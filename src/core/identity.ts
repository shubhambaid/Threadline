import { UsageError } from "./errors.js";

const AGENT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The agent writing records: `--agent` wins, then ALETHIC_AGENT. */
export function resolveAgent(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = flag ?? env.ALETHIC_AGENT;
  if (!value) {
    throw new UsageError(
      "No agent identity. Pass --agent <name> or set ALETHIC_AGENT (e.g. codex, claude-code, gemini, human).",
    );
  }
  if (!AGENT_NAME.test(value)) {
    throw new UsageError(
      `Invalid agent name "${value}": use lowercase letters, digits, '.', '_' or '-' (e.g. claude-code).`,
    );
  }
  return value;
}
