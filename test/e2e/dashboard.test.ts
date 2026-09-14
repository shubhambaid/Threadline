import { writeFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Io } from "../../src/commands/context.js";
import type { Finding } from "../../src/core/findings.js";
import {
  buildDashboardModel,
  type DashboardModel,
  inspectBriefing,
  inspectRecord,
} from "../../src/dashboard/ledger.js";
import { renderPage } from "../../src/dashboard/page.js";
import { startDashboard } from "../../src/dashboard/server.js";
import { createRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { cli, TEST_NOW } from "../helpers/run-cli.js";
import { expectOk, initializedRepo } from "../helpers/workspace.js";

const LATER = "2026-09-13T22:30:00Z";

function as(repo: FixtureRepo, agent: string, session: string, at: string) {
  return {
    cwd: repo.root,
    env: { ALETHIC_AGENT: agent, ALETHIC_SESSION: session, ALETHIC_NOW: at },
  };
}

function ioFor(repo: FixtureRepo): Io {
  return {
    cwd: repo.root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ALETHIC_NOW: LATER },
    stdout: () => {},
    stderr: () => {},
  };
}

/**
 * Two codex sessions, a handoff to claude-code, a contradiction, an overlapping claim, a withheld
 * record with a secret, changed evidence, and a check that no longer applies.
 */
async function ledgerRepo(): Promise<FixtureRepo> {
  const repo = await initializedRepo();
  const run = async (args: string[], who: ReturnType<typeof as>) => expectOk(await cli(args, who));
  const codexA = (at: string) => as(repo, "codex", "codex-a", at);
  const codexB = (at: string) => as(repo, "codex", "codex-b", at);
  const claude = (at: string) => as(repo, "claude-code", "claude-1", at);

  await run(
    ["task", "start", "Rework sessions", "--id", "task-sessions", "--paths", "apps/api/auth/**"],
    codexA(TEST_NOW),
  );
  await run(
    [
      ...["decision", "add", "--topic", "auth.session-store", "--id", "dec-store-postgres"],
      ...["--chosen", "Keep sessions in Postgres", "--rationale", "One store to run."],
      ...[
        "--evidence-file",
        "apps/api/auth/session.ts",
        "--paths",
        "apps/api/auth/**",
        "--link",
        "task-sessions",
      ],
    ],
    codexA("2026-09-13T21:05:00Z"),
  );
  await run(
    [
      "checkpoint",
      "create",
      "--failed",
      "Delete session rows::The cache serves them",
      "--next",
      "Compare token versions",
    ],
    codexA("2026-09-13T21:10:00Z"),
  );
  await run(
    ["task", "update", "task-sessions", "--status", "paused"],
    codexA("2026-09-13T21:11:00Z"),
  );
  await repo.commitAll("codex session a");

  await run(["task", "claim", "task-sessions"], claude("2026-09-13T21:30:00Z"));
  await run(
    ["receipt", "add", "--command", "npm test", "--exit-code", "0"],
    claude("2026-09-13T21:40:00Z"),
  );
  await run(["checkpoint", "create", "--next", "Ship it"], claude("2026-09-13T21:45:00Z"));

  await run(
    [
      "task",
      "start",
      "Expire idle sessions",
      "--id",
      "task-idle",
      "--paths",
      "apps/api/auth/session.ts",
    ],
    codexB("2026-09-13T21:50:00Z"),
  );
  await run(
    [
      ...["decision", "add", "--topic", "auth.session-store", "--id", "dec-store-redis"],
      ...[
        "--chosen",
        "Move sessions to Redis",
        "--rationale",
        "Survive restarts.",
        "--paths",
        "apps/api/auth/**",
      ],
    ],
    codexB("2026-09-13T21:55:00Z"),
  );
  writeFileSync(
    path.join(repo.root, ".alethic/knowledge/kn-leak.yaml"),
    [
      "id: kn-leak",
      "kind: knowledge",
      "schema_version: 1",
      "summary: Staging admin login",
      "status: active",
      "confidence: agent-reported",
      "category: operations",
      "body: The staging admin uses password = Hunter2Hunter2!",
      "created_by:",
      "  agent: codex",
      'created_at: "2026-09-13T21:00:00Z"',
      "",
    ].join("\n"),
  );
  await repo.commitAll("more work");
  // An uncommitted edit to the decision's evidence.
  repo.write("apps/api/auth/session.ts", "export function createSession() { return 1; }\n");
  return repo;
}

let repo: FixtureRepo;
let model: DashboardModel;

