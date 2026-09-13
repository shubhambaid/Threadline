import type { RecordKind } from "../core/ids.js";
import { asArray, asObject, asString } from "../core/json.js";

/** Collectors for ids, paths, and commits inside a record. They tolerate schema-invalid data. */

type Data = Record<string, unknown>;

function evidenceBlocks(data: Data): { prefix: string; evidence: Data }[] {
  const blocks: { prefix: string; evidence: Data }[] = [];
  const top = asObject(data.evidence);
  if (top) blocks.push({ prefix: "evidence", evidence: top });
  asArray(data.failed_approaches).forEach((item, index) => {
    const evidence = asObject(asObject(item)?.evidence);
    if (evidence) blocks.push({ prefix: `failed_approaches[${index}].evidence`, evidence });
  });
  return blocks;
}

function eachString(value: unknown, path: string, visit: (item: string, path: string) => void) {
  asArray(value).forEach((item, index) => {
    if (typeof item === "string") visit(item, `${path}[${index}]`);
  });
}

export interface Reference {
  path: string;
  id: string;
  /** Kind the referenced record must have. */
  expected?: RecordKind;
  /** The referenced record must have the same kind as the referencing one. */
  sameKind?: boolean;
}

export function collectReferences(data: Data): Reference[] {
  const refs: Reference[] = [];
  eachString(data.links, "links", (id, path) => refs.push({ path, id }));
  eachString(data.supersedes, "supersedes", (id, path) => refs.push({ path, id, sameKind: true }));
  const task = asString(data.task);
  if (task !== undefined) refs.push({ path: "task", id: task, expected: "task" });
  eachString(data.receipts, "receipts", (id, path) => refs.push({ path, id, expected: "receipt" }));
  for (const { prefix, evidence } of evidenceBlocks(data)) {
    eachString(evidence.receipts, `${prefix}.receipts`, (id, path) =>
      refs.push({ path, id, expected: "receipt" }),
    );
  }
  return refs;
}

export type PathRole = "scope" | "evidence" | "changed" | "fingerprint";

export interface PathField {
  path: string;
  value: string;
  role: PathRole;
}

export function collectPaths(data: Data): PathField[] {
  const fields: PathField[] = [];
  eachString(asObject(data.scope)?.paths, "scope.paths", (value, path) =>
    fields.push({ path, value, role: "scope" }),
  );
  for (const { prefix, evidence } of evidenceBlocks(data)) {
    eachString(evidence.files, `${prefix}.files`, (value, path) =>
      fields.push({ path, value, role: "evidence" }),
    );
  }
  eachString(asObject(data.git)?.changed_paths, "git.changed_paths", (value, path) =>
    fields.push({ path, value, role: "changed" }),
  );
  const fingerprints = asObject(asObject(data.anchor)?.fingerprints);
  for (const value of Object.keys(fingerprints ?? {})) {
    fields.push({ path: `anchor.fingerprints.${value}`, value, role: "fingerprint" });
  }
  return fields;
}

/**
 * `evidence`: cited as proof. `git`: a checkpoint's or receipt's code state.
 * `hint`: valid_at and anchor.commit, which may legitimately disappear (docs/spec.md §9).
 */
export type CommitRole = "evidence" | "git" | "hint";

export interface CommitField {
  path: string;
  sha: string;
  role: CommitRole;
}

export function collectCommits(data: Data): CommitField[] {
  const fields: CommitField[] = [];
  for (const { prefix, evidence } of evidenceBlocks(data)) {
    eachString(evidence.commits, `${prefix}.commits`, (sha, path) =>
      fields.push({ path, sha, role: "evidence" }),
    );
  }
  const git = asObject(data.git);
  for (const key of ["head", "base"]) {
    const sha = asString(git?.[key]);
    if (sha !== undefined) fields.push({ path: `git.${key}`, sha, role: "git" });
  }
  const validAt = asString(data.valid_at);
  if (validAt !== undefined) fields.push({ path: "valid_at", sha: validAt, role: "hint" });
  const anchorCommit = asString(asObject(data.anchor)?.commit);
  if (anchorCommit !== undefined) {
    fields.push({ path: "anchor.commit", sha: anchorCommit, role: "hint" });
  }
  return fields;
}
