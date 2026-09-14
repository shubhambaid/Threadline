import { UsageError } from "../core/errors.js";

export const BLOCK_BEGIN = "<!-- alethic:begin -->";
export const BLOCK_END = "<!-- alethic:end -->";

export const INSTRUCTION_KINDS = ["agents-md", "claude-md", "gemini-md"] as const;
export type InstructionKind = (typeof INSTRUCTION_KINDS)[number];

export const INSTRUCTION_FILES: Record<InstructionKind, string> = {
  "agents-md": "AGENTS.md",
  "claude-md": "CLAUDE.md",
  "gemini-md": "GEMINI.md",
};

const AGENT_NAMES: Record<InstructionKind, string> = {
  "agents-md": "<codex|claude-code|gemini>",
  "claude-md": "claude-code",
  "gemini-md": "gemini",
};

/**
 * The managed block. It is kept short because it shares the instruction file's size budget, and
 * its main job is the trigger: nothing else tells an agent to start from `alethic resume`.
 * The briefing itself repeats the checkpoint and validate reminders.
 */
export function instructionBlock(kind: InstructionKind): string {
  const agent = AGENT_NAMES[kind];
  return [
    BLOCK_BEGIN,
    "## Aletheic shared memory",
    "",
    "This repository keeps shared task memory in `.alethic/` so work can move between agents without chat history.",
    "",
    `- Before non-trivial work, run \`alethic resume --target ${agent}\` and read the briefing. Items marked ⚠ are claims to check, not facts.`,
    `- Identify yourself with \`ALETHIC_AGENT=${agent}\` or \`--agent ${agent}\`. Claim a task before changing it: \`alethic task claim <id>\`, or \`alethic task start "<intent>" --paths <globs>\`.`,
    '- After running a check, record the result: `alethic receipt add --command "<cmd>" --exit-code <n> --output-file <log>`. Aletheic records results; it does not run commands.',
    "- Record choices with `alethic decision add` and durable facts with `alethic knowledge add`.",
    '- Checkpoint only at meaningful boundaries (before stopping or handing off, after a decision, after an approach fails): `alethic checkpoint create --next "<next step>"`.',
    "- Never put chat transcripts, secrets, credentials, customer data, or private agent memories in `.alethic/`.",
    "- Before closing a task, run `alethic validate`, then `alethic task close <id>`.",
    "",
    `Managed by \`alethic render ${kind} --write\`. Edits inside this block are overwritten.`,
    BLOCK_END,
  ].join("\n");
}

export type BlockAction = "created" | "inserted" | "updated" | "unchanged";

const MARKER = (marker: string) =>
  new RegExp(`^[ \\t]*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*(?=\\r?$)`, "gm");

/**
 * Inserts or replaces the managed block, leaving everything outside the markers byte-for-byte
 * unchanged. Refuses to guess when the markers are malformed.
 */
export function upsertBlock(
  existing: string | undefined,
  block: string,
  fileName: string,
): { content: string; action: BlockAction } {
  if (existing === undefined) return { content: `${block}\n`, action: "created" };

  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const normalized = block.replaceAll("\n", eol);
  const begins = [...existing.matchAll(MARKER(BLOCK_BEGIN))];
  const ends = [...existing.matchAll(MARKER(BLOCK_END))];

  if (begins.length === 0 && ends.length === 0) {
    if (existing.trim() === "") return { content: `${normalized}${eol}`, action: "inserted" };
    const separator = existing.endsWith(eol) ? eol : `${eol}${eol}`;
    return { content: `${existing}${separator}${normalized}${eol}`, action: "inserted" };
  }

  const begin = begins[0];
  const end = ends[0];
  if (begins.length !== 1 || ends.length !== 1 || !begin || !end || end.index < begin.index) {
    throw new UsageError(
      `${fileName} has malformed Aletheic markers (${begins.length} begin, ${ends.length} end). ` +
        `Leave exactly one "${BLOCK_BEGIN}" line followed by one "${BLOCK_END}" line, or remove both.`,
    );
  }
  const content =
    existing.slice(0, begin.index) + normalized + existing.slice(end.index + end[0].length);
  return { content, action: content === existing ? "unchanged" : "updated" };
}

export function hasBlock(content: string): boolean {
  return MARKER(BLOCK_BEGIN).test(content) && MARKER(BLOCK_END).test(content);
}

/** True when the file imports AGENTS.md with an `@AGENTS.md` line (Claude Code and Gemini CLI). */
export function importsAgentsMd(content: string): boolean {
  return /^[ \t]*@(?:\.\/)?AGENTS\.md[ \t]*\r?$/m.test(content);
}
