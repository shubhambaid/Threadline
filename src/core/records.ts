import { UsageError } from "./errors.js";
import type { RecordKind } from "./ids.js";
import { asString } from "./json.js";
import { type LoadedRecord, loadRecords } from "./store.js";

/** Records by id. When ids are duplicated, the first file wins (validate reports duplicates). */
export async function loadRecordIndex(root: string): Promise<Map<string, LoadedRecord>> {
  const { records } = await loadRecords(root);
  const index = new Map<string, LoadedRecord>();
  for (const record of records) {
    const id = asString(record.data.id);
    if (id !== undefined && !index.has(id)) index.set(id, record);
  }
  return index;
}

export function requireRecord(
  index: ReadonlyMap<string, LoadedRecord>,
  id: string,
  kind?: RecordKind,
  label?: string,
): LoadedRecord {
  const prefix = label ? `${label} ` : "";
  const record = index.get(id);
  if (!record) throw new UsageError(`${prefix}${id} does not exist`);
  if (kind && record.kind !== kind) {
    throw new UsageError(`${prefix}${id} is a ${record.kind}, not a ${kind}`);
  }
  return record;
}
