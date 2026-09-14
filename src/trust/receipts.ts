import { digestOf } from "../core/anchor.js";
import { asArray, asObject, asString } from "../core/json.js";
import type { Manifest } from "../core/manifest.js";
import { ALETHIC_DIR, checkRepoPath, scopeMatcher } from "../core/paths.js";
import {
  createGitLookups,
  type GitLookups,
  hashWorkingTreeFiles,
  listWorkspaceFiles,
} from "../git/git.js";

export type Coverage = "workspace" | "scope" | "partial";

export interface WorkspaceDigest {
  digest: string;
  /** Files digested. */
  files: number;
  /** Files that matched before the limit was applied. */
  matched: number;
  coverage: Coverage;
}

/**
 * Digest of the file content a check could see: tracked and untracked (not ignored) working-tree
 * files, outside `.alethic/` and forbidden paths, limited to `scopePaths` when given. Deleted
 * tracked files drop out of the digest, so deleting a file changes it. Beyond `limit` files, only
 * the first `limit` in path order are digested and coverage is `partial`.
 */
export async function digestWorkspace(
  root: string,
  manifest: Manifest,
  scopePaths: readonly string[],
  limit: number,
): Promise<WorkspaceDigest> {
  const forbidden = scopeMatcher(manifest.privacy.forbidden_globs);
  const inScope = scopePaths.length > 0 ? scopeMatcher(scopePaths) : () => true;
  const matched = (await listWorkspaceFiles(root)).filter(
    (file) =>
      !file.startsWith(`${ALETHIC_DIR}/`) &&
      checkRepoPath(file) === undefined &&
      !forbidden(file) &&
      inScope(file),
  );
  const counted = matched.slice(0, limit);
  const blobs = await hashWorkingTreeFiles(root, counted);
  const lines = counted.flatMap((file) => {
    const blob = blobs.get(file);
    return blob ? [`${blob} ${file}`] : [];
  });
  return {
    digest: digestOf(lines.join("\n")),
    files: lines.length,
    matched: matched.length,
    coverage: matched.length > limit ? "partial" : scopePaths.length > 0 ? "scope" : "workspace",
  };
}

/**
 * Whether a receipt's result applies to the code as it is now (docs/spec.md §6.5):
 *
 * - `same-content`, `content-changed`: observed by `receipt run`; the files it could see are
 *   compared by content with the files now, so an edit without a commit is caught.
 * - `changed-during-run`: observed, but files changed while it ran, so what it tested is unclear.
 * - `at-head`, `code-unchanged`, `code-changed`: imported; compared by commit, which is sound only
 *   when neither the run nor the current tree had uncommitted changes.
 * - `uncommitted`: imported, and the run or the current tree had uncommitted changes, so a
 *   commit comparison cannot say what the check ran on.
 * - `unknown`: the commit it ran on is not in this repository.
 */
export type ReceiptApplicability =
  | "same-content"
  | "content-changed"
  | "changed-during-run"
  | "at-head"
  | "uncommitted"
  | "code-unchanged"
  | "code-changed"
  | "unknown";

export interface ReceiptAssessment {
  applicability: ReceiptApplicability;
  /** Alethic ran the command and captured state (`receipt run`), rather than being told. */
  observed: boolean;
  coverage?: Coverage;
  /** The working tree had uncommitted changes when the check ran (or was reported). */
  ranDirty: boolean;
  /** The receipt's commit is the current HEAD. */
  atHead: boolean;
  /** False when the code is known unchanged since; true when known changed; else undefined. */
  codeChanged?: boolean;
}

export interface ReceiptContext {
  root: string;
  manifest: Manifest;
  head?: string;
  /** Whether the current tree has uncommitted changes outside `.alethic/`. */
  dirty: boolean;
  lookups: GitLookups;
  digests: Map<string, Promise<WorkspaceDigest>>;
}

export function createReceiptContext(
  root: string,
  manifest: Manifest,
  git: { head?: string; dirty: boolean },
  lookups: GitLookups = createGitLookups(root),
): ReceiptContext {
  return { root, manifest, head: git.head, dirty: git.dirty, lookups, digests: new Map() };
}

