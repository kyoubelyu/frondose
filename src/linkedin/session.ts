import { CdpClient } from "../cdp/client.js";
import { resolveInputMode } from "../cdp/hardwareInput.js";
import { ensureChrome, injectStealth } from "../cdp/index.js";
import { appendOverlayEventRow, attachEventBus } from "../overlay/eventBus.js";
import { installOverlay } from "../overlay/inject.js";
import type { ClientOrUnavailable, CurrentSurfaceContext, LinkedinSession } from "./types.js";

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
        await injectStealth(client.handle);
        // P-55 M-0 overlay spike — throwaway
        await installOverlay(client.handle);
        attachEventBus(client.handle, appendOverlayEventRow);
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
