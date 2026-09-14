import { beforeAll, describe, expect, it } from "vitest";
import type { FixtureRepo } from "../helpers/fixture-repo.js";
import {
  buildResumeFixture,
  LATEST_FAILED,
  LATEST_NEXT,
  RESUME_INTENT,
  RESUME_NOW,
  RESUME_TASK,
  STALE_KNOWLEDGE,
} from "../helpers/resume-fixture.js";
import { cli } from "../helpers/run-cli.js";
import { expectOk, initializedRepo } from "../helpers/workspace.js";

const CITATION =
  /\[(?:task|dec|kn|cp|rcpt)-[a-z0-9-]+\]|\(commit [0-9a-f]{7,}\)|\(receipt rcpt-[a-z0-9-]+\)/;
const POINTER_LINE = /^- \d+ more( files)?: /;

let repo: FixtureRepo;

beforeAll(async () => {
  repo = await buildResumeFixture();
}, 180_000);

async function resume(target: FixtureRepo, args: string[]): Promise<string> {
  return expectOk(
    await cli(["resume", "--task", RESUME_TASK, ...args], {
      cwd: target.root,
      env: { THREADLINE_NOW: RESUME_NOW },
    }),
  ).stdout;
}

interface JsonBriefing {
  tokens: number;
  sections: { key: string; items: { key: string; level: string; text: string }[] }[];
}

async function resumeJson(budget: number): Promise<JsonBriefing> {
  return JSON.parse(await resume(repo, ["--budget", String(budget), "--format", "json"]));
}

function bullets(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("- "));
}

function section(text: string, title: string): string {
  const start = text.indexOf(`## ${title}\n`);
  if (start < 0) return "";
  const rest = text.slice(start + title.length + 4);
  const end = rest.search(/\n## |\n---\n/);
  return end < 0 ? rest : rest.slice(0, end);
}

function lineCiting(text: string, id: string): string | undefined {
  return bullets(text).find((line) => line.includes(`[${id}]`) && !POINTER_LINE.test(line));
}

function count(briefing: JsonBriefing, level: string): number {
  return briefing.sections.flatMap((s) => s.items).filter((i) => i.level === level).length;
}

function stripFrame(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("## "));
  const end = lines.lastIndexOf("---");
  return lines.slice(start, end).join("\n");
}

