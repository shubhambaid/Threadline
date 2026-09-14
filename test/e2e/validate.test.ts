import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/core/findings.js";
import { stringifyRecord } from "../../src/core/format.js";
import { createFixtureRepo, createRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { cli } from "../helpers/run-cli.js";

interface Report {
  valid: boolean;
  errors: number;
  warnings: number;
  records: number;
  findings: Finding[];
}

async function validate(repo: FixtureRepo, args: string[] = []) {
  const result = await cli(["validate", "--json", ...args], { cwd: repo.root });
  return { ...result, report: JSON.parse(result.stdout) as Report };
}

function codes(report: Report, severity: Finding["severity"]): string[] {
  return [
    ...new Set(report.findings.filter((f) => f.severity === severity).map((f) => f.code)),
  ].sort();
}

function knowledge(id: string, extra: Record<string, unknown> = {}): string {
  return stringifyRecord({
    id,
    kind: "knowledge",
    schema_version: 1,
    summary: "Test record.",
    status: "active",
    confidence: "inferred",
    category: "gotcha",
    body: "Test body.",
    created_by: { agent: "codex" },
    created_at: "2026-09-13T20:30:00Z",
    ...extra,
  });
}

describe("threadline validate", () => {
  it("accepts a valid repository", async () => {
    const repo = await createFixtureRepo("valid");
    const { code, report } = await validate(repo);
    expect(report.findings).toEqual([]);
    expect(report).toMatchObject({ valid: true, errors: 0, warnings: 0, records: 5 });
    expect(code).toBe(0);
  });

  it("reports schema, YAML, and file naming errors", async () => {
    const repo = await createFixtureRepo("invalid-schema");
    const { code, report } = await validate(repo);
    expect(code).toBe(1);
    expect(codes(report, "error")).toEqual(["id-mismatch", "schema", "wrong-extension", "yaml"]);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        file: ".threadline/tasks/task-no-intent.yaml",
        path: "intent",
        message: "is required",
      }),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        file: ".threadline/decisions/dec-bad-status.yaml",
        path: "status",
        message: "must be one of: proposed, accepted, superseded",
      }),
    );
  });

  it("reports provenance problems, with missing commits as warnings unless --strict", async () => {
    const repo = await createFixtureRepo("invalid-provenance");
    const { code, report } = await validate(repo);
    expect(code).toBe(1);
    expect(codes(report, "error")).toEqual([
      "dangling-reference",
      "missing-evidence-file",
      "untrusted-confidence",
      "wrong-reference-kind",
    ]);
    expect(codes(report, "warning")).toEqual(["missing-commit"]);

    const strict = await validate(repo, ["--strict"]);
    expect(codes(strict.report, "error")).toContain("missing-commit");
    expect(codes(strict.report, "warning")).toEqual([]);
  });

  it("reports evidence files deleted since the record was written", async () => {
    const repo = await createFixtureRepo("stale");
    const { code, report } = await validate(repo);
    expect(code).toBe(1);
    expect(codes(report, "error")).toEqual(["missing-evidence-file"]);
    expect(codes(report, "warning")).toEqual([]);
    expect(codes(report, "info")).toEqual(["unavailable-commit"]);
  });

  it("rejects active tasks with expired leases only", async () => {
    const repo = await createFixtureRepo("expired-lease");
    const { code, report } = await validate(repo);
    expect(code).toBe(1);
    expect(report.findings).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "expired-lease",
        file: ".threadline/tasks/task-abandoned.yaml",
        path: "owner.lease_expires_at",
      }),
    ]);
  });

  it("rejects checkpoints without a Git reference", async () => {
    const repo = await createFixtureRepo("checkpoint-no-git");
    const { code, report } = await validate(repo);
    expect(code).toBe(1);
    expect(report.findings).toEqual([
      expect.objectContaining({ code: "schema", path: "git", message: "is required" }),
    ]);
  });

  it("rejects secrets without echoing them", async () => {
    const repo = await createFixtureRepo("valid");
    const token = `gh${"p_"}${"Z9".repeat(18)}`;
    repo.write(
      ".threadline/knowledge/kn-leaked.yaml",
      knowledge("kn-leaked", { body: `Deploy with GITHUB_TOKEN=${token}.` }),
    );
    const { code, report, stdout } = await validate(repo);
    expect(code).toBe(1);
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: "secret",
        file: ".threadline/knowledge/kn-leaked.yaml",
        path: "body",
        message: "Looks like a GitHub token",
      }),
    ]);
    expect(stdout).not.toContain(token);
  });

  it("rejects unsafe, escaping, and forbidden paths", async () => {
    const repo = await createFixtureRepo("valid");
    const outside = mkdtempSync(path.join(tmpdir(), "threadline-outside-"));
    writeFileSync(path.join(outside, "secret.txt"), "x");
    symlinkSync(outside, path.join(repo.root, "linked"));
    repo.write("config/prod.env", "X=1\n");
    repo.write(
      ".threadline/manifest.yaml",
      'format_version: 1\nproject:\n  name: fixture-valid\nprivacy:\n  forbidden_globs:\n    - "**/*.env"\n',
    );
    repo.write(
      ".threadline/knowledge/kn-unsafe.yaml",
      knowledge("kn-unsafe", {
        scope: { paths: ["../outside"] },
        evidence: { files: ["linked/secret.txt", "config/prod.env"] },
      }),
    );
    const { code, report } = await validate(repo);
    expect(code).toBe(1);
    expect(codes(report, "error")).toEqual(["forbidden-path", "schema", "unsafe-path"]);
  });

  it("rejects edits to committed checkpoints", async () => {
    const repo = await createFixtureRepo("valid");
    const file = path.join(
      repo.root,
      ".threadline/checkpoints/cp-session-reset-20260913t201500z.yaml",
    );
    writeFileSync(file, readFileSync(file, "utf8").replace("Compare token_version", "Rewrite"));
    const { code, report } = await validate(repo);
    expect(code).toBe(1);
    expect(codes(report, "error")).toEqual(["append-only"]);
  });

  it("prints findings with locations and hints", async () => {
    const repo = await createFixtureRepo("expired-lease");
    const result = await cli(["validate"], { cwd: repo.root });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "error   .threadline/tasks/task-abandoned.yaml:owner.lease_expires_at: Lease held by codex expired at 2026-09-13T20:00:00Z",
    );
    expect(result.stdout).toContain("hint: Renew with `threadline task claim task-abandoned`");
    expect(result.stdout).toContain("✗ 1 error, 0 warnings in 2 records");
  });

  it("refuses to run before init", async () => {
    const repo = await createRepo();
    await repo.commitAll("empty");
    const result = await cli(["validate"], { cwd: repo.root });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("threadline init");
  });
});
