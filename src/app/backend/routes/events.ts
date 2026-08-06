import type { ServerResponse } from "node:http";
import type { ServeState } from "../context.js";

export type TimerHolder = { value: ReturnType<typeof setTimeout> | null };

export function handleGetEvents(
  state: ServeState,
  timerHolder: TimerHolder,
  res: ServerResponse,
  graceMs: number,
): void {
  // D-RUN-1 (safety, belt-and-suspenders): if the controlling UDS client (the Tauri
  // shell's SSE subscriber) disconnects and does NOT reconnect within a short grace
  // window, STOP THE AGENT so an orphaned sidecar can't keep acting on the page even if
  // the parent's kill failed — halt the cron loop (cronEnabled=false; cron.tick() early-
  // returns) AND abort any in-flight turn. The grace window tolerates the subscriber's
  // ~1s reconnect (main.rs run_sse_subscriber) so a transient blip never stops a live
  // session. Headless `mai serve` (cron, no SSE client) never connects → never triggers.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(":\n\n");
  state.sseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: "cron-mode", cronEnabled: state.cronEnabled })}\n\n`);
  // A (re)connected client cancels any pending orphan-abort.
  if (timerHolder.value) {
    clearTimeout(timerHolder.value);
    timerHolder.value = null;
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
      if (timerHolder.value) clearTimeout(timerHolder.value);
      timerHolder.value = setTimeout(() => {
        timerHolder.value = null;
        if (state.sseClients.size === 0) {
          // Controlling client gone + no reconnect → stop the agent loop entirely.
          state.cronEnabled = false;
          if (state.currentTurn !== null) state.currentTurn.abortController.abort();
        }
      }, graceMs);
      timerHolder.value.unref?.();
    }
  });
}
