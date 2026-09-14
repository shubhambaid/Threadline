import { UsageError } from "../core/errors.js";
import { APPEND_ONLY_KINDS } from "../core/ids.js";
import { asArray, asObject, asString } from "../core/json.js";
import { loadRecordIndex, requireRecord } from "../core/records.js";
import {
  anchorFor,
  assertFilesExist,
  assertReferences,
  openWriteContext,
  saveRecord,
  unique,
  validAt,
} from "../core/write.js";
import { assessStaleness, createStalenessContext } from "../trust/staleness.js";
import { type Io, requireInitialized } from "./context.js";
import { type CommonWriteOptions, reportWrite } from "./report.js";

export interface VerifyOptions extends CommonWriteOptions {
  human?: string;
  note?: string;
  receipt?: string[];
  maxFingerprints?: string;
}

const RETIRED = new Set(["superseded", "deprecated", "done", "abandoned"]);
/** Levels an unchanged anchor may keep without a person confirming again. */
const KEEPABLE = new Set(["agent-reported", "ci-reported", "human-confirmed"]);

function strings(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

function sameAnchor(before: unknown, after: unknown): boolean {
  const a = asObject(before);
  const b = asObject(after);
  if (!a || !b) return false;
  const entries = (value: unknown) =>
    JSON.stringify(Object.entries(asObject(value) ?? {}).sort(([x], [y]) => x.localeCompare(y)));
  const overflow = (value: unknown) => {
    const o = asObject(value);
    return o ? `${String(o.count)} ${String(o.digest)}` : "";
  };
  return (
    entries(a.fingerprints) === entries(b.fingerprints) &&
    overflow(a.overflow) === overflow(b.overflow)
  );
}

/**
 * Re-anchors a record to HEAD after someone checked it still holds (docs/spec.md §8 rule 3, §9).
 * Confidence rises only to `human-confirmed`, and only with a named human. When the anchored
 * content changed, an earlier human or CI label is not carried over onto code nobody confirmed.
 */
export async function verifyCommand(io: Io, id: string, options: VerifyOptions): Promise<number> {
  if (options.note && !options.human) throw new UsageError("--note describes a --human check.");
  const root = await requireInitialized(io);
  const ctx = await openWriteContext(root, options.agent, io.env);
  const index = await loadRecordIndex(root);
  const record = requireRecord(index, id);
  if (APPEND_ONLY_KINDS.has(record.kind)) {
    throw new UsageError(
      `${id} is a ${record.kind}, and ${record.kind}s are append-only. Record a new one instead.`,
    );
  }
  const status = asString(record.data.status) ?? "";
  if (RETIRED.has(status)) {
    throw new UsageError(`${id} is ${status}. Verify the record that replaced it instead.`);
  }

  const head = await validAt(root);
  if (!head) throw new UsageError("Verifying needs at least one commit to anchor to.");

  const data = record.data;
  const evidence = asObject(data.evidence) ?? {};
  const evidenceFiles = strings(evidence.files);
  try {
    await assertFilesExist(ctx, evidenceFiles, "evidence.files");
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    throw new UsageError(
      `${error.message}. Remove it from ${record.file} (or supersede the record), then verify again.`,
    );
  }
  const receipts = unique(options.receipt);
  assertReferences(index, receipts, "--receipt", "receipt");

  const before = await assessStaleness(await createStalenessContext(root, ctx.manifest), data);
  const anchored = await anchorFor(
    ctx,
    { scopePaths: strings(asObject(data.scope)?.paths), evidenceFiles },
    options.maxFingerprints,
  );

  const previous = asString(data.confidence) ?? "inferred";
  const unchanged = sameAnchor(data.anchor, anchored.anchor);
  const confidence = options.human
    ? "human-confirmed"
    : unchanged && KEEPABLE.has(previous)
      ? previous
      : "agent-reported";
  const warnings = [...anchored.warnings];
  if (!options.human && KEEPABLE.has(previous) && previous !== confidence) {
    warnings.push(
      `Confidence changed from ${previous} to agent-reported: the anchored content changed since it was confirmed. Pass --human <name> if a person checked it again.`,
    );
  }

  const nextEvidence: Record<string, unknown> = { ...evidence };
  if (receipts.length > 0)
    nextEvidence.receipts = unique([...strings(evidence.receipts), ...receipts]);
  if (options.human) {
    nextEvidence.human = [
      ...asArray(evidence.human),
      { name: options.human, at: ctx.timestamp, note: options.note ?? `Verified at ${head}.` },
    ];
  }

  const updated: Record<string, unknown> = {
    ...data,
    confidence,
    valid_at: head,
    anchor: anchored.anchor,
    updated_at: ctx.timestamp,
  };
  if (Object.keys(nextEvidence).length > 0) updated.evidence = nextEvidence;
  if (!anchored.anchor) delete updated.anchor;
  const file = await saveRecord(ctx, record.kind, updated, { overwrite: true });

  const was =
    before.status === "unchanged" || before.status === "unanchored"
      ? before.status
      : `${before.status}: ${before.reasons[0] ?? ""}`;
  reportWrite(
    io,
    {
      id,
      file,
      warnings,
      message: [
        `Verified ${id} at ${head}`,
        `  was: ${was}`,
        `  confidence: ${confidence}${options.human ? ` (confirmed by ${options.human})` : ""}`,
        `  anchor: ${Object.keys(anchored.anchor?.fingerprints ?? {}).length} files fingerprinted`,
      ].join("\n"),
      details: { previousStatus: before.status, confidence, validAt: head },
    },
    options.json,
  );
  return 0;
}
