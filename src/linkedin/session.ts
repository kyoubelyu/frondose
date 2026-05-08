import type { CdpClient } from "../cdp/client.js";
import type { CurrentSurfaceContext, LinkedinSession } from "./types.js";

export interface CreateLinkedinSessionOpts {
  client: CdpClient;
}

/** Create a session that holds the CdpClient + caches the most-recent inspect output. */
export function createLinkedinSession(opts: CreateLinkedinSessionOpts): LinkedinSession {
  const { client } = opts;
  let lastContext: CurrentSurfaceContext | undefined;
  return {
    getClient(): CdpClient {
      return client;
    },
    setLastContext(ctx: CurrentSurfaceContext): void {
      lastContext = ctx;
    },
    getLastContext(): CurrentSurfaceContext | undefined {
      return lastContext;
    },
  };
}
