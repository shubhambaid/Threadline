import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/core/findings.js";
import { cli } from "../helpers/run-cli.js";
import { as, expectOk, expectValid, initializedRepo } from "../helpers/workspace.js";

const GUARD = "apps/api/auth/password-reset.ts";

describe("conservative freshness in validate and resume", () => {
  it("warns about a one-line change that reverses a condition, and explains scope-only changes", async () => {
    const repo = await initializedRepo();
    repo.write(
      GUARD,
      "export function mayReset(attempts: number) {\n  if (attempts < 5) return true;\n  return false;\n}\n",
    );
    await repo.commitAll("guard");
    const codex = as(repo, "codex");
    expectOk(
      await cli(
        [
          ...["task", "start", "Limit password reset attempts", "--id", "task-limit"],
          ...["--paths", "apps/api/auth/**"],
        ],
        codex,
      ),
    );
    expectOk(
      await cli(
        [
          ...["decision", "add", "--topic", "auth.reset-limit", "--id", "dec-reset-limit"],
          ...["--chosen", "Allow at most five reset attempts", "--rationale", "Slows guessing."],
          ...["--evidence-file", GUARD, "--paths", "apps/api/auth/**"],
        ],
        codex,
      ),
    );
    await repo.commitAll("record decision");
    await expectValid(repo);

    // A nearby file under the scope glob changes: explained, but not a stale claim.
    repo.write("apps/api/auth/session.ts", "export function createSession() { return 1; }\n");
    await expectValid(repo);
    const nearby = expectOk(await cli(["resume", "--task", "task-limit"], { cwd: repo.root }));
    expect(nearby.stdout).toContain(
      "[dec-reset-limit] ℹ nearby files changed, cited files did not: apps/api/auth/session.ts changed 2 lines (+1/-1), but only a scope glob matches it",
    );
    expect(nearby.stdout).not.toContain("⚠ may be stale");

    // One line reverses the condition the decision relies on.
    repo.write(
      GUARD,
      "export function mayReset(attempts: number) {\n  if (attempts >= 5) return true;\n  return false;\n}\n",
    );
    const validation = await cli(["validate", "--json"], { cwd: repo.root });
    const findings = JSON.parse(validation.stdout).findings as Finding[];
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "needs-reverification",
        file: ".alethic/decisions/dec-reset-limit.yaml",
        message: `May be stale: ${GUARD} changed 2 lines (+1/-1) since it was anchored`,
      }),
    ]);
    const briefing = expectOk(await cli(["resume", "--task", "task-limit"], { cwd: repo.root }));
    expect(briefing.stdout).toContain(
      `[dec-reset-limit] ⚠ may be stale (small change): ${GUARD} changed 2 lines (+1/-1) since it was anchored`,
    );
  });
});
