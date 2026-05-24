import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CdpClient } from "../../../cdp/client.js";
import { attachEventBus, type OverlayEvent } from "../../../overlay/eventBus.js";
import { subscribeContextId } from "../../../overlay/inject.js";
import { readIdentity } from "../../../persistence/identity.js";
import { setCronMode } from "../../../persistence/mode.js";
import { MAX_RETRY_ATTEMPTS, type ServeDeps, type ServeState } from "./context.js";
import type { createOverlayDispatcher } from "./dispatch.js";
import { checkBearer, readAuditTail, readJsonBody, sendJson } from "./http.js";
import { showEdgeRing } from "./takeover.js";
import type { createTurnRunner } from "./turn.js";

/**
 * P-Y4 (ask d): wire the in-page overlay to a booted CDP client — capture the overlay
 * execution-context id (for callInOverlay) + route in-page overlay events (pill activate,
 * passive observe) into serve. Extracted verbatim from the old POST /chrome/ensure body so
 * BOTH that route AND the lazy onClientBooted boot path share one idempotent implementation.
 * Idempotent via the state guards: a second call (e.g. ensure after onClientBooted already
 * ran) no-ops.
 */
export async function ensureOverlaySubscription(
  state: ServeState,
  deps: ServeDeps,
  onOverlayEvent: (event: OverlayEvent) => void,
  client: CdpClient,
): Promise<void> {
  if (!state.unsubscribeContextId) {
    state.unsubscribeContextId = await subscribeContextId(client.handle, (id) => {
      const wasReconnect = state.overlayContextId !== undefined && state.overlayContextId !== id;
      state.overlayContextId = id;
      if (state.currentTurn !== null && state.cronEnabled) showEdgeRing(state, deps.session);
      if (wasReconnect) {
        deps.emitFrame({ type: "overlay-reconnected" });
        const ts = Date.now();
        deps.emitOverlayEvent({
          kind: "overlay-event",
          ts,
          event_type: "overlay-reconnected",
          t0: ts,
          latency_ms: 0,
        });
      }
    });
  }
  if (!state.unsubscribeOverlayEvents) {
    state.unsubscribeOverlayEvents = attachEventBus(client.handle, (event) => {
      onOverlayEvent(event);
    });
  }
}

