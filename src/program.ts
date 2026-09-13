import path from "node:path";
import { type Command, CommanderError, Command as CommanderProgram } from "commander";
import pkg from "../package.json" with { type: "json" };
import type { Io } from "./commands/context.js";
import { initCommand } from "./commands/init.js";
import { statusCommand } from "./commands/status.js";
import { validateCommand } from "./commands/validate.js";
import { UsageError } from "./core/errors.js";
import { GitError } from "./git/git.js";

/**
 * Runs the Threadline CLI and resolves to its exit code:
 * 0 success, 1 validation errors, 2 usage or environment problems.
 */
export async function runCli(argv: readonly string[], io: Io): Promise<number> {
  let exitCode = 0;
  const program = new CommanderProgram()
    .name("threadline")
    .description("Shared memory for coding agents, anchored to Git.")
    .version(pkg.version, "-v, --version")
    .option("-C, --cwd <dir>", "run as if Threadline was started in <dir>")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
    });

  const ioFor = (command: Command): Io => {
    const { cwd } = command.optsWithGlobals<{ cwd?: string }>();
    return cwd ? { ...io, cwd: path.resolve(io.cwd, cwd) } : io;
  };

  program
    .command("init")
    .description("Create .threadline/ in the current Git repository")
    .option("--name <name>", "project name (default: the repository directory name)")
    .action(async (options, command: Command) => {
      exitCode = await initCommand(ioFor(command), options);
    });

  program
    .command("validate")
    .description("Check records for schema, provenance, privacy, and lease problems")
    .option("--json", "print a machine-readable report")
    .option("--strict", "treat missing evidence commits as errors")
    .action(async (options, command: Command) => {
      exitCode = await validateCommand(ioFor(command), options);
    });

  program
    .command("status")
    .description("Show Git state, active tasks, and validation summary")
    .option("--json", "print machine-readable status")
    .action(async (options, command: Command) => {
      exitCode = await statusCommand(ioFor(command), options);
    });

  try {
    await program.parseAsync([...argv], { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    if (error instanceof UsageError || error instanceof GitError) {
      io.stderr(`error: ${error.message}\n`);
      return 2;
    }
    io.stderr(`error: unexpected failure: ${(error as Error).message}\n`);
    if (io.env.THREADLINE_DEBUG) io.stderr(`${(error as Error).stack}\n`);
    return 2;
  }
}
