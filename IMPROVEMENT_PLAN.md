# Alethic improvement plan

## Objective

Build a shared context ledger for coding agents that is portable across models, anchored to Git, and compiled into a small, trustworthy briefing for whichever agent picks up the work.

The implementation already provides structured YAML records, schemas, content anchors, a deterministic briefing compiler, CLI and MCP access, and handoff tests. The next phase should strengthen the meaning of its trust labels, test its usefulness in real sessions, and make the recorded work easy to explore.

This document defines eight proposed tasks. It does not indicate that they have been implemented. Findings are based on the repository review on September 14, 2026; that review passed 238 tests across 29 test files, type checking, linting, and the build.

## 1. Enforce trust rules before compiling a briefing

**Priority: P0 — trust foundation**

### Problem

`resume` loads records through `loadRecordIndex`, which discards loading findings and does not validate record schemas or provenance. The separate validator performs those checks. A hand-edited record can therefore reach a briefing without satisfying the checks applied elsewhere. For example, validation rejects `ci-verified`, while the briefing renderer recognizes that label as verified. Relevant contradictions also need to be visible at the point of handoff.

### Work

- Introduce a shared assessment path used by validation and briefing compilation.
- Check schemas, identity consistency, references, provenance, and privacy before rendering record content.
- Exclude invalid claims from authoritative briefing sections and explain the exclusions without echoing sensitive content.
- Surface relevant contradictory decisions, duplicate IDs, broken references, and incomplete loading.
- Preserve deterministic output and reuse Git lookups to avoid unnecessary overhead.
- Treat record prose as attributed evidence, with no authority to override repository or user instructions.

### Acceptance criteria

- A manually forged `ci-verified` record cannot appear as verified in a briefing.
- Malformed records and duplicate IDs are reported rather than silently ignored or selected.
- Relevant conflicting decisions produce an explicit warning with source references.
- Privacy checks apply to manually edited records before their content is emitted.
- Tests cover these failures through `resume`, not only through `validate`.

**Relevant code:** `src/core/records.ts`, `src/commands/resume.ts`, `src/validate/index.ts`, `src/compile/briefing.ts`.

## 2. Make content freshness conservative and explicit

**Priority: P0 — trust foundation**

### Problem

The default threshold permits up to 20 changed lines without marking a record stale. A small edit can invalidate a claim, and the briefing does not display the informational notes for these changes. The current line comparison also ignores ordering, so reordered operations can register zero added or deleted lines.

### Work

- Reserve an unchanged-content status for matching fingerprints.
- Make any change to direct evidence visible and require reassessment of applicability.
- Use change size to prioritize review, rather than imply semantic correctness.
- Distinguish direct evidence changes from changes to surrounding scope.
- Replace or supplement the order-insensitive line comparison.
- Represent unavailable anchors and uncertain applicability explicitly.
- Keep content-based behavior across rebases, squash merges, and shallow clones.

### Acceptance criteria

- A one-line change reversing a condition produces a visible warning.
- Reordering existing operations cannot leave changed direct evidence labeled unchanged.
- Missing historical content produces uncertainty rather than an unsupported freshness claim.
- Unrelated scope changes can be explained without overstating their effect on direct evidence.
- Briefing and dashboard views use the same derived statuses.

**Relevant code:** `src/trust/staleness.ts`, `src/core/manifest.ts`, `src/compile/briefing.ts`.

## 3. Distinguish recorded human confirmation from authenticated approval

**Priority: P0 — trust foundation**

### Problem

Passing `--human <name>` creates `human-confirmed`. This records an assertion about a human; it does not authenticate that person's approval. An agent with CLI access can supply the flag. The current “hard-to-forge” positioning overstates this guarantee.

### Work

- Document the trust boundary and the threat model for local writers.
- Make labels and briefing wording distinguish self-reported confirmation from independently authenticated approval.
- Keep identity, evidence provenance, and current applicability separate.
- If authenticated approval is introduced, bind it to a specific record revision or content digest and a verifiable reviewer identity.
- Invalidate approval applicability when the approved claim changes.
- Update schemas, specification, adapters, and migration guidance together if labels change.

### Acceptance criteria

- Supplying an arbitrary human name never implies authenticated approval.
- Agents can tell who allegedly confirmed a claim and whether that attribution was verified.
- Editing an approved claim cannot silently preserve approval for the new claim.
- Documentation describes exactly what each trust level establishes.

**Relevant code:** `src/core/write.ts`, `src/commands/verify.ts`, `src/trust/confidence.ts`, `schemas/common.schema.json`.

## 4. Bind check receipts to the code that actually ran

**Priority: P0 — evidence correctness**

### Problem

