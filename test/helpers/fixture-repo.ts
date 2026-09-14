import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../../src/git/git.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

export interface FixtureRepo {
  root: string;
  /** Full shas of commits made through this helper, oldest first. */
  commits: string[];
  run(args: string[]): Promise<string>;
  write(rel: string, content: string): void;
  commitAll(message: string): Promise<string>;
}

/** A fresh repository on `main` with local identity and no hooks or signing. */
export async function createRepo(): Promise<FixtureRepo> {
  const root = mkdtempSync(path.join(tmpdir(), "alethic-repo-"));
  const repo: FixtureRepo = {
    root,
    commits: [],
    async run(args) {
      const result = await git(root, args);
      if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      return result.stdout;
    },
    write(rel, content) {
      const target = path.join(root, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    },
    async commitAll(message) {
      await repo.run(["add", "-A"]);
      await repo.run(["commit", "--quiet", "--allow-empty", "-m", message]);
      const sha = (await repo.run(["rev-parse", "HEAD"])).trim();
      repo.commits.push(sha);
      return sha;
    },
  };
  await repo.run(["init", "--quiet", "--initial-branch=main"]);
  for (const [key, value] of [
    ["user.name", "Alethic Tests"],
    ["user.email", "tests@alethic.invalid"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
    ["core.hooksPath", ".git/no-hooks"],
  ] as const) {
    await repo.run(["config", key, value]);
  }
  return repo;
}

/**
 * Builds a repository from test/fixtures/<name>/:
 * - `commits/<n>/` trees are applied and committed in numeric order. A `.delete` file lists
 *   paths to remove in that step.
 * - `alethic/` is copied to `.alethic/`, with `{{commit:N}}`, `{{short:N}}`, and
 *   `{{blob:path}}` replaced by the full sha of commit N, its 7-char prefix, and the blob id
 *   of `path` at HEAD.
 */
export async function createFixtureRepo(
  name: string,
  options: { commitRecords?: boolean } = {},
): Promise<FixtureRepo> {
  const dir = path.join(FIXTURES, name);
  if (!existsSync(dir)) throw new Error(`Unknown fixture: ${name}`);
  const repo = await createRepo();

  const commitsDir = path.join(dir, "commits");
  const steps = existsSync(commitsDir)
    ? readdirSync(commitsDir)
        .filter((step) => /^\d+$/.test(step))
        .sort((a, b) => Number(a) - Number(b))
    : [];
  if (steps.length === 0) {
    repo.write("README.md", "# fixture\n");
    await repo.commitAll("fixture: initial");
  }
  for (const step of steps) {
    const stepDir = path.join(commitsDir, step);
    const deletions = path.join(stepDir, ".delete");
    if (existsSync(deletions)) {
      for (const rel of readFileSync(deletions, "utf8").split("\n")) {
        if (rel.trim()) rmSync(path.join(repo.root, rel.trim()), { force: true, recursive: true });
      }
    }
    cpSync(stepDir, repo.root, {
      recursive: true,
      filter: (source) => path.basename(source) !== ".delete",
    });
    await repo.commitAll(`fixture: commit ${step}`);
  }

  const alethicDir = path.join(dir, "alethic");
  if (existsSync(alethicDir)) {
    await copyWithSubstitution(repo, alethicDir, path.join(repo.root, ".alethic"));
    if (options.commitRecords ?? true) await repo.commitAll("fixture: alethic records");
  }
  return repo;
}

async function copyWithSubstitution(repo: FixtureRepo, from: string, to: string): Promise<void> {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyWithSubstitution(repo, source, target);
    } else {
      writeFileSync(target, await substitute(repo, readFileSync(source, "utf8")));
    }
  }
}

async function substitute(repo: FixtureRepo, text: string): Promise<string> {
  let out = text;
  for (const token of new Set(text.match(/\{\{(?:commit|short|blob):[^}]+\}\}/g) ?? [])) {
    const [, type, arg = ""] = /^\{\{(commit|short|blob):([^}]+)\}\}$/.exec(token) ?? [];
    let value: string;
    if (type === "blob") {
      value = (await repo.run(["rev-parse", `HEAD:${arg}`])).trim();
    } else {
      const sha = repo.commits[Number(arg) - 1];
      if (!sha) throw new Error(`Fixture references missing commit ${arg}`);
      value = type === "short" ? sha.slice(0, 7) : sha;
    }
    out = out.split(token).join(value);
  }
  return out;
}
