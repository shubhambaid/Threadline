import { headCommit, resolveCommit, shortSha } from "../git/git.js";
import { claimDigest } from "../trust/claims.js";
import { validateAgainst } from "../validate/schema.js";
import { compileSecretPatterns, type SecretPattern, scanForSecrets } from "../validate/secrets.js";
import { type Anchor, type AnchorInput, captureAnchor } from "./anchor.js";
import { now as clockNow, toTimestamp } from "./clock.js";
import { UsageError } from "./errors.js";
import { resolveAgent } from "./identity.js";
import type { RecordKind } from "./ids.js";
import { asArray, asObject, isPlainObject } from "./json.js";
import { loadManifest, type Manifest } from "./manifest.js";
import {
  checkContainment,
  checkRepoPath,
  isGlob,
  PATH_PROBLEM_MESSAGES,
  scopeMatcher,
} from "./paths.js";
import { requireRecord } from "./records.js";
import { type LoadedRecord, writeRecord } from "./store.js";

/** Shared state for commands that write records. */
export interface WriteContext {
  root: string;
  manifest: Manifest;
  agent: string;
  now: Date;
  timestamp: string;
  patterns: SecretPattern[];
}

export async function openWriteContext(
  root: string,
  agentFlag: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<WriteContext> {
  const agent = resolveAgent(agentFlag, env);
  const { manifest, findings } = await loadManifest(root);
  if (!manifest) {
    const problems = findings.map((f) => `${f.path ?? f.file}: ${f.message}`).join("; ");
    throw new UsageError(`The manifest is invalid (${problems}). Run \`alethic validate\`.`);
  }
  const { patterns, invalid } = compileSecretPatterns(manifest.privacy.extra_secret_patterns);
  if (invalid.length > 0) {
    throw new UsageError(
      `privacy.extra_secret_patterns has invalid regular expressions: ${invalid.map((i) => i.pattern).join(", ")}`,
    );
  }
  const at = clockNow(env);
  return { root, manifest, agent, now: at, timestamp: toTimestamp(at), patterns };
}

const KEEP_EMPTY = new Set(["fingerprints"]);

/** Drops undefined and null values, empty arrays, and empty objects, recursively. */
export function compact(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (Array.isArray(item)) {
      if (item.length > 0) out[key] = item;
      continue;
    }
    if (isPlainObject(item)) {
      const inner = KEEP_EMPTY.has(key) ? item : compact(item);
      if (Object.keys(inner).length > 0 || KEEP_EMPTY.has(key)) out[key] = inner;
      continue;
    }
    out[key] = item;
  }
  return out;
}

export function unique(values?: readonly string[]): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

export function parseInteger(value: string, label: string, min?: number): number {
  if (!/^-?\d+$/.test(value.trim())) throw new UsageError(`${label} must be an integer`);
  const parsed = Number(value);
  if (min !== undefined && parsed < min) throw new UsageError(`${label} must be at least ${min}`);
  return parsed;
}

/** Splits `left::right`. The value is not echoed in errors, since it may be sensitive. */
export function parsePair(value: string, label: string): [string, string] {
  const index = value.indexOf("::");
  const left = index < 0 ? "" : value.slice(0, index).trim();
  const right = index < 0 ? "" : value.slice(index + 2).trim();
  if (!left || !right) throw new UsageError(`${label} must look like "<text>::<reason>"`);
  return [left, right];
}

export async function assertSafePaths(
  ctx: WriteContext,
  paths: readonly string[],
  label: string,
): Promise<void> {
  const forbidden = scopeMatcher(ctx.manifest.privacy.forbidden_globs);
  for (const p of paths) {
    const problem = checkRepoPath(p);
    if (problem) throw new UsageError(`${label} "${p}": ${PATH_PROBLEM_MESSAGES[problem]}`);
    if (isGlob(p)) continue;
    if (forbidden(p)) throw new UsageError(`${label} "${p}" matches privacy.forbidden_globs`);
    if ((await checkContainment(ctx.root, p)) === "outside") {
      throw new UsageError(`${label} "${p}" resolves outside the repository`);
    }
  }
}

export async function assertFilesExist(
  ctx: WriteContext,
  files: readonly string[],
  label: string,
): Promise<void> {
  for (const file of files) {
    if (isGlob(file)) throw new UsageError(`${label} must name files, not globs: "${file}"`);
    if ((await checkContainment(ctx.root, file)) === "missing") {
      throw new UsageError(`${label} "${file}" does not exist`);
    }
  }
}

