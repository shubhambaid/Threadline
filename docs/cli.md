# Threadline CLI

The command is `threadline` (package `@threadline/cli`). Every command works without a model connection. The record format is defined in [spec.md](spec.md).

```console
threadline init [--name <name>]
threadline validate [--json] [--strict]
threadline status [--json]

threadline task start "<intent>" [--paths <globs...>] [--next <text>] [--human <name>]
threadline task claim <id> [--force]
threadline task update <id> [--status proposed|paused|blocked] [--next <text>]
threadline task close <id> [--status done|abandoned]

threadline decision add --topic <key> --chosen <text> --rationale <text> [--alternative "<option>::<reason>"]...
threadline decision update <id> --status proposed|accepted|superseded
threadline knowledge add --category <category> --body <text> [--summary <text>]
threadline knowledge update <id> --status active|deprecated
threadline receipt add --command "<cmd>" --exit-code <n> [--output-file <path>]

threadline checkpoint create [--task <id>] [--done <text>]... [--failed "<approach>::<why>"]... [--question <text>]... [--next <text>]
threadline checkpoint list [--task <id>] [--json]
threadline checkpoint show <id> [--json]

threadline resume [--task <id>] [--target codex|claude-code|gemini|generic] [--budget <tokens>] [--format md|json]

threadline verify <id> [--human <name> [--note <text>]] [--receipt <id>]...
threadline doctor [--fix] [--strict] [--json]

threadline render agents-md|claude-md|gemini-md [--write | --check]
threadline render pr-summary [--task <id>]
threadline mcp
```

Global options:

| Option | Meaning |
|---|---|
| `-C, --cwd <dir>` | Run as if started in `<dir>`, like `git -C`. |
| `-v, --version` | Print the version. |
| `-h, --help` | Show help for any command, e.g. `threadline checkpoint create --help`. |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. `validate` found no errors; warnings and info notes are allowed. |
| 1 | `validate` found at least one error, or `task close` refused because the task's records are invalid. |
| 2 | A usage or environment problem: unknown command, missing option, not a Git repository, Threadline not initialized, no agent identity, or a write refused because it would be invalid or leak a secret. |

## Writing records safely

Every command that writes a record:

- needs an agent identity from `--agent <name>` or `THREADLINE_AGENT`;
- validates the record against its schema and scans every field for secrets **before** writing. If anything fails, nothing is written, and secret values are never echoed;
- rejects unsafe paths (absolute, `..`, symlink escapes) and paths matching `privacy.forbidden_globs`;
- checks that referenced records (`--link`, `--receipt`, `--supersedes`, `--task`) exist and are the right kind;
- captures an `anchor`: Git blob ids of cited evidence files first, then files matched by `--paths`, up to `limits.max_fingerprints_per_record` (override with `--max-fingerprints <n>`);
- sets `confidence: agent-reported`, or `human-confirmed` only when `--human <name>` names the person;
- accepts `--json` to print `{ id, file, warnings, ... }`.

Repeatable options (`--done`, `--failed`, `--question`, `--alternative`, `--link`, `--receipt`, `--evidence-file`, `--commit`, `--check`, `--issue`, `--pr`, `--supersedes`) may be given more than once. `--paths` takes one or more values.

## `threadline init`

Creates `.threadline/` in the current Git repository:

```text
.threadline/
  manifest.yaml
  .gitignore            # ignores local/
  tasks/ decisions/ knowledge/ checkpoints/ receipts/   (each with .gitkeep)
  local/.gitkeep        # private scratch, never committed
```

- `--name <name>` sets `project.name`. The default is the repository directory name.
- `defaults.default_branch` is guessed from `origin/HEAD`, then a local `main` or `master`, then `init.defaultBranch`.
- Safe to run again: existing files are never overwritten. The manifest is written last, so an interrupted run never leaves a repository that looks initialized but is incomplete.

## `threadline task`

