import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Io } from "../../src/commands/context.js";
import { createMcpHandler, type JsonRpcResponse } from "../../src/mcp/server.js";
import { serveStdio } from "../../src/mcp/stdio.js";
import { runCli } from "../../src/program.js";
import { TEST_NOW } from "./run-cli.js";

/** The official MCP client, talking to the server through the real stdio line framing. */
export class LineTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private readonly input = new PassThrough();
  private buffer = "";
  private readonly served: Promise<void>;

  constructor(handle: (message: unknown) => Promise<JsonRpcResponse | undefined>) {
    this.served = serveStdio(handle, this.input, (text) => this.receive(text));
  }

  private receive(text: string): void {
    this.buffer += text;
    for (let i = this.buffer.indexOf("\n"); i >= 0; i = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
    }
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this.input.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    this.input.end();
    await this.served;
    this.onclose?.();
  }
}

export function serverIo(root: string, agent: string, at = TEST_NOW): Io {
  return {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ALETHIC_NOW: at,
      ALETHIC_AGENT: agent,
    },
    stdout: () => {},
    stderr: () => {},
  };
}

export interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

export interface McpSession {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

/** Connects an MCP client to an Alethic server for `root`, acting as `agent` at time `at`. */
export async function connectMcp(root: string, agent: string, at = TEST_NOW): Promise<McpSession> {
  const client = new Client({ name: "alethic-test", version: "0.0.0" });
  await client.connect(
    new LineTransport(createMcpHandler({ io: serverIo(root, agent, at), run: runCli })),
  );
  return {
    client,
    call: async (name, args = {}) =>
      (await client.callTool({ name, arguments: args })) as ToolResult,
    close: () => client.close(),
  };
}

export function textOf(result: ToolResult): string {
  return result.content.map((item) => item.text).join("\n");
}
