import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { cli } from "../helpers/run-cli.js";

describe("alethic CLI", () => {
  it("prints the version", async () => {
    const result = await cli(["--version"], { cwd: tmpdir() });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("exits 2 on unknown commands", async () => {
    const result = await cli(["frobnicate"], { cwd: tmpdir() });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command");
  });

  it("exits 2 when -C points at a missing directory", async () => {
    const result = await cli(["-C", path.join(tmpdir(), "alethic-does-not-exist"), "status"], {
      cwd: tmpdir(),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Directory does not exist");
  });
});
