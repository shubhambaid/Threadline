import type { Finding } from "../core/findings.js";
import { asArray, asObject, asString } from "../core/json.js";
import type { Manifest } from "../core/manifest.js";
import { expandScope, isGlob, scopeMatcher } from "../core/paths.js";
import type { LoadedRecord } from "../core/store.js";
import { truncate } from "../core/text.js";
import { listTrackedFiles } from "../git/git.js";

type Overlaps = (a: readonly string[], b: readonly string[]) => Promise<boolean>;

function strings(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

function idOf(record: LoadedRecord): string {
  return asString(record.data.id) ?? record.file;
}

function scopeOf(record: LoadedRecord): string[] {
  return strings(asObject(record.data.scope)?.paths);
}

function byCreation(a: LoadedRecord, b: LoadedRecord): number {
  return (
    (asString(a.data.created_at) ?? "").localeCompare(asString(b.data.created_at) ?? "") ||
    idOf(a).localeCompare(idOf(b))
  );
}

/**
 * Whether two sets of scope paths can cover the same file: the same pattern, one naming a path
 * the other matches, or both matching a tracked file. Uses the same glob rules as `resume`.
 */
export function createOverlapCheck(root: string, manifest: Manifest): Overlaps {
  let tracked: Promise<string[]> | undefined;
  const expanded = new Map<string, Promise<Set<string>>>();
  const filesFor = (paths: readonly string[]) => {
    const key = JSON.stringify([...paths].sort());
    let files = expanded.get(key);
    if (!files) {
      tracked ??= listTrackedFiles(root);
      files = tracked.then(
        (all) => new Set(expandScope(all, paths, manifest.limits.max_glob_matches).files),
      );
      expanded.set(key, files);
    }
    return files;
  };
  return async (a, b) => {
    if (a.some((p) => b.includes(p))) return true;
    const matchesA = scopeMatcher(a);
    const matchesB = scopeMatcher(b);
    if (b.some((p) => !isGlob(p) && matchesA(p)) || a.some((p) => !isGlob(p) && matchesB(p))) {
      return true;
    }
    const [filesA, filesB] = await Promise.all([filesFor(a), filesFor(b)]);
    for (const file of filesA) if (filesB.has(file)) return true;
    return false;
  };
}

/**
 * Two accepted decisions on the same topic whose scopes overlap (or either has no scope), where
 * neither supersedes the other, directly or through a chain (docs/spec.md §11).
 */
export async function findContradictions(
  records: readonly LoadedRecord[],
  overlaps: Overlaps,
): Promise<Finding[]> {
  const decisions = new Map(
    records.filter((r) => r.kind === "decision").map((record) => [idOf(record), record]),
  );
  const supersedes = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of strings(decisions.get(current)?.data.supersedes)) {
        if (next === target) return true;
        stack.push(next);
      }
    }
    return false;
  };

  const byTopic = new Map<string, LoadedRecord[]>();
  for (const record of decisions.values()) {
    const topic = asString(record.data.topic);
    if (record.data.status !== "accepted" || !topic) continue;
    byTopic.set(topic, [...(byTopic.get(topic) ?? []), record]);
  }

  const findings: Finding[] = [];
  for (const [topic, group] of [...byTopic.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    group.sort(byCreation);
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const older = group[i] as LoadedRecord;
        const newer = group[j] as LoadedRecord;
        const [olderId, newerId] = [idOf(older), idOf(newer)];
        if (supersedes(newerId, olderId) || supersedes(olderId, newerId)) continue;
        const [scopeA, scopeB] = [scopeOf(older), scopeOf(newer)];
        if (scopeA.length > 0 && scopeB.length > 0 && !(await overlaps(scopeA, scopeB))) continue;
        findings.push({
          severity: "warning",
          code: "contradiction",
          file: newer.file,
          path: "topic",
          message: `Accepted decisions ${olderId} and ${newerId} both decide ${topic} for overlapping paths, and neither supersedes the other`,
          hint: `Keep one: \`threadline decision update ${olderId} --status superseded\` (or the other way round), or record a new decision with --supersedes.`,
        });
      }
    }
  }
  return findings;
}

