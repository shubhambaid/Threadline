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
- **Receipts:** those named with `--receipt`, plus receipts you recorded since your last checkpoint for the task (or since the task started).
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

Staleness warnings (spec §9) and contradictory-decision warnings (spec §11) come in a later release.

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
