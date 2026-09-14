import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type AnchorInput, captureAnchor } from "../../src/core/anchor.js";
import { resolveManifest } from "../../src/core/manifest.js";
import { git } from "../../src/git/git.js";
import { assessStaleness, createStalenessContext, lineDelta } from "../../src/trust/staleness.js";
import { createRepo, type FixtureRepo } from "../helpers/fixture-repo.js";

const MANIFEST = resolveManifest({
  project: { name: "t" },
  staleness: { changed_lines_threshold: 3 },
});
const LIMITS = { maxFingerprints: 50, maxGlobMatches: 2000, forbiddenGlobs: [] as string[] };

function lines(n: number, prefix = "line"): string {
  return `${Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n")}\n`;
}

async function baseRepo(): Promise<FixtureRepo> {
  const repo = await createRepo();
  repo.write("src/a.ts", lines(10));
  repo.write("src/b.ts", lines(5, "b"));
  await repo.commitAll("initial");
  return repo;
}

async function record(repo: FixtureRepo, input: AnchorInput, limits = LIMITS) {
  const { anchor } = await captureAnchor(repo.root, input, limits);
  return {
    scope: { paths: input.scopePaths ?? [] },
    evidence: { files: input.evidenceFiles ?? [] },
    anchor,
  };
}

async function assess(root: string, data: Record<string, unknown>) {
  return assessStaleness(await createStalenessContext(root, MANIFEST), data);
}

describe("lineDelta", () => {
  it("counts added and deleted lines", () => {
    expect(lineDelta("a\nb\nc\n", "a\nc\nd\n")).toEqual({ added: 1, deleted: 1 });
    expect(lineDelta("same\n", "same\n")).toEqual({ added: 0, deleted: 0 });
  });
});

