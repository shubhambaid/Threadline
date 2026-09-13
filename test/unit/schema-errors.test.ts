import { describe, expect, it } from "vitest";
import { validateAgainst } from "../../src/validate/schema.js";

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "dec-example",
    kind: "decision",
    schema_version: 1,
    summary: "Example decision.",
    status: "accepted",
    confidence: "agent-reported",
    topic: "example.topic",
    chosen: "Option A.",
    rationale: "Because.",
    created_by: { agent: "codex" },
    created_at: "2026-09-13T00:00:00Z",
    ...overrides,
  };
}

describe("schema error messages", () => {
  it("accepts a minimal valid decision", () => {
    expect(validateAgainst("decision", decision())).toEqual({ valid: true, issues: [] });
  });

  it("reports genuinely unknown fields", () => {
    const { issues } = validateAgainst("decision", decision({ foo: 1 }));
    expect(issues).toEqual([
      { path: "foo", message: "is not an allowed field", keyword: "unevaluatedProperties" },
    ]);
  });

  it("does not report declared fields as unknown when another rule fails", () => {
    const { issues } = validateAgainst(
      "decision",
      decision({ confidence: "human-confirmed", status: "bogus" }),
    );
    const paths = issues.map((i) => i.path);
    expect(paths).toContain("evidence");
    expect(paths).toContain("status");
    expect(issues.filter((i) => i.keyword === "unevaluatedProperties")).toEqual([]);
  });

  it("explains unsafe paths without dumping the regex", () => {
    const { issues } = validateAgainst("decision", decision({ scope: { paths: ["../outside"] } }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("scope.paths[0]");
    expect(issues[0]?.message).toMatch(/repository-relative/);
    expect(issues[0]?.message).not.toMatch(/\(\?!/);
  });

  it("hints to quote commit ids that YAML parsed as numbers", () => {
    const { issues } = validateAgainst("decision", decision({ valid_at: 1234567 }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("valid_at");
    expect(issues[0]?.message).toMatch(/quote/i);
  });

  it("explains timestamp format", () => {
    const { issues } = validateAgainst("decision", decision({ created_at: "2026-09-13 00:00:00" }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/UTC/);
  });
});
