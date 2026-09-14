import { asArray, asObject, asString } from "../core/json.js";
import type { Manifest } from "../core/manifest.js";
import { expandScope, scopeMatcher } from "../core/paths.js";
import type { LoadedRecord } from "../core/store.js";
import { createGitLookups, type GitLookups, listTrackedFiles } from "../git/git.js";
import { collectPaths, collectReferences } from "../validate/references.js";

export interface GitState {
  head?: string;
  headShort?: string;
  branch?: string;
  dirty: boolean;
  base?: string;
  changedPaths: string[];
}

/** How a record was found. Explicit links outrank inferred relevance. */
export type Reason =
  | "task-link"
  | "checkpoint-link"
  | "links-to-task"
  | "cited-by-checkpoint"
  | "cited-by-record"
  | "since-checkpoint"
  | "at-head"
  | "path-overlap";

export const REASON_WEIGHT: Record<Reason, number> = {
  "task-link": 100,
  "checkpoint-link": 90,
  "links-to-task": 80,
  "cited-by-checkpoint": 80,
  "cited-by-record": 50,
  "since-checkpoint": 80,
  "at-head": 45,
  "path-overlap": 40,
};

const EXPLICIT: ReadonlySet<Reason> = new Set(["task-link", "checkpoint-link", "links-to-task"]);

export interface Candidate {
  id: string;
  record: LoadedRecord;
  reasons: Reason[];
}

/** A record that matched but was left out on purpose, and why. */
export interface Skipped {
  id: string;
  reason: string;
}

export interface Collected {
  /** The task's checkpoints, newest first. */
  checkpoints: LoadedRecord[];
  decisions: Candidate[];
  knowledge: Candidate[];
  receipts: Candidate[];
  /** Retired records that matched only by inference. */
  skipped: Skipped[];
  scopePaths: string[];
  relevantFiles: string[];
}

function strings(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

function idOf(record: LoadedRecord): string {
  return asString(record.data.id) ?? record.file;
}

/** Deterministic retrieval of the records relevant to a task. No embeddings. */
export async function collect(
  root: string,
  index: ReadonlyMap<string, LoadedRecord>,
  task: LoadedRecord,
  git: GitState,
  manifest: Manifest,
  lookups: GitLookups = createGitLookups(root),
): Promise<Collected> {
  const taskId = idOf(task);
  const records = [...index.values()];
  const checkpoints = records
    .filter((record) => record.kind === "checkpoint" && record.data.task === taskId)
    .sort(
      (a, b) =>
        (asString(b.data.created_at) ?? "").localeCompare(asString(a.data.created_at) ?? "") ||
        idOf(b).localeCompare(idOf(a)),
    );

  const candidates = new Map<string, Candidate>();
  const add = (record: LoadedRecord, reason: Reason) => {
    if (record.kind !== "decision" && record.kind !== "knowledge" && record.kind !== "receipt") {
      return;
    }
    const id = idOf(record);
    const existing = candidates.get(id);
    if (!existing) candidates.set(id, { id, record, reasons: [reason] });
    else if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
  };
  const addId = (id: string, reason: Reason) => {
    const record = index.get(id);
    if (record) add(record, reason);
  };

  // Explicit links in both directions.
  for (const ref of collectReferences(task.data)) addId(ref.id, "task-link");
  for (const checkpoint of checkpoints) {
    for (const ref of collectReferences(checkpoint.data)) {
      if (ref.path === "task") continue;
      addId(ref.id, ref.expected === "receipt" ? "cited-by-checkpoint" : "checkpoint-link");
    }
  }
  for (const record of records) {
    if (strings(record.data.links).includes(taskId)) add(record, "links-to-task");
  }

  // Path overlap between records and the files this task touches.
  const scopePaths = strings(asObject(task.data.scope)?.paths);
  const inScope =
    scopePaths.length > 0
      ? expandScope(await listTrackedFiles(root), scopePaths, manifest.limits.max_glob_matches)
          .files
      : [];
  const checkpointChanged = checkpoints.flatMap((checkpoint) =>
    strings(asObject(checkpoint.data.git)?.changed_paths),
  );
  const relevantFiles = [
    ...new Set([...inScope, ...git.changedPaths, ...checkpointChanged]),
  ].sort();
  for (const record of records) {
    if (record.kind !== "decision" && record.kind !== "knowledge") continue;
    const paths = collectPaths(record.data)
      .filter((field) => field.role === "scope" || field.role === "evidence")
      .map((field) => field.value);
    if (paths.length > 0 && relevantFiles.some(scopeMatcher(paths))) add(record, "path-overlap");
  }

  // Receipts cited as evidence by the records found so far.
  for (const candidate of [...candidates.values()]) {
    if (candidate.record.kind === "receipt") continue;
    for (const ref of collectReferences(candidate.record.data)) {
      if (ref.expected === "receipt") addId(ref.id, "cited-by-record");
    }
  }

  // Receipts recorded at the current HEAD since the task started, and receipts recorded on this
  // line of history since the latest checkpoint. The latter are the ones the next checkpoint
  // would attach (the same rule as `checkpoint create`), so they are not lost when a commit lands
  // before anyone checkpoints again.
  if (git.head) {
    const since = asString(task.data.created_at) ?? "";
    const pendingSince = asString(checkpoints[0]?.data.created_at) ?? since;
    for (const record of records) {
      const createdAt = asString(record.data.created_at) ?? "";
      if (record.kind !== "receipt" || createdAt < since) continue;
      const head = asString(asObject(record.data.git)?.head);
      const resolved = head ? await lookups.resolveCommit(head) : undefined;
      if (!resolved) continue;
      if (resolved === git.head) add(record, "at-head");
      else if (createdAt >= pendingSince && (await lookups.isAncestor(resolved, git.head))) {
        add(record, "since-checkpoint");
      }
    }
  }

  // Superseded decisions and deprecated knowledge appear only when explicitly linked.
  const skipped: Skipped[] = [];
  const kept = [...candidates.values()]
    .filter((candidate) => {
      const { kind, data } = candidate.record;
      const retired =
        (kind === "decision" && data.status === "superseded") ||
        (kind === "knowledge" && data.status === "deprecated");
      if (!retired || candidate.reasons.some((reason) => EXPLICIT.has(reason))) return true;
      skipped.push({
        id: candidate.id,
        reason: `${String(data.status)} and not linked to the task (matched by ${candidate.reasons.join(", ")})`,
      });
      return false;
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    checkpoints,
    decisions: kept.filter((candidate) => candidate.record.kind === "decision"),
    knowledge: kept.filter((candidate) => candidate.record.kind === "knowledge"),
    receipts: kept.filter((candidate) => candidate.record.kind === "receipt"),
    skipped: skipped.sort((a, b) => a.id.localeCompare(b.id)),
    scopePaths,
    relevantFiles,
  };
}
