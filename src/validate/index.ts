import { type Finding, sortFindings } from "../core/findings.js";
import { APPEND_ONLY_KINDS } from "../core/ids.js";
import { asString } from "../core/json.js";
import type { Manifest } from "../core/manifest.js";
import {
  type Containment,
  checkContainment,
  checkRepoPath,
  isGlob,
  scopeMatcher,
} from "../core/paths.js";
import type { LoadedRecord } from "../core/store.js";
import { commitExists, firstCommittedContent, isShallow } from "../git/git.js";
import { createOverlapCheck, findContradictions } from "../trust/conflicts.js";
import { assessStaleness, createStalenessContext, type DerivedStatus } from "../trust/staleness.js";
import { assessLedger, type LedgerAssessment } from "./assess.js";
import { checkLeases } from "./leases.js";
import { collectCommits, collectPaths } from "./references.js";

export interface ValidateOptions {
  now: Date;
  /** Treat missing evidence commits as errors instead of warnings. */
  strict?: boolean;
  /** A ledger already assessed by the caller, so records are not loaded twice. */
  ledger?: LedgerAssessment;
}

export interface ValidationReport {
  findings: Finding[];
  errors: number;
  warnings: number;
  records: LoadedRecord[];
  /** Undefined when the manifest is missing or invalid. */
  manifest?: Manifest;
  ledger: LedgerAssessment;
}

const SHA = /^[0-9a-f]{7,64}$/;

/**
 * Runs every check from docs/spec.md §16 against the repository's Alethic state: the shared
 * record assessment (the same one `resume` relies on), plus checks that need Git or the filesystem.
 */
export async function validateRepository(
  root: string,
  options: ValidateOptions,
): Promise<ValidationReport> {
  const ledger = options.ledger ?? (await assessLedger(root));
  const { records, settings: manifest } = ledger;

  const findings: Finding[] = [
    ...ledger.findings,
    ...checkLeases(records, options.now),
    ...(await checkContainmentOfPaths(root, records, manifest)),
    ...(await checkCommits(root, records, options.strict ?? false)),
    ...(await checkAppendOnly(root, records)),
    ...(await checkStaleness(root, records, manifest)),
    ...(await findContradictions(records, createOverlapCheck(root, manifest))),
  ];

  const sorted = sortFindings(findings);
  return {
    findings: sorted,
    errors: sorted.filter((f) => f.severity === "error").length,
    warnings: sorted.filter((f) => f.severity === "warning").length,
    records,
    ...(ledger.manifest ? { manifest: ledger.manifest } : {}),
    ledger,
  };
}

/** Symlink escapes and missing evidence files. Forbidden paths are part of the shared assessment. */
async function checkContainmentOfPaths(
  root: string,
  records: readonly LoadedRecord[],
  manifest: Manifest,
): Promise<Finding[]> {
  const forbidden = scopeMatcher(manifest.privacy.forbidden_globs);
  const cache = new Map<string, Promise<Containment>>();
  const containment = (p: string) => {
    let result = cache.get(p);
    if (!result) {
      result = checkContainment(root, p);
      cache.set(p, result);
    }
    return result;
  };

  const findings: Finding[] = [];
  for (const record of records) {
    for (const field of collectPaths(record.data)) {
      // Lexically unsafe paths are reported by the schema, forbidden ones by the assessment.
      if (checkRepoPath(field.value) !== undefined || isGlob(field.value)) continue;
      if (forbidden(field.value)) continue;
      const where = await containment(field.value);
      if (where === "outside") {
        findings.push({
          severity: "error",
          code: "unsafe-path",
          file: record.file,
          path: field.path,
          message: `${field.value} resolves outside the repository through a symlink`,
          hint: "Cite paths inside the repository only (docs/spec.md §10).",
        });
      } else if (where === "missing" && field.role === "evidence") {
        findings.push({
          severity: "error",
          code: "missing-evidence-file",
          file: record.file,
          path: field.path,
          message: `${field.value} does not exist`,
          hint: "Restore the file, update the path, or remove it from evidence.",
        });
      }
    }
  }
  return findings;
}

