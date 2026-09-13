import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type BlockAction,
  hasBlock,
  INSTRUCTION_FILES,
  INSTRUCTION_KINDS,
  type InstructionKind,
  importsAgentsMd,
  instructionBlock,
  upsertBlock,
} from "../adapters/blocks.js";
import { buildPrSummary } from "../compile/pr-summary.js";
import { UsageError } from "../core/errors.js";
import { checkContainment } from "../core/paths.js";
import { type Io, requireInitialized } from "./context.js";
import { prepareTask } from "./resume.js";

export const RENDER_KINDS = [...INSTRUCTION_KINDS, "pr-summary"] as const;

export interface RenderOptions {
  write?: boolean;
  check?: boolean;
  task?: string;
  agent?: string;
}

const WROTE: Record<Exclude<BlockAction, "unchanged">, string> = {
  created: "Created",
  inserted: "Added the Threadline block to",
  updated: "Updated the Threadline block in",
};

const WOULD: Record<Exclude<BlockAction, "unchanged">, string> = {
  created: "create",
  inserted: "add the block to",
  updated: "update the block in",
};

export async function renderCommand(io: Io, kind: string, options: RenderOptions): Promise<number> {
  if (!(RENDER_KINDS as readonly string[]).includes(kind)) {
    throw new UsageError(`Unknown output "${kind}". Choose one of: ${RENDER_KINDS.join(", ")}`);
  }
  if (kind === "pr-summary") {
    if (options.write || options.check) {
      throw new UsageError(
        "pr-summary prints to stdout. Pipe it instead, e.g. `threadline render pr-summary | gh pr create --body-file -`.",
      );
    }
    const prepared = await prepareTask(io, options);
    io.stdout(buildPrSummary(prepared));
    return 0;
  }
  if (options.task) throw new UsageError("--task only applies to pr-summary.");
  if (options.write && options.check) throw new UsageError("Pass --write or --check, not both.");

  const root = await requireInitialized(io);
  const instructionKind = kind as InstructionKind;
  const file = INSTRUCTION_FILES[instructionKind];
  const target = await resolveTarget(root, file);
  const existing = await readOptional(target);

  if (instructionKind !== "agents-md") {
    const agentsReal = await realpath(path.join(root, "AGENTS.md")).catch(() => undefined);
    const targetReal = await realpath(target).catch(() => undefined);
    if (agentsReal && targetReal === agentsReal) {
      throw new UsageError(
        `${file} is a link to AGENTS.md. Run \`threadline render agents-md --write\` so every agent shares one block.`,
      );
    }
    if (existing !== undefined && importsAgentsMd(existing) && !hasBlock(existing)) {
      const agents = agentsReal ? await readOptional(agentsReal) : undefined;
      if (agents !== undefined && hasBlock(agents)) {
        io.stdout(
          `${file} imports AGENTS.md, which already has the Threadline block. Nothing to change.\n`,
        );
        return 0;
      }
    }
  }

  const block = instructionBlock(instructionKind);
  const { content, action } = upsertBlock(existing, block, file);

  if (options.check) {
    if (action === "unchanged") {
      io.stdout(`${file} is up to date.\n`);
      return 0;
    }
    const state = existing === undefined ? "does not exist" : "is out of date";
    io.stderr(`${file} ${state}. Run \`threadline render ${kind} --write\`.\n`);
    return 1;
  }
  if (!options.write) {
    io.stdout(`${block}\n`);
    io.stderr(
      action === "unchanged"
        ? `Preview only; ${file} is already up to date.\n`
        : `Preview only. Pass --write to ${WOULD[action]} ${file}.\n`,
    );
    return 0;
  }
  if (action === "unchanged") {
    io.stdout(`${file} is up to date.\n`);
    return 0;
  }
  const temp = `${target}.tmp-${process.pid}`;
  await writeFile(temp, content, "utf8");
  await rename(temp, target);
  io.stdout(`${WROTE[action]} ${file}.\n`);
  return 0;
}

/** The file to write: itself, or the target of a symlink that stays inside the repository. */
async function resolveTarget(root: string, file: string): Promise<string> {
  const joined = path.join(root, file);
  const info = await lstat(joined).catch(() => undefined);
  if (!info) return joined;
  if (!info.isSymbolicLink()) return joined;
  const containment = await checkContainment(root, file);
  if (containment === "outside") {
    throw new UsageError(`${file} links outside the repository; refusing to write through it.`);
  }
  if (containment === "missing") {
    throw new UsageError(`${file} is a broken link; fix or remove it first.`);
  }
  return realpath(joined);
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
