import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/core/findings.js";
import { cli } from "../helpers/run-cli.js";
import {
  as,
  expectOk,
  expectValid,
  initializedRepo,
  readRecord,
  shortHead,
} from "../helpers/workspace.js";

const NOW = "2026-09-13T21:00:00Z";
const LATER = "2026-09-14T21:00:00Z";
const DECISION_FILE = ".threadline/decisions/dec-auth-refresh-cache.yaml";

interface DoctorReport {
  ok: boolean;
  errors: number;
  warnings: number;
  fixed: string[];
  findings: (Finding & { command?: string; fixable: boolean })[];
}

function rewrite(lines: number, prefix: string): string {
  return `${Array.from({ length: lines }, (_, i) => `export const ${prefix}${i} = ${i};`).join("\n")}\n`;
}

async function validateJson(root: string, at = NOW) {
  const result = await cli(["validate", "--json"], { cwd: root, env: { THREADLINE_NOW: at } });
  return JSON.parse(result.stdout) as { findings: Finding[]; errors: number; warnings: number };
}

async function doctor(root: string, args: string[] = [], at = NOW) {
  const result = await cli(["doctor", "--json", ...args], {
    cwd: root,
    env: { THREADLINE_NOW: at, THREADLINE_AGENT: "gemini" },
  });
  return {
    code: result.code,
    report: JSON.parse(result.stdout) as DoctorReport,
    stderr: result.stderr,
  };
}

function codes(findings: readonly Finding[]): string[] {
  return findings.map((f) => f.code).sort();
}

describe("staleness in validate, and threadline verify", () => {
  it("warns about changed evidence and re-anchors only on an explicit verify", async () => {
    const repo = await initializedRepo();
    expectOk(
      await cli(
        [
          "decision",
          "add",
          "--topic",
          "auth.refresh-cache",
          "--chosen",
          "Cache refresh sessions in Redis for 15 minutes",
          "--rationale",
          "Refresh is the hottest endpoint.",
          "--evidence-file",
          "apps/api/auth/refresh.ts",
          "--paths",
          "apps/api/auth/**",
        ],
        as(repo, "codex"),
      ),
    );
    await repo.commitAll("record decision");
    await expectValid(repo);

    // An edit elsewhere under the scope glob is only context.
    repo.write("apps/api/auth/session.ts", rewrite(30, "session"));
    await expectValid(repo);

    repo.write("apps/api/auth/refresh.ts", rewrite(40, "refresh"));
    await repo.commitAll("rewrite refresh");
    const stale = await validateJson(repo.root);
    expect(stale.errors).toBe(0);
    expect(stale.findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "needs-reverification",
        file: DECISION_FILE,
        message:
          "May be stale: apps/api/auth/refresh.ts changed 41 lines (+40/-1) since it was anchored",
      }),
    ]);
    expect(stale.findings[0]?.hint).toContain("threadline verify dec-auth-refresh-cache");

    const verified = expectOk(
      await cli(["verify", "dec-auth-refresh-cache"], as(repo, "claude-code")),
    );
    expect(verified.stdout).toContain(
      "was: needs_reverification: apps/api/auth/refresh.ts changed 41 lines",
    );
    expect(verified.stdout).toContain("confidence: agent-reported");
    const afterVerify = readRecord(repo, DECISION_FILE);
    expect(afterVerify.valid_at).toBe(await shortHead(repo));
    expect(afterVerify.updated_at).toBe(NOW);
    await expectValid(repo);

    expectOk(
      await cli(
        ["verify", "dec-auth-refresh-cache", "--human", "Priya", "--note", "Read refresh.ts"],
        as(repo, "claude-code"),
      ),
    );
    const confirmed = readRecord(repo, DECISION_FILE);
    expect(confirmed.confidence).toBe("human-confirmed");
    expect((confirmed.evidence as { human: unknown[] }).human).toEqual([
      { name: "Priya", at: NOW, note: "Read refresh.ts" },
    ]);

    // Re-verifying unchanged content keeps the human confirmation.
    expectOk(await cli(["verify", "dec-auth-refresh-cache"], as(repo, "codex")));
    expect(readRecord(repo, DECISION_FILE).confidence).toBe("human-confirmed");

    // After the code changes, an agent cannot carry the human confirmation forward.
    repo.write("apps/api/auth/refresh.ts", rewrite(40, "changed"));
    const downgraded = expectOk(
      await cli(["verify", "dec-auth-refresh-cache", "--json"], as(repo, "codex")),
    );
    const output = JSON.parse(downgraded.stdout);
    expect(output.confidence).toBe("agent-reported");
    expect(output.warnings[0]).toContain(
      "Confidence changed from human-confirmed to agent-reported",
    );
    await expectValid(repo);
  });

  it("refuses append-only, retired, and broken records", async () => {
    const repo = await initializedRepo();
    const codex = as(repo, "codex");
    expectOk(await cli(["task", "start", "Add session reset", "--id", "task-reset"], codex));
    const checkpoint = JSON.parse(
      expectOk(await cli(["checkpoint", "create", "--json"], codex)).stdout,
    ).id as string;
    const appendOnly = await cli(["verify", checkpoint], codex);
    expect(appendOnly.code).toBe(2);
    expect(appendOnly.stderr).toContain("checkpoints are append-only");

    expectOk(
      await cli(
        [
          ...["knowledge", "add", "--category", "gotcha", "--body", "Refresh reads Redis first."],
          ...["--evidence-file", "apps/api/auth/refresh.ts", "--id", "kn-refresh-redis"],
        ],
        codex,
      ),
    );
    await repo.run(["rm", "-q", "apps/api/auth/refresh.ts"]);
    const broken = await cli(["verify", "kn-refresh-redis"], codex);
    expect(broken.code).toBe(2);
    expect(broken.stderr).toContain('evidence.files "apps/api/auth/refresh.ts" does not exist');
    expect(broken.stderr).toContain("Remove it from .threadline/knowledge/kn-refresh-redis.yaml");

    expectOk(
      await cli(["knowledge", "update", "kn-refresh-redis", "--status", "deprecated"], codex),
    );
    const retired = await cli(["verify", "kn-refresh-redis"], codex);
    expect(retired.code).toBe(2);
    expect(retired.stderr).toContain("kn-refresh-redis is deprecated");

    const noNote = await cli(["verify", "task-reset", "--note", "looked"], codex);
    expect(noNote.code).toBe(2);
    expect(noNote.stderr).toContain("--note describes a --human check");
  });
});

