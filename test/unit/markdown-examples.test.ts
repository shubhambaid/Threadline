import { describe, expect, it } from "vitest";
import { extractExamples } from "../helpers/markdown-examples.js";

const fence = "```";

describe("extractExamples", () => {
  it("extracts tagged yaml blocks with schema and expectation", () => {
    const md = [
      "# Doc",
      "<!-- threadline:schema=task -->",
      `${fence}yaml`,
      "id: task-a",
      fence,
      "<!-- threadline:schema=checkpoint expect=invalid -->",
      `${fence}yaml`,
      "id: cp-b",
      fence,
    ].join("\n");
    const { examples, problems } = extractExamples(md);
    expect(problems).toEqual([]);
    expect(examples).toEqual([
      { schema: "task", expectInvalid: false, yaml: "id: task-a", line: 2 },
      { schema: "checkpoint", expectInvalid: true, yaml: "id: cp-b", line: 6 },
    ]);
  });

  it("ignores untagged yaml blocks", () => {
    const md = [`${fence}yaml`, "id: task-a", fence].join("\n");
    expect(extractExamples(md)).toEqual({ examples: [], problems: [] });
  });

  it("rejects a blank line between marker and fence", () => {
    const md = ["<!-- threadline:schema=task -->", "", `${fence}yaml`, "id: x", fence].join("\n");
    const { examples, problems } = extractExamples(md);
    expect(examples).toEqual([]);
    expect(problems[0]).toMatch(/immediately followed/);
  });

  it("rejects a non-yaml fence after a marker", () => {
    const md = ["<!-- threadline:schema=task -->", `${fence}yml`, "id: x", fence].join("\n");
    expect(extractExamples(md).problems[0]).toMatch(/immediately followed/);
  });

  it("reports malformed markers", () => {
    const md = "<!--threadline:schema=task-->";
    expect(extractExamples(md).problems[0]).toMatch(/malformed marker/);
  });

  it("does not treat markers inside code fences as real", () => {
    const md = [
      "````markdown",
      "<!-- threadline:schema=task -->",
      `${fence}yaml`,
      "id: x",
      fence,
      "````",
    ].join("\n");
    expect(extractExamples(md)).toEqual({ examples: [], problems: [] });
  });

  it("reports unterminated fences", () => {
    const md = ["<!-- threadline:schema=task -->", `${fence}yaml`, "id: x"].join("\n");
    expect(extractExamples(md).problems[0]).toMatch(/unterminated/);
  });
});
