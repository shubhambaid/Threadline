# Why not just AGENTS.md?

`AGENTS.md` (and `CLAUDE.md`, `GEMINI.md`) is the right place for **how to work in this repository**: build commands, conventions, where things live. Those change rarely and apply to every task.

Aletheic is for **where the work stands**: this task's goal, the approach that failed an hour ago, the decision made yesterday, the test that passed on commit `aa50b9e`. That changes constantly and belongs to specific tasks and code.

Putting the second kind into the first kind of file runs into these limits:

| Need | Instruction file | Aletheic |
|---|---|---|
| Read by every agent | Each agent reads its own file by default: Codex `AGENTS.md`, Claude Code `CLAUDE.md`, Gemini CLI `GEMINI.md`. Sharing needs imports or settings. | Any agent that can run a command, or any MCP client, reads the same records. |
| Size | Always loaded in full and competes for a capped budget (Codex reads at most 32 KiB by default). | `resume` selects and compresses what is relevant to one task, within an approximate budget. |
| Structure | Free-form prose. Nothing checks it. | Schemas per record kind, validated in CI. |
| Staleness | A note about `refresh.ts` stays after `refresh.ts` is rewritten. | Records fingerprint the files they describe, and changed code flags them *may be stale*. |
| Provenance | No record of who wrote a line or whether anyone checked it. | Every record says which agent wrote it, with a confidence label that only a named human can raise. |
| Evidence | "Tests pass" with no commit or output. | Receipts record the command, exit code, commit, and a redacted output tail. |
| Parallel work | Everyone edits one file, so branches conflict. | One file per record merges cleanly. Real conflicts, such as contradictory decisions or overlapping claims, are detected. |
| Handoff | Nothing marks who is working on what. | Tasks have owners with expiring leases, and checkpoints capture the next safe action. |
| History | Old notes are deleted or pile up. | Decisions are superseded explicitly. Checkpoints and receipts are append-only. |

## How they work together

Aletheic uses the instruction file for the one thing only it can do: tell each agent to start from `alethic resume`. `alethic render agents-md --write` maintains a block of about fifteen lines, and nothing else in the file is touched. Project conventions stay in `AGENTS.md`, and task state moves to `.alethic/`.

## When an instruction file is enough

If one agent works on short tasks that finish in a single session, and nobody else continues its work, an instruction file is all you need. Aletheic pays off when work spans sessions, agents, or people: when "what did the last session learn?" has an answer worth keeping.
