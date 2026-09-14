import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FixtureRepo } from "../helpers/fixture-repo.js";
import { cli, TEST_NOW } from "../helpers/run-cli.js";
import { as, expectOk, expectValid, initializedRepo, readRecord } from "../helpers/workspace.js";

const NODE = process.execPath;
const TASK = "task-auth";

interface Receipt {
  result: string;
  exit_code: number;
  git: { head: string; dirty: boolean };
  output_tail?: string;
  provenance: { source: string; capture: string };
  execution?: { argv: string[]; cwd: string; started_at: string; finished_at: string };
  state?: {
    coverage: string;
    file_limit: number;
    before: { digest: string; dirty: boolean; files: number };
    after: { digest: string; dirty: boolean; files: number };
    changed_during_run: boolean;
  };
}

async function repoWithTask(): Promise<FixtureRepo> {
  const repo = await initializedRepo();
  expectOk(
    await cli(["task", "start", "Harden auth", "--id", TASK, "--paths", "apps/api/auth/**"], {
      ...as(repo, "codex"),
    }),
  );
  await repo.commitAll("start task");
  return repo;
}

function run(repo: FixtureRepo, id: string, script: string, extra: string[] = []) {
  return cli(["receipt", "run", "--id", id, ...extra, "--", NODE, "-e", script], as(repo, "codex"));
}

function receipt(repo: FixtureRepo, id: string): Receipt {
  return readRecord(repo, `.alethic/receipts/${id}.yaml`) as unknown as Receipt;
}

async function checkLine(repo: FixtureRepo, id: string): Promise<string> {
  const text = expectOk(
    await cli(["resume", "--task", TASK, "--budget", "4000"], { cwd: repo.root }),
  ).stdout;
  return text.split("\n").find((line) => line.includes(`(receipt ${id})`)) ?? "";
}

