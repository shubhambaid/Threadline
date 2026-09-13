/**
 * Extracts machine-checked YAML examples from Markdown, per the convention in docs/spec.md:
 * the line directly before a ```yaml fence is `<!-- threadline:schema=<name> [expect=invalid] -->`.
 */
export interface MarkdownExample {
  schema: string;
  expectInvalid: boolean;
  yaml: string;
  /** 1-based line number of the marker. */
  line: number;
}

export interface ExtractResult {
  examples: MarkdownExample[];
  problems: string[];
}

const MARKER = /^<!-- threadline:schema=([a-z]+)( expect=invalid)? -->$/;
const FENCE_OPEN = /^(`{3,}|~{3,})/;

export function extractExamples(markdown: string): ExtractResult {
  const lines = markdown.split(/\r?\n/);
  const examples: MarkdownExample[] = [];
  const problems: string[] = [];
  let fence: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (fence) {
      if (line.startsWith(fence) && line.slice(fence.length).trim() === "") fence = undefined;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = open[1];
      continue;
    }
    if (!line.startsWith("<!--") || !line.includes("threadline:schema")) continue;

    const marker = MARKER.exec(line);
    if (!marker) {
      problems.push(`line ${i + 1}: malformed marker ${JSON.stringify(line)}`);
      continue;
    }
    if (lines[i + 1] !== "```yaml") {
      problems.push(`line ${i + 1}: marker must be immediately followed by a \`\`\`yaml fence`);
      continue;
    }
    const body: string[] = [];
    let j = i + 2;
    while (j < lines.length && lines[j] !== "```") body.push(lines[j++] ?? "");
    if (j >= lines.length) {
      problems.push(`line ${i + 1}: unterminated yaml fence`);
      break;
    }
    examples.push({
      schema: marker[1] ?? "",
      expectInvalid: marker[2] !== undefined,
      yaml: body.join("\n"),
      line: i + 1,
    });
    i = j;
  }
  if (fence) problems.push("unterminated code fence at end of document");
  return { examples, problems };
}
