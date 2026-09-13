import { asArray, asObject, asString } from "../core/json.js";
import type { LoadedRecord } from "../core/store.js";
import { NOT_DETERMINED, oneLine, truncate } from "../core/text.js";
import { isVerified } from "../trust/confidence.js";
import type { DerivedStatus, StalenessResult } from "../trust/staleness.js";
import {
  allocate,
  type BriefingItem,
  type BriefingSection,
  estimateTokens,
  type Level,
} from "./budget.js";
import type { GitState } from "./collect.js";
import type { ScoredCandidate } from "./score.js";

export const TARGETS = ["codex", "claude-code", "gemini", "generic"] as const;
export type Target = (typeof TARGETS)[number];

const TARGET_NAMES: Record<Target, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  gemini: "Gemini",
  generic: "any coding agent",
};

const TARGET_HINTS: Record<Target, string> = {
  codex: "Project instructions for Codex are in AGENTS.md.",
  "claude-code": "Project instructions for Claude Code are in CLAUDE.md.",
  gemini: "Project instructions for Gemini are in GEMINI.md, or AGENTS.md if configured.",
  generic: "Project instructions are in the repository's agent instruction file.",
};

/**
 * What to keep when space is short. Handoff-specific items that exist nowhere else come first;
 * decisions and files can be looked up by id or path, so they give way first.
 */
const SECTION_PRIORITY = {
  failed: 5000,
  questions: 4000,
  checks: 3000,
  decisions: 2000,
  files: 1000,
} as const;

const STALE: ReadonlySet<DerivedStatus> = new Set([
  "needs_reverification",
  "diverged",
  "broken_evidence",
]);

export interface CheckpointRelation {
  kind: "head" | "ahead" | "other-line" | "unavailable";
  commits?: number;
  /** Whether files outside .threadline/ changed between the checkpoint and HEAD. */
  codeChanged?: boolean;
}

export interface BriefingInput {
  target: Target;
  budget: number;
  now: Date;
  task: LoadedRecord;
  checkpoints: LoadedRecord[];
  latestRelation?: CheckpointRelation;
  git: GitState;
  scopePaths: string[];
  /** Decisions, knowledge, and receipts, ranked. */
  records: ScoredCandidate[];
}

export interface Briefing {
  taskId: string;
  text: string;
  tokens: number;
  overBudget: boolean;
  sections: { key: string; title: string; items: { key: string; level: Level; text: string }[] }[];
}

type Data = Record<string, unknown>;

