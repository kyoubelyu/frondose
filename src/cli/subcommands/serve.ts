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
import { computeCronRunId, findDueJobs, markRan, readSchedule, writeSchedule } from "../../persistence/schedule.js";
import type { ControlSignals } from "../../tools/index.js";
import { makeAllTools } from "../../tools/index.js";

export interface ServeOpts {
  sockPath: string;
  bearerToken: string;
}

const AUDIT_PATH = (): string => join(getHomeBase(), ".mai", "agent", "audit.jsonl");

interface SseFrame {
  type:
    | "tool-call"
    | "text"
    | "step-done"
    | "done"
    | "error"
    | "overlay-reconnected"
    | "overlay-event"
    | "suggestion-card"
    | "next-actions"
    | "profile-nav"
    | "dialog-mode"
    | "cron-mode";
  turnId?: string;
  toolName?: string;
  toolNames?: string[];
  chunk?: string;
  finishReason?: string;
  aborted?: boolean;
  message?: string;
  event?: OverlayEvent;
  card?: SuggestionCardPayload;
  nextActions?: NextActionsPayload;
  profileUrl?: string;
  profileHandle?: string;
  dialogMode?: "expand" | "collapse";
  cronEnabled?: boolean;
}

interface SuggestionCardPayload {
  dismissed?: boolean;
  reason?: string;
  title?: string;
  icpMatch?: { qualified: boolean; matched: string[]; missing: string[] };
  painChainHypothesis?: string;
  painChainStage?: string;
  suggestedMove?: { kind: "connect" | "comment" | "message"; text: string };
}

interface NextActionsPayload {
  summary: string;
  actions: Array<{ id: string; label: string; prompt: string; danger?: boolean }>;
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
  let cronEnabled = true;
  let cronInterval: ReturnType<typeof setInterval> | null = null;

