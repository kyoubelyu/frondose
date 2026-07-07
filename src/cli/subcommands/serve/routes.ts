import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServeDeps, ServeState } from "./context.js";
import type { createOverlayDispatcher } from "./dispatch.js";
import { checkBearer, sendJson } from "./http.js";
import {
  handleAutoStart,
  handleAutoStop,
  handlePostAgentAbort,
  handlePostAgentActivate,
  handlePostAgentRetry,
  handlePostAgentTurn,
  handlePostCronMode,
  handlePostPassiveMode,
} from "./routes/agent.js";
import { handleGetAuditTail } from "./routes/audit.js";
import { handleChromeEnsure } from "./routes/cdp.js";
import { handleGetEvents, type TimerHolder } from "./routes/events.js";
import { handleHealth, handleIdentity } from "./routes/health.js";
import { handleGetSettings, handlePostSettings } from "./routes/settings.js";
import { handlePostWorkflow } from "./routes/workflow.js";
import type { createTurnRunner } from "./turn.js";

export { ensureOverlaySubscription } from "./routes/cdp.js";

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
  const timerHolder: TimerHolder = { value: null };
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
        handleHealth(res);
        return;
      }

      if (method === "GET" && url === "/identity") {
        handleIdentity(res);
        return;
      }

      if (method === "GET" && url === "/settings") {
        handleGetSettings(res);
        return;
      }

      if (method === "POST" && url === "/settings") {
        await handlePostSettings(deps, req, res);
        return;
      }

      if (method === "POST" && url === "/chrome/ensure") {
        await handleChromeEnsure(state, deps, dispatch, res);
        return;
      }

      if (method === "POST" && url === "/agent/turn") {
        await handlePostAgentTurn(state, deps, turn, req, res);
        return;
      }

      if (method === "POST" && url === "/agent/activate") {
        await handlePostAgentActivate(state, turn, req, res);
        return;
      }

      if (method === "POST" && url === "/agent/abort") {
        handlePostAgentAbort(state, res);
        return;
      }

      if (method === "POST" && url === "/agent/retry") {
        handlePostAgentRetry(state, turn, res);
        return;
      }

      if (method === "POST" && url.startsWith("/workflow/")) {
        await handlePostWorkflow(state, deps, turn, req, res, url);
        return;
      }

      if (method === "POST" && url === "/agent/cron-mode") {
        await handlePostCronMode(state, deps, req, res);
        return;
      }

      if (method === "POST" && url === "/agent/auto/start") {
        await handleAutoStart(state, deps, req, res);
        return;
      }

      if (method === "POST" && url === "/agent/auto/stop") {
        handleAutoStop(state, deps, res);
        return;
      }

      if (method === "POST" && url === "/agent/passive-mode") {
        await handlePostPassiveMode(state, deps, req, res);
        return;
      }

      if (method === "GET" && url === "/agent/events") {
        handleGetEvents(state, timerHolder, res, CLIENT_DISCONNECT_GRACE_MS);
        return;
      }

      if (method === "GET" && url.startsWith("/audit/tail")) {
        handleGetAuditTail(deps, url, res);
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
