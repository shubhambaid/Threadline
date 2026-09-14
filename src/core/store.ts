import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { UsageError } from "./errors.js";
import type { Finding } from "./findings.js";
import { parseYaml, stringifyRecord, yamlFinding } from "./format.js";
import { exists } from "./fs.js";
import { KIND_DIRS, RECORD_KINDS, type RecordKind } from "./ids.js";
import { isPlainObject } from "./json.js";
import { THREADLINE_DIR } from "./paths.js";

export interface LoadedRecord {
  /** Repository-relative path, e.g. `.threadline/tasks/task-x.yaml`. */
  file: string;
  /** Kind implied by the directory the file is in. */
  kind: RecordKind;
  data: Record<string, unknown>;
  /** Raw file content, used for append-only checks. */
  text: string;
}

export interface StoreLoad {
  records: LoadedRecord[];
  findings: Finding[];
}

export function recordFile(kind: RecordKind, id: string): string {
  return `${THREADLINE_DIR}/${KIND_DIRS[kind]}/${id}.yaml`;
}

/** Loads every record file. Files that are not parseable YAML mappings become findings instead. */
export async function loadRecords(root: string): Promise<StoreLoad> {
  const records: LoadedRecord[] = [];
  const findings: Finding[] = [];

  for (const kind of RECORD_KINDS) {
    const dir = `${THREADLINE_DIR}/${KIND_DIRS[kind]}`;
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".gitkeep") continue;
      const file = `${dir}/${entry.name}`;
      if (!entry.isFile()) {
        findings.push({
          severity: "warning",
          code: "unexpected-file",
          file,
          message: "Unexpected non-file entry in a record directory",
        });
        continue;
      }
      if (entry.name.endsWith(".yml")) {
        findings.push({
          severity: "error",
          code: "wrong-extension",
          file,
          message: "Record files must use the .yaml extension",
          hint: `Rename it to ${entry.name.slice(0, -4)}.yaml.`,
        });
        continue;
      }
      if (!entry.name.endsWith(".yaml")) {
        findings.push({
          severity: "warning",
          code: "unexpected-file",
          file,
          message: "Ignoring a file that is not a .yaml record",
        });
        continue;
      }

      const text = await readFile(path.join(root, file), "utf8");
      const parsed = parseYaml(text);
      if (parsed.problems.length > 0) {
        findings.push(...parsed.problems.map((problem) => yamlFinding(file, problem)));
        continue;
      }
      if (!isPlainObject(parsed.data)) {
        findings.push({
          severity: "error",
          code: "yaml",
          file,
          message: "A record must be a YAML mapping",
        });
        continue;
      }
      records.push({ file, kind, data: parsed.data, text });
    }
  }
  return { records, findings };
}

/** Writes a record atomically (temp file + rename). Refuses to overwrite unless asked. */
export async function writeRecord(
  root: string,
  kind: RecordKind,
  record: Record<string, unknown>,
  options: { overwrite?: boolean } = {},
): Promise<string> {
  const id = record.id;
  if (typeof id !== "string") throw new Error("record.id must be a string");
  const file = recordFile(kind, id);
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  if (!options.overwrite && (await exists(target))) {
    throw new UsageError(`${file} already exists`);
  }
  const temp = `${target}.tmp-${process.pid}`;
  await writeFile(temp, stringifyRecord(record), "utf8");
  await rename(temp, target);
  return file;
}
