import { stat } from "node:fs/promises";
import { UsageError } from "../core/errors.js";
import { isInitialized } from "../core/manifest.js";
import { findRepoRoot } from "../git/git.js";

/** Everything a command needs from its environment, injectable for tests. */
export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export async function resolveRepoRoot(io: Io): Promise<string> {
  const info = await stat(io.cwd).catch(() => undefined);
  if (!info?.isDirectory()) throw new UsageError(`Directory does not exist: ${io.cwd}`);
  const root = await findRepoRoot(io.cwd);
  if (!root) throw new UsageError(`Not inside a Git repository: ${io.cwd}`);
  return root;
}

export async function requireInitialized(io: Io): Promise<string> {
  const root = await resolveRepoRoot(io);
  if (!(await isInitialized(root))) {
    throw new UsageError(
      "Threadline is not initialized in this repository. Run `threadline init` first.",
    );
  }
  return root;
}