- **`start`** creates an `active` task owned by the current agent, with a lease of `defaults.lease_minutes`. The branch defaults to the current one.
- **`claim`** takes ownership, or renews your own lease. It fails while another agent holds an unexpired lease on an active task; `--force` takes over and says whose lease it overrode. Paused, blocked, and proposed tasks can be claimed by anyone.
- **`update`** sets `paused`, `blocked`, or `proposed`, and changes `next_action` or `summary`. Use `claim` to make a task active and `close` to finish it.
- **`close`** sets `done` (default) or `abandoned`. It first validates the repository and refuses (exit 1) if the task, its checkpoints, or the receipts they cite have errors. An expired lease on the task itself does not block closing.

Closed tasks cannot be claimed, updated, or checkpointed.

## `threadline decision` and `threadline knowledge`

- **`decision add`** records `--topic`, `--chosen`, and `--rationale`, plus rejected alternatives as `"<option>::<reason>"`. The id defaults to `dec-<topic>`. Recording a second decision on the same topic needs `--id`, and `--supersedes <old-id>` when it replaces the old one.
- **`knowledge add`** records a fact with `--category` (`architecture`, `operations`, `convention`, `gotcha`) and `--body`.
- Both accept evidence: `--evidence-file`, `--commit` (a warning if not in the repository), `--check`, `--receipt`, `--issue`, `--pr`.
- **`update`** changes `status` or `summary`.

## `threadline receipt add`

Records the result of a check that **already ran**. Threadline never runs commands.

```console
$ pnpm test auth > /tmp/auth.log; echo $?
1
$ threadline receipt add --command "pnpm test auth" --exit-code 1 --output-file /tmp/auth.log
Created .threadline/receipts/rcpt-pnpm-test-auth-20260913t200200z.yaml (fail, agent-reported)
```

- `--result` defaults to `pass` for exit code 0, otherwise `fail`. Use `error` when the check could not run properly.
- `--output-file` keeps the last 4,000 characters, starting at a line boundary, after redacting secrets.
- The receipt records the branch, HEAD, and whether the tree was dirty (uncommitted changes outside `.threadline/`).
- With `CI=true` and a clean tree, confidence is `ci-reported` and `provenance.source` is `ci-env`, with the GitHub Actions run URL when available. That is still a self-report (spec §8). No command can produce `ci-verified`.

## `threadline checkpoint`

**`create`** writes an append-only snapshot for the next agent:

- **Task:** `--task`, or your single active task, or the single active task on this branch.
- **Git:** branch, HEAD, dirty, `base` (merge-base with `defaults.default_branch`), and `changed_paths` since base, including uncommitted and untracked files, excluding `.threadline/` and forbidden paths.
- **Receipts:** those named with `--receipt`, plus receipts any agent recorded since the task's last checkpoint (or since the task started) whose `git.head` is on the current line of history. Evidence recorded before a handoff carries over; receipts from unrelated branches do not.
- **`next_safe_action`:** `--next`, else the task's `next_action`, else `Not determined: review open_questions and failed_approaches before acting.` A checkpoint is never refused for lack of a next step, since stopping without one is worse.

**`list`** shows checkpoints newest first. **`show`** prints the checkpoint with its task's intent and each cited receipt's result; `--json` returns `{ checkpoint, task, receipts }`.

A typical handoff:

```console
$ threadline checkpoint create --done "Added token_version" \
    --failed "Delete session rows::Refresh tokens are cached" --next "Compare token_version in refresh.ts"
$ threadline task update task-session-reset --status paused
$ git add -A && git commit -m "wip: checkpoint" && git push

# The next agent, in a fresh session:
$ threadline status
$ threadline checkpoint show $(threadline checkpoint list --task task-session-reset --json | jq -r '.[0].id')
$ threadline task claim task-session-reset
```

## `threadline resume`

Compiles a briefing for the next agent from records and the current Git state. Sections always appear in this order:

1. **Goal**: the task's intent, status, and owner.
2. **Current repository state**: branch, HEAD, dirty, changes since base, and how far HEAD has moved since the latest checkpoint, including whether any code outside `.threadline/` changed.
3. **Relevant architecture and decisions**: decisions and knowledge.
4. **Files changed or likely relevant**: task scope, changes on this branch, and paths changed at the latest checkpoint.
5. **Verified behavior and checks run**: receipts, noting whether they ran on HEAD, on a commit with the same code, or on code that has changed since.
6. **Failed approaches**: from every checkpoint for the task, newest first.
7. **Open questions**: from the latest checkpoint.
8. **Next safe action**: from the latest checkpoint, else the task.

