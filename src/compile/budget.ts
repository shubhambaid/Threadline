/** How much of an item a briefing shows. */
export type Level = "full" | "short" | "pointer";

export interface BriefingItem {
  /** Unique across all sections. */
  key: string;
  full: string;
  short: string;
  /** Citation shown when the item collapses into an "N more" line. */
  pointer: string;
  /** Higher is shown first and upgraded first when space allows. */
  priority: number;
}

export interface BriefingSection {
  key: string;
  title: string;
  /** Required sections always render every item in full. */
  required: boolean;
  items: BriefingItem[];
  /** Word used in the collapsed line, e.g. "files" in "3 more files: …". */
  pointerNoun?: string;
}

export interface Allocation {
  levels: Map<string, Level>;
  content: string;
  tokens: number;
  overBudget: boolean;
}

/** Approximate tokens as characters / 4: deterministic and tokenizer-independent. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function renderContent(
  sections: readonly BriefingSection[],
  levels: ReadonlyMap<string, Level>,
): string {
  return sections
    .map((section) => {
      const lines = [`## ${section.title}`];
      const pointers: string[] = [];
      let hidden = 0;
      for (const item of section.items) {
        const level = levels.get(item.key) ?? "pointer";
        if (level === "pointer") {
          hidden++;
          if (!pointers.includes(item.pointer)) pointers.push(item.pointer);
        } else {
          lines.push(`- ${level === "full" ? item.full : item.short}`);
        }
      }
      if (hidden > 0) {
        const noun = section.pointerNoun ? ` ${section.pointerNoun}` : "";
        lines.push(`- ${hidden} more${noun}: ${pointers.join(", ")}`);
      }
      if (section.items.length === 0) lines.push("None recorded.");
      return lines.join("\n");
    })
    .join("\n\n");
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
