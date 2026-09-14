import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../../src/git/git.js";
import { cli } from "../helpers/run-cli.js";
import { as, expectOk, initializedRepo } from "../helpers/workspace.js";

describe("alethic show", () => {
  it("prints a record with its revision, freshness, and trust", async () => {
    const repo = await initializedRepo();
    expectOk(
      await cli(
        [
          ...["decision", "add", "--topic", "auth.session-store", "--id", "dec-store"],
          ...["--chosen", "Keep sessions in Postgres", "--rationale", "One store."],
          ...["--evidence-file", "apps/api/auth/session.ts", "--human", "Priya"],
        ],
        as(repo, "codex"),
      ),
    );
    const file = ".alethic/decisions/dec-store.yaml";
    const blob = (await git(repo.root, ["hash-object", file])).stdout.trim();

    const text = expectOk(await cli(["show", "dec-store"], { cwd: repo.root })).stdout;
    expect(text).toContain("# dec-store (decision)");
    expect(text).toContain(`File:      ${file}`);
    expect(text).toContain(`Revision:  ${blob}`);
    expect(text).toContain("Freshness: unchanged");
    expect(text).toContain(
      "Trust:     human-confirmed by Priya (attributed, recorded by codex; not authenticated)",
    );
    expect(text).toContain("chosen: Keep sessions in Postgres");

    repo.write("apps/api/auth/session.ts", "export function createSession() { return 1; }\n");
    const json = JSON.parse(
      expectOk(await cli(["show", "dec-store", "--json"], { cwd: repo.root })).stdout,
    );
    expect(json).toMatchObject({
      id: "dec-store",
      kind: "decision",
      file,
      revision: blob,
      derived: {
        staleness: { status: "needs_reverification", changedDirect: ["apps/api/auth/session.ts"] },
        confirmation: { level: "attributed", name: "Priya", authenticated: false },
      },
      findings: [],
    });
  });

  it("says whether a receipt applies to the current code", async () => {
    const repo = await initializedRepo();
    expectOk(
      await cli(
        ["receipt", "add", "--command", "npm test", "--exit-code", "0", "--id", "rcpt-t"],
        as(repo, "codex"),
      ),
    );
    const text = expectOk(await cli(["show", "rcpt-t"], { cwd: repo.root })).stdout;
    expect(text).toContain("Applies:   HEAD; reported to Alethic, not observed");
  });

  it("refuses records that failed validation, without printing them", async () => {
    const repo = await initializedRepo();
    writeFileSync(
      path.join(repo.root, ".alethic/knowledge/kn-leak.yaml"),
      [
        "id: kn-leak",
        "kind: knowledge",
        "schema_version: 1",
        "summary: Admin login",
        "status: active",
        "confidence: agent-reported",
        "category: operations",
        "body: The admin uses password = Hunter2Hunter2!",
        "created_by:",
        "  agent: codex",
        'created_at: "2026-09-13T20:00:00Z"',
        "",
      ].join("\n"),
    );
    const result = await cli(["show", "kn-leak"], { cwd: repo.root });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("kn-leak failed validation (secret)");
    expect(result.stdout + result.stderr).not.toContain("Hunter2");
  });
});
