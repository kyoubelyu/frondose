/** P-58d.2 — local Frondose update/download portal server.
 *
 *  Serves ~/.frondose/site/ over plain HTTP (read-only static files): the landing
 *  page (index.html), the Tauri updater manifest (latest.json, server root),
 *  the signed universal .app.tar.gz + .sig, and the .dmg installer.
 *
 *  CLI-layer operator-facing server (like serverHttp.ts) — NOT an agent tool,
 *  never imported under src/tools/**. No-bash boundary unaffected. No new deps.
 *
 *  OQ-5: latest.json lives at the server ROOT so updateServerUrl = http://IP:PORT
 *  (the Tauri updater appends /latest.json). Artifacts under /downloads/.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { DATA_DIR_NAME, getHomeBase } from "../../persistence/paths.js";

export const UPDATE_SERVER_PORT = 4875;

export interface UpdateServerOpts {
  siteDir: string;
  port?: number;
  bindAddress?: string;
}

/** Map a file path to a Content-Type. Uses endsWith so ".tar.gz" is handled. */
function contentType(filePath: string): string {
  if (filePath.endsWith(".tar.gz") || filePath.endsWith(".gz")) return "application/gzip";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".sig")) return "text/plain; charset=utf-8";
  if (filePath.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

// [3b NIT-1] sendError takes optional extra headers so the 405 branch can advertise Allow: GET.
function sendError(res: ServerResponse, status: number, message: string, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...extraHeaders });
  res.end(message);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, siteRoot: string): Promise<void> {
  if (req.method !== "GET") {
    sendError(res, 405, "method not allowed", { Allow: "GET" }); // [3b NIT-1]
    return;
  }
  const raw = (req.url ?? "/").split("?")[0] ?? "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    sendError(res, 400, "bad request");
    return;
  }
  // [3b CLR-1] reject NUL bytes outright (defense-in-depth; path.resolve would also reject).
  if (decoded.includes("\0")) {
    sendError(res, 400, "bad request");
    return;
  }
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(siteRoot, rel);
  // [3b CLR-2] Path-traversal containment is LEXICAL only: resolved must be the root
  // itself or strictly inside it. This does NOT resolve symlinks — intentional: the site
  // is populated by build-release.sh with REGULAR copied files (no symlinks), so a
  // per-request realpath() is omitted to avoid I/O overhead for a non-threat (see §8).
  if (resolved !== siteRoot && !resolved.startsWith(siteRoot + path.sep)) {
    sendError(res, 403, "forbidden");
    return;
  }
  let st: import("node:fs").Stats;
  try {
    st = await stat(resolved);
  } catch {
    sendError(res, 404, "not found");
    return;
  }
  if (!st.isFile()) {
    sendError(res, 404, "not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType(resolved), "Content-Length": st.size });
  const stream = createReadStream(resolved);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

export function startUpdateServer(opts: UpdateServerOpts): Server {
  const siteRoot = path.resolve(opts.siteDir);
  const server = createServer((req, res) => {
    handleRequest(req, res, siteRoot).catch(() => {
      if (!res.headersSent) sendError(res, 500, "server error");
      else res.destroy();
    });
  });
  const host = opts.bindAddress ?? "0.0.0.0";
  const port = opts.port ?? UPDATE_SERVER_PORT;
  server.listen(port, host, () => {
    process.stdout.write(`[update-server] serving ${siteRoot} on http://${host}:${port}\n`);
  });
  return server;
}

/** CLI wrapper: starts the server and blocks until SIGINT/SIGTERM. */
export async function runUpdateServerSubcommand(opts: { port?: string; siteDir?: string }): Promise<void> {
  const siteDir = opts.siteDir ?? path.join(getHomeBase(), DATA_DIR_NAME, "site");
  // [3b CLR-4] strict port parse: Number (not parseInt — rejects "4875abc"), integer 1-65535.
  const port = opts.port === undefined ? UPDATE_SERVER_PORT : Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`update-server: invalid --port "${opts.port}" (expected integer 1-65535)\n`);
    process.exit(1);
  }
  await new Promise<void>((resolve, reject) => {
    const server = startUpdateServer({ siteDir, port, bindAddress: "0.0.0.0" });
    // [3b CLR-4] turn a listen failure (e.g. EADDRINUSE) into a controlled CLI failure.
    server.once("error", (e: Error) => {
      process.stderr.write(`update-server: failed to listen on 0.0.0.0:${port} — ${e.message}\n`);
      reject(e);
    });
    const shutdown = (): void => {
      server.close(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
