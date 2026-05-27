import { CdpClient } from "../cdp/client.js";
import { resolveInputMode } from "../cdp/hardwareInput.js";
import { ensureChrome, injectStealth } from "../cdp/index.js";
import { STEALTH_INIT_SCRIPT } from "../cdp/stealth.js";
import { appendOverlayEventRow, attachEventBus } from "../overlay/eventBus.js";
import { installOverlay } from "../overlay/inject.js";
import type { ClientOrUnavailable, CurrentSurfaceContext, LinkedinSession } from "./types.js";

declare module "./types.js" {
  interface LinkedinSession {
    /** P-SP-E: optional auto-run state probe for cap-aware click guard.
     *  Returns the current running auto_runs row (with maxConnects) and current
     *  ledger count for connect_sent. Undefined when serve wiring not applied. */
    autoRun?: () => { runId: string; maxConnects: number | null; connectSentCount: number } | null;
  }
}

const VISUAL_DWELL_MS = 500; // P-Y2.3 (OQ-Y2.3.6): pre-click cursor-travel dwell so the operator sees the
// cursor land + highlight before the click. 400–600ms range; builder may tune
// at the live gate. Applied ONLY when the driver actually painted (Auto mode).

export interface CreateLinkedinSessionOpts {
  port: number;
  profileDir: string;
  /** P-32: requested input mode. Resolved once via `resolveInputMode` (graceful
   *  downgrade to "cdp" if the native addon / Accessibility grant is absent). */
  inputMode?: "cdp" | "hardware";
  /**
   * P-23 §6.5: daemon-mode Chrome guard. When provided and returns false at
   * the moment of a getOrInitClient() call, the session returns a
   * `{ok:false, error:"chrome_unavailable"}` sentinel instead of booting
   * Chrome. Default (undefined) preserves existing REPL behavior.
   */
  chromeAcquireGuard?: () => boolean;
  /**
   * P-Y4 (ask d): post-boot hook invoked ONCE inside getOrInitClient — after Chrome
   * boots + stealth + overlay install, before the client is returned. serve wires this
   * to ensureOverlaySubscription so an AGENT-DRIVEN lazy boot (no operator "Start" click)
   * still captures overlayContextId + attaches the overlay-event dispatcher — wiring that
   * used to live ONLY in POST /chrome/ensure. Best-effort: a failure here is logged and
   * swallowed so it never breaks the browser tool that triggered the boot.
   */
  onClientBooted?: (client: CdpClient) => void | Promise<void>;
}

/** [P-62 OQ-5] Subscribe to Target.targetCreated; on each new `page` target, attach with
 *  flat sessions and register STEALTH_INIT_SCRIPT on that sub-session. Best-effort: any
 *  failure is logged + does NOT throw (a single popup's stealth miss is not boot-fatal).
 *  The primary `client` retains its full CdpClient + stealthInjected flag (the new-target
 *  sub-session is NOT a CdpClient — it's a flat-session sub-channel for script registration).
 *  NOT exported. */
async function registerTargetCreatedAutoInject(client: CdpClient): Promise<void> {
  try {
    await client.handle.Target.setDiscoverTargets({ discover: true });
  } catch (e) {
    console.error("[mai] Target.setDiscoverTargets failed (OQ-5):", e);
    return;
  }
  client.handle.on(
    "Target.targetCreated",
    async (params: { targetInfo: { type: string; targetId: string; url?: string } }) => {
      if (params.targetInfo.type !== "page") return;
      try {
        // BUILDER-VERIFY (4b): chrome-remote-interface 0.34.0 exposes flat sessions via
        // client.send(method, params, sessionId, callback), so use handle.send(..., sessionId).
        const { sessionId } = await client.handle.Target.attachToTarget({
          targetId: params.targetInfo.targetId,
          flatten: true,
        });
        await client.handle.send(
          "Page.addScriptToEvaluateOnNewDocument",
          { source: STEALTH_INIT_SCRIPT, runImmediately: true },
          sessionId,
        );
      } catch (e) {
        console.error(`[mai] OQ-5 auto-inject failed for target ${params.targetInfo.targetId}:`, e);
      }
    },
  );
}

/**
 * Build a LinkedinSession that lazy-boots Chrome on the first getOrInitClient()
 * call. Promise-deduplicates concurrent calls. Failed boots reset pending so
 * retries are possible on subsequent invocations.
 *
 * The factory itself does NOT touch Chrome — it only captures launch options.
 * Chrome boots when the first LinkedIn tool calls session.getOrInitClient()
 * inside its execute callback.
 */
