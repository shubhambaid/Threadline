import path from "node:path";
import { type Finding, sortFindings } from "../core/findings.js";
import { APPEND_ONLY_KINDS, isRecordKind, KIND_DIRS, type RecordKind } from "../core/ids.js";
import { asString } from "../core/json.js";
import { loadManifest, MANIFEST_FILE, type Manifest, resolveManifest } from "../core/manifest.js";
import {
  type Containment,
  checkContainment,
  checkRepoPath,
  isGlob,
  scopeMatcher,
} from "../core/paths.js";
import { type LoadedRecord, loadRecords } from "../core/store.js";
import { commitExists, firstCommittedContent, isShallow } from "../git/git.js";
import { createOverlapCheck, findContradictions } from "../trust/conflicts.js";
import { assessStaleness, createStalenessContext, type DerivedStatus } from "../trust/staleness.js";
import { checkLeases } from "./leases.js";
import { collectCommits, collectPaths, collectReferences } from "./references.js";
import { validateAgainst } from "./schema.js";
import { compileSecretPatterns, type SecretPattern, scanForSecrets } from "./secrets.js";

export interface ValidateOptions {
  now: Date;
  /** Treat missing evidence commits as errors instead of warnings. */
  strict?: boolean;
}

export interface ValidationReport {
  findings: Finding[];
  errors: number;
  warnings: number;
  records: LoadedRecord[];
  /** Undefined when the manifest is missing or invalid. */
  manifest?: Manifest;
}

const SPEC_SECTION: Record<RecordKind, string> = {
  task: "§6.1",
  decision: "§6.2",
  knowledge: "§6.3",
  checkpoint: "§6.4",
  receipt: "§6.5",
};

const FALLBACK_MANIFEST = resolveManifest({ project: { name: "unknown" } });

const SHA = /^[0-9a-f]{7,64}$/;

/** Runs every check from docs/spec.md §16 against the repository's Threadline state. */
export async function validateRepository(
  root: string,
  options: ValidateOptions,
): Promise<ValidationReport> {
  const manifestLoad = await loadManifest(root);
  const manifest = manifestLoad.manifest ?? FALLBACK_MANIFEST;
  const store = await loadRecords(root);
  const { records } = store;
  const secrets = compileSecretPatterns(manifest.privacy.extra_secret_patterns);

  const findings: Finding[] = [
    ...manifestLoad.findings,
    ...store.findings,
    ...secrets.invalid.map(
      ({ pattern, error }): Finding => ({
        severity: "error",
        code: "manifest-pattern",
        file: MANIFEST_FILE,
        path: `privacy.extra_secret_patterns[${manifest.privacy.extra_secret_patterns.indexOf(pattern)}]`,
        message: `Invalid regular expression: ${error}`,
      }),
    ),
    ...checkSchemas(records),
    ...checkIdentity(records),
    ...checkReferences(records),
    ...checkSecrets(records, secrets.patterns),
    ...checkLeases(records, options.now),
    ...checkTrust(records, manifest),
    ...(await checkPaths(root, records, manifest)),
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
    ...(manifestLoad.manifest ? { manifest: manifestLoad.manifest } : {}),
  };
}

function checkSchemas(records: readonly LoadedRecord[]): Finding[] {
  return records.flatMap((record) =>
    validateAgainst(record.kind, record.data).issues.map(
      (issue): Finding => ({
        severity: "error",
        code: "schema",
        file: record.file,
        path: issue.path,
        message: issue.message,
        hint: `See docs/spec.md ${SPEC_SECTION[record.kind]}.`,
      }),
    ),
  );
}

