import { UsageError } from "../core/errors.js";
import { makeId } from "../core/ids.js";
import { type FieldSpec, merge, pick, readInputFile } from "../core/input.js";
import { loadRecordIndex } from "../core/records.js";
import { truncate } from "../core/text.js";
import {
  addHumanConfirmation,
  anchorFor,
  assertReferences,
  assertSafePaths,
  buildEvidence,
  compact,
  createdBy,
  type EvidenceFlags,
  openWriteContext,
  parsePair,
  saveRecord,
  unique,
  validAt,
} from "../core/write.js";
import { type Io, requireInitialized } from "./context.js";
import { type CommonWriteOptions, reportWrite } from "./report.js";
import { type StatusUpdateOptions, updateRecordCommand } from "./update.js";

export const DECISION_STATUSES = ["proposed", "accepted", "superseded"] as const;

export interface DecisionAddOptions extends CommonWriteOptions, EvidenceFlags {
  topic?: string;
  chosen?: string;
  rationale?: string;
  summary?: string;
  alternative?: string[];
  status?: string;
  paths?: string[];
  link?: string[];
  supersedes?: string[];
  human?: string;
  id?: string;
  maxFingerprints?: string;
  fromFile?: string;
}

const DECISION_FIELDS: FieldSpec = {
  id: "string",
  topic: "string",
  chosen: "string",
  rationale: "string",
  summary: "string",
  status: "string",
  alternatives: { pairs: ["option", "rejected_because"] },
  paths: "strings",
  links: "strings",
  supersedes: "strings",
  evidence: "evidence",
};

/** Fields from `--from-file`, merged under the flags: flags override strings and add to lists. */
export async function decisionOptions(
  io: Io,
  options: DecisionAddOptions,
): Promise<DecisionAddOptions & { topic: string; chosen: string; rationale: string }> {
  const input = options.fromFile
    ? await readInputFile(io, options.fromFile, DECISION_FIELDS)
    : undefined;
  const alternatives = (input?.pairs.alternatives ?? []).map(([option, because]) => {
    if (option.includes("::")) throw new UsageError('alternatives[].option must not contain "::"');
    return `${option}::${because}`;
  });
  const evidence = input?.evidence ?? {};
  const merged = {
    ...options,
    id: pick(options.id, input, "id"),
    topic: pick(options.topic, input, "topic"),
    chosen: pick(options.chosen, input, "chosen"),
    rationale: pick(options.rationale, input, "rationale"),
    summary: pick(options.summary, input, "summary"),
    status: pick(options.status, input, "status"),
    alternative: [...alternatives, ...(options.alternative ?? [])],
    paths: merge(options.paths, input, "paths"),
    link: merge(options.link, input, "links"),
    supersedes: merge(options.supersedes, input, "supersedes"),
    evidenceFile: [...(evidence.files ?? []), ...(options.evidenceFile ?? [])],
    commit: [...(evidence.commits ?? []), ...(options.commit ?? [])],
    check: [...(evidence.checks ?? []), ...(options.check ?? [])],
    receipt: [...(evidence.receipts ?? []), ...(options.receipt ?? [])],
    issue: [...(evidence.issues ?? []), ...(options.issue ?? [])],
    pr: [...(evidence.prs ?? []), ...(options.pr ?? [])],
  };
  for (const field of ["topic", "chosen", "rationale"] as const) {
    if (!merged[field]) {
      throw new UsageError(`--${field} is required (or ${field} in --from-file).`);
    }
  }
  return merged as DecisionAddOptions & { topic: string; chosen: string; rationale: string };
}

export async function decisionAddCommand(io: Io, flags: DecisionAddOptions): Promise<number> {
  const options = await decisionOptions(io, flags);
  const status = options.status ?? "accepted";
  if (!(DECISION_STATUSES as readonly string[]).includes(status)) {
    throw new UsageError(`--status must be one of: ${DECISION_STATUSES.join(", ")}`);
  }
  const root = await requireInitialized(io);
  const ctx = await openWriteContext(root, options.agent, io.env);
  const index = await loadRecordIndex(root);

  const paths = unique(options.paths);
  await assertSafePaths(ctx, paths, "--paths");
  const links = unique(options.link);
  assertReferences(index, links, "--link");
  const supersedes = unique(options.supersedes);
  assertReferences(index, supersedes, "--supersedes", "decision");
  const alternatives = (options.alternative ?? []).map((value) => {
    const [option, rejectedBecause] = parsePair(value, "--alternative");
    return { option, rejected_because: rejectedBecause };
  });

  const id = options.id ?? makeId("decision", options.topic, ctx.now);
  if (index.has(id)) {
    throw new UsageError(
      `${id} already exists. Pass --id for a new decision, and --supersedes ${id} if it replaces the old one.`,
    );
  }

  const { evidence, warnings } = await buildEvidence(ctx, index, options);
  const anchored = await anchorFor(
    ctx,
    { scopePaths: paths, evidenceFiles: unique(options.evidenceFile) },
    options.maxFingerprints,
  );

  const draft = compact({
    id,
    kind: "decision",
    schema_version: 1,
    summary: truncate(options.summary ?? options.chosen, 280),
    status,
    confidence: "agent-reported",
    topic: options.topic,
    chosen: options.chosen.trim(),
    rationale: options.rationale.trim(),
    alternatives,
    scope: { paths },
    links,
    evidence,
    supersedes,
    created_by: createdBy(ctx, options.human),
    created_at: ctx.timestamp,
    valid_at: await validAt(root),
    anchor: anchored.anchor,
  });
  const record = options.human
    ? addHumanConfirmation(ctx, "decision", draft, {
        name: options.human,
        note: "Confirmed this decision.",
      })
    : draft;
  const file = await saveRecord(ctx, "decision", record);
  reportWrite(
    io,
    {
      id,
      file,
      warnings: [...warnings, ...anchored.warnings],
      message: `Created ${file} (${status}, ${String(record.confidence)})`,
    },
    options.json,
  );
  return 0;
}

export function decisionUpdateCommand(
  io: Io,
  id: string,
  options: StatusUpdateOptions,
): Promise<number> {
  return updateRecordCommand(io, "decision", id, options, DECISION_STATUSES);
}
