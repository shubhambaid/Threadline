import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/core/findings.js";
import type { FixtureRepo } from "../helpers/fixture-repo.js";
import { cli, TEST_NOW } from "../helpers/run-cli.js";
import { as, expectOk, expectValid, initializedRepo, readRecord } from "../helpers/workspace.js";

const DECISION = "dec-session-store";
const FILE = `.alethic/decisions/${DECISION}.yaml`;

async function setup(agent = "codex"): Promise<FixtureRepo> {
  const repo = await initializedRepo();
  expectOk(
    await cli(
      [
        ...["task", "start", "Move sessions", "--id", "task-sessions"],
        ...["--paths", "apps/api/auth/**"],
      ],
      as(repo, agent),
    ),
  );
  expectOk(
    await cli(
      [
        ...["decision", "add", "--topic", "auth.session-store", "--id", DECISION],
        ...["--chosen", "Keep sessions in Postgres", "--rationale", "One store to operate."],
        ...["--paths", "apps/api/auth/session.ts", "--link", "task-sessions", "--human", "Priya"],
      ],
      as(repo, agent),
    ),
  );
  return repo;
}

async function decisionLine(repo: FixtureRepo): Promise<string> {
  const text = expectOk(
    await cli(["resume", "--task", "task-sessions"], { cwd: repo.root }),
  ).stdout;
  return text.split("\n").find((l) => l.startsWith("- ") && l.includes(`[${DECISION}]`)) ?? "";
}

function edit(repo: FixtureRepo, change: (text: string) => string): void {
  const file = path.join(repo.root, FILE);
  writeFileSync(file, change(readFileSync(file, "utf8")));
}

async function findings(repo: FixtureRepo): Promise<Finding[]> {
  const result = await cli(["validate", "--json"], { cwd: repo.root });
  return JSON.parse(result.stdout).findings;
}

describe("human confirmation is an attribution, not authenticated approval", () => {
  it("records who was named, who recorded it, and what text it applies to", async () => {
    const repo = await setup("gemini");
    const record = readRecord(repo, FILE);
    expect(record.confidence).toBe("human-confirmed");
    expect((record.evidence as { human: unknown[] }).human).toEqual([
      {
        name: "Priya",
        at: TEST_NOW,
        note: "Confirmed this decision.",
        recorded_by: "gemini",
        authentication: "none",
        claim_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    await expectValid(repo);

    // Any agent can name a person; the briefing says whose word it is and that nobody checked.
    const line = await decisionLine(repo);
    expect(line).toContain("ℹ confirmed by Priya, as recorded by gemini; not authenticated");
    expect(line).not.toContain("⚠");
  });

  it("does not let an edited claim keep its confirmation", async () => {
    const repo = await setup();
    edit(repo, (text) => text.replaceAll("Keep sessions in Postgres", "Keep sessions in Redis"));

    expect(await findings(repo)).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "confirmation-outdated",
        file: FILE,
        message:
          "The claim was edited after Priya confirmed it, so that confirmation no longer applies",
      }),
    ]);
    expect(await decisionLine(repo)).toContain("⚠ unverified: edited after Priya confirmed it");

    // Re-verifying without a person does not restore it, even though the code is unchanged.
    const verified = JSON.parse(
      expectOk(await cli(["verify", DECISION, "--json"], as(repo, "codex"))).stdout,
    );
    expect(verified.confidence).toBe("agent-reported");
    expect(verified.warnings[0]).toContain("the claim was edited after it was confirmed");
  });

  it("withdraws the confirmation when an update changes the claim, but not for a status change", async () => {
    const repo = await setup();
    const statusOnly = JSON.parse(
      expectOk(
        await cli(
          ["decision", "update", DECISION, "--status", "proposed", "--json"],
          as(repo, "codex"),
        ),
      ).stdout,
    );
    expect(statusOnly.warnings).toEqual([]);
    expect(readRecord(repo, FILE).confidence).toBe("human-confirmed");

    const summary = JSON.parse(
      expectOk(
        await cli(
          ["decision", "update", DECISION, "--summary", "Sessions stay in Postgres", "--json"],
          as(repo, "codex"),
        ),
      ).stdout,
    );
    expect(summary.warnings[0]).toContain(
      "Confidence changed from human-confirmed to agent-reported: the text Priya confirmed has changed",
    );
    const record = readRecord(repo, FILE);
    expect(record.confidence).toBe("agent-reported");
    expect((record.evidence as { human: unknown[] }).human).toHaveLength(1);
    await expectValid(repo);
  });

  it("marks older confirmations that are not bound to the text", async () => {
    const repo = await setup();
    edit(repo, (text) => text.replace(/\n\s+claim_digest: [0-9a-f]+/, ""));
    await expectValid(repo);
    expect(await decisionLine(repo)).toContain(
      "⚠ confirmation by Priya is not tied to this text; not authenticated",
    );
  });
});
