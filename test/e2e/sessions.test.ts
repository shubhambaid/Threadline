import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/core/findings.js";
import { runCli } from "../../src/program.js";
import type { FixtureRepo } from "../helpers/fixture-repo.js";
import { cli, TEST_NOW } from "../helpers/run-cli.js";
import { expectOk, initializedRepo, readRecord } from "../helpers/workspace.js";

function as(repo: FixtureRepo, agent: string, session?: string, now = TEST_NOW, model?: string) {
  return {
    cwd: repo.root,
    env: {
      ALETHIC_AGENT: agent,
      ALETHIC_NOW: now,
      ...(session ? { ALETHIC_SESSION: session } : {}),
      ...(model ? { ALETHIC_MODEL: model } : {}),
    },
  };
}

async function doctorFindings(repo: FixtureRepo, now = TEST_NOW): Promise<Finding[]> {
  const result = await cli(["doctor", "--json"], { cwd: repo.root, env: { ALETHIC_NOW: now } });
  return JSON.parse(result.stdout).findings;
}

describe("agent sessions", () => {
  it("records the session and stated model of whoever writes", async () => {
    const repo = await initializedRepo();
    expectOk(
      await cli(
        ["task", "start", "Rework sessions", "--id", "task-x", "--paths", "apps/api/auth/**"],
        as(repo, "codex", "codex-a1", TEST_NOW, "gpt-5-codex"),
      ),
    );
    expect(readRecord(repo, ".alethic/tasks/task-x.yaml")).toMatchObject({
      created_by: { agent: "codex", session: "codex-a1", model: "gpt-5-codex" },
      owner: { agent: "codex", session: "codex-a1" },
    });
    const status = JSON.parse(expectOk(await cli(["status", "--json"], { cwd: repo.root })).stdout);
    expect(status.activeTasks[0]).toMatchObject({ owner: "codex", ownerSession: "codex-a1" });

    const invalid = await cli(["task", "start", "Nope"], as(repo, "codex", "not a session"));
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain('Invalid ALETHIC_SESSION "not a session"');

    const fresh = expectOk(await cli(["session", "new"], as(repo, "gemini"))).stdout.trim();
    expect(fresh).toMatch(/^gemini-[0-9a-f]{12}$/);
  });

  it("keeps another session of the same agent from taking a task it does not hold", async () => {
    const repo = await initializedRepo();
    expectOk(
      await cli(["task", "start", "Rework sessions", "--id", "task-x"], as(repo, "codex", "s-a")),
    );

    const refused = await cli(["task", "claim", "task-x"], as(repo, "codex", "s-b"));
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("task-x is held by codex (session s-a)");
    expect(refused.stderr).toContain("That is another session of codex (this one is s-b)");

    expect(
      expectOk(await cli(["task", "claim", "task-x"], as(repo, "codex", "s-a"))).stdout,
    ).toContain("Renewed task-x for codex (session s-a)");
    expect(
      expectOk(await cli(["task", "claim", "task-x", "--force"], as(repo, "codex", "s-b"))).stdout,
    ).toContain("Took over task-x from codex (session s-a)");

    // A caller that names no session cannot prove it is the holding session.
    const anonymous = await cli(["task", "update", "task-x", "--next", "x"], as(repo, "codex"));
    expect(anonymous.code).toBe(2);
    expect(anonymous.stderr).toContain("set ALETHIC_SESSION to that session to continue it");
  });

  it("warns when two sessions of the same tool hold overlapping tasks", async () => {
    const repo = await initializedRepo();
    expectOk(
      await cli(
        ["task", "start", "Rework sessions", "--id", "task-a", "--paths", "apps/api/auth/**"],
        as(repo, "codex", "s-a"),
      ),
    );
    expectOk(
      await cli(
        [
          "task",
          "start",
          "Fix session expiry",
          "--id",
          "task-b",
          "--paths",
          "apps/api/auth/session.ts",
        ],
        as(repo, "codex", "s-b"),
      ),
    );
    expect(await doctorFindings(repo)).toContainEqual(
      expect.objectContaining({
        code: "overlapping-claim",
        message:
          "task-a (codex (session s-a)) and task-b (codex (session s-b)) are both active over overlapping paths",
      }),
    );
  });

  it("reports a checkpoint written while another session held the task, keeping both names", async () => {
    const repo = await initializedRepo();
    expectOk(
      await cli(["task", "start", "Rework sessions", "--id", "task-x"], as(repo, "codex", "s-a")),
    );
    // Another session, e.g. on a branch merged later, checkpoints the task without claiming it.
    const later = "2026-09-13T21:30:00Z";
    const created = JSON.parse(
      expectOk(
        await cli(
          ["checkpoint", "create", "--task", "task-x", "--next", "Ship it", "--json"],
          as(repo, "claude-code", "s-b", later),
        ),
      ).stdout,
    ) as { id: string };

    const findings = await doctorFindings(repo, later);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "competing-claim",
        message: `${created.id} was written by claude-code (session s-b) at ${later}, while codex (session s-a) held task-x (claimed ${TEST_NOW}, lease until 2026-09-14T01:00:00Z)`,
        command: `alethic checkpoint show ${created.id}`,
      }),
    );
  });

  it("gives each MCP connection a session of its own", async () => {
    const repo = await initializedRepo();
    const messages = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "task_start", arguments: { intent: "Via MCP", id: "task-mcp" } },
      },
    ];
    let output = "";
    const code = await runCli(["mcp"], {
      cwd: repo.root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ALETHIC_AGENT: "claude-code",
        ALETHIC_NOW: TEST_NOW,
      },
      stdout: (text) => {
        output += text;
      },
      stderr: () => {},
      stdin: Readable.from([`${messages.map((m) => JSON.stringify(m)).join("\n")}\n`]),
    });
    expect(code).toBe(0);
    expect(output).toContain('"id":2');
    const record = readRecord(repo, ".alethic/tasks/task-mcp.yaml") as {
      created_by: { session: string };
    };
    expect(record.created_by.session).toMatch(/^mcp-[0-9a-f]{12}$/);
  });
});
