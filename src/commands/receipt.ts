import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { constants } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { toTimestamp } from "../core/clock.js";
import { UsageError } from "../core/errors.js";
import { makeId } from "../core/ids.js";
import { loadRecordIndex } from "../core/records.js";
import { tailText, truncate } from "../core/text.js";
import {
  anchorFor,
  assertSafePaths,
  compact,
  createdBy,
  openWriteContext,
  parseInteger,
  saveRecord,
  unique,
  validAt,
  type WriteContext,
} from "../core/write.js";
import { currentBranch, isDirty } from "../git/git.js";
import { digestWorkspace } from "../trust/receipts.js";
import { redactSecrets } from "../validate/secrets.js";
import { type Io, requireInitialized } from "./context.js";
import { type CommonWriteOptions, reportWrite } from "./report.js";

const RESULTS = ["pass", "fail", "error"] as const;
const OUTPUT_TAIL_LIMIT = 4000;
/** Output kept in memory while a command runs, before redaction and truncation. */
const OUTPUT_BUFFER = 64_000;
const MAX_ARGS = 200;
const MAX_ARG_LENGTH = 1000;

export interface ReceiptAddOptions extends CommonWriteOptions {
  command: string;
  exitCode: string;
  result?: string;
  outputFile?: string;
  durationMs?: string;
  ranAt?: string;
  summary?: string;
  paths?: string[];
  id?: string;
  maxFingerprints?: string;
}

function ciProvenance(
  env: NodeJS.ProcessEnv,
  dirty: boolean,
  capture: "observed" | "imported",
): { inCi: boolean; provenance: Record<string, unknown> } {
  const inCi = (env.CI === "true" || env.CI === "1") && !dirty;
  return {
    inCi,
    provenance: inCi
      ? compact({ source: "ci-env", capture, run_url: githubRunUrl(env) })
      : { source: "local", capture },
  };
}

/**
 * Records the result of a check someone already ran, as reported. Aletheic did not observe it,
 * and the receipt says so (`provenance.capture: imported`). A receipt made in CI on a clean tree
 * is `ci-reported`, which is still a self-report (docs/spec.md §8); nothing here can produce
 * `ci-verified`.
 */
export async function receiptAddCommand(io: Io, options: ReceiptAddOptions): Promise<number> {
  const exitCode = parseInteger(options.exitCode, "--exit-code");
  const result = options.result ?? (exitCode === 0 ? "pass" : "fail");
  if (!(RESULTS as readonly string[]).includes(result)) {
    throw new UsageError(`--result must be one of: ${RESULTS.join(", ")}`);
  }
  const durationMs =
    options.durationMs === undefined
      ? undefined
      : parseInteger(options.durationMs, "--duration-ms", 0);

  const root = await requireInitialized(io);
  const ctx = await openWriteContext(root, options.agent, io.env);
  const paths = unique(options.paths);
  await assertSafePaths(ctx, paths, "--paths");

  const head = await validAt(root);
  if (!head) throw new UsageError("Receipts need at least one commit to tie the result to.");
  const [branch, dirty] = await Promise.all([currentBranch(root), isDirty(root)]);

  let outputTail: string | undefined;
  if (options.outputFile) {
    const text = await readFile(path.resolve(io.cwd, options.outputFile), "utf8").catch(() => {
      throw new UsageError(`--output-file ${options.outputFile} cannot be read`);
    });
    // Redact before truncating, so a secret cut at the boundary is still caught.
    outputTail = tailText(redactSecrets(text, ctx.patterns), OUTPUT_TAIL_LIMIT) || undefined;
  }

  const { inCi, provenance } = ciProvenance(io.env, dirty, "imported");
  const outcome =
    result === "pass" ? "passed" : result === "fail" ? `failed (exit ${exitCode})` : "errored";

  const index = await loadRecordIndex(root);
  const id = options.id ?? makeId("receipt", options.command, ctx.now);
  if (index.has(id)) throw new UsageError(`${id} already exists. Pass --id to choose another id.`);
  const anchored = await anchorFor(ctx, { scopePaths: paths }, options.maxFingerprints);

  const record = compact({
    id,
    kind: "receipt",
    schema_version: 1,
    summary: truncate(options.summary ?? `${options.command} ${outcome}`, 280),
    status: "recorded",
    confidence: inCi ? "ci-reported" : "agent-reported",
    command: options.command.trim(),
    exit_code: exitCode,
    result,
    ran_at: options.ranAt ?? ctx.timestamp,
    duration_ms: durationMs,
    git: { branch, head, dirty },
    output_tail: outputTail,
    provenance,
    scope: { paths },
    created_by: createdBy(ctx, undefined),
    created_at: ctx.timestamp,
    valid_at: head,
    anchor: anchored.anchor,
  });
  const file = await saveRecord(ctx, "receipt", record);
  reportWrite(
    io,
    {
      id,
      file,
      warnings: anchored.warnings,
      message: `Created ${file} (${result}, ${record.confidence}, reported)`,
      details: { result, confidence: record.confidence, capture: "imported" },
    },
    options.json,
  );
  return 0;
}

