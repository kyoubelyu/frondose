/** P-26: server-side HTTP listener. Plain HTTP on Tailscale per OQ-1/4.
 *
 *  Built on Node's built-in `http` module — no new npm deps. Operator MUST
 *  ensure all workers + server share a Tailscale tailnet; the bind address
 *  defaults to `127.0.0.1` (only loopback exposed). Operator opts in to
 *  Tailscale by setting `config.server.bind_address` to a `100.x.x.x` or
 *  `*.tailnet.ts.net` address.
 *
 *  Token auth: `Authorization: Bearer <token>` → SHA-256 → constant-time
 *  compare via `getWorkerByTokenHashConstantTime` (workersRegistry.ts).
 *  Revoked or unknown tokens → 401.
 *
 *  Step-3b C-6: this file is the ONLY caller of
 *  `getWorkerByTokenHashConstantTime`. The non-constant-time variant is NOT
 *  exported from workersRegistry.ts.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { getGoogleAccount, getLlmKey, incrementLlmKeyAssignedCount } from "../persistence/credentialLibrary.js";
import { consumeInvite, lookupInviteAny, lookupPendingInvite } from "../persistence/invitesRegistry.js";
import { readPersonaTemplate } from "../persistence/personaLibrary.js";
import { enqueueServerInbox } from "../persistence/serverInbox.js";
import {
  addWorker,
  drainPendingWorkerInbox,
  getWorkerByTokenHashConstantTime,
  insertLeadAction,
  pendingWorkerInboxCount,
  queryRecentLeadAction,
  updateHeartbeat,
} from "../persistence/workersRegistry.js";
import { renderBootstrapScript } from "./serverBootstrapTemplate.js";

export const SERVER_HTTP_PORT = 3031;

export interface ServerHttpHandlers {
  workersDb: import("better-sqlite3").Database;
  serverInboxDb: import("better-sqlite3").Database;
  // P-27 additions:
  invitesDb: import("better-sqlite3").Database;
  personasDir: string;
  serverUrl: string;
  maiVersion: string;
  // P-28: credential library. Nullable — credential folding is skipped silently
  // when the DB handle is absent (graceful degradation; register still 200s).
  credentialsDb: import("better-sqlite3").Database | null;
}

// ─── Zod request schemas (mirror plan §4.4) ──────────────────────────────────
const heartbeatReqSchema = z.object({
  workerId: z.string().min(1),
  hostname: z.string().min(1).optional(),
  persona: z.string().min(1).optional(),
});
const leadCheckReqSchema = z.object({
  personRef: z.string().url(),
  lookbackHours: z.number().int().min(1).max(720).optional().default(72),
});
const leadTouchReqSchema = z.object({
  personRef: z.string().url(),
  actionType: z.string().min(1),
  ts: z.number().int(),
});
const eventReqSchema = z.object({
  type: z.string().min(1),
  data: z.record(z.unknown()).optional().default({}),
});
const pollQuerySchema = z.object({
  worker_id: z.string().min(1),
  timeout: z.coerce.number().int().min(1).max(60).optional().default(25),
});
// P-27: invite-token register request.
const registerReqSchema = z.object({
  inviteToken: z.string().regex(/^[0-9a-f]{64}$/i),
  hostname: z.string().min(1).max(255).optional(),
  requestedWorkerId: z.string().min(1).max(64).optional(),
});

// ─── Public entrypoint ────────────────────────────────────────────────────────

export function startServerHttp(
  handlers: ServerHttpHandlers,
  bindAddress: string | null,
  port: number = SERVER_HTTP_PORT,
): Server {
  const server = createServer((req, res) => {
    routeRequest(req, res, handlers).catch((e) => {
      sendJson(res, 500, { error: "server error", detail: e instanceof Error ? e.message : String(e) });
    });
  });
  const host = bindAddress ?? "127.0.0.1";
  server.listen(port, host, () => {
    process.stdout.write(`[server http] listening on ${host}:${port}\n`);
  });
  return server;
}

// ─── Routing + token auth ─────────────────────────────────────────────────────

interface AuthedWorker {
  worker_id: string;
  status: string;
}

async function routeRequest(req: IncomingMessage, res: ServerResponse, handlers: ServerHttpHandlers): Promise<void> {
  const url = req.url ?? "/";

  // ─── P-27 public route: GET /bootstrap/<token>.sh (no Bearer) ───
  // All /bootstrap/* GETs route to the handler; the handler's regex decides
  // 200 vs 404 (a path missing the .sh suffix or with a malformed token → 404).
  if (req.method === "GET" && url.startsWith("/bootstrap/")) {
    return handleBootstrapScript(req, res, handlers);
  }

  // ─── P-27 invite-token route: POST /api/register (body field, no Bearer) ───
  if (req.method === "POST" && url === "/api/register") {
    return handleRegister(req, res, handlers);
  }

  // ─── Bearer-token routes (P-26 unchanged): existing 5 endpoints ───
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    sendJson(res, 401, { error: "invalid_token" });
    return;
  }
  const token = auth.slice(7);
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const worker = getWorkerByTokenHashConstantTime(handlers.workersDb, tokenHash);
  if (!worker || worker.status !== "active") {
    sendJson(res, 401, { error: "invalid_token" });
    return;
  }
  // Routing
  if (req.method === "POST" && url === "/api/heartbeat") {
    return handleHeartbeat(req, res, handlers, worker);
  }
  if (req.method === "POST" && url === "/api/lead/check") {
    return handleLeadCheck(req, res, handlers);
  }
  if (req.method === "POST" && url === "/api/lead/touch") {
    return handleLeadTouch(req, res, handlers, worker);
  }
  if (req.method === "POST" && url === "/api/event") {
    return handleEvent(req, res, handlers, worker);
  }
  if (req.method === "GET" && url.startsWith("/api/worker_inbox/poll")) {
    return handleWorkerInboxPoll(req, res, handlers, worker);
  }
  sendJson(res, 404, { error: "not_found" });
}

// ─── P-27 handler: GET /bootstrap/<token>.sh ──────────────────────────────────

async function handleBootstrapScript(req: IncomingMessage, res: ServerResponse, h: ServerHttpHandlers): Promise<void> {
  const url = req.url ?? "";
  const m = url.match(/^\/bootstrap\/([0-9a-f]{64})\.sh(?:\?|$)/i);
  if (!m || !m[1]) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("invite token not found or expired\n");
    return;
  }
  const tokenPlain = m[1];
  const tokenSha256 = createHash("sha256").update(tokenPlain).digest("hex");
  const pending = lookupPendingInvite(h.invitesDb, tokenSha256);
  if (!pending) {
    // Distinguish 404 (not found / expired) from 410 (consumed).
    const any = lookupInviteAny(h.invitesDb, tokenSha256);
    if (any?.status === "consumed") {
      res.writeHead(410, { "Content-Type": "text/plain" });
      res.end("invite token already used\n");
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("invite token not found or expired\n");
    }
    return;
  }
  const script = renderBootstrapScript(h.serverUrl, tokenPlain, h.maiVersion);
  res.writeHead(200, { "Content-Type": "text/x-sh; charset=utf-8" });
  res.end(script);
}

// ─── P-27 handler: POST /api/register ─────────────────────────────────────────

async function handleRegister(req: IncomingMessage, res: ServerResponse, h: ServerHttpHandlers): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "bad_json" });
    return;
  }
  const parsed = registerReqSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: "validation", detail: parsed.error.format() });
    return;
  }

  const tokenSha256 = createHash("sha256").update(parsed.data.inviteToken).digest("hex");
  const pending = lookupPendingInvite(h.invitesDb, tokenSha256);
  if (!pending) {
    sendJson(res, 401, { ok: false, error: "invite invalid or consumed" });
    return;
  }

  // (1) Validate persona EXISTS before consuming — avoid burning an invite on a
  //     non-existent persona (operator fixes the library and re-provisions).
  const persona = readPersonaTemplate(h.personasDir, pending.persona_id);
  if (!persona) {
    sendJson(res, 422, { ok: false, error: `persona_not_found: ${pending.persona_id}` });
    return;
  }

  // (2) Generate worker_id + permanent token.
  const workerId = parsed.data.requestedWorkerId ?? randomBytes(4).toString("hex");
  const permanentToken = randomBytes(32).toString("hex");

  // (3) Consume invite FIRST (atomic single-row UPDATE).
  const consumed = consumeInvite(h.invitesDb, tokenSha256, workerId);
  if (!consumed) {
    // Race: another request consumed between our lookup and update.
    sendJson(res, 401, { ok: false, error: "invite invalid or consumed" });
    return;
  }

  // (4) Insert worker into workers.sqlite. Cross-DB; if this throws the invite
  //     is already consumed — operator re-provisions (§9 R-3).
  addWorker(h.workersDb, workerId, permanentToken, parsed.data.hostname ?? undefined, pending.persona_id);

  // (5) Build identity from persona template.
  //     C-2 FIX: the field is `profileUrl` (identityRecordSchema's actual name),
  //     NOT `linkedInUrl` — P-27 wrote `linkedInUrl`, which Zod silently STRIPPED
  //     on every parse, losing the URL. Source stays `persona.linkedInUrl`
  //     (personaTemplateSchema's field — unchanged); the identity KEY is `profileUrl`.
  const identity = {
    fullName: persona.fullName,
    role: persona.role,
    company: persona.company,
    profileUrl: persona.linkedInUrl,
    email: persona.email,
    persona: pending.persona_id,
    updatedAt: new Date().toISOString(),
  };

  // (5a) P-28: resolve LLM key + Google account from persona refs.
  //      Missing/unresolvable refs (or a null credentialsDb) degrade gracefully —
  //      register still 200s. Step 5a runs AFTER consumeInvite + addWorker so a
  //      missing credential never burns an invite or blocks registration.
  let llmProviderConfig: { name: string; type: "anthropic" | "openai"; baseUrl?: string; key: string } | undefined;
  if (h.credentialsDb && persona.llmKeyRef) {
    const k = getLlmKey(h.credentialsDb, persona.llmKeyRef);
    if (k) {
      llmProviderConfig = {
        name: k.id,
        type: k.provider_type,
        baseUrl: k.base_url ?? undefined,
        key: k.api_key,
      };
      incrementLlmKeyAssignedCount(h.credentialsDb, persona.llmKeyRef);
    } else {
      process.stderr.write(`[server http] register: llmKeyRef '${persona.llmKeyRef}' not found\n`);
    }
  }

  let googleAccountEmail: string | undefined;
  if (h.credentialsDb && persona.googleAccountRef) {
    const g = getGoogleAccount(h.credentialsDb, persona.googleAccountRef);
    if (g)
      googleAccountEmail = g.email; // password NEVER pushed (G-P28.23)
    else process.stderr.write(`[server http] register: googleAccountRef '${persona.googleAccountRef}' not found\n`);
  }

  sendJson(res, 200, {
    ok: true,
    workerId,
    permanentToken,
    personaId: pending.persona_id,
    identity,
    soulBandOverride: persona.soulBandOverride ?? null,
    ...(llmProviderConfig ? { llmProviderConfig } : {}),
    ...(googleAccountEmail ? { googleAccountEmail } : {}),
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > maxBytes) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  if (total === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

// ─── Endpoint handlers ────────────────────────────────────────────────────────

async function handleHeartbeat(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: ServerHttpHandlers,
  _worker: AuthedWorker,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "bad_json" });
    return;
  }
  const parsed = heartbeatReqSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: "validation", detail: parsed.error.format() });
    return;
  }
  updateHeartbeat(
    handlers.workersDb,
    parsed.data.workerId,
    parsed.data.hostname ?? null,
    parsed.data.persona ?? null,
    Date.now(),
  );
  const pending = pendingWorkerInboxCount(handlers.serverInboxDb, parsed.data.workerId);
  sendJson(res, 200, { ok: true, pendingMessages: pending });
}

async function handleLeadCheck(req: IncomingMessage, res: ServerResponse, handlers: ServerHttpHandlers): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "bad_json" });
    return;
  }
  const parsed = leadCheckReqSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: "validation", detail: parsed.error.format() });
    return;
  }
  const { personRef, lookbackHours } = parsed.data;
  const since = Date.now() - lookbackHours * 3600_000;
  const row = queryRecentLeadAction(handlers.workersDb, personRef, since);
  if (!row) {
    sendJson(res, 200, { allowed: true, lastTouchedBy: null, lastTouchedTs: null, reason: null });
  } else {
    const ageH = Math.round((Date.now() - row.ts) / 3600_000);
    sendJson(res, 200, {
      allowed: false,
      lastTouchedBy: row.worker_id,
      lastTouchedTs: row.ts,
      reason: `Worker ${row.worker_id} touched this person ${ageH}h ago`,
    });
  }
}

async function handleLeadTouch(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: ServerHttpHandlers,
  worker: AuthedWorker,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "bad_json" });
    return;
  }
  const parsed = leadTouchReqSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: "validation", detail: parsed.error.format() });
    return;
  }
  insertLeadAction(handlers.workersDb, parsed.data.personRef, parsed.data.actionType, worker.worker_id, parsed.data.ts);
  sendJson(res, 200, { ok: true });
}

async function handleEvent(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: ServerHttpHandlers,
  worker: AuthedWorker,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "bad_json" });
    return;
  }
  const parsed = eventReqSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: "validation", detail: parsed.error.format() });
    return;
  }
  const id = enqueueServerInbox(handlers.serverInboxDb, worker.worker_id, parsed.data.type, parsed.data.data);
  sendJson(res, 200, { ok: true, id });
}

async function handleWorkerInboxPoll(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: ServerHttpHandlers,
  worker: AuthedWorker,
): Promise<void> {
  const u = new URL(req.url ?? "/", "http://localhost");
  const parsed = pollQuerySchema.safeParse({
    worker_id: u.searchParams.get("worker_id"),
    timeout: u.searchParams.get("timeout") ?? undefined,
  });
  if (!parsed.success) {
    sendJson(res, 400, { error: "validation", detail: parsed.error.format() });
    return;
  }
  if (parsed.data.worker_id !== worker.worker_id) {
    sendJson(res, 403, { error: "worker_id mismatch with token" });
    return;
  }
  const messages = await drainPendingWorkerInbox(handlers.serverInboxDb, worker.worker_id, parsed.data.timeout * 1000);
  sendJson(res, 200, { messages });
}
