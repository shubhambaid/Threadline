import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BLOCK_BEGIN, BLOCK_END, instructionBlock } from "../../src/adapters/blocks.js";
import { cli } from "../helpers/run-cli.js";
import { as, expectOk, initializedRepo } from "../helpers/workspace.js";

describe("alethic render (instruction files)", () => {
  it("previews without writing", async () => {
    const repo = await initializedRepo();
    const result = expectOk(await cli(["render", "agents-md"], { cwd: repo.root }));
    expect(result.stdout).toBe(`${instructionBlock("agents-md")}\n`);
    expect(result.stderr).toContain("Pass --write to create AGENTS.md");
    expect(existsSync(path.join(repo.root, "AGENTS.md"))).toBe(false);
  });

  it("creates the block once and then reports it up to date", async () => {
    const repo = await initializedRepo();
    const file = path.join(repo.root, "AGENTS.md");
    expect(
      (await cli(["render", "agents-md", "--check"], { cwd: repo.root })).code,
      "missing file fails --check",
    ).toBe(1);

    expect(expectOk(await cli(["render", "agents-md", "--write"], { cwd: repo.root })).stdout).toBe(
      "Created AGENTS.md.\n",
    );
    const first = readFileSync(file, "utf8");
    const again = expectOk(await cli(["render", "agents-md", "--write"], { cwd: repo.root }));
    expect(again.stdout).toBe("AGENTS.md is up to date.\n");
    expect(readFileSync(file, "utf8")).toBe(first);
    expectOk(await cli(["render", "agents-md", "--check"], { cwd: repo.root }));
  });

  it("preserves content around the block and repairs edits inside it", async () => {
    const repo = await initializedRepo();
    const file = path.join(repo.root, "CLAUDE.md");
    writeFileSync(file, "# Claude notes\n\nUse pnpm, not npm.\n");

    expect(expectOk(await cli(["render", "claude-md", "--write"], { cwd: repo.root })).stdout).toBe(
      "Added the Aletheic block to CLAUDE.md.\n",
    );
    const written = readFileSync(file, "utf8");
    expect(written.startsWith("# Claude notes\n\nUse pnpm, not npm.\n\n")).toBe(true);

    const tampered = written
      .replace("Never put chat transcripts", "Feel free to store chat transcripts")
      .concat("\n## Later section\nKeep me.\n");
    writeFileSync(file, tampered);
    const check = await cli(["render", "claude-md", "--check"], { cwd: repo.root });
    expect(check.code).toBe(1);
    expect(check.stderr).toContain("CLAUDE.md is out of date");

    expect(expectOk(await cli(["render", "claude-md", "--write"], { cwd: repo.root })).stdout).toBe(
      "Updated the Aletheic block in CLAUDE.md.\n",
    );
    const repaired = readFileSync(file, "utf8");
    expect(repaired).toBe(`${written}\n## Later section\nKeep me.\n`);
  });

  it("refuses to guess when markers are malformed", async () => {
    const repo = await initializedRepo();
    const file = path.join(repo.root, "GEMINI.md");
    const content = `intro\n${BLOCK_BEGIN}\nno end marker\n`;
    writeFileSync(file, content);
    const result = await cli(["render", "gemini-md", "--write"], { cwd: repo.root });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("GEMINI.md has malformed Aletheic markers");
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  it("leaves a CLAUDE.md that imports AGENTS.md alone once AGENTS.md has the block", async () => {
    const repo = await initializedRepo();
    expectOk(await cli(["render", "agents-md", "--write"], { cwd: repo.root }));
    const file = path.join(repo.root, "CLAUDE.md");
    writeFileSync(file, "@AGENTS.md\n\n# Claude-only notes\n");

    for (const flag of ["--write", "--check"]) {
      const result = expectOk(await cli(["render", "claude-md", flag], { cwd: repo.root }));
      expect(result.stdout).toContain("imports AGENTS.md, which already has the Aletheic block");
    }
    expect(readFileSync(file, "utf8")).toBe("@AGENTS.md\n\n# Claude-only notes\n");
  });

  it("does not write through links to AGENTS.md or outside the repository", async () => {
    const repo = await initializedRepo();
    expectOk(await cli(["render", "agents-md", "--write"], { cwd: repo.root }));
    symlinkSync("AGENTS.md", path.join(repo.root, "CLAUDE.md"));
    const linked = await cli(["render", "claude-md", "--write"], { cwd: repo.root });
    expect(linked.code).toBe(2);
    expect(linked.stderr).toContain("CLAUDE.md is a link to AGENTS.md");

    const outside = path.join(mkdtempSync(path.join(os.tmpdir(), "alethic-outside-")), "x.md");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, path.join(repo.root, "GEMINI.md"));
    const escaped = await cli(["render", "gemini-md", "--write"], { cwd: repo.root });
    expect(escaped.code).toBe(2);
    expect(escaped.stderr).toContain("links outside the repository");
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it("rejects unknown outputs", async () => {
    const repo = await initializedRepo();
    const result = await cli(["render", "cursor-rules"], { cwd: repo.root });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("agents-md, claude-md, gemini-md, pr-summary");
  });
});

describe("alethic render pr-summary", () => {
  it("summarizes the task, decisions, recorded checks, and open work with citations", async () => {
    const repo = await initializedRepo();
    const codex = as(repo, "codex");
    expectOk(
      await cli(
        [
          "task",
          "start",
          "Sessions issued before a password reset stop working.",
          "--summary",
          "Invalidate sessions after password reset",
          "--paths",
          "apps/api/auth/**",
          "--id",
          "task-reset-sessions",
        ],
        codex,
      ),
    );
    expectOk(
      await cli(
        [
          "decision",
          "add",
          "--topic",
          "auth.session-invalidation",
          "--chosen",
          "Store token_version on users",
          "--rationale",
          "One write per user revokes every session.",
          "--link",
          "task-reset-sessions",
        ],
        codex,
      ),
    );
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), "alethic-log-")), "test.log");
    writeFileSync(log, "expected 401, received 200\n");
    expectOk(
      await cli(
        ["receipt", "add", "--command", "pnpm test auth", "--exit-code", "1", "--output-file", log],
        codex,
      ),
    );
    expectOk(
      await cli(
        [
          "checkpoint",
          "create",
          "--failed",
          "Delete session rows::Cached refresh tokens stay valid",
          "--question",
          "Does mobile retry on 401?",
          "--next",
          "Invalidate the cached refresh entry.",
        ],
        codex,
      ),
    );

    const summary = expectOk(await cli(["render", "pr-summary"], codex)).stdout;
    expect(summary).toMatch(/^## Invalidate sessions after password reset\n/);
    expect(summary).toContain("Aletheic task `task-reset-sessions`: active, owner codex.");
    expect(summary).toContain(
      "- Store token_version on users. Why: One write per user revokes every session. `dec-auth-session-invalidation` ⚠ unverified",
    );
    expect(summary).toMatch(
      /- Failed: `pnpm test auth` \(exit 1\) at [0-9a-f]{7,}, code unchanged since, reported\. `rcpt-pnpm-test-auth-[0-9t]+z` ⚠ unverified/,
    );
    expect(summary).toMatch(
      /### Approaches that did not work\n\n- Delete session rows: Cached refresh tokens stay valid `cp-/,
    );
    expect(summary).toContain("### Open questions\n\n- Does mobile retry on 401?");
    expect(summary).toContain("### Next\n\n- Invalidate the cached refresh entry.");
    expect(summary).toContain("not re-run here");
    expect(expectOk(await cli(["render", "pr-summary"], codex)).stdout).toBe(summary);

    const write = await cli(["render", "pr-summary", "--write"], codex);
    expect(write.code).toBe(2);
    expect(write.stderr).toContain("gh pr create --body-file -");
  });
});

it("keeps the markers on their own lines in rendered blocks", () => {
  const lines = instructionBlock("agents-md").split("\n");
  expect(lines[0]).toBe(BLOCK_BEGIN);
  expect(lines.at(-1)).toBe(BLOCK_END);
});