function strings(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

function idOf(record: LoadedRecord): string {
  return asString(record.data.id) ?? record.file;
}

function sentence(text: string): string {
  const line = oneLine(text);
  return /[.!?]$/.test(line) ? line : `${line}.`;
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function markers(data: Data, staleness?: StalenessResult): string {
  const parts: string[] = [];
  if (staleness && STALE.has(staleness.status)) {
    parts.push(`⚠ may be stale: ${staleness.reasons[0] ?? staleness.status.replace(/_/g, " ")}`);
  }
  if (!isVerified(data.confidence)) parts.push("⚠ unverified");
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function fixed(key: string, text: string): BriefingItem {
  return { key, full: text, short: text, pointer: "", priority: 0 };
}

/** Records that may be stale first, so their warnings survive small budgets; rank otherwise. */
function warningsFirst(records: ScoredCandidate[]): ScoredCandidate[] {
  return [
    ...records.filter((r) => STALE.has(r.staleness.status)),
    ...records.filter((r) => !STALE.has(r.staleness.status)),
  ];
}

/**
 * Priority follows display order within a section, so the allocator can never show a later
 * item in more detail than an earlier one.
 */
function inDisplayOrder(items: BriefingItem[], base: number): BriefingItem[] {
  return items.map((item, index) => ({ ...item, priority: base + items.length - index }));
}

/** Builds the briefing described in docs/spec.md §14. */
export function buildBriefing(input: BriefingInput): Briefing {
  const taskId = idOf(input.task);
  const sections = buildSections(input, taskId);
  // Reserve the largest frame of any target, so the content is identical for every target.
  const reserve = Math.max(
    ...TARGETS.map((target) => estimateTokens(frame(target, input.budget, taskId, ""))),
  );
  const allocation = allocate(sections, input.budget - reserve);
  const text = frame(input.target, input.budget, taskId, allocation.content);
  return {
    taskId,
    text,
    tokens: estimateTokens(text),
    overBudget: allocation.overBudget,
    sections: sections.map((section) => ({
      key: section.key,
      title: section.title,
      items: section.items.map((item) => {
        const level = allocation.levels.get(item.key) ?? "pointer";
        const text = level === "full" ? item.full : level === "short" ? item.short : item.pointer;
        return { key: item.key, level, text };
      }),
    })),
  };
}

function frame(target: Target, budget: number, taskId: string, content: string): string {
  return [
    `# Threadline briefing: ${taskId}`,
    "",
    `> Compiled by \`threadline resume\` for ${TARGET_NAMES[target]}. Budget: about ${budget} tokens, estimated as characters / 4. Every bullet cites its source; ⚠ marks claims that are unverified or may be stale.`,
    "",
    content,
    "",
    "---",
    `${TARGET_HINTS[target]} Before stopping, run \`threadline checkpoint create\`. Before closing the task, run \`threadline validate\`. Never put secrets, customer data, or chat transcripts in records.`,
    "",
  ].join("\n");
}

function buildSections(input: BriefingInput, taskId: string): BriefingSection[] {
  const task = input.task.data;
  const latest = input.checkpoints[0];
  const latestId = latest ? idOf(latest) : undefined;
  const git = input.git;

  // Goal
  const owner = asObject(task.owner);
  const agent = asString(owner?.agent);
  const lease = asString(owner?.lease_expires_at);
  const expired = lease !== undefined && Date.parse(lease) <= input.now.getTime();
  const goal: BriefingSection = {
    key: "goal",
    title: "Goal",
    required: true,
    items: [
      fixed(
        "goal:intent",
        `${sentence(asString(task.intent) ?? asString(task.summary) ?? taskId)} [${taskId}]${markers(task)}`,
      ),
      fixed(
        "goal:status",
        `Status: ${asString(task.status) ?? "unknown"}${agent ? `; owner ${agent}, lease ${expired ? "expired at" : "until"} ${lease}` : ""}. [${taskId}]`,
      ),
    ],
  };

  // Current repository state
  const stateItems: BriefingItem[] = [];
  if (git.head && git.headShort) {
    stateItems.push(
      fixed(
        "state:git",
        `Branch ${git.branch ?? "(detached HEAD)"} at ${git.headShort}, ${git.dirty ? "with uncommitted changes" : "clean"}${git.base ? `; ${count(git.changedPaths.length, "path")} changed since ${git.base}` : ""}. (commit ${git.headShort})`,
      ),
    );
  } else {
    stateItems.push(fixed("state:git", `The repository has no commits yet. [${taskId}]`));
  }
  if (latest && latestId) {
    const cpGit = asObject(latest.data.git);
    const where = `${asString(cpGit?.branch) ?? "(detached HEAD)"} at ${asString(cpGit?.head) ?? "?"}${cpGit?.dirty ? " with uncommitted changes" : ""}`;
    const author = asString(asObject(latest.data.created_by)?.agent) ?? "an unknown agent";
    stateItems.push(
      fixed(
        "state:checkpoint",
        `Latest checkpoint was written by ${author} at ${asString(latest.data.created_at) ?? "?"} on ${where}; ${relationText(input.latestRelation)}. [${latestId}]`,
      ),
    );
  } else {
    stateItems.push(
      fixed("state:checkpoint", `No checkpoint has been written for this task yet. [${taskId}]`),
    );
  }
  const state: BriefingSection = {
    key: "state",
    title: "Current repository state",
    required: true,
    items: stateItems,
  };

  // Relevant architecture and decisions
  const decisions: BriefingSection = {
    key: "decisions",
    title: "Relevant architecture and decisions",
    required: false,
    items: inDisplayOrder(
      warningsFirst(
        input.records.filter((r) => r.record.kind === "decision" || r.record.kind === "knowledge"),
      ).map(recordItem),
      SECTION_PRIORITY.decisions,
    ),
  };

  // Files changed or likely relevant: task scope, then this branch's changes, then paths the
  // latest checkpoint changed that are no longer changed.
  const fileItems: BriefingItem[] = [];
  for (const pattern of input.scopePaths) {
    const text = `${pattern}: task scope [${taskId}]`;
    fileItems.push({
      key: `scope:${pattern}`,
      full: text,
      short: text,
      pointer: `[${taskId}]`,
      priority: 0,
    });
  }
  const currentChanges = new Set(git.changedPaths);
  if (git.headShort) {
    for (const file of git.changedPaths) {
      const text = `${file}: changed on this branch (commit ${git.headShort})`;
      fileItems.push({
        key: `file:${file}`,
        full: text,
        short: text,
        pointer: `(commit ${git.headShort})`,
        priority: 0,
      });
    }
  }
  if (latest && latestId) {
    for (const file of strings(asObject(latest.data.git)?.changed_paths)) {
      if (currentChanges.has(file)) continue;
      const text = `${file}: changed at the latest checkpoint [${latestId}]`;
      fileItems.push({
        key: `checkpoint-file:${file}`,
        full: text,
        short: text,
        pointer: `[${latestId}]`,
        priority: 0,
      });
    }
  }
  const files: BriefingSection = {
    key: "files",
    title: "Files changed or likely relevant",
    required: false,
    items: inDisplayOrder(fileItems, SECTION_PRIORITY.files),
    pointerNoun: "files",
  };

  // Verified behavior and checks run
  const checks: BriefingSection = {
    key: "checks",
    title: "Verified behavior and checks run",
    required: false,
    items: inDisplayOrder(
      warningsFirst(input.records.filter((r) => r.record.kind === "receipt")).map(receiptItem),
      SECTION_PRIORITY.checks,
    ),
  };

  // Failed approaches, from every checkpoint, newest first
  const failedItems: BriefingItem[] = [];
  const seen = new Set<string>();
  for (const checkpoint of input.checkpoints) {
    const cpId = idOf(checkpoint);
    for (const entry of asArray(checkpoint.data.failed_approaches)) {
      const data = asObject(entry);
      const approach = asString(data?.approach);
      const why = asString(data?.why_failed);
      if (!approach || !why) continue;
      const normalized = oneLine(approach).toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const receipts = strings(asObject(data?.evidence)?.receipts);
      const tail = ` [${cpId}]${markers(checkpoint.data)}`;
      failedItems.push({
        key: `failed:${cpId}:${failedItems.length}`,
        full: `${sentence(approach)} Failed because: ${sentence(why)}${receipts.length > 0 ? ` (${receipts.map((r) => `receipt ${r}`).join(", ")})` : ""}${tail}`,
        short: `${truncate(`${oneLine(approach)}: ${oneLine(why)}`, 140)}${tail}`,
        pointer: `[${cpId}]`,
        priority: 0,
      });
    }
  }
  const failed: BriefingSection = {
    key: "failed",
    title: "Failed approaches",
    required: false,
    items: inDisplayOrder(failedItems, SECTION_PRIORITY.failed),
  };

  // Open questions, from the latest checkpoint
  const questions: BriefingSection = {
    key: "questions",
    title: "Open questions",
    required: false,
    items:
      latest && latestId
        ? inDisplayOrder(
            strings(latest.data.open_questions).map((question, index) => {
              const text = `${sentence(question)} [${latestId}]`;
              return {
                key: `question:${latestId}:${index}`,
                full: text,
                short: text,
                pointer: `[${latestId}]`,
                priority: 0,
              };
            }),
            SECTION_PRIORITY.questions,
          )
        : [],
  };

  // Next safe action
  const fromCheckpoint = latest ? asString(latest.data.next_safe_action) : undefined;
  const nextText = fromCheckpoint ?? asString(task.next_action) ?? NOT_DETERMINED;
  const nextCite = fromCheckpoint && latestId ? latestId : taskId;
  const next: BriefingSection = {
    key: "next",
    title: "Next safe action",
    required: true,
    items: [fixed("next", `${sentence(nextText)} [${nextCite}]`)],
  };

  return [goal, state, decisions, files, checks, failed, questions, next];
}

function relationText(relation: CheckpointRelation | undefined): string {
  switch (relation?.kind) {
    case "head":
      return "that is the current HEAD";
    case "ahead": {
      const change =
        relation.codeChanged === false
          ? ", with no code changes since"
          : relation.codeChanged
            ? ", and the code has changed since"
            : "";
      return `HEAD is ${count(relation.commits ?? 0, "commit")} ahead of it${change}`;
    }
    case "other-line":
      return relation.codeChanged === false
        ? "HEAD is not a descendant of it, but the code is the same"
        : "HEAD is not a descendant of it, so its state may not apply here";
    default:
      return "its commit is not in this repository";
  }
}

function recordItem(candidate: ScoredCandidate): BriefingItem {
  const data = candidate.record.data;
  const id = candidate.id;
  const tail = ` [${id}]${markers(data, candidate.staleness)}`;
  const prefix =
    data.status === "proposed"
      ? "Proposed: "
      : data.status === "superseded"
        ? "Superseded: "
        : data.status === "deprecated"
          ? "Deprecated: "
          : "";
  const summary = `${prefix}${sentence(asString(data.summary) ?? id)}${tail}`;
  let full: string;
  if (candidate.record.kind === "decision") {
    const alternatives = asArray(data.alternatives).flatMap((entry) => {
      const alternative = asObject(entry);
      const option = asString(alternative?.option);
      const because = asString(alternative?.rejected_because);
      return option && because ? [`${oneLine(option)} (${oneLine(because)})`] : [];
    });
    full = `${prefix}${sentence(asString(data.chosen) ?? "")} Why: ${sentence(asString(data.rationale) ?? "")}${alternatives.length > 0 ? ` Rejected: ${alternatives.join("; ")}.` : ""}${tail}`;
  } else {
    full = `${prefix}${sentence(asString(data.body) ?? "")}${tail}`;
  }
  return { key: `record:${id}`, full, short: summary, pointer: `[${id}]`, priority: 0 };
}

function receiptItem(candidate: ScoredCandidate): BriefingItem {
  const data = candidate.record.data;
  const id = candidate.id;
  const git = asObject(data.git);
  const head = asString(git?.head) ?? "?";
  const code = String(data.exit_code);
  const outcome =
    data.result === "pass"
      ? "passed"
      : data.result === "fail"
        ? `failed (exit ${code})`
        : `errored (exit ${code})`;
  const freshness = candidate.atHead
    ? " (HEAD)"
    : candidate.codeChanged === false
      ? " (code unchanged since)"
      : candidate.codeChanged
        ? " (code has changed since)"
        : " (commit not in this repository)";
  const where = `at ${head}${freshness}`;
  const command = `\`${oneLine(asString(data.command) ?? "?")}\``;
  const lastLine = (asString(data.output_tail) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const tail = ` (receipt ${id})${markers(data, candidate.staleness)}`;
  return {
    key: `record:${id}`,
    full: `${command} ${outcome} ${where}, ${asString(data.ran_at) ?? "?"}${lastLine ? `; output ends: "${truncate(lastLine, 160)}"` : ""}.${tail}`,
    short: `${command} ${outcome} ${where}.${tail}`,
    pointer: `(receipt ${id})`,
    priority: 0,
  };
}
