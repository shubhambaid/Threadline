import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";
import { parseYaml } from "../../src/core/format.js";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const TASK = "task-invalidate-sessions-after-password-reset";

let bin: string;

beforeAll(async () => {
  // Build fresh so the demo exercises this checkout, never a stale dist/. The output goes under
  // node_modules/ so the bundle's runtime dependencies (commander, yaml, ajv) still resolve.
  const cache = path.join(ROOT, "node_modules/.cache");
  mkdirSync(cache, { recursive: true });
  const out = mkdtempSync(path.join(cache, "alethic-demo-build-"));
  await run(path.join(ROOT, "node_modules/.bin/tsup"), ["--out-dir", out], { cwd: ROOT });
  bin = `node ${path.join(out, "cli.js")}`;
  return () => rmSync(out, { recursive: true, force: true });
}, 120_000);

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing "${start}"`).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  return text.slice(from, to < 0 ? undefined : to);
}

it("runs examples/demo/run-demo.sh end to end", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "alethic-demo-"));
  const script = path.join(ROOT, "examples/demo/run-demo.sh");
  const { stdout } = await run("bash", [script, work], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ALETHIC_BIN: bin },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  }).catch((error: { stdout?: string; stderr?: string; message: string }) => {
    throw new Error(
      `${error.message}\n--- stdout (tail) ---\n${(error.stdout ?? "").slice(-3000)}\n--- stderr ---\n${error.stderr ?? ""}`,
    );
  });

  const codex = between(stdout, "== Codex starts", "== Claude Code resumes");
  expect(codex).toMatch(/ {2}pass 3\n {2}fail 1\n {2}exit 1\n/);

  // Claude Code's only context is the briefing compiled from Codex's records.
  const claude = between(stdout, "== Claude Code resumes", "== Gemini resumes");
  expect(claude).toContain(`# Aletheic briefing: ${TASK}`);
  expect(claude).toContain(
    "Delete session rows on reset. Failed because: refresh() reads the refresh cache first, so cached sessions keep working.",
  );
  expect(claude).toContain("Bump users.tokenVersion on reset and compare it in refresh()");
  expect(claude).toMatch(/`node --test` failed \(exit 1\)/);
  expect(claude).toContain(`Claimed ${TASK} for claude-code`);
  expect(claude).toMatch(/ {2}pass 2\n {2}fail 0\n {2}exit 0\n/);

  const gemini = between(stdout, "== Gemini resumes", "== What the repository now remembers");
  expect(gemini).toContain("[dec-auth-session-invalidation]");
  expect(gemini).toContain("Run the full test suite, then close the task");
  expect(gemini).toMatch(/ {2}pass 4\n {2}fail 0\n {2}exit 0\n/);

  const summary = between(stdout, "== What the repository now remembers", "Demo repository:");
  expect(summary).toMatch(/✓ \d+ records valid/);
  expect(summary).toContain("✓ No problems found");
  expect(summary).toContain("Aletheic task `task-invalidate-sessions-after-password-reset`: done");
  expect(summary).toContain("- Passed: `node --test` (exit 0)");
  for (const author of ["maintainer", "codex", "claude-code", "gemini"]) {
    expect(summary).toContain(` ${author}: `);
  }

  const receipts = path.join(work, "auth-service/.alethic/receipts");
  const agents = readdirSync(receipts)
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => parseYaml(readFileSync(path.join(receipts, file), "utf8")))
    .map((parsed) => (parsed.data as { created_by: { agent: string } }).created_by.agent)
    .sort();
  expect(agents).toEqual(["claude-code", "codex", "gemini"]);
}, 180_000);
