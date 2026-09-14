export type Severity = "error" | "warning" | "info";

export interface Finding {
  severity: Severity;
  /** Stable machine-readable code, e.g. `schema`, `dangling-link`, `secret`. */
  code: string;
  /** Repository-relative file the finding is about. */
  file?: string;
  /** Dotted field path inside the file. */
  path?: string;
  message: string;
  /** A concrete next step that fixes the finding. */
  hint?: string;
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.file ?? "").localeCompare(b.file ?? "") ||
      (a.path ?? "").localeCompare(b.path ?? "") ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  );
}
