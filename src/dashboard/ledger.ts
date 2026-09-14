import path from "node:path";
import type { Io } from "../commands/context.js";
import { requireInitialized } from "../commands/context.js";
import { prepareTask } from "../commands/resume.js";
import { BUDGET_POLICY, buildBriefing } from "../compile/briefing.js";
import { digestOf } from "../core/anchor.js";
import { UsageError } from "../core/errors.js";
import { type Finding, sortFindings } from "../core/findings.js";
import { describeWriter } from "../core/identity.js";
import type { RecordKind } from "../core/ids.js";
import { asArray, asObject, asString } from "../core/json.js";
import { isGlob } from "../core/paths.js";
import { type LoadedRecord, loadRecords } from "../core/store.js";
import { oneLine, truncate } from "../core/text.js";
import {
  createGitLookups,
  currentBranch,
  git,
  hashWorkingTreeFiles,
  headCommit,
  isDirty,
  shortSha,
} from "../git/git.js";
import {
  type ConfirmationLevel,
  type ConfirmationState,
  confirmationState,
} from "../trust/claims.js";
import {
  createOverlapCheck,
  findCompetingClaims,
  findContradictionPairs,
  findOrphanedCheckpoints,
  findOverlappingClaims,
  findUnretiredSupersessions,
} from "../trust/conflicts.js";
import {
  assessReceipt,
  createReceiptContext,
  describeApplicability,
  type ReceiptApplicability,
  type ReceiptAssessment,
} from "../trust/receipts.js";
import {
  assessStaleness,
  createStalenessContext,
  type DerivedStatus,
  type StalenessResult,
} from "../trust/staleness.js";
import { assessLedger } from "../validate/assess.js";
import { validateRepository } from "../validate/index.js";
import { collectPaths, collectReferences } from "../validate/references.js";

export type NodeType = RecordKind | "session" | "commit" | "file";

/**
 * How an edge is known (docs/dashboard.md). `explicit`: a field in a record states it.
 * `inferred`: derived from paths or from the order of recorded work. `delivered`: a recorded
 * briefing delivery; Aletheic does not record deliveries yet, so no edge has this basis.
 */
export type EdgeBasis = "explicit" | "inferred" | "delivered";

export type EdgeType =
  | "authored"
  | "owns"
  | "checkpoint-for"
  | "links"
  | "cites"
  | "supersedes"
  | "anchored-to"
  | "evidence"
  | "relevant-to"
  | "handoff";

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  summary?: string;
  status?: string;
  confidence?: string;
  /** When the record was written. */
  at?: string;
  /** Session node id of the author. */
  session?: string;
  /** For tasks, their own id; for checkpoints, the task they belong to. */
  task?: string;
  branch?: string;
  /** Record file, repository-relative. */
  file?: string;
  model?: string;
  freshness?: DerivedStatus;
  freshnessReason?: string;
  review?: string;
  trust?: ConfirmationLevel;
  human?: string;
  applicability?: ReceiptApplicability;
  applicabilityText?: string;
  result?: string;
  observed?: boolean;
  disputed?: boolean;
  owner?: string;
  ownerSession?: string;
  leaseExpired?: boolean;
  /** The record failed validation: only its file and finding codes are shown. */
  withheld?: boolean;
  codes?: string[];
  errors: number;
  warnings: number;
  /** Commits and files: shown only when the viewer expands them. */
  detail?: boolean;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: EdgeType;
  basis: EdgeBasis;
  label: string;
  /** Why the edge exists, in words. */
  explanation: string;
  /** Handoffs connect sessions through a task and the records on either side. */
  via?: { task: string; fromRecord: string; toRecord: string };
}

export interface SessionInfo {
  id: string;
  agent: string;
  session: string | null;
  label: string;
  records: number;
  first?: string;
  last?: string;
}

export interface TimelineEvent {
  at: string;
  kind: string;
  text: string;
  record?: string;
  session?: string;
  basis: EdgeBasis;
}

export type HealthGroup = "validity" | "freshness" | "conflicts" | "claims" | "checks" | "trust";

