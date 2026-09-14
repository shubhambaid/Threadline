import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cli } from "../helpers/run-cli.js";
import {
  as,
  expectOk,
  expectValid,
  initializedRepo,
  readRecord,
  shortHead,
} from "../helpers/workspace.js";

const DECISION_FILE = ".alethic/decisions/dec-auth-session-invalidation.yaml";

function decisionArgs(extra: string[] = []): string[] {
  return [
    "decision",
    "add",
    "--topic",
    "auth.session-invalidation",
    "--chosen",
    "Bump a per-user token_version on password reset",
    "--rationale",
    "One increment revokes every session, including cached refresh tokens",
    ...extra,
  ];
}

describe("alethic decision", () => {
  it("records alternatives, evidence, and an anchor", async () => {
    const repo = await initializedRepo();
    const short = (repo.commits[0] ?? "").slice(0, 7);
    expectOk(
      await cli(
        decisionArgs([
          "--alternative",
          "Delete session rows::Refresh tokens are cached for 15 minutes",
          "--paths",
          "apps/api/auth/**",
          "--evidence-file",
          "apps/api/auth/session.ts",
          "--commit",
          short,
          "--check",
          "pnpm test auth",
        ]),
        as(repo, "claude-code"),
      ),
    );
    const decision = readRecord(repo, DECISION_FILE);
    expect(decision).toMatchObject({
      status: "accepted",
      confidence: "agent-reported",
      topic: "auth.session-invalidation",
      alternatives: [
        {
          option: "Delete session rows",
          rejected_because: "Refresh tokens are cached for 15 minutes",
        },
      ],
      evidence: {
        files: ["apps/api/auth/session.ts"],
        commits: [short],
        checks: ["pnpm test auth"],
      },
      created_by: { agent: "claude-code" },
    });
    const fingerprints = Object.keys((decision.anchor as { fingerprints: object }).fingerprints);
    expect(fingerprints[0]).toBe("apps/api/auth/session.ts");
    await expectValid(repo);
  });

  it("records human confirmation only when a human is named", async () => {
    const repo = await initializedRepo();
    expectOk(await cli(decisionArgs(["--human", "maintainer"]), as(repo, "claude-code")));
    expect(readRecord(repo, DECISION_FILE)).toMatchObject({
      confidence: "human-confirmed",
      created_by: { agent: "claude-code", human: "maintainer" },
      evidence: { human: [{ name: "maintainer", note: "Confirmed this decision." }] },
    });
    await expectValid(repo);
  });

  it("refuses secrets and dangling references without writing anything", async () => {
    const repo = await initializedRepo();
    const token = `sk-${"ant-"}api03-${"a".repeat(30)}`;
    const leaked = await cli(
      [
        "decision",
        "add",
        "--topic",
        "deploy.keys",
        "--chosen",
        "Use the shared key",
        "--rationale",
        `It is ${token}`,
      ],
      as(repo, "codex"),
    );
    expect(leaked.code).toBe(2);
    expect(leaked.stderr).toContain("rationale looks like a Anthropic API key");
    expect(leaked.stderr).not.toContain(token);

    const dangling = await cli(decisionArgs(["--link", "kn-missing"]), as(repo, "codex"));
    expect(dangling.code).toBe(2);
    expect(dangling.stderr).toContain("--link kn-missing does not exist");

    expect(readdirSync(path.join(repo.root, ".alethic/decisions"))).toEqual([".gitkeep"]);
  });

  it("marks decisions superseded", async () => {
    const repo = await initializedRepo();
    expectOk(await cli(decisionArgs(), as(repo, "codex")));
    expectOk(
      await cli(
        ["decision", "update", "dec-auth-session-invalidation", "--status", "superseded"],
        as(repo, "claude-code", "2026-09-13T22:00:00Z"),
      ),
    );
    expect(readRecord(repo, DECISION_FILE)).toMatchObject({
      status: "superseded",
      updated_at: "2026-09-13T22:00:00Z",
    });
  });
});

