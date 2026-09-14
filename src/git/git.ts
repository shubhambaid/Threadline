import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  override name = "GitError";
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs git without a shell. Non-zero exits are returned, not thrown. */
export async function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const code = (e as { code?: unknown }).code;
    if (typeof code === "number") {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code };
    }
    if (code === "ENOENT") throw new GitError("git is not installed or not on PATH");
    throw error;
  }
}

async function gitOk(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) {
    throw new GitError(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export async function findRepoRoot(cwd: string): Promise<string | undefined> {
  const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Full sha of HEAD, or undefined in a repository with no commits yet. */
export async function headCommit(root: string): Promise<string | undefined> {
  const result = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Current branch name, or undefined when HEAD is detached. */
export async function currentBranch(root: string): Promise<string | undefined> {
  const result = await git(root, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Best guess at the repository's default branch: origin's HEAD, then main/master, then git's init default. */
export async function guessDefaultBranch(root: string): Promise<string> {
  const remote = await git(root, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const remoteName = remote.code === 0 ? remote.stdout.trim().replace(/^origin\//, "") : "";
  if (remoteName) return remoteName;
  for (const candidate of ["main", "master"]) {
    const ref = await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (ref.code === 0) return candidate;
  }
  const configured = await git(root, ["config", "--get", "init.defaultBranch"]);
  return configured.code === 0 && configured.stdout.trim() ? configured.stdout.trim() : "main";
}

export async function shortSha(root: string, sha: string): Promise<string> {
  return (await gitOk(root, ["rev-parse", "--short", sha])).trim();
}

/**
 * Whether the working tree has uncommitted changes, including untracked files.
 * Changes under `.alethic/` are ignored by default, since writing records must not make
 * the code state look dirty.
 */
export async function isDirty(
  root: string,
  options: { includeAlethic?: boolean } = {},
): Promise<boolean> {
  const args = ["status", "--porcelain=v1", "--untracked-files=normal", "--", "."];
  if (!options.includeAlethic) args.push(":(exclude).alethic");
  return (await gitOk(root, args)).trim().length > 0;
}

/** Full sha for an abbreviated or full commit id, or undefined if it is not in the repository. */
export async function resolveCommit(root: string, sha: string): Promise<string | undefined> {
  const result = await git(root, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Full sha of a local branch, falling back to origin's copy of it. */
export async function resolveBranchRef(root: string, branch: string): Promise<string | undefined> {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const result = await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (result.code === 0) return result.stdout.trim();
  }
  return undefined;
}

export async function mergeBase(root: string, a: string, b: string): Promise<string | undefined> {
  const result = await git(root, ["merge-base", a, b]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/**
 * Whether any file outside `.alethic/` differs between two commits. Committing records
 * alone does not count as a code change. Undefined if either commit is missing.
 */
export async function codeChangedBetween(
  root: string,
  from: string,
  to: string,
): Promise<boolean | undefined> {
  const result = await git(root, ["diff", "--quiet", from, to, "--", ".", ":(exclude).alethic"]);
  if (result.code === 0) return false;
  if (result.code === 1) return true;
  return undefined;
}

/** Commits in `from..to` when `from` is an ancestor of `to`; otherwise undefined. */
export async function commitsSince(
  root: string,
  from: string,
  to: string,
): Promise<number | undefined> {
  if (!(await isAncestor(root, from, to))) return undefined;
  const result = await git(root, ["rev-list", "--count", `${from}..${to}`]);
  return result.code === 0 ? Number(result.stdout.trim()) : undefined;
}

/** Content of a blob, or undefined if the object is not in the repository. */
export async function readBlob(root: string, blob: string): Promise<string | undefined> {
  const result = await git(root, ["cat-file", "blob", blob]);
  return result.code === 0 ? result.stdout : undefined;
}

/**
 * Git blob ids of working-tree files, as `git add` would store them.
 * Missing files, directories, and symlinks are skipped.
 */
export async function hashWorkingTreeFiles(
  root: string,
  files: readonly string[],
): Promise<Map<string, string>> {
  const regular: string[] = [];
  for (const file of files) {
    const info = await lstat(join(root, file)).catch(() => undefined);
    if (info?.isFile()) regular.push(file);
  }
  const blobs = new Map<string, string>();
  for (let start = 0; start < regular.length; start += 200) {
    const chunk = regular.slice(start, start + 200);
    const ids = (await gitOk(root, ["hash-object", "--", ...chunk])).trim().split("\n");
    chunk.forEach((file, index) => {
      const id = ids[index];
      if (id) blobs.set(file, id);
    });
  }
  return blobs;
}

/**
 * Paths changed relative to `base` (committed since base, staged, unstaged) plus untracked
 * files, excluding `.alethic/`. Without a base, changes relative to HEAD. Sorted, unique.
 */
export async function changedPathsSince(root: string, base: string | undefined): Promise<string[]> {
  const files = new Set<string>();
  const add = (output: string) => {
    for (const file of output.split("\0")) {
      if (file && !file.startsWith(".alethic/")) files.add(file);
    }
  };
  const against = base ?? (await headCommit(root));
  if (against) add(await gitOk(root, ["diff", "--name-only", "-z", against, "--"]));
  add(await gitOk(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...files].sort();
}

export async function isShallow(root: string): Promise<boolean> {
  return (await gitOk(root, ["rev-parse", "--is-shallow-repository"])).trim() === "true";
}

export async function commitExists(root: string, sha: string): Promise<boolean> {
  return (await git(root, ["cat-file", "-e", `${sha}^{commit}`])).code === 0;
}

export async function isAncestor(
  root: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  return (await git(root, ["merge-base", "--is-ancestor", ancestor, descendant])).code === 0;
}

/** Tracked files (index), repository-relative, sorted. */
export async function listTrackedFiles(root: string): Promise<string[]> {
  const out = await gitOk(root, ["ls-files", "-z", "--cached"]);
  return out
    .split("\0")
    .filter((file) => file.length > 0)
    .sort();
}

export interface GitLookups {
  resolveCommit(sha: string): Promise<string | undefined>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  codeChangedBetween(from: string, to: string): Promise<boolean | undefined>;
  commitsSince(from: string, to: string): Promise<number | undefined>;
}

/**
 * Commit queries memoized for one command run. A large ledger names the same few commits many
 * times, and each uncached query is a git process, which dominated `resume` on large ledgers.
 */
export function createGitLookups(root: string): GitLookups {
  const memo = <T>(query: (...args: string[]) => Promise<T>) => {
    const cache = new Map<string, Promise<T>>();
    return (...args: string[]): Promise<T> => {
      const key = args.join("\0");
      let hit = cache.get(key);
      if (!hit) {
        hit = query(...args);
        cache.set(key, hit);
      }
      return hit;
    };
  };
  return {
    resolveCommit: memo((sha) => resolveCommit(root, sha ?? "")),
    isAncestor: memo((a, b) => isAncestor(root, a ?? "", b ?? "")),
    codeChangedBetween: memo((a, b) => codeChangedBetween(root, a ?? "", b ?? "")),
    commitsSince: memo((a, b) => commitsSince(root, a ?? "", b ?? "")),
  };
}

/** Tracked files plus untracked files that are not ignored, repository-relative, sorted. */
export async function listWorkspaceFiles(root: string): Promise<string[]> {
  const out = await gitOk(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  return [...new Set(out.split("\0").filter((file) => file.length > 0))].sort();
}

/**
 * Content of `path` in the commit that first added it, or undefined if it was never committed.
 * Used to enforce that checkpoints and receipts are append-only.
 */
export async function firstCommittedContent(
  root: string,
  path: string,
): Promise<string | undefined> {
  const log = await git(root, ["log", "--diff-filter=A", "--format=%H", "--", path]);
  if (log.code !== 0) return undefined;
  const commits = log.stdout.trim().split("\n").filter(Boolean);
  const first = commits.at(-1);
  if (!first) return undefined;
  const show = await git(root, ["show", `${first}:${path}`]);
  return show.code === 0 ? show.stdout : undefined;
}