describe("alethic receipt run", () => {
  it("observes a clean run and notices later edits that were not committed", async () => {
    const repo = await repoWithTask();
    const result = await run(repo, "rcpt-clean", "console.log('all good')");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("all good");
    expect(result.stdout).toContain(
      "Recorded .alethic/receipts/rcpt-clean.yaml (pass, exit 0, observed; no files changed while it ran)",
    );

    const record = receipt(repo, "rcpt-clean");
    expect(record).toMatchObject({
      result: "pass",
      exit_code: 0,
      git: { dirty: false },
      provenance: { source: "local", capture: "observed" },
      execution: {
        argv: [NODE, "-e", "console.log('all good')"],
        cwd: ".",
        started_at: TEST_NOW,
        finished_at: TEST_NOW,
      },
      state: { coverage: "workspace", changed_during_run: false },
    });
    expect(record.state?.before.digest).toBe(record.state?.after.digest);
    expect(record.output_tail).toBe("all good");
    expect(Object.keys(record)).not.toContain("env");
    await expectValid(repo);

    const line = await checkLine(repo, "rcpt-clean");
    expect(line).toContain("observed by `alethic receipt run`; files unchanged since it ran");

    // Same HEAD, different code: the earlier result no longer describes it.
    repo.write("apps/api/auth/session.ts", "export function createSession() { return null; }\n");
    expect(await checkLine(repo, "rcpt-clean")).toContain(
      "observed by `alethic receipt run`; files have changed since it ran",
    );
  });

  it("records failures with a redacted output tail and exits 1", async () => {
    const repo = await repoWithTask();
    // The secret is assembled at run time: one written into argv would (rightly) block the write.
    const result = await run(
      repo,
      "rcpt-fail",
      "console.log('connecting with password = ' + 'Hunter2' + 'Hunter2!'); console.error('boom'); process.exit(3)",
    );
    expect(result.code).toBe(1);
    const record = receipt(repo, "rcpt-fail");
    expect(record).toMatchObject({ result: "fail", exit_code: 3 });
    expect(record.output_tail).toContain("[REDACTED]");
    expect(record.output_tail).toContain("boom");
    expect(record.output_tail).not.toContain("Hunter2");
    expect(
      readFileSync(path.join(repo.root, ".alethic/receipts/rcpt-fail.yaml"), "utf8"),
    ).not.toContain("Hunter2Hunter2!");
  });

  it("discloses that it ran on uncommitted changes", async () => {
    const repo = await repoWithTask();
    repo.write("README.md", "# workspace, edited\n");
    expect((await run(repo, "rcpt-dirty", "0")).code).toBe(0);
    expect(receipt(repo, "rcpt-dirty")).toMatchObject({
      git: { dirty: true },
      state: { before: { dirty: true }, changed_during_run: false },
    });
    expect(await checkLine(repo, "rcpt-dirty")).toContain("it ran on uncommitted changes");
  });

  it("makes changes during the run visible", async () => {
    const repo = await repoWithTask();
    const result = await run(
      repo,
      "rcpt-racy",
      "require('fs').appendFileSync('apps/api/auth/session.ts', '// touched\\n')",
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("warning: Files changed while the command ran");
    const record = receipt(repo, "rcpt-racy");
    expect(record.state?.changed_during_run).toBe(true);
    expect(record.state?.before.digest).not.toBe(record.state?.after.digest);
    expect(await checkLine(repo, "rcpt-racy")).toContain("⚠ files changed while it ran");
  });

  it("records partial coverage when more files match than it digests", async () => {
    const repo = await repoWithTask();
    const manifest = path.join(repo.root, ".alethic/manifest.yaml");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8").replace(
        "max_fingerprints_per_record: 50",
        "max_fingerprints_per_record: 50\n  max_receipt_files: 2",
      ),
    );
    await repo.commitAll("limit receipt files");
    const result = await run(repo, "rcpt-partial", "0");
    expect(result.stdout).toContain("warning: Only the first 2 of");
    expect(receipt(repo, "rcpt-partial").state).toMatchObject({
      coverage: "partial",
      file_limit: 2,
      before: { files: 2 },
    });
    expect(await checkLine(repo, "rcpt-partial")).toContain(
      "digested only part of the working tree",
    );
  });

  it("records a command that cannot start as an error", async () => {
    const repo = await repoWithTask();
    const result = await cli(
      ["receipt", "run", "--id", "rcpt-missing", "--", "alethic-no-such-command-xyz"],
      as(repo, "codex"),
    );
    expect(result.code).toBe(1);
    expect(receipt(repo, "rcpt-missing")).toMatchObject({ result: "error", exit_code: 127 });
    expect(receipt(repo, "rcpt-missing").output_tail).toContain("ENOENT");
  });

  it("keeps stdout machine-readable with --json", async () => {
    const repo = await repoWithTask();
    const result = await run(repo, "rcpt-json", "console.log('noise')", ["--json"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: "rcpt-json",
      result: "pass",
      capture: "observed",
      changedDuringRun: false,
    });
    expect(result.stderr).toContain("noise");
  });
});

describe("imported receipts", () => {
  it("never read as observed, and uncommitted edits make them inapplicable", async () => {
    const repo = await repoWithTask();
    expectOk(
      await cli(
        ["receipt", "add", "--command", "npm test", "--exit-code", "0", "--id", "rcpt-told"],
        as(repo, "codex"),
      ),
    );
    expect(receipt(repo, "rcpt-told").provenance).toEqual({ source: "local", capture: "imported" });
    const clean = await checkLine(repo, "rcpt-told");
    expect(clean).toContain("(HEAD; reported to Alethic, not observed)");
    expect(clean).not.toContain("observed by");

    repo.write("apps/api/auth/refresh.ts", "export function refresh() { return 1; }\n");
    expect(await checkLine(repo, "rcpt-told")).toContain(
      "⚠ there are uncommitted changes, so whether it applies to this code is unknown",
    );
  });
});