export function createLinkedinSession(opts: CreateLinkedinSessionOpts): LinkedinSession {
  let cached: CdpClient | undefined;
  let initPromise: Promise<CdpClient> | undefined;
  let lastContext: CurrentSurfaceContext | undefined;
  let visualDriver: ((fnDeclaration: string) => boolean) | undefined;

  // P-32: resolve the effective input mode ONCE at session creation
  // (graceful downgrade to "cdp" — D-4).
  const inputMode = resolveInputMode(opts.inputMode ?? "cdp");

  return {
    inputMode,

    async getOrInitClient(): Promise<ClientOrUnavailable> {
      // P-23 §6.5: refuse Chrome boot when daemon's guard denies ownership.
      if (opts.chromeAcquireGuard && !opts.chromeAcquireGuard()) {
        return {
          ok: false,
          error: "chrome_unavailable",
          message: "REPL holds Chrome lock — daemon must yield",
        };
      }
      if (cached?.isConnected()) return { ok: true, client: cached };
      if (!cached?.isConnected()) cached = undefined;
      if (initPromise) return { ok: true, client: await initPromise };
      const bootPromise = (async (): Promise<CdpClient> => {
        const handle = await ensureChrome(opts);
        // P-37 B7: a freshly-launched Chrome's new-tab page is still initializing
        // its JS runtime — navigate() too soon → ERR_CONNECTION_CLOSED. A 300 ms
        // settle absorbs it. Only on fresh launch (launched:false → Chrome already
        // up → zero delay on every subsequent session).
        if (handle.launched) {
          await new Promise((r) => setTimeout(r, 300));
        }
        // CdpClient.connect uses waitForPageTarget under the hood (v0.3-fix1 B1 fix).
        const client = await CdpClient.connect(handle.port);
        await injectStealth(client);
        // [P-62 OQ-5] Auto-inject stealth on EVERY new page target (popups, OAuth windows, new
        // tabs). Without this, addScriptToEvaluateOnNewDocument's per-target/per-session scope
        // leaves new targets unprotected. Minimal: only `page`-type targets; iframes / workers
        // are skipped (out of scope per source §6).
        await registerTargetCreatedAutoInject(client);
        // P-55 M-0 overlay spike — throwaway
        await installOverlay(client.handle);
        attachEventBus(client.handle, appendOverlayEventRow);
        if (opts.onClientBooted) {
          try {
            await opts.onClientBooted(client);
          } catch (err) {
            // Best-effort overlay wiring: a subscribe failure must NOT break the browser
            // tool that triggered this boot. POST /chrome/ensure remains a manual re-trigger.
            console.error("[mai] onClientBooted hook failed:", err);
          }
        }
        return client;
      })();
      // Cache-on-success + clear-pending-on-either, via the two-arm then() pattern.
      // NOT .finally — that would race with the cached = client assignment timing
      // for callers that resolve before our success branch runs.
      initPromise = bootPromise.then(
        (client) => {
          cached = client;
          initPromise = undefined;
          return client;
        },
        (err) => {
          initPromise = undefined;
          throw err;
        },
      );
      const client = await initPromise;
      return { ok: true, client };
    },

    getClient(): CdpClient | undefined {
      return cached;
    },

    setLastContext(ctx: CurrentSurfaceContext): void {
      lastContext = ctx;
    },

    getLastContext(): CurrentSurfaceContext | undefined {
      return lastContext;
    },

    setVisualDriver(driver: (fnDeclaration: string) => boolean): void {
      visualDriver = driver;
    },

    async showAgentTarget(box: { x: number; y: number; w: number; h: number }, label: string): Promise<void> {
      if (!visualDriver) return;
      const payload = JSON.stringify({ box, label });
      const painted = visualDriver(`function() { window.__maiShowAgentTarget(${JSON.stringify(payload)}); }`);
      if (painted) await new Promise((r) => setTimeout(r, VISUAL_DWELL_MS));
    },

    clearAgentTarget(): void {
      if (!visualDriver) return;
      visualDriver("function() { window.__maiClearAgentTarget(); }");
    },

    /** P-18 D-2: Probe cached CDP connection health via Runtime.evaluate("1").
     *  Returns true if healthy (or no cached client to check).
     *  On failure, clears the stale cache so next tool call triggers reconnect. */
    async heartbeat(): Promise<boolean> {
      const client = cached;
      if (!client) return true;
      try {
        await client.evaluate("1");
        return true;
      } catch {
        cached = undefined;
        return false;
      }
    },
  };
}
