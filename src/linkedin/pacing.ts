import type { PacingResult } from "./types.js";

/** Apply a 400-800ms jittered delay between LinkedIn interactions (audit-only output). */
export async function applyPacing(): Promise<PacingResult> {
  const baseMs = 400;
  const jitterMs = Math.floor(Math.random() * 400);
  const total = baseMs + jitterMs;
  await new Promise<void>((r) => setTimeout(r, total));
  return { waitedMs: total, jitterMs, serial: true };
}
