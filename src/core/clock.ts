/** Current time, overridable with ALETHIC_NOW for deterministic tests and demos. */
export function now(env: NodeJS.ProcessEnv = process.env): Date {
  const fixed = env.ALETHIC_NOW;
  if (!fixed) return new Date();
  const date = new Date(fixed);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`ALETHIC_NOW is not a valid timestamp: ${fixed}`);
  }
  return date;
}

/** `2026-09-13T20:15:00Z`: UTC, second precision, as required by the schemas. */
export function toTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `20260913t201500z`: the suffix used in checkpoint and receipt ids. */
export function toIdSuffix(date: Date): string {
  return toTimestamp(date).replace(/[-:]/g, "").toLowerCase();
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}
