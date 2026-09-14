import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseYaml } from "../../src/core/format.js";
import { git } from "../../src/git/git.js";
import { validateAgainst } from "../../src/validate/schema.js";
import { createRepo } from "../helpers/fixture-repo.js";
import { cli } from "../helpers/run-cli.js";

const LAYOUT = [
  ".alethic/manifest.yaml",
  ".alethic/.gitignore",
  ".alethic/tasks/.gitkeep",
  ".alethic/decisions/.gitkeep",
  ".alethic/knowledge/.gitkeep",
  ".alethic/checkpoints/.gitkeep",
  ".alethic/receipts/.gitkeep",
  ".alethic/local/.gitkeep",
];

async function repoWithCommit() {
  const repo = await createRepo();
  repo.write("README.md", "# project\n");
  await repo.commitAll("initial");
  return repo;
}

describe("alethic init", () => {
  it("creates the layout and a schema-valid manifest", async () => {
    const repo = await repoWithCommit();
    const result = await cli(["init", "--name", "acme-api"], { cwd: repo.root });
    expect(result.code).toBe(0);
    for (const rel of LAYOUT) {
      expect(existsSync(path.join(repo.root, rel)), rel).toBe(true);
      expect(result.stdout).toContain(`created ${rel}`);
    }
    const manifest = parseYaml(
      readFileSync(path.join(repo.root, ".alethic/manifest.yaml"), "utf8"),
    );
    expect(manifest.problems).toEqual([]);
    expect(validateAgainst("manifest", manifest.data).issues).toEqual([]);
    expect(manifest.data).toMatchObject({
      project: { name: "acme-api" },
      defaults: { default_branch: "main" },
      trust: { ci_provenance: "none" },
    });
  });

  it("is idempotent", async () => {
    const repo = await repoWithCommit();
    await cli(["init"], { cwd: repo.root });
    const manifestPath = path.join(repo.root, ".alethic/manifest.yaml");
    const before = readFileSync(manifestPath, "utf8");
    const again = await cli(["init", "--name", "other"], { cwd: repo.root });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("already initialized");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });

  it("keeps local/ out of Git but tracks its .gitkeep", async () => {
    const repo = await repoWithCommit();
    await cli(["init"], { cwd: repo.root });
    repo.write(".alethic/local/notes.md", "private scratch\n");
    expect((await git(repo.root, ["check-ignore", "-q", ".alethic/local/notes.md"])).code).toBe(0);
    expect((await git(repo.root, ["check-ignore", "-q", ".alethic/local/.gitkeep"])).code).toBe(1);
  });

  it("validates cleanly right after init", async () => {
    const repo = await repoWithCommit();
    await cli(["init"], { cwd: repo.root });
    const result = await cli(["validate"], { cwd: repo.root });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("✓ 0 records valid");
  });

  it("fails outside a Git repository", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "alethic-nogit-"));
    const result = await cli(["init"], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Not inside a Git repository");
  });

  it("honors -C", async () => {
    const repo = await repoWithCommit();
    const result = await cli(["-C", repo.root, "init"], { cwd: tmpdir() });
    expect(result.code).toBe(0);
    expect(existsSync(path.join(repo.root, ".alethic/manifest.yaml"))).toBe(true);
  });
});