Receipt applicability currently relies partly on commit comparisons. Matching HEAD values do not prove identical working trees. Receipts store dirty state, but rendered check lines do not disclose it. `receipt add` captures repository state when recording the receipt, which can differ from the state when the command ran.

### Work

- Move `receipt run` earlier in the roadmap and reconcile command execution with the specification's existing non-goals.
- Capture command arguments, working directory, start/end times, exit code, and redacted output.
- Capture relevant content fingerprints before and after execution, including the working state covered by the check.
- Detect changes during execution and report their effect on applicability as uncertain.
- Disclose dirty state and fingerprint coverage in receipts and briefings.
- Preserve `receipt add` for imported or manually reported checks, with an explicit provenance distinction.
- Keep captured execution separate from cryptographically verified CI provenance.

### Acceptance criteria

- Editing code without changing HEAD invalidates an unsupported claim that a previous check applies to current code.
- Changes during execution are visible.
- Imported receipts cannot imply that Alethic observed execution.
- Output is redacted before storage, and sensitive environment values are not captured by default.
- Tests cover clean, dirty, changed-during-run, and partially fingerprinted states.

**Relevant code:** `src/commands/receipt.ts`, `src/commands/resume.ts`, `src/compile/briefing.ts`, `schemas/receipt.schema.json`.

## 5. Keep briefing size bounded as the ledger grows

**Priority: P1 — reliable compilation**

### Problem

Hidden records collapse into lines containing every distinct citation. That pointer list can exceed the budget even when essential sections are small. Tokenizer accuracy alone will not solve this growth.

### Work

- Bound inline citation lists and show omitted-record counts.
- Provide a retrieval command or drill-down reference for omitted records.
- Preserve the goal, essential repository state, critical warnings, and next action.
- Define behavior when essential content itself exceeds the requested budget.
- Explain budget overflow accurately, distinguishing mandatory content from pointer overhead.
- Add inclusion and omission reasons to an inspectable compiler result.
- Measure compilation time and output size on large ledgers before choosing a caching or indexing strategy.

### Acceptance criteria

- Large numbers of optional records cannot make a collapsed pointer list grow without limit.
- Overflow is explicit and attributable to a documented policy.
- Omitted records remain retrievable.
- Repeated compilation with identical inputs remains deterministic.
- Scale fixtures exercise hundreds and thousands of records.

**Relevant code:** `src/compile/budget.ts`, `src/compile/briefing.ts`, `src/compile/collect.ts`, `src/compile/score.ts`.

## 6. Distinguish concurrent sessions and protect competing updates

**Priority: P1 — collaboration correctness**

### Problem

Ownership uses agent names. Overlap detection skips matching owner names, so two separate sessions of the same tool can escape a warning. Atomic file replacement prevents partial writes but does not prevent lost updates between competing writers.

### Work

- Separate tool identity from session identity; record model identity only when known.
- Attribute claims and checkpoints to sessions while retaining readable agent names.
- Detect overlapping work by different sessions of the same tool.
- Add optimistic concurrency checks for mutable records and collision-safe creation for append-only records.
- Define reconciliation behavior for competing claims merged through Git.
- Document that leases describe visible repository state and are not global locks across independent clones.

### Acceptance criteria

- Two `codex` sessions with overlapping tasks are distinguishable and produce a warning.
- A stale writer cannot silently overwrite a newer record revision.
- Concurrent creation cannot silently replace an existing receipt or checkpoint.
- Merged ownership conflicts are actionable and retain attribution.

**Relevant code:** `src/core/identity.ts`, `src/core/store.ts`, `src/commands/task.ts`, `src/trust/conflicts.ts`, `src/validate/leases.ts`.

## 7. Validate handoff quality in real agent sessions

**Priority: P1 — product validation**

### Problem

The demo and cross-agent tests exercise scripted operations under different agent names. They establish interoperability, but do not establish whether fresh agents reliably record useful context, follow the briefing, or improve task outcomes. Live adapter verification remains unfinished.

### Work

- Run actual tasks across fresh sessions of the supported agents.
- Compare against Git plus repository instructions and a simple handoff Markdown file.
- Include failed approaches, changed evidence, conflicting decisions, expired ownership, and incomplete checks.
- Measure time and tokens to the next useful action, repeated investigation, repeated mistakes, stale-claim reliance, and maintenance effort.
- Use Alethic in its own development to expose routine capture friction.
- Add file/stdin input and improve capture ergonomics where observed friction justifies it.
- Publish reproducible scenarios and limitations without storing private transcripts in the ledger.

### Acceptance criteria

- Supported adapters have documented real-session verification.
- Evaluation results separate scripted compatibility from observed agent behavior.
- Critical constraints and failed approaches survive small-budget handoffs.
- Results describe both benefits and cases where a simple handoff file is sufficient.
- Evaluation findings feed back into compiler priorities and capture workflows.

