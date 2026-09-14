import type { Io } from "./context.js";

export interface WriteReport {
  id: string;
  file: string;
  message: string;
  warnings?: string[];
  details?: Record<string, unknown>;
}

/** Prints the outcome of a write command as text, or as JSON with `--json`. */
export function reportWrite(io: Io, report: WriteReport, json = false): void {
  const warnings = report.warnings ?? [];
  if (json) {
    const output = { id: report.id, file: report.file, warnings, ...report.details };
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  io.stdout(`${[report.message, ...warnings.map((w) => `  warning: ${w}`)].join("\n")}\n`);
}

export interface CommonWriteOptions {
  agent?: string;
  json?: boolean;
}
