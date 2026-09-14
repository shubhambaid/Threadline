import { beforeAll, describe, expect, it } from "vitest";
import type { FixtureRepo } from "../helpers/fixture-repo.js";
import { buildResumeFixture, RESUME_NOW, RESUME_TASK } from "../helpers/resume-fixture.js";
import { cli } from "../helpers/run-cli.js";
import { expectOk } from "../helpers/workspace.js";

let repo: FixtureRepo;

beforeAll(async () => {
  repo = await buildResumeFixture();
}, 180_000);

/**
 * Golden briefings, committed so reviewers can read exactly what an agent receives at each
 * budget. Commit ids differ between runs, so they are normalized.
 */
describe("resume golden briefings", () => {
  for (const budget of [1000, 2500, 5000]) {
    it(`matches the committed briefing at ${budget} tokens`, async () => {
      const result = await cli(
        ["resume", "--task", RESUME_TASK, "--budget", String(budget), "--target", "claude-code"],
        { cwd: repo.root, env: { THREADLINE_NOW: RESUME_NOW } },
      );
      const briefing = expectOk(result).stdout.replace(/\b[0-9a-f]{7,40}\b/g, "<sha>");
      await expect(briefing).toMatchFileSnapshot(`./__snapshots__/resume-${budget}.md`);
    });
  }
});