export function createRequestHandler(
  state: ServeState,
  deps: ServeDeps,
  turn: ReturnType<typeof createTurnRunner>,
  dispatch: ReturnType<typeof createOverlayDispatcher>,
): { handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> } {
  // D-RUN-1 (safety, belt-and-suspenders): if the controlling UDS client (the Tauri
  // shell's SSE subscriber) disconnects and does NOT reconnect within a short grace
  // window, STOP THE AGENT so an orphaned sidecar can't keep acting on the page even if
  // the parent's kill failed — halt the cron loop (cronEnabled=false; cron.tick() early-
  // returns) AND abort any in-flight turn. The grace window tolerates the subscriber's
  // ~1s reconnect (main.rs run_sse_subscriber) so a transient blip never stops a live
  // session. Headless `mai serve` (cron, no SSE client) never connects → never triggers.
  const CLIENT_DISCONNECT_GRACE_MS = 3000;
  let clientGoneTimer: ReturnType<typeof setTimeout> | null = null;
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const authError = checkBearer(req, deps.expectedToken);
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
        const result = await deps.session.getOrInitClient();
        if (result.ok === false) {
          sendJson(res, 503, { ok: false, error: result.error, message: result.message });
          return;
        }
        await ensureOverlaySubscription(state, deps, dispatch.dispatchOverlayEvent, result.client);
        sendJson(res, 200, { ok: true, chromePort: 9222, overlayInstalled: true });
        return;
      }

      if (method === "POST" && url === "/agent/turn") {
        if (state.currentTurn !== null) {
          sendJson(res, 409, { ok: false, reason: "turn_in_progress", turnId: state.currentTurn.turnId });
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
        state.currentTurn = { turnId, abortController };
        state.messages.push({ role: "user", content: prompt });
        state.lastTurnUserPrompt = prompt;

        sendJson(res, 200, { ok: true, turnId, status: "queued" });
        void turn
          .runOneTurn({
            turnId,
            abortController,
            userPrompt: prompt,
            isRetryable: true,
            isCronTurn: false,
          })
          .catch((e) => {
            deps.emitFrame({
              type: "error",
              turnId,
              message: e instanceof Error ? e.message : String(e),
            });
          })
          .finally(() => {
            state.currentTurn = null;
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
        if (state.currentTurn !== null) {
          sendJson(res, 409, { ok: false, reason: "turn_in_progress", turnId: state.currentTurn.turnId });
          return;
        }
        const turnId = randomBytes(4).toString("hex");
        const abortController = new AbortController();
        state.currentTurn = { turnId, abortController };
        sendJson(res, 200, { ok: true, turnId, status: "queued" });
        void turn.triggerAnalyzeProfile(pageUrl, turnId, abortController).finally(() => {
          state.currentTurn = null;
        });
        return;
      }

      if (method === "POST" && url === "/agent/abort") {
        if (state.currentTurn === null) {
          sendJson(res, 200, { ok: false, reason: "not_found" });
          return;
        }
        state.currentTurn.abortController.abort();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && url === "/agent/retry") {
        if (state.currentTurn !== null) {
          sendJson(res, 409, { ok: false, reason: "turn_in_progress", turnId: state.currentTurn.turnId });
          return;
        }
        if (state.lastFailedTurnPrompt === null) {
          sendJson(res, 200, { ok: false, reason: "no_failed_turn" });
          return;
        }
        if (state.retryAttempts >= MAX_RETRY_ATTEMPTS) {
          sendJson(res, 200, { ok: false, reason: "retry_limit_reached", attempts: state.retryAttempts });
          return;
        }
        const prompt = state.lastFailedTurnPrompt ?? state.lastTurnUserPrompt;
        state.lastFailedTurnPrompt = null;
        state.retryAttempts++;
        const turnId = randomBytes(4).toString("hex");
        const abortController = new AbortController();
        state.currentTurn = { turnId, abortController };
        state.messages.push({ role: "user", content: prompt });
        state.lastTurnUserPrompt = prompt;
        sendJson(res, 200, { ok: true, turnId, status: "queued", attempts: state.retryAttempts });
        void turn
          .runOneTurn({
            turnId,
            abortController,
            userPrompt: prompt,
            isRetryable: true,
            isCronTurn: false,
          })
          .finally(() => {
            state.currentTurn = null;
          });
        return;
      }

      if (method === "POST" && url.startsWith("/workflow/")) {
        const body = await readJsonBody(req);
        const r = deps.workflow.handleEndpoint(url, body);
        if (r.resumePrompt) void turn.resumeWorkflowTurn(r.resumePrompt);
        sendJson(res, r.status, r.response);
        return;
      }

      if (method === "POST" && url === "/agent/cron-mode") {
        const body = await readJsonBody(req);
        const enabled = typeof body?.enabled === "boolean" ? body.enabled : null;
        if (enabled === null) {
          sendJson(res, 400, { ok: false, reason: "missing_enabled" });
          return;
        }
        setCronMode(state, enabled);
        deps.emitFrame({ type: "cron-mode", cronEnabled: enabled });
        sendJson(res, 200, { ok: true, cronEnabled: state.cronEnabled });
        return;
      }

      if (method === "POST" && url === "/agent/passive-mode") {
        const body = await readJsonBody(req);
        const enabled = typeof body?.enabled === "boolean" ? body.enabled : null;
        if (enabled === null) {
          sendJson(res, 400, { ok: false, reason: "missing_enabled" });
          return;
        }
        state.passiveEnabled = enabled;
        deps.emitFrame({ type: "passive-mode", passiveEnabled: enabled });
        sendJson(res, 200, { ok: true, passiveEnabled: state.passiveEnabled });
        return;
      }

      if (method === "GET" && url === "/agent/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(":\n\n");
        state.sseClients.add(res);
        res.write(`data: ${JSON.stringify({ type: "cron-mode", cronEnabled: state.cronEnabled })}\n\n`);
        // A (re)connected client cancels any pending orphan-abort.
        if (clientGoneTimer) {
          clearTimeout(clientGoneTimer);
          clientGoneTimer = null;
        }
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
          state.sseClients.delete(res);
          if (state.sseClients.size === 0) {
            if (clientGoneTimer) clearTimeout(clientGoneTimer);
            clientGoneTimer = setTimeout(() => {
              clientGoneTimer = null;
              if (state.sseClients.size === 0) {
                // Controlling client gone + no reconnect → stop the agent loop entirely.
                state.cronEnabled = false;
                if (state.currentTurn !== null) state.currentTurn.abortController.abort();
              }
            }, CLIENT_DISCONNECT_GRACE_MS);
            clientGoneTimer.unref?.();
          }
        });
        return;
      }

      if (method === "GET" && url.startsWith("/audit/tail")) {
        const u = new URL(url, "http://localhost");
        const nParam = u.searchParams.get("n");
        const sinceParam = u.searchParams.get("since");
        const n = nParam ? Math.min(Math.max(Number.parseInt(nParam, 10) || 20, 1), 100) : 20;
        const since = sinceParam ? Number.parseInt(sinceParam, 10) : undefined;
        const rows = readAuditTail(deps.auditPath, n, since);
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
  }

  return { handleRequest };
}
