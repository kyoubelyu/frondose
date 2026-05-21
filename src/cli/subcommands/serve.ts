// P-56a M-1 SCAFFOLD: HTTP-over-UDS bridge for the v0.5 Tauri desktop shell.
// P-56b extension: agent loop + SSE events + audit-tail + overlay contextId bridge.
//
// Endpoints:
//   GET  /health
//   GET  /identity
//   POST /chrome/ensure
//   POST /agent/turn
//   GET  /agent/events
//   POST /agent/abort
//   GET  /audit/tail

import { randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import { dirname, join } from "node:path";
import type { CoreMessage, StepResult, ToolSet } from "ai";
import { HookRunner } from "../../agent/hooks.js";
import { runAgentLoop } from "../../agent/loop.js";
import { resolveMaxSteps } from "../../agent/maxSteps.js";
import { resolveModel } from "../../agent/modelResolver.js";
import { BOUNDARY } from "../../agent/systemPrompt/boundary.js";
import { CHECKPOINT } from "../../agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../../agent/systemPrompt/compose.js";
import { resolveSoulBand } from "../../agent/systemPrompt/soul.js";
import { createLinkedinSession } from "../../linkedin/session.js";
import { attachEventBus, type OverlayEvent } from "../../overlay/eventBus.js";
import { callInOverlay, subscribeContextId } from "../../overlay/inject.js";
import { makeAuditWriter } from "../../persistence/audit.js";
import { DEFAULT_CONFIG_PATH, readConfig } from "../../persistence/config.js";
import { DEFAULT_IDENTITY_PATH, readIdentity } from "../../persistence/identity.js";
import { getHomeBase } from "../../persistence/paths.js";
import type { ControlSignals } from "../../tools/index.js";
import { makeAllTools } from "../../tools/index.js";

export interface ServeOpts {
  sockPath: string;
  bearerToken: string;
}

const AUDIT_PATH = (): string => join(getHomeBase(), ".mai", "agent", "audit.jsonl");

interface SseFrame {
  type: "tool-call" | "text" | "step-done" | "done" | "error" | "overlay-reconnected" | "overlay-event";
  turnId?: string;
  toolName?: string;
  toolNames?: string[];
  chunk?: string;
  finishReason?: string;
  aborted?: boolean;
  message?: string;
  event?: OverlayEvent;
}

interface CurrentTurn {
  turnId: string;
  abortController: AbortController;
}

type ServeEmitter = EventEmitter<{
  "overlay-event": [OverlayEvent];
  "sse-frame": [SseFrame];
}>;

export async function runServeSubcommand(opts: ServeOpts): Promise<void> {
  const parentDir = dirname(opts.sockPath);
  mkdirSync(parentDir, { recursive: true });
  try {
    chmodSync(parentDir, 0o700);
  } catch (e) {
    process.stderr.write(
      `[mai serve] warn: chmod 0o700 on ${parentDir} failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }

  const cfg = readConfig(DEFAULT_CONFIG_PATH());
  const identity = readIdentity(DEFAULT_IDENTITY_PATH());
  const system = composeSystemPrompt({
    boundary: BOUNDARY,
    soul: resolveSoulBand(cfg.soul.override, identity),
    checkpoint: CHECKPOINT,
  });
  const model = resolveModel({});
  const maxSteps = resolveMaxSteps(undefined);
  const profileDir = join(getHomeBase(), ".mai", "agent", "chrome-profile");
  const memoryDbPath = join(getHomeBase(), ".mai", "agent", "memory.sqlite");
  const identityPath = DEFAULT_IDENTITY_PATH();
  const schedulePath = join(getHomeBase(), ".mai", "agent", "schedule.jsonl");
  const auditPath = AUDIT_PATH();
  const auditWriter = makeAuditWriter(auditPath);
  const session = createLinkedinSession({ port: 9222, profileDir, inputMode: cfg.worker.input_mode });
  const messages: CoreMessage[] = [];
  let currentTurn: CurrentTurn | null = null;
  const control: ControlSignals = {
    requestStop: () => currentTurn?.abortController.abort(),
    auditPath,
  };
  const hookRunner = new HookRunner();
  const workerId = identity?.fullName ?? os.hostname();
  const tools = makeAllTools(session, { memoryDbPath, identityPath, schedulePath }, control, hookRunner, {
    mode: "worker",
    workerId,
  });

  const emitter: ServeEmitter = new EventEmitter();
  const sseClients = new Set<ServerResponse>();
  const broadcast = (frame: SseFrame): void => {
    const data = `data: ${JSON.stringify(frame)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(data);
      } catch {
        // Zombie client; res.on("close") handles cleanup.
      }
    }
  };
  emitter.on("sse-frame", broadcast);
  emitter.on("overlay-event", (event) => broadcast({ type: "overlay-event", event }));

  let overlayContextId: number | undefined;
  let unsubscribeContextId: (() => void) | undefined;
  let unsubscribeOverlayEvents: (() => void) | undefined;

  const expectedToken = Buffer.from(opts.bearerToken, "utf-8");
  const server = createServer(async (req, res) => {
    try {
      const authError = checkBearer(req, expectedToken);
      if (authError) {
        sendJson(res, 401, { ok: false, error: authError });
        return;
      }
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      if (method === "GET" && url === "/health") {
        sendJson(res, 200, { ok: true, ts: Date.now(), pid: process.pid });
        return;
      }

      if (method === "GET" && url === "/identity") {
        const id = readIdentity();
        if (id === null) {
          sendJson(res, 200, { ok: false, reason: "identity not set; run `mai setup`" });
          return;
        }
        sendJson(res, 200, { ok: true, ...id });
        return;
      }

      if (method === "POST" && url === "/chrome/ensure") {
        const result = await session.getOrInitClient();
        if (result.ok === false) {
          sendJson(res, 503, { ok: false, error: result.error, message: result.message });
          return;
        }
        if (!unsubscribeContextId) {
          unsubscribeContextId = subscribeContextId(result.client.handle, (id) => {
            const wasReconnect = overlayContextId !== undefined && overlayContextId !== id;
            overlayContextId = id;
            if (wasReconnect) {
              emitter.emit("sse-frame", { type: "overlay-reconnected" });
              const ts = Date.now();
              emitter.emit("overlay-event", {
                kind: "overlay-event",
                ts,
                event_type: "overlay-reconnected",
                t0: ts,
                latency_ms: 0,
              });
            }
          });
        }
        if (!unsubscribeOverlayEvents) {
          unsubscribeOverlayEvents = attachEventBus(result.client.handle, (event) =>
            emitter.emit("overlay-event", event),
          );
        }
        sendJson(res, 200, { ok: true, chromePort: 9222, overlayInstalled: true });
        return;
      }

      if (method === "POST" && url === "/agent/turn") {
        if (currentTurn !== null) {
          sendJson(res, 409, { ok: false, reason: "turn_in_progress", turnId: currentTurn.turnId });
          return;
        }
        const body = await readJsonBody(req);
        const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt) {
          sendJson(res, 400, { ok: false, reason: "missing_prompt" });
          return;
        }
        const turnId = randomBytes(4).toString("hex");
        const abortController = new AbortController();
        currentTurn = { turnId, abortController };
        messages.push({ role: "user", content: prompt });

        sendJson(res, 200, { ok: true, turnId, status: "queued" });
        void runOneTurn({
          turnId,
          abortController,
          model,
          system,
          messages,
          tools,
          maxSteps,
          auditWriter,
          emitFrame: (frame) => emitter.emit("sse-frame", frame),
          session,
          getOverlayContextId: () => overlayContextId,
        })
          .catch((e) => {
            emitter.emit("sse-frame", {
              type: "error",
              turnId,
              message: e instanceof Error ? e.message : String(e),
            });
          })
          .finally(() => {
            currentTurn = null;
          });
        return;
      }

      if (method === "POST" && url === "/agent/abort") {
        if (currentTurn === null) {
          sendJson(res, 200, { ok: false, reason: "not_found" });
          return;
        }
        currentTurn.abortController.abort();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && url === "/agent/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(":\n\n");
        sseClients.add(res);
        const ping = setInterval(() => {
          try {
            res.write(":\n\n");
          } catch {
            // ignore; close handler will clean up.
          }
        }, 30_000);
        ping.unref();
        res.on("close", () => {
          clearInterval(ping);
          sseClients.delete(res);
        });
        return;
      }

      if (method === "GET" && url.startsWith("/audit/tail")) {
        const u = new URL(url, "http://localhost");
        const nParam = u.searchParams.get("n");
        const sinceParam = u.searchParams.get("since");
        const n = nParam ? Math.min(Math.max(Number.parseInt(nParam, 10) || 20, 1), 100) : 20;
        const since = sinceParam ? Number.parseInt(sinceParam, 10) : undefined;
        const rows = readAuditTail(auditPath, n, since);
        sendJson(res, 200, { ok: true, rows, total: rows.length });
        return;
      }

      sendJson(res, 404, { ok: false, error: "not_found", path: url });
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: "internal",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  const shutdown = (signal: string) => {
    process.stdout.write(`[mai serve] ${signal} - shutting down\n`);
    if (currentTurn) currentTurn.abortController.abort();
    if (unsubscribeContextId) unsubscribeContextId();
    if (unsubscribeOverlayEvents) unsubscribeOverlayEvents();
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    sseClients.clear();
    server.close(() => {
      removeSocket(opts.sockPath);
      process.exit(0);
    });
    setTimeout(() => {
      removeSocket(opts.sockPath);
      process.exit(0);
    }, 2000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.sockPath, () => {
      server.off("error", reject);
      chmodSync(opts.sockPath, 0o600);
      process.stdout.write(`[mai serve] listening on ${opts.sockPath}\n`);
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    server.on("close", () => resolve());
  });
}

interface RunOneTurnOpts {
  turnId: string;
  abortController: AbortController;
  model: ReturnType<typeof resolveModel>;
  system: string;
  messages: CoreMessage[];
  tools: ReturnType<typeof makeAllTools>;
  maxSteps: number;
  auditWriter: ReturnType<typeof makeAuditWriter>;
  emitFrame: (frame: SseFrame) => void;
  session: ReturnType<typeof createLinkedinSession>;
  getOverlayContextId: () => number | undefined;
}

async function runOneTurn(opts: RunOneTurnOpts): Promise<void> {
  const { turnId, abortController, emitFrame, session, getOverlayContextId } = opts;
  try {
    await runAgentLoop({
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      maxSteps: opts.maxSteps,
      abortSignal: abortController.signal,
      onStepFinish: async (step: StepResult<ToolSet>) => {
        await opts.auditWriter(step);
        const toolCalls = step.toolCalls as unknown as Array<{ toolName: string }>;
        emitFrame({ type: "step-done", turnId, toolNames: toolCalls.map((call) => call.toolName) });
      },
      onText: (delta) => emitFrame({ type: "text", turnId, chunk: delta }),
      onToolCall: (toolName) => {
        emitFrame({ type: "tool-call", turnId, toolName });
        const ctxId = getOverlayContextId();
        const client = session.getClient();
        if (ctxId !== undefined && client) {
          const text = JSON.stringify(`mai \xb7 ${toolName}\u2026`);
          void callInOverlay(client.handle, ctxId, `function() { window.__maiUpdateTicker(${text}); }`);
        }
      },
    });

    const finishReason = abortController.signal.aborted ? "aborted" : "stop";
    emitFrame({ type: "done", turnId, finishReason, aborted: abortController.signal.aborted });
    if (!abortController.signal.aborted) {
      const ctxId = getOverlayContextId();
      const client = session.getClient();
      if (ctxId !== undefined && client) {
        void callInOverlay(client.handle, ctxId, 'function() { window.__maiUpdateTicker("done"); }');
      }
    }
  } catch (e) {
    if (abortController.signal.aborted) {
      emitFrame({ type: "done", turnId, finishReason: "aborted", aborted: true });
      return;
    }
    emitFrame({ type: "error", turnId, message: e instanceof Error ? e.message : String(e) });
  }
}

function checkBearer(req: IncomingMessage, expectedToken: Buffer): "missing_bearer" | "invalid_token" | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return "missing_bearer";
  const provided = Buffer.from(auth.slice(7), "utf-8");
  if (provided.length !== expectedToken.length) return "invalid_token";
  if (!timingSafeEqual(provided, expectedToken)) return "invalid_token";
  return null;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString("utf-8");
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readAuditTail(auditPath: string, n: number, since?: number): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(auditPath, "utf-8");
  } catch {
    return [];
  }

  const lines = raw.split("\n").filter((line) => line.length > 0);
  const valid: unknown[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as unknown;
      if (since === undefined || rowEpochMs(row) >= since) valid.push(row);
    } catch {
      // Skip malformed partial-write rows.
    }
  }
  return valid.slice(-n);
}

function rowEpochMs(row: unknown): number {
  if (!row || typeof row !== "object") return 0;
  const value = "ts" in row ? (row as { ts?: unknown }).ts : undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function removeSocket(sockPath: string): void {
  try {
    rmSync(sockPath, { force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
