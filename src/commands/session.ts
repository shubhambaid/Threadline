import { newSessionId } from "../core/identity.js";
import type { Io } from "./context.js";

/**
 * Prints a fresh session id for ALETHIC_SESSION, so separate runs of the same agent tool are
 * recorded as different writers: `export ALETHIC_SESSION=$(alethic session new)`.
 */
export async function sessionNewCommand(io: Io, options: { agent?: string }): Promise<number> {
  io.stdout(`${newSessionId(options.agent ?? io.env.ALETHIC_AGENT ?? "s")}\n`);
  return 0;
}
