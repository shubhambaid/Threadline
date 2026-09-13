import { execFile } from "node:child_process";
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
 * Changes under `.threadline/` are ignored by default, since writing records must not make
 * the code state look dirty.
 */
export async function isDirty(
  root: string,
  options: { includeThreadline?: boolean } = {},
): Promise<boolean> {
  const args = ["status", "--porcelain=v1", "--untracked-files=normal", "--", "."];
  if (!options.includeThreadline) args.push(":(exclude).threadline");
  return (await gitOk(root, args)).trim().length > 0;
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
