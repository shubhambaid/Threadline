import type { Finding } from "../core/findings.js";
import { asObject, asString } from "../core/json.js";
import type { LoadedRecord } from "../core/store.js";

/** Active tasks whose ownership lease has expired are invalid (docs/spec.md §12). */
export function checkLeases(records: readonly LoadedRecord[], now: Date): Finding[] {
  const findings: Finding[] = [];
  for (const record of records) {
    if (record.kind !== "task" || record.data.status !== "active") continue;
    const owner = asObject(record.data.owner);
    const lease = asString(owner?.lease_expires_at);
    if (lease === undefined) continue;
    const expiresAt = Date.parse(lease);
    if (Number.isNaN(expiresAt) || expiresAt > now.getTime()) continue;
    const id = asString(record.data.id) ?? "<id>";
    findings.push({
      severity: "error",
      code: "expired-lease",
      file: record.file,
      path: "owner.lease_expires_at",
      message: `Lease held by ${asString(owner?.agent) ?? "unknown agent"} expired at ${lease}`,
      hint: `Renew with \`alethic task claim ${id}\`, or hand off: write a checkpoint and set status: paused.`,
    });
  }
  return findings;
}
