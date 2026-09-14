# Aletheic briefing: task-invalidate-sessions-after-password-reset

> Compiled by `alethic resume` for Claude Code. Budget: about 1000 tokens, estimated as characters / 4. Every bullet cites its source; ⚠ marks claims that are unverified or may be stale.

## Goal
- After a password reset, every session and refresh token issued before the reset must stop working within one request, so a stolen session cannot outlive a reset. [task-invalidate-sessions-after-password-reset] ⚠ unverified
- Status: active; owner claude-code, lease until 2026-09-13T22:12:00Z. [task-invalidate-sessions-after-password-reset]

## Current repository state
- Branch feat/session-reset at <sha>, clean; 2 paths changed since <sha>. (commit <sha>)
- Latest checkpoint was written by claude-code at 2026-09-13T18:33:00Z on feat/session-reset at <sha>; HEAD is 1 commit ahead of it, with no code changes since. [cp-invalidate-sessions-after-password-reset-20260913t183300z]

## Relevant architecture and decisions
- Proposed: Rotate refresh tokens on every use. [dec-auth-token-rotation] ⚠ may be stale: apps/api/auth/refresh.ts changed 41 lines (+40/-1) since it was anchored ⚠ unverified
- Refresh tokens are cached in Redis for 15 minutes. [kn-refresh-tokens-are-cached-in-redis-for-15-minutes] ⚠ may be stale: apps/api/auth/refresh.ts changed 41 lines (+40/-1) since it was anchored ⚠ unverified
- Tell users that other devices were signed out. [dec-web-login-copy] ⚠ unverified
- Store token_version on users and reject tokens with an older version. [dec-auth-session-invalidation]
- Use the documented approach for admin override. [dec-auth-admin-override] ⚠ unverified
- Use the documented approach for email notice. [dec-auth-email-notice] ⚠ unverified
- 12 more: [dec-auth-device-list], [dec-auth-csrf-tokens], [dec-auth-cookie-flags], [dec-auth-migration-order], [dec-auth-error-messages], [dec-auth-audit-log], [dec-auth-rate-limit], [dec-auth-password-hashing], [dec-auth-refresh-cache], [dec-auth-token-format], [kn-the-auth-test-suite-resets-the-database-before-each-file], [kn-sessions-live-in-the-sessions-table-keyed-by-user]

## Files changed or likely relevant
- apps/api/auth/**: task scope [task-invalidate-sessions-after-password-reset]
- 2 more files: (commit <sha>)

## Verified behavior and checks run
- `pnpm test auth/refresh` passed at <sha> (code unchanged since). (receipt rcpt-pnpm-test-auth-refresh-20260913t183200z) ⚠ unverified
- `pnpm test auth` failed (exit 1) at <sha> (code unchanged since). (receipt rcpt-pnpm-test-auth-20260913t183100z) ⚠ unverified
- `pnpm lint` passed at <sha> (code has changed since). (receipt rcpt-pnpm-lint-20260913t180900z) ⚠ unverified
- `pnpm test auth` failed (exit 1) at <sha> (code has changed since). (receipt rcpt-pnpm-test-auth-20260913t180800z) ⚠ unverified

## Failed approaches
- Bump token_version inside the Redis cache entry: The cache entry is written before the version check [cp-invalidate-sessions-after-password-reset-20260913t183300z] ⚠ unverified
- Delete all session rows on reset: Refresh tokens are cached in Redis for 15 minutes [cp-invalidate-sessions-after-password-reset-20260913t181000z] ⚠ unverified
- Evict Redis keys with SCAN: Too slow on the production cache [cp-invalidate-sessions-after-password-reset-20260913t181000z] ⚠ unverified

## Open questions
- Does the mobile client retry refresh on 401? [cp-invalidate-sessions-after-password-reset-20260913t183300z]
- Should the audit log record the reset? [cp-invalidate-sessions-after-password-reset-20260913t183300z]

## Next safe action
- Invalidate the cached refresh entry when token_version changes, then rerun pnpm test auth. [cp-invalidate-sessions-after-password-reset-20260913t183300z]

---
Project instructions for Claude Code are in CLAUDE.md. Before stopping, run `alethic checkpoint create`. Before closing the task, run `alethic validate`. Never put secrets, customer data, or chat transcripts in records.