/** Active tasks with unexpired leases, held by different agents, over overlapping paths. */
export async function findOverlappingClaims(
  records: readonly LoadedRecord[],
  overlaps: Overlaps,
  now: Date,
): Promise<Finding[]> {
  const claimed = records
    .filter((record) => {
      if (record.kind !== "task" || record.data.status !== "active") return false;
      const lease = Date.parse(asString(asObject(record.data.owner)?.lease_expires_at) ?? "");
      return lease > now.getTime() && scopeOf(record).length > 0;
    })
    .sort(byCreation);

  const findings: Finding[] = [];
  for (let i = 0; i < claimed.length; i++) {
    for (let j = i + 1; j < claimed.length; j++) {
      const first = claimed[i] as LoadedRecord;
      const second = claimed[j] as LoadedRecord;
      const ownerA = asString(asObject(first.data.owner)?.agent);
      const ownerB = asString(asObject(second.data.owner)?.agent);
      if (!ownerA || !ownerB || ownerA === ownerB) continue;
      if (!(await overlaps(scopeOf(first), scopeOf(second)))) continue;
      findings.push({
        severity: "warning",
        code: "overlapping-claim",
        file: second.file,
        path: "scope.paths",
        message: `${idOf(first)} (${ownerA}) and ${idOf(second)} (${ownerB}) are both active over overlapping paths`,
        hint: `Coordinate before editing the same files: pause one with \`threadline task update ${idOf(second)} --status paused\`, or narrow its paths.`,
      });
    }
  }
  return findings;
}

/** Decisions that an accepted decision supersedes, but that are still proposed or accepted. */
export function findUnretiredSupersessions(records: readonly LoadedRecord[]): Finding[] {
  const decisions = new Map(
    records.filter((r) => r.kind === "decision").map((record) => [idOf(record), record]),
  );
  const findings: Finding[] = [];
  const reported = new Set<string>();
  for (const record of [...decisions.values()].sort(byCreation)) {
    if (record.data.status !== "accepted") continue;
    for (const old of strings(record.data.supersedes)) {
      const target = decisions.get(old);
      if (!target || target.data.status === "superseded" || reported.has(old)) continue;
      reported.add(old);
      findings.push({
        severity: "warning",
        code: "superseded-still-accepted",
        file: target.file,
        path: "status",
        message: `${old} is superseded by ${idOf(record)} but is still ${String(target.data.status)}`,
        hint: `Retire it: \`threadline decision update ${old} --status superseded\`.`,
      });
    }
  }
  return findings;
}

/** Checkpoints written after their task was closed: work that may have been dropped. */
export function findOrphanedCheckpoints(records: readonly LoadedRecord[]): Finding[] {
  const tasks = new Map(records.filter((r) => r.kind === "task").map((r) => [idOf(r), r]));
  const findings: Finding[] = [];
  for (const checkpoint of records.filter((r) => r.kind === "checkpoint").sort(byCreation)) {
    const task = tasks.get(asString(checkpoint.data.task) ?? "");
    const status = asString(task?.data.status);
    if (!task || (status !== "done" && status !== "abandoned")) continue;
    const closedAt = asString(task.data.updated_at) ?? asString(task.data.created_at) ?? "";
    if ((asString(checkpoint.data.created_at) ?? "") <= closedAt) continue;
    const next = asString(checkpoint.data.next_safe_action) ?? "";
    findings.push({
      severity: "warning",
      code: "orphaned-checkpoint",
      file: checkpoint.file,
      path: "task",
      message: `Written after ${idOf(task)} was closed (${status}); its next action may be unfinished work: ${truncate(next, 120)}`,
      hint: `Review it with \`threadline checkpoint show ${idOf(checkpoint)}\`, and start a follow-up task if the work is still needed.`,
    });
  }
  return findings;
}
