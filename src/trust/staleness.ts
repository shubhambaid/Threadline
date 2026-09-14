import { readFile } from "node:fs/promises";
import path from "node:path";
import { digestOf } from "../core/anchor.js";
import { exists } from "../core/fs.js";
import { asArray, asObject, asString } from "../core/json.js";
import type { Manifest } from "../core/manifest.js";
import { ALETHIC_DIR, checkRepoPath, expandScope, isGlob, scopeMatcher } from "../core/paths.js";
import {
  hashWorkingTreeFiles,
  headCommit,
  isAncestor,
  listTrackedFiles,
  readBlob,
  resolveCommit,
} from "../git/git.js";
import { collectPaths } from "../validate/references.js";

/**
 * Derived at read time, never written into records (docs/spec.md §9). From most to least severe:
 *
 * - `broken_evidence`: a cited evidence file no longer exists.
 * - `diverged`: anchored on another line of history, and the direct content here differs.
 * - `needs_reverification`: direct content changed, by any amount.
 * - `uncertain`: whether the record still applies cannot be established, e.g. nothing was
 *   fingerprinted, or a cited file has no fingerprint.
 * - `scope_changed`: direct content is unchanged, but files matched only by a scope glob changed.
 * - `unchanged`: every fingerprint that counts matches the current tree.
 * - `unanchored`: the record names no files, so there is nothing to compare.
 */
export type DerivedStatus =
  | "unchanged"
  | "scope_changed"
  | "uncertain"
  | "needs_reverification"
  | "diverged"
  | "broken_evidence"
  | "unanchored";

/** Statuses meaning the claim may no longer hold for this code. */
export const STALE_STATUSES: ReadonlySet<DerivedStatus> = new Set([
  "needs_reverification",
  "diverged",
  "broken_evidence",
]);

/**
 * How much review a content change calls for. Size orders review work; it says nothing about
 * whether the claim still holds, since a one-line change can reverse a condition.
 */
export type ReviewPriority = "small" | "large" | "unknown";

/** Where the anchor commit sits relative to HEAD. */
export type AnchorRelation = "ancestor" | "other-line" | "unavailable" | "none";

export interface StalenessResult {
  status: DerivedStatus;
  /** Why the status is not `unchanged`, most important first. */
  reasons: string[];
  /** Informational observations, including context changes that do not affect direct evidence. */
  notes: string[];
  anchor: AnchorRelation;
  /** Set when direct content changed. */
  review?: ReviewPriority;
  /** Direct files (evidence, or exact scope paths) whose content changed or was removed. */
  changedDirect: string[];
  /** Files matched only by a scope glob that changed, were removed, or were added. */
  changedContext: string[];
}

/** Caches Git lookups across many records. Create one per command run. */
export interface StalenessContext {
  root: string;
  head: string | undefined;
  threshold: number;
  maxGlobMatches: number;
  excluded: (file: string) => boolean;
  trackedFiles?: string[];
  blobs: Map<string, string | null>;
  relations: Map<string, Promise<AnchorRelation>>;
}

export async function createStalenessContext(
  root: string,
  manifest: Manifest,
): Promise<StalenessContext> {
  const forbidden = scopeMatcher(manifest.privacy.forbidden_globs);
  return {
    root,
    head: await headCommit(root),
    threshold: manifest.staleness.changed_lines_threshold,
    maxGlobMatches: manifest.limits.max_glob_matches,
    excluded: (file) =>
      file.startsWith(`${ALETHIC_DIR}/`) || checkRepoPath(file) !== undefined || forbidden(file),
    blobs: new Map(),
    relations: new Map(),
  };
}

/** Beyond this many edits, the diff stops and reports every differing line as changed. */
const MAX_EDIT_DISTANCE = 20_000;

/**
 * Lines added and deleted between two texts, from a longest-common-subsequence diff, so moving
 * or reordering lines counts as a change. Very large diffs fall back to an upper bound.
 */
export function lineDelta(before: string, after: string): { added: number; deleted: number } {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return { added: m, deleted: n };
  const distance = editDistance(a.slice(start, endA), b.slice(start, endB));
  if (distance === undefined) return { added: m, deleted: n };
  const common = (n + m - distance) / 2;
  return { added: m - common, deleted: n - common };
}

/** Myers' O(ND) insert/delete edit distance, or undefined past MAX_EDIT_DISTANCE. */
function editDistance(a: readonly string[], b: readonly string[]): number | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const furthest = new Int32Array(2 * max + 3);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down =
        k === -d || (k !== d && (furthest[offset + k - 1] ?? 0) < (furthest[offset + k + 1] ?? 0));
      let x = down ? (furthest[offset + k + 1] ?? 0) : (furthest[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      furthest[offset + k] = x;
      if (x >= n && y >= m) return d;
    }
  }
  return undefined;
}

