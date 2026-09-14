# Threadline Specification — format v1

> Shared memory for coding agents, anchored to Git.
> Git versions code. Threadline versions the context needed to change it safely.

Status: draft for v0. This document is normative. The words MUST, MUST NOT, SHOULD, and MAY carry their usual RFC 2119 meaning. The JSON Schemas in [`schemas/`](../schemas) are the machine-readable form of the rules here. If this document and the schemas disagree, that is a bug, and the test suite is built to catch it (see [Appendix A](#appendix-a-machine-checked-examples)).

## 1. Problem

Coding agents such as Codex, Claude Code, and Gemini/Antigravity each work in isolated sessions with their own private memory. When work moves from one agent to another, or from Monday's session to Tuesday's, the next agent has to rebuild the context from code, `git log`, and whatever chat transcript it can find:

- what the work is for;
- what has already been decided, and why;
- which approaches were tried and failed;
- which tests actually ran, on which code;
- what is still unknown;
- what the next safe step is.

Today that context lives in chat history, which is private, huge, and vendor-specific, or in ad-hoc handoff Markdown, which is unstructured, unverifiable, and silently goes stale. Agents repeat investigations, contradict earlier decisions, and trust test results that no longer apply.

Threadline stores that context as small, typed, reviewable records inside the repository, versioned by Git alongside the code they describe.

## 2. Principles

1. **Git-native.** Shared state lives in the repository and moves through ordinary branches, commits, reviews, and merges. There is no server.
2. **Evidence over assertion.** Important records link to commits, files, checks, receipts, issues, PRs, or human confirmations. A claim with no evidence is labeled as such.
3. **Portable by default.** The format is plain YAML plus JSON Schema. It depends on no model, IDE, CLI, or vendor.
4. **Small context, not transcript dumps.** Agents receive a task-specific briefing within an approximate size budget, not the whole store.
5. **Human-readable and machine-validatable.** A developer can read and hand-edit every record without Threadline installed, and CI can validate them without a model.
6. **Private by design.** Raw transcripts, credentials, customer data, and model-private memories never enter committed state.

## 3. Non-goals (v0)

- Replacing Git, issue trackers, or ADR processes.
- Storing chat transcripts or reasoning traces, in full or in part.
- Orchestrating agents: scheduling, running, or supervising them, or executing commands on their behalf.
- Hosted accounts, billing, sync services, or a central database.
- Inferring "truth" from agent output automatically. Threadline records who claimed what, with what evidence, and at what trust level. It never upgrades a claim on its own.
- Semantic/embedding search. Retrieval is deterministic.

## 4. File layout

```text
.threadline/
  manifest.yaml          # project settings (§7)
  .gitignore             # ignores local/
  tasks/                 # task-*.yaml
  decisions/             # dec-*.yaml
  knowledge/             # kn-*.yaml
  checkpoints/           # cp-*.yaml    (append-only)
  receipts/              # rcpt-*.yaml  (append-only)
  local/                 # NOT committed: private scratch for one machine
```

Rules:

- One record per file. The file name MUST be `<id>.yaml`, in the directory for its kind. One file per record keeps merge conflicts rare and diffs readable.
- Files are UTF-8 YAML 1.2. Tools MUST NOT depend on YAML features beyond plain mappings, sequences, and scalars: no anchors, aliases, or custom tags.
- Commit ids and other hex strings SHOULD be quoted (`"83fa2de"`). An unquoted all-digit sha such as `1234567` parses as a number and fails validation.
- Nothing under `local/` is ever read by `resume`, rendered, or committed.

## 5. Record envelope

Every record (task, decision, knowledge, checkpoint, receipt) shares these fields:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | `<prefix>-<slug>`: lowercase letters, digits, and single hyphens, at most 120 chars. Prefixes: `task-`, `dec-`, `kn-`, `cp-`, `rcpt-`. |
| `kind` | yes | `task` \| `decision` \| `knowledge` \| `checkpoint` \| `receipt` |
| `schema_version` | yes | `1` |
| `summary` | yes | One line, at most 280 characters. Written for a busy reader. |
| `status` | yes | Lifecycle state. Allowed values depend on the kind (§6). |
| `confidence` | yes | Trust level (§8). |
| `created_by` | yes | `{agent, human?}`. `agent` is a lowercase tool name such as `codex`, `claude-code`, `gemini`, or `human`. |
| `created_at` | yes | UTC timestamp ending in `Z`. |
| `updated_at` | no | UTC timestamp of the last edit. |
| `valid_at` | no | Commit id the record was true at, for humans and ancestry hints (§9). |
| `anchor` | no | Content fingerprints used for staleness detection (§9). |
| `scope.paths` | no | Repository-relative paths or globs the record is about (§10). |
| `links` | no | Ids of related records. |
| `evidence` | no | `commits`, `files`, `checks`, `receipts`, `issues`, `prs`, `human` (§8). |
| `supersedes` | no | Ids of records this one replaces. |

Unknown fields are rejected, and extensions require a new `schema_version`. Checkpoint and receipt ids SHOULD end in a UTC timestamp (`-20260913t201500z`) so that parallel writers never collide.

A note on the brief's `status: verified`: in Threadline, *verification is a trust level*, not a lifecycle status. A decision is `status: accepted` with `confidence: human-confirmed`, for example.

## 6. Record kinds

### 6.1 Task

A unit of intended work: what it is for, who holds it, and what comes next.

- `status`: `proposed` → `active` → `paused` | `blocked` → `done` | `abandoned`
- `intent` (required): what should be true when the task is done, and why.
- `branch`: the branch where the work happens.
- `owner`: `{agent, claimed_at, lease_expires_at}`. It is required when `status: active` (see §12).
- `next_action`: the next concrete step.

<!-- threadline:schema=task -->
```yaml
id: task-session-reset-invalidation
kind: task
schema_version: 1
summary: Invalidate existing sessions when a user resets their password.
status: active
confidence: human-confirmed
created_by:
  agent: codex
  human: maintainer
created_at: "2026-09-13T18:02:00Z"
updated_at: "2026-09-13T20:15:00Z"
intent: >-
  After a password reset, every session and refresh token issued before the reset
  must stop working within one request, so a stolen session cannot outlive a reset.
branch: feat/session-reset
scope:
  paths:
    - apps/api/auth/**
    - apps/api/db/migrations/**
owner:
  agent: codex
  claimed_at: "2026-09-13T18:02:00Z"
  lease_expires_at: "2026-09-13T22:02:00Z"
next_action: Make refresh-token validation compare token_version.
evidence:
  issues:
    - "#412"
  human:
    - name: maintainer
      at: "2026-09-13T18:00:00Z"
      note: Scope agreed in issue #412.
```

### 6.2 Decision

A choice that later work must respect: what was chosen, why, and what was rejected.

- `status`: `proposed` | `accepted` | `superseded`
- `topic` (required): a stable dotted key for *what* is being decided, such as `auth.session-invalidation`. Two `accepted` decisions with the same topic and overlapping scope conflict unless one `supersedes` the other (§11).
- `chosen` (required), `rationale` (required), `alternatives`: `[{option, rejected_because}]`.

<!-- threadline:schema=decision -->
```yaml
id: dec-auth-session-rotation
kind: decision
schema_version: 1
summary: Rotate user sessions on password reset by bumping a per-user token version.
status: accepted
confidence: human-confirmed
topic: auth.session-invalidation
chosen: Store token_version on users, embed it in session and refresh tokens, and reject mismatches.
rationale: >-
  A single increment revokes every session and cached refresh token without scanning
  Redis, and it holds even while refresh tokens sit in the 15-minute cache.
alternatives:
  - option: Delete all session rows on reset.
    rejected_because: Cached refresh tokens in Redis stay valid for up to 15 minutes.
  - option: Scan and evict Redis keys per user.
    rejected_because: Keys are not indexed by user, and SCAN over the production cache is too slow.
created_by:
  agent: claude-code
  human: maintainer
created_at: "2026-09-13T21:10:00Z"
valid_at: "83fa2de"
scope:
  paths:
    - apps/api/auth/**
links:
  - task-session-reset-invalidation
  - kn-refresh-tokens-cached-in-redis
evidence:
  commits:
    - "83fa2de"
  checks:
    - pnpm test auth/session-reset
  receipts:
    - rcpt-auth-tests-20260913t200200z
  human:
    - name: maintainer
      at: "2026-09-13T21:12:00Z"
      note: Approved in PR review.
anchor:
  commit: "83fa2de5b0c4a1d2e3f40516273849506a7b8c9d"
  fingerprints:
    apps/api/auth/session.ts: "8f94139338f9404f26296befa88755fc2598c289"
    apps/api/auth/refresh.ts: "3b18e512dba79e4c8300dd08aeb37f8e728b8dad"
```

### 6.3 Knowledge

A durable architectural or operational fact that is useful beyond one task.

- `status`: `active` | `deprecated`
- `category` (required): `architecture` | `operations` | `convention` | `gotcha`
- `body` (required): the fact, with enough detail to act on.

<!-- threadline:schema=knowledge -->
```yaml
id: kn-refresh-tokens-cached-in-redis
kind: knowledge
schema_version: 1
summary: Refresh tokens are cached in Redis for 15 minutes, so database changes alone do not revoke them.
status: active
confidence: agent-reported
category: gotcha
body: >-
  apps/api/auth/refresh.ts reads refresh-token sessions from Redis (key auth:rt:<id>,
  TTL 900s) before falling back to Postgres. Revocation logic must also invalidate or
  outvote the cached entry.
created_by:
  agent: codex
created_at: "2026-09-13T20:05:00Z"
valid_at: "9c1e4b7"
scope:
  paths:
    - apps/api/auth/refresh.ts
    - apps/api/cache/**
evidence:
  files:
    - apps/api/auth/refresh.ts
  receipts:
    - rcpt-auth-tests-20260913t200200z
anchor:
  commit: "9c1e4b7d2f0a8e6b5c4d3e2f1a0b9c8d7e6f5a41"
  fingerprints:
    apps/api/auth/refresh.ts: "3b18e512dba79e4c8300dd08aeb37f8e728b8dad"
```

### 6.4 Checkpoint

A compact, append-only handoff snapshot for unfinished work. A checkpoint is written for the *next* agent, and it MUST let them continue without the original chat.

- `status`: always `recorded`. A checkpoint is never edited after it is committed; newer checkpoints replace it.
- `task` (required): the task id.
- `git` (required): `{branch?, base?, head, dirty, changed_paths?}`. `head` and `dirty` are required, so a checkpoint without a Git reference is invalid.
  - `base`: merge-base with the default branch.
  - `dirty`: whether the working tree had uncommitted changes, including untracked files, **outside `.threadline/`**. Writing Threadline records never makes the code state dirty.
  - `changed_paths`: paths changed since `base`, including uncommitted changes when `dirty: true`.
- `done`: what is finished.
- `failed_approaches`: `[{approach, why_failed, evidence?}]`. This is the field most often missing from handoffs, and one of the most valuable.
- `open_questions`: unknowns the next agent must not guess at.
- `next_safe_action` (required): one concrete step that is safe to take without further context. An agent that must stop without knowing the next step still checkpoints: `threadline checkpoint create` falls back to the task's `next_action`, then to `Not determined: review open_questions and failed_approaches before acting.`
- `receipts`: verification receipts covering this state.

<!-- threadline:schema=checkpoint -->
```yaml
id: cp-session-reset-20260913t201500z
kind: checkpoint
schema_version: 1
summary: Session invalidation half done; token-version approach in progress, refresh-path test still red.
status: recorded
confidence: agent-reported
created_by:
  agent: codex
created_at: "2026-09-13T20:15:00Z"
valid_at: "9c1e4b7"
task: task-session-reset-invalidation
scope:
  paths:
    - apps/api/auth/**
git:
  branch: feat/session-reset
  base: "5d2a9f0"
  head: "9c1e4b7"
  dirty: true
  changed_paths:
    - apps/api/auth/password-reset.ts
    - apps/api/auth/session.ts
    - apps/api/auth/session.test.ts
    - apps/api/db/migrations/0042_token_version.sql
done:
  - Added users.token_version column (migration 0042).
  - Password reset increments token_version.
failed_approaches:
  - approach: Delete all session rows on reset.
    why_failed: Refresh tokens are cached in Redis for 15 minutes, so deleted sessions kept working.
    evidence:
      receipts:
        - rcpt-auth-tests-20260913t200200z
open_questions:
  - Should API keys issued before the reset also be revoked?
next_safe_action: Make refresh-token validation in apps/api/auth/refresh.ts compare token_version, then rerun pnpm test auth.
receipts:
  - rcpt-auth-tests-20260913t200200z
links:
  - kn-refresh-tokens-cached-in-redis
```

### 6.5 Receipt

The recorded result of a test, build, lint, or other check, tied to the code state it ran on. Threadline **records** receipts. It does not run commands.

- `status`: always `recorded`. Receipts are append-only.
- `command` (required), `exit_code` (required), `result` (required): `pass` (exit code MUST be 0) | `fail` (exit code MUST NOT be 0) | `error` (the check could not run properly).
- `ran_at` (required), `duration_ms`.
- `git` (required): `{branch?, head, dirty}`. `dirty` means the same as in a checkpoint: uncommitted changes outside `.threadline/`.
- `output_tail`: at most 4,000 characters from the end of the output, redacted (§13) before writing.
- `provenance`: `{source: local | ci-env | github-attestation, run_url?, attestation?}`.

<!-- threadline:schema=receipt -->
```yaml
id: rcpt-auth-tests-20260913t200200z
kind: receipt
schema_version: 1
summary: Auth suite fails after deleting session rows; refresh token still accepted.
status: recorded
confidence: agent-reported
created_by:
  agent: codex
created_at: "2026-09-13T20:02:30Z"
valid_at: "9c1e4b7"
command: pnpm test auth
exit_code: 1
result: fail
ran_at: "2026-09-13T20:01:10Z"
duration_ms: 79400
git:
  branch: feat/session-reset
  head: "9c1e4b7"
  dirty: true
output_tail: |
  FAIL apps/api/auth/session.test.ts > refresh token rejected after reset
    expected 401, received 200
  Tests: 1 failed, 38 passed, 39 total
provenance:
  source: local
scope:
  paths:
    - apps/api/auth/**
```

## 7. Manifest

`.threadline/manifest.yaml` holds project-wide settings. Every section except `format_version` and `project` is optional, and the defaults are shown below.

<!-- threadline:schema=manifest -->
```yaml
format_version: 1
project:
  name: acme-api
defaults:
  budget: 2500              # approximate briefing size for resume (§14)
  lease_minutes: 240        # task ownership lease length (§12)
  default_branch: main
privacy:
  extra_secret_patterns:    # JavaScript regexes, added to the built-in set (§13)
    - "acme_live_[A-Za-z0-9]{24}"
  forbidden_globs:          # paths records must never cite or fingerprint
    - "**/*.env"
staleness:
  changed_lines_threshold: 20
limits:
  max_glob_matches: 2000
  max_fingerprints_per_record: 50
trust:
  ci_provenance: none       # none | github-attestation (§8)
```

## 8. Provenance and trust levels

Every record carries exactly one `confidence`. From lowest to highest trust: `inferred` < `agent-reported` = `ci-reported` < `human-confirmed` < `ci-verified`.

| Level | Meaning | Who may assign it |
|---|---|---|
| `inferred` | Derived by reading code or history; nobody observed it directly. | Anyone. |
| `agent-reported` | An agent observed or did it in its own session. | Any agent. This is the default for agent writes. |
| `ci-reported` | A self-report made from a CI environment (`CI=true`, clean tree). It carries **the same weight as `agent-reported`**: any local process can set `CI=true`, so the label records where a claim was made, not that anyone checked it. | Tooling, automatically. Receipts also record `provenance.source: ci-env`. |
| `human-confirmed` | A named human confirmed it. | Only with a non-empty `evidence.human` entry (enforced by schema). Tools set it only when passed `--human <name>`. |
| `ci-verified` | Backed by CI provenance that can be checked cryptographically. | Only when `manifest.trust.ci_provenance` names a trusted source **and** the cited receipt's `provenance` verifies against it. |

Rules:

1. Trust levels are hard to forge by design. Tools MUST NOT grant `ci-verified` based on environment variables, file paths, agent names, or anything else a local process controls. For the same reason, tools that sort, score, or filter by trust MUST NOT rank `ci-reported` above `agent-reported`.
2. In format v1, `validate` MUST reject `ci-verified` when `trust.ci_provenance` is `none` or absent. The attestation verifier for `github-attestation` is on the roadmap; until it ships, `ci-verified` cannot be produced.
3. No tool upgrades confidence on its own. Upgrades happen through an explicit action such as `threadline verify <id> --human <name>`, and that action is visible in the Git diff.
4. Briefings (§14) treat only `human-confirmed` and `ci-verified` as verified. Everything else is shown with an *unverified* marker.
5. When evidence commits disappear (squash merge, rebase, shallow clone), the record keeps its confidence, and validators report a warning, not an error (§9). Durable evidence such as PRs, issues, and receipts is preferred over branch-local commit ids.

## 9. Anchoring and staleness

A record describes code at a moment in time. When that code changes, the record may no longer apply.

**`valid_at`** is the commit the author considered the record true at. It exists for humans and as a hint. Commit ancestry is unreliable after squash merges, rebases, branch deletion, and shallow clones, so ancestry alone MUST NOT mark a record stale or broken.

Commit ids MAY be abbreviated. Tools MUST resolve them with Git before comparing them and MUST NOT compare ids as strings: `83fa2de` and its full 40-character id are the same commit.

**`anchor`** is the basis for staleness. When a record is written, tools capture Git blob ids for its `evidence.files` and for tracked files matched by `scope.paths` (subject to the limits in §10):

```yaml
anchor:
  commit: "<full sha of HEAD when written>"
  fingerprints:
    apps/api/auth/session.ts: "<blob id>"
  overflow:              # present only when more files matched than the limit
    count: 212
    digest: "<object id summarizing the remaining matched files>"
```

The derived status is computed at read time and never written into the record automatically:

| Derived status | Condition |
|---|---|
| `fresh` | Every fingerprint matches the current tree. |
| `needs_reverification` | A fingerprinted file's content changed by more than `staleness.changed_lines_threshold` lines, or files were added to or removed from the scope. |
| `broken_evidence` | A cited `evidence.files` path no longer exists. |
| `diverged` | The anchor commit exists and is not an ancestor of `HEAD`, **and** fingerprints differ. The record describes code from another line of history that does not match this one. |

**Direct and context files.** A fingerprinted file is *direct* when it is listed in `evidence.files` or named exactly in `scope.paths`. Other fingerprinted files are *context*: they were matched only by a glob or a directory. When a record has any direct files, changes to context files are reported as notes and do not change the derived status. The same applies to files added under a glob and to changes summarized in `overflow`. This keeps a broad scope such as `apps/api/auth/**` from flagging a claim on every edit nearby. A record anchored only by globs has no direct files, so every matched file counts for it.

An anchor commit that is missing, or not an ancestor, while the fingerprints still match is reported only as an informational note ("anchor commit unavailable"). This is why a record created on a feature branch stays `fresh` after that branch is squash-merged and deleted.

A record is re-anchored only by an explicit action (`threadline verify`), and that action shows up as a diff.

## 10. Path safety

Every path in `scope.paths`, `evidence.files`, `git.changed_paths`, `anchor.fingerprints`, and `privacy.forbidden_globs`:

- MUST be repository-relative and use POSIX `/` separators;
- MUST NOT be absolute (`/etc/passwd`), start with `~`, contain a drive letter (`C:`), backslashes, empty segments (`a//b`), `.` or `..` segments, or NUL bytes;
- MUST NOT resolve, after following symlinks, to a location outside the repository root;
- MUST NOT match `privacy.forbidden_globs`.

Globs use `*`, `**`, `?`, `[...]`, and `{a,b}`. They are expanded **only against tracked files** (`git ls-files`), never by walking the filesystem, so ignored directories such as `node_modules` are never visited. Expansion stops after `limits.max_glob_matches` files, with a warning.

Each record fingerprints at most `limits.max_fingerprints_per_record` files: cited `evidence.files` first, then scope matches, each group in sorted path order, so the result is deterministic. Any remaining matched files are summarized in `anchor.overflow`. Write commands accept `--max-fingerprints N` to override the limit for a single record.

## 11. Merge behavior and conflicts

Threadline relies on Git to merge records and adds checks for the conflicts Git cannot see.

| Situation | What happens |
|---|---|
| Two branches add different records | Merges cleanly, because each record is its own file. |
| Two branches edit the same task or decision | An ordinary Git conflict, resolved by a human in review. |
| Two branches create the same id | A Git add/add conflict. Timestamped ids make this unlikely for checkpoints and receipts. |
| Checkpoints and receipts | Append-only. `validate` rejects a committed checkpoint or receipt whose content differs from the version first committed. |
| Two `accepted` decisions with the same `topic` and overlapping scope, neither superseding the other | A **contradiction**, reported by `validate` (warning) and `doctor`. |
| Two `active` tasks with unexpired leases held by different agents over overlapping paths | An **overlapping claim**, reported by `doctor`. |
| A checkpoint whose task is `done` or `abandoned` | Reported by `doctor` as orphaned work. |

Resolving a contradiction means writing a new decision that `supersedes` the loser, or setting the loser to `status: superseded`.

## 12. Task ownership leases

An `active` task has an `owner` with a lease, which signals to other agents that someone is working on it.

- `threadline task start` and `threadline task claim` set `lease_expires_at = now + defaults.lease_minutes`.
- Claiming a task whose lease is held by another agent and has not expired fails without `--force`. Renewing your own lease always succeeds.
- An `active` task whose lease has expired is **invalid**: `validate` rejects it. An agent that stops work MUST either hand off (write a checkpoint and set `status: paused`) or renew. This keeps abandoned claims from blocking other agents.
- Leases are advisory coordination, not locks. Git remains the source of truth.

## 13. Privacy boundary

Committed Threadline state is **shared, reviewable, and permanent**: once pushed, assume it is public to everyone with repository access, forever.

MUST NOT appear in any record:

- chat transcripts, prompts, model reasoning, or excerpts of them;
- credentials of any kind: API keys, tokens, passwords, private keys, connection strings with credentials, cookies;
- customer or personal data: emails, names of end users, addresses, payment data, production records;
- model- or vendor-private memory content;
- content from paths matching `privacy.forbidden_globs`.

Enforcement:

- Write commands scan every string field and refuse to write anything that matches a secret pattern. `validate` runs the same scan and rejects matching records.
- The built-in patterns cover PEM private-key blocks; AWS access key ids; Google API keys; GitHub, GitLab, Slack, Stripe, OpenAI, and Anthropic token formats; JWTs; URLs with embedded credentials; and assignments shaped like `password|passwd|secret|token|api[_-]?key` followed by `:` or `=` and a non-placeholder value. Projects add their own patterns with `privacy.extra_secret_patterns`.
- `receipt.output_tail` is redacted before writing, with matches replaced by `[REDACTED]`.
- Scanning is a safety net, not a guarantee. Review `.threadline/` diffs like any other code.

`.threadline/local/` is gitignored for per-machine scratch. Tools never read it into shared outputs.

## 14. Context briefings

`threadline resume` compiles a briefing for the next agent from records and the current Git state:

1. **Goal**
2. **Current repository state**: branch, HEAD, dirty, and changes since base
3. **Relevant architecture and decisions**
4. **Files changed or likely relevant**
5. **Verified behavior and checks run**
6. **Failed approaches**
7. **Open questions**
8. **Next safe action**

Rules:

- **Deterministic.** The same records and Git state always produce byte-identical output. Retrieval uses task ids, explicit links, path overlap, topic, trust level, recency, and Git state, never embeddings.
- **Traceable.** Every bullet cites its source: a record id (`[dec-auth-session-rotation]`), a commit (`(commit 83fa2de)`), or a receipt.
- **Honest.** Claims that are not `human-confirmed` or `ci-verified` are marked *unverified*. Records whose derived status is not `fresh` are marked *may be stale*.
- **Budgeted, approximately.** `--budget` is an **approximate** size target, estimated as `ceil(characters / 4)` tokens. Real tokenizer counts vary by model, so the budget is not a guarantee. Goal, repository state, and next safe action are always included. When space runs out, lower-priority items collapse to one-line summaries, then to "N more: ids…" pointers.
- The `--target` agent changes only framing hints, such as which instruction file or MCP tools exist, never the content.

## 15. Agent compatibility

The format is agent-neutral. Integrations are thin:

- **Instruction files.** `threadline render` maintains a marked block (`<!-- threadline:begin -->` … `<!-- threadline:end -->`) in `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`. The block tells the agent to run `threadline resume` before non-trivial work, write checkpoints only at meaningful boundaries, record receipts with `threadline receipt add`, never store private content (§13), and run `threadline validate` before closing work. Content outside the block is never touched. Agents do not share one instruction file by default: Codex reads `AGENTS.md`, Claude Code reads `CLAUDE.md`, and Gemini CLI reads `GEMINI.md` unless configured otherwise. A `CLAUDE.md` or `GEMINI.md` that imports `@AGENTS.md` can share the `AGENTS.md` block, and `render` detects that instead of writing a second copy.
- **MCP.** `threadline mcp` exposes the same operations as MCP tools and resources for agents that support MCP. Tools run the same command code as the CLI, including schema validation, path safety, and the secret scan. No MCP tool can mark a record `human-confirmed`: human confirmation goes through the CLI with `--human`.
- **CLI.** Every agent that can run shell commands can use the CLI directly. Identity comes from `--agent` or `THREADLINE_AGENT`.

Per-agent setup (exact config files and commands) lives in `docs/adapters/`, where it is checked against each vendor's current documentation.

## 16. Validation summary

`threadline validate` exits 0 when state is valid, 1 on errors, and 2 on usage or environment problems. It MUST report errors for:

- schema violations, mapped to `file: field` with a fix hint;
- a file name that does not match its id, a record in the wrong directory, or duplicate ids;
- dangling references in `links`, `task`, `receipts`, `evidence.receipts`, or `supersedes`;
- `evidence.files` that do not exist in the working tree;
- evidence commits that do not exist (reported as a warning in shallow clones and after history rewrites, and as an error with `--strict`);
- secret-like content (§13);
- unsafe paths (§10);
- `active` tasks with expired leases (§12);
- checkpoints without `git.head` (enforced by schema);
- `ci-verified` confidence without trusted provenance (§8);
- changes to committed checkpoints or receipts (§11);
- invalid regexes in `privacy.extra_secret_patterns`.

It reports warnings for derived staleness (§9) and contradictory decisions (§11).

## 17. Walkthroughs

### 17.1 Fresh task

```console
$ threadline init
Created .threadline/ (manifest, tasks, decisions, knowledge, checkpoints, receipts, local/)

$ THREADLINE_AGENT=codex threadline task start "Invalidate sessions after password reset" \
    --paths 'apps/api/auth/**' --branch feat/session-reset
Created .threadline/tasks/task-invalidate-sessions-after-password-reset.yaml (active, lease until 22:02Z)

$ git add .threadline && git commit -m "threadline: start session reset task"
```

Codex works and runs the auth tests, which fail. It records the result without Threadline running anything:

```console
$ pnpm test auth > /tmp/auth.log; echo $?
1
$ threadline receipt add --command "pnpm test auth" --exit-code 1 --output-file /tmp/auth.log
Created .threadline/receipts/rcpt-pnpm-test-auth-20260913t200200z.yaml (fail, agent-reported)
```

### 17.2 Agent handoff

Codex has to stop. It writes a checkpoint at this boundary:

```console
$ threadline checkpoint create \
    --done "Added users.token_version (migration 0042)" \
    --failed "Delete all session rows on reset::Refresh tokens are cached in Redis for 15 minutes" \
    --question "Should API keys issued before the reset also be revoked?" \
    --next "Make refresh-token validation compare token_version, then rerun pnpm test auth"
Created .threadline/checkpoints/cp-invalidate-sessions-after-password-reset-20260913t201500z.yaml
  git: feat/session-reset @ 9c1e4b7 (dirty), 4 changed paths, 1 receipt attached

$ threadline task update task-invalidate-sessions-after-password-reset --status paused
$ git add -A && git commit -m "wip: token version; threadline checkpoint" && git push
```

Claude Code picks the work up in a fresh session with no chat history:

```console
$ git pull && THREADLINE_AGENT=claude-code threadline task claim task-invalidate-sessions-after-password-reset
Claimed (lease until 01:30Z)

$ threadline resume --target claude-code --budget 2500
## Goal
After a password reset, every session and refresh token issued before it must stop working. [task-invalidate-sessions-after-password-reset] ⚠ unverified
## Failed approaches
- Deleting all session rows on reset: refresh tokens are cached in Redis for 15 minutes. [cp-…-20260913t201500z] (receipt rcpt-pnpm-test-auth-20260913t200200z)
## Next safe action
Make refresh-token validation compare token_version, then rerun pnpm test auth. [cp-…-20260913t201500z]
...
```

Claude does not repeat the failed approach. It records a decision, and the maintainer confirms it in PR review with `threadline verify dec-auth-session-rotation --human maintainer`.

### 17.3 Stale-memory detection

Weeks later, someone rewrites `apps/api/auth/refresh.ts` to use opaque tokens stored in Postgres, and the Redis cache goes away. Neither the decision nor the knowledge record is edited. An agent on a new task touching `apps/api/auth/**` runs:

```console
$ threadline resume --budget 1000
## Relevant architecture and decisions
- Rotate sessions on reset via per-user token_version. [dec-auth-session-rotation] ⚠ may be stale: apps/api/auth/refresh.ts changed 184 lines since anchor
- Refresh tokens cached in Redis for 15 minutes. [kn-refresh-tokens-cached-in-redis] ⚠ may be stale
...

$ threadline doctor
warning  kn-refresh-tokens-cached-in-redis  needs_reverification (apps/api/auth/refresh.ts: +120/-64)
         fix: confirm the fact still holds, then `threadline verify kn-refresh-tokens-cached-in-redis`,
              or mark it deprecated: `threadline knowledge update kn-refresh-tokens-cached-in-redis --status deprecated`
```

The agent is warned before it builds on a fact that no longer holds.

## 18. Creating a checkpoint by hand

You do not need the CLI to write a valid checkpoint.

1. Collect the Git state:
   ```console
   git rev-parse --abbrev-ref HEAD                    # branch
   git merge-base main HEAD | cut -c1-7               # base
   git rev-parse --short HEAD                         # head
   git status --porcelain | head -1                   # any output means dirty: true
   git diff --name-only $(git merge-base main HEAD)   # changed_paths (includes uncommitted edits)
   ```
2. Create `.threadline/checkpoints/cp-<task-slug>-<yyyymmdd>t<hhmmss>z.yaml`. The `id` MUST match the file name.
3. Fill in the required fields: `id`, `kind: checkpoint`, `schema_version: 1`, `summary`, `status: recorded`, `confidence` (use `agent-reported`, or `inferred` when reconstructing from history), `created_by.agent` (`human` if you are writing it yourself), `created_at` (UTC, ending in `Z`), `task`, `git.head`, `git.dirty`, and `next_safe_action`. Quote shas.
4. Add whatever else helps the next person: `done`, `failed_approaches`, `open_questions`, `receipts`. Leave out anything private (§13).
5. Validate with `threadline validate`, or without Threadline by converting the YAML to JSON and checking it against `schemas/checkpoint.schema.json` with any JSON Schema 2020-12 validator (register `schemas/common.schema.json` too).
6. Commit it.

Use the example in §6.4 as a template. For contrast, this is **invalid**: it has no `git.head`, and its changed path is absolute.

<!-- threadline:schema=checkpoint expect=invalid -->
```yaml
id: cp-bad-example-20260913t000000z
kind: checkpoint
schema_version: 1
summary: Missing git.head and uses an absolute path.
status: recorded
confidence: agent-reported
created_by:
  agent: human
created_at: "2026-09-13T00:00:00Z"
task: task-session-reset-invalidation
git:
  branch: main
  dirty: false
  changed_paths:
    - /etc/passwd
next_safe_action: Nothing.
```

And this decision is invalid because it claims `human-confirmed` without naming a human:

<!-- threadline:schema=decision expect=invalid -->
```yaml
id: dec-unbacked-claim
kind: decision
schema_version: 1
summary: Claims human confirmation with no human evidence.
status: accepted
confidence: human-confirmed
topic: auth.session-invalidation
chosen: Anything.
rationale: None given.
created_by:
  agent: codex
created_at: "2026-09-13T00:00:00Z"
```

## Appendix A: machine-checked examples

YAML examples in this document and in `docs/adapters/*.md` are validated by the test suite (`test/spec/spec-examples.test.ts`). The convention is strict so that any tool extracts the same examples:

- An example is checked **only** if the line directly before its opening fence is exactly `<!-- threadline:schema=<name> -->` or `<!-- threadline:schema=<name> expect=invalid -->`, where `<name>` is one of `manifest`, `task`, `decision`, `knowledge`, `checkpoint`, `receipt`.
- The marker MUST start at column 0, with exactly one space inside each comment delimiter.
- The next line MUST be exactly three backticks followed by `yaml`, with no blank line between marker and fence. The block ends at the next line consisting of exactly three backticks.
- Untagged YAML blocks are illustrative and ignored.
- Markers inside other code fences are ignored.
- Any comment line starting with `<!--` and containing `threadline:schema` that does not match the exact form, a marker not followed by a yaml fence, or an unknown schema name fails the test.
- A block marked `expect=invalid` MUST fail schema validation. All other tagged blocks MUST pass.
