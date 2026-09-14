import { isAlias, isNode, LineCounter, parseDocument, stringify, visit } from "yaml";
import type { Finding } from "./findings.js";

export interface YamlProblem {
  message: string;
  line?: number;
}

export function yamlFinding(file: string, problem: YamlProblem): Finding {
  return {
    severity: "error",
    code: "yaml",
    file,
    message: problem.line ? `line ${problem.line}: ${problem.message}` : problem.message,
    hint: "Records must be plain YAML: no anchors, aliases, custom tags, or duplicate keys.",
  };
}

export interface ParsedYaml {
  data: unknown;
  problems: YamlProblem[];
}

const CORE_TAG_PREFIX = "tag:yaml.org,2002:";

/**
 * Parses one YAML document. Anchors, aliases, custom tags, duplicate keys, and multiple
 * documents are rejected so every record stays plain data that any tool reads the same way.
 */
export function parseYaml(text: string): ParsedYaml {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: true });
  const problems: YamlProblem[] = [];
  const lineAt = (offset: number | undefined) =>
    offset === undefined ? undefined : lineCounter.linePos(offset).line;

  for (const error of doc.errors) {
    problems.push({
      message: error.message.split("\n", 1)[0] ?? error.message,
      line: error.linePos?.[0]?.line,
    });
  }
  visit(doc, (_key, node) => {
    if (isAlias(node)) {
      problems.push({ message: "YAML aliases are not allowed", line: lineAt(node.range?.[0]) });
    } else if (isNode(node)) {
      if (node.anchor) {
        problems.push({
          message: `YAML anchors are not allowed (&${node.anchor})`,
          line: lineAt(node.range?.[0]),
        });
      }
      if (node.tag && !node.tag.startsWith(CORE_TAG_PREFIX)) {
        problems.push({
          message: `Custom YAML tags are not allowed (${node.tag})`,
          line: lineAt(node.range?.[0]),
        });
      }
    }
  });

  if (problems.length > 0) return { data: undefined, problems };
  return { data: doc.toJS(), problems };
}

/** Field order used when Aletheic writes records, so diffs stay stable and readable. */
const KEY_ORDER = [
  "id",
  "kind",
  "schema_version",
  "summary",
  "status",
  "confidence",
  "topic",
  "category",
  "task",
  "intent",
  "chosen",
  "rationale",
  "alternatives",
  "body",
  "command",
  "exit_code",
  "result",
  "ran_at",
  "duration_ms",
  "branch",
  "owner",
  "git",
  "done",
  "failed_approaches",
  "open_questions",
  "next_safe_action",
  "next_action",
  "receipts",
  "output_tail",
  "provenance",
  "scope",
  "links",
  "evidence",
  "supersedes",
  "created_by",
  "created_at",
  "updated_at",
  "valid_at",
  "anchor",
];

const KEY_RANK = new Map(KEY_ORDER.map((key, index) => [key, index]));

export function orderRecordKeys(record: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(record).sort((a, b) => {
    const ra = KEY_RANK.get(a) ?? Number.MAX_SAFE_INTEGER;
    const rb = KEY_RANK.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb || a.localeCompare(b);
  });
  return Object.fromEntries(keys.map((key) => [key, record[key]]));
}

export function stringifyYaml(value: unknown): string {
  // aliasDuplicateObjects: false, because parseYaml rejects aliases.
  return stringify(value, { lineWidth: 0, minContentWidth: 0, aliasDuplicateObjects: false });
}

export function stringifyRecord(record: Record<string, unknown>): string {
  return stringifyYaml(orderRecordKeys(record));
}
