/** Recorded when nobody knows the next step. Stopping without a checkpoint is worse. */
export const NOT_DETERMINED =
  "Not determined: review open_questions and failed_approaches before acting.";

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** One line of at most `max` characters, cut at a word boundary when possible. */
export function truncate(text: string, max: number): string {
  const line = oneLine(text);
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The last `max` characters of `text`, starting at a line boundary when possible. */
export function tailText(text: string, max: number): string {
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed.length <= max) return trimmed;
  const slice = trimmed.slice(-max);
  const newline = slice.indexOf("\n");
  return newline >= 0 && newline < slice.length - 1 ? slice.slice(newline + 1) : slice;
}
