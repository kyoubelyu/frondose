import { CdpClient } from "../cdp/client.js";
import { ensureChrome, injectStealth } from "../cdp/index.js";
import type { CurrentSurfaceContext, LinkedinSession } from "./types.js";

export interface CreateLinkedinSessionOpts {
  port: number;
  profileDir: string;
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

  return {
    getOrInitClient(): Promise<CdpClient> {
      if (cached && cached.isConnected()) return Promise.resolve(cached);
      if (!cached?.isConnected()) cached = undefined;
      if (initPromise) return initPromise;
      const bootPromise = (async (): Promise<CdpClient> => {
        const handle = await ensureChrome(opts);
        // CdpClient.connect uses waitForPageTarget under the hood (v0.3-fix1 B1 fix).
        const client = await CdpClient.connect(handle.port);
        await injectStealth(client.handle);
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
      return initPromise;
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
  };
}
