import { describe, expect, it } from "vitest";
import { cli } from "../helpers/run-cli.js";
import { as, expectOk, initializedRepo, readRecord } from "../helpers/workspace.js";

const TASK_ID = "task-invalidate-sessions";

describe("checkpoint receipts across a handoff", () => {
  it("carries over other agents' receipts on this line of history, not other branches'", async () => {
    const repo = await initializedRepo();
    expectOk(
      await cli(
        ["task", "start", "Invalidate sessions"],
        as(repo, "codex", "2026-09-13T21:00:00Z"),
      ),
    );
    expectOk(
      await cli(
        ["receipt", "add", "--command", "pnpm test auth", "--exit-code", "1"],
        as(repo, "codex", "2026-09-13T21:05:00Z"),
      ),
    );
    await repo.commitAll("threadline: task and receipt");

    // A receipt recorded on an unrelated branch must not be attached.
    await repo.run(["checkout", "-q", "-b", "experiment"]);
    repo.write("apps/api/auth/experiment.ts", "export const experiment = true;\n");
    await repo.commitAll("experiment");
    expectOk(
      await cli(
        ["receipt", "add", "--command", "pnpm test experiment", "--exit-code", "0"],
        as(repo, "gemini", "2026-09-13T21:06:00Z"),
      ),
    );
    await repo.run(["checkout", "-q", "main"]);

    // Codex hands off without checkpointing; Claude Code checkpoints without new receipts.
    expectOk(
      await cli(
        ["task", "update", TASK_ID, "--status", "paused"],
        as(repo, "codex", "2026-09-13T21:07:00Z"),
      ),
    );
    expectOk(
      await cli(["task", "claim", TASK_ID], as(repo, "claude-code", "2026-09-13T21:10:00Z")),
    );
    const result = expectOk(
      await cli(
        ["checkpoint", "create", "--next", "Continue from the failing auth tests"],
        as(repo, "claude-code", "2026-09-13T21:15:00Z"),
      ),
    );
    expect(result.stdout).toContain("1 receipt attached");
    expect(
      readRecord(repo, ".threadline/checkpoints/cp-invalidate-sessions-20260913t211500z.yaml")
        .receipts,
    ).toEqual(["rcpt-pnpm-test-auth-20260913t210500z"]);
  });
});
