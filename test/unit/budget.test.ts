import { describe, expect, it } from "vitest";
import {
  allocate,
  type BriefingItem,
  type BriefingSection,
  estimateTokens,
  type Level,
  renderContent,
} from "../../src/compile/budget.js";

function item(key: string, priority: number, detail = 0, pointer = `[${key}]`): BriefingItem {
  return {
    key,
    full: `${key} in full detail ${"x".repeat(detail)} [${key}]`,
    short: `${key} briefly [${key}]`,
    pointer,
    priority,
  };
}

function section(key: string, required: boolean, items: BriefingItem[]): BriefingSection {
  return { key, title: key, required, items };
}

function budgetFor(sections: BriefingSection[], levels: [string, Level][]): number {
  return estimateTokens(renderContent(sections, new Map(levels)));
}

describe("estimateTokens", () => {
  it("rounds characters / 4 up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("allocate", () => {
  it("keeps required items in full and reports when they alone exceed the budget", () => {
    const result = allocate([section("Goal", true, [item("goal", 0, 400)])], 10);
    expect(result.levels.get("goal")).toBe("full");
    expect(result.overBudget).toBe(true);
  });

  it("upgrades higher-priority items first and never exceeds the budget", () => {
    const sections = [section("S", false, [item("low", 5, 200), item("high", 10, 200)])];
    const budget = budgetFor(sections, [
      ["high", "full"],
      ["low", "short"],
    ]);
    const result = allocate(sections, budget);
    expect(result.levels.get("high")).toBe("full");
    expect(result.levels.get("low")).toBe("short");
    expect(result.tokens).toBeLessThanOrEqual(budget);
    expect(result.overBudget).toBe(false);
  });

  it("shows the top item of every section before a second item of any section", () => {
    const sections = [
      section("Valuable", false, [item("v1", 100), item("v2", 90)]),
      section("Other", false, [item("o1", 1)]),
    ];
    const budget = budgetFor(sections, [
      ["v1", "short"],
      ["o1", "short"],
    ]);
    const result = allocate(sections, budget);
    expect(result.levels.get("v1")).toBe("short");
    expect(result.levels.get("o1")).toBe("short");
    expect(result.levels.get("v2")).toBe("pointer");
  });

  it("never shows a lower-ranked item while hiding a higher-ranked one in the same section", () => {
    const big: BriefingItem = { ...item("big", 10), short: `big ${"y".repeat(400)} [big]` };
    const sections = [section("Checks", false, [big, item("small", 5)])];
    const budget = budgetFor(sections, [["small", "short"]]);
    const result = allocate(sections, budget);
    expect(result.levels.get("big")).toBe("pointer");
    expect(result.levels.get("small")).toBe("pointer");
  });

  it("collapses hidden items into one cited line per section, without duplicate pointers", () => {
    const sections: BriefingSection[] = [
      {
        ...section("Files", false, [
          item("a", 1, 0, "[cp-x]"),
          item("b", 1, 0, "[cp-x]"),
          item("c", 1, 0, "[dec-y]"),
        ]),
        pointerNoun: { one: "file", other: "files" },
      },
    ];
    expect(allocate(sections, 0).content).toBe("## Files\n- 3 more files: [cp-x], [dec-y]");

    const single: BriefingSection[] = [
      { ...section("Files", false, [item("a", 1)]), pointerNoun: { one: "file", other: "files" } },
    ];
    expect(allocate(single, 0).content).toBe("## Files\n- 1 more file: [a]");
  });

  it("bounds the citations in a collapsed line, however many records are hidden", () => {
    const many = Array.from({ length: 400 }, (_, i) => item(`i${i}`, 1));
    const content = allocate([section("Decisions", false, many)], 0).content;
    expect(content).toBe("## Decisions\n- 400 more: [i0], [i1], [i2], [i3], [i4], and 395 others");
    const few = allocate([section("Decisions", false, many.slice(0, 7))], 0).content;
    expect(few).toBe("## Decisions\n- 7 more: [i0], [i1], [i2], [i3], [i4], and 2 others");
  });

  it("renders empty sections without bullets", () => {
    expect(renderContent([section("Open questions", false, [])], new Map())).toBe(
      "## Open questions\nNone recorded.",
    );
  });

  it("chooses the same levels regardless of item order", () => {
    const items = [item("a", 1, 50), item("b", 1, 50), item("c", 1, 50)];
    const budget = 40;
    const forward = allocate([section("S", false, items)], budget);
    const backward = allocate([section("S", false, [...items].reverse())], budget);
    expect([...backward.levels].sort()).toEqual([...forward.levels].sort());
  });
});
