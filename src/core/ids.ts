import { toIdSuffix } from "./clock.js";

export const RECORD_KINDS = ["task", "decision", "knowledge", "checkpoint", "receipt"] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

export const KIND_PREFIX: Record<RecordKind, string> = {
  task: "task",
  decision: "dec",
  knowledge: "kn",
  checkpoint: "cp",
  receipt: "rcpt",
};

export const KIND_DIRS: Record<RecordKind, string> = {
  task: "tasks",
  decision: "decisions",
  knowledge: "knowledge",
  checkpoint: "checkpoints",
  receipt: "receipts",
};

/** Kinds whose records are never edited after they are committed. */
export const APPEND_ONLY_KINDS: ReadonlySet<RecordKind> = new Set(["checkpoint", "receipt"]);

export function isRecordKind(value: string): value is RecordKind {
  return (RECORD_KINDS as readonly string[]).includes(value);
}

export function kindFromId(id: string): RecordKind | undefined {
  const prefix = id.split("-", 1)[0];
  return RECORD_KINDS.find((kind) => KIND_PREFIX[kind] === prefix);
}

/** Lowercase ASCII slug of single-hyphen-separated words, cut at a word boundary. */
export function slugify(text: string, maxLength = 60): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "untitled";
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength + 1);
  const boundary = cut.lastIndexOf("-");
  return (boundary > 0 ? cut.slice(0, boundary) : slug.slice(0, maxLength)).replace(/-+$/, "");
}

/** Builds a record id. Append-only kinds get a UTC timestamp suffix so parallel writers never collide. */
export function makeId(kind: RecordKind, text: string, date: Date): string {
  const base = `${KIND_PREFIX[kind]}-${slugify(text)}`;
  return APPEND_ONLY_KINDS.has(kind) ? `${base}-${toIdSuffix(date)}` : base;
}
