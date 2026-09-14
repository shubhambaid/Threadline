import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { connectMcp, textOf } from "../helpers/mcp-client.js";
import { cli } from "../helpers/run-cli.js";
import { as, expectOk, expectValid, initializedRepo, readRecord } from "../helpers/workspace.js";

const CODEX_AT = "2026-09-13T21:00:00Z";
const CLAUDE_AT = "2026-09-14T09:00:00Z";
const GEMINI_AT = "2026-09-14T21:00:00Z";
const TASK = "task-invalidate-sessions-after-password-reset";

function logFile(content: string): string {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "alethic-log-")), "out.log");
  writeFileSync(file, content);
  return file;
}

/**
 * One task moves Codex (CLI) → Claude Code (MCP) → Gemini (CLI) using only committed repository
 * state: each agent starts in a fresh session with nothing but the repository.
 */
it("hands one task from Codex to Claude Code to Gemini through shared records", async () => {
  const repo = await initializedRepo();

  // Instruction files: one block in AGENTS.md, imported by Claude Code, read by Gemini.
  const codex = as(repo, "codex", CODEX_AT);
  expectOk(await cli(["render", "agents-md", "--write"], codex));
  repo.write("CLAUDE.md", "@AGENTS.md\n");
  mkdirSync(path.join(repo.root, ".gemini"), { recursive: true });
  repo.write(
    ".gemini/settings.json",
    `${JSON.stringify({ context: { fileName: ["AGENTS.md", "GEMINI.md"] } }, null, 2)}\n`,
  );
  expectOk(await cli(["render", "claude-md", "--check"], codex));
  await repo.commitAll("Add agent instructions");

  // Codex starts the task, hits a failing test, and stops.
  expectOk(
    await cli(
      [
        "task",
        "start",
        "Sessions issued before a password reset must stop working within one request.",
        "--summary",
        "Invalidate sessions after password reset",
        "--paths",
        "apps/api/auth/**",
      ],
      codex,
    ),
  );
  repo.write("apps/api/auth/password-reset.ts", "export function resetPassword() { bump(); }\n");
  await repo.commitAll("codex: bump token_version on reset");
  expectOk(
    await cli(
      [
        "receipt",
        "add",
        "--command",
        "pnpm test auth",
        "--exit-code",
        "1",
        "--output-file",
        logFile("expected 401, received 200\n"),
      ],
      codex,
    ),
  );
  expectOk(
    await cli(
      [
        "checkpoint",
        "create",
        "--failed",
        "Delete session rows on reset::Refresh tokens are cached in Redis",
        "--question",
        "Does the mobile client retry refresh on 401?",
        "--next",
        "Compare token_version in apps/api/auth/refresh.ts",
      ],
      codex,
    ),
  );
  await repo.commitAll("codex: checkpoint");

  // Claude Code, over MCP, after Codex's lease has expired.
  const claude = await connectMcp(repo.root, "claude-code", CLAUDE_AT);
  try {
    const briefing = textOf(await claude.call("resume", { target: "claude-code" }));
    expect(briefing).toContain(`# Aletheic briefing: ${TASK}`);
    expect(briefing).toContain("Compare token_version in apps/api/auth/refresh.ts");
    expect(briefing).toContain("Delete session rows on reset");
    expect(briefing).toMatch(/`pnpm test auth` failed \(exit 1\)/);
    expect(briefing).toContain("Does the mobile client retry refresh on 401?");

    const claimed = await claude.call("task_claim", { id: TASK });
    expect(claimed.isError, textOf(claimed)).toBe(false);
    repo.write("apps/api/auth/refresh.ts", "export function refresh() { checkVersion(); }\n");
    await repo.commitAll("claude: compare token_version on refresh");

    for (const call of [
      claude.call("receipt_record", {
        command: "pnpm test auth",
        exit_code: 0,
        output: "Tests: 39 passed\n",
      }),
      claude.call("decision_add", {
        topic: "auth.session-invalidation",
        chosen: "Store token_version on users and reject older tokens",
        rationale: "One write per user revokes every session, including cached refresh tokens.",
        alternatives: [
          { option: "Delete session rows on reset", rejected_because: "Redis cache outlives it" },
        ],
        links: [TASK],
      }),
      claude.call("checkpoint_create", {
        done: ["Compared token_version in refresh.ts"],
        next: "Run the full test suite, then close the task.",
      }),
    ]) {
      const result = await call;
      expect(result.isError, textOf(result)).toBe(false);
    }
  } finally {
    await claude.close();
  }
  await repo.commitAll("claude: checkpoint");

  // Gemini, from the CLI, finishes the task.
  const gemini = as(repo, "gemini", GEMINI_AT);
  const briefing = expectOk(
    await cli(["resume", "--target", "gemini", "--budget", "2500"], gemini),
  ).stdout;
  expect(briefing).toContain("Run the full test suite, then close the task.");
  expect(briefing).toContain("[dec-auth-session-invalidation]");
  expect(briefing).toMatch(/`pnpm test auth` passed at [0-9a-f]+/);
  expect(briefing).toContain("Delete session rows on reset");
  expect(briefing).toContain("Latest checkpoint was written by claude-code");

  expectOk(await cli(["task", "claim", TASK], gemini));
  expectOk(
    await cli(
      [
        "receipt",
        "add",
        "--command",
        "pnpm test",
        "--exit-code",
        "0",
        "--output-file",
        logFile("Tests: 212 passed\n"),
      ],
      gemini,
    ),
  );
  expectOk(await cli(["task", "close", TASK], gemini));
  await repo.commitAll("gemini: close task");
  await expectValid(repo, GEMINI_AT);

  expect(readRecord(repo, `.alethic/tasks/${TASK}.yaml`).status).toBe("done");
  const writers = (dir: string) =>
    readdirSync(path.join(repo.root, ".alethic", dir))
      .filter((file) => file.endsWith(".yaml"))
      .map((file) => readRecord(repo, `.alethic/${dir}/${file}`))
      .map((record) => (record.created_by as { agent: string }).agent)
      .sort();
  expect(writers("checkpoints")).toEqual(["claude-code", "codex"]);
  expect(writers("receipts")).toEqual(["claude-code", "codex", "gemini"]);
  expect(writers("decisions")).toEqual(["claude-code"]);
  expect(await repo.run(["status", "--porcelain"])).toBe("");
  const summary = expectOk(await cli(["render", "pr-summary", "--task", TASK], gemini)).stdout;
  expect(summary).toContain(`Aletheic task \`${TASK}\`: done, owner gemini.`);
  expect(summary).toMatch(/- Passed: `pnpm test` \(exit 0\)/);
  expect(summary).not.toContain("### Next");
});
