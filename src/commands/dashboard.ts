import { writeFile } from "node:fs/promises";
import path from "node:path";
import { now } from "../core/clock.js";
import { UsageError } from "../core/errors.js";
import { parseInteger } from "../core/write.js";
import { buildDashboardModel } from "../dashboard/ledger.js";
import { type DashboardServer, startDashboard } from "../dashboard/server.js";
import type { Io } from "./context.js";

export interface DashboardOptions {
  port?: string;
  host?: string;
  snapshot?: string;
}

export const DEFAULT_DASHBOARD_PORT = 4700;

/**
 * Serves the read-only dashboard until interrupted, or with `--snapshot`, writes the data it
 * would show as JSON and exits. The snapshot goes through the same assessment as the page, so
 * records that failed validation are withheld from it too.
 */
export async function dashboardCommand(io: Io, options: DashboardOptions): Promise<number> {
  if (options.snapshot) {
    const model = await buildDashboardModel(io, now(io.env));
    const json = `${JSON.stringify(model, null, 2)}\n`;
    if (options.snapshot === "-") {
      io.stdout(json);
    } else {
      await writeFile(path.resolve(io.cwd, options.snapshot), json, "utf8");
      io.stdout(`Wrote ${options.snapshot}\n`);
    }
    return 0;
  }

  const port =
    options.port === undefined ? DEFAULT_DASHBOARD_PORT : parseInteger(options.port, "--port", 0);
  if (port > 65_535) throw new UsageError("--port must be at most 65535");
  let server: DashboardServer;
  try {
    server = await startDashboard(io, { host: options.host, port });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new UsageError(
        `Port ${port} is in use. Pass --port <n>, or --port 0 for any free port.`,
      );
    }
    throw error;
  }
  io.stdout(
    `Aletheic dashboard: ${server.url}\nRead-only, and reachable only from this machine. Press Ctrl+C to stop.\n`,
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.close();
  return 0;
}
