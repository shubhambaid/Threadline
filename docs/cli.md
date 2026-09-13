# Threadline CLI

The command is `threadline` (package `@threadline/cli`). Every command works without a model connection. The record format is defined in [spec.md](spec.md).

```console
threadline init [--name <name>]
threadline validate [--json] [--strict]
threadline status [--json]
```

Global options:

| Option | Meaning |
|---|---|
| `-C, --cwd <dir>` | Run as if started in `<dir>`, like `git -C`. |
| `-v, --version` | Print the version. |
| `-h, --help` | Show help for any command. |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. `validate` found no errors; warnings and info notes are allowed. |
| 1 | `validate` found at least one error. |
| 2 | A usage or environment problem: unknown command, not a Git repository, Threadline not initialized, or git missing. |

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