describe("assessStaleness", () => {
  it("is unanchored without fingerprints", async () => {
    const repo = await baseRepo();
    expect((await assess(repo.root, {})).status).toBe("unanchored");
  });

  it("is fresh when nothing changed", async () => {
    const repo = await baseRepo();
    const data = await record(repo, { scopePaths: ["src/**"], evidenceFiles: ["src/a.ts"] });
    expect(await assess(repo.root, data)).toMatchObject({ status: "fresh", anchor: "ancestor" });
  });

  it("stays fresh for edits within the threshold", async () => {
    const repo = await baseRepo();
    const data = await record(repo, { evidenceFiles: ["src/a.ts"] });
    repo.write("src/a.ts", lines(10).replace("line 3", "line three"));
    const result = await assess(repo.root, data);
    expect(result.status).toBe("fresh");
    expect(result.notes.join("\n")).toContain(
      "src/a.ts changed 2 lines, within the threshold of 3",
    );
  });

  it("needs reverification when a file changes beyond the threshold", async () => {
    const repo = await baseRepo();
    const data = await record(repo, { evidenceFiles: ["src/a.ts"] });
    repo.write("src/a.ts", lines(10, "new"));
    const result = await assess(repo.root, data);
    expect(result.status).toBe("needs_reverification");
    expect(result.reasons[0]).toBe("src/a.ts changed 20 lines (+10/-10) since it was anchored");
  });

  it("needs reverification when the anchored version was never committed", async () => {
    const repo = await baseRepo();
    repo.write("src/draft.ts", "draft 1\n");
    const data = await record(repo, { evidenceFiles: ["src/draft.ts"] });
    repo.write("src/draft.ts", "draft 2\n");
    const result = await assess(repo.root, data);
    expect(result.status).toBe("needs_reverification");
    expect(result.reasons[0]).toContain("anchored version is not in this repository");
  });

  it("reports broken evidence when a cited file is deleted", async () => {
    const repo = await baseRepo();
    const data = await record(repo, { evidenceFiles: ["src/a.ts"] });
    await repo.run(["rm", "-q", "src/a.ts"]);
    const result = await assess(repo.root, data);
    expect(result.status).toBe("broken_evidence");
    expect(result.reasons).toContain("src/a.ts no longer exists");
  });

  it("needs reverification when files are added under scope", async () => {
    const repo = await baseRepo();
    const data = await record(repo, { scopePaths: ["src/**"] });
    repo.write("src/new.ts", "export {};\n");
    await repo.commitAll("add new file");
    const result = await assess(repo.root, data);
    expect(result.status).toBe("needs_reverification");
    expect(result.reasons[0]).toBe("1 file added under scope: src/new.ts");
  });

  it("detects changes among files summarized in the overflow digest", async () => {
    const repo = await baseRepo();
    const data = await record(repo, { scopePaths: ["src/**"] }, { ...LIMITS, maxFingerprints: 1 });
    expect(Object.keys(data.anchor?.fingerprints ?? {})).toEqual(["src/a.ts"]);
    expect((await assess(repo.root, data)).status).toBe("fresh");
    repo.write("src/b.ts", lines(5, "b").replace("b 0", "b zero"));
    const result = await assess(repo.root, data);
    expect(result.status).toBe("needs_reverification");
    expect(result.reasons).toContain("files beyond the fingerprint limit changed");
  });

  it("only notes changes to files matched by a scope glob when the record cites evidence", async () => {
    const repo = await baseRepo();
    const data = await record(repo, { scopePaths: ["src/**"], evidenceFiles: ["src/a.ts"] });
    repo.write("src/b.ts", lines(5, "rewritten"));
    repo.write("src/c.ts", "export {};\n");
    await repo.commitAll("edit around the evidence");
    const result = await assess(repo.root, data);
    expect(result.status).toBe("fresh");
    expect(result.notes).toContain(
      "src/b.ts changed 10 lines (+5/-5), but only a scope glob matches it",
    );
    expect(result.notes).toContain("1 file added under a scope glob: src/c.ts");

    repo.write("src/a.ts", lines(10, "new"));
    expect((await assess(repo.root, data)).status).toBe("needs_reverification");
  });

  it("treats files named exactly in scope as direct", async () => {
    const repo = await baseRepo();
    const data = await record(repo, { scopePaths: ["src/a.ts", "src/**"] });
    repo.write("src/b.ts", lines(5, "rewritten"));
    expect((await assess(repo.root, data)).status).toBe("fresh");
    repo.write("src/a.ts", lines(10, "new"));
    const result = await assess(repo.root, data);
    expect(result.status).toBe("needs_reverification");
    expect(result.reasons).toEqual(["src/a.ts changed 20 lines (+10/-10) since it was anchored"]);
  });

  it("keeps scope-only records sensitive to every matched file", async () => {
    const repo = await baseRepo();
    const data = await record(repo, { scopePaths: ["src/**"] });
    repo.write("src/b.ts", lines(5, "rewritten"));
    expect((await assess(repo.root, data)).status).toBe("needs_reverification");
  });

  it("stays fresh after its branch is squash-merged, deleted, and garbage-collected", async () => {
    const repo = await baseRepo();
    await repo.run(["checkout", "-q", "-b", "feature"]);
    repo.write("src/feature.ts", lines(4, "feature"));
    await repo.commitAll("feature work");
    const data = await record(repo, {
      scopePaths: ["src/feature.ts"],
      evidenceFiles: ["src/feature.ts"],
    });

    await repo.run(["checkout", "-q", "main"]);
    await repo.run(["merge", "--squash", "-q", "feature"]);
    await repo.run(["commit", "-q", "-m", "Squash feature"]);
    await repo.run(["branch", "-D", "feature"]);
    await repo.run(["reflog", "expire", "--expire=now", "--all"]);
    await repo.run(["gc", "--prune=now", "--quiet"]);
    const anchorCommit = data.anchor?.commit ?? "";
    expect((await git(repo.root, ["cat-file", "-e", `${anchorCommit}^{commit}`])).code).not.toBe(0);

    const result = await assess(repo.root, data);
    expect(result).toMatchObject({ status: "fresh", anchor: "unavailable" });
    expect(result.notes.join("\n")).toContain("is not in this repository");
  });

  it("stays fresh in a shallow clone that lacks the anchor commit", async () => {
    const repo = await baseRepo();
    const data = await record(repo, { evidenceFiles: ["src/a.ts"] });
    repo.write("src/b.ts", lines(6, "b"));
    await repo.commitAll("later work");
    const clone = path.join(mkdtempSync(path.join(tmpdir(), "alethic-shallow-")), "clone");
    const cloned = await git(tmpdir(), [
      "clone",
      "-q",
      "--depth",
      "1",
      `file://${repo.root}`,
      clone,
    ]);
    expect(cloned.code, cloned.stderr).toBe(0);
    expect(await assess(clone, data)).toMatchObject({ status: "fresh", anchor: "unavailable" });
  });

  it("is diverged when anchored on another line of history with different content", async () => {
    const repo = await baseRepo();
    await repo.run(["checkout", "-q", "-b", "other"]);
    repo.write("src/a.ts", lines(10, "other"));
    await repo.commitAll("other line");
    const data = await record(repo, { evidenceFiles: ["src/a.ts"] });
    await repo.run(["checkout", "-q", "main"]);
    const result = await assess(repo.root, data);
    expect(result).toMatchObject({ status: "diverged", anchor: "other-line" });
    expect(result.reasons[0]).toBe(
      "anchored on another line of history, and the content here differs",
    );
  });

  it("stays fresh on another line of history when the content matches", async () => {
    const repo = await baseRepo();
    await repo.run(["checkout", "-q", "-b", "other"]);
    repo.write("src/b.ts", lines(7, "b"));
    await repo.commitAll("unrelated change");
    const data = await record(repo, { evidenceFiles: ["src/a.ts"] });
    await repo.run(["checkout", "-q", "main"]);
    const result = await assess(repo.root, data);
    expect(result).toMatchObject({ status: "fresh", anchor: "other-line" });
    expect(result.notes).toContain("anchored on another line of history, but the content matches");
  });
});
