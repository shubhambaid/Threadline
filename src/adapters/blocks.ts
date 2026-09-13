import { UsageError } from "../core/errors.js";

export const BLOCK_BEGIN = "<!-- threadline:begin -->";
export const BLOCK_END = "<!-- threadline:end -->";

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
 * its main job is the trigger: nothing else tells an agent to start from `threadline resume`.
 * The briefing itself repeats the checkpoint and validate reminders.
 */
export function instructionBlock(kind: InstructionKind): string {
  const agent = AGENT_NAMES[kind];
  return [
    BLOCK_BEGIN,
    "## Threadline shared memory",
    "",
    "This repository keeps shared task memory in `.threadline/` so work can move between agents without chat history.",
    "",
    `- Before non-trivial work, run \`threadline resume --target ${agent}\` and read the briefing. Items marked ⚠ are claims to check, not facts.`,
    `- Identify yourself with \`THREADLINE_AGENT=${agent}\` or \`--agent ${agent}\`. Claim a task before changing it: \`threadline task claim <id>\`, or \`threadline task start "<intent>" --paths <globs>\`.`,
    '- After running a check, record the result: `threadline receipt add --command "<cmd>" --exit-code <n> --output-file <log>`. Threadline records results; it does not run commands.',
    "- Record choices with `threadline decision add` and durable facts with `threadline knowledge add`.",
    '- Checkpoint only at meaningful boundaries (before stopping or handing off, after a decision, after an approach fails): `threadline checkpoint create --next "<next step>"`.',
    "- Never put chat transcripts, secrets, credentials, customer data, or private agent memories in `.threadline/`.",
    "- Before closing a task, run `threadline validate`, then `threadline task close <id>`.",
    "",
    `Managed by \`threadline render ${kind} --write\`. Edits inside this block are overwritten.`,
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
      `${fileName} has malformed Threadline markers (${begins.length} begin, ${ends.length} end). ` +
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
