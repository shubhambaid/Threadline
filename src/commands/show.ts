import { digestOf } from "../core/anchor.js";
import { asString } from "../core/json.js";
import { headCommit, isDirty } from "../git/git.js";
import { confirmationState } from "../trust/claims.js";
import {
  assessReceipt,
  createReceiptContext,
  describeApplicability,
  type ReceiptAssessment,
} from "../trust/receipts.js";
import { assessStaleness, createStalenessContext } from "../trust/staleness.js";
import { assessLedger, requireManifest, requireUsable } from "../validate/assess.js";
import { type Io, requireInitialized } from "./context.js";
import { formatFinding } from "./output.js";

export interface ShowOptions {
  json?: boolean;
}

/**
 * One record, with what is derived about it: freshness (spec §9), trust (§8), and for receipts,
 * whether the result applies to the current code (§6.5). It is how an agent reads an item a
 * briefing collapsed into an "N more" pointer. Only records that pass the shared assessment are
 * shown, so a withheld record's content is never printed.
 */
export async function showCommand(io: Io, id: string, options: ShowOptions): Promise<number> {
  const root = await requireInitialized(io);
  const ledger = await assessLedger(root);
  const manifest = requireManifest(ledger);
  const record = requireUsable(ledger, id);

  const staleness = await assessStaleness(
    await createStalenessContext(root, manifest),
    record.data,
  );
  const confirmation = confirmationState(record.kind, record.data);
  let receipt: ReceiptAssessment | undefined;
  if (record.kind === "receipt") {
    const [head, dirty] = await Promise.all([headCommit(root), isDirty(root)]);
    receipt = await assessReceipt(
      createReceiptContext(root, manifest, { head, dirty }),
      record.data,
    );
  }
  const findings = ledger.findings.filter((finding) => finding.file === record.file);
  // The Git blob id of the file: the record's revision, the same id `git hash-object` prints.
  const revision = digestOf(record.text);

  if (options.json) {
    const output = {
      id,
      kind: record.kind,
      file: record.file,
      revision,
      record: record.data,
      derived: {
        staleness,
        confirmation,
        ...(receipt ? { receipt } : {}),
      },
      findings,
    };
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  }

  const freshness =
    staleness.reasons.length > 0
      ? `${staleness.status}: ${staleness.reasons.join("; ")}`
      : staleness.status;
  const trust =
    confirmation.level === "none"
      ? (asString(record.data.confidence) ?? "unknown")
      : `human-confirmed by ${confirmation.name ?? "?"} (${confirmation.level}${confirmation.recordedBy ? `, recorded by ${confirmation.recordedBy}` : ""}; not authenticated)`;
  const lines = [
    `# ${id} (${record.kind})`,
    "",
    `File:      ${record.file}`,
    `Revision:  ${revision}`,
    `Freshness: ${freshness}`,
    `Trust:     ${trust}`,
    ...(receipt ? [`Applies:   ${describeApplicability(receipt).full}`] : []),
    ...staleness.notes.map((note) => `Note:      ${note}`),
    ...(findings.length > 0 ? ["", ...findings.map(formatFinding)] : []),
    "",
    "---",
    record.text.trimEnd(),
  ];
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}
