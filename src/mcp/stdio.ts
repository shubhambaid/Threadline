import { createInterface } from "node:readline";
import type { JsonRpcResponse } from "./server.js";

/**
 * MCP stdio transport: one JSON-RPC message per line in, one per line out. Nothing else may be
 * written to stdout. Resolves when the input closes and every pending response is written.
 */
export async function serveStdio(
  handle: (message: unknown) => Promise<JsonRpcResponse | undefined>,
  input: NodeJS.ReadableStream,
  write: (line: string) => void,
): Promise<void> {
  const pending = new Set<Promise<void>>();
  for await (const line of createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })) {
    if (line.trim() === "") continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
      continue;
    }
    const task: Promise<void> = handle(message)
      .then((response) => {
        if (response) write(`${JSON.stringify(response)}\n`);
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  }
  await Promise.all(pending);
}
