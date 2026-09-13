import {
  buildBriefing,
  type CheckpointRelation,
  TARGETS,
  type Target,
} from "../compile/briefing.js";
import { collect, type GitState } from "../compile/collect.js";
import { type AssessedCandidate, rankCandidates } from "../compile/score.js";
import { now } from "../core/clock.js";
import { UsageError } from "../core/errors.js";
import { asObject, asString } from "../core/json.js";
import { loadManifest, type Manifest } from "../core/manifest.js";
import { checkRepoPath, scopeMatcher } from "../core/paths.js";
import { loadRecordIndex, requireRecord } from "../core/records.js";
import type { LoadedRecord } from "../core/store.js";
import { parseInteger } from "../core/write.js";
import {
  changedPathsSince,
  codeChangedBetween,
  commitsSince,
  currentBranch,
  headCommit,
  isDirty,
  mergeBase,
  resolveBranchRef,
  resolveCommit,
  shortSha,
} from "../git/git.js";
import { assessStaleness, createStalenessContext } from "../trust/staleness.js";
import { type Io, requireInitialized } from "./context.js";

export interface ResumeOptions {
  task?: string;
  target?: string;
  budget?: string;
  format?: string;
  agent?: string;
}

const OPEN_STATUSES = new Set(["active", "paused", "blocked", "proposed"]);

export async function resumeCommand(io: Io, options: ResumeOptions): Promise<number> {
  const target = options.target ?? "generic";
  if (!(TARGETS as readonly string[]).includes(target)) {
    throw new UsageError(`--target must be one of: ${TARGETS.join(", ")}`);
  }
  const format = options.format ?? "md";
  if (format !== "md" && format !== "json") throw new UsageError("--format must be md or json");

  const root = await requireInitialized(io);
  const { manifest, findings } = await loadManifest(root);
  if (!manifest) {
    const problems = findings.map((f) => `${f.path ?? f.file}: ${f.message}`).join("; ");
    throw new UsageError(`The manifest is invalid (${problems}). Run \`threadline validate\`.`);
  }
  const budget =
    options.budget === undefined
      ? manifest.defaults.budget
      : parseInteger(options.budget, "--budget", 200);

  const index = await loadRecordIndex(root);
  const git = await readGitState(root, manifest);
  const task = options.task
    ? requireRecord(index, options.task, "task", "--task")
    : inferTask(index, options.agent ?? io.env.THREADLINE_AGENT, git.branch);

  const collected = await collect(root, index, task, git, manifest);
  const staleness = await createStalenessContext(root, manifest);
  const assessed: AssessedCandidate[] = [];
  for (const candidate of [...collected.decisions, ...collected.knowledge, ...collected.receipts]) {
    const result = await assessStaleness(staleness, candidate.record.data);
    let atHead: boolean | undefined;
    let codeChanged: boolean | undefined;
    if (candidate.record.kind === "receipt") {
      const receiptHead = asString(asObject(candidate.record.data.git)?.head);
      const resolved = receiptHead ? await resolveCommit(root, receiptHead) : undefined;
      if (resolved && git.head) {
        atHead = resolved === git.head;
        codeChanged = atHead ? false : await codeChangedBetween(root, resolved, git.head);
      }
    }
    assessed.push({ ...candidate, staleness: result, atHead, codeChanged });
  }

  const latest = collected.checkpoints[0];
  const briefing = buildBriefing({
    target: target as Target,
    budget,
    now: now(io.env),
    task,
    checkpoints: collected.checkpoints,
    latestRelation: latest
      ? await relationToHead(root, asString(asObject(latest.data.git)?.head), git.head)
      : undefined,
    git,
    scopePaths: collected.scopePaths,
    records: rankCandidates(assessed),
  });

  if (format === "json") {
    const output = {
      task: briefing.taskId,
      target,
      budget,
      tokens: briefing.tokens,
      overBudget: briefing.overBudget,
      sections: briefing.sections,
    };
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    io.stdout(briefing.text);
  }
  if (briefing.overBudget) {
    io.stderr(
      `warning: the required sections alone exceed the budget of about ${budget} tokens.\n`,
    );
  }
  return 0;
}

async function readGitState(root: string, manifest: Manifest): Promise<GitState> {
  const head = await headCommit(root);
  if (!head) return { dirty: await isDirty(root), changedPaths: [] };
  const defaultRef = await resolveBranchRef(root, manifest.defaults.default_branch);
  const baseFull = defaultRef ? await mergeBase(root, head, defaultRef) : undefined;
  const forbidden = scopeMatcher(manifest.privacy.forbidden_globs);
  const [branch, dirty, headShort, base, changed] = await Promise.all([
    currentBranch(root),
    isDirty(root),
    shortSha(root, head),
    baseFull ? shortSha(root, baseFull) : Promise.resolve(undefined),
    changedPathsSince(root, baseFull),
  ]);
  return {
    head,
    headShort,
    branch,
    dirty,
    base,
    changedPaths: changed.filter((p) => checkRepoPath(p) === undefined && !forbidden(p)),
  };
}

function inferTask(
  index: ReadonlyMap<string, LoadedRecord>,
  agent: string | undefined,
  branch: string | undefined,
): LoadedRecord {
  const open = [...index.values()].filter(
    (record) => record.kind === "task" && OPEN_STATUSES.has(String(record.data.status)),
  );
  if (agent) {
    const mine = open.filter(
      (record) => record.data.status === "active" && asObject(record.data.owner)?.agent === agent,
    );
    if (mine.length === 1 && mine[0]) return mine[0];
  }
  const onBranch = open.filter((record) => branch !== undefined && record.data.branch === branch);
  if (onBranch.length === 1 && onBranch[0]) return onBranch[0];
  if (open.length === 1 && open[0]) return open[0];
  if (open.length === 0) {
    throw new UsageError("No open tasks to resume. Start one with `threadline task start`.");
  }
  throw new UsageError(
    `Several open tasks. Pass --task <id>: ${open.map((record) => record.data.id).join(", ")}`,
  );
}

async function relationToHead(
  root: string,
  checkpointHead: string | undefined,
  head: string | undefined,
): Promise<CheckpointRelation> {
  const resolved = checkpointHead ? await resolveCommit(root, checkpointHead) : undefined;
  if (!resolved || !head) return { kind: "unavailable" };
  if (resolved === head) return { kind: "head", codeChanged: false };
  const [commits, codeChanged] = await Promise.all([
    commitsSince(root, resolved, head),
    codeChangedBetween(root, resolved, head),
  ]);
  return commits === undefined
    ? { kind: "other-line", codeChanged }
    : { kind: "ahead", commits, codeChanged };
}
