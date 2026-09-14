# Evaluating handoffs in real agent sessions

Aletheic's tests show that the format, the CLI, and the MCP server work, and that a briefing keeps the facts a handoff depends on. They do not show that a fresh Codex, Claude Code, or Gemini session reads the briefing, acts on it, and does better than it would with Git and a notes file. This page is the protocol for finding out, and the record of what has and has not been done.

## Status

| What | Established by | Status |
|---|---|---|
| Records, validation, briefings, and receipts behave as specified | Unit and end-to-end tests | Passing on every test run |
| One task moves through three agent identities using only the CLI | `examples/demo/run-demo.sh`, run by `test/e2e/demo.test.ts` | Passing. Scripted: the "agents" are shell steps, not model sessions. |
| The MCP tools and resources work with the official MCP client | `test/e2e/mcp.test.ts` | Passing. Scripted. |
| Each scenario below builds identically in all three conditions, and in the Aletheic condition its critical fact survives a 600-token briefing | `test/e2e/eval-scenarios.test.ts` | Passing. Scripted: this checks what a session would be given, not what it does with it. |
| Codex, Claude Code, and Gemini CLI follow the instruction block and use the briefing | Live sessions with this protocol | **Not run** |
| Aletheic improves handoff outcomes over Git plus a handoff file | Live sessions with this protocol | **Not run** |
| The adapters in `docs/adapters/` work in real sessions | Live sessions | **Not verified** (checked against vendor documentation only) |

Nothing on this page is a result until the live rows are filled in.

## Conditions

Every scenario is built three ways by `examples/eval/build-scenario.sh`. The code, commits, repository instructions, and prompt are identical; only what the previous agent left behind differs.

| Condition | What the next session gets |
|---|---|
| `aletheic` | `.alethic/` records written by the previous "agent", and the instruction block telling it to start from `alethic resume` |
| `handoff-file` | The same facts in prose in `HANDOFF.md`, and an instruction to read it |
| `git-only` | Repository instructions and commit history only |

## Scenarios

| Scenario | What the previous agent left | The trap | What a good handoff looks like |
|---|---|---|---|
| `failed-approach` | An approach that failed (deleting session rows), with the reason | Repeating the failed approach | The session avoids it and fixes the cause |
| `changed-evidence` | A decision whose rationale depends on code that someone later changed | Relying on an obsolete reason | The session checks the current code before building on the decision |
| `conflicting-decisions` | Two accepted decisions that disagree | Silently following one | The session notices and says so |
| `expired-ownership` | An active task whose owner's lease expired | Waiting for, or working alongside, an owner who is gone | The session takes the task over properly and continues from the next step |
| `incomplete-checks` | A passing check, followed by a code change nobody re-tested | Trusting the old pass | The session re-runs the check and finds the regression |

```console
$ npm run build
$ examples/eval/build-scenario.sh incomplete-checks aletheic /tmp/eval/incomplete-checks-aletheic
/tmp/eval/incomplete-checks-aletheic
$ ls /tmp/eval/incomplete-checks-aletheic
PROMPT.md  SCORING.md  repo  scenario.json
```

## Procedure

1. Build each scenario in each condition into its own directory. Never reuse a repository between sessions.
2. For each agent (Codex, Claude Code, Gemini CLI), start a **fresh** session in `repo/` with no memory of earlier sessions, no extra instructions, and default settings. Record the agent's version and model.
3. Paste `PROMPT.md` as the only message. Do not answer questions about the scenario beyond "use your judgment". Stop at 30 minutes or when the agent says it is done.
4. Score with `SCORING.md` from the outcome: the repository afterwards (`git diff`, `node --test`, `.alethic/`, `HANDOFF.md`) and the agent's final message. Do not store transcripts.
5. Run every scenario in every condition for every agent, in a randomized order, and at least twice per cell if budget allows; models vary between runs.

## Measures

- **Outcome:** the scenario's checklist items (yes, partly, no), and whether `node --test` passes.
- **Time and tokens to the first useful change:** as reported by the agent tool, when it reports them.
- **Repeated investigation:** re-running the failed approach, or re-discovering a fact the handoff already stated.
- **Stale-claim reliance:** acting on the obsolete rationale or the old passing check without checking it.
- **Maintenance effort:** records, notes, or commands the agent wrote to keep the handoff state current, and any it got wrong.
- **Friction:** Aletheic commands that failed, needed retries, or that the agent avoided.

## Recording results

Add one row per session to the table below, and keep any longer notes in `docs/evaluation-results/` (not in `.alethic/`: evaluation observations are not project memory, and transcripts never belong in either).

| Date | Agent and version | Model | Scenario | Condition | Outcome items | Time / tokens | Notes |
|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | No live sessions have been run. |

When results exist, report the cases where `handoff-file` or `git-only` did as well as `aletheic`, not only the wins. Feed what they show back into compiler priorities (what a small briefing keeps) and capture workflows (what agents skip writing).

## Open questions the evaluation should answer

These are hypotheses, not findings:

- A handoff file may be enough when one agent hands to one agent within a day and nothing changes in between. The scenarios where Aletheic is expected to matter are the ones where something changed after the note was written: `changed-evidence`, `incomplete-checks`, and `expired-ownership`.
- Agents may not run `alethic resume` unprompted even with the instruction block. If so, the block's wording, or starting sessions through MCP resources, needs work.
- Writing checkpoints may be skipped at the end of sessions. `--from-file` and stdin input exist to lower that friction, but whether agents use them is untested.

## Using Aletheic on Aletheic

Developing Aletheic with its own ledger would expose capture friction in routine use. It has not been done yet: the improvement work so far was done in single sessions without handoffs, so records written after the fact would not show real friction. The next multi-session change should start with `alethic init` in this repository and add what it finds to this page.
