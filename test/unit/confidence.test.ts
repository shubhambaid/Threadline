import { describe, expect, it } from "vitest";
import { CONFIDENCE_LEVELS, isVerified, trustRank } from "../../src/trust/confidence.js";

describe("trust levels", () => {
  it("ranks ci-reported equal to agent-reported, never above", () => {
    expect(trustRank("ci-reported")).toBe(trustRank("agent-reported"));
  });

  it("orders the ladder from spec §8", () => {
    expect(trustRank("inferred")).toBeLessThan(trustRank("agent-reported"));
    expect(trustRank("agent-reported")).toBeLessThan(trustRank("human-confirmed"));
    expect(trustRank("human-confirmed")).toBeLessThan(trustRank("ci-verified"));
    expect(trustRank("made-up")).toBe(0);
    expect(trustRank(undefined)).toBe(0);
  });

  it("treats only human-confirmed and ci-verified as verified", () => {
    expect(CONFIDENCE_LEVELS.filter(isVerified)).toEqual(["human-confirmed", "ci-verified"]);
  });
});