const REVIEW_RANK: Record<ReviewPriority, number> = { small: 1, large: 2, unknown: 3 };

function higher(a: ReviewPriority | undefined, b: ReviewPriority): ReviewPriority {
  return a !== undefined && REVIEW_RANK[a] >= REVIEW_RANK[b] ? a : b;
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

async function currentBlobs(
  ctx: StalenessContext,
  files: readonly string[],
): Promise<Map<string, string | null>> {
  const missing = files.filter((file) => !ctx.blobs.has(file));
  if (missing.length > 0) {
    const hashed = await hashWorkingTreeFiles(ctx.root, missing);
    for (const file of missing) ctx.blobs.set(file, hashed.get(file) ?? null);
  }
  return ctx.blobs;
}

async function trackedFiles(ctx: StalenessContext): Promise<string[]> {
  ctx.trackedFiles ??= await listTrackedFiles(ctx.root);
  return ctx.trackedFiles;
}

function relationOf(ctx: StalenessContext, commit: string): Promise<AnchorRelation> {
  let relation = ctx.relations.get(commit);
  if (!relation) {
    relation = (async (): Promise<AnchorRelation> => {
      const full = await resolveCommit(ctx.root, commit);
      if (!full) return "unavailable";
      if (ctx.head && (await isAncestor(ctx.root, full, ctx.head))) return "ancestor";
      return "other-line";
    })();
    ctx.relations.set(commit, relation);
  }
  return relation;
}

/**
 * Content-based staleness. Any change to direct evidence needs re-verification, whatever its
 * size. Commit ancestry is only a hint: a record whose anchored content still matches stays
 * `unchanged` after its commit is squash-merged away.
 */
export async function assessStaleness(
  ctx: StalenessContext,
  data: Record<string, unknown>,
): Promise<StalenessResult> {
  const reasons: string[] = [];
  const notes: string[] = [];
  const changedDirect: string[] = [];
  const changedContext: string[] = [];

  const evidenceFiles = [
    ...new Set(
      collectPaths(data)
        .filter((field) => field.role === "evidence")
        .map((field) => field.value),
    ),
  ]
    .filter((file) => checkRepoPath(file) === undefined && !isGlob(file))
    .sort();
  const missingEvidence = new Set<string>();
  for (const file of evidenceFiles) {
    if (!(await exists(path.join(ctx.root, file)))) {
      missingEvidence.add(file);
      reasons.push(`${file} no longer exists`);
    }
  }
  const broken = missingEvidence.size > 0;

  const scopePaths = asArray(asObject(data.scope)?.paths).filter(
    (p): p is string => typeof p === "string",
  );
  const anchor = asObject(data.anchor);
  const fingerprints = asObject(anchor?.fingerprints) ?? {};
  const anchored = Object.keys(fingerprints).sort();
  const overflow = asObject(anchor?.overflow);
  if (!anchor || (anchored.length === 0 && !overflow)) {
    const base = { notes, anchor: "none" as const, changedDirect, changedContext };
    if (broken) return { status: "broken_evidence", reasons, ...base };
    if (evidenceFiles.length === 0 && scopePaths.length === 0) {
      return { status: "unanchored", reasons, ...base };
    }
    reasons.push(
      "nothing was fingerprinted when it was recorded, so changes to the code it describes cannot be detected",
    );
    return { status: "uncertain", reasons, ...base };
  }

  // Direct files are cited as evidence or named exactly in scope. When a record has any, files
  // matched only by a scope glob (or a directory) are context: their edits are reported as scope
  // changes, not as changes to the evidence. A record anchored only by globs has no direct files,
  // so every matched file counts as direct for it.
  const evidenceSet = new Set(evidenceFiles);
  const exactScope = new Set(scopePaths.filter((p) => !isGlob(p)));
  const isDirect = (file: string) => evidenceSet.has(file) || exactScope.has(file);
  const hasDirect = evidenceFiles.length > 0 || anchored.some(isDirect);
  const counts = (file: string) => !hasDirect || isDirect(file);
  const anchoredSet = new Set(anchored);

  let review: ReviewPriority | undefined;
  let differs = false;
  const blobs = await currentBlobs(ctx, anchored);
  for (const file of anchored) {
    const before = asString(fingerprints[file]);
    const current = blobs.get(file) ?? null;
    if (current === before) continue;
    const direct = counts(file);

    if (current === null) {
      if (!direct) {
        changedContext.push(file);
        notes.push(`${file} was deleted, but only a scope glob matched it`);
        continue;
      }
      differs = true;
      changedDirect.push(file);
      review = higher(review, "large");
      if (!evidenceSet.has(file)) reasons.push(`${file} was deleted`);
      continue;
    }

    const previous = before ? await readBlob(ctx.root, before) : undefined;
    if (previous === undefined) {
      if (!direct) {
        changedContext.push(file);
        notes.push(`${file} changed, but only a scope glob matches it`);
        continue;
      }
      differs = true;
      changedDirect.push(file);
      review = higher(review, "unknown");
      reasons.push(
        `${file} changed, and the anchored version is not in this repository, so the size of the change is unknown`,
      );
      continue;
    }

    const { added, deleted } = lineDelta(
      previous,
      await readFile(path.join(ctx.root, file), "utf8"),
    );
    const total = added + deleted;
    const size =
      total === 0
        ? "changed only in whitespace or line endings"
        : `changed ${count(total, "line")} (+${added}/-${deleted})`;
    if (!direct) {
      changedContext.push(file);
      notes.push(`${file} ${size}, but only a scope glob matches it`);
      continue;
    }
    differs = true;
    changedDirect.push(file);
    review = higher(review, total <= ctx.threshold ? "small" : "large");
    reasons.push(`${file} ${size} since it was anchored`);
  }

  // Cited evidence without a fingerprint of its own, e.g. added to the record by hand.
  const uncovered = evidenceFiles.filter(
    (file) => !anchoredSet.has(file) && !missingEvidence.has(file) && !ctx.excluded(file),
  );
  const uncertain: string[] = [];
  if (uncovered.length > 0 && !overflow) {
    uncertain.push(
      `${uncovered.slice(0, 3).join(", ")}${uncovered.length > 3 ? ", …" : ""} ${uncovered.length === 1 ? "is" : "are"} cited as evidence but not fingerprinted, so changes cannot be detected`,
    );
  }

  if (scopePaths.length > 0) {
    const matched = expandScope(
      await trackedFiles(ctx),
      scopePaths,
      ctx.maxGlobMatches,
    ).files.filter((file) => !ctx.excluded(file));
    const list = (files: string[]) =>
      `${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}`;
    if (!overflow) {
      const added = matched.filter((file) => !anchoredSet.has(file));
      const direct = added.filter(counts);
      const context = added.filter((file) => !counts(file));
      if (direct.length > 0) {
        differs = true;
        changedDirect.push(...direct);
        review = higher(review, "large");
        reasons.push(`${count(direct.length, "file")} added under scope: ${list(direct)}`);
      }
      if (context.length > 0) {
        changedContext.push(...context);
        notes.push(`${count(context.length, "file")} added under a scope glob: ${list(context)}`);
      }
    } else {
      // Recompute the overflow digest in the same order captureAnchor used.
      const ordered = [
        ...evidenceFiles.filter((file) => !ctx.excluded(file)),
        ...matched.filter((file) => !evidenceSet.has(file)),
      ];
      const rest = ordered.filter((file) => !anchoredSet.has(file));
      const restBlobs = await currentBlobs(ctx, rest);
      const present = rest.filter((file) => restBlobs.get(file));
      const digest = digestOf(present.map((file) => `${restBlobs.get(file)} ${file}`).join("\n"));
      if (present.length !== overflow.count || digest !== overflow.digest) {
        // Evidence beyond the limit lives in the overflow digest, so a change there is direct.
        if (!hasDirect || uncovered.length > 0) {
          differs = true;
          review = higher(review, "unknown");
          reasons.push("files beyond the fingerprint limit changed");
        } else {
          notes.push("files beyond the fingerprint limit changed, but only scope globs match them");
        }
        if (hasDirect && uncovered.length === 0)
          changedContext.push("(files beyond the fingerprint limit)");
      }
    }
  }

  const commit = asString(anchor.commit);
  const relation = commit ? await relationOf(ctx, commit) : "unavailable";
  if (relation === "unavailable") {
    notes.push(
      `anchor commit ${commit ?? "(none)"} is not in this repository (squash merge, rebase, or shallow clone?)`,
    );
  }

  let status: DerivedStatus = "unchanged";
  if (broken) {
    status = "broken_evidence";
  } else if (relation === "other-line" && differs) {
    status = "diverged";
    reasons.unshift("anchored on another line of history, and the content here differs");
  } else if (differs) {
    status = "needs_reverification";
  } else if (uncertain.length > 0) {
    status = "uncertain";
  } else if (changedContext.length > 0) {
    status = "scope_changed";
    reasons.push(...notes.filter((note) => !note.startsWith("anchor commit ")));
  }
  reasons.push(...uncertain);
  if (relation === "other-line" && !differs) {
    notes.push("anchored on another line of history, but the content matches");
  }
  return {
    status,
    reasons,
    notes,
    anchor: relation,
    ...(differs && review ? { review } : {}),
    changedDirect,
    changedContext,
  };
}
