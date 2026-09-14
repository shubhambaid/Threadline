import { now } from "../core/clock.js";
import { RECORD_KINDS, type RecordKind } from "../core/ids.js";
import { asObject, asString } from "../core/json.js";
import type { LoadedRecord } from "../core/store.js";
import { currentBranch, headCommit, isDirty } from "../git/git.js";
import { validateRepository } from "../validate/index.js";
import { type Io, requireInitialized } from "./context.js";
import { plural } from "./output.js";

export interface StatusOptions {
  json?: boolean;
}

export interface TaskSummary {
  id: string;
  status: string;
  summary: string;
  owner: string | null;
  leaseExpiresAt: string | null;
  leaseExpired: boolean;
  nextAction: string | null;
  latestCheckpoint: { id: string; createdAt: string } | null;
}

const OPEN_STATUSES = new Set(["proposed", "paused", "blocked"]);

export async function statusCommand(io: Io, options: StatusOptions): Promise<number> {
  const root = await requireInitialized(io);
  const at = now(io.env);
  const [report, head, branch, dirty] = await Promise.all([
    validateRepository(root, { now: at }),
    headCommit(root),
    currentBranch(root),
    isDirty(root),
  ]);

  const counts = Object.fromEntries(
    RECORD_KINDS.map((kind) => [kind, report.records.filter((r) => r.kind === kind).length]),
  ) as Record<RecordKind, number>;
  const tasks = report.records
    .filter((record) => record.kind === "task")
    .map((task) => summarizeTask(task, report.records, at))
    .sort((a, b) => a.id.localeCompare(b.id));
  const activeTasks = tasks.filter((task) => task.status === "active");
  const openTasks = tasks.filter((task) => OPEN_STATUSES.has(task.status));

  const status = {
    project: report.manifest?.project.name ?? null,
    git: { branch: branch ?? null, head: head ?? null, dirty },
    counts,
    activeTasks,
    openTasks,
    validation: { valid: report.errors === 0, errors: report.errors, warnings: report.warnings },
  };

  if (options.json) {
    io.stdout(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }

  const lines = [
    `Threadline status: ${status.project ?? "(manifest invalid)"}`,
    `  branch   ${branch ?? "(detached HEAD)"} @ ${head ? head.slice(0, 7) : "no commits"} (${dirty ? "dirty" : "clean"})`,
    `  records  ${[
      plural(counts.task, "task"),
      plural(counts.decision, "decision"),
      plural(counts.knowledge, "knowledge", "knowledge"),
      plural(counts.checkpoint, "checkpoint"),
      plural(counts.receipt, "receipt"),
    ].join(", ")}`,
    "",
    "Active tasks",
  ];
  if (activeTasks.length === 0) lines.push("  none");
  for (const task of activeTasks) {
    lines.push(`  ${task.id}: ${task.summary}`);
    if (task.owner) {
      lines.push(
        `    owner ${task.owner}, lease until ${task.leaseExpiresAt ?? "?"}${task.leaseExpired ? " (expired)" : ""}`,
      );
    }
    if (task.nextAction) lines.push(`    next: ${task.nextAction}`);
    lines.push(
      `    latest checkpoint: ${task.latestCheckpoint ? `${task.latestCheckpoint.id} (${task.latestCheckpoint.createdAt})` : "none"}`,
    );
  }
  if (openTasks.length > 0) {
    lines.push("", "Other open tasks");
    for (const task of openTasks) lines.push(`  ${task.id} [${task.status}]: ${task.summary}`);
  }
  lines.push(
    "",
    report.errors === 0
      ? `Validation: ok (${plural(report.warnings, "warning")})`
      : `Validation: ${plural(report.errors, "error")}, ${plural(report.warnings, "warning")}. Run \`threadline validate\` for details.`,
  );
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}

function summarizeTask(
  task: LoadedRecord,
  records: readonly LoadedRecord[],
  at: Date,
): TaskSummary {
  const id = asString(task.data.id) ?? task.file;
  const owner = asObject(task.data.owner);
  const lease = asString(owner?.lease_expires_at) ?? null;
  const checkpoints = records
    .filter((record) => record.kind === "checkpoint" && record.data.task === id)
    .map((record) => ({
      id: asString(record.data.id) ?? record.file,
      createdAt: asString(record.data.created_at) ?? "",
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

  return {
    id,
    status: asString(task.data.status) ?? "unknown",
    summary: asString(task.data.summary) ?? "",
    owner: asString(owner?.agent) ?? null,
    leaseExpiresAt: lease,
    leaseExpired: lease !== null && Date.parse(lease) <= at.getTime(),
    nextAction: asString(task.data.next_action) ?? null,
    latestCheckpoint: checkpoints[0] ?? null,
  };
}
