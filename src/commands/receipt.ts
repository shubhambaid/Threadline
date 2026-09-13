import { readFile } from "node:fs/promises";
import path from "node:path";
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
} from "../core/write.js";
import { currentBranch, isDirty } from "../git/git.js";
import { redactSecrets } from "../validate/secrets.js";
import { type Io, requireInitialized } from "./context.js";
import { type CommonWriteOptions, reportWrite } from "./report.js";

const RESULTS = ["pass", "fail", "error"] as const;
const OUTPUT_TAIL_LIMIT = 4000;

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

/**
 * Records the result of a check someone already ran. Threadline never runs the command.
 * A receipt made in CI on a clean tree is `ci-reported`, which is still a self-report
 * (docs/spec.md §8); nothing here can produce `ci-verified`.
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

  const inCi = (io.env.CI === "true" || io.env.CI === "1") && !dirty;
  const provenance = inCi
    ? compact({ source: "ci-env", run_url: githubRunUrl(io.env) })
    : { source: "local" };
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
      message: `Created ${file} (${result}, ${record.confidence})`,
      details: { result, confidence: record.confidence },
    },
    options.json,
  );
  return 0;
}

function githubRunUrl(env: NodeJS.ProcessEnv): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}
