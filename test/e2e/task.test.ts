import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stringifyRecord } from "../../src/core/format.js";
import { cli, TEST_NOW } from "../helpers/run-cli.js";
import { as, expectOk, expectValid, initializedRepo, readRecord } from "../helpers/workspace.js";

const TASK_ID = "task-invalidate-sessions-after-password-reset";
const TASK_FILE = `.threadline/tasks/${TASK_ID}.yaml`;
const INTENT = "Invalidate sessions after password reset";

describe("threadline task", () => {
  it("starts an active task owned by the agent, with a lease and an anchor", async () => {
    const repo = await initializedRepo();
    const result = expectOk(
      await cli(
        ["task", "start", INTENT, "--paths", "apps/api/auth/**", "--next", "Add token_version"],
        as(repo, "codex"),
      ),
    );
    expect(result.stdout).toContain(
      `Created ${TASK_FILE} (active, owned by codex until 2026-09-14T01:00:00Z)`,
    );
    const task = readRecord(repo, TASK_FILE);
    expect(task).toMatchObject({
      id: TASK_ID,
      status: "active",
      confidence: "agent-reported",
      intent: INTENT,
      branch: "main",
      owner: { agent: "codex", claimed_at: TEST_NOW, lease_expires_at: "2026-09-14T01:00:00Z" },
      next_action: "Add token_version",
      scope: { paths: ["apps/api/auth/**"] },
      created_by: { agent: "codex" },
      created_at: TEST_NOW,
    });
    expect(Object.keys((task.anchor as { fingerprints: object }).fingerprints)).toEqual([
      "apps/api/auth/password-reset.ts",
      "apps/api/auth/refresh.ts",
      "apps/api/auth/session.test.ts",
      "apps/api/auth/session.ts",
    ]);
    await expectValid(repo);
  });

  it("requires an agent identity and safe paths, and writes nothing otherwise", async () => {
    const repo = await initializedRepo();
    const anonymous = await cli(["task", "start", INTENT], { cwd: repo.root });
    expect(anonymous.code).toBe(2);
    expect(anonymous.stderr).toContain("THREADLINE_AGENT");

    const unsafe = await cli(["task", "start", INTENT, "--paths", "../outside"], as(repo, "codex"));
    expect(unsafe.code).toBe(2);
    expect(unsafe.stderr).toContain("'.' or '..' segments");
    expect(existsSync(path.join(repo.root, TASK_FILE))).toBe(false);
  });

  it("coordinates ownership with expiring leases", async () => {
    const repo = await initializedRepo();
    expectOk(await cli(["task", "start", INTENT], as(repo, "codex")));

    const blocked = await cli(
      ["task", "claim", TASK_ID],
      as(repo, "claude-code", "2026-09-13T21:30:00Z"),
    );
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain(`${TASK_ID} is held by codex until 2026-09-14T01:00:00Z`);

    const renewed = expectOk(
      await cli(["task", "claim", TASK_ID], as(repo, "codex", "2026-09-13T21:30:00Z")),
    );
    expect(renewed.stdout).toContain("Renewed");
    expect(readRecord(repo, TASK_FILE).owner).toEqual({
      agent: "codex",
      claimed_at: TEST_NOW,
      lease_expires_at: "2026-09-14T01:30:00Z",
    });

    const claimed = expectOk(
      await cli(["task", "claim", TASK_ID], as(repo, "claude-code", "2026-09-14T02:00:00Z")),
    );
    expect(claimed.stdout).toContain(`Claimed ${TASK_ID} for claude-code`);

    const forced = expectOk(
      await cli(["task", "claim", TASK_ID, "--force"], as(repo, "gemini", "2026-09-14T02:10:00Z")),
    );
    expect(forced.stdout).toContain(`Took over ${TASK_ID} from claude-code`);
    expect(readRecord(repo, TASK_FILE).owner).toMatchObject({ agent: "gemini" });
    await expectValid(repo, "2026-09-14T02:10:00Z");
  });

  it("updates, closes, and then protects closed tasks", async () => {
    const repo = await initializedRepo();
    expectOk(await cli(["task", "start", INTENT], as(repo, "codex")));

    expectOk(
      await cli(
        ["task", "update", TASK_ID, "--status", "paused", "--next", "Resume from the checkpoint"],
        as(repo, "codex", "2026-09-13T21:10:00Z"),
      ),
    );
    expect(readRecord(repo, TASK_FILE)).toMatchObject({
      status: "paused",
      next_action: "Resume from the checkpoint",
      updated_at: "2026-09-13T21:10:00Z",
    });

    const activate = await cli(
      ["task", "update", TASK_ID, "--status", "active"],
      as(repo, "codex"),
    );
    expect(activate.code).toBe(2);
    expect(activate.stderr).toContain("task claim");

    expectOk(await cli(["task", "close", TASK_ID, "--status", "done"], as(repo, "codex")));
    expect(readRecord(repo, TASK_FILE).status).toBe("done");
    await expectValid(repo);

    const reclaim = await cli(["task", "claim", TASK_ID], as(repo, "claude-code"));
    expect(reclaim.code).toBe(2);
    expect(reclaim.stderr).toContain("closed tasks cannot be changed");
  });

  it("refuses to close a task whose own records are invalid", async () => {
    const repo = await initializedRepo();
    expectOk(await cli(["task", "start", INTENT], as(repo, "codex")));
    repo.write(
      ".threadline/checkpoints/cp-broken-20260913t210500z.yaml",
      stringifyRecord({
        id: "cp-broken-20260913t210500z",
        kind: "checkpoint",
        schema_version: 1,
        summary: "Cites a receipt that does not exist.",
        status: "recorded",
        confidence: "agent-reported",
        task: TASK_ID,
        git: { head: repo.commits.at(-1)?.slice(0, 7), dirty: false },
        next_safe_action: "Continue.",
        receipts: ["rcpt-missing-20260913t210000z"],
        created_by: { agent: "codex" },
        created_at: "2026-09-13T21:05:00Z",
      }),
    );
    const result = await cli(["task", "close", TASK_ID], as(repo, "codex"));
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("rcpt-missing-20260913t210000z does not exist");
    expect(result.stdout).toContain(`Cannot close ${TASK_ID}`);
    expect(readRecord(repo, TASK_FILE).status).toBe("active");
  });
});
