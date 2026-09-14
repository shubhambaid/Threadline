import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FixtureRepo } from "../helpers/fixture-repo.js";
import { createRepo } from "../helpers/fixture-repo.js";
import { cli, TEST_NOW } from "../helpers/run-cli.js";
import { as, expectOk } from "../helpers/workspace.js";

const TASK = "task-scale";

/** A ledger with many decisions in the task's scope and many receipts on this line of history. */
async function scaleRepo(decisions: number, receipts: number): Promise<FixtureRepo> {
  const repo = await createRepo();
  for (let i = 0; i < 60; i++)
    repo.write(`src/mod${i % 6}/f${i}.ts`, `export const v${i} = ${i};\n`);
  await repo.commitAll("code");
  expectOk(await cli(["init", "--name", "scale"], { cwd: repo.root }));
  expectOk(
    await cli(
      ["task", "start", "Scale the ledger", "--id", TASK, "--paths", "src/**"],
      as(repo, "codex"),
    ),
  );
  const head = (await repo.run(["rev-parse", "--short", "HEAD"])).trim();
  const dir = (kind: string) => path.join(repo.root, ".alethic", kind);
  for (let i = 0; i < decisions; i++) {
    writeFileSync(
      path.join(dir("decisions"), `dec-scale-${i}.yaml`),
      [
        `id: dec-scale-${i}`,
        "kind: decision",
        "schema_version: 1",
        `summary: Decision ${i} about module ${i % 6}`,
        "status: accepted",
        "confidence: agent-reported",
        `topic: scale.topic-${i}`,
        `chosen: Choose option ${i} for module ${i % 6}`,
        `rationale: Option ${i} keeps module ${i % 6} simple.`,
        "scope:",
        "  paths:",
        `    - src/mod${i % 6}/**`,
        "created_by:",
        "  agent: codex",
        'created_at: "2026-09-13T20:00:00Z"',
        "",
      ].join("\n"),
    );
  }
  for (let i = 0; i < receipts; i++) {
    writeFileSync(
      path.join(dir("receipts"), `rcpt-scale-${i}.yaml`),
      [
        `id: rcpt-scale-${i}`,
        "kind: receipt",
        "schema_version: 1",
        `summary: check ${i} passed`,
        "status: recorded",
        "confidence: agent-reported",
        `command: npm test -- part-${i}`,
        "exit_code: 0",
        "result: pass",
        `ran_at: "${TEST_NOW}"`,
        "git:",
        `  head: "${head}"`,
        "  dirty: false",
        "provenance:",
        "  source: local",
        "  capture: imported",
        "created_by:",
        "  agent: codex",
        `created_at: "${TEST_NOW}"`,
        "",
      ].join("\n"),
    );
  }
  await repo.commitAll("ledger");
  return repo;
}

interface JsonBriefing {
  tokens: number;
  overBudget: boolean;
  report: { budget: number; frame: number; required: number; optional: number; pointers: number };
  sections: {
    key: string;
    items: { key: string; level: string; record?: string; reasons?: string[] }[];
  }[];
}

describe.each([
  [300, 60],
  [1500, 300],
])("resume on a ledger with %i decisions and %i receipts", (decisions, receipts) => {
  it("stays bounded, deterministic, inspectable, and retrievable", async () => {
    const repo = await scaleRepo(decisions, receipts);
    const run = (args: string[]) =>
      cli(["resume", "--task", TASK, ...args], { cwd: repo.root, env: { ALETHIC_NOW: TEST_NOW } });

    for (const budget of [1000, 2500]) {
      const started = Date.now();
      const text = expectOk(await run(["--budget", String(budget)])).stdout;
      const elapsed = Date.now() - started;
      expect(elapsed, `resume took ${elapsed} ms`).toBeLessThan(20_000);
      expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(budget);

      const pointerLines = text.split("\n").filter((line) => /^- \d+ more/.test(line));
      expect(pointerLines.length).toBeGreaterThan(0);
      for (const line of pointerLines) {
        expect((line.match(/\[|\(receipt /g) ?? []).length).toBeLessThanOrEqual(5);
        expect(line.length).toBeLessThan(220);
      }
      expect(expectOk(await run(["--budget", String(budget)])).stdout).toBe(text);
    }

    const json = JSON.parse(
      expectOk(await run(["--budget", "1000", "--format", "json"])).stdout,
    ) as JsonBriefing;
    expect(json.overBudget).toBe(false);
    expect(json.report.budget).toBe(1000);
    expect(
      json.report.frame + json.report.required + json.report.optional + json.report.pointers,
    ).toBeGreaterThanOrEqual(json.tokens - 10);
    const items = json.sections.flatMap((section) => section.items);
    const recordItems = items.filter(
      (item) => item.record?.startsWith("dec-scale-") || item.record?.startsWith("rcpt-scale-"),
    );
    expect(recordItems).toHaveLength(decisions + receipts);
    const collapsed = recordItems.find((item) => item.level === "pointer");
    expect(collapsed?.reasons?.length).toBeGreaterThan(0);

    const shown = expectOk(await cli(["show", collapsed?.record ?? ""], { cwd: repo.root }));
    expect(shown.stdout).toContain(`# ${collapsed?.record} (`);
  }, 120_000);
});
