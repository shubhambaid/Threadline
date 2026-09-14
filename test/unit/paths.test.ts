import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkContainment,
  checkRepoPath,
  expandScope,
  scopeMatcher,
} from "../../src/core/paths.js";
import { validateAgainst } from "../../src/validate/schema.js";

const SAFE = [
  "src/a.ts",
  "apps/api/auth/**",
  ".github/workflows/ci.yml",
  "a/b/",
  "**/*.env",
  "x..y/z",
  "{a,b}/*.ts",
  "file.name.ts",
];

const UNSAFE = [
  "",
  "/etc/passwd",
  "~/x",
  "C:/x",
  "c:x",
  "a\\b",
  "a//b",
  "./a",
  "a/./b",
  "../a",
  "a/..",
  "a/../b",
  ".",
  "..",
  "a\0b",
];

function schemaAccepts(p: string): boolean {
  return validateAgainst("knowledge", {
    id: "kn-x",
    kind: "knowledge",
    schema_version: 1,
    summary: "x",
    status: "active",
    confidence: "inferred",
    category: "gotcha",
    body: "x",
    created_by: { agent: "codex" },
    created_at: "2026-09-13T00:00:00Z",
    scope: { paths: [p] },
  }).valid;
}

describe("checkRepoPath", () => {
  it.each(SAFE)("accepts %j", (p) => {
    expect(checkRepoPath(p)).toBeUndefined();
  });

  it.each(UNSAFE)("rejects %j", (p) => {
    expect(checkRepoPath(p)).toBeDefined();
  });

  it.each([...SAFE, ...UNSAFE])("agrees with the schema pattern for %j", (p) => {
    expect(checkRepoPath(p) === undefined).toBe(schemaAccepts(p));
  });
});

describe("scope matching", () => {
  const tracked = [
    "apps/api/auth/refresh.ts",
    "apps/api/auth/session.ts",
    "apps/api/cache/redis.ts",
    "apps/web/index.ts",
    "README.md",
  ];

  it("treats plain paths as the file or directory subtree", () => {
    const match = scopeMatcher(["apps/api/auth", "README.md"]);
    expect(tracked.filter(match)).toEqual([
      "apps/api/auth/refresh.ts",
      "apps/api/auth/session.ts",
      "README.md",
    ]);
  });

  it("expands globs against tracked files with a limit", () => {
    expect(expandScope(tracked, ["apps/api/**"], 10)).toEqual({
      files: ["apps/api/auth/refresh.ts", "apps/api/auth/session.ts", "apps/api/cache/redis.ts"],
      truncated: false,
    });
    expect(expandScope(tracked, ["apps/**"], 2)).toEqual({
      files: ["apps/api/auth/refresh.ts", "apps/api/auth/session.ts"],
      truncated: true,
    });
  });

  it("matches nothing for an empty scope", () => {
    expect(tracked.filter(scopeMatcher([]))).toEqual([]);
  });
});

describe("checkContainment", () => {
  const base = mkdtempSync(path.join(tmpdir(), "alethic-paths-"));
  const repo = path.join(base, "repo");
  const outside = path.join(base, "outside");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(repo, "src", "a.ts"), "");
  writeFileSync(path.join(outside, "secret.txt"), "");
  symlinkSync(outside, path.join(repo, "linked"));
  symlinkSync(path.join(repo, "src"), path.join(repo, "inner-link"));

  it("accepts files inside the repository", async () => {
    expect(await checkContainment(repo, "src/a.ts")).toBe("inside");
    expect(await checkContainment(repo, "inner-link/a.ts")).toBe("inside");
  });

  it("reports missing files inside the repository", async () => {
    expect(await checkContainment(repo, "src/missing.ts")).toBe("missing");
  });

  it("rejects symlink escapes, even for missing files", async () => {
    expect(await checkContainment(repo, "linked/secret.txt")).toBe("outside");
    expect(await checkContainment(repo, "linked/missing.txt")).toBe("outside");
  });
});