Options:

- `--task <id>`: defaults to the active task owned by `--agent` or `THREADLINE_AGENT`, else the single open task on the current branch, else the single open task.
- `--budget <tokens>`: an **approximate** size, estimated as characters / 4 (default `defaults.budget`). Real tokenizer counts vary by model. Goal, repository state, and next safe action are always included in full. Other items shrink to one-line summaries, then to `N more: [ids]` pointers. Every non-empty section keeps at least its top item before any section gets a second one, and a lower-ranked item is never shown while a higher-ranked item in the same section is hidden. When space is short, items are kept in this order: failed approaches, open questions, checks, decisions and knowledge, then files.
- `--target`: `codex`, `claude-code`, `gemini`, or `generic`. Only the header and footer change; the content is identical for every target.
- `--format json`: `{ task, target, budget, tokens, overBudget, sections[{ key, title, items[{ key, level, text }] }] }`.

How records are chosen (deterministic, no embeddings):

- records linked from the task or its checkpoints, and records whose `links` name the task;
- receipts cited by the task's checkpoints or by chosen decisions and knowledge, receipts recorded at HEAD since the task started, and receipts recorded on this line of history since the latest checkpoint (the ones the next checkpoint would attach);
- decisions and knowledge whose `scope.paths` or evidence files match the task scope, the branch's changed paths, or the checkpoints' changed paths;
- superseded decisions and deprecated knowledge only when explicitly linked.

They are ranked by how they were found (explicit links first), trust level (`ci-reported` counts the same as `agent-reported`), accepted status, whether their anchor is on this line of history, and, for receipts, whether the code is unchanged since they ran; then recency and id. Staleness never lowers a record's rank: a record that may be stale is shown with its warning rather than hidden. Within their section, records that may be stale are listed first, so their warnings survive small budgets.

Every bullet ends with its source: a record id like `[dec-auth-session-invalidation]`, `(receipt rcpt-…)`, or `(commit abc1234)`. Claims that are not `human-confirmed` or `ci-verified` are marked `⚠ unverified`. Records whose anchored content changed materially are marked `⚠ may be stale: <reason>` (spec §9).

## `threadline render`

**Instruction files.** `render agents-md`, `render claude-md`, and `render gemini-md` maintain a short block between `<!-- threadline:begin -->` and `<!-- threadline:end -->` in `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`. The block tells the agent to start from `threadline resume`, record receipts and checkpoints, keep private content out of records, and validate before closing.

- Without options, it prints the block and writes nothing.
- `--write` creates the file, appends the block, or replaces the existing block. Text outside the markers is never changed, and CRLF line endings are kept. Running it again changes nothing.
- `--check` exits 1 when the file is missing or its block differs. Use it in CI.
- Malformed markers (a begin without an end, or two blocks) are refused with exit 2 rather than guessed at.
- `claude-md` and `gemini-md` change nothing when the file imports `@AGENTS.md` and `AGENTS.md` already has the block. They refuse to write through a symlink to `AGENTS.md`, and no file is written through a symlink that leaves the repository.

Codex reads `AGENTS.md`, Claude Code reads `CLAUDE.md`, and Gemini CLI reads `GEMINI.md` unless configured otherwise. Per-agent setup: [Codex](adapters/codex.md), [Claude Code](adapters/claude-code.md), [Gemini CLI](adapters/gemini.md).

**Pull request summary.** `render pr-summary` prints a Markdown description for a task (`--task`, or inferred as for `resume`). It includes the intent and status, decisions, the latest receipt for each command, failed approaches, open questions, and the next step, and each item cites its record. It reports recorded results and never re-runs them.

```console
$ threadline render pr-summary | gh pr create --title "Invalidate sessions after password reset" --body-file -
```

## `threadline mcp`

Runs a Model Context Protocol server over stdio: newline-delimited JSON-RPC 2.0, protocol versions 2024-11-05 through 2025-11-25. Stdout carries only protocol messages, and diagnostics go to stderr. The server exits when the client closes stdin.

