import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Io } from "../commands/context.js";
import { UsageError } from "./errors.js";
import { parseYaml } from "./format.js";
import { asArray, asObject, isPlainObject } from "./json.js";

/** How one key of an input file is read. */
export type FieldType = "string" | "strings" | { pairs: [string, string] } | "evidence";

export type FieldSpec = Record<string, FieldType>;

const EVIDENCE_KEYS = ["files", "commits", "checks", "receipts", "issues", "prs"] as const;

/** Keys that record trust or identity, which input files may not set. */
const FORBIDDEN_KEYS = ["confidence", "human", "created_by", "owner", "anchor", "valid_at"];

export interface InputFile {
  strings: Record<string, string>;
  lists: Record<string, string[]>;
  pairs: Record<string, [string, string][]>;
  evidence: Partial<Record<(typeof EVIDENCE_KEYS)[number], string[]>>;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += typeof chunk === "string" ? chunk : chunk.toString();
  return text;
}

/**
 * Reads the fields of a write command from a YAML or JSON file, or from stdin with `-`, so agents
 * can write a structured record without quoting many flags. Only the listed keys are accepted,
 * and never keys that set trust or identity: those come from flags and the environment. The
 * record still goes through the same validation and secret scan as flags. Values are not echoed
 * in errors, since they may be sensitive.
 */
export async function readInputFile(io: Io, file: string, spec: FieldSpec): Promise<InputFile> {
  const label = file === "-" ? "stdin" : file;
  let text: string;
  if (file === "-") {
    text = await readAll(io.stdin ?? process.stdin);
  } else {
    text = await readFile(path.resolve(io.cwd, file), "utf8").catch(() => {
      throw new UsageError(`--from-file ${file} cannot be read`);
    });
  }

  const parsed = parseYaml(text);
  if (parsed.problems.length > 0) {
    const problem = parsed.problems[0];
    throw new UsageError(
      `--from-file ${label} is not valid YAML or JSON${problem?.line ? ` (line ${problem.line})` : ""}: ${problem?.message ?? ""}`,
    );
  }
  if (!isPlainObject(parsed.data)) {
    throw new UsageError(`--from-file ${label} must contain a mapping of fields`);
  }

  const result: InputFile = { strings: {}, lists: {}, pairs: {}, evidence: {} };
  for (const [key, value] of Object.entries(parsed.data)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new UsageError(
        `--from-file ${label}: "${key}" cannot be set from a file. Trust and identity come from flags and the environment (for example --human).`,
      );
    }
    const type = spec[key];
    if (!type) {
      throw new UsageError(
        `--from-file ${label}: unknown field "${key}". Allowed: ${Object.keys(spec).join(", ")}.`,
      );
    }
    if (value === null || value === undefined) continue;
    const where = `--from-file ${label}: ${key}`;
    if (type === "string") {
      if (typeof value !== "string") throw new UsageError(`${where} must be a string`);
      result.strings[key] = value;
    } else if (type === "strings") {
      result.lists[key] = stringList(value, where);
    } else if (type === "evidence") {
      const evidence = asObject(value);
      if (!evidence) throw new UsageError(`${where} must be a mapping`);
      for (const [name, items] of Object.entries(evidence)) {
        if (!(EVIDENCE_KEYS as readonly string[]).includes(name)) {
          throw new UsageError(
            `${where}.${name} is not allowed. Allowed: ${EVIDENCE_KEYS.join(", ")}.`,
          );
        }
        result.evidence[name as (typeof EVIDENCE_KEYS)[number]] = stringList(
          items,
          `${where}.${name}`,
        );
      }
    } else {
      const [left, right] = type.pairs;
      result.pairs[key] = asArray(value).map((entry, index) => {
        const item = asObject(entry);
        const a = item?.[left];
        const b = item?.[right];
        if (!Array.isArray(value) || typeof a !== "string" || typeof b !== "string") {
          throw new UsageError(`${where}[${index}] must have string ${left} and ${right}`);
        }
        return [a, b];
      });
      if (!Array.isArray(value)) throw new UsageError(`${where} must be a list`);
    }
  }
  return result;
}

function stringList(value: unknown, where: string): string[] {
  const items = typeof value === "string" ? [value] : value;
  if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) {
    throw new UsageError(`${where} must be a string or a list of strings`);
  }
  return items as string[];
}

/** Flag value if given, else the file's. */
export function pick(flag: string | undefined, input: InputFile | undefined, key: string) {
  return flag ?? input?.strings[key];
}

/** The file's list followed by the flag's values. */
export function merge(flag: string[] | undefined, input: InputFile | undefined, key: string) {
  return [...(input?.lists[key] ?? []), ...(flag ?? [])];
}
