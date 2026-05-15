/** P-26: module-level state for safe-mode + heartbeat tracking.
 *  Lives in persistence/ to avoid CLI→tools import direction violation
 *  (scout §10.3 verified — tools already import persistence safely).
 *
 *  Safe-mode activates when:
 *    - `configuredServerUrl !== null` (worker is part of a fleet) AND
 *    - `Date.now() - lastSuccessfulHeartbeatMs > SAFE_MODE_TIMEOUT_MS` (2 min).
 *  Standalone workers (`configuredServerUrl === null`) never enter safe-mode.
 */

let lastSuccessfulHeartbeatMs = 0;
let configuredServerUrl: string | null = null;
const SAFE_MODE_TIMEOUT_MS = 2 * 60 * 1000;

export function setSafeModeServerUrl(url: string | null): void {
  configuredServerUrl = url;
}

export function recordHeartbeatSuccess(): void {
  lastSuccessfulHeartbeatMs = Date.now();
}

export function getLastHeartbeatMs(): number {
  return lastSuccessfulHeartbeatMs;
}

export function isSafeMode(): boolean {
  if (configuredServerUrl === null) return false;
  return Date.now() - lastSuccessfulHeartbeatMs > SAFE_MODE_TIMEOUT_MS;
}

/** TEST-ONLY reset hook. */
export function __resetSafeModeState(): void {
  lastSuccessfulHeartbeatMs = 0;
  configuredServerUrl = null;
}
