import { UsageError } from "../core/errors.js";
import { loadRecordIndex, requireRecord } from "../core/records.js";
import { truncate } from "../core/text.js";
import { openWriteContext, saveRecord } from "../core/write.js";
import { type Io, requireInitialized } from "./context.js";
import { type CommonWriteOptions, reportWrite } from "./report.js";

export interface StatusUpdateOptions extends CommonWriteOptions {
  status?: string;
  summary?: string;
}

/** `decision update` and `knowledge update`: change status or summary of an editable record. */
export async function updateRecordCommand(
  io: Io,
  kind: "decision" | "knowledge",
  id: string,
  options: StatusUpdateOptions,
  allowedStatuses: readonly string[],
): Promise<number> {
  if (!options.status && !options.summary) {
    throw new UsageError("Nothing to update. Pass --status or --summary.");
  }
  if (options.status && !allowedStatuses.includes(options.status)) {
    throw new UsageError(`--status must be one of: ${allowedStatuses.join(", ")}`);
  }
  const root = await requireInitialized(io);
  const ctx = await openWriteContext(root, options.agent, io.env);
  const record = requireRecord(await loadRecordIndex(root), id, kind);
  const updated = {
    ...record.data,
    ...(options.status ? { status: options.status } : {}),
    ...(options.summary ? { summary: truncate(options.summary, 280) } : {}),
    updated_at: ctx.timestamp,
  };
  const file = await saveRecord(ctx, kind, updated, { overwrite: true });
  reportWrite(
    io,
    { id, file, message: `Updated ${file}${options.status ? ` (status: ${options.status})` : ""}` },
    options.json,
  );
  return 0;
}
