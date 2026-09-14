import { describe, expect, it } from "vitest";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  hasBlock,
  INSTRUCTION_KINDS,
  importsAgentsMd,
  instructionBlock,
  upsertBlock,
} from "../../src/adapters/blocks.js";

const BLOCK = `${BLOCK_BEGIN}\nnew\n${BLOCK_END}`;

describe("upsertBlock", () => {
  it("creates a file that holds only the block", () => {
    expect(upsertBlock(undefined, BLOCK, "AGENTS.md")).toEqual({
      content: `${BLOCK}\n`,
      action: "created",
    });
  });

  it("appends to existing content without touching it", () => {
    const existing = "# Project\n\nUse pnpm.\n";
    const { content, action } = upsertBlock(existing, BLOCK, "AGENTS.md");
    expect(action).toBe("inserted");
    expect(content).toBe(`# Project\n\nUse pnpm.\n\n${BLOCK}\n`);
    expect(upsertBlock("no newline", BLOCK, "AGENTS.md").content).toBe(`no newline\n\n${BLOCK}\n`);
  });

  it("replaces only the text between the markers and is idempotent", () => {
    const existing = `before\n  ${BLOCK_BEGIN}\nold\nlines\n${BLOCK_END}\nafter\n`;
    const first = upsertBlock(existing, BLOCK, "AGENTS.md");
    expect(first).toEqual({ content: `before\n${BLOCK}\nafter\n`, action: "updated" });
    expect(upsertBlock(first.content, BLOCK, "AGENTS.md")).toEqual({
      content: first.content,
      action: "unchanged",
    });
  });

  it("keeps CRLF line endings", () => {
    const existing = `a\r\n${BLOCK_BEGIN}\r\nold\r\n${BLOCK_END}\r\nb\r\n`;
    const { content } = upsertBlock(existing, BLOCK, "AGENTS.md");
    expect(content).toBe(`a\r\n${BLOCK_BEGIN}\r\nnew\r\n${BLOCK_END}\r\nb\r\n`);
    expect(content.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("refuses malformed markers", () => {
    for (const existing of [
      `${BLOCK_BEGIN}\nno end\n`,
      `${BLOCK_END}\n${BLOCK_BEGIN}\n`,
      `${BLOCK}\n${BLOCK}\n`,
    ]) {
      expect(() => upsertBlock(existing, BLOCK, "CLAUDE.md")).toThrow(/CLAUDE.md has malformed/);
    }
  });

  it("ignores markers that are not on their own line", () => {
    const existing = `Mention \`${BLOCK_BEGIN}\` inline.\n`;
    expect(upsertBlock(existing, BLOCK, "AGENTS.md").action).toBe("inserted");
  });
});

describe("instruction blocks", () => {
  it("stay short and name the target agent", () => {
    for (const kind of INSTRUCTION_KINDS) {
      const block = instructionBlock(kind);
      expect(hasBlock(block)).toBe(true);
      expect(block.split("\n").length).toBeLessThanOrEqual(20);
      expect(Buffer.byteLength(block)).toBeLessThan(2048);
      expect(block).toContain("alethic receipt run -- <command>");
      expect(block).toContain("alethic receipt add");
    }
    expect(instructionBlock("claude-md")).toContain("--target claude-code");
    expect(instructionBlock("gemini-md")).toContain("--target gemini");
  });

  it("detects @AGENTS.md imports", () => {
    expect(importsAgentsMd("# Claude\n@AGENTS.md\n")).toBe(true);
    expect(importsAgentsMd("@./AGENTS.md")).toBe(true);
    expect(importsAgentsMd("See @AGENTS.md for more")).toBe(false);
  });
});
