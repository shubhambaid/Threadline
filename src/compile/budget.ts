/** How much of an item a briefing shows. */
export type Level = "full" | "short" | "pointer";

/** Why an item is in the briefing, for inspection (`resume --format json`). */
export interface ItemMeta {
  /** The record the item comes from. */
  record?: string;
  /** How the record was found (explicit links, path overlap, …). */
  reasons?: string[];
  score?: number;
  /** Derived freshness (spec §9). */
  freshness?: string;
  /** For receipts: whether the result applies to the current code (spec §6.5). */
  applicability?: string;
}

export interface BriefingItem {
  /** Unique across all sections. */
  key: string;
  full: string;
  short: string;
  /** Citation shown when the item collapses into an "N more" line. */
  pointer: string;
  /** Higher is shown first and upgraded first when space allows. */
  priority: number;
  meta?: ItemMeta;
}

export interface BriefingSection {
  key: string;
  title: string;
  /** Required sections always render every item in full. */
  required: boolean;
  items: BriefingItem[];
  /** Noun used in the collapsed line, e.g. "files" in "3 more files: …". */
  pointerNoun?: { one: string; other: string };
  /** Leave the section out entirely when it has no items, instead of "None recorded." */
  hideWhenEmpty?: boolean;
}

export interface Allocation {
  levels: Map<string, Level>;
  content: string;
  tokens: number;
  overBudget: boolean;
}

/**
 * A collapsed "N more" line cites at most this many records and counts the rest, so hidden
 * records cannot make it grow without limit. Every item stays listed in `resume --format json`.
 */
export const MAX_POINTERS = 5;

/** Approximate tokens as characters / 4: deterministic and tokenizer-independent. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type LineKind = "heading" | "required" | "item" | "pointer" | "empty";

interface RenderedSection {
  lines: { kind: LineKind; text: string }[];
}

function renderSection(
  section: BriefingSection,
  levels: ReadonlyMap<string, Level>,
): RenderedSection {
  const lines: RenderedSection["lines"] = [{ kind: "heading", text: `## ${section.title}` }];
  const pointers: string[] = [];
  let hidden = 0;
  for (const item of section.items) {
    const level = levels.get(item.key) ?? "pointer";
    if (level === "pointer") {
      hidden++;
      if (!pointers.includes(item.pointer)) pointers.push(item.pointer);
    } else {
      lines.push({
        kind: section.required ? "required" : "item",
        text: `- ${level === "full" ? item.full : item.short}`,
      });
    }
  }
  if (hidden > 0) {
    const noun = section.pointerNoun
      ? ` ${hidden === 1 ? section.pointerNoun.one : section.pointerNoun.other}`
      : "";
    const shown = pointers.slice(0, MAX_POINTERS);
    const rest = pointers.length - shown.length;
    lines.push({
      kind: "pointer",
      text: `- ${hidden} more${noun}: ${shown.join(", ")}${rest > 0 ? `, and ${rest} ${rest === 1 ? "other" : "others"}` : ""}`,
    });
  }
  if (section.items.length === 0) lines.push({ kind: "empty", text: "None recorded." });
  return { lines };
}

function visible(sections: readonly BriefingSection[]): BriefingSection[] {
  return sections.filter((section) => !(section.hideWhenEmpty && section.items.length === 0));
}

export function renderContent(
  sections: readonly BriefingSection[],
  levels: ReadonlyMap<string, Level>,
): string {
  return visible(sections)
    .map((section) =>
      renderSection(section, levels)
        .lines.map((line) => line.text)
        .join("\n"),
    )
    .join("\n\n");
}

/** Where the content's approximate tokens go (spec §14). The parts add up to about the whole. */
export interface ContentUsage {
  /** Headings and the items of required sections: never shortened. */
  required: number;
  /** Optional items shown as summaries or in full. */
  optional: number;
  /** Collapsed "N more" lines and "None recorded." placeholders. */
  pointers: number;
}

export function contentUsage(
  sections: readonly BriefingSection[],
  levels: ReadonlyMap<string, Level>,
): ContentUsage {
  const chars = { required: 0, optional: 0, pointers: 0 };
  for (const section of visible(sections)) {
    for (const line of renderSection(section, levels).lines) {
      const size = line.text.length + 1;
      if (line.kind === "heading" || line.kind === "required") chars.required += size;
      else if (line.kind === "item") chars.optional += size;
      else chars.pointers += size;
    }
  }
  return {
    required: Math.ceil(chars.required / 4),
    optional: Math.ceil(chars.optional / 4),
    pointers: Math.ceil(chars.pointers / 4),
  };
}

function byPriority(a: BriefingItem, b: BriefingItem): number {
  return b.priority - a.priority || a.key.localeCompare(b.key);
}

/**
 * Chooses a level for every item. Required items are always full. Optional items start as
 * pointers and are upgraded while the content fits:
 *
 * 1. the top item of every section, to short, so no section is reduced to a pointer while
 *    another shows several items;
 * 2. every item to short, then every item to full, in priority order.
 *
 * Within a section, upgrades stop at the first item that does not fit, so a lower-ranked item
 * is never shown while a higher-ranked one is hidden. Ties break by key: deterministic.
 */
export function allocate(sections: readonly BriefingSection[], budget: number): Allocation {
  const levels = new Map<string, Level>();
  const sectionOf = new Map<string, string>();
  for (const section of sections) {
    for (const item of section.items) {
      levels.set(item.key, section.required ? "full" : "pointer");
      sectionOf.set(item.key, section.key);
    }
  }

  const upgrade = (item: BriefingItem, from: Level, to: Level): boolean => {
    if (levels.get(item.key) !== from) return true;
    levels.set(item.key, to);
    if (to === "full" && item.full === item.short) return true;
    if (estimateTokens(renderContent(sections, levels)) <= budget) return true;
    levels.set(item.key, from);
    return false;
  };

  const optional = sections.filter((section) => !section.required);
  const leaders = optional
    .map((section) => [...section.items].sort(byPriority)[0])
    .filter((item): item is BriefingItem => item !== undefined)
    .sort(byPriority);
  for (const leader of leaders) upgrade(leader, "pointer", "short");

  const ranked = optional.flatMap((section) => section.items).sort(byPriority);
  for (const [from, to] of [
    ["pointer", "short"],
    ["short", "full"],
  ] as const) {
    const blocked = new Set<string>();
    for (const item of ranked) {
      const section = sectionOf.get(item.key) ?? "";
      if (blocked.has(section)) continue;
      if (!upgrade(item, from, to)) blocked.add(section);
    }
  }

  const content = renderContent(sections, levels);
  const tokens = estimateTokens(content);
  return { levels, content, tokens, overBudget: tokens > budget };
}