  cronInterval = setInterval(async () => {
    if (!cronEnabled) return;
    if (currentTurn !== null) return;
    let records: ReturnType<typeof readSchedule>;
    try {
      records = readSchedule(schedulePath);
    } catch {
      return;
    }
    const due = findDueJobs(records, new Date());
    if (due.length === 0) return;
    due.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const next = due[0];
    if (!next) return;
    const fireDate = new Date(next.nextRunAt);
    const cronRunId = computeCronRunId(next, fireDate);
    const localHH = fireDate.getHours().toString().padStart(2, "0");
    const localMM = fireDate.getMinutes().toString().padStart(2, "0");
    const escapeTask = (task: string): string =>
      task.replace(/\\/g, "\\\\").replace(/\r/g, "").replace(/\n/g, " ").replace(/"/g, '\\"');
    const trimmed = next.task.trim();
    const taskLine = trimmed.length > 0 ? `\n(scheduled task: "${escapeTask(trimmed)}")` : "";
    const cronPrompt = `[TIME ${localHH}:${localMM}]\n[CRON_RUN_ID=${cronRunId}]${taskLine}`;
    const turnId = randomBytes(4).toString("hex");
    const abortController = new AbortController();
    currentTurn = { turnId, abortController };
    messages.push({ role: "user", content: cronPrompt });
    try {
      await runOneTurn({
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
      });
      const all = readSchedule(schedulePath);
      const idx = all.findIndex((record) => record.id === next.id);
      if (idx >= 0) {
        const target = all[idx];
        if (target !== undefined) {
          const updated = markRan(target, fireDate);
          if (updated === null) all.splice(idx, 1);
          else all[idx] = updated;
          writeSchedule(schedulePath, all);
        }
      }
    } catch (e) {
      emitter.emit("sse-frame", {
        type: "error",
        turnId,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      currentTurn = null;
    }
  }, 60_000);
  cronInterval.unref();

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
          unsubscribeContextId = await subscribeContextId(result.client.handle, (id) => {
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
          unsubscribeOverlayEvents = attachEventBus(result.client.handle, (event) => {
            void dispatchOverlayEvent(event);
          });
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

      if (method === "POST" && url === "/agent/activate") {
        const body = await readJsonBody(req);
        const pageUrl = typeof body?.url === "string" ? body.url : null;
        if (!pageUrl) {
          sendJson(res, 400, { ok: false, reason: "missing_url" });
          return;
        }
        if (currentTurn !== null) {
          sendJson(res, 409, { ok: false, reason: "turn_in_progress", turnId: currentTurn.turnId });
          return;
        }
        const turnId = randomBytes(4).toString("hex");
        const abortController = new AbortController();
        currentTurn = { turnId, abortController };
        sendJson(res, 200, { ok: true, turnId, status: "queued" });
        void triggerAnalyzeProfile(pageUrl, turnId, abortController).finally(() => {
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

      if (method === "POST" && url === "/agent/cron-mode") {
        const body = await readJsonBody(req);
        const enabled = typeof body?.enabled === "boolean" ? body.enabled : null;
        if (enabled === null) {
          sendJson(res, 400, { ok: false, reason: "missing_enabled" });
          return;
        }
        cronEnabled = enabled;
        emitter.emit("sse-frame", { type: "cron-mode", cronEnabled: enabled });
        sendJson(res, 200, { ok: true, cronEnabled });
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

  function dispatchOverlayEvent(event: OverlayEvent): void {
    const eventRecord = event as unknown as Record<string, unknown>;
    const payload = event.payload;
    const stringField = (key: string): string | undefined => {
      const direct = eventRecord[key];
      if (typeof direct === "string") return direct;
      const fromPayload = payload?.[key];
      return typeof fromPayload === "string" ? fromPayload : undefined;
    };

    if (event.event_type === "profile-nav") {
      emitter.emit("sse-frame", {
        type: "profile-nav",
        profileUrl: stringField("url"),
        profileHandle: stringField("handle"),
      });
      return;
    }
    if (event.event_type === "activate") {
      const pageUrl = stringField("url");
      if (!pageUrl) return;
      if (currentTurn !== null) {
        emitter.emit("sse-frame", {
          type: "error",
          message: `cannot activate - turn ${currentTurn.turnId} in progress`,
        });
        return;
      }
      const turnId = randomBytes(4).toString("hex");
      const abortController = new AbortController();
      currentTurn = { turnId, abortController };
      void triggerAnalyzeProfile(pageUrl, turnId, abortController).finally(() => {
        currentTurn = null;
      });
      return;
    }
    if (event.event_type === "expand-dialog") {
      emitter.emit("sse-frame", { type: "dialog-mode", dialogMode: "expand" });
      return;
    }
    if (event.event_type === "prompt") {
      const text = stringField("text");
      if (text && text.length > 0) {
        void triggerCardActionTurn(text);
      }
      return;
    }
    if (event.event_type === "card-action") {
      const prompt = stringField("prompt");
      if (prompt && prompt.length > 0) {
        void triggerCardActionTurn(prompt);
      }
      return;
    }
    emitter.emit("overlay-event", event);
  }

  async function triggerAnalyzeProfile(
    pageUrl: string,
    turnId: string,
    abortController: AbortController,
  ): Promise<void> {
    const analyzePrompt =
      `Operator is on profile ${pageUrl}. Analyze this profile against the operator's ICP. ` +
      "First call `inspect` to extract role/industry/region/companyName from the page. " +
      "Then call `qualify_profile` with those four fields. " +
      "Then call `suggest_card` with: " +
      "(a) when qualified — title (name + role), icpMatch, painChainHypothesis (≤2 sentences), " +
      "painChainStage (one of the 15 methodology enum values), suggestedMove (kind + text); " +
      '(b) when disqualified or extraction failed — {dismissed:true, reason:"..."}. ' +
      "Stop after suggest_card. Do NOT take any outreach action in this sub-turn.";
    messages.push({ role: "user", content: analyzePrompt });
    try {
      await runOneTurn({
        turnId,
        abortController,
        model,
        system,
        messages,
        tools,
        maxSteps: 20,
        auditWriter,
        emitFrame: (frame) => emitter.emit("sse-frame", frame),
        session,
        getOverlayContextId: () => overlayContextId,
      });
    } catch (e) {
      emitter.emit("sse-frame", {
        type: "error",
        turnId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function triggerCardActionTurn(actionPrompt: string): Promise<void> {
    if (currentTurn !== null) {
      emitter.emit("sse-frame", {
        type: "error",
        message: `cannot fire card action - turn ${currentTurn.turnId} in progress`,
      });
      return;
    }
    const turnId = randomBytes(4).toString("hex");
    const abortController = new AbortController();
    currentTurn = { turnId, abortController };
    messages.push({ role: "user", content: actionPrompt });
    try {
      await runOneTurn({
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
      });
    } catch (e) {
      emitter.emit("sse-frame", {
        type: "error",
        turnId,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      currentTurn = null;
    }
  }

  const shutdown = (signal: string) => {
    process.stdout.write(`[mai serve] ${signal} - shutting down\n`);
    if (currentTurn) currentTurn.abortController.abort();
    if (unsubscribeContextId) unsubscribeContextId();
    if (unsubscribeOverlayEvents) unsubscribeOverlayEvents();
    if (cronInterval) {
      clearInterval(cronInterval);
      cronInterval = null;
    }
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
  const ctxId0 = getOverlayContextId();
  const client0 = session.getClient();
  if (ctxId0 !== undefined && client0) {
    void callInOverlay(client0.handle, ctxId0, "function() { window.__maiClearOutput(); }");
  }
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
        const toolResults =
          (step as unknown as { toolResults?: Array<{ toolName: string; result: unknown }> }).toolResults ?? [];
        for (const tr of toolResults) {
          if (tr.toolName === "suggest_card") {
            const card = (tr.result as unknown as { ok: boolean }) ?? {};
            emitFrame({ type: "suggestion-card", turnId, card: card as SuggestionCardPayload });
            const ctxId = getOverlayContextId();
            const client = session.getClient();
            if (ctxId !== undefined && client) {
              const json = JSON.stringify(card);
              void callInOverlay(client.handle, ctxId, `function() { window.__maiShowCard(${JSON.stringify(json)}); }`);
            }
          }
          if (tr.toolName === "suggest_next_actions") {
            const nextActions = (tr.result as unknown as { ok: boolean }) ?? {};
            emitFrame({ type: "next-actions", turnId, nextActions: nextActions as unknown as NextActionsPayload });
            const ctxId = getOverlayContextId();
            const client = session.getClient();
            if (ctxId !== undefined && client) {
              const json = JSON.stringify(nextActions);
              void callInOverlay(
                client.handle,
                ctxId,
                `function() { window.__maiShowNextActions(${JSON.stringify(json)}); }`,
              );
            }
          }
        }
        emitFrame({ type: "step-done", turnId, toolNames: toolCalls.map((call) => call.toolName) });
      },
      onText: (delta) => {
        emitFrame({ type: "text", turnId, chunk: delta });
        const ctxId = getOverlayContextId();
        const client = session.getClient();
        if (ctxId !== undefined && client) {
          const s = JSON.stringify(delta);
          void callInOverlay(client.handle, ctxId, `function() { window.__maiAppendOutput(${JSON.stringify(s)}); }`);
        }
      },
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
