import { describe, expect, it } from "vitest";
import { orderRecordKeys, parseYaml, stringifyRecord } from "../../src/core/format.js";

describe("parseYaml", () => {
  it("parses plain mappings", () => {
    expect(parseYaml("id: task-a\nscope:\n  paths:\n    - src/**\n")).toEqual({
      data: { id: "task-a", scope: { paths: ["src/**"] } },
      problems: [],
    });
  });

  it("keeps quoted shas as strings and unquoted digit shas as numbers", () => {
    expect(parseYaml('a: "1234567"\nb: 1234567\n').data).toEqual({ a: "1234567", b: 1234567 });
  });

  it("rejects anchors and aliases", () => {
    const { data, problems } = parseYaml("a: &x {k: 1}\nb: *x\n");
    expect(data).toBeUndefined();
    expect(problems.map((p) => p.message)).toEqual([
      "YAML anchors are not allowed (&x)",
      "YAML aliases are not allowed",
    ]);
    expect(problems[1]?.line).toBe(2);
  });

  it("rejects custom tags but allows core tags", () => {
    expect(parseYaml("a: !secret x\n").problems[0]?.message).toMatch(/Custom YAML tags/);
    expect(parseYaml("a: !!str 123\n")).toEqual({ data: { a: "123" }, problems: [] });
  });

  it("rejects duplicate keys and multiple documents", () => {
    expect(parseYaml("a: 1\na: 2\n").problems[0]?.message).toMatch(/unique|duplicate/i);
    expect(parseYaml("a: 1\n---\nb: 2\n").problems.length).toBeGreaterThan(0);
  });

  it("reports syntax errors with a line number", () => {
    const { problems } = parseYaml("a: 1\nb: [unclosed\n");
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]?.line).toBeGreaterThanOrEqual(2);
  });
});

describe("stringifyRecord", () => {
  it("orders keys canonically and appends unknown keys alphabetically", () => {
    expect(
      Object.keys(
        orderRecordKeys({ zeta: 1, created_at: 1, summary: 1, id: 1, alpha: 1, kind: 1 }),
      ),
    ).toEqual(["id", "kind", "summary", "created_at", "alpha", "zeta"]);
  });

  it("round-trips digit-only shas as strings and never emits aliases", () => {
    const shared = { agent: "codex" };
    const record = { id: "task-a", valid_at: "1234567", created_by: shared, owner: shared };
    const text = stringifyRecord(record);
    expect(text).not.toMatch(/[&*]/);
    expect(parseYaml(text)).toEqual({ data: record, problems: [] });
  });
});