export async function assessReceipt(
  ctx: ReceiptContext,
  data: Record<string, unknown>,
): Promise<ReceiptAssessment> {
  const git = asObject(data.git);
  const head = asString(git?.head);
  const resolved = head ? await ctx.lookups.resolveCommit(head) : undefined;
  const atHead = resolved !== undefined && resolved === ctx.head;
  const ranDirty = git?.dirty === true;
  const state = asObject(data.state);
  const observed = asObject(data.provenance)?.capture === "observed" && state !== undefined;

  if (observed && state) {
    const coverage = asString(state.coverage) as Coverage | undefined;
    const base = { observed, coverage, ranDirty, atHead };
    if (state.changed_during_run === true) {
      return { applicability: "changed-during-run", ...base };
    }
    const limit = typeof state.file_limit === "number" ? state.file_limit : 1;
    const scope =
      coverage === "workspace"
        ? []
        : asArray(asObject(data.scope)?.paths).filter((p): p is string => typeof p === "string");
    const key = JSON.stringify([scope, limit]);
    let current = ctx.digests.get(key);
    if (!current) {
      current = digestWorkspace(ctx.root, ctx.manifest, scope, limit);
      ctx.digests.set(key, current);
    }
    const same = asString(asObject(state.after)?.digest) === (await current).digest;
    return {
      applicability: same ? "same-content" : "content-changed",
      ...base,
      // Unchanged files beyond a partial digest are not known, so only a change is certain.
      codeChanged: same ? (coverage === "partial" ? undefined : false) : true,
    };
  }

  const base = { observed: false, ranDirty, atHead };
  if (!resolved) return { applicability: "unknown", ...base };
  if (ranDirty || ctx.dirty) return { applicability: "uncommitted", ...base };
  if (atHead) return { applicability: "at-head", ...base, codeChanged: false };
  const changed = ctx.head ? await ctx.lookups.codeChangedBetween(resolved, ctx.head) : undefined;
  if (changed === undefined) return { applicability: "unknown", ...base };
  return {
    applicability: changed ? "code-changed" : "code-unchanged",
    ...base,
    codeChanged: changed,
  };
}

/** How a receipt relates to the current code, in words, short for summaries and full for detail. */
export function describeApplicability(receipt: ReceiptAssessment | undefined): {
  short: string;
  full: string;
} {
  if (!receipt) return { short: "applicability unknown", full: "applicability unknown" };
  const how = receipt.observed
    ? "observed by `alethic receipt run`"
    : "reported to Alethic, not observed";
  const files = receipt.coverage === "scope" ? "the files in its paths" : "files";
  const dirty = receipt.observed && receipt.ranDirty ? "; it ran on uncommitted changes" : "";
  switch (receipt.applicability) {
    case "same-content":
      return receipt.coverage === "partial"
        ? {
            short: "observed; digested files unchanged, coverage partial",
            full: `${how}; the files it digested are unchanged since, but it digested only part of the working tree${dirty}`,
          }
        : {
            short: `observed; ${files} unchanged since`,
            full: `${how}; ${files} unchanged since it ran${dirty}`,
          };
    case "content-changed":
      return {
        short: `observed; ${files} changed since`,
        full: `${how}; ${files} have changed since it ran${dirty}`,
      };
    case "changed-during-run":
      return {
        short: "observed; ⚠ files changed while it ran",
        full: `${how}; ⚠ files changed while it ran, so what it tested is unclear`,
      };
    case "at-head":
      return { short: "HEAD, reported", full: `HEAD; ${how}` };
    case "uncommitted":
      return receipt.ranDirty
        ? {
            short: "reported; ⚠ ran on uncommitted changes",
            full: `${how}; ⚠ it ran on uncommitted changes, so whether it applies to this code is unknown`,
          }
        : {
            short: "reported; ⚠ uncommitted changes since",
            full: `${how}; ⚠ there are uncommitted changes, so whether it applies to this code is unknown`,
          };
    case "code-unchanged":
      return { short: "code unchanged since, reported", full: `code unchanged since; ${how}` };
    case "code-changed":
      return { short: "code has changed since, reported", full: `code has changed since; ${how}` };
    default:
      return {
        short: "commit not in this repository, reported",
        full: `commit not in this repository; ${how}`,
      };
  }
}
