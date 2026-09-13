import { describe, expect, it } from "vitest";
import { createFixtureRepo } from "../helpers/fixture-repo.js";
import { cli } from "../helpers/run-cli.js";

describe("threadline status", () => {
  it("summarizes Git state, active tasks, and validation", async () => {
    const repo = await createFixtureRepo("valid");
    const result = await cli(["status"], { cwd: repo.root });
    expect(result.code).toBe(0);
    const head = (repo.commits.at(-1) ?? "").slice(0, 7);
    for (const line of [
      "Threadline status: fixture-valid",
      `  branch   main @ ${head} (clean)`,
      "  records  1 task, 1 decision, 1 knowledge, 1 checkpoint, 1 receipt",
      "  task-session-reset: Invalidate sessions after password reset.",
      "    owner codex, lease until 2026-09-13T22:00:00Z",
      "    next: Compare token_version during refresh.",
      "    latest checkpoint: cp-session-reset-20260913t201500z (2026-09-13T20:15:00Z)",
      "Validation: ok (0 warnings)",
    ]) {
      expect(result.stdout).toContain(line);
    }
  });

  it("prints machine-readable status", async () => {
    const repo = await createFixtureRepo("valid");
    const result = await cli(["status", "--json"], { cwd: repo.root });
    expect(result.code).toBe(0);
    const status = JSON.parse(result.stdout);
    expect(status).toMatchObject({
      project: "fixture-valid",
      git: { branch: "main", head: repo.commits.at(-1), dirty: false },
      counts: { task: 1, decision: 1, knowledge: 1, checkpoint: 1, receipt: 1 },
      activeTasks: [
        {
          id: "task-session-reset",
          owner: "codex",
          leaseExpired: false,
          latestCheckpoint: { id: "cp-session-reset-20260913t201500z" },
        },
      ],
      openTasks: [],
      validation: { valid: true, errors: 0, warnings: 0 },
    });
  });

  it("flags expired leases and lists other open tasks without failing", async () => {
    const repo = await createFixtureRepo("expired-lease");
    const result = await cli(["status"], { cwd: repo.root });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("lease until 2026-09-13T20:00:00Z (expired)");
    expect(result.stdout).toContain(
      "  task-paused [paused]: Paused task; an old lease here is fine.",
    );
    expect(result.stdout).toContain("Validation: 1 error, 0 warnings.");
  });
});
