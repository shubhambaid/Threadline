import { describe, expect, it } from "vitest";
import { captureAnchor, digestOf } from "../../src/core/anchor.js";
import { createRepo } from "../helpers/fixture-repo.js";

const LIMITS = { maxFingerprints: 50, maxGlobMatches: 2000, forbiddenGlobs: [] };

async function sampleRepo() {
  const repo = await createRepo();
  repo.write("src/a.ts", "export const a = 1;\n");
  repo.write("src/b.ts", "export const b = 2;\n");
  repo.write("src/nested/c.ts", "export const c = 3;\n");
  repo.write("config/prod.env", "SECRET=1\n");
  repo.write("README.md", "# sample\n");
  repo.write(".threadline/manifest.yaml", "format_version: 1\n");
  await repo.commitAll("initial");
  return repo;
}

async function blobAtHead(repo: Awaited<ReturnType<typeof createRepo>>, file: string) {
  return (await repo.run(["rev-parse", `HEAD:${file}`])).trim();
}

describe("digestOf", () => {
  it("matches git's blob id", () => {
    expect(digestOf("hello")).toBe("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
  });
});

describe("captureAnchor", () => {
  it("fingerprints evidence files and scope matches with git blob ids", async () => {
    const repo = await sampleRepo();
    const { anchor, warnings } = await captureAnchor(
      repo.root,
      { scopePaths: ["src/**"], evidenceFiles: ["README.md"] },
      LIMITS,
    );
    expect(warnings).toEqual([]);
    expect(anchor?.commit).toBe(repo.commits[0]);
    expect(Object.keys(anchor?.fingerprints ?? {})).toEqual([
      "README.md",
      "src/a.ts",
      "src/b.ts",
      "src/nested/c.ts",
    ]);
    expect(anchor?.fingerprints["src/a.ts"]).toBe(await blobAtHead(repo, "src/a.ts"));
    expect(anchor?.overflow).toBeUndefined();
  });

  it("hashes working-tree content, not HEAD", async () => {
    const repo = await sampleRepo();
    repo.write("src/a.ts", "export const a = 42;\n");
    const { anchor } = await captureAnchor(repo.root, { evidenceFiles: ["src/a.ts"] }, LIMITS);
    expect(anchor?.fingerprints["src/a.ts"]).not.toBe(await blobAtHead(repo, "src/a.ts"));
  });

  it("puts evidence first and summarizes files beyond the limit", async () => {
    const repo = await sampleRepo();
    const { anchor, warnings } = await captureAnchor(
      repo.root,
      { scopePaths: ["src"], evidenceFiles: ["src/nested/c.ts"] },
      { ...LIMITS, maxFingerprints: 1 },
    );
    expect(Object.keys(anchor?.fingerprints ?? {})).toEqual(["src/nested/c.ts"]);
    expect(anchor?.overflow?.count).toBe(2);
    expect(anchor?.overflow?.digest).toMatch(/^[0-9a-f]{40}$/);
    expect(warnings[0]).toMatch(/summarized in anchor.overflow/);
  });

  it("is deterministic", async () => {
    const repo = await sampleRepo();
    const input = { scopePaths: ["**"], evidenceFiles: ["src/b.ts"] };
    const limits = { ...LIMITS, maxFingerprints: 2 };
    expect(await captureAnchor(repo.root, input, limits)).toEqual(
      await captureAnchor(repo.root, input, limits),
    );
  });

  it("excludes forbidden paths, .threadline, unsafe and missing files", async () => {
    const repo = await sampleRepo();
    const { anchor } = await captureAnchor(
      repo.root,
      { scopePaths: ["**"], evidenceFiles: ["../outside.ts", "src/missing.ts"] },
      { ...LIMITS, forbiddenGlobs: ["**/*.env"] },
    );
    expect(Object.keys(anchor?.fingerprints ?? {})).toEqual([
      "README.md",
      "src/a.ts",
      "src/b.ts",
      "src/nested/c.ts",
    ]);
  });

  it("warns when scope expansion hits the glob limit", async () => {
    const repo = await sampleRepo();
    const { warnings } = await captureAnchor(
      repo.root,
      { scopePaths: ["**"] },
      { ...LIMITS, maxGlobMatches: 2 },
    );
    expect(warnings[0]).toMatch(/more than 2 tracked files/);
  });

  it("captures nothing before the first commit", async () => {
    const repo = await createRepo();
    repo.write("src/a.ts", "x\n");
    const result = await captureAnchor(repo.root, { evidenceFiles: ["src/a.ts"] }, LIMITS);
    expect(result.anchor).toBeUndefined();
    expect(result.warnings[0]).toMatch(/no commits/);
  });
});
