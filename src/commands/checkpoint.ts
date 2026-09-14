import { UsageError } from "../core/errors.js";
import { makeId } from "../core/ids.js";
import { asArray, asObject, asString } from "../core/json.js";
import { checkRepoPath, scopeMatcher } from "../core/paths.js";
import { loadRecordIndex, requireRecord } from "../core/records.js";
import type { LoadedRecord } from "../core/store.js";
import { NOT_DETERMINED, truncate } from "../core/text.js";
import {
  anchorFor,
  assertReferences,
  compact,
  confidenceFor,
  createdBy,
  openWriteContext,
  parsePair,
  saveRecord,
  unique,
  type WriteContext,
} from "../core/write.js";
import {
  changedPathsSince,
  currentBranch,
  headCommit,
  isAncestor,
  isDirty,
  mergeBase,
  resolveBranchRef,
  resolveCommit,
  shortSha,
} from "../git/git.js";
import { type Io, requireInitialized } from "./context.js";
import { type CommonWriteOptions, reportWrite } from "./report.js";

export { NOT_DETERMINED } from "../core/text.js";

type Data = Record<string, unknown>;

function strings(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

async function inferTask(
  index: ReadonlyMap<string, LoadedRecord>,
  ctx: WriteContext,
): Promise<LoadedRecord> {
  const active = [...index.values()].filter(
    (record) => record.kind === "task" && record.data.status === "active",
  );
  const mine = active.filter((record) => asObject(record.data.owner)?.agent === ctx.agent);
  if (mine.length === 1 && mine[0]) return mine[0];
  if (mine.length === 0) {
    const branch = await currentBranch(ctx.root);
    const onBranch = active.filter((record) => record.data.branch === branch);
    if (onBranch.length === 1 && onBranch[0]) return onBranch[0];
  }
  if (active.length === 0) {
    throw new UsageError(
      "No active task to checkpoint. Pass --task <id>, or start one with `alethic task start`.",
    );
  }
  const candidates = (mine.length > 0 ? mine : active).map((record) => record.data.id);
  throw new UsageError(`Several active tasks match. Pass --task <id>: ${candidates.join(", ")}`);
}

export interface CheckpointCreateOptions extends CommonWriteOptions {
  task?: string;
  summary?: string;
  done?: string[];
  failed?: string[];
  question?: string[];
  next?: string;
  receipt?: string[];
  link?: string[];
  human?: string;
  id?: string;
  maxFingerprints?: string;
}

export async function checkpointCreateCommand(
  io: Io,
  options: CheckpointCreateOptions,
): Promise<number> {
  const root = await requireInitialized(io);
  const ctx = await openWriteContext(root, options.agent, io.env);
  const index = await loadRecordIndex(root);

  const task = options.task
    ? requireRecord(index, options.task, "task", "--task")
    : await inferTask(index, ctx);
  const taskId = asString(task.data.id) ?? "";
  const taskStatus = asString(task.data.status);
  if (taskStatus === "done" || taskStatus === "abandoned") {
    throw new UsageError(`${taskId} is ${taskStatus}; checkpoints are for unfinished work.`);
  }

  const head = await headCommit(root);
  if (!head) throw new UsageError("Checkpoints need at least one commit to tie the state to.");
  const defaultRef = await resolveBranchRef(root, ctx.manifest.defaults.default_branch);
  const baseFull = defaultRef ? await mergeBase(root, head, defaultRef) : undefined;
  const forbidden = scopeMatcher(ctx.manifest.privacy.forbidden_globs);
  const [branch, dirty, headShort, base, changed] = await Promise.all([
    currentBranch(root),
    isDirty(root),
    shortSha(root, head),
    baseFull ? shortSha(root, baseFull) : Promise.resolve(undefined),
    changedPathsSince(root, baseFull),
  ]);
  const changedPaths = changed.filter((p) => checkRepoPath(p) === undefined && !forbidden(p));

  const failedApproaches = (options.failed ?? []).map((value) => {
    const [approach, whyFailed] = parsePair(value, "--failed");
    return { approach, why_failed: whyFailed };
  });
  const links = unique(options.link);
  assertReferences(index, links, "--link");

  // Receipts: the ones named explicitly, plus receipts any agent recorded since the task's last
  // checkpoint (or since the task started) on this line of history. Other agents' receipts are
  // included so evidence survives a handoff; the ancestry check keeps out receipts recorded on
  // unrelated branches. Timestamps have one-second precision, so "since" includes that second.
  const explicitReceipts = unique(options.receipt);
  assertReferences(index, explicitReceipts, "--receipt", "receipt");
  const previous = [...index.values()]
    .filter((record) => record.kind === "checkpoint" && record.data.task === taskId)
    .map((record) => asString(record.data.created_at) ?? "")
    .sort();
  const since = previous.at(-1) ?? asString(task.data.created_at) ?? "";
  const autoReceipts: string[] = [];
  for (const record of index.values()) {
    if (record.kind !== "receipt" || (asString(record.data.created_at) ?? "") < since) continue;
    const receiptId = asString(record.data.id);
    const receiptHead = asString(asObject(record.data.git)?.head);
    const resolved = receiptHead ? await resolveCommit(root, receiptHead) : undefined;
    if (receiptId && resolved && (await isAncestor(root, resolved, head))) {
      autoReceipts.push(receiptId);
    }
  }
  const receipts = unique([...explicitReceipts, ...autoReceipts]).sort();

  const nextSafeAction = options.next ?? asString(task.data.next_action) ?? NOT_DETERMINED;
  const id = options.id ?? makeId("checkpoint", taskId.replace(/^task-/, ""), ctx.now);
  if (index.has(id)) throw new UsageError(`${id} already exists. Pass --id to choose another id.`);

  const scopePaths = strings(asObject(task.data.scope)?.paths);
  const anchored = await anchorFor(
    ctx,
    { scopePaths, evidenceFiles: changedPaths },
    options.maxFingerprints,
  );

  const record = compact({
    id,
    kind: "checkpoint",
    schema_version: 1,
    summary: truncate(
      options.summary ?? `${asString(task.data.summary) ?? taskId} Next: ${nextSafeAction}`,
      280,
    ),
    status: "recorded",
    confidence: confidenceFor(options.human),
    task: taskId,
    git: { branch, base, head: headShort, dirty, changed_paths: changedPaths },
    done: unique(options.done),
    failed_approaches: failedApproaches,
    open_questions: unique(options.question),
    next_safe_action: nextSafeAction,
    receipts,
    scope: { paths: scopePaths },
    links,
    evidence: options.human
      ? { human: [{ name: options.human, at: ctx.timestamp, note: "Reviewed this checkpoint." }] }
      : undefined,
    created_by: createdBy(ctx, options.human),
    created_at: ctx.timestamp,
    valid_at: headShort,
    anchor: anchored.anchor,
  });
  const file = await saveRecord(ctx, "checkpoint", record);

  const warnings = [...anchored.warnings];
  if (nextSafeAction === NOT_DETERMINED) {
    warnings.push("No next action was given or found on the task; recorded as not determined.");
  }
  reportWrite(
    io,
    {
      id,
      file,
      warnings,
      message: [
        `Created ${file}`,
        `  task: ${taskId}`,
        `  git: ${branch ?? "(detached HEAD)"} @ ${headShort} (${dirty ? "dirty" : "clean"}), ${changedPaths.length} changed ${changedPaths.length === 1 ? "path" : "paths"}, ${receipts.length} ${receipts.length === 1 ? "receipt" : "receipts"} attached`,
        `  next: ${nextSafeAction}`,
      ].join("\n"),
      details: { task: taskId, receipts, changedPaths, nextSafeAction },
    },
    options.json,
  );
  return 0;
}

export interface CheckpointSummary {
  id: string;
  task: string;
  createdAt: string;
  agent: string;
  summary: string;
  nextSafeAction: string;
}

export async function checkpointListCommand(
  io: Io,
  options: { task?: string; json?: boolean },
): Promise<number> {
  const root = await requireInitialized(io);
  const index = await loadRecordIndex(root);
  const checkpoints: CheckpointSummary[] = [...index.values()]
    .filter(
      (record) =>
        record.kind === "checkpoint" && (!options.task || record.data.task === options.task),
    )
    .map((record) => ({
      id: asString(record.data.id) ?? record.file,
      task: asString(record.data.task) ?? "",
      createdAt: asString(record.data.created_at) ?? "",
      agent: asString(asObject(record.data.created_by)?.agent) ?? "",
      summary: asString(record.data.summary) ?? "",
      nextSafeAction: asString(record.data.next_safe_action) ?? "",
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

  if (options.json) {
    io.stdout(`${JSON.stringify(checkpoints, null, 2)}\n`);
  } else if (checkpoints.length === 0) {
    io.stdout(options.task ? `No checkpoints for ${options.task}.\n` : "No checkpoints.\n");
  } else {
    io.stdout(
      `${checkpoints
        .map((c) => `${c.id}\n  ${c.createdAt} by ${c.agent} for ${c.task}\n  ${c.summary}`)
        .join("\n\n")}\n`,
    );
  }
  return 0;
}

export async function checkpointShowCommand(
  io: Io,
  id: string,
  options: { json?: boolean },
): Promise<number> {
  const root = await requireInitialized(io);
  const index = await loadRecordIndex(root);
  const checkpoint = requireRecord(index, id, "checkpoint");
  const cp = checkpoint.data;
  const taskId = asString(cp.task) ?? "";
  const task = index.get(taskId);
  const receipts = strings(cp.receipts).map((receiptId) => ({
    id: receiptId,
    record: index.get(receiptId)?.data,
  }));

  if (options.json) {
    const output = {
      checkpoint: cp,
      task: task?.data ?? null,
      receipts: receipts.map((r) => r.record ?? { id: r.id, missing: true }),
    };
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  }

  const git = asObject(cp.git);
  const list = (items: string[]) => (items.length > 0 ? items.map((i) => `  - ${i}`) : ["  none"]);
  const lines = [
    `# ${id}`,
    "",
    `Task: ${taskId}${task ? `: ${asString(task.data.summary) ?? ""}` : " (task not found)"}`,
    ...(task ? [`Intent: ${asString(task.data.intent) ?? ""}`] : []),
    `Written by ${asString(asObject(cp.created_by)?.agent) ?? "?"} at ${asString(cp.created_at) ?? "?"}`,
    `Git: ${asString(git?.branch) ?? "(detached HEAD)"} @ ${asString(git?.head) ?? "?"} (${git?.dirty ? "dirty" : "clean"})${asString(git?.base) ? `, base ${asString(git?.base)}` : ""}`,
    "",
    "Changed paths:",
    ...list(strings(git?.changed_paths)),
    "",
    "Done:",
    ...list(strings(cp.done)),
    "",
    "Failed approaches:",
    ...list(
      asArray(cp.failed_approaches).map((item) => {
        const data = asObject(item);
        return `${asString(data?.approach) ?? "?"}: ${asString(data?.why_failed) ?? "?"}`;
      }),
    ),
    "",
    "Open questions:",
    ...list(strings(cp.open_questions)),
    "",
    "Next safe action:",
    `  ${asString(cp.next_safe_action) ?? NOT_DETERMINED}`,
    "",
    "Receipts:",
    ...list(receipts.map((r) => describeReceipt(r.id, r.record))),
  ];
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}

function describeReceipt(id: string, data: Data | undefined): string {
  if (!data) return `${id} (not found)`;
  const git = asObject(data.git);
  return `${id}: ${asString(data.result) ?? "?"} \`${asString(data.command) ?? "?"}\` (exit ${String(data.exit_code)}, ${asString(data.confidence) ?? "?"}, at ${asString(git?.head) ?? "?"})`;
}