function checkIdentity(records: readonly LoadedRecord[]): Finding[] {
  const findings: Finding[] = [];
  const byId = new Map<string, LoadedRecord[]>();

  for (const record of records) {
    const id = asString(record.data.id);
    const stem = path.posix.basename(record.file, ".yaml");
    if (id !== undefined && id !== stem) {
      findings.push({
        severity: "error",
        code: "id-mismatch",
        file: record.file,
        path: "id",
        message: `id "${id}" does not match the file name ${stem}.yaml`,
        hint: `Rename the file to ${id}.yaml, or change the id.`,
      });
    }
    const kind = asString(record.data.kind);
    if (kind !== undefined && kind !== record.kind && isRecordKind(kind)) {
      findings.push({
        severity: "error",
        code: "kind-mismatch",
        file: record.file,
        path: "kind",
        message: `A ${kind} record is stored in ${KIND_DIRS[record.kind]}/`,
        hint: `Move it to .threadline/${KIND_DIRS[kind]}/.`,
      });
    }
    if (id) byId.set(id, [...(byId.get(id) ?? []), record]);
  }

  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    for (const record of group) {
      const others = group.filter((other) => other !== record).map((other) => other.file);
      findings.push({
        severity: "error",
        code: "duplicate-id",
        file: record.file,
        path: "id",
        message: `id "${id}" is also used by ${others.join(", ")}`,
        hint: "Give each record a unique id.",
      });
    }
  }
  return findings;
}

function checkReferences(records: readonly LoadedRecord[]): Finding[] {
  const byId = new Map<string, LoadedRecord>();
  for (const record of records) {
    const id = asString(record.data.id);
    if (id !== undefined && !byId.has(id)) byId.set(id, record);
  }

  return records.flatMap((record) =>
    collectReferences(record.data).flatMap((ref): Finding[] => {
      const target = byId.get(ref.id);
      if (!target) {
        return [
          {
            severity: "error",
            code: "dangling-reference",
            file: record.file,
            path: ref.path,
            message: `${ref.id} does not exist`,
            hint: "Create the referenced record, or remove the reference.",
          },
        ];
      }
      const expected = ref.sameKind ? record.kind : ref.expected;
      if (expected && target.kind !== expected) {
        return [
          {
            severity: "error",
            code: "wrong-reference-kind",
            file: record.file,
            path: ref.path,
            message: `${ref.id} is a ${target.kind}, but a ${expected} is expected here`,
          },
        ];
      }
      return [];
    }),
  );
}

function checkSecrets(records: readonly LoadedRecord[], patterns: SecretPattern[]): Finding[] {
  return records.flatMap((record) =>
    scanForSecrets(record.data, patterns).map(
      (secret): Finding => ({
        severity: "error",
        code: "secret",
        file: record.file,
        path: secret.path,
        message: `Looks like a ${secret.pattern}`,
        hint: "Remove it. Records are shared and permanent; never store credentials (docs/spec.md §13).",
      }),
    ),
  );
}

function checkTrust(records: readonly LoadedRecord[], manifest: Manifest): Finding[] {
  return records
    .filter((record) => record.data.confidence === "ci-verified")
    .map(
      (record): Finding => ({
        severity: "error",
        code: "untrusted-confidence",
        file: record.file,
        path: "confidence",
        message:
          manifest.trust.ci_provenance === "none"
            ? "ci-verified requires trusted CI provenance, but trust.ci_provenance is none"
            : "ci-verified cannot be checked yet: provenance verification is not available in this version",
        hint: "Use ci-reported for CI self-reports, or agent-reported (docs/spec.md §8).",
      }),
    );
}

async function checkPaths(
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
      // Lexically unsafe paths are already reported by the schema.
      if (checkRepoPath(field.value) !== undefined || isGlob(field.value)) continue;
      if (forbidden(field.value)) {
        findings.push({
          severity: "error",
          code: "forbidden-path",
          file: record.file,
          path: field.path,
          message: `${field.value} matches privacy.forbidden_globs`,
          hint: "Records must not cite or fingerprint forbidden paths. Remove the reference.",
        });
        continue;
      }
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
    const id = asString(record.data.id) ?? record.file;
    const more = result.reasons.length > 1 ? ` (and ${result.reasons.length - 1} more)` : "";
    findings.push({
      severity: "warning",
      code,
      file: record.file,
      path: "anchor",
      message: `May be stale: ${result.reasons[0] ?? result.status}${more}`,
      hint: `Check it against the current code, then run \`threadline verify ${id}\` (with --human <name> if a person confirmed it), or supersede or deprecate it.`,
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
