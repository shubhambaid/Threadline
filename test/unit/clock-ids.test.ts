import { describe, expect, it } from "vitest";
import common from "../../schemas/common.schema.json" with { type: "json" };
import { addMinutes, now, toIdSuffix, toTimestamp } from "../../src/core/clock.js";
import { KIND_DIRS, kindFromId, makeId, RECORD_KINDS, slugify } from "../../src/core/ids.js";

const RECORD_ID = new RegExp(common.$defs.recordId.pattern);
const TIMESTAMP = new RegExp(common.$defs.timestamp.pattern);

describe("clock", () => {
  it("honors ALETHIC_NOW", () => {
    expect(toTimestamp(now({ ALETHIC_NOW: "2026-09-13T20:15:00Z" }))).toBe("2026-09-13T20:15:00Z");
  });

  it("rejects an invalid ALETHIC_NOW", () => {
    expect(() => now({ ALETHIC_NOW: "yesterday" })).toThrow(/ALETHIC_NOW/);
  });

  it("formats timestamps the schema accepts", () => {
    const date = new Date("2026-09-13T20:15:00.123Z");
    expect(toTimestamp(date)).toBe("2026-09-13T20:15:00Z");
    expect(TIMESTAMP.test(toTimestamp(date))).toBe(true);
    expect(toIdSuffix(date)).toBe("20260913t201500z");
    expect(toTimestamp(addMinutes(date, 90))).toBe("2026-09-13T21:45:00Z");
  });
});

describe("ids", () => {
  const date = new Date("2026-09-13T20:15:00Z");

  it("slugifies text", () => {
    expect(slugify("Add session invalidation after password reset")).toBe(
      "add-session-invalidation-after-password-reset",
    );
    expect(slugify("Café déjà vu!")).toBe("cafe-deja-vu");
    expect(slugify("  --  ")).toBe("untitled");
  });

  it("cuts long slugs at a word boundary", () => {
    const slug = slugify("word ".repeat(30), 22);
    expect(slug).toBe("word-word-word-word");
    expect(slug.length).toBeLessThanOrEqual(22);
  });

  it("adds timestamps only to append-only kinds", () => {
    expect(makeId("task", "Session reset", date)).toBe("task-session-reset");
    expect(makeId("checkpoint", "Session reset", date)).toBe("cp-session-reset-20260913t201500z");
    expect(makeId("receipt", "pnpm test auth", date)).toBe("rcpt-pnpm-test-auth-20260913t201500z");
  });

  it("produces ids the schema accepts for every kind, even from long text", () => {
    for (const kind of RECORD_KINDS) {
      const id = makeId(kind, "An extremely long title ".repeat(10), date);
      expect(RECORD_ID.test(id), id).toBe(true);
      expect(id.length).toBeLessThanOrEqual(120);
      expect(kindFromId(id)).toBe(kind);
      expect(KIND_DIRS[kind]).toBeTruthy();
    }
  });
});
