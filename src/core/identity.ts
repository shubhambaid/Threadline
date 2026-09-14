import { randomBytes } from "node:crypto";
import { UsageError } from "./errors.js";

const AGENT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Mirrors `sessionId` in schemas/common.schema.json. */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

/**
 * Who is writing (docs/spec.md §5). The agent is the tool, such as codex; the session is one run
 * of it, so two sessions of the same tool are different writers. The model is recorded only
 * when the caller states it, never guessed.
 */
export interface Identity {
  agent: string;
  session?: string;
  model?: string;
}

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

/** Agent from `--agent` or ALETHIC_AGENT; session from ALETHIC_SESSION; model from ALETHIC_MODEL. */
export function resolveIdentity(
  agentFlag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Identity {
  const agent = resolveAgent(agentFlag, env);
  const session = env.ALETHIC_SESSION?.trim() || undefined;
  if (session !== undefined && !SESSION_ID.test(session)) {
    throw new UsageError(
      `Invalid ALETHIC_SESSION "${session}": use letters, digits, '.', '_', ':' or '-', at most 80 characters. \`alethic session new\` prints one.`,
    );
  }
  const model = env.ALETHIC_MODEL?.trim() || undefined;
  if (model !== undefined && model.length > 100) {
    throw new UsageError("ALETHIC_MODEL must be at most 100 characters.");
  }
  return { agent, ...(session ? { session } : {}), ...(model ? { model } : {}) };
}

/** A fresh session id, such as `codex-3f9a0c2b7d1e`. */
export function newSessionId(prefix = "s"): string {
  const safe = AGENT_NAME.test(prefix) ? prefix : "s";
  return `${safe}-${randomBytes(6).toString("hex")}`;
}

export interface Writer {
  agent?: string;
  session?: string;
}

/**
 * Whether two writers are known to be different: different agents, or the same agent with two
 * different recorded sessions. Without sessions, two runs of one tool cannot be told apart.
 */
export function distinctWriters(a: Writer, b: Writer): boolean {
  if (a.agent !== b.agent) return true;
  return a.session !== undefined && b.session !== undefined && a.session !== b.session;
}

/** `codex (session codex-3f9a0c2b7d1e)`, or just `codex` when no session was recorded. */
export function describeWriter(writer: Writer): string {
  const agent = writer.agent ?? "an unknown agent";
  return writer.session ? `${agent} (session ${writer.session})` : agent;
}
