import type { Finding } from "../core/findings.js";

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** `error   .threadline/tasks/task-x.yaml:owner.lease_expires_at: message` plus an indented hint. */
export function formatFinding(finding: Finding): string {
  const location = finding.file ? `${finding.file}${finding.path ? `:${finding.path}` : ""}: ` : "";
  const lines = [`${finding.severity.padEnd(7)} ${location}${finding.message}`];
  if (finding.hint) lines.push(`        hint: ${finding.hint}`);
  return lines.join("\n");
}
