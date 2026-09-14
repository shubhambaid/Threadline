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
  body?: string;
  category?: string;
  summary?: string;
  paths?: string[];
  link?: string[];
  human?: string;
  id?: string;
  maxFingerprints?: string;
  fromFile?: string;
}

const KNOWLEDGE_FIELDS: FieldSpec = {
  id: "string",
  category: "string",
  body: "string",
  summary: "string",
  paths: "strings",
  links: "strings",
  evidence: "evidence",
};

/** Fields from `--from-file`, merged under the flags: flags override strings and add to lists. */
async function knowledgeOptions(
  io: Io,
  options: KnowledgeAddOptions,
): Promise<KnowledgeAddOptions & { body: string; category: string }> {
  const input = options.fromFile
    ? await readInputFile(io, options.fromFile, KNOWLEDGE_FIELDS)
    : undefined;
  const evidence = input?.evidence ?? {};
  const merged = {
    ...options,
    id: pick(options.id, input, "id"),
    category: pick(options.category, input, "category"),
    body: pick(options.body, input, "body"),
    summary: pick(options.summary, input, "summary"),
    paths: merge(options.paths, input, "paths"),
    link: merge(options.link, input, "links"),
    evidenceFile: [...(evidence.files ?? []), ...(options.evidenceFile ?? [])],
    commit: [...(evidence.commits ?? []), ...(options.commit ?? [])],
    check: [...(evidence.checks ?? []), ...(options.check ?? [])],
    receipt: [...(evidence.receipts ?? []), ...(options.receipt ?? [])],
    issue: [...(evidence.issues ?? []), ...(options.issue ?? [])],
    pr: [...(evidence.prs ?? []), ...(options.pr ?? [])],
  };
  for (const field of ["category", "body"] as const) {
    if (!merged[field]) {
      throw new UsageError(`--${field} is required (or ${field} in --from-file).`);
    }
  }
  return merged as KnowledgeAddOptions & { body: string; category: string };
}

export async function knowledgeAddCommand(io: Io, flags: KnowledgeAddOptions): Promise<number> {
  const options = await knowledgeOptions(io, flags);
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

  const { evidence, warnings } = await buildEvidence(ctx, index, options);
  const anchored = await anchorFor(
    ctx,
    { scopePaths: paths, evidenceFiles: unique(options.evidenceFile) },
    options.maxFingerprints,
  );

  const draft = compact({
    id,
    kind: "knowledge",
    schema_version: 1,
    summary,
    status: "active",
    confidence: "agent-reported",
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
  const record = options.human
    ? addHumanConfirmation(ctx, "knowledge", draft, {
        name: options.human,
        note: "Confirmed this fact.",
      })
    : draft;
  const file = await saveRecord(ctx, "knowledge", record);
  reportWrite(
    io,
    {
      id,
      file,
      warnings: [...warnings, ...anchored.warnings],
      message: `Created ${file} (${options.category}, ${String(record.confidence)})`,
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
