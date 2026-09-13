export const CONFIDENCE_LEVELS = [
  "inferred",
  "agent-reported",
  "ci-reported",
  "human-confirmed",
  "ci-verified",
] as const;

export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/**
 * Trust ranks from docs/spec.md §8. `ci-reported` is a self-report (any process can set
 * CI=true), so it ranks equal to `agent-reported`, never above it.
 */
const TRUST_RANK: Record<Confidence, number> = {
  inferred: 0,
  "agent-reported": 1,
  "ci-reported": 1,
  "human-confirmed": 2,
  "ci-verified": 3,
};

export function trustRank(value: unknown): number {
  return typeof value === "string" && value in TRUST_RANK ? TRUST_RANK[value as Confidence] : 0;
}

/** Only these levels count as verified in briefings; everything else is marked unverified. */
export function isVerified(value: unknown): boolean {
  return value === "human-confirmed" || value === "ci-verified";
}
