/** P-29: operator-facing web dashboard HTTP listener (port 8090).
 *  Separate from the worker REST API (serverHttp.ts, port 3031). Basic-Auth
 *  gate; static React/Tailwind bundle from dist/web/; 5 read-only-ish endpoints. */
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import { extname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import type { Database as DB } from "better-sqlite3";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { listInvitesByPersona } from "../persistence/invitesRegistry.js";
import { listRecentMemoryEvents } from "../persistence/memory.js";
import { listPersonaTemplates, readPersonaTemplate } from "../persistence/personaLibrary.js";
import { readWorkerNodeConfig } from "../persistence/workerNodeConfig.js";
import { getLastLeadActionByWorker, listWorkers } from "../persistence/workersRegistry.js";
import { mintInvite } from "../tools/server/provisionWorker.js";
import { handleSshWs } from "./serverSsh.js";
import { handleVncWs } from "./serverVnc.js";

export interface WebHttpDeps {
  workersDb: DB | null;
  memoryDb: DB | null;
  invitesDb: DB | null;
  personasDir: string;
  serverUrl: string;
  /** Absolute path to the static asset directory (dist/web/; injected for tests). */
  assetRoot: string;
  // P-30 additions (additive; builder wires in at Step 4b):
  sshUser?: string | null;
  sshPort?: number;
  workersConfigDir?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

const provisionBodySchema = z.object({
  personaId: z.string().min(1),
  hostname: z.string().optional(),
  ttlMin: z.number().int().min(5).max(1440).optional(),
});

/** Timing-safe Basic-Auth check. Returns true when auth passes OR webToken is
 *  undefined (no-auth / Tailscale-only mode). Length-guard before timingSafeEqual. */
export function checkBasicAuth(req: IncomingMessage, webToken: string | undefined): boolean {
  if (!webToken) return true; // no-auth (Tailscale-only) mode
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
    const supplied = decoded.slice(decoded.indexOf(":") + 1); // password component
    const a = Buffer.from(supplied, "utf-8");
    const b = Buffer.from(webToken, "utf-8");
    return a.length === b.length && timingSafeEqual(a, b); // length-guard before compare
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** D-5: resolve-then-prefix-check traversal guard. The URL path is percent-decoded
 *  BEFORE the resolve check so encoded traversal (`%2e%2e%2f`) is caught (G-P29.9). */
function serveStatic(res: ServerResponse, assetRoot: string, urlPath: string): void {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found\n");
    return;
  }
  if (rel === "/") rel = "/index.html";
  const resolved = resolve(assetRoot, `.${rel}`);
  if (resolved !== assetRoot && !resolved.startsWith(`${assetRoot}/`)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found\n");
    return;
  }
  try {
    const body = readFileSync(resolved);
    res.writeHead(200, { "Content-Type": MIME[extname(resolved)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found\n");
  }
}

async function readJsonBody(req: IncomingMessage, max = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > max) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return total === 0 ? null : JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

async function route(req: IncomingMessage, res: ServerResponse, deps: WebHttpDeps): Promise<void> {
  const u = new URL(req.url ?? "/", "http://localhost");
  const path = u.pathname;

  // ─── GET dashboard JSON ───
  if (req.method === "GET" && path === "/api/web/workers") {
    const workers = deps.workersDb ? listWorkers(deps.workersDb) : [];
    const out = workers.map((w) => ({
      ...w,
      last_action: deps.workersDb ? getLastLeadActionByWorker(deps.workersDb, w.worker_id) : null,
    }));
    return sendJson(res, 200, { workers: out });
  }
  if (req.method === "GET" && path === "/api/web/leads") {
    const page = Math.max(0, Number(u.searchParams.get("page") ?? 0) || 0);
    const limit = Math.min(200, Math.max(1, Number(u.searchParams.get("limit") ?? 50) || 50));
    const events = deps.memoryDb ? listRecentMemoryEvents(deps.memoryDb, limit, page * limit) : [];
    return sendJson(res, 200, { events, page, limit });
  }
  if (req.method === "GET" && path === "/api/web/personas") {
    const ids = listPersonaTemplates(deps.personasDir);
    const personas = ids.map((id) => {
      const t = readPersonaTemplate(deps.personasDir, id);
      return { id, fullName: t?.fullName ?? null, role: t?.role ?? null, company: t?.company ?? null };
    });
    return sendJson(res, 200, { personas });
  }
  if (req.method === "GET" && path === "/api/web/invites") {
    const personaId = u.searchParams.get("personaId");
    if (!personaId) return sendJson(res, 400, { error: "validation", detail: "personaId required" });
    const invites = deps.invitesDb ? listInvitesByPersona(deps.invitesDb, personaId) : [];
    return sendJson(res, 200, { invites });
  }
  // ─── POST provision ───
  if (req.method === "POST" && path === "/api/web/provision") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: "validation" });
    }
    const parsed = provisionBodySchema.safeParse(body);
    if (!parsed.success) return sendJson(res, 400, { ok: false, error: "validation" });
    if (!deps.invitesDb) return sendJson(res, 503, { ok: false, error: "invites_db_unavailable" });
    const r = mintInvite(deps.invitesDb, deps.personasDir, deps.serverUrl, parsed.data);
    if (!r.ok) return sendJson(res, 422, { ok: false, error: "persona_not_found", detail: r.error });
    return sendJson(res, 200, r);
  }
  // ─── unknown /api/web/* ───
  if (path.startsWith("/api/web/")) return sendJson(res, 404, { error: "not_found" });
  // ─── static (GET only) ───
  if (req.method === "GET") return serveStatic(res, deps.assetRoot, path);
  sendJson(res, 404, { error: "not_found" });
}

/** P-30: WebSocket upgrade handler — Basic-Auth gate + /ws/ssh|vnc/<id> routing.
 *  D-7 (Step-3b B-1 Option A): auth via the Authorization header the browser
 *  replays on the same-origin WS upgrade — reuses P-29's `checkBasicAuth`. No
 *  `?token=` query param. Log lines reference worker_id only, never req.url.
 *
 *  Ordering invariant (G-P30.7): auth → worker-active check → SSH/VNC dial. The
 *  socket is destroyed BEFORE any dial for an unknown/non-active worker. */
export function attachWebSockets(server: Server, deps: WebHttpDeps, webToken: string | undefined): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    // ── auth: same Basic-Auth gate as the HTTP routes (no-auth when webToken unset) ──
    if (!checkBasicAuth(req, webToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="mai-server"\r\n\r\n');
      socket.destroy();
      return;
    }
    const sshM = u.pathname.match(/^\/ws\/ssh\/([\w.-]+)$/);
    const vncM = u.pathname.match(/^\/ws\/vnc\/([\w.-]+)$/);
    const workerId = sshM?.[1] ?? vncM?.[1];
    if (!workerId) {
      socket.destroy();
      return;
    }
    const worker = deps.workersDb
      ? listWorkers(deps.workersDb).find((w) => w.worker_id === workerId && w.status === "active")
      : undefined;
    if (!worker || !worker.hostname) {
      socket.destroy(); // unknown/inactive/hostname-less worker — no dial
      return;
    }
    const workerHost = worker.hostname;
    const nodeCfg = readWorkerNodeConfig(deps.workersConfigDir ?? "", workerId);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (sshM) {
        handleSshWs(ws, {
          workerId,
          host: workerHost,
          user: nodeCfg?.ssh_user ?? deps.sshUser ?? os.userInfo().username,
          port: nodeCfg?.ssh_port ?? deps.sshPort ?? 22,
        });
      } else {
        void handleVncWs(ws, {
          workerId,
          host: nodeCfg?.vnc_host ?? workerHost,
          vncPort: nodeCfg?.vnc_port,
          vncPassword: nodeCfg?.vnc_password,
        });
      }
    });
  });
}

export function startWebHttp(
  deps: WebHttpDeps,
  port: number,
  bindAddress: string | null,
  webToken: string | undefined,
): Server {
  const server = createServer((req, res) => {
    if (!checkBasicAuth(req, webToken)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="mai-server"', "Content-Type": "text/plain" });
      res.end("Unauthorized\n");
      return;
    }
    route(req, res, deps).catch((e) => {
      sendJson(res, 500, { error: "server error", detail: e instanceof Error ? e.message : String(e) });
    });
  });
  // P-30: WebSocket upgrade handler (SSH/VNC) on the same http.Server.
  attachWebSockets(server, deps, webToken);
  const host = bindAddress ?? "127.0.0.1";
  server.listen(port, host, () => {
    process.stdout.write(`[web] dashboard listening on ${host}:${port}${webToken ? " (Basic-Auth)" : " (no-auth)"}\n`);
  });
  return server;
}