describe("threadline resume", () => {
  it("stays within approximate budgets and keeps the essentials at 1000 tokens", async () => {
    for (const budget of [1000, 2500, 5000]) {
      const text = await resume(repo, ["--budget", String(budget)]);
      expect(Math.ceil(text.length / 4), `budget ${budget}`).toBeLessThanOrEqual(budget);
    }

    const small = await resume(repo, ["--budget", "1000"]);
    expect(section(small, "Goal")).toContain(RESUME_INTENT);
    expect(section(small, "Current repository state")).toContain("Branch feat/session-reset at");
    expect(section(small, "Current repository state")).toContain(
      "HEAD is 1 commit ahead of it, with no code changes since",
    );
    expect(section(small, "Next safe action")).toContain(LATEST_NEXT);
    expect(lineCiting(small, "dec-auth-session-invalidation")).toBeDefined();
    expect(section(small, "Failed approaches")).toContain(LATEST_FAILED);
    expect(section(small, "Open questions")).toContain(
      "Does the mobile client retry refresh on 401?",
    );
    expect(section(small, "Verified behavior and checks run")).toMatch(
      /`pnpm test auth` failed \(exit 1\) at [0-9a-f]+ \(code unchanged since\)/,
    );
    const warnings = bullets(small).filter(
      (line) => line.includes("⚠ may be stale") && !POINTER_LINE.test(line),
    );
    expect(warnings.length).toBeGreaterThan(0);

    const pointers = bullets(small).filter((line) => POINTER_LINE.test(line));
    expect(pointers.length).toBeGreaterThan(0);
    expect(pointers.length).toBeLessThanOrEqual(5);
  });

  it("adds detail as the budget grows", async () => {
    const small = await resumeJson(1000);
    const medium = await resumeJson(2500);
    const large = await resumeJson(5000);
    expect(count(small, "full")).toBeLessThan(count(medium, "full"));
    expect(count(medium, "full")).toBeLessThan(count(large, "full"));
    expect(count(large, "pointer")).toBe(0);
    expect(small.tokens).toBeLessThan(medium.tokens);
    expect(medium.tokens).toBeLessThanOrEqual(large.tokens);
  });

  it("never shows a later item in more detail than an earlier one in its section", async () => {
    const rank: Record<string, number> = { full: 2, short: 1, pointer: 0 };
    for (const budget of [1000, 2500, 5000]) {
      const briefing = await resumeJson(budget);
      for (const { key, items } of briefing.sections) {
        const levels = items.map((item) => rank[item.level] ?? 0);
        expect(levels, `${key} at ${budget}`).toEqual([...levels].sort((a, b) => b - a));
      }
    }
  });

  it("ends every bullet with a citation", async () => {
    for (const budget of [1000, 2500, 5000]) {
      const text = await resume(repo, ["--budget", String(budget)]);
      for (const line of bullets(text)) expect(line, `budget ${budget}`).toMatch(CITATION);
    }
  });

  it("finds records by links and paths, and leaves out unrelated and retired ones", async () => {
    const text = await resume(repo, ["--budget", "5000"]);
    for (const included of [
      "dec-auth-session-invalidation",
      "dec-auth-token-format",
      "dec-auth-token-rotation",
      "dec-web-login-copy",
      STALE_KNOWLEDGE,
      "kn-sessions-live-in-the-sessions-table-keyed-by-user",
    ]) {
      expect(lineCiting(text, included), included).toBeDefined();
    }
    for (const excluded of [
      "dec-billing-rounding",
      "kn-invoices-round-at-the-edge",
      "dec-auth-old-approach",
      "kn-old-convention",
    ]) {
      expect(text, excluded).not.toContain(excluded);
    }
    expect(lineCiting(text, "dec-auth-token-rotation")).toMatch(/^- Proposed: /);
  });

  it("marks unverified and possibly stale claims", async () => {
    const text = await resume(repo, ["--budget", "5000"]);
    const confirmed = lineCiting(text, "dec-auth-session-invalidation") ?? "";
    expect(confirmed).not.toContain("⚠");
    expect(lineCiting(text, "dec-auth-token-format")).toContain("⚠ unverified");
    expect(lineCiting(text, "dec-auth-token-format")).not.toContain("may be stale");
    expect(lineCiting(text, STALE_KNOWLEDGE)).toContain(
      "⚠ may be stale: apps/api/auth/refresh.ts changed 41 lines (+40/-1) since it was anchored",
    );
  });

  it("changes only the header and footer for different targets", async () => {
    const outputs = await Promise.all(
      ["codex", "claude-code", "gemini", "generic"].map((target) =>
        resume(repo, ["--budget", "2500", "--target", target]),
      ),
    );
    const bodies = outputs.map(stripFrame);
    for (const body of bodies) expect(body).toBe(bodies[0]);
    expect(outputs[0]).toContain("AGENTS.md");
    expect(outputs[1]).toContain("CLAUDE.md");
    expect(outputs[2]).toContain("GEMINI.md");
  });

  it("is deterministic within a repository and across identical repositories", async () => {
    const first = await resume(repo, ["--budget", "2500"]);
    expect(await resume(repo, ["--budget", "2500"])).toBe(first);

    const twin = await buildResumeFixture();
    const normalize = (text: string) => text.replace(/\b[0-9a-f]{7,40}\b/g, "<sha>");
    expect(normalize(await resume(twin, ["--budget", "2500"]))).toBe(normalize(first));
  }, 180_000);

  it("infers the only open task and refuses when there is none", async () => {
    const inferred = expectOk(
      await cli(["resume", "--budget", "1000"], {
        cwd: repo.root,
        env: { THREADLINE_NOW: RESUME_NOW },
      }),
    );
    expect(inferred.stdout).toContain(`# Threadline briefing: ${RESUME_TASK}`);

    const empty = await initializedRepo();
    const none = await cli(["resume"], { cwd: empty.root });
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("No open tasks");
  });
});
