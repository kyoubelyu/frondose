// P-Y2.3 — serve-side takeover wiring. The Auto-gate lives in the injected driver (returns painted-bool
// so the tool layer can skip the cursor-dwell otherwise). Ring show is Auto-gated; ring hide is ungated
// (always safe to retract). Extracted from serve.ts/turn.ts so the gating is unit-testable (T-Gate/T-Ring).
import { callInOverlay } from "../../overlay/inject.js";
import type { ServeDeps, ServeState } from "./context.js";

export function makeTakeoverVisualDriver(
  state: ServeState,
  session: ServeDeps["session"],
): (fnDeclaration: string) => boolean {
  return (fnDeclaration) => {
    const ctx = state.overlayContextId;
    const client = session.getClient();
    if (ctx === undefined || !client || !state.cronEnabled) return false; // no paint outside Auto+overlay
    void callInOverlay(client.handle, ctx, fnDeclaration);
    return true;
  };
}

export function showEdgeRing(state: ServeState, session: ServeDeps["session"]): void {
  if (!state.cronEnabled) return; // ring only in Auto
  pushOverlay(state, session, "function() { window.__frondoseShowEdgeRing(); }");
}

export function hideEdgeRing(state: ServeState, session: ServeDeps["session"]): void {
  // ungated — retract is always safe (no-op in the overlay if nothing was shown)
  pushOverlay(state, session, "function() { window.__frondoseHideEdgeRing(); window.__frondoseClearAgentTarget(); }");
}

function pushOverlay(state: ServeState, session: ServeDeps["session"], fn: string): void {
  const ctx = state.overlayContextId;
  const client = session.getClient();
  if (ctx === undefined || !client) return;
  void callInOverlay(client.handle, ctx, fn);
}
