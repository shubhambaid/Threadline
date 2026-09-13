import { runCli } from "../../src/program.js";

/** Fixed clock for tests. Fixture leases are written relative to this time. */
export const TEST_NOW = "2026-09-13T21:00:00Z";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in-process with a clean environment (no THREADLINE_AGENT from the host). */
export async function cli(
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    THREADLINE_NOW: TEST_NOW,
    ...options.env,
  };
  const code = await runCli(args, {
    cwd: options.cwd,
    env,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}
