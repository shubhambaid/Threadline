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

/** Derived at read time, never written into records (docs/spec.md §9). */
export type DerivedStatus =
  | "fresh"
  | "unanchored"
  | "needs_reverification"
  | "diverged"
  | "broken_evidence";

/** Where the anchor commit sits relative to HEAD. */
export type AnchorRelation = "ancestor" | "other-line" | "unavailable" | "none";

export interface StalenessResult {
  status: DerivedStatus;
  /** Why the status is not fresh, most important first. */
  reasons: string[];
  /** Informational observations that do not affect the status. */
  notes: string[];
  anchor: AnchorRelation;
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

/** Lines added and deleted between two texts, compared as multisets of lines. */
export function lineDelta(before: string, after: string): { added: number; deleted: number } {
  const remaining = new Map<string, number>();
  for (const line of before.split("\n")) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after.split("\n")) {
    const available = remaining.get(line) ?? 0;
    if (available > 0) remaining.set(line, available - 1);
    else added++;
  }
  let deleted = 0;
  for (const left of remaining.values()) deleted += left;
  return { added, deleted };
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
 * Content-based staleness. Commit ancestry is only a hint: a record whose anchored content
 * still matches stays fresh after its commit is squash-merged away.
 */
export async function assessStaleness(
  ctx: StalenessContext,
  data: Record<string, unknown>,
): Promise<StalenessResult> {
  const reasons: string[] = [];
  const notes: string[] = [];

  const evidenceFiles = [
    ...new Set(
      collectPaths(data)
        .filter((field) => field.role === "evidence")
        .map((field) => field.value),
    ),
  ]
    .filter((file) => checkRepoPath(file) === undefined && !isGlob(file))
    .sort();
  let broken = false;
  for (const file of evidenceFiles) {
    if (!(await exists(path.join(ctx.root, file)))) {
      broken = true;
      reasons.push(`${file} no longer exists`);
    }
  }

  const anchor = asObject(data.anchor);
  const fingerprints = asObject(anchor?.fingerprints) ?? {};
  const anchored = Object.keys(fingerprints).sort();
  const overflow = asObject(anchor?.overflow);
  if (!anchor || (anchored.length === 0 && !overflow)) {
    return { status: broken ? "broken_evidence" : "unanchored", reasons, notes, anchor: "none" };
  }

  const scopePaths = asArray(asObject(data.scope)?.paths).filter(
    (p): p is string => typeof p === "string",
  );

  // Direct files are cited as evidence or named exactly in scope. When a record has any, files
  // matched only by a scope glob (or a directory) are context: their edits are noted but do not
  // make the record stale, so a broad glob does not flag a claim on every change nearby.
  const evidenceSet = new Set(evidenceFiles);
  const exactScope = new Set(scopePaths.filter((p) => !isGlob(p)));
  const isDirect = (file: string) => evidenceSet.has(file) || exactScope.has(file);
  const hasDirect = evidenceFiles.length > 0 || anchored.some(isDirect);
  const counts = (file: string) => !hasDirect || isDirect(file);

  let material = false;
  let differs = false;
  const blobs = await currentBlobs(ctx, anchored);
  for (const file of anchored) {
    const before = asString(fingerprints[file]);
    const current = blobs.get(file) ?? null;
    if (current === before) continue;
    const direct = counts(file);
    if (direct) differs = true;
    if (current === null) {
      if (!direct) {
        notes.push(`${file} was deleted, but only a scope glob matched it`);
        continue;
      }
      material = true;
      if (!evidenceSet.has(file)) reasons.push(`${file} was deleted`);
      continue;
    }
    const previous = before ? await readBlob(ctx.root, before) : undefined;
    if (previous === undefined) {
      if (!direct) {
        notes.push(`${file} changed, but only a scope glob matches it`);
        continue;
      }
      material = true;
      reasons.push(`${file} changed, and the anchored version is not in this repository`);
      continue;
    }
    const { added, deleted } = lineDelta(
      previous,
      await readFile(path.join(ctx.root, file), "utf8"),
    );
    const total = added + deleted;
    if (total <= ctx.threshold) {
      notes.push(`${file} changed ${total} lines, within the threshold of ${ctx.threshold}`);
    } else if (!direct) {
      notes.push(
        `${file} changed ${total} lines (+${added}/-${deleted}), but only a scope glob matches it`,
      );
    } else {
      material = true;
      reasons.push(`${file} changed ${total} lines (+${added}/-${deleted}) since it was anchored`);
    }
  }

  if (scopePaths.length > 0) {
    const matched = expandScope(
      await trackedFiles(ctx),
      scopePaths,
      ctx.maxGlobMatches,
    ).files.filter((file) => !ctx.excluded(file));
    const anchoredSet = new Set(anchored);
    if (!overflow) {
      const added = matched.filter((file) => !anchoredSet.has(file));
      const direct = added.filter(counts);
      const context = added.filter((file) => !counts(file));
      const list = (files: string[]) =>
        `${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}`;
      if (direct.length > 0) {
        material = true;
        differs = true;
        reasons.push(`${count(direct.length, "file")} added under scope: ${list(direct)}`);
      }
      if (context.length > 0) {
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
        if (hasDirect) {
          notes.push("files beyond the fingerprint limit changed, but only scope globs match them");
        } else {
          material = true;
          differs = true;
          reasons.push("files beyond the fingerprint limit changed");
        }
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

  let status: DerivedStatus = "fresh";
  if (broken) {
    status = "broken_evidence";
  } else if (relation === "other-line" && differs) {
    status = "diverged";
    reasons.unshift("anchored on another line of history, and the content here differs");
  } else if (material) {
    status = "needs_reverification";
  }
  if (relation === "other-line" && !differs) {
    notes.push("anchored on another line of history, but the content matches");
  }
  return { status, reasons, notes, anchor: relation };
}
