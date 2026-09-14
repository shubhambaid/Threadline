import { now } from "../core/clock.js";
import { type Finding, sortFindings } from "../core/findings.js";
import { asArray, asObject, asString } from "../core/json.js";
import { resolveManifest } from "../core/manifest.js";
import { loadRecordIndex } from "../core/records.js";
import { openWriteContext, saveRecord } from "../core/write.js";
import {
  createOverlapCheck,
  findCompetingClaims,
  findOrphanedCheckpoints,
  findOverlappingClaims,
  findUnretiredSupersessions,
} from "../trust/conflicts.js";
import { validateRepository } from "../validate/index.js";
import { type Io, requireInitialized } from "./context.js";
import { formatFinding, plural } from "./output.js";

export interface DoctorOptions {
  fix?: boolean;
  strict?: boolean;
  agent?: string;
  json?: boolean;
}

interface Diagnosis extends Finding {
  /** The first command in the hint, when there is one. */
  command?: string;
  /** Whether `alethic doctor --fix` resolves it. */
  fixable: boolean;
}

const FIXABLE = new Set(["expired-lease", "superseded-still-accepted"]);
const COMMAND = /`((?:alethic|git) [^`]+)`/;
const FALLBACK_MANIFEST = resolveManifest({ project: { name: "unknown" } });

function strings(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

/**
 * Everything `validate` reports, plus coordination problems only worth raising on request:
 * overlapping claims, competing claims, orphaned checkpoints, and superseded decisions still
 * marked accepted.
 */
export async function doctorCommand(io: Io, options: DoctorOptions): Promise<number> {
  const root = await requireInitialized(io);
  const at = now(io.env);
  const fixed = options.fix ? await applyFixes(io, root, at, options.agent) : [];

  const report = await validateRepository(root, { now: at, strict: options.strict ?? false });
  const overlaps = createOverlapCheck(root, report.manifest ?? FALLBACK_MANIFEST);
  const diagnoses: Diagnosis[] = sortFindings([
    ...report.findings,
    ...(await findOverlappingClaims(report.records, overlaps, at)),
    ...findCompetingClaims(report.records),
    ...findOrphanedCheckpoints(report.records),
    ...findUnretiredSupersessions(report.records),
  ]).map((finding) => {
    const command = COMMAND.exec(finding.hint ?? "")?.[1];
    return { ...finding, ...(command ? { command } : {}), fixable: FIXABLE.has(finding.code) };
  });
  const errors = diagnoses.filter((d) => d.severity === "error").length;
  const warnings = diagnoses.filter((d) => d.severity === "warning").length;

  if (options.json) {
    const output = { ok: errors === 0, errors, warnings, fixed, findings: diagnoses };
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    return errors > 0 ? 1 : 0;
  }

  const lines: string[] = [];
  if (fixed.length > 0) lines.push("Fixed", ...fixed.map((message) => `  ${message}`), "");
  for (const diagnosis of diagnoses) {
    lines.push(formatFinding(diagnosis));
    if (diagnosis.fixable) lines.push("        fixable: alethic doctor --fix");
  }
  if (diagnoses.length > 0) lines.push("");
  const fixable = diagnoses.filter((d) => d.fixable).length;
  lines.push(
    diagnoses.length === 0
      ? `✓ No problems found in ${plural(report.records.length, "record")}.`
      : `${errors > 0 ? "✗" : "✓"} ${plural(errors, "error")}, ${plural(warnings, "warning")}${fixable > 0 && !options.fix ? ` (${fixable} fixable with --fix)` : ""}`,
  );
  io.stdout(`${lines.join("\n")}\n`);
  return errors > 0 ? 1 : 0;
}

/**
 * Safe, mechanical fixes only: pause active tasks whose lease expired (the owner stays on record)
 * and retire decisions that an accepted decision already supersedes. Anything that needs judgment
 * is left to the suggested command. Each write is checked against the content it was based on.
 */
async function applyFixes(
  io: Io,
  root: string,
  at: Date,
  agent: string | undefined,
): Promise<string[]> {
  const index = await loadRecordIndex(root);
  const records = [...index.values()].sort((a, b) => a.file.localeCompare(b.file));
  const updates: {
    kind: "task" | "decision";
    data: Record<string, unknown>;
    expected: string;
    message: string;
  }[] = [];

  for (const record of records) {
    if (record.kind !== "task" || record.data.status !== "active") continue;
    const owner = asObject(record.data.owner);
    const lease = asString(owner?.lease_expires_at);
    if (!lease || Date.parse(lease) > at.getTime()) continue;
    updates.push({
      kind: "task",
      data: { ...record.data, status: "paused" },
      expected: record.text,
      message: `Paused ${String(record.data.id)}: the lease held by ${asString(owner?.agent) ?? "?"} expired at ${lease}.`,
    });
  }

  const retired = new Map<string, string>();
  for (const record of records) {
    if (record.kind !== "decision" || record.data.status !== "accepted") continue;
    for (const old of strings(record.data.supersedes)) {
      const target = index.get(old);
      if (target?.kind === "decision" && target.data.status !== "superseded" && !retired.has(old)) {
        retired.set(old, String(record.data.id));
      }
    }
  }
  for (const [old, by] of [...retired.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const target = index.get(old);
    if (!target) continue;
    updates.push({
      kind: "decision",
      data: { ...target.data, status: "superseded" },
      expected: target.text,
      message: `Marked ${old} superseded: ${by} supersedes it.`,
    });
  }

  if (updates.length === 0) return [];
  const ctx = await openWriteContext(root, agent, io.env);
  for (const update of updates) {
    await saveRecord(
      ctx,
      update.kind,
      { ...update.data, updated_at: ctx.timestamp },
      { overwrite: true, expected: update.expected },
    );
  }
  return updates.map((update) => update.message);
}
