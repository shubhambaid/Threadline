import { writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/program.js";
import type { FixtureRepo } from "../helpers/fixture-repo.js";
import { cli, TEST_NOW } from "../helpers/run-cli.js";
import { as, expectOk, initializedRepo, readRecord } from "../helpers/workspace.js";

async function withStdin(repo: FixtureRepo, args: string[], input: string) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    cwd: repo.root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ALETHIC_AGENT: "codex",
      ALETHIC_NOW: TEST_NOW,
    },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: Readable.from([input]),
  });
  return { code, stdout, stderr };
}

describe("--from-file", () => {
  it("creates a checkpoint from a YAML file, with flags adding to it", async () => {
    const repo = await initializedRepo();
    expectOk(
      await cli(["task", "start", "Reset sessions", "--id", "task-reset"], as(repo, "codex")),
    );
    const file = path.join(repo.root, "checkpoint.yaml");
    writeFileSync(
      file,
      [
        "task: task-reset",
        "done:",
        "  - Added token_version",
        "failed_approaches:",
        "  - approach: Delete session rows",
        "    why_failed: The refresh cache still serves them",
        "open_questions:",
        "  - Revoke API keys too?",
        "next_safe_action: Compare token_version in refresh",
        "",
      ].join("\n"),
    );
    const created = JSON.parse(
      expectOk(
        await cli(
          [
            "checkpoint",
            "create",
            "--from-file",
            "checkpoint.yaml",
            "--done",
            "Wrote a test",
            "--json",
          ],
          as(repo, "codex"),
        ),
      ).stdout,
    ) as { file: string };
    expect(readRecord(repo, created.file)).toMatchObject({
      task: "task-reset",
      done: ["Added token_version", "Wrote a test"],
      failed_approaches: [
        { approach: "Delete session rows", why_failed: "The refresh cache still serves them" },
      ],
      open_questions: ["Revoke API keys too?"],
      next_safe_action: "Compare token_version in refresh",
    });
  });

  it("adds a decision from JSON on stdin", async () => {
    const repo = await initializedRepo();
    const result = await withStdin(
      repo,
      ["decision", "add", "--from-file", "-", "--json"],
      JSON.stringify({
        topic: "auth.session-invalidation",
        chosen: "Bump token_version on reset",
        rationale: "One write revokes every session.",
        alternatives: [
          { option: "Delete session rows", rejected_because: "The cache serves them" },
        ],
        paths: ["apps/api/auth/**"],
        evidence: { files: ["apps/api/auth/session.ts"], checks: ["npm test"] },
      }),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(readRecord(repo, ".alethic/decisions/dec-auth-session-invalidation.yaml")).toMatchObject(
      {
        chosen: "Bump token_version on reset",
        confidence: "agent-reported",
        alternatives: [
          { option: "Delete session rows", rejected_because: "The cache serves them" },
        ],
        scope: { paths: ["apps/api/auth/**"] },
        evidence: { files: ["apps/api/auth/session.ts"], checks: ["npm test"] },
      },
    );
  });

  it("adds knowledge from a file and lets flags override it", async () => {
    const repo = await initializedRepo();
    writeFileSync(
      path.join(repo.root, "fact.yaml"),
      "category: gotcha\nbody: Refresh reads the cache first.\nsummary: From the file\n",
    );
    const created = JSON.parse(
      expectOk(
        await cli(
          ["knowledge", "add", "--from-file", "fact.yaml", "--summary", "From the flag", "--json"],
          as(repo, "codex"),
        ),
      ).stdout,
    ) as { file: string };
    expect(readRecord(repo, created.file)).toMatchObject({
      category: "gotcha",
      body: "Refresh reads the cache first.",
      summary: "From the flag",
    });
  });

  it("refuses unknown fields, trust fields, missing required fields, and secrets", async () => {
    const repo = await initializedRepo();
    const write = (name: string, text: string) => writeFileSync(path.join(repo.root, name), text);

    write("unknown.yaml", "topic: a.b\nchosen: x\nrationale: y\ncolour: blue\n");
    const unknown = await cli(
      ["decision", "add", "--from-file", "unknown.yaml"],
      as(repo, "codex"),
    );
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown field "colour"');

    write("trust.yaml", "topic: a.b\nchosen: x\nrationale: y\nconfidence: human-confirmed\n");
    const trust = await cli(["decision", "add", "--from-file", "trust.yaml"], as(repo, "codex"));
    expect(trust.code).toBe(2);
    expect(trust.stderr).toContain('"confidence" cannot be set from a file');

    write("partial.yaml", "topic: a.b\nchosen: x\n");
    const partial = await cli(
      ["decision", "add", "--from-file", "partial.yaml"],
      as(repo, "codex"),
    );
    expect(partial.code).toBe(2);
    expect(partial.stderr).toContain("--rationale is required (or rationale in --from-file)");

    write("secret.yaml", "category: operations\nbody: The admin uses password = Hunter2Hunter2!\n");
    const secret = await cli(["knowledge", "add", "--from-file", "secret.yaml"], as(repo, "codex"));
    expect(secret.code).toBe(2);
    expect(secret.stderr).toContain("Refusing to write");
    expect(secret.stderr).not.toContain("Hunter2");
  });
});