| Tool | Runs |
|---|---|
| `resume` | `resume` (Markdown briefing) |
| `status` | `status --json` |
| `validate` | `validate --json`. Findings are a normal result, not a tool error. |
| `task_start` | `task start` |
| `task_claim` | `task claim` |
| `checkpoint_create` | `checkpoint create`, with `failed_approaches` as `{ approach, why_failed }` objects |
| `receipt_record` | `receipt add`, with the command's output passed as `output` text |
| `decision_add` | `decision add`, with `alternatives` as `{ option, rejected_because }` objects |
| `knowledge_add` | `knowledge add` |

Resources: `threadline://status` (JSON), and `threadline://records/{id}` for any record's YAML. Open tasks are listed.

- Every tool call runs the matching CLI command in-process, one call at a time. Schema validation, path safety, reference checks, and the secret scan are therefore the same as on the command line. A refused write comes back as a tool error (`isError: true`) with the CLI's message.
- Arguments are checked against each tool's input schema first, and unknown properties are refused.
- No tool takes a `human` argument, so nothing written over MCP can be `human-confirmed`.
- Identity comes from `THREADLINE_AGENT` in the server's environment, or from an `agent` argument.
- The repository is `-C <dir>` if given, else `CLAUDE_PROJECT_DIR`, else the working directory.

## `threadline validate`

