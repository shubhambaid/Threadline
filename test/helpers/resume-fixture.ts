import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FixtureRepo } from "./fixture-repo.js";
import { cli } from "./run-cli.js";
import { APP_FILES, as, expectOk, initializedRepo } from "./workspace.js";

export const RESUME_TASK = "task-invalidate-sessions-after-password-reset";
export const RESUME_INTENT =
  "After a password reset, every session and refresh token issued before the reset must stop working within one request, so a stolen session cannot outlive a reset.";
export const RESUME_NOW = "2026-09-13T21:00:00Z";
export const STALE_KNOWLEDGE = "kn-refresh-tokens-are-cached-in-redis-for-15-minutes";
export const LATEST_NEXT =
  "Invalidate the cached refresh entry when token_version changes, then rerun pnpm test auth";
export const LATEST_FAILED = "Bump token_version inside the Redis cache entry";

const TOPICS = [
  "token-format",
  "refresh-cache",
  "password-hashing",
  "rate-limit",
  "audit-log",
  "error-messages",
  "migration-order",
  "cookie-flags",
  "csrf-tokens",
  "device-list",
  "email-notice",
  "admin-override",
];

const SENTENCES = [
  "keeps revocation to a single write per user",
  "avoids scanning shared caches in production",
  "stays testable with the in-memory store the auth suite already uses",
  "composes with the existing session middleware without new dependencies",
  "lets operators reason about it from the users table alone",
  "only needs the migration reverted to roll back",
];

function paragraph(subject: string, sentences: number): string {
  return SENTENCES.slice(0, sentences)
    .map((text) => `The ${subject} approach ${text}.`)
    .join(" ");
}

const START = Date.parse("2026-09-13T18:00:00Z");

/**
 * A realistic handoff with about 30 records: two agents, two checkpoints, a dozen in-scope
 * decisions, unrelated/superseded/deprecated records that must be left out, one explicitly
 * linked out-of-scope decision, and one fact made stale by a later rewrite.
 * Large enough that 1000 and 2500 token budgets must compress it.
 */
