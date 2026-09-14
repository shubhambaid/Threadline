import { createHash } from "node:crypto";
import { hashWorkingTreeFiles, headCommit, listTrackedFiles } from "../git/git.js";
import { ALETHIC_DIR, checkRepoPath, expandScope, isGlob, scopeMatcher } from "./paths.js";

export interface Anchor {
  commit: string;
  fingerprints: Record<string, string>;
  overflow?: { count: number; digest: string };
}

export interface AnchorInput {
  scopePaths?: readonly string[];
  evidenceFiles?: readonly string[];
}

export interface AnchorLimits {
  maxFingerprints: number;
  maxGlobMatches: number;
  forbiddenGlobs: readonly string[];
}

export interface AnchorResult {
  /** Undefined when the repository has no commits yet. */
  anchor?: Anchor;
  warnings: string[];
}

/**
 * Captures content fingerprints for a record (docs/spec.md §9, §10): cited evidence files first,
 * then tracked files matched by scope, each group sorted by path. Files beyond the limit are
 * summarized in `overflow`. Working-tree content is hashed, so uncommitted edits count.
 */
export async function captureAnchor(
  root: string,
  input: AnchorInput,
  limits: AnchorLimits,
): Promise<AnchorResult> {
  const warnings: string[] = [];
  const head = await headCommit(root);
  if (!head) return { warnings: ["The repository has no commits yet, so no anchor was captured."] };

  const forbidden = scopeMatcher(limits.forbiddenGlobs);
  const excluded = (file: string) =>
    file.startsWith(`${ALETHIC_DIR}/`) || checkRepoPath(file) !== undefined || forbidden(file);

  const evidence = [...new Set(input.evidenceFiles ?? [])]
    .filter((file) => !isGlob(file) && !excluded(file))
    .sort();
  const evidenceSet = new Set(evidence);

  const scopePaths = input.scopePaths ?? [];
  let scoped: string[] = [];
  if (scopePaths.length > 0) {
    const expansion = expandScope(await listTrackedFiles(root), scopePaths, limits.maxGlobMatches);
    if (expansion.truncated) {
      warnings.push(
        `Scope matched more than ${limits.maxGlobMatches} tracked files; only the first ${limits.maxGlobMatches} were considered.`,
      );
    }
    scoped = expansion.files.filter((file) => !evidenceSet.has(file) && !excluded(file));
  }

  const ordered = [...evidence, ...scoped];
  const blobs = await hashWorkingTreeFiles(root, ordered);
  const present = ordered.filter((file) => blobs.has(file));
  const primary = present.slice(0, limits.maxFingerprints);
  const rest = present.slice(limits.maxFingerprints);

  const anchor: Anchor = {
    commit: head,
    fingerprints: Object.fromEntries(primary.map((file) => [file, blobs.get(file) ?? ""])),
  };
  if (rest.length > 0) {
    anchor.overflow = {
      count: rest.length,
      digest: digestOf(rest.map((file) => `${blobs.get(file)} ${file}`).join("\n")),
    };
    warnings.push(
      `${rest.length} matched files beyond the fingerprint limit (${limits.maxFingerprints}) were summarized in anchor.overflow.`,
    );
  }
  return { anchor, warnings };
}

/** Git-style SHA-1 blob id of `text`, used as the overflow digest. */
export function digestOf(text: string): string {
  const body = Buffer.from(text, "utf8");
  return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
}
