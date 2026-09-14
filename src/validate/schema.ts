import type { ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import checkpoint from "../../schemas/checkpoint.schema.json" with { type: "json" };
import common from "../../schemas/common.schema.json" with { type: "json" };
import decision from "../../schemas/decision.schema.json" with { type: "json" };
import knowledge from "../../schemas/knowledge.schema.json" with { type: "json" };
import manifest from "../../schemas/manifest.schema.json" with { type: "json" };
import receipt from "../../schemas/receipt.schema.json" with { type: "json" };
import task from "../../schemas/task.schema.json" with { type: "json" };

export const SCHEMA_NAMES = [
  "manifest",
  "task",
  "decision",
  "knowledge",
  "checkpoint",
  "receipt",
] as const;

export type SchemaName = (typeof SCHEMA_NAMES)[number];

export interface SchemaIssue {
  /** Dotted path into the document, e.g. `git.head` or `evidence.commits[0]`. `$` is the root. */
  path: string;
  message: string;
  keyword: string;
}

export interface SchemaResult {
  valid: boolean;
  issues: SchemaIssue[];
}

interface SchemaJson {
  properties?: Record<string, unknown>;
}

const SCHEMAS: Record<SchemaName, SchemaJson> = {
  manifest,
  task,
  decision,
  knowledge,
  checkpoint,
  receipt,
};

const ENVELOPE_FIELDS = Object.keys(common.$defs.envelope.properties);

/** Top-level fields each schema declares, directly or through the shared envelope. */
const DECLARED_FIELDS: Record<SchemaName, Set<string>> = Object.fromEntries(
  SCHEMA_NAMES.map((name) => {
    const own = Object.keys(SCHEMAS[name].properties ?? {});
    return [name, new Set(name === "manifest" ? own : [...ENVELOPE_FIELDS, ...own])];
  }),
) as Record<SchemaName, Set<string>>;

let ajv: Ajv2020 | undefined;

function getAjv(): Ajv2020 {
  if (!ajv) {
    ajv = new Ajv2020({
      allErrors: true,
      verbose: true,
      strictSchema: true,
      strictNumbers: true,
      strictTuples: true,
      strictTypes: false,
      strictRequired: false,
    });
    ajv.addSchema(common);
    for (const schema of Object.values(SCHEMAS)) ajv.addSchema(schema);
  }
  return ajv;
}

export function isSchemaName(value: string): value is SchemaName {
  return (SCHEMA_NAMES as readonly string[]).includes(value);
}

export function validateAgainst(name: SchemaName, data: unknown): SchemaResult {
  const validate = getAjv().getSchema(`urn:alethic:v1:${name}`);
  if (!validate) throw new Error(`Schema not registered: ${name}`);
  const valid = validate(data) as boolean;
  return {
    valid,
    issues: valid ? [] : formatErrors(validate.errors ?? [], DECLARED_FIELDS[name]),
  };
}

// Keywords that only restate a failure already reported by a more specific error.
const NOISE_KEYWORDS = new Set(["if", "allOf"]);

/** Human-readable messages for the shared patterns, keyed by `$defs` name. */
const DEF_PATTERN_MESSAGES: Record<string, string> = {
  repoPath:
    "must be a safe repository-relative path (no leading / or ~, drive letter, backslash, or empty, '.' or '..' segments)",
  sha: "must be a commit id (7-64 lowercase hex characters)",
  objectId: "must be a full Git object id (40 or 64 lowercase hex characters)",
  timestamp: 'must be a UTC timestamp like "2026-09-13T20:15:00Z"',
  agentName: "must be a lowercase agent name (letters, digits, '.', '_', '-')",
  recordId: "must be a record id: task-, dec-, kn-, cp-, or rcpt- followed by a lowercase slug",
  taskId: "must be a task id: task- followed by a lowercase slug",
  receiptId: "must be a receipt id: rcpt- followed by a lowercase slug",
};

const PROPERTY_PATTERN_MESSAGES: Record<string, string> = {
  topic: "must be a dotted lowercase key like auth.session-invalidation",
};

/**
 * @param declared Top-level fields the schema allows. When a composed subschema fails, Ajv stops
 * counting its fields as evaluated and reports them as unknown; those false reports are dropped.
 */
export function formatErrors(errors: ErrorObject[], declared?: Set<string>): SchemaIssue[] {
  const seen = new Set<string>();
  const issues: SchemaIssue[] = [];
  for (const error of errors) {
    if (NOISE_KEYWORDS.has(error.keyword)) continue;
    let path = pointerToPath(error.instancePath);
    const params = error.params as Record<string, unknown>;
    let message = error.message ?? "is invalid";

    if (error.keyword === "required") {
      path = joinPath(path, String(params.missingProperty));
      message = "is required";
    } else if (
      error.keyword === "additionalProperties" ||
      error.keyword === "unevaluatedProperties"
    ) {
      const field = String(params.additionalProperty ?? params.unevaluatedProperty);
      if (
        error.keyword === "unevaluatedProperties" &&
        !error.instancePath &&
        declared?.has(field)
      ) {
        continue;
      }
      path = joinPath(path, field);
      message = "is not an allowed field";
    } else if (error.keyword === "enum") {
      message = `must be one of: ${(params.allowedValues as unknown[]).join(", ")}`;
    } else if (error.keyword === "const") {
      message = `must be ${JSON.stringify(params.allowedValue)}`;
    } else if (error.keyword === "pattern") {
      message = patternMessage(error.schemaPath, String(params.pattern));
    } else if (
      error.keyword === "type" &&
      typeof error.data === "number" &&
      error.schemaPath.includes("/$defs/sha/")
    ) {
      message = "must be a quoted string; YAML parsed this commit id as a number";
    }

    const key = `${path} ${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ path, message, keyword: error.keyword });
  }
  return issues;
}

function patternMessage(schemaPath: string, pattern: string): string {
  const def = /\/\$defs\/(\w+)\/pattern$/.exec(schemaPath)?.[1];
  if (def && DEF_PATTERN_MESSAGES[def]) return DEF_PATTERN_MESSAGES[def];
  const property = /#\/properties\/(\w+)\/pattern$/.exec(schemaPath)?.[1];
  if (property === "id" && pattern.startsWith("^")) {
    return `must start with "${pattern.slice(1)}"`;
  }
  if (property && PROPERTY_PATTERN_MESSAGES[property]) return PROPERTY_PATTERN_MESSAGES[property];
  return `must match pattern ${pattern}`;
}

function pointerToPath(pointer: string): string {
  if (!pointer) return "$";
  let out = "";
  for (const raw of pointer.slice(1).split("/")) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    out = /^\d+$/.test(segment) ? `${out}[${segment}]` : joinPath(out || "$", segment);
  }
  return out;
}

function joinPath(base: string, key: string): string {
  return base === "$" || base === "" ? key : `${base}.${key}`;
}
