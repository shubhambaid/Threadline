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
  saveRecord,
  unique,
  validAt,
} from "../core/write.js";
import { type Io, requireInitialized } from "./context.js";
import { type CommonWriteOptions, reportWrite } from "./report.js";
import { type StatusUpdateOptions, updateRecordCommand } from "./update.js";

export const KNOWLEDGE_CATEGORIES = ["architecture", "operations", "convention", "gotcha"] as const;
export const KNOWLEDGE_STATUSES = ["active", "deprecated"] as const;

export interface KnowledgeAddOptions extends CommonWriteOptions, EvidenceFlags {
  body: string;
  category: string;
  summary?: string;
  paths?: string[];
  link?: string[];
  human?: string;
  id?: string;
  maxFingerprints?: string;
}

export async function knowledgeAddCommand(io: Io, options: KnowledgeAddOptions): Promise<number> {
  if (!(KNOWLEDGE_CATEGORIES as readonly string[]).includes(options.category)) {
    throw new UsageError(`--category must be one of: ${KNOWLEDGE_CATEGORIES.join(", ")}`);
  }
  const root = await requireInitialized(io);
  const ctx = await openWriteContext(root, options.agent, io.env);
  const index = await loadRecordIndex(root);

  const paths = unique(options.paths);
  await assertSafePaths(ctx, paths, "--paths");
  const links = unique(options.link);
  assertReferences(index, links, "--link");

  const summary = truncate(options.summary ?? options.body, 280);
  const id = options.id ?? makeId("knowledge", options.summary ?? options.body, ctx.now);
  if (index.has(id)) throw new UsageError(`${id} already exists. Pass --id to choose another id.`);

  const { evidence, warnings } = await buildEvidence(
    ctx,
    index,
    options,
    options.human ? { name: options.human, note: "Confirmed this fact." } : undefined,
  );
  const anchored = await anchorFor(
    ctx,
    { scopePaths: paths, evidenceFiles: unique(options.evidenceFile) },
    options.maxFingerprints,
  );

  const record = compact({
    id,
    kind: "knowledge",
    schema_version: 1,
    summary,
    status: "active",
    confidence: confidenceFor(options.human),
    category: options.category,
    body: options.body.trim(),
    scope: { paths },
    links,
    evidence,
    created_by: createdBy(ctx, options.human),
    created_at: ctx.timestamp,
    valid_at: await validAt(root),
    anchor: anchored.anchor,
  });
  const file = await saveRecord(ctx, "knowledge", record);
  reportWrite(
    io,
    {
      id,
      file,
      warnings: [...warnings, ...anchored.warnings],
      message: `Created ${file} (${options.category}, ${record.confidence})`,
    },
    options.json,
  );
  return 0;
}

export function knowledgeUpdateCommand(
  io: Io,
  id: string,
  options: StatusUpdateOptions,
): Promise<number> {
  return updateRecordCommand(io, "knowledge", id, options, KNOWLEDGE_STATUSES);
}
