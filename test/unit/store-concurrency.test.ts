import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeRecord } from "../../src/core/store.js";

const FILE = ".alethic/tasks/task-x.yaml";

function record(summary: string): Record<string, unknown> {
  return { id: "task-x", kind: "task", summary };
}

function workspace(): { root: string; file: string } {
  const root = mkdtempSync(path.join(tmpdir(), "alethic-store-"));
  return { root, file: path.join(root, FILE) };
}

describe("writeRecord with competing writers", () => {
  it("creates a record once when two writers race, and leaves no temporary files", async () => {
    const { root, file } = workspace();
    const results = await Promise.allSettled([
      writeRecord(root, "task", record("first")),
      writeRecord(root, "task", record("second")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(String(rejected?.reason)).toContain(`${FILE} already exists`);
    expect(readFileSync(file, "utf8")).toMatch(/summary: (first|second)/);
    expect(readdirSync(path.dirname(file))).toEqual(["task-x.yaml"]);
  });

  it("refuses to replace a record that changed after it was read", async () => {
    const { root, file } = workspace();
    await writeRecord(root, "task", record("v1"));
    const read = readFileSync(file, "utf8");
    writeFileSync(file, read.replace("v1", "v2 from another session"));

    await expect(
      writeRecord(root, "task", record("v1 edited"), { overwrite: true, expected: read }),
    ).rejects.toThrow("changed after this command read it");
    expect(readFileSync(file, "utf8")).toContain("v2 from another session");

    await writeRecord(root, "task", record("v3"), {
      overwrite: true,
      expected: readFileSync(file, "utf8"),
    });
    expect(readFileSync(file, "utf8")).toContain("v3");
    expect(readdirSync(path.dirname(file))).toEqual(["task-x.yaml"]);
  });

  it("refuses while another write holds the lock, and names a lock left behind", async () => {
    const { root, file } = workspace();
    await writeRecord(root, "task", record("v1"));
    writeFileSync(`${file}.lock`, "12345\n");
    await expect(writeRecord(root, "task", record("v2"), { overwrite: true })).rejects.toThrow(
      "is being written by another alethic command",
    );

    const old = new Date(Date.now() - 120_000);
    utimesSync(`${file}.lock`, old, old);
    await expect(writeRecord(root, "task", record("v2"), { overwrite: true })).rejects.toThrow(
      "was left behind by an interrupted write",
    );
    expect(readFileSync(file, "utf8")).toContain("v1");
  });
});