**Relevant files:** `test/e2e/cross-agent.test.ts`, `examples/demo/run-demo.sh`, `docs/adapters/`, `ROADMAP.md`.

## 8. Build an observability dashboard for agent work and context relationships

**Priority: P2 — visibility and exploration; design can begin alongside P1 work**

### Goal

Create a polished, local dashboard that lets a developer see what each agent session worked on, how work passed between sessions, which context records connect them, and where evidence is stale, disputed, or missing.

The main experience should answer: “How did we get here, what did the next agent receive, and what can I trust now?”

### Graph view

- Represent agent sessions, tasks, checkpoints, decisions, knowledge, receipts, and relevant Git commits or files as distinct node types.
- Show labeled relationships such as authored, owns, checkpoint-for, cites, supersedes, and anchored-to.
- Make handoffs traceable through a shared task, checkpoint, and receiving session where evidence exists.
- Distinguish explicit record links, inferred relevance, and observed briefing delivery using different edge styles and labels.
- Group by task or session by default, with progressive expansion to avoid an unreadable graph.
- Support search and filters for agent, session, task, branch, time range, record kind, confidence, and freshness.

### Context provenance

Existing authored records establish who wrote something. They do not establish that another agent read or used it. The dashboard must preserve that distinction.

- Use existing records for an initial authorship and evidence graph.
- If briefing-delivery events are added, record a versioned, privacy-conscious event containing the receiving session, selected task, Git/content state, compiler version, budget, record revisions, and inclusion levels.
- Label such an event as context delivered; it does not prove comprehension or influence.
- Treat path overlap and shared-task relationships as inferred connections, not proven context transfer.
- Define storage, opt-in behavior, and retention for events before adding them to the shared ledger. Preserve the existing boundary that `.alethic/local/` is not shared or compiled into briefings.

### Supporting views

- **Activity timeline:** checkpoints, decisions, checks, ownership changes, and evidenced handoffs in chronological order.
- **Task detail:** goal, owner/session, current status, next action, related records, and unresolved conflicts.
- **Agent/session detail:** authored records, owned tasks, recorded checks, and evidenced incoming/outgoing context relationships.
- **Record inspector:** readable content, revision, source path, trust explanation, anchor comparison, and linked evidence.
- **Briefing inspector:** what was included, shortened, or omitted and why, using the compiler's own explanations.
- **Health overview:** invalid records, changed evidence, conflicting decisions, expired claims, and check applicability.

### Visual design

- Use a graph workspace with a compact filter panel, a collapsible detail inspector, and an optional timeline strip.
- Give node types consistent shapes and labels; use restrained colors for trust and freshness states.
- Provide clear selection highlighting, relationship explanations, a legend, and useful empty states.
- Support keyboard navigation and an accessible list/table alternative to the graph.
- Avoid activity leaderboards or interpreting record counts as productivity.

### Architecture and scope

- Start with a read-only local dashboard served on loopback, using Git and YAML as the source of truth.
- Reuse core validation, staleness, conflict, and compilation logic through a structured query layer.
- Keep graph indexes rebuildable; introduce no required hosted service, account, or separate authoritative database.
- Render record text as untrusted content, enforce repository path boundaries, and apply privacy checks before display or export.
- Clearly distinguish current working-tree views from historical committed-state views.
- Use lazy expansion and bounded graph queries for large repositories.
- Defer record editing, command execution, and remote collaboration controls beyond the first dashboard release.

### Acceptance criteria

- A developer can follow a recorded task from one session's checkpoint to a later session's work and inspect the supporting links.
- The UI distinguishes two sessions of the same agent tool.
- Every edge explains whether it is explicit, inferred, or based on a delivery event.
- Context delivered is never presented as proof that an agent used or understood it.
- Stale evidence, invalid records, and contradictory decisions are visible and link to explanations.
- Selecting a node reveals its source record or Git evidence.
- The dashboard reflects ledger changes and agrees with CLI assessments.
- The initial release is read-only, local, accessible without the graph, and usable on a large-ledger fixture.

### Suggested delivery sequence

1. Establish session attribution and a shared assessed-data interface.
2. Ship a local graph with task filters, record inspection, and an activity timeline.
3. Add compiler explanations and clearly labeled context-delivery events if needed.
4. Refine layout, accessibility, performance, and historical exploration using real handoff trials.

## Recommended execution order

1. Complete tasks 1–4 to make trust and applicability claims precise.
2. Complete tasks 5–6 to keep compilation and collaboration reliable at scale.
3. Run task 7 throughout development to test the product's actual handoff benefit.
4. Build task 8 on the shared assessment and session-attribution foundations, beginning with a read-only view of existing records.

The dashboard should make the ledger's evidence understandable. Its graph should expose uncertainty with the same care as the briefing itself.
