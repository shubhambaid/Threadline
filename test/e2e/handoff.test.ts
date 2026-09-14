import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cli } from "../helpers/run-cli.js";
import { as, expectOk, initializedRepo, readRecord, shortHead } from "../helpers/workspace.js";

const INTENT = "Invalidate sessions after password reset";
const TASK_ID = "task-invalidate-sessions-after-password-reset";
const FAILED_APPROACH = "Delete all session rows on reset";
const WHY_FAILED = "Refresh tokens are cached in Redis for 15 minutes";
const NEXT = "Make refresh.ts compare token_version, then rerun pnpm test auth";

describe("agent handoff", () => {
  it("lets a second agent continue from repository state alone", async () => {
    const repo = await initializedRepo();

    // Agent A (Codex) starts the work, hits a failure, and checkpoints before stopping.
    await repo.run(["checkout", "-q", "-b", "feat/session-reset"]);
    expectOk(
      await cli(
        ["task", "start", INTENT, "--paths", "apps/api/auth/**"],
        as(repo, "codex", "2026-09-13T18:00:00Z"),
      ),
    );
    repo.write(
      "apps/api/auth/password-reset.ts",
      "export function resetPassword(user: { token_version: number }) {\n  user.token_version += 1;\n}\n",
    );
    await repo.commitAll("wip: bump token_version on reset");
    const headAtCheckpoint = await shortHead(repo);

    const log = path.join(mkdtempSync(path.join(tmpdir(), "alethic-handoff-")), "auth.log");
    writeFileSync(log, "FAIL refresh token rejected after reset\n  expected 401, received 200\n");
    const failing = JSON.parse(
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
            log,
            "--json",
          ],
          as(repo, "codex", "2026-09-13T19:55:00Z"),
        ),
      ).stdout,
    );
    expectOk(
      await cli(
        [
          "checkpoint",
          "create",
          "--done",
          "Password reset increments token_version",
          "--failed",
          `${FAILED_APPROACH}::${WHY_FAILED}`,
          "--question",
          "Should API keys issued before the reset be revoked?",
          "--next",
          NEXT,
        ],
        as(repo, "codex", "2026-09-13T20:00:00Z"),
      ),
    );
    expectOk(
      await cli(
        ["task", "update", TASK_ID, "--status", "paused"],
        as(repo, "codex", "2026-09-13T20:01:00Z"),
      ),
    );
    await repo.commitAll("alethic: checkpoint session reset");

    // Agent B (Claude Code) starts cold. Its only input is the repository.
    const claude = (at: string) => as(repo, "claude-code", at);
    const status = JSON.parse(
      expectOk(await cli(["status", "--json"], claude("2026-09-13T23:00:00Z"))).stdout,
    );
    expect(status.validation.valid).toBe(true);
    expect(status.activeTasks).toEqual([]);
    expect(status.openTasks).toEqual([expect.objectContaining({ id: TASK_ID, status: "paused" })]);

    const [latest] = JSON.parse(
      expectOk(
        await cli(
          ["checkpoint", "list", "--task", TASK_ID, "--json"],
          claude("2026-09-13T23:00:00Z"),
        ),
      ).stdout,
    );
    const shown = JSON.parse(
      expectOk(
        await cli(["checkpoint", "show", latest.id, "--json"], claude("2026-09-13T23:00:00Z")),
      ).stdout,
    );

    // Everything needed to continue, field by field.
    expect(shown.task).toMatchObject({ intent: INTENT, scope: { paths: ["apps/api/auth/**"] } });
    expect(shown.checkpoint).toMatchObject({
      task: TASK_ID,
      git: {
        branch: "feat/session-reset",
        head: headAtCheckpoint,
        dirty: false,
        changed_paths: ["apps/api/auth/password-reset.ts"],
      },
      done: ["Password reset increments token_version"],
      failed_approaches: [{ approach: FAILED_APPROACH, why_failed: WHY_FAILED }],
      open_questions: ["Should API keys issued before the reset be revoked?"],
      next_safe_action: NEXT,
      receipts: [failing.id],
    });
    expect(shown.receipts).toEqual([
      expect.objectContaining({
        id: failing.id,
        result: "fail",
        command: "pnpm test auth",
        git: expect.objectContaining({ head: headAtCheckpoint }),
        output_tail: expect.stringContaining("expected 401, received 200"),
      }),
    ]);

    // Agent B takes over, finishes, records evidence and the decision, and closes the task.
    const claimed = expectOk(await cli(["task", "claim", TASK_ID], claude("2026-09-13T23:05:00Z")));
    expect(claimed.stdout).toContain(`Claimed ${TASK_ID} for claude-code`);
    repo.write("apps/api/auth/refresh.ts", "export function refresh(tokenVersion: number) {}\n");
    await repo.commitAll("feat: compare token_version on refresh");

    const passing = JSON.parse(
      expectOk(
        await cli(
          ["receipt", "add", "--command", "pnpm test auth", "--exit-code", "0", "--json"],
          claude("2026-09-13T23:30:00Z"),
        ),
      ).stdout,
    );
    expectOk(
      await cli(
        [
          "decision",
          "add",
          "--topic",
          "auth.session-invalidation",
          "--chosen",
          "Bump a per-user token_version and compare it on refresh",
          "--rationale",
          "Revokes cached refresh tokens without scanning Redis",
          "--alternative",
          `${FAILED_APPROACH}::${WHY_FAILED}`,
          "--link",
          TASK_ID,
          "--receipt",
          passing.id,
        ],
        claude("2026-09-13T23:31:00Z"),
      ),
    );
    expectOk(
      await cli(["task", "close", TASK_ID, "--status", "done"], claude("2026-09-13T23:40:00Z")),
    );
    await repo.commitAll("alethic: close session reset");

    expect(readRecord(repo, `.alethic/tasks/${TASK_ID}.yaml`)).toMatchObject({
      status: "done",
      owner: { agent: "claude-code" },
    });
    const validate = await cli(["validate", "--strict"], claude("2026-09-13T23:41:00Z"));
    expect(validate.stdout).toContain("✓ 5 records valid");
    expect(validate.code).toBe(0);
  });
});
