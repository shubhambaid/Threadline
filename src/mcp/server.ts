import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import pkg from "../../package.json" with { type: "json" };
import { type Io, requireInitialized } from "../commands/context.js";
import { UsageError } from "../core/errors.js";
import { asObject, asString, isPlainObject } from "../core/json.js";
import { loadRecordIndex } from "../core/records.js";
import { TOOLS, type ToolSpec } from "./tools.js";

/** Protocol revisions this server speaks; the newest is offered when a client asks for another. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export type RunCli = (argv: readonly string[], io: Io) => Promise<number>;

type Id = string | number;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: Id | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const INSTRUCTIONS =
  "Threadline is shared task memory stored in .threadline/ and committed with the code. Call `resume` before non-trivial work. After running a check, call `receipt_record`. Call `checkpoint_create` before stopping or handing off. Never store transcripts, secrets, or customer data.";

const OPEN_TASK = new Set(["active", "paused", "blocked", "proposed"]);
const RECORD_URI = /^threadline:\/\/records\/([a-z0-9][a-z0-9-]*)$/;

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A Model Context Protocol server over JSON-RPC. It handles one message at a time, so tool calls
 * that write records never race each other. Every tool runs the CLI in-process.
 */
export function createMcpHandler(options: {
  io: Io;
  run: RunCli;
}): (message: unknown) => Promise<JsonRpcResponse | undefined> {
  const { io, run } = options;
  const ajv = new Ajv2020({ allErrors: true });
  const tools = new Map<string, { spec: ToolSpec; validate: ValidateFunction }>(
    TOOLS.map((spec) => [spec.name, { spec, validate: ajv.compile(spec.inputSchema) }]),
  );

  async function capture(argv: string[]): Promise<Captured> {
    const out: Captured = { code: 0, stdout: "", stderr: "" };
    out.code = await run(argv, {
      cwd: io.cwd,
      env: io.env,
      stdout: (chunk) => {
        out.stdout += chunk;
      },
      stderr: (chunk) => {
        out.stderr += chunk;
      },
    });
    return out;
  }

  async function callTool(params: Record<string, unknown>): Promise<unknown> {
    const name = asString(params.name);
    const tool = name ? tools.get(name) : undefined;
    if (!tool) throw new RpcError(-32602, `Unknown tool: ${name ?? "(missing name)"}`);
    const args = params.arguments ?? {};
    if (!isPlainObject(args)) throw new RpcError(-32602, "Tool arguments must be an object");
    if (!tool.validate(args)) {
      return toolResult(`Invalid arguments: ${describeErrors(tool.validate.errors)}`, true);
    }

    let scratch: string | undefined;
    const scratchDir = async () => {
      scratch ??= await mkdtemp(path.join(os.tmpdir(), "threadline-mcp-"));
      return scratch;
    };
    try {
      const argv = await tool.spec.argv(args, scratchDir);
      const out = await capture(argv);
      const ok = (tool.spec.okCodes ?? [0]).includes(out.code);
      if (!ok) {
        const message = out.stderr.trim() || out.stdout.trim();
        return toolResult(message || `threadline exited with code ${out.code}`, true);
      }
      return toolResult(out.stdout, false, out.stderr.trim());
    } catch (error) {
      if (error instanceof UsageError) return toolResult(error.message, true);
      throw error;
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }

  async function listResources(): Promise<unknown> {
    const resources: unknown[] = [
      {
        uri: "threadline://status",
        name: "status",
        title: "Threadline status",
        description: "Git state, active tasks, latest checkpoints, and validation summary.",
        mimeType: "application/json",
      },
    ];
    try {
      const index = await loadRecordIndex(await requireInitialized(io));
      const open = [...index.values()]
        .filter((record) => record.kind === "task" && OPEN_TASK.has(String(record.data.status)))
        .sort((a, b) => String(a.data.id).localeCompare(String(b.data.id)));
      for (const record of open) {
        resources.push({
          uri: `threadline://records/${String(record.data.id)}`,
          name: String(record.data.id),
          title: asString(record.data.summary),
          mimeType: "application/yaml",
        });
      }
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
    }
    return { resources };
  }

  async function readResource(params: Record<string, unknown>): Promise<unknown> {
    const uri = asString(params.uri) ?? "";
    if (uri === "threadline://status") {
      const out = await capture(["status", "--json"]);
      if (out.code !== 0) throw new RpcError(-32603, out.stderr.trim() || "status failed");
      return { contents: [{ uri, mimeType: "application/json", text: out.stdout }] };
    }
    const id = RECORD_URI.exec(uri)?.[1];
    if (id) {
      let record: { text: string } | undefined;
      try {
        record = (await loadRecordIndex(await requireInitialized(io))).get(id);
      } catch (error) {
        if (error instanceof UsageError) throw new RpcError(-32603, error.message);
        throw error;
      }
      if (record) return { contents: [{ uri, mimeType: "application/yaml", text: record.text }] };
    }
    throw new RpcError(-32002, `Resource not found: ${uri}`, { uri });
  }

  const methods: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    initialize: async (params) => {
      const requested = asString(params.protocolVersion);
      return {
        protocolVersion:
          requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: { name: "threadline", title: "Threadline", version: pkg.version },
        instructions: INSTRUCTIONS,
      };
    },
    ping: async () => ({}),
    "tools/list": async () => ({
      tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
        name,
        title,
        description,
        inputSchema,
        annotations,
      })),
    }),
    "tools/call": callTool,
    "resources/list": listResources,
    "resources/templates/list": async () => ({
      resourceTemplates: [
        {
          uriTemplate: "threadline://records/{id}",
          name: "record",
          title: "Threadline record",
          description: "Any task, decision, knowledge, checkpoint, or receipt record by id.",
          mimeType: "application/yaml",
        },
      ],
    }),
    "resources/read": readResource,
  };

  async function dispatch(message: unknown): Promise<JsonRpcResponse | undefined> {
    const request = asObject(message);
    const rawId = request?.id;
    const id: Id | null = typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
    if (request?.jsonrpc !== "2.0" || typeof request.method !== "string") {
      // Responses to requests we never send are ignored; anything else is malformed.
      if (request && request.jsonrpc === "2.0" && ("result" in request || "error" in request)) {
        return undefined;
      }
      return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
    }
    const isNotification = !("id" in request);
    const method = methods[request.method];
    if (isNotification) return undefined;
    if (!method) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    }
    try {
      return { jsonrpc: "2.0", id, result: await method(asObject(request.params) ?? {}) };
    } catch (error) {
      if (error instanceof RpcError) {
        const data = error.data === undefined ? {} : { data: error.data };
        return { jsonrpc: "2.0", id, error: { code: error.code, message: error.message, ...data } };
      }
      if (io.env.THREADLINE_DEBUG) io.stderr(`${(error as Error).stack}\n`);
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `Internal error: ${(error as Error).message}` },
      };
    }
  }

  let queue: Promise<unknown> = Promise.resolve();
  return (message) => {
    const result = queue.then(() => dispatch(message));
    queue = result.catch(() => undefined);
    return result;
  };
}

function toolResult(text: string, isError: boolean, warnings = ""): unknown {
  const content = [{ type: "text", text }];
  if (warnings) content.push({ type: "text", text: `warnings:\n${warnings}` });
  return { content, isError };
}

function describeErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => {
      const where = error.instancePath ? error.instancePath.slice(1).replaceAll("/", ".") : "";
      const extra = asString(asObject(error.params)?.additionalProperty);
      const message = extra ? `has unknown property "${extra}"` : (error.message ?? "is invalid");
      return where ? `${where} ${message}` : `arguments ${message}`;
    })
    .join("; ");
}