export async function buildResumeFixture(): Promise<FixtureRepo> {
  const repo = await initializedRepo({
    ...APP_FILES,
    "apps/api/cache/redis.ts": "export const ttlSeconds = 900;\n",
    "apps/web/login.tsx": "export const Login = () => null;\n",
    "apps/api/billing/invoice.ts": "export const round = (n: number) => n;\n",
  });
  const logs = mkdtempSync(path.join(tmpdir(), "threadline-resume-logs-"));
  let minute = 0;
  const run = async (agent: string, args: string[]) => {
    minute += 1;
    const at = new Date(START + minute * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    return expectOk(await cli(args, as(repo, agent, at)));
  };
  const log = (name: string, text: string) => {
    const file = path.join(logs, name);
    writeFileSync(file, text);
    return file;
  };

  await repo.run(["checkout", "-q", "-b", "feat/session-reset"]);
  await run("codex", [
    "task",
    "start",
    RESUME_INTENT,
    "--summary",
    "Invalidate sessions after password reset",
    "--paths",
    "apps/api/auth/**",
    "--next",
    "Add token_version to users",
  ]);

  // Early records about refresh.ts; a later rewrite makes the fact stale.
  await run("codex", [
    "knowledge",
    "add",
    "--category",
    "gotcha",
    "--summary",
    "Refresh tokens are cached in Redis for 15 minutes",
    "--body",
    "apps/api/auth/refresh.ts reads refresh sessions from Redis (key auth:rt:<id>, TTL 900s) before falling back to Postgres, so revocation must also outvote the cached entry.",
    "--evidence-file",
    "apps/api/auth/refresh.ts",
    "--paths",
    "apps/api/auth/refresh.ts",
  ]);
  await run("codex", [
    "knowledge",
    "add",
    "--category",
    "architecture",
    "--summary",
    "Sessions live in the sessions table keyed by user",
    "--body",
    paragraph("session table", 3),
    "--paths",
    "apps/api/auth/session.ts",
  ]);
  await run("codex", [
    "knowledge",
    "add",
    "--category",
    "operations",
    "--summary",
    "The auth test suite resets the database before each file",
    "--body",
    paragraph("test database", 2),
    "--paths",
    "apps/api/auth/session.test.ts",
  ]);
  await run("codex", [
    "knowledge",
    "add",
    "--category",
    "convention",
    "--summary",
    "Old convention",
    "--body",
    "No longer applies.",
    "--paths",
    "apps/api/auth/**",
  ]);
  await run("codex", ["knowledge", "update", "kn-old-convention", "--status", "deprecated"]);
  await run("codex", [
    "knowledge",
    "add",
    "--category",
    "gotcha",
    "--summary",
    "Invoices round at the edge",
    "--body",
    "Billing only.",
    "--paths",
    "apps/api/billing/**",
  ]);

  // Codex works, records evidence, and checkpoints.
  repo.write(
    "apps/api/auth/password-reset.ts",
    "export function resetPassword(user: { token_version: number }) {\n  user.token_version += 1;\n}\n",
  );
  await repo.commitAll("wip: bump token_version on reset");
  await run("codex", [
    "receipt",
    "add",
    "--command",
    "pnpm test auth",
    "--exit-code",
    "1",
    "--output-file",
    log(
      "codex.log",
      "FAIL apps/api/auth/session.test.ts > refresh token rejected after reset\n  expected 401, received 200\nTests: 1 failed, 38 passed",
    ),
  ]);
  await run("codex", ["receipt", "add", "--command", "pnpm lint", "--exit-code", "0"]);
  await run("codex", [
    "checkpoint",
    "create",
    "--done",
    "Password reset increments token_version",
    "--failed",
    "Delete all session rows on reset::Refresh tokens are cached in Redis for 15 minutes",
    "--failed",
    "Evict Redis keys with SCAN::Too slow on the production cache",
    "--question",
    "Should API keys issued before the reset be revoked?",
    "--next",
    "Make refresh.ts compare token_version",
  ]);
  await run("codex", ["task", "update", RESUME_TASK, "--status", "paused"]);
  await repo.commitAll("threadline: codex checkpoint");

  // Claude Code takes over and rewrites refresh.ts.
  await run("claude-code", ["task", "claim", RESUME_TASK]);
  await run("claude-code", [
    "decision",
    "add",
    "--topic",
    "auth.token-rotation",
    "--status",
    "proposed",
    "--chosen",
    "Rotate refresh tokens on every use",
    "--rationale",
    paragraph("rotation", 3),
    "--paths",
    "apps/api/auth/refresh.ts",
  ]);
  repo.write(
    "apps/api/auth/refresh.ts",
    `${Array.from({ length: 40 }, (_, i) => `export const refreshStep${i} = ${i};`).join("\n")}\n`,
  );
  await repo.commitAll("feat: compare token_version on refresh");

  await run("claude-code", [
    "decision",
    "add",
    "--topic",
    "auth.session-invalidation",
    "--chosen",
    "Store token_version on users and reject tokens with an older version",
    "--rationale",
    paragraph("token version", 6),
    "--alternative",
    "Delete all session rows on reset::Cached refresh tokens stay valid for 15 minutes",
    "--alternative",
    "Scan and evict Redis keys per user::Keys are not indexed by user",
    "--paths",
    "apps/api/auth/**",
    "--human",
    "maintainer",
  ]);
  for (const topic of TOPICS) {
    await run("claude-code", [
      "decision",
      "add",
      "--topic",
      `auth.${topic}`,
      "--chosen",
      `Use the documented approach for ${topic.replace(/-/g, " ")}`,
      "--rationale",
      paragraph(topic.replace(/-/g, " "), 6),
      "--alternative",
      `Custom ${topic.replace(/-/g, " ")} handling::More code to maintain and test`,
      "--paths",
      "apps/api/auth/**",
    ]);
  }
  await run("claude-code", [
    "decision",
    "add",
    "--topic",
    "auth.old-approach",
    "--chosen",
    "Delete session rows on reset",
    "--rationale",
    "Simplest possible change.",
    "--paths",
    "apps/api/auth/**",
  ]);
  await run("claude-code", [
    "decision",
    "update",
    "dec-auth-old-approach",
    "--status",
    "superseded",
  ]);
  await run("claude-code", [
    "decision",
    "add",
    "--topic",
    "billing.rounding",
    "--chosen",
    "Round invoices half-even",
    "--rationale",
    "Matches the accounting system.",
    "--paths",
    "apps/api/billing/**",
  ]);
  await run("gemini", [
    "decision",
    "add",
    "--topic",
    "web.login-copy",
    "--chosen",
    "Tell users that other devices were signed out",
    "--rationale",
    "Users should know why they must sign in again.",
    "--paths",
    "apps/web/**",
  ]);

  await run("claude-code", [
    "receipt",
    "add",
    "--command",
    "pnpm test auth",
    "--exit-code",
    "1",
    "--output-file",
    log(
      "claude.log",
      "FAIL apps/api/auth/refresh.test.ts > cached token after reset\n  expected 401, received 200",
    ),
  ]);
  await run("claude-code", [
    "receipt",
    "add",
    "--command",
    "pnpm test auth/refresh",
    "--exit-code",
    "0",
  ]);
  await run("claude-code", [
    "checkpoint",
    "create",
    "--done",
    "refresh.ts compares token_version",
    "--failed",
    `${LATEST_FAILED}::The cache entry is written before the version check`,
    "--question",
    "Does the mobile client retry refresh on 401?",
    "--question",
    "Should the audit log record the reset?",
    "--next",
    LATEST_NEXT,
    "--link",
    "dec-web-login-copy",
  ]);
  await repo.commitAll("threadline: claude checkpoint");
  return repo;
}
