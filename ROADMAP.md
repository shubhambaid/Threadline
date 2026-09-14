# Roadmap

Threadline is pre-release. This page lists what exists, what is needed before a first published release, and what may come later. Items can move as real use shows what matters.

## Done (v0)

- Record format v1: tasks, decisions, knowledge, checkpoints, and receipts, with JSON Schemas and a normative [spec](docs/spec.md) whose examples are tested.
- Validator for schema, references, secrets, expiring leases, trust labels, path safety, missing commits, and append-only history. There is also a GitHub Action.
- Task, decision, knowledge, receipt, and checkpoint commands, with an end-to-end handoff test.
- `resume`: a deterministic, cited, approximately budgeted briefing, with golden outputs at 1000, 2500, and 5000 tokens.
- Instruction blocks for `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`, PR summaries, and a stdio MCP server tested with the official MCP client.
- Content-based staleness that survives squash merges and shallow clones, plus `verify`, contradiction and overlapping-claim detection, and `doctor`.
- A demo that hands one task from Codex to Claude Code to Gemini, run by the test suite.

## Before the first release

- **Publish** as `@threadline/cli` once the npm scope is confirmed (fallback names are listed in the project plan), with the `threadline` command.
- **Verify the adapters in real sessions** of Codex, Claude Code, and Gemini CLI. Today they are checked against vendor documentation and exercised with the official MCP client, not in live agent sessions.
- **Antigravity setup**, verified the same way.
- **Demo media**: a README GIF from `examples/demo/demo.tape` and a short video.
- **Input from files** for agents that prefer writing YAML: `checkpoint create --from-file` (and stdin), plus the same for decisions and knowledge.

## Next

- **`receipt run`**: run a command and record its receipt in one step. The instruction block will switch from `receipt add` to `receipt run` when this ships.
- **`ci-verified`**: verify receipts against GitHub Actions artifact attestations when `trust.ci_provenance: github-attestation` is configured. Until then `ci-verified` cannot be produced, by design (spec §8).
- **Retiring old records**: archive closed tasks and their checkpoints so long-lived repositories stay fast to load.
- **Optional tokenizer-accurate budgets**, keeping the characters / 4 estimate as the deterministic default.

## Not planned

These are non-goals (spec §3): replacing Git, storing chat transcripts, orchestrating agents, hosted accounts or databases, and deciding automatically whether a claim is true.
