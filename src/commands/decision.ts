import { UsageError } from "../core/errors.js";
import { makeId } from "../core/ids.js";
import { loadRecordIndex } from "../core/records.js";
import { truncate } from "../core/text.js";
import {
  anchorFor,
  assertReferences,
  assertSafePaths,
  buildEvidence,
  compact,
  confidenceFor,
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
  topic: string;
  chosen: string;
  rationale: string;
  summary?: string;
  alternative?: string[];
  status?: string;
  paths?: string[];
  link?: string[];
  supersedes?: string[];
  human?: string;
  id?: string;
  maxFingerprints?: string;
}

export async function decisionAddCommand(io: Io, options: DecisionAddOptions): Promise<number> {
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

  const { evidence, warnings } = await buildEvidence(
    ctx,
    index,
    options,
    options.human ? { name: options.human, note: "Confirmed this decision." } : undefined,
  );
  const anchored = await anchorFor(
    ctx,
    { scopePaths: paths, evidenceFiles: unique(options.evidenceFile) },
    options.maxFingerprints,
  );

  const record = compact({
    id,
    kind: "decision",
    schema_version: 1,
    summary: truncate(options.summary ?? options.chosen, 280),
    status,
    confidence: confidenceFor(options.human),
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
  const file = await saveRecord(ctx, "decision", record);
  reportWrite(
    io,
    {
      id,
      file,
      warnings: [...warnings, ...anchored.warnings],
      message: `Created ${file} (${status}, ${record.confidence})`,
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
