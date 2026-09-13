import { describe, expect, it } from "vitest";
import { NOT_DETERMINED } from "../../src/commands/checkpoint.js";
import { cli } from "../helpers/run-cli.js";
import {
  as,
  expectOk,
  expectValid,
  initializedRepo,
  readRecord,
  shortHead,
} from "../helpers/workspace.js";

const INTENT = "Invalidate sessions after password reset";
const TASK_ID = "task-invalidate-sessions-after-password-reset";

describe("threadline checkpoint", () => {
  it("captures Git state and attaches this agent's receipts", async () => {
    const repo = await initializedRepo();
    const base = await shortHead(repo);
    expectOk(
      await cli(
        [
          "task",
          "start",
          INTENT,
          "--paths",
          "apps/api/auth/**",
          "--next",
          "Compare token_version in refresh.ts",
        ],
        as(repo, "codex"),
      ),
    );
    await repo.run(["checkout", "-q", "-b", "feat/session-reset"]);
    repo.write("apps/api/auth/session.ts", "export function createSession(version: number) {}\n");
    await repo.commitAll("wip: token version");
    repo.write("apps/api/auth/token-version.ts", "export const TOKEN_VERSION = 1;\n");

    expectOk(
      await cli(
        ["receipt", "add", "--command", "pnpm test auth", "--exit-code", "1"],
        as(repo, "codex", "2026-09-13T21:10:00Z"),
      ),
    );
    expectOk(
      await cli(
        ["receipt", "add", "--command", "pnpm lint", "--exit-code", "0"],
        as(repo, "claude-code", "2026-09-13T21:11:00Z"),
      ),
    );

    const result = expectOk(
      await cli(
        [
          "checkpoint",
          "create",
          "--done",
          "Added token_version to sessions",
          "--failed",
          "Delete session rows on reset::Refresh tokens are cached in Redis",
          "--question",
          "Should API keys be revoked too?",
        ],
        as(repo, "codex", "2026-09-13T21:15:00Z"),
      ),
    );
    expect(result.stdout).toContain("2 changed paths, 1 receipt attached");

    const file =
      ".threadline/checkpoints/cp-invalidate-sessions-after-password-reset-20260913t211500z.yaml";
    expect(readRecord(repo, file)).toMatchObject({
      status: "recorded",
      task: TASK_ID,
      git: {
        branch: "feat/session-reset",
        base,
        head: await shortHead(repo),
        dirty: true,
        changed_paths: ["apps/api/auth/session.ts", "apps/api/auth/token-version.ts"],
      },
      done: ["Added token_version to sessions"],
      failed_approaches: [
        {
          approach: "Delete session rows on reset",
          why_failed: "Refresh tokens are cached in Redis",
        },
      ],
      open_questions: ["Should API keys be revoked too?"],
      next_safe_action: "Compare token_version in refresh.ts",
      receipts: ["rcpt-pnpm-test-auth-20260913t211000z"],
      scope: { paths: ["apps/api/auth/**"] },
    });
    await expectValid(repo, "2026-09-13T21:15:00Z");
  });

  it("still checkpoints when nobody knows the next step", async () => {
    const repo = await initializedRepo();
    expectOk(await cli(["task", "start", INTENT], as(repo, "codex")));
    const result = expectOk(
      await cli(
        ["checkpoint", "create", "--question", "Why does refresh still pass?"],
        as(repo, "codex", "2026-09-13T21:15:00Z"),
      ),
    );
    expect(result.stdout).toContain("recorded as not determined");
    expect(
      readRecord(
        repo,
        ".threadline/checkpoints/cp-invalidate-sessions-after-password-reset-20260913t211500z.yaml",
      ).next_safe_action,
    ).toBe(NOT_DETERMINED);
  });

  it("asks for --task when it cannot tell which task is meant", async () => {
    const repo = await initializedRepo();
    const none = await cli(["checkpoint", "create"], as(repo, "codex"));
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("No active task");

    expectOk(await cli(["task", "start", "First task"], as(repo, "codex")));
    expectOk(await cli(["task", "start", "Second task"], as(repo, "codex")));
    const ambiguous = await cli(["checkpoint", "create"], as(repo, "codex"));
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.stderr).toContain("task-first-task, task-second-task");

    expectOk(await cli(["checkpoint", "create", "--task", "task-second-task"], as(repo, "codex")));
  });

  it("lists newest first and shows everything needed to continue", async () => {
    const repo = await initializedRepo();
    expectOk(await cli(["task", "start", INTENT, "--next", "First step"], as(repo, "codex")));
    expectOk(
      await cli(
        ["receipt", "add", "--command", "pnpm test auth", "--exit-code", "1"],
        as(repo, "codex", "2026-09-13T21:05:00Z"),
      ),
    );
    expectOk(await cli(["checkpoint", "create"], as(repo, "codex", "2026-09-13T21:15:00Z")));
    expectOk(
      await cli(
        [
          "checkpoint",
          "create",
          "--next",
          "Second step",
          "--failed",
          "Retry blindly::Same failure",
        ],
        as(repo, "codex", "2026-09-13T21:45:00Z"),
      ),
    );

    const list = JSON.parse(
      expectOk(await cli(["checkpoint", "list", "--task", TASK_ID, "--json"], as(repo, "gemini")))
        .stdout,
    );
    expect(list.map((c: { id: string }) => c.id)).toEqual([
      "cp-invalidate-sessions-after-password-reset-20260913t214500z",
      "cp-invalidate-sessions-after-password-reset-20260913t211500z",
    ]);

    const shown = expectOk(
      await cli(
        ["checkpoint", "show", "cp-invalidate-sessions-after-password-reset-20260913t211500z"],
        as(repo, "gemini"),
      ),
    ).stdout;
    for (const text of [
      `Task: ${TASK_ID}: ${INTENT}`,
      `Intent: ${INTENT}`,
      "Next safe action:\n  First step",
      "rcpt-pnpm-test-auth-20260913t210500z: fail `pnpm test auth` (exit 1, agent-reported",
    ]) {
      expect(shown).toContain(text);
    }
  });
});