export interface HealthItem extends Finding {
  group: HealthGroup;
  /** Graph node the item is about, when it is about a record. */
  record?: string;
}

export interface DashboardModel {
  version: string;
  generatedAt: string;
  view: { kind: "working-tree"; note: string };
  repository: {
    project: string | null;
    branch: string | null;
    head: string | null;
    headShort: string | null;
    dirty: boolean;
  };
  counts: Record<RecordKind | "withheld" | "unloadable", number>;
  sessions: SessionInfo[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  timeline: TimelineEvent[];
  health: { items: HealthItem[]; errors: number; warnings: number };
  delivery: { recorded: false; note: string };
}

const MAX_INFERRED_PER_TASK = 500;
const VIEW_NOTE =
  "Records and files as they are in this working tree now, including uncommitted changes. Historical views of earlier commits are not available yet.";
const DELIVERY_NOTE =
  "Aletheic does not record which briefing an agent received, so no relationship here claims that an agent read or used a record. Handoffs are inferred from the order of recorded work.";

const GROUPS: Record<string, HealthGroup> = {
  "needs-reverification": "freshness",
  diverged: "freshness",
  "uncertain-applicability": "freshness",
  contradiction: "conflicts",
  "superseded-still-accepted": "conflicts",
  "expired-lease": "claims",
  "overlapping-claim": "claims",
  "competing-claim": "claims",
  "orphaned-checkpoint": "claims",
  "confirmation-outdated": "trust",
};

function strings(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

function idOf(record: LoadedRecord): string {
  return asString(record.data.id) ?? record.file;
}

export function sessionNodeId(agent: string | undefined, session: string | undefined) {
  return agent ? `session:${agent}#${session ?? ""}` : undefined;
}

function byTime(a: LoadedRecord, b: LoadedRecord): number {
  return (
    (asString(a.data.created_at) ?? "").localeCompare(asString(b.data.created_at) ?? "") ||
    idOf(a).localeCompare(idOf(b))
  );
}

/**
 * A digest of everything the dashboard shows: record files, HEAD, and uncommitted changes. The
 * page polls it and reloads the model when it changes.
 */
export async function ledgerVersion(root: string): Promise<string> {
  const [store, head, diff, untracked] = await Promise.all([
    loadRecords(root),
    headCommit(root),
    git(root, ["diff", "HEAD", "--no-ext-diff", "--binary"]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return digestOf(
    [
      head ?? "",
      ...store.records.map((record) => `${record.file}\0${record.text}`),
      ...store.findings.map((finding) => `${finding.file ?? ""}\0${finding.message}`),
      diff.stdout,
      untracked.stdout,
    ].join("\n"),
  );
}

/**
 * The dashboard's read model (docs/dashboard.md), built from the same assessment, freshness,
 * receipt, conflict, and validation code the CLI uses, so the two always agree. Records that
 * failed validation appear only as withheld nodes with their file and finding codes.
 */
export async function buildDashboardModel(io: Io, now: Date): Promise<DashboardModel> {
  const root = await requireInitialized(io);
  const ledger = await assessLedger(root);
  const manifest = ledger.settings;
  const [report, head, branch, dirty, version] = await Promise.all([
    validateRepository(root, { now, ledger }),
    headCommit(root),
    currentBranch(root),
    isDirty(root),
    ledgerVersion(root),
  ]);
  const headShort = head ? await shortSha(root, head) : undefined;
  const overlaps = createOverlapCheck(root, manifest);
  const staleness = await createStalenessContext(root, manifest);
  const receipts = createReceiptContext(root, manifest, { head, dirty }, createGitLookups(root));

  const usable = [...ledger.index.values()].sort(byTime);
  const byId = ledger.index;
  const coordination = [
    ...(await findOverlappingClaims(usable, overlaps, now)),
    ...findCompetingClaims(usable),
    ...findOrphanedCheckpoints(usable),
    ...findUnretiredSupersessions(usable),
  ];
  const contradictions = await findContradictionPairs(usable, overlaps);
  const disputed = new Set(
    contradictions.flatMap(({ older, newer }) => [idOf(older), idOf(newer)]),
  );

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeIds = new Set<string>();
  const addEdge = (edge: Omit<GraphEdge, "id">) => {
    if (edge.from === edge.to) return;
    const id = `${edge.type}:${edge.from}->${edge.to}${edge.via ? `:${edge.via.task}:${edge.via.toRecord}` : ""}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ id, ...edge });
  };

  const sessions = new Map<string, SessionInfo>();
  const touch = (writer: unknown, at: string | undefined): SessionInfo | undefined => {
    const data = asObject(writer);
    const agent = asString(data?.agent);
    const session = asString(data?.session);
    const id = sessionNodeId(agent, session);
    if (!id || !agent) return undefined;
    let info = sessions.get(id);
    if (!info) {
      info = {
        id,
        agent,
        session: session ?? null,
        label: describeWriter({ agent, session }),
        records: 0,
      };
      sessions.set(id, info);
    }
    if (at) {
      if (!info.first || at < info.first) info.first = at;
      if (!info.last || at > info.last) info.last = at;
    }
    return info;
  };

  const timeline: TimelineEvent[] = [];
  const derivedHealth: HealthItem[] = [];

  for (const record of usable) {
    const { data } = record;
    const id = idOf(record);
    const at = asString(data.created_at);
    const author = touch(data.created_by, at);
    if (author) author.records++;
    const node: GraphNode = {
      id,
      type: record.kind,
      label: truncate(oneLine(asString(data.summary) ?? id), 90),
      summary: asString(data.summary),
      status: asString(data.status),
      confidence: asString(data.confidence),
      at,
      session: author?.id,
      file: record.file,
      errors: 0,
      warnings: 0,
    };
    const model = asString(asObject(data.created_by)?.model);
    if (model) node.model = model;
    const confirmation = confirmationState(record.kind, data);
    if (confirmation.level !== "none") {
      node.trust = confirmation.level;
      if (confirmation.name) node.human = confirmation.name;
    }
    if (disputed.has(id)) node.disputed = true;
    if (author) {
      addEdge({
        from: author.id,
        to: id,
        type: "authored",
        basis: "explicit",
        label: "wrote",
        explanation: `created_by names ${author.label}.`,
      });
    }

    if (record.kind === "task") {
      node.task = id;
      node.branch = asString(data.branch);
      const owner = asObject(data.owner);
      const claimedAt = asString(owner?.claimed_at);
      const holder = touch(owner, claimedAt);
      if (holder) {
        node.owner = holder.label;
        node.ownerSession = holder.id;
        const lease = asString(owner?.lease_expires_at);
        node.leaseExpired = lease !== undefined && Date.parse(lease) <= now.getTime();
        addEdge({
          from: holder.id,
          to: id,
          type: "owns",
          basis: "explicit",
          label: node.status === "active" ? "holds" : "last held",
          explanation: `owner names ${holder.label}, claimed ${claimedAt ?? "?"}, lease ${node.leaseExpired ? "expired" : "until"} ${lease ?? "?"}.`,
        });
      }
      timeline.push({
        at: at ?? "",
        kind: "task-started",
        text: `Started ${id}: ${node.label}`,
        record: id,
        session: author?.id,
        basis: "explicit",
      });
      if (holder && claimedAt && claimedAt !== at) {
        timeline.push({
          at: claimedAt,
          kind: "task-claimed",
          text: `${holder.label} claimed ${id}`,
          record: id,
          session: holder.id,
          basis: "explicit",
        });
      }
      const updated = asString(data.updated_at);
      if (updated && node.status && node.status !== "active") {
        timeline.push({
          at: updated,
          kind: `task-${node.status}`,
          text: `${id} is ${node.status}`,
          record: id,
          basis: "explicit",
        });
      }
    } else if (record.kind === "checkpoint") {
      node.task = asString(data.task);
      node.branch = asString(asObject(data.git)?.branch);
      if (node.task && byId.has(node.task)) {
        addEdge({
          from: id,
          to: node.task,
          type: "checkpoint-for",
          basis: "explicit",
          label: "checkpoint for",
          explanation: `task names ${node.task}.`,
        });
      }
      const next = asString(data.next_safe_action);
      timeline.push({
        at: at ?? "",
        kind: "checkpoint",
        text: `Checkpoint on ${node.task ?? "?"}${next ? `; next: ${truncate(next, 100)}` : ""}`,
        record: id,
        session: author?.id,
        basis: "explicit",
      });
    } else if (record.kind === "decision" || record.kind === "knowledge") {
      const result = await assessStaleness(staleness, data);
      node.freshness = result.status;
      if (result.reasons[0]) node.freshnessReason = result.reasons[0];
      if (result.review) node.review = result.review;
      if (result.status === "uncertain" && result.anchor === "none") {
        derivedHealth.push({
          severity: "info",
          code: "unanchored-claim",
          group: "freshness",
          file: record.file,
          record: id,
          message: `${id}: ${result.reasons[0] ?? "applicability unknown"}`,
          hint: `Re-anchor it after checking it: \`alethic verify ${id}\`.`,
        });
      }
      timeline.push({
        at: at ?? "",
        kind: record.kind,
        text:
          record.kind === "decision"
            ? `Decided ${asString(data.topic) ?? ""}: ${node.label}`
            : `Recorded: ${node.label}`,
        record: id,
        session: author?.id,
        basis: "explicit",
      });
    } else if (record.kind === "receipt") {
      const assessment = await assessReceipt(receipts, data);
      node.applicability = assessment.applicability;
      node.applicabilityText = describeApplicability(assessment).full;
      node.observed = assessment.observed;
      node.result = asString(data.result);
      node.branch = asString(asObject(data.git)?.branch);
      if (
        assessment.applicability === "content-changed" ||
        assessment.applicability === "changed-during-run" ||
        assessment.applicability === "uncommitted"
      ) {
        derivedHealth.push({
          severity: "warning",
          code: "check-applicability",
          group: "checks",
          file: record.file,
          record: id,
          message: `\`${oneLine(asString(data.command) ?? "?")}\` ${node.result ?? ""}: ${describeApplicability(assessment).full}`,
          hint: "Run the check again before relying on its result: `alethic receipt run -- <command>`.",
        });
      }
      timeline.push({
        at: asString(data.ran_at) ?? at ?? "",
        kind: "check",
        text: `\`${truncate(oneLine(asString(data.command) ?? "?"), 80)}\` ${node.result ?? "recorded"} (${assessment.observed ? "observed" : "reported"})`,
        record: id,
        session: author?.id,
        basis: "explicit",
      });
    }
    nodes.set(id, node);

    // Explicit references between records.
    for (const ref of collectReferences(data)) {
      if (ref.path === "task" || !byId.has(ref.id)) continue;
      if (ref.path.startsWith("links")) {
        addEdge({
          from: id,
          to: ref.id,
          type: "links",
          basis: "explicit",
          label: "links to",
          explanation: `${id} lists ${ref.id} in links.`,
        });
      } else if (ref.path.startsWith("supersedes")) {
        addEdge({
          from: id,
          to: ref.id,
          type: "supersedes",
          basis: "explicit",
          label: "supersedes",
          explanation: `${id} lists ${ref.id} in supersedes.`,
        });
      } else if (ref.expected === "receipt") {
        addEdge({
          from: id,
          to: ref.id,
          type: "cites",
          basis: "explicit",
          label: "cites",
          explanation: `${id} cites ${ref.id} in ${ref.path}.`,
        });
      }
    }

    // Git evidence, shown on request.
    const commits = new Set<string>();
    for (const value of [
      asString(asObject(data.anchor)?.commit),
      asString(asObject(data.git)?.head),
    ]) {
      if (value) commits.add(value.slice(0, 7));
    }
    for (const commit of commits) {
      const commitId = `commit:${commit}`;
      if (!nodes.has(commitId)) {
        nodes.set(commitId, {
          id: commitId,
          type: "commit",
          label: commit,
          detail: true,
          errors: 0,
          warnings: 0,
        });
      }
      addEdge({
        from: id,
        to: commitId,
        type: "anchored-to",
        basis: "explicit",
        label:
          record.kind === "receipt" || record.kind === "checkpoint" ? "at commit" : "anchored at",
        explanation:
          record.kind === "receipt" || record.kind === "checkpoint"
            ? `git.head is ${commit}.`
            : `anchor.commit is ${commit}. Freshness compares file content, not this commit.`,
      });
    }
    for (const field of collectPaths(data)) {
      if (field.role !== "evidence" || isGlob(field.value)) continue;
      const fileId = `file:${field.value}`;
      if (!nodes.has(fileId)) {
        nodes.set(fileId, {
          id: fileId,
          type: "file",
          label: field.value,
          detail: true,
          errors: 0,
          warnings: 0,
        });
      }
      addEdge({
        from: id,
        to: fileId,
        type: "evidence",
        basis: "explicit",
        label: "cites file",
        explanation: `${field.path} names ${field.value}.`,
      });
    }
  }

  // Inferred: decisions and knowledge whose paths overlap a task's scope, without a link.
  for (const task of usable.filter((record) => record.kind === "task")) {
    const taskId = idOf(task);
    const scope = strings(asObject(task.data.scope)?.paths);
    if (scope.length === 0) continue;
    let added = 0;
    for (const record of usable) {
      if (record.kind !== "decision" && record.kind !== "knowledge") continue;
      const id = idOf(record);
      if (strings(record.data.links).includes(taskId) || strings(task.data.links).includes(id))
        continue;
      const paths = collectPaths(record.data)
        .filter((field) => field.role === "scope" || field.role === "evidence")
        .map((field) => field.value);
      if (paths.length === 0 || !(await overlaps(paths, scope))) continue;
      addEdge({
        from: id,
        to: taskId,
        type: "relevant-to",
        basis: "inferred",
        label: "relevant to",
        explanation: `Its paths (${paths.slice(0, 3).join(", ")}) overlap the task's scope (${scope.slice(0, 3).join(", ")}). Inferred from paths; no record links them.`,
      });
      if (++added >= MAX_INFERRED_PER_TASK) break;
    }
  }

  // Inferred: handoffs, from the order of recorded work on each task by different writers.
  for (const task of usable.filter((record) => record.kind === "task")) {
    const taskId = idOf(task);
    const touches: { at: string; writer: string; record: string }[] = [];
    const push = (writer: unknown, at: string | undefined, record: string) => {
      const data = asObject(writer);
      const id = sessionNodeId(asString(data?.agent), asString(data?.session));
      if (id && at) touches.push({ at, writer: id, record });
    };
    push(task.data.created_by, asString(task.data.created_at), taskId);
    const owner = asObject(task.data.owner);
    push(owner, asString(owner?.claimed_at), taskId);
    for (const record of usable) {
      const linked =
        (record.kind === "checkpoint" && record.data.task === taskId) ||
        (record.kind !== "task" && strings(record.data.links).includes(taskId));
      if (linked) push(record.data.created_by, asString(record.data.created_at), idOf(record));
    }
    touches.sort((a, b) => a.at.localeCompare(b.at) || a.record.localeCompare(b.record));
    for (let i = 1; i < touches.length; i++) {
      const previous = touches[i - 1];
      const next = touches[i];
      if (!previous || !next || previous.writer === next.writer) continue;
      const from = sessions.get(previous.writer)?.label ?? previous.writer;
      const to = sessions.get(next.writer)?.label ?? next.writer;
      addEdge({
        from: previous.writer,
        to: next.writer,
        type: "handoff",
        basis: "inferred",
        label: `handoff on ${taskId}`,
        explanation: `${to} worked on ${taskId} after ${from}: ${previous.record} at ${previous.at}, then ${next.record} at ${next.at}. This is the order of recorded work; nothing records that ${to} read ${previous.record}.`,
        via: { task: taskId, fromRecord: previous.record, toRecord: next.record },
      });
      timeline.push({
        at: next.at,
        kind: "handoff",
        text: `Handoff on ${taskId}: ${from} → ${to} (inferred)`,
        record: next.record,
        session: next.writer,
        basis: "inferred",
      });
    }
  }

  for (const entry of ledger.excluded) {
    const id = `withheld:${entry.file}`;
    nodes.set(id, {
      id,
      type: entry.kind,
      label: `${path.posix.basename(entry.file)} (withheld)`,
      file: entry.file,
      withheld: true,
      codes: entry.codes,
      errors: 0,
      warnings: 0,
    });
  }

  const nodeByFile = new Map<string, string>();
  for (const node of nodes.values()) if (node.file) nodeByFile.set(node.file, node.id);
  const items: HealthItem[] = [
    ...sortFindings([...report.findings, ...coordination]).map((finding): HealthItem => {
      const record = finding.file ? nodeByFile.get(finding.file) : undefined;
      const node = record ? nodes.get(record) : undefined;
      if (node && finding.severity === "error") node.errors++;
      if (node && finding.severity === "warning") node.warnings++;
      return {
        ...finding,
        group: GROUPS[finding.code] ?? "validity",
        ...(record ? { record } : {}),
      };
    }),
    ...derivedHealth,
  ];

  const counts = {
    task: 0,
    decision: 0,
    knowledge: 0,
    checkpoint: 0,
    receipt: 0,
    withheld: ledger.excluded.length,
    unloadable: ledger.unloadable.length,
  };
  for (const record of usable) counts[record.kind]++;

  return {
    version,
    generatedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    view: { kind: "working-tree", note: VIEW_NOTE },
    repository: {
      project: ledger.manifest?.project.name ?? null,
      branch: branch ?? null,
      head: head ?? null,
      headShort: headShort ?? null,
      dirty,
    },
    counts,
    sessions: [...sessions.values()].sort(
      (a, b) => (a.first ?? "").localeCompare(b.first ?? "") || a.id.localeCompare(b.id),
    ),
    nodes: [...nodes.values()],
    edges,
    timeline: timeline.sort(
      (a, b) =>
        a.at.localeCompare(b.at) ||
        (a.record ?? "").localeCompare(b.record ?? "") ||
        a.kind.localeCompare(b.kind),
    ),
    health: {
      items,
      errors: items.filter((item) => item.severity === "error").length,
      warnings: items.filter((item) => item.severity === "warning").length,
    },
    delivery: { recorded: false, note: DELIVERY_NOTE },
  };
}

export interface AnchorRow {
  path: string;
  role: "direct" | "context";
  anchored: string | null;
  current: string | null;
  state: "same" | "changed" | "missing";
}

export type RecordInspection =
  | {
      id: string;
      withheld: true;
      files: string[];
      codes: string[];
      findings: Finding[];
    }
  | {
      id: string;
      withheld: false;
      kind: RecordKind;
      file: string;
      revision: string;
      text: string;
      data: Record<string, unknown>;
      author: string;
      trust: string;
      staleness: StalenessResult;
      confirmation: ConfirmationState;
      receipt?: ReceiptAssessment & { text: string };
      anchor: { commit: string | null; rows: AnchorRow[] };
      findings: Finding[];
    };

/** One record for the inspector, with the same derived assessments as `alethic show`. */
export async function inspectRecord(io: Io, id: string, now: Date): Promise<RecordInspection> {
  const root = await requireInitialized(io);
  const ledger = await assessLedger(root);
  const record = ledger.index.get(id);
  if (!record) {
    const withheld = ledger.excluded.filter((entry) => entry.id === id);
    if (withheld.length === 0) throw new UsageError(`${id} does not exist`);
    const files = withheld.map((entry) => entry.file);
    return {
      id,
      withheld: true,
      files,
      codes: [...new Set(withheld.flatMap((entry) => entry.codes))].sort(),
      findings: ledger.findings.filter((finding) => finding.file && files.includes(finding.file)),
    };
  }
  const manifest = ledger.settings;
  const { data } = record;
  const staleness = await assessStaleness(await createStalenessContext(root, manifest), data);
  const confirmation = confirmationState(record.kind, data);
  let receipt: (ReceiptAssessment & { text: string }) | undefined;
  if (record.kind === "receipt") {
    const [head, dirty] = await Promise.all([headCommit(root), isDirty(root)]);
    const assessment = await assessReceipt(
      createReceiptContext(root, manifest, { head, dirty }),
      data,
    );
    receipt = { ...assessment, text: describeApplicability(assessment).full };
  }

  const anchor = asObject(data.anchor);
  const fingerprints = asObject(anchor?.fingerprints) ?? {};
  const anchoredFiles = Object.keys(fingerprints).sort();
  const current = await hashWorkingTreeFiles(root, anchoredFiles);
  const evidence = new Set(
    collectPaths(data)
      .filter((f) => f.role === "evidence")
      .map((f) => f.value),
  );
  const exactScope = new Set(strings(asObject(data.scope)?.paths).filter((p) => !isGlob(p)));
  const hasDirect = evidence.size > 0 || anchoredFiles.some((file) => exactScope.has(file));
  const rows: AnchorRow[] = anchoredFiles.map((file) => {
    const anchored = asString(fingerprints[file]) ?? null;
    const now = current.get(file) ?? null;
    return {
      path: file,
      role: !hasDirect || evidence.has(file) || exactScope.has(file) ? "direct" : "context",
      anchored,
      current: now,
      state: now === null ? "missing" : now === anchored ? "same" : "changed",
    };
  });

  const report = await validateRepository(root, { now, ledger });
  const author = asObject(data.created_by);
  return {
    id,
    withheld: false,
    kind: record.kind,
    file: record.file,
    revision: digestOf(record.text),
    text: record.text,
    data,
    author: describeWriter({ agent: asString(author?.agent), session: asString(author?.session) }),
    trust: explainTrust(data, confirmation),
    staleness,
    confirmation,
    ...(receipt ? { receipt } : {}),
    anchor: { commit: asString(anchor?.commit) ?? null, rows },
    findings: report.findings.filter((finding) => finding.file === record.file),
  };
}

/** What a trust label establishes for this record, in words (docs/spec.md §8.1). */
export function explainTrust(
  data: Record<string, unknown>,
  confirmation: ConfirmationState,
): string {
  const created = asObject(data.created_by);
  const author = describeWriter({
    agent: asString(created?.agent),
    session: asString(created?.session),
  });
  const who = confirmation.name ?? "a person";
  switch (asString(data.confidence)) {
    case "human-confirmed":
      if (confirmation.level === "attributed") {
        return `${confirmation.recordedBy ?? author} recorded that ${who} confirmed this exact text${confirmation.at ? ` at ${confirmation.at}` : ""}. The name is an attribution, not an authenticated identity.`;
      }
      if (confirmation.level === "outdated") {
        return `${who} confirmed an earlier version of this text. It was edited since, so it counts as reported by ${author}.`;
      }
      return `Labeled as confirmed by ${who}, but the confirmation is not tied to this text, so later edits cannot be ruled out. The name is not authenticated.`;
    case "ci-reported":
      return `Reported by ${author} from an environment that said it was CI. Any process can say that, so it carries the same weight as an agent's report.`;
    case "inferred":
      return `Derived by ${author} from code or history; nobody observed it directly.`;
    default:
      return `Reported by ${author}: that agent's own account, which nobody else has checked.`;
  }
}

/** What `alethic resume` would give an agent for this task now, with the compiler's reasons. */
export async function inspectBriefing(io: Io, task: string, budget: number, now: Date) {
  const prepared = await prepareTask(io, { task });
  const briefing = buildBriefing({
    target: "generic",
    budget,
    now,
    task: prepared.task,
    checkpoints: prepared.checkpoints,
    latestRelation: prepared.latestRelation,
    git: prepared.git,
    scopePaths: prepared.scopePaths,
    records: prepared.records,
    integrity: prepared.integrity,
  });
  return {
    task: briefing.taskId,
    budget,
    tokens: briefing.tokens,
    overBudget: briefing.overBudget,
    report: briefing.report,
    policy: BUDGET_POLICY,
    sections: briefing.sections,
    skipped: prepared.skipped,
    text: briefing.text,
    note: "What `alethic resume` would give an agent for this task now. It is not a record that any agent received it.",
  };
}
