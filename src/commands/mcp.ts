import { UsageError } from "../core/errors.js";
import { isInitialized } from "../core/manifest.js";
import { createMcpHandler, type RunCli } from "../mcp/server.js";
import { serveStdio } from "../mcp/stdio.js";
import { type Io, resolveRepoRoot } from "./context.js";

/**
 * Serves MCP over stdio until the client closes stdin. Startup problems are logged to stderr and
 * the server keeps running, so the agent sees a tool error that explains them.
 */
export async function mcpCommand(io: Io, run: RunCli): Promise<number> {
  let cwd = io.cwd;
  try {
    cwd = await resolveRepoRoot(io);
    if (!(await isInitialized(cwd))) {
      io.stderr(`alethic mcp: ${cwd} has no .alethic/ yet; run \`alethic init\`.\n`);
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`alethic mcp: ${error.message}\n`);
  }
  const handler = createMcpHandler({ io: { ...io, cwd }, run });
  await serveStdio(handler, io.stdin ?? process.stdin, io.stdout);
  return 0;
}
