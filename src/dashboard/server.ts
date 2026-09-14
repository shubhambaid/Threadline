import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type Io, requireInitialized } from "../commands/context.js";
import { now as clockNow } from "../core/clock.js";
import { UsageError } from "../core/errors.js";
import { buildDashboardModel, inspectBriefing, inspectRecord, ledgerVersion } from "./ledger.js";
import { renderPage } from "./page.js";

export const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "::1", "localhost"];
const RECORD_ID = /^(?:task|dec|kn|cp|rcpt)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface DashboardServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * A read-only dashboard on this machine (docs/dashboard.md). It listens only on a loopback
 * address, answers only GET and HEAD, rejects requests addressed to any other host name (so a
 * web page cannot reach it through DNS rebinding), and serves a page that loads nothing from the
 * network. Every response is computed from the working tree on request; nothing is cached or
 * written.
 */
export async function startDashboard(
  io: Io,
  options: { host?: string; port?: number } = {},
): Promise<DashboardServer> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new UsageError(
      `The dashboard only listens on this machine (127.0.0.1, ::1, or localhost), not ${host}.`,
    );
  }
  const root = await requireInitialized(io);
  const quiet: Io = { ...io, cwd: root, stdout: () => {}, stderr: () => {} };
  let allowedHosts = new Set<string>();

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!allowedHosts.has(request.headers.host ?? "")) {
      sendText(
        response,
        403,
        "Forbidden: this dashboard only answers requests addressed to localhost.",
      );
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendText(response, 405, "The dashboard is read-only.");
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const now = clockNow(io.env);
    switch (url.pathname) {
      case "/": {
        const nonce = randomBytes(18).toString("base64");
        send(response, 200, "text/html; charset=utf-8", renderPage(nonce), nonce);
        return;
      }
      case "/api/ledger":
        sendJson(response, 200, await buildDashboardModel(quiet, now));
        return;
      case "/api/version":
        sendJson(response, 200, { version: await ledgerVersion(root) });
        return;
      case "/api/record": {
        const id = url.searchParams.get("id") ?? "";
        if (!RECORD_ID.test(id)) {
          sendJson(response, 400, { error: "id must be a record id" });
          return;
        }
        sendJson(response, 200, await inspectRecord(quiet, id, now));
        return;
      }
      case "/api/briefing": {
        const task = url.searchParams.get("task") ?? "";
        const budget = Number(url.searchParams.get("budget") ?? "1000");
        if (!RECORD_ID.test(task) || !task.startsWith("task-")) {
          sendJson(response, 400, { error: "task must be a task id" });
          return;
        }
        if (!Number.isInteger(budget) || budget < 200 || budget > 100_000) {
          sendJson(response, 400, { error: "budget must be a whole number from 200 to 100000" });
          return;
        }
        sendJson(response, 200, await inspectBriefing(quiet, task, budget, now));
        return;
      }
      default:
        sendText(response, 404, "Not found");
    }
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (error instanceof UsageError) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (io.env.ALETHIC_DEBUG) io.stderr(`${(error as Error).stack}\n`);
      sendJson(response, 500, {
        error: "The dashboard could not read the ledger. Run `alethic validate` for details.",
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  return {
    url: `http://${host === "::1" ? "[::1]" : host}:${port}/`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function send(
  response: ServerResponse,
  status: number,
  type: string,
  body: string,
  nonce?: string,
): void {
  response.setHeader(
    "Content-Security-Policy",
    nonce
      ? `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      : "default-src 'none'; frame-ancestors 'none'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Cache-Control", "no-store");
  response.writeHead(status, { "Content-Type": type });
  response.end(body);
}

function sendText(response: ServerResponse, status: number, text: string): void {
  send(response, status, "text/plain; charset=utf-8", `${text}\n`);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(value));
}
