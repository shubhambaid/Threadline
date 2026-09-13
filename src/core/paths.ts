import { realpath } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";

export const THREADLINE_DIR = ".threadline";

export type PathProblem =
  | "empty"
  | "nul"
  | "absolute"
  | "home"
  | "drive"
  | "backslash"
  | "empty-segment"
  | "dot-segment";

export const PATH_PROBLEM_MESSAGES: Record<PathProblem, string> = {
  empty: "path is empty",
  nul: "path contains a NUL byte",
  absolute: "path must be repository-relative, not absolute",
  home: "path must not start with ~",
  drive: "path must not contain a drive letter",
  backslash: "path must use / separators, not backslashes",
  "empty-segment": "path must not contain empty segments (//)",
  "dot-segment": "path must not contain '.' or '..' segments",
};

/**
 * Lexical safety check for repository paths and globs. Mirrors the `repoPath` pattern in
 * schemas/common.schema.json (a unit test keeps the two in agreement).
 */
export function checkRepoPath(p: string): PathProblem | undefined {
  if (p.length === 0) return "empty";
  if (p.includes("\0")) return "nul";
  if (p.startsWith("/")) return "absolute";
  if (p.startsWith("~")) return "home";
  if (/^[A-Za-z]:/.test(p)) return "drive";
  if (p.includes("\\")) return "backslash";
  if (p.includes("//")) return "empty-segment";
  if (p.split("/").some((segment) => segment === "." || segment === "..")) return "dot-segment";
  return undefined;
}

export function isGlob(p: string): boolean {
  return /[*?[\]{}]/.test(p);
}

export type Containment = "inside" | "outside" | "missing";

/**
 * Resolves symlinks and reports whether a lexically safe path stays inside the repository.
 * For a path that does not exist, the nearest existing ancestor is checked instead, so a
 * missing file under a symlinked directory that escapes the repo is still `outside`.
 */
export async function checkContainment(root: string, p: string): Promise<Containment> {
  const realRoot = await realpath(root);
  let candidate = path.join(root, p);
  let missing = false;
  for (;;) {
    try {
      const real = await realpath(candidate);
      const relative = path.relative(realRoot, real);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return "outside";
      return missing ? "missing" : "inside";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing = true;
      const parent = path.dirname(candidate);
      if (parent === candidate) return "missing";
      candidate = parent;
    }
  }
}

/**
 * Matcher for scope paths. A glob matches as written. A plain path matches itself and,
 * when it names a directory, everything beneath it.
 */
export function scopeMatcher(patterns: readonly string[]): (file: string) => boolean {
  const expanded = patterns.flatMap((pattern) => {
    if (isGlob(pattern)) return [pattern];
    const trimmed = pattern.replace(/\/+$/, "");
    return [trimmed, `${trimmed}/**`];
  });
  if (expanded.length === 0) return () => false;
  return picomatch(expanded, { dot: true });
}

export interface Expansion {
  files: string[];
  /** True when matching stopped at the limit. */
  truncated: boolean;
}

/** Expands scope patterns against tracked files only, stopping at `limit` matches. */
export function expandScope(
  trackedFiles: readonly string[],
  patterns: readonly string[],
  limit: number,
): Expansion {
  const matches = scopeMatcher(patterns);
  const files: string[] = [];
  for (const file of trackedFiles) {
    if (!matches(file)) continue;
    if (files.length >= limit) return { files, truncated: true };
    files.push(file);
  }
  return { files, truncated: false };
}
