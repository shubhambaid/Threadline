import { describe, expect, it } from "vitest";
import { cli } from "../helpers/run-cli.js";
import { as, expectOk, initializedRepo, readRecord } from "../helpers/workspace.js";

const SAME_SECOND = "2026-09-13T21:00:00Z";

describe("checkpoint receipt attachment", () => {
  it("attaches receipts recorded in the same second the task started", async () => {
    const repo = await initializedRepo();
    expectOk(await cli(["task", "start", "Fast task"], as(repo, "codex", SAME_SECOND)));
    expectOk(
      await cli(
        ["receipt", "add", "--command", "npm test", "--exit-code", "1"],
        as(repo, "codex", SAME_SECOND),
      ),
    );
    const result = expectOk(
      await cli(["checkpoint", "create"], as(repo, "codex", "2026-09-13T21:00:01Z")),
    );
    expect(result.stdout).toContain("1 receipt attached");
    expect(
      readRecord(repo, ".alethic/checkpoints/cp-fast-task-20260913t210001z.yaml").receipts,
    ).toEqual(["rcpt-npm-test-20260913t210000z"]);
  });
});