export function assertReferences(
  index: ReadonlyMap<string, LoadedRecord>,
  ids: readonly string[],
  label: string,
  kind?: RecordKind,
): void {
  for (const id of ids) requireRecord(index, id, kind, label);
}

/** Short sha of HEAD for `valid_at`, or undefined before the first commit. */
export async function validAt(root: string): Promise<string | undefined> {
  const head = await headCommit(root);
  return head ? shortSha(root, head) : undefined;
}

export async function anchorFor(
  ctx: WriteContext,
  input: AnchorInput,
  maxFingerprintsFlag?: string,
): Promise<{ anchor?: Anchor; warnings: string[] }> {
  const maxFingerprints =
    maxFingerprintsFlag === undefined
      ? ctx.manifest.limits.max_fingerprints_per_record
      : parseInteger(maxFingerprintsFlag, "--max-fingerprints", 0);
  const result = await captureAnchor(ctx.root, input, {
    maxFingerprints,
    maxGlobMatches: ctx.manifest.limits.max_glob_matches,
    forbiddenGlobs: ctx.manifest.privacy.forbidden_globs,
  });
  const { anchor } = result;
  if (anchor && Object.keys(anchor.fingerprints).length === 0 && !anchor.overflow) {
    return { warnings: result.warnings };
  }
  return result;
}

export interface EvidenceFlags {
  evidenceFile?: string[];
  commit?: string[];
  check?: string[];
  receipt?: string[];
  issue?: string[];
  pr?: string[];
}

export async function buildEvidence(
  ctx: WriteContext,
  index: ReadonlyMap<string, LoadedRecord>,
  flags: EvidenceFlags,
): Promise<{ evidence: Record<string, unknown>; warnings: string[] }> {
  const warnings: string[] = [];
  const files = unique(flags.evidenceFile);
  await assertSafePaths(ctx, files, "--evidence-file");
  await assertFilesExist(ctx, files, "--evidence-file");

  const commits = unique(flags.commit).map((sha) => sha.toLowerCase());
  for (const sha of commits) {
    if (!/^[0-9a-f]{7,64}$/.test(sha)) {
      throw new UsageError(`--commit "${sha}" is not a commit id (7-64 hex characters)`);
    }
    if (!(await resolveCommit(ctx.root, sha))) {
      warnings.push(`Commit ${sha} is not in this repository.`);
    }
  }

  const receipts = unique(flags.receipt);
  assertReferences(index, receipts, "--receipt", "receipt");

  const evidence = compact({
    commits,
    files,
    checks: unique(flags.check),
    receipts,
    issues: unique(flags.issue),
    prs: unique(flags.pr),
  });
  return { evidence, warnings };
}

/**
 * Records that a named person confirmed this exact claim, and marks the record `human-confirmed`.
 * The confirmation says who recorded it and is bound to a digest of the claim, so a later edit
 * leaves it visibly outdated. The name is an attribution by `ctx.agent`, not an authenticated
 * identity (docs/spec.md §8).
 */
export function addHumanConfirmation(
  ctx: WriteContext,
  kind: RecordKind,
  record: Record<string, unknown>,
  human: { name: string; note: string },
): Record<string, unknown> {
  const evidence = asObject(record.evidence) ?? {};
  return {
    ...record,
    confidence: "human-confirmed",
    evidence: {
      ...evidence,
      human: [
        ...asArray(evidence.human),
        {
          name: human.name,
          at: ctx.timestamp,
          note: human.note,
          recorded_by: ctx.agent,
          authentication: "none",
          claim_digest: claimDigest(kind, record),
        },
      ],
    },
  };
}

export function createdBy(ctx: WriteContext, human: string | undefined): Record<string, unknown> {
  return compact({ agent: ctx.agent, human });
}

/**
 * Validates and writes a record. Nothing is written if it fails the schema or contains
 * anything that looks like a secret. Secret values are never echoed.
 */
export async function saveRecord(
  ctx: WriteContext,
  kind: RecordKind,
  record: Record<string, unknown>,
  options: { overwrite?: boolean } = {},
): Promise<string> {
  const secrets = scanForSecrets(record, ctx.patterns);
  if (secrets.length > 0) {
    throw new UsageError(
      `Refusing to write: ${secrets.map((s) => `${s.path} looks like a ${s.pattern}`).join("; ")}. Records are shared and permanent; remove credentials (docs/spec.md §13).`,
    );
  }
  const { issues } = validateAgainst(kind, record);
  if (issues.length > 0) {
    throw new UsageError(
      `Refusing to write an invalid ${kind}: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
    );
  }
  return writeRecord(ctx.root, kind, record, options);
}