describe("alethic knowledge", () => {
  it("adds and deprecates facts", async () => {
    const repo = await initializedRepo();
    expectOk(
      await cli(
        [
          "knowledge",
          "add",
          "--category",
          "gotcha",
          "--summary",
          "Refresh tokens are cached",
          "--body",
          "refresh.ts reads sessions from Redis (TTL 900s) before Postgres.",
          "--evidence-file",
          "apps/api/auth/refresh.ts",
        ],
        as(repo, "codex"),
      ),
    );
    const file = ".alethic/knowledge/kn-refresh-tokens-are-cached.yaml";
    expect(readRecord(repo, file)).toMatchObject({
      status: "active",
      category: "gotcha",
      evidence: { files: ["apps/api/auth/refresh.ts"] },
    });
    await expectValid(repo);

    expectOk(
      await cli(
        ["knowledge", "update", "kn-refresh-tokens-are-cached", "--status", "deprecated"],
        as(repo, "codex"),
      ),
    );
    expect(readRecord(repo, file).status).toBe("deprecated");

    const bad = await cli(
      ["knowledge", "add", "--category", "trivia", "--body", "x"],
      as(repo, "codex"),
    );
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--category must be one of");
  });
});

describe("alethic receipt", () => {
  it("records a failing check with redacted, truncated output", async () => {
    const repo = await initializedRepo();
    const token = `sk-${"ant-"}api03-${"b".repeat(30)}`;
    const log = path.join(mkdtempSync(path.join(tmpdir(), "alethic-log-")), "auth.log");
    writeFileSync(
      log,
      `${"noise line\n".repeat(1000)}FAIL session.test.ts\nANTHROPIC_API_KEY=${token}\nTests: 1 failed\n`,
    );
    const result = expectOk(
      await cli(
        [
          "receipt",
          "add",
          "--command",
          "pnpm test auth",
          "--exit-code",
          "1",
          "--output-file",
          log,
          "--duration-ms",
          "1200",
        ],
        as(repo, "codex"),
      ),
    );
    expect(result.stdout).toContain("(fail, agent-reported)");
    const receipt = readRecord(repo, ".alethic/receipts/rcpt-pnpm-test-auth-20260913t210000z.yaml");
    expect(receipt).toMatchObject({
      status: "recorded",
      confidence: "agent-reported",
      command: "pnpm test auth",
      exit_code: 1,
      result: "fail",
      duration_ms: 1200,
      git: { branch: "main", head: await shortHead(repo), dirty: false },
      provenance: { source: "local" },
    });
    const tail = receipt.output_tail as string;
    expect(tail.length).toBeLessThanOrEqual(4000);
    expect(tail).toContain("[REDACTED]");
    expect(tail).not.toContain(token);
    expect(tail.endsWith("Tests: 1 failed")).toBe(true);
    await expectValid(repo);
  });

  it("labels CI self-reports ci-reported, and dirty trees agent-reported", async () => {
    const repo = await initializedRepo();
    const ciEnv = {
      CI: "true",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "acme/api",
      GITHUB_RUN_ID: "42",
    };
    const options = as(repo, "ci");
    expectOk(
      await cli(["receipt", "add", "--command", "pnpm test", "--exit-code", "0"], {
        ...options,
        env: { ...options.env, ...ciEnv },
      }),
    );
    expect(
      readRecord(repo, ".alethic/receipts/rcpt-pnpm-test-20260913t210000z.yaml"),
    ).toMatchObject({
      result: "pass",
      confidence: "ci-reported",
      provenance: { source: "ci-env", run_url: "https://github.com/acme/api/actions/runs/42" },
    });

    repo.write("apps/api/auth/uncommitted.ts", "export {};\n");
    const later = as(repo, "ci", "2026-09-13T21:05:00Z");
    expectOk(
      await cli(["receipt", "add", "--command", "pnpm test", "--exit-code", "0"], {
        ...later,
        env: { ...later.env, ...ciEnv },
      }),
    );
    expect(
      readRecord(repo, ".alethic/receipts/rcpt-pnpm-test-20260913t210500z.yaml"),
    ).toMatchObject({
      confidence: "agent-reported",
      git: { dirty: true },
      provenance: { source: "local" },
    });
  });

  it("rejects a pass result with a non-zero exit code", async () => {
    const repo = await initializedRepo();
    const result = await cli(
      ["receipt", "add", "--command", "pnpm test", "--exit-code", "2", "--result", "pass"],
      as(repo, "codex"),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("exit_code must be 0");
    expect(
      existsSync(path.join(repo.root, ".alethic/receipts/rcpt-pnpm-test-20260913t210000z.yaml")),
    ).toBe(false);
  });
});
