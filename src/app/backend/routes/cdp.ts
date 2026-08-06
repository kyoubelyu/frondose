import type { ServerResponse } from "node:http";
import type { CdpClient } from "../../../cdp/client.js";
import { attachEventBus, type OverlayEvent } from "../../../overlay/eventBus.js";
import { subscribeContextId } from "../../../overlay/inject.js";
import type { ServeDeps, ServeState } from "../context.js";
import type { createOverlayDispatcher } from "../dispatch.js";
import { sendJson } from "../http.js";
import { showEdgeRing } from "../takeover.js";

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

export async function handleChromeEnsure(
  state: ServeState,
  deps: ServeDeps,
  dispatch: ReturnType<typeof createOverlayDispatcher>,
  res: ServerResponse,
): Promise<void> {
  const result = await deps.session.getOrInitClient();
  if (result.ok === false) {
    sendJson(res, 503, { ok: false, error: result.error, message: result.message });
    return;
  }
  await ensureOverlaySubscription(state, deps, dispatch.dispatchOverlayEvent, result.client);
  sendJson(res, 200, { ok: true, chromePort: 9222, overlayInstalled: true });
}

export const handlePostChromeEnsure = handleChromeEnsure;