beforeAll(async () => {
  repo = await ledgerRepo();
  model = await buildDashboardModel(ioFor(repo), new Date(LATER));
}, 120_000);

describe("dashboard model", () => {
  it("tells two sessions of the same agent apart", () => {
    const codex = model.sessions.filter((session) => session.agent === "codex");
    expect(codex.map((session) => session.label).sort()).toEqual([
      "codex (session codex-a)",
      "codex (session codex-b)",
    ]);
    expect(model.nodes.find((node) => node.id === "dec-store-redis")?.session).toBe(
      "session:codex#codex-b",
    );
    expect(model.health.items).toContainEqual(
      expect.objectContaining({
        code: "overlapping-claim",
        message: expect.stringContaining("claude-code (session claude-1)"),
      }),
    );
  });

  it("explains every relationship and never claims a briefing was delivered", () => {
    expect(model.edges.length).toBeGreaterThan(10);
    for (const edge of model.edges) {
      expect(["explicit", "inferred"]).toContain(edge.basis);
      expect(edge.explanation.length).toBeGreaterThan(10);
    }
    expect(model.delivery.recorded).toBe(false);
    const handoff = model.edges.find(
      (edge) =>
        edge.type === "handoff" &&
        edge.from === "session:codex#codex-a" &&
        edge.to === "session:claude-code#claude-1",
    );
    expect(handoff).toMatchObject({ basis: "inferred", via: { task: "task-sessions" } });
    expect(handoff?.explanation).toContain(
      "nothing records that claude-code (session claude-1) read",
    );
    expect(model.edges).toContainEqual(
      expect.objectContaining({
        from: "dec-store-postgres",
        to: "task-sessions",
        type: "links",
        basis: "explicit",
      }),
    );
    expect(model.edges).toContainEqual(
      expect.objectContaining({
        from: "dec-store-redis",
        to: "task-sessions",
        type: "relevant-to",
        basis: "inferred",
      }),
    );
  });

  it("makes changed evidence, conflicts, and invalid records visible without leaking content", () => {
    const postgres = model.nodes.find((node) => node.id === "dec-store-postgres");
    expect(postgres).toMatchObject({ freshness: "needs_reverification", disputed: true });
    const receipt = model.nodes.find((node) => node.type === "receipt");
    expect(receipt?.applicability).toBe("uncommitted");

    const withheld = model.nodes.find((node) => node.withheld);
    expect(withheld).toMatchObject({
      id: "withheld:.alethic/knowledge/kn-leak.yaml",
      codes: ["secret"],
    });
    expect(withheld?.summary).toBeUndefined();
    expect(JSON.stringify(model)).not.toContain("Hunter2");

    const codes = model.health.items.map((item) => item.code);
    for (const code of [
      "secret",
      "needs-reverification",
      "contradiction",
      "overlapping-claim",
      "check-applicability",
    ]) {
      expect(codes, code).toContain(code);
    }
    expect(model.health.items.find((item) => item.code === "secret")?.record).toBe(withheld?.id);
    expect(model.health.items.find((item) => item.code === "needs-reverification")?.record).toBe(
      "dec-store-postgres",
    );
  });

  it("agrees with the CLI's validation", async () => {
    const result = await cli(["validate", "--json"], {
      cwd: repo.root,
      env: { ALETHIC_NOW: LATER },
    });
    const validation = JSON.parse(result.stdout) as {
      errors: number;
      warnings: number;
      findings: Finding[];
    };
    expect(model.health.errors).toBe(validation.errors);
    for (const finding of validation.findings) {
      expect(model.health.items).toContainEqual(
        expect.objectContaining({ code: finding.code, message: finding.message }),
      );
    }
  });

  it("inspects a record with its anchor comparison and trust, and refuses withheld content", async () => {
    const inspection = await inspectRecord(ioFor(repo), "dec-store-postgres", new Date(LATER));
    if (inspection.withheld) throw new Error("expected a usable record");
    expect(inspection.staleness.status).toBe("needs_reverification");
    expect(inspection.anchor.rows).toContainEqual(
      expect.objectContaining({
        path: "apps/api/auth/session.ts",
        role: "direct",
        state: "changed",
      }),
    );
    expect(inspection.trust).toContain("Reported by codex (session codex-a)");
    expect(inspection.text).toContain("topic: auth.session-store");

    const leak = await inspectRecord(ioFor(repo), "kn-leak", new Date(LATER));
    expect(leak).toMatchObject({ withheld: true, codes: ["secret"] });
    expect(JSON.stringify(leak)).not.toContain("Hunter2");
  });

  it("shows what a briefing would contain and why, without claiming it was delivered", async () => {
    const briefing = await inspectBriefing(ioFor(repo), "task-sessions", 800, new Date(LATER));
    expect(briefing.note).toContain("It is not a record that any agent received it");
    expect(briefing.report.budget).toBe(800);
    const items = briefing.sections.flatMap((section) => section.items);
    expect(
      items.some((item) => item.record === "dec-store-postgres" && (item.reasons ?? []).length > 0),
    ).toBe(true);
  });

  it("exports the same model as a snapshot", async () => {
    const result = expectOk(
      await cli(["dashboard", "--snapshot", "-"], { cwd: repo.root, env: { ALETHIC_NOW: LATER } }),
    );
    const snapshot = JSON.parse(result.stdout) as DashboardModel;
    expect(snapshot.nodes.length).toBe(model.nodes.length);
    expect(result.stdout).not.toContain("Hunter2");
  });
});