export interface ReceiptRunOptions extends CommonWriteOptions {
  summary?: string;
  paths?: string[];
  id?: string;
  maxFingerprints?: string;
}

interface Execution {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  spawnError?: string;
}

/**
 * Runs one command the caller names, in the foreground, and records what happened: the argv,
 * working directory, start and end times, exit code, redacted output tail, and content digests
 * of the files the command could see, taken just before and just after it ran. This is the only
 * command that executes anything; it does not schedule, retry, or supervise work (spec §3).
 * Environment variables are passed through to the command but never recorded.
 *
 * Exit codes: 0 when the check passed and was recorded, 1 when it failed or errored and was
 * recorded, 2 when nothing was recorded.
 */
export async function receiptRunCommand(
  io: Io,
  argv: readonly string[],
  options: ReceiptRunOptions,
): Promise<number> {
  if (argv.length === 0 || !argv[0]) {
    throw new UsageError("Pass the command after --, e.g. `alethic receipt run -- npm test`.");
  }
  if (argv.length > MAX_ARGS || argv.some((arg) => arg.length > MAX_ARG_LENGTH)) {
    throw new UsageError(
      `The command is too long to record (at most ${MAX_ARGS} arguments of ${MAX_ARG_LENGTH} characters). Wrap it in a script.`,
    );
  }
  const root = await requireInitialized(io);
  const ctx = await openWriteContext(root, options.agent, io.env);
  const paths = unique(options.paths);
  await assertSafePaths(ctx, paths, "--paths");

  const commandText = argv.map(quoteArg).join(" ");
  const index = await loadRecordIndex(root);
  const id = options.id ?? makeId("receipt", commandText, ctx.now);
  if (index.has(id)) throw new UsageError(`${id} already exists. Pass --id to choose another id.`);

  const headBefore = await validAt(root);
  if (!headBefore) throw new UsageError("Receipts need at least one commit to tie the result to.");
  const limit = ctx.manifest.limits.max_receipt_files;
  const [branch, dirtyBefore, before, anchored, cwd] = await Promise.all([
    currentBranch(root),
    isDirty(root),
    digestWorkspace(root, ctx.manifest, paths, limit),
    anchorFor(ctx, { scopePaths: paths }, options.maxFingerprints),
    relativeCwd(root, io.cwd),
  ]);

  const startedAt = timestamp(ctx, io);
  const started = performance.now();
  const run = await execute(argv, io, options.json ?? false);
  const durationMs = Math.round(performance.now() - started);
  const finishedAt = timestamp(ctx, io);

  const [headAfter, dirtyAfter, after] = await Promise.all([
    validAt(root),
    isDirty(root),
    digestWorkspace(root, ctx.manifest, paths, limit),
  ]);
  const changedDuringRun = before.digest !== after.digest || headBefore !== headAfter;

  const result = run.spawnError || run.signal ? "error" : run.code === 0 ? "pass" : "fail";
  const exitCode =
    run.code ??
    (run.signal ? 128 + (constants.signals[run.signal] ?? 0) : run.spawnError ? 127 : 1);
  const outcome =
    result === "pass" ? "passed" : result === "fail" ? `failed (exit ${exitCode})` : "errored";
  const output = run.spawnError ? `${run.output}\n${run.spawnError}` : run.output;
  const outputTail = tailText(redactSecrets(output, ctx.patterns), OUTPUT_TAIL_LIMIT) || undefined;
  const { inCi, provenance } = ciProvenance(io.env, dirtyBefore, "observed");
  const coverage =
    before.coverage === "partial" || after.coverage === "partial" ? "partial" : before.coverage;

  const record = compact({
    id,
    kind: "receipt",
    schema_version: 1,
    summary: truncate(options.summary ?? `${commandText} ${outcome}`, 280),
    status: "recorded",
    confidence: inCi ? "ci-reported" : "agent-reported",
    command: truncate(commandText, 1000),
    exit_code: exitCode,
    result,
    ran_at: startedAt,
    duration_ms: durationMs,
    git: { branch, head: headBefore, dirty: dirtyBefore },
    output_tail: outputTail,
    provenance,
    execution: {
      argv: [...argv],
      cwd,
      started_at: startedAt,
      finished_at: finishedAt,
      signal: run.signal ?? undefined,
    },
    state: {
      coverage,
      file_limit: limit,
      before: { head: headBefore, dirty: dirtyBefore, digest: before.digest, files: before.files },
      after: {
        head: headAfter ?? headBefore,
        dirty: dirtyAfter,
        digest: after.digest,
        files: after.files,
      },
      changed_during_run: changedDuringRun,
    },
    scope: { paths },
    created_by: createdBy(ctx, undefined),
    created_at: ctx.timestamp,
    valid_at: headBefore,
    anchor: anchored.anchor,
  });

  let file: string;
  try {
    file = await saveRecord(ctx, "receipt", record);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    throw new UsageError(
      `The command ran (${outcome}), but no receipt was written. ${error.message}`,
    );
  }

  const warnings = [...anchored.warnings];
  if (changedDuringRun) {
    warnings.push("Files changed while the command ran, so what it tested is unclear.");
  }
  if (coverage === "partial") {
    warnings.push(
      `Only the first ${limit} of ${Math.max(before.matched, after.matched)} files were digested (limits.max_receipt_files), so later changes to the rest go unnoticed.`,
    );
  }
  reportWrite(
    io,
    {
      id,
      file,
      warnings,
      message: `Recorded ${file} (${result}, exit ${exitCode}, observed; ${changedDuringRun ? "files changed while it ran" : "no files changed while it ran"})`,
      details: {
        result,
        exitCode,
        confidence: record.confidence,
        capture: "observed",
        coverage,
        changedDuringRun,
      },
    },
    options.json,
  );
  return result === "pass" ? 0 : 1;
}

/** Output streams through as it arrives; with --json it goes to stderr so stdout stays JSON. */
function execute(argv: readonly string[], io: Io, json: boolean): Promise<Execution> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (execution: Execution) => {
      if (settled) return;
      settled = true;
      resolve(execution);
    };
    const keep = (chunk: string) => {
      output = (output + chunk).slice(-OUTPUT_BUFFER);
    };
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: io.cwd,
      env: io.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      keep(chunk);
      (json ? io.stderr : io.stdout)(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      keep(chunk);
      io.stderr(chunk);
    });
    child.on("error", (error) =>
      finish({ code: null, signal: null, output, spawnError: error.message }),
    );
    child.on("close", (code, signal) => finish({ code, signal, output }));
  });
}

function timestamp(ctx: WriteContext, io: Io): string {
  return io.env.ALETHIC_NOW ? ctx.timestamp : toTimestamp(new Date());
}

async function relativeCwd(root: string, cwd: string): Promise<string> {
  const relative = path.relative(await realpath(root), await realpath(cwd));
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function quoteArg(arg: string): string {
  return /^[A-Za-z0-9_./:@=,+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function githubRunUrl(env: NodeJS.ProcessEnv): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}
