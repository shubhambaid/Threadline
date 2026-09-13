import { now } from "../core/clock.js";
import { validateRepository } from "../validate/index.js";
import { type Io, requireInitialized } from "./context.js";
import { formatFinding, plural } from "./output.js";

export interface ValidateCommandOptions {
  json?: boolean;
  strict?: boolean;
}

export async function validateCommand(io: Io, options: ValidateCommandOptions): Promise<number> {
  const root = await requireInitialized(io);
  const report = await validateRepository(root, {
    now: now(io.env),
    strict: options.strict ?? false,
  });

  if (options.json) {
    const output = {
      valid: report.errors === 0,
      errors: report.errors,
      warnings: report.warnings,
      records: report.records.length,
      findings: report.findings,
    };
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    const records = plural(report.records.length, "record");
    const summary =
      report.errors === 0
        ? `✓ ${records} valid${report.warnings > 0 ? `, ${plural(report.warnings, "warning")}` : ""}`
        : `✗ ${plural(report.errors, "error")}, ${plural(report.warnings, "warning")} in ${records}`;
    const blocks = report.findings.map(formatFinding);
    io.stdout(`${[...blocks, ...(blocks.length > 0 ? [""] : []), summary].join("\n")}\n`);
  }
  return report.errors > 0 ? 1 : 0;
}
