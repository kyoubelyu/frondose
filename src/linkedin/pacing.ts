import type { PacingResult } from "./types.js";

/** @internal — test-only DI hook; consumers should not call. */
let _pacingFn: (() => Promise<PacingResult>) | undefined;

export function __setPacingFn(fn: (() => Promise<PacingResult>) | undefined): void {
  _pacingFn = fn;
}

/** Apply a 400-800ms jittered delay between LinkedIn interactions (audit-only output). */
export async function applyPacing(): Promise<PacingResult> {
  if (_pacingFn) return _pacingFn();
  const baseMs = 400;
  const jitterMs = Math.floor(Math.random() * 400);
  const total = baseMs + jitterMs;
  await new Promise<void>((r) => setTimeout(r, total));
  return { waitedMs: total, jitterMs, serial: true };
}
