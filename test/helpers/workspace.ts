import { readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { parseYaml } from "../../src/core/format.js";
import { createRepo, type FixtureRepo } from "./fixture-repo.js";
import { type CliResult, cli, TEST_NOW } from "./run-cli.js";

export const APP_FILES: Record<string, string> = {
  "apps/api/auth/session.ts": "export function createSession() {}\n",
  "apps/api/auth/refresh.ts": "export function refresh() {}\n",
  "apps/api/auth/password-reset.ts": "export function resetPassword() {}\n",
  "apps/api/auth/session.test.ts": "// session tests\n",
  "README.md": "# workspace\n",
};

/** A repository with application files and a committed `alethic init`. */
export async function initializedRepo(files = APP_FILES): Promise<FixtureRepo> {
  const repo = await createRepo();
  for (const [rel, content] of Object.entries(files)) repo.write(rel, content);
  await repo.commitAll("initial");
  const result = await cli(["init", "--name", "workspace"], { cwd: repo.root });
  if (result.code !== 0) throw new Error(`init failed: ${result.stderr}`);
  await repo.commitAll("Initialize Alethic");
  return repo;
}

/** CLI options for acting as `agent` at time `at`. */
export function as(repo: FixtureRepo, agent: string, at = TEST_NOW) {
  return { cwd: repo.root, env: { ALETHIC_AGENT: agent, ALETHIC_NOW: at } };
}

export function expectOk(result: CliResult): CliResult {
  expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
  return result;
}

export function readRecord(repo: FixtureRepo, file: string): Record<string, unknown> {
  const parsed = parseYaml(readFileSync(path.join(repo.root, file), "utf8"));
  expect(parsed.problems).toEqual([]);
  return parsed.data as Record<string, unknown>;
}

export async function expectValid(repo: FixtureRepo, at = TEST_NOW): Promise<void> {
  const result = await cli(["validate", "--json"], { cwd: repo.root, env: { ALETHIC_NOW: at } });
  expect(JSON.parse(result.stdout).findings).toEqual([]);
  expect(result.code).toBe(0);
}

export async function shortHead(repo: FixtureRepo): Promise<string> {
  return (await repo.run(["rev-parse", "--short", "HEAD"])).trim();
}
