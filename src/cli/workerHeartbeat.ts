/** P-26: background heartbeat loop for workers.
 *  Sends POST /api/heartbeat every 60s; calls recordHeartbeatSuccess() on 200.
 *  Recursive setTimeout (not setInterval) so a slow request doesn't pile up.
 *  Silent on network failure — safe-mode state is what surfaces the outage. */
import os from "node:os";
import { recordHeartbeatSuccess } from "../persistence/safeModeState.js";
import type { ServerCoords } from "../tools/server/queryLeadGlobally.js";

export const HEARTBEAT_INTERVAL_MS = 60_000;

export function startWorkerHeartbeat(serverCoords: ServerCoords, abortSignal: AbortSignal): void {
  const sendOne = async (): Promise<void> => {
    if (abortSignal.aborted) return;
    try {
      const res = await fetch(`${serverCoords.serverUrl}/api/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serverCoords.token}`,
        },
        body: JSON.stringify({ workerId: serverCoords.workerId, hostname: os.hostname() }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) recordHeartbeatSuccess();
    } catch {
      // Network failure — silent; safe-mode activates after 2-min threshold.
    }
    if (!abortSignal.aborted) setTimeout(sendOne, HEARTBEAT_INTERVAL_MS);
  };
  // First call immediate (operator shouldn't wait 60s at boot to see fleet health).
  setTimeout(sendOne, 0);
}