Checks every record against the rules in [spec.md §16](spec.md#16-validation-summary). Findings are printed as:

```text
error   .threadline/tasks/task-abandoned.yaml:owner.lease_expires_at: Lease held by codex expired at 2026-09-13T20:00:00Z
        hint: Renew with `threadline task claim task-abandoned`, or hand off: write a checkpoint and set status: paused.

✗ 1 error, 0 warnings in 2 records
```

- `--json` prints `{ valid, errors, warnings, records, findings[] }`. Each finding has `severity`, `code`, `file`, `path`, `message`, and `hint`.
- `--strict` turns missing evidence commits into errors. Without it they are warnings, because squash merges and shallow clones legitimately remove commits.

Finding codes:

| Code | Severity | Meaning |
|---|---|---|
| `manifest-missing` | error | `.threadline/manifest.yaml` does not exist. |
| `manifest-pattern` | error | An entry in `privacy.extra_secret_patterns` is not a valid regular expression. |
| `yaml` | error | Unparseable YAML, or anchors, aliases, custom tags, duplicate keys, or multiple documents. |
| `wrong-extension` | error | A record file ends in `.yml` instead of `.yaml`. |
| `unexpected-file` | warning | A non-record file or directory inside a record directory. |
| `schema` | error | The record does not match its JSON Schema. |
| `id-mismatch` | error | The `id` does not match the file name. |
| `kind-mismatch` | error | The `kind` does not match the directory the file is in. |
| `duplicate-id` | error | Two files use the same id. |
| `dangling-reference` | error | `links`, `task`, `receipts`, `evidence.receipts`, or `supersedes` names a record that does not exist. |
| `wrong-reference-kind` | error | A reference points at the wrong kind of record, such as a checkpoint's `task` naming a decision. |
| `secret` | error | A field looks like a credential. The value is never printed. |
| `expired-lease` | error | An `active` task's ownership lease has expired. |
| `untrusted-confidence` | error | `ci-verified` without verifiable CI provenance. |
| `forbidden-path` | error | A cited path matches `privacy.forbidden_globs`. |
| `unsafe-path` | error | A path resolves outside the repository through a symlink. Lexically unsafe paths (absolute, `..`) are reported as `schema`. |
| `missing-evidence-file` | error | An `evidence.files` path does not exist in the working tree. |
| `missing-commit` | warning (error with `--strict`) | An evidence commit, `git.head`, or `git.base` is not in the repository. |
| `unavailable-commit` | info | `valid_at` or `anchor.commit` is not in the repository. Expected after squash merges; never a failure. |
| `append-only` | error | A committed checkpoint or receipt was edited. |
| `needs-reverification` | warning | An active decision's or knowledge record's direct files changed beyond `staleness.changed_lines_threshold`, or files were added to its scope (spec §9). |
| `diverged` | warning | The record was anchored on another line of history, and the content here differs. |
| `contradiction` | warning | Two accepted decisions on the same topic have overlapping scopes, and neither supersedes the other (spec §11). |

A deleted evidence file is reported once, as `missing-evidence-file`, rather than also as stale.

## `threadline verify`

Re-anchors a decision, knowledge record, or task to HEAD after someone checked that it still holds. It rewrites `valid_at`, `anchor`, and `updated_at`, so the check appears as a diff (spec §8 rule 3, §9).

```console
$ threadline verify dec-auth-refresh-cache --human "Priya" --note "Read refresh.ts after the rewrite"
Updated .threadline/decisions/dec-auth-refresh-cache.yaml
Verified dec-auth-refresh-cache at 4b1e9c2
  was: needs_reverification: apps/api/auth/refresh.ts changed 41 lines (+40/-1) since it was anchored
  confidence: human-confirmed (confirmed by Priya)
  anchor: 4 files fingerprinted
```

- `--human <name>` sets `human-confirmed` and appends an `evidence.human` entry. `--note` records what the person checked.
- Without `--human`, confidence becomes `agent-reported`, unless the anchored content is unchanged. In that case an existing `agent-reported`, `ci-reported`, or `human-confirmed` label is kept. A confirmation made against older code is never carried forward onto code that has changed. `inferred` becomes `agent-reported`.
- No command can produce `ci-verified`.
- `--receipt <id>` adds supporting receipts to `evidence.receipts`.
- Refused: checkpoints and receipts (append-only), superseded or deprecated records, closed tasks, and records whose evidence files no longer exist.

## `threadline doctor`

Runs everything `validate` checks, plus coordination checks that only `doctor` reports:

| Code | Severity | Meaning |
|---|---|---|
| `overlapping-claim` | warning | Two active tasks with unexpired leases, held by different agents, over overlapping paths. |
| `orphaned-checkpoint` | warning | A checkpoint written after its task was closed, typically from merging branches. Its next action may be unfinished work. |
| `superseded-still-accepted` | warning | A decision named in an accepted decision's `supersedes` that is still `accepted` or `proposed`. |

Scopes overlap when they share a pattern, when one names a path the other matches, or when both match a tracked file. A decision with no scope overlaps everything on its topic.

- Each finding carries its hint. In `--json` output it also carries `command` (the suggested command, when there is one) and `fixable`.
- `--fix` applies only mechanical fixes, then reports what remains. It pauses active tasks whose lease expired (the owner stays on record), and marks decisions `superseded` when an accepted decision already supersedes them. Anything that needs judgment, such as contradictions, stale claims, or overlapping claims, is left to the suggested command. `--fix` needs an agent identity.
- Exit code 1 when errors remain, 0 otherwise. `--json` prints `{ ok, errors, warnings, fixed[], findings[] }`.

## `threadline status`

Shows the branch, HEAD, and dirty state (changes under `.threadline/` don't count as dirty), record counts, active tasks with their owners, leases, next actions, and latest checkpoints, other open tasks, and a validation summary. It always exits 0 once Threadline is initialized; run `validate` for details.

`--json` prints `{ project, git, counts, activeTasks[], openTasks[], validation }`.

## Environment variables

| Variable | Meaning |
|---|---|
| `THREADLINE_AGENT` | Agent identity for commands that write records, such as `codex`, `claude-code`, or `gemini`. `--agent` takes precedence. |
| `THREADLINE_NOW` | Fixed current time (for example `2026-09-13T21:00:00Z`), for reproducible tests and demos. |
| `THREADLINE_DEBUG` | Print stack traces for unexpected failures. |
| `CI` | When `true` (or `1`) and the tree is clean, receipts are labeled `ci-reported`. |
| `CLAUDE_PROJECT_DIR` | Set by Claude Code for the MCP servers it starts. `threadline mcp` uses it as the repository when `-C` is not given. |

## CI

Validate records on every pull request with the bundled action:

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0 # full history, so evidence commits can be checked
- uses: shubhambaid/Threadline@main
  with:
    strict: "true"
```

Inputs: `working-directory` (default `.`) and `strict` (default `"false"`). Lease expiry is checked against the real clock, so a task abandoned while `active` fails CI until someone renews it or pauses it.