describe("threadline doctor", () => {
  it("reports contradictions and overlapping claims, and fixes only mechanical problems", async () => {
    const repo = await initializedRepo();
    const codex = as(repo, "codex");
    const claude = as(repo, "claude-code");
    const decide = (id: string, paths: string, extra: string[] = [], who = codex) =>
      cli(
        [
          ...["decision", "add", "--topic", "auth.session-store", "--id", id],
          ...["--chosen", `Option ${id}`, "--rationale", "Because.", "--paths", paths, ...extra],
        ],
        who,
      );
    expectOk(await decide("dec-store-postgres", "apps/api/auth/**"));
    expectOk(await decide("dec-store-redis", "apps/api/auth/session.ts", [], claude));
    expectOk(await decide("dec-store-docs", "docs/**"));
    expectOk(await cli(["task", "start", "Rework sessions", "--paths", "apps/api/auth/**"], codex));
    expectOk(
      await cli(["task", "start", "Fix refresh", "--paths", "apps/api/auth/refresh.ts"], claude),
    );

    const validation = await validateJson(repo.root);
    expect(codes(validation.findings)).toEqual(["contradiction"]);
    expect(validation.findings[0]).toMatchObject({
      file: ".threadline/decisions/dec-store-redis.yaml",
      message:
        "Accepted decisions dec-store-postgres and dec-store-redis both decide auth.session-store for overlapping paths, and neither supersedes the other",
    });

    const first = await doctor(repo.root);
    expect(first.code).toBe(0);
    expect(codes(first.report.findings)).toEqual(["contradiction", "overlapping-claim"]);
    expect(first.report.findings.find((f) => f.code === "contradiction")?.command).toBe(
      "threadline decision update dec-store-postgres --status superseded",
    );

    expectOk(
      await decide("dec-store-tokens", "apps/api/auth/**", [
        ...["--supersedes", "dec-store-postgres", "--supersedes", "dec-store-redis"],
      ]),
    );
    const later = await doctor(repo.root, [], LATER);
    expect(later.code).toBe(1);
    expect(codes(later.report.findings)).toEqual([
      "contradiction",
      "expired-lease",
      "expired-lease",
      "superseded-still-accepted",
      "superseded-still-accepted",
    ]);
    expect(later.report.findings.filter((f) => f.fixable).map((f) => f.code)).toEqual([
      "expired-lease",
      "expired-lease",
      "superseded-still-accepted",
      "superseded-still-accepted",
    ]);

    const fixed = await doctor(repo.root, ["--fix"], LATER);
    expect(fixed.code).toBe(0);
    expect(fixed.report.fixed).toEqual([
      expect.stringMatching(/^Paused task-fix-refresh: the lease held by claude-code expired/),
      expect.stringMatching(/^Paused task-rework-sessions: the lease held by codex expired/),
      "Marked dec-store-postgres superseded: dec-store-tokens supersedes it.",
      "Marked dec-store-redis superseded: dec-store-tokens supersedes it.",
    ]);
    expect(fixed.report.findings).toEqual([]);
    expect(readRecord(repo, ".threadline/tasks/task-rework-sessions.yaml")).toMatchObject({
      status: "paused",
      owner: { agent: "codex" },
    });
    await expectValid(repo, LATER);

    const again = await doctor(repo.root, ["--fix"], LATER);
    expect(again.report.fixed).toEqual([]);
  });

  it("reports checkpoints written after their task closed", async () => {
    const repo = await initializedRepo();
    expectOk(
      await cli(["task", "start", "Add audit log", "--id", "task-audit"], as(repo, "codex", NOW)),
    );
    // A checkpoint from one branch and a close from another, merged: the checkpoint is newer.
    expectOk(
      await cli(
        ["checkpoint", "create", "--next", "Write the audit table migration"],
        as(repo, "codex", "2026-09-13T21:30:00Z"),
      ),
    );
    expectOk(await cli(["task", "close", "task-audit"], as(repo, "codex", "2026-09-13T21:10:00Z")));

    const { report } = await doctor(repo.root, [], "2026-09-13T22:00:00Z");
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: "orphaned-checkpoint",
        message:
          "Written after task-audit was closed (done); its next action may be unfinished work: Write the audit table migration",
        command: expect.stringMatching(/^threadline checkpoint show cp-audit-/),
      }),
    ]);
  });

  it("prints a readable summary", async () => {
    const repo = await initializedRepo();
    const clean = expectOk(await cli(["doctor"], { cwd: repo.root }));
    expect(clean.stdout).toBe("✓ No problems found in 0 records.\n");

    expectOk(await cli(["task", "start", "Rework sessions"], as(repo, "codex")));
    const result = await cli(["doctor"], { cwd: repo.root, env: { THREADLINE_NOW: LATER } });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("fixable: threadline doctor --fix");
    expect(result.stdout).toContain("✗ 1 error, 0 warnings (1 fixable with --fix)");
  });
});
