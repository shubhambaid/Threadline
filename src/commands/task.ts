import { addMinutes, toTimestamp } from "../core/clock.js";
import { UsageError } from "../core/errors.js";
import { makeId } from "../core/ids.js";
import { asObject, asString } from "../core/json.js";
import { loadRecordIndex, requireRecord } from "../core/records.js";
import { truncate } from "../core/text.js";
import {
  addHumanConfirmation,
  anchorFor,
  assertSafePaths,
  compact,
  createdBy,
  openWriteContext,
  saveRecord,
  unique,
  validAt,
  type WriteContext,
} from "../core/write.js";
import { currentBranch } from "../git/git.js";
import { reconcileConfirmation } from "../trust/claims.js";
import { validateRepository } from "../validate/index.js";
import { collectReferences } from "../validate/references.js";
import { type Io, requireInitialized } from "./context.js";
import { formatFinding, plural } from "./output.js";
import { type CommonWriteOptions, reportWrite } from "./report.js";

type Data = Record<string, unknown>;

interface Lease {
  agent?: string;
  expiresAt?: string;
  /** The task is active and the lease has not expired. */
  held: boolean;
}

function leaseOf(data: Data, now: Date): Lease {
  const owner = asObject(data.owner);
  const agent = asString(owner?.agent);
  const expiresAt = asString(owner?.lease_expires_at);
  const held =
    data.status === "active" &&
    agent !== undefined &&
    expiresAt !== undefined &&
    Date.parse(expiresAt) > now.getTime();
  return { agent, expiresAt, held };
}

function assertOpen(id: string, data: Data): void {
  const status = asString(data.status);
  if (status === "done" || status === "abandoned") {
    throw new UsageError(`${id} is ${status}; closed tasks cannot be changed.`);
  }
}

function assertNotHeldByOther(ctx: WriteContext, id: string, data: Data, force?: boolean): Lease {
  const lease = leaseOf(data, ctx.now);
  if (lease.held && lease.agent !== ctx.agent && !force) {
    throw new UsageError(
      `${id} is held by ${lease.agent} until ${lease.expiresAt}. Wait for the lease to expire, or pass --force to take over.`,
    );
  }
  return lease;
}

function leaseUntil(ctx: WriteContext): string {
  return toTimestamp(addMinutes(ctx.now, ctx.manifest.defaults.lease_minutes));
}

export interface TaskStartOptions extends CommonWriteOptions {
  summary?: string;
  paths?: string[];
  branch?: string;
  next?: string;
  id?: string;
  human?: string;
  maxFingerprints?: string;
}

export async function taskStartCommand(
  io: Io,
  intent: string,
  options: TaskStartOptions,
): Promise<number> {
  const root = await requireInitialized(io);
  const ctx = await openWriteContext(root, options.agent, io.env);
  const paths = unique(options.paths);
  await assertSafePaths(ctx, paths, "--paths");

  const id = options.id ?? makeId("task", options.summary ?? intent, ctx.now);
  const index = await loadRecordIndex(root);
  if (index.has(id)) throw new UsageError(`${id} already exists. Pass --id to choose another id.`);

  const { anchor, warnings } = await anchorFor(ctx, { scopePaths: paths }, options.maxFingerprints);
  const leaseExpiresAt = leaseUntil(ctx);
  const draft = compact({
    id,
    kind: "task",
    schema_version: 1,
    summary: truncate(options.summary ?? intent, 280),
    status: "active",
    confidence: "agent-reported",
    intent: intent.trim(),
    branch: options.branch ?? (await currentBranch(root)),
    owner: { agent: ctx.agent, claimed_at: ctx.timestamp, lease_expires_at: leaseExpiresAt },
    next_action: options.next,
    scope: { paths },
    created_by: createdBy(ctx, options.human),
    created_at: ctx.timestamp,
    valid_at: await validAt(root),
    anchor,
  });
  const record = options.human
    ? addHumanConfirmation(ctx, "task", draft, {
        name: options.human,
        note: "Confirmed the task intent.",
      })
    : draft;

  const file = await saveRecord(ctx, "task", record);
  reportWrite(
    io,
    {
      id,
      file,
      warnings,
      message: `Created ${file} (active, owned by ${ctx.agent} until ${leaseExpiresAt})`,
      details: { owner: ctx.agent, leaseExpiresAt },
    },
    options.json,
  );
  return 0;
}

export interface TaskClaimOptions extends CommonWriteOptions {
  force?: boolean;
}

