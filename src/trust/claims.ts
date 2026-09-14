import { createHash } from "node:crypto";
import type { RecordKind } from "../core/ids.js";
import { asArray, asObject, asString, isPlainObject } from "../core/json.js";

/**
 * The fields that make up what a record claims, per kind. A human confirmation is bound to a
 * digest of exactly these fields, so editing the claim leaves the confirmation visibly outdated.
 * Status, confidence, evidence, timestamps, anchors, and ownership are not part of the claim:
 * retiring a decision or pausing a task does not change what was confirmed.
 */
const CLAIM_FIELDS: Record<RecordKind, readonly string[]> = {
  task: ["summary", "intent", "scope"],
  decision: ["summary", "topic", "chosen", "rationale", "alternatives", "scope", "supersedes"],
  knowledge: ["summary", "category", "body", "scope"],
  checkpoint: [
    "summary",
    "task",
    "git",
    "done",
    "failed_approaches",
    "open_questions",
    "next_safe_action",
  ],
  receipt: ["summary", "command", "exit_code", "result", "git", "output_tail"],
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

/** SHA-256 of the canonical JSON of a record's claim fields (docs/spec.md §8). */
export function claimDigest(kind: RecordKind, data: Record<string, unknown>): string {
  const claim: Record<string, unknown> = { kind };
  for (const field of CLAIM_FIELDS[kind]) {
    if (data[field] !== undefined) claim[field] = data[field];
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(claim)))
    .digest("hex");
}

/**
 * What a `human-confirmed` label establishes for this revision of the record:
 *
 * - `none`: the record is not labeled `human-confirmed`.
 * - `attributed`: the latest confirmation names a person and is bound to this exact claim. The
 *   name is an attribution recorded by whoever wrote the record; it is not authenticated.
 * - `unbound`: the confirmation predates claim digests (or was written by hand), so nothing shows
 *   whether the claim was edited after it.
 * - `outdated`: the claim was edited after the person confirmed it.
 */
export type ConfirmationLevel = "none" | "attributed" | "unbound" | "outdated";

export interface ConfirmationState {
  level: ConfirmationLevel;
  /** The person named by the latest confirmation. */
  name?: string;
  /** The agent that recorded the latest confirmation, when known. */
  recordedBy?: string;
  at?: string;
  /** Whether the attribution was authenticated. Always false in format v1. */
  authenticated: false;
}

export function confirmationState(
  kind: RecordKind,
  data: Record<string, unknown>,
): ConfirmationState {
  if (data.confidence !== "human-confirmed") return { level: "none", authenticated: false };
  const entries = asArray(asObject(data.evidence)?.human)
    .map(asObject)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  const latest = entries.at(-1);
  const name = asString(latest?.name);
  const recordedBy = asString(latest?.recorded_by);
  const at = asString(latest?.at);
  const bound = asString(latest?.claim_digest);
  const base = {
    ...(name ? { name } : {}),
    ...(recordedBy ? { recordedBy } : {}),
    ...(at ? { at } : {}),
    authenticated: false as const,
  };
  if (!bound) return { level: "unbound", ...base };
  return { level: bound === claimDigest(kind, data) ? "attributed" : "outdated", ...base };
}

/**
 * Keeps an edit from silently carrying a human confirmation onto text the person never saw:
 * when a `human-confirmed` record's claim changes, it becomes `agent-reported` and the caller
 * gets a warning. The confirmation history stays in `evidence.human`.
 */
export function reconcileConfirmation(
  kind: RecordKind,
  id: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { record: Record<string, unknown>; warning?: string } {
  if (after.confidence !== "human-confirmed") return { record: after };
  if (claimDigest(kind, before) === claimDigest(kind, after)) return { record: after };
  const name = confirmationState(kind, before).name ?? "the person";
  return {
    record: { ...after, confidence: "agent-reported" },
    warning: `Confidence changed from human-confirmed to agent-reported: the text ${name} confirmed has changed. If they check it again, run \`alethic verify ${id} --human <name>\`.`,
  };
}

/**
 * The confidence to rank and label a record by. A confirmation whose claim was edited afterwards
 * no longer counts, so the record falls back to `agent-reported`.
 */
export function effectiveConfidence(kind: RecordKind, data: Record<string, unknown>): unknown {
  return confirmationState(kind, data).level === "outdated" ? "agent-reported" : data.confidence;
}