function get(port: number, target: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: target, method, headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    },
  );
}

describe("dashboard server", () => {
  it("serves a self-contained page and JSON on loopback, read-only", async () => {
    const server = await startDashboard(ioFor(repo), { port: 0 });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const page = await get(server.port, "/");
      expect(page.status).toBe(200);
      const csp = String(page.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'none'");
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce).toBeTruthy();
      expect(page.body).toContain(`<script nonce="${nonce}">`);
      expect(page.body).not.toMatch(/<script[^>]+src=/);

      const ledger = await get(server.port, "/api/ledger");
      expect(ledger.status).toBe(200);
      expect((JSON.parse(ledger.body) as DashboardModel).version).toBe(model.version);

      expect((await get(server.port, "/api/ledger", {}, "POST")).status).toBe(405);
      expect((await get(server.port, "/", { host: "attacker.example" })).status).toBe(403);
      expect((await get(server.port, "/api/record?id=../../etc/passwd")).status).toBe(400);
      expect((await get(server.port, "/api/briefing?task=task-sessions&budget=5")).status).toBe(
        400,
      );
      const missing = await get(server.port, "/api/record?id=dec-nope");
      expect(missing.status).toBe(400);
      expect(missing.body).toContain("dec-nope does not exist");
    } finally {
      await server.close();
    }
  });

  it("refuses to listen beyond this machine", async () => {
    await expect(startDashboard(ioFor(repo), { host: "0.0.0.0", port: 0 })).rejects.toThrow(
      "only listens on this machine",
    );
  });

  it("embeds the browser code without a premature closing script tag", () => {
    const page = renderPage("abc");
    expect(page.match(/<\/script>/g)).toHaveLength(1);
    expect(page).toContain("function clientMain");
  });
});

describe("dashboard on a large ledger", () => {
  it("builds the model for 1200 decisions within bounds", async () => {
    const big = await createRepo();
    for (let i = 0; i < 40; i++)
      big.write(`src/mod${i % 4}/f${i}.ts`, `export const v${i} = ${i};\n`);
    await big.commitAll("code");
    expectOk(await cli(["init", "--name", "big"], { cwd: big.root }));
    expectOk(
      await cli(
        ["task", "start", "Big", "--id", "task-big", "--paths", "src/**"],
        as(big, "codex", "s-1", TEST_NOW),
      ),
    );
    for (let i = 0; i < 1200; i++) {
      writeFileSync(
        path.join(big.root, `.alethic/decisions/dec-big-${i}.yaml`),
        `id: dec-big-${i}\nkind: decision\nschema_version: 1\nsummary: Decision ${i}\nstatus: accepted\nconfidence: agent-reported\ntopic: big.topic-${i}\nchosen: Option ${i}\nrationale: Reason ${i}.\nscope:\n  paths:\n    - src/mod${i % 4}/**\ncreated_by:\n  agent: codex\n  session: s-${i % 3}\ncreated_at: "2026-09-13T20:00:00Z"\n`,
      );
    }
    await big.commitAll("ledger");
    const started = Date.now();
    const bigModel = await buildDashboardModel(ioFor(big), new Date(LATER));
    const elapsed = Date.now() - started;
    expect(elapsed, `model took ${elapsed} ms`).toBeLessThan(30_000);
    expect(bigModel.nodes.filter((node) => node.type === "decision")).toHaveLength(1200);
    expect(bigModel.sessions).toHaveLength(3);
  }, 120_000);
});