export async function taskClaimCommand(
  io: Io,
  id: string,
  options: TaskClaimOptions,
): Promise<number> {
  const root = await requireInitialized(io);
  const ctx = await openWriteContext(root, options.agent, io.env);
  const task = requireRecord(await loadRecordIndex(root), id, "task");
  assertOpen(id, task.data);
  const lease = assertNotHeldByOther(ctx, id, task.data, options.force);

  const renewing = lease.held && lease.agent === ctx.agent;
  const leaseExpiresAt = leaseUntil(ctx);
  const claimedAt = renewing
    ? (asString(asObject(task.data.owner)?.claimed_at) ?? ctx.timestamp)
    : ctx.timestamp;
  const updated = {
    ...task.data,
    status: "active",
    owner: { agent: ctx.agent, claimed_at: claimedAt, lease_expires_at: leaseExpiresAt },
    updated_at: ctx.timestamp,
  };
  const file = await saveRecord(ctx, "task", updated, { overwrite: true });

  const message = renewing
    ? `Renewed ${id} for ${ctx.agent} until ${leaseExpiresAt}`
    : lease.held
      ? `Took over ${id} from ${lease.agent} (lease was until ${lease.expiresAt}); owned by ${ctx.agent} until ${leaseExpiresAt}`
      : `Claimed ${id} for ${ctx.agent} until ${leaseExpiresAt}`;
  reportWrite(
    io,
    { id, file, message, details: { owner: ctx.agent, leaseExpiresAt, renewed: renewing } },
    options.json,
  );
  return 0;
}

export interface TaskUpdateOptions extends CommonWriteOptions {
  status?: string;
  next?: string;
  summary?: string;
  force?: boolean;
}

const UPDATABLE_STATUSES = ["proposed", "paused", "blocked"];

export async function taskUpdateCommand(
  io: Io,
  id: string,
  options: TaskUpdateOptions,
): Promise<number> {
  const { status, next, summary } = options;
  if (!status && !next && !summary) {
    throw new UsageError("Nothing to update. Pass --status, --next, or --summary.");
  }
  if (status === "active") {
    throw new UsageError(`Use \`alethic task claim ${id}\` to make a task active.`);
  }
  if (status === "done" || status === "abandoned") {
    throw new UsageError(`Use \`alethic task close ${id} --status ${status}\` to close a task.`);
  }
  if (status && !UPDATABLE_STATUSES.includes(status)) {
    throw new UsageError(`--status must be one of: ${UPDATABLE_STATUSES.join(", ")}`);
  }

  const root = await requireInitialized(io);
  const ctx = await openWriteContext(root, options.agent, io.env);
  const task = requireRecord(await loadRecordIndex(root), id, "task");
  assertOpen(id, task.data);
  assertNotHeldByOther(ctx, id, task.data, options.force);

  const { record: updated, warning } = reconcileConfirmation("task", id, task.data, {
    ...task.data,
    ...(status ? { status } : {}),
    ...(next ? { next_action: next } : {}),
    ...(summary ? { summary: truncate(summary, 280) } : {}),
    updated_at: ctx.timestamp,
  });
  const file = await saveRecord(ctx, "task", updated, { overwrite: true });
  reportWrite(
    io,
    {
      id,
      file,
      warnings: warning ? [warning] : [],
      message: `Updated ${file}${status ? ` (status: ${status})` : ""}`,
    },
    options.json,
  );
  return 0;
}

export interface TaskCloseOptions extends CommonWriteOptions {
  status?: string;
  summary?: string;
  force?: boolean;
}

export async function taskCloseCommand(
  io: Io,
  id: string,
  options: TaskCloseOptions,
): Promise<number> {
  const status = options.status ?? "done";
  if (status !== "done" && status !== "abandoned") {
    throw new UsageError("--status must be done or abandoned");
  }
  const root = await requireInitialized(io);
  const ctx = await openWriteContext(root, options.agent, io.env);
  const index = await loadRecordIndex(root);
  const task = requireRecord(index, id, "task");
  assertOpen(id, task.data);
  assertNotHeldByOther(ctx, id, task.data, options.force);

  // The task's own records: the task, its checkpoints, and receipts those checkpoints cite.
  const related = new Set([task.file]);
  for (const record of index.values()) {
    if (record.kind !== "checkpoint" || record.data.task !== id) continue;
    related.add(record.file);
    for (const ref of collectReferences(record.data)) {
      const target = index.get(ref.id);
      if (target?.kind === "receipt") related.add(target.file);
    }
  }
  const report = await validateRepository(root, { now: ctx.now });
  const blocking = report.findings.filter(
    (finding) =>
      finding.severity === "error" &&
      finding.file !== undefined &&
      related.has(finding.file) &&
      // Closing the task resolves its expired lease.
      finding.code !== "expired-lease",
  );
  if (blocking.length > 0) {
    io.stdout(
      `${blocking.map(formatFinding).join("\n")}\n\n✗ Cannot close ${id}: fix the ${plural(blocking.length, "error")} above first.\n`,
    );
    return 1;
  }

  const { record: updated, warning } = reconcileConfirmation("task", id, task.data, {
    ...task.data,
    status,
    ...(options.summary ? { summary: truncate(options.summary, 280) } : {}),
    updated_at: ctx.timestamp,
  });
  const file = await saveRecord(ctx, "task", updated, { overwrite: true });
  reportWrite(
    io,
    { id, file, warnings: warning ? [warning] : [], message: `Closed ${id} (${status})` },
    options.json,
  );
  return 0;
}
