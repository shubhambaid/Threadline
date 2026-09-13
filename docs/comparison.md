# How Threadline compares

Threadline sits between things teams already use. It replaces none of them. This page describes categories of tools, not specific products, because features change quickly.

| | Survives a switch to another agent | Reviewed in pull requests | Tied to a code version | Flags when code changes | Structured for handoff |
|---|---|---|---|---|---|
| Chat transcripts and session resume | No | No | No | No | No |
| An agent's private memory | No | Usually not | No | No | No |
| Instruction files (`AGENTS.md`, …) | Partly | Yes | No | No | No |
| Architecture decision records | Yes | Yes | Loosely | No | No |
| Issue trackers and PR descriptions | Yes | Partly | Loosely | No | Partly |
| **Threadline** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** |

## Chat transcripts and session resume

A transcript holds everything an agent saw and said, which is the problem: it is long, specific to one tool, and full of dead ends, tool output, and sometimes secrets or customer data. Resuming a session works only with the same tool, and usually only for the same person.

Threadline stores the conclusions instead: what failed and why, what was decided, what ran, and what to do next. It never stores the transcript, and committing one is outside its privacy boundary (spec §13).

## An agent's private memory

Some agents keep their own memory across sessions. That memory helps that agent, for that user. Other agents cannot read it, reviewers never see it, and it does not know which commit a memory was true at.

Threadline is shared, and memory that stays private to one agent belongs in `.threadline/local/`, which is never committed and never read by `resume`.

## Instruction files

See [Why not just AGENTS.md?](why-not-agents-md.md). In short: instruction files are for stable conventions, and Threadline is for changing task state. Threadline adds a short block to the instruction file so agents know to use it.

## Architecture decision records (ADRs)

ADRs record significant, long-lived architectural choices, written and reviewed by people. Threadline decisions are smaller and more frequent: a choice made during one task, with rejected alternatives, often written by an agent and marked unverified until a person confirms it. They are anchored to the files they concern and flagged when those files change.

They work together. A Threadline decision can cite an ADR in `evidence.files`, and an accepted decision worth keeping long-term can be written up as an ADR.

## Issue trackers and pull request descriptions

The tracker says what should be done and who is assigned. Threadline records the state of the work in progress: the current branch and commit, checks that ran, approaches already ruled out, and the next safe step. That state changes too often, and is too tied to code, to maintain by hand in a ticket.

Tasks can cite issues and pull requests (`--issue`, `--pr`), and `threadline render pr-summary` turns the records into a PR description.

## What Threadline is not

- **Not an orchestrator.** It does not start, schedule, or coordinate agents. Leases are advisory.
- **Not a test runner or CI.** Receipts record checks that already ran. `ci-verified` is reserved for verifiable CI provenance, which is not implemented yet, so nothing can claim it.
- **Not a truth oracle.** It does not decide whether a claim is correct. It records who made the claim, what supports it, and whether the code it describes has changed since.
- **Not a hosted service.** Everything lives in your repository.
