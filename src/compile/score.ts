import { asString } from "../core/json.js";
import { trustRank } from "../trust/confidence.js";
import type { StalenessResult } from "../trust/staleness.js";
import { type Candidate, REASON_WEIGHT } from "./collect.js";

export interface AssessedCandidate extends Candidate {
  staleness: StalenessResult;
  /** Receipts: whether they ran on the current HEAD. */
  atHead?: boolean;
  /** Receipts: whether files outside .alethic/ changed since they ran; undefined if unknown. */
  codeChanged?: boolean;
}

export interface ScoredCandidate extends AssessedCandidate {
  score: number;
}

/**
 * Relevance, not truth. Staleness does not lower the score: a record that may be stale is
 * exactly what an incoming agent needs to see, with its warning, rather than have hidden.
 */
export function scoreCandidate(candidate: AssessedCandidate): number {
  const weights = candidate.reasons.map((reason) => REASON_WEIGHT[reason]).sort((a, b) => b - a);
  let score = (weights[0] ?? 0) + 5 * Math.max(0, weights.length - 1);
  score += 5 * trustRank(candidate.record.data.confidence);
  if (candidate.record.kind === "decision" && candidate.record.data.status === "accepted") {
    score += 10;
  }
  if (candidate.staleness.anchor === "ancestor") score += 5;
  // Evidence about the code as it is now outranks evidence about older code.
  if (candidate.record.kind === "receipt" && candidate.codeChanged === false) score += 10;
  return score;
}

/** Highest score first, then newest, then id. */
export function rankCandidates(candidates: readonly AssessedCandidate[]): ScoredCandidate[] {
  return candidates
    .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (asString(b.record.data.created_at) ?? "").localeCompare(
          asString(a.record.data.created_at) ?? "",
        ) ||
        a.id.localeCompare(b.id),
    );
}
