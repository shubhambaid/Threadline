import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isSchemaName, SCHEMA_NAMES, validateAgainst } from "../../src/validate/schema.js";
import { extractExamples } from "../helpers/markdown-examples.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

function documentsToCheck(): string[] {
  const docs = ["docs/spec.md"];
  const adapters = `${root}docs/adapters`;
  if (existsSync(adapters)) {
    for (const name of readdirSync(adapters).sort()) {
      if (name.endsWith(".md")) docs.push(`docs/adapters/${name}`);
    }
  }
  return docs;
}

for (const doc of documentsToCheck()) {
  describe(doc, () => {
    const { examples, problems } = extractExamples(readFileSync(`${root}${doc}`, "utf8"));

    it("has no malformed example markers", () => {
      expect(problems).toEqual([]);
    });

    if (doc === "docs/spec.md") {
      it("has a valid example for every schema", () => {
        const covered = new Set(examples.filter((e) => !e.expectInvalid).map((e) => e.schema));
        expect([...covered].sort()).toEqual([...SCHEMA_NAMES].sort());
      });
    }

    for (const example of examples) {
      const label = `line ${example.line}: ${example.schema}${example.expectInvalid ? " (expect invalid)" : ""}`;
      it(label, () => {
        expect(isSchemaName(example.schema), `unknown schema "${example.schema}"`).toBe(true);
        if (!isSchemaName(example.schema)) return;
        const data: unknown = parse(example.yaml);
        const result = validateAgainst(example.schema, data);
        if (example.expectInvalid) {
          expect(result.valid).toBe(false);
        } else {
          expect(result.issues).toEqual([]);
        }
      });
    }
  });
}