async function checkCommits(
  root: string,
  records: readonly LoadedRecord[],
  strict: boolean,
): Promise<Finding[]> {
  const cache = new Map<string, Promise<boolean>>();
  let shallow: Promise<boolean> | undefined;
  const findings: Finding[] = [];

  for (const record of records) {
    for (const field of collectCommits(record.data)) {
      if (!SHA.test(field.sha)) continue;
      let present = cache.get(field.sha);
      if (!present) {
        present = commitExists(root, field.sha);
        cache.set(field.sha, present);
      }
      if (await present) continue;

      if (field.role === "hint") {
        findings.push({
          severity: "info",
          code: "unavailable-commit",
          file: record.file,
          path: field.path,
          message: `${field.sha} is not in this repository (squash merge, rebase, or shallow clone?)`,
        });
        continue;
      }
      shallow ??= isShallow(root);
      findings.push({
        severity: strict ? "error" : "warning",
        code: "missing-commit",
        file: record.file,
        path: field.path,
        message: `Commit ${field.sha} is not in this repository${(await shallow) ? " (this is a shallow clone)" : ""}`,
        hint: strict
          ? "Point at a commit that exists, or cite a PR, issue, or receipt instead."
          : "Prefer durable evidence (PRs, issues, receipts). --strict treats this as an error.",
      });
    }
  }
  return findings;
}

const STALE_CODES: Partial<Record<DerivedStatus, string>> = {
  needs_reverification: "needs-reverification",
  diverged: "diverged",
  uncertain: "uncertain-applicability",
};

/**
 * Warnings for active claims whose anchored content changed (docs/spec.md §9). Missing evidence
 * files are already errors from the path check, so `broken_evidence` is not repeated here.
 */
async function checkStaleness(
  root: string,
  records: readonly LoadedRecord[],
  manifest: Manifest,
): Promise<Finding[]> {
  const claims = records.filter(
    (record) =>
      (record.kind === "decision" && record.data.status !== "superseded") ||
      (record.kind === "knowledge" && record.data.status !== "deprecated"),
  );
  if (claims.length === 0) return [];
  const ctx = await createStalenessContext(root, manifest);
  const findings: Finding[] = [];
  for (const record of claims) {
    const result = await assessStaleness(ctx, record.data);
    const code = STALE_CODES[result.status];
    if (!code) continue;
    // Hand-written records may omit the anchor (spec §18); briefings still mark them.
    if (result.status === "uncertain" && result.anchor === "none") continue;
    const id = asString(record.data.id) ?? record.file;
    const more = result.reasons.length > 1 ? ` (and ${result.reasons.length - 1} more)` : "";
    const label = result.status === "uncertain" ? "Applicability unknown" : "May be stale";
    findings.push({
      severity: "warning",
      code,
      file: record.file,
      path: "anchor",
      message: `${label}: ${result.reasons[0] ?? result.status}${more}`,
      hint: `Check it against the current code, then run \`alethic verify ${id}\` (with --human <name> if a person confirmed it), or supersede or deprecate it.`,
    });
  }
  return findings;
}

async function checkAppendOnly(root: string, records: readonly LoadedRecord[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const record of records) {
    if (!APPEND_ONLY_KINDS.has(record.kind)) continue;
    const original = await firstCommittedContent(root, record.file);
    if (original === undefined || original === record.text) continue;
    findings.push({
      severity: "error",
      code: "append-only",
      file: record.file,
      message: `${record.kind === "checkpoint" ? "Checkpoints" : "Receipts"} are append-only, but this file changed after it was first committed`,
      hint: `Restore the committed version (git checkout HEAD -- ${record.file}) and write a new ${record.kind} instead.`,
    });
  }
  return findings;
}
