import { UsageError } from "../core/errors.js";
import { newSessionId } from "../core/identity.js";
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
  // Each MCP connection is one session. Without ALETHIC_SESSION, give it an id of its own, so two
  // concurrent sessions of the same agent tool are recorded as different writers.
  const env = io.env.ALETHIC_SESSION ? io.env : { ...io.env, ALETHIC_SESSION: newSessionId("mcp") };
  const handler = createMcpHandler({ io: { ...io, cwd, env }, run });
  await serveStdio(handler, io.stdin ?? process.stdin, io.stdout);
  return 0;
}
