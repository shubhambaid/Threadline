import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { exists } from "../core/fs.js";
import { KIND_DIRS, RECORD_KINDS } from "../core/ids.js";
import { defaultManifestYaml, MANIFEST_FILE } from "../core/manifest.js";
import { ALETHIC_DIR } from "../core/paths.js";
import { guessDefaultBranch } from "../git/git.js";
import { type Io, resolveRepoRoot } from "./context.js";

export const GITIGNORE_CONTENT = `# Private per-machine scratch. Never committed, never read into shared output.
local/*
!local/.gitkeep
`;

export interface InitOptions {
  name?: string;
}

export async function initCommand(io: Io, options: InitOptions): Promise<number> {
  const root = await resolveRepoRoot(io);
  const created: string[] = [];

  const ensureFile = async (rel: string, content: string | (() => Promise<string>)) => {
    const target = path.join(root, rel);
    if (await exists(target)) return;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof content === "string" ? content : await content(), {
      flag: "wx",
    });
    created.push(rel);
  };

  await ensureFile(`${ALETHIC_DIR}/.gitignore`, GITIGNORE_CONTENT);
  for (const kind of RECORD_KINDS) {
    await ensureFile(`${ALETHIC_DIR}/${KIND_DIRS[kind]}/.gitkeep`, "");
  }
  await ensureFile(`${ALETHIC_DIR}/local/.gitkeep`, "");
  // Written last: the manifest's presence is what marks the repository as initialized,
  // so an interrupted init never looks complete.
  await ensureFile(MANIFEST_FILE, async () => {
    const name = (options.name ?? path.basename(root)).slice(0, 100) || "project";
    return defaultManifestYaml(name, await guessDefaultBranch(root));
  });

  if (created.length === 0) {
    io.stdout("Alethic is already initialized. Nothing to do.\n");
    return 0;
  }
  io.stdout(
    [
      `Initialized Alethic in ${ALETHIC_DIR}/`,
      ...created.map((file) => `  created ${file}`),
      "",
      "Next, commit it:",
      `  git add ${ALETHIC_DIR} && git commit -m "Initialize Alethic"`,
      "",
    ].join("\n"),
  );
  return 0;
}
