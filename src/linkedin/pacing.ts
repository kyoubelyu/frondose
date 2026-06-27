import { frondoseEnv } from "../env.js";
import type { PacingResult } from "./types.js";

/** @internal — test-only DI hook; consumers should not call. */
let _pacingFn: (() => Promise<PacingResult>) | undefined;

export function __setPacingFn(fn: (() => Promise<PacingResult>) | undefined): void {
  _pacingFn = fn;
}

/** Default inter-interaction pacing band (D-RUN-2): ~0.8–2.5 s jittered. */
export const DEFAULT_PACE_MIN_MS = 800;
export const DEFAULT_PACE_MAX_MS = 2500;

/**
 * Parse a non-negative-integer millisecond value. Returns null for absent,
 * empty, or invalid input — callers fall through to the default. Accepts "0"
 * (the disable sentinel) and no-leading-zero positives; rejects negatives,
 * decimals, exponents, and leading-zero forms. Mirrors parseMaxSteps (N-2).
 */
export function parsePaceMs(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^(0|[1-9]\d*)$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : null;
}

/**
 * Resolve the effective pacing band from env (precedence: env var > default).
 * Setting either FRONDOSE_PACE_MIN_MS or FRONDOSE_PACE_MAX_MS to 0 disables pacing.
 * A min>max misconfiguration is normalized (lo/hi swapped).
 */
export function resolvePaceBand(): { minMs: number; maxMs: number; disabled: boolean } {
  const min = parsePaceMs(frondoseEnv("PACE_MIN_MS")) ?? DEFAULT_PACE_MIN_MS;
  const max = parsePaceMs(frondoseEnv("PACE_MAX_MS")) ?? DEFAULT_PACE_MAX_MS;
  if (min <= 0 || max <= 0) return { minMs: 0, maxMs: 0, disabled: true };
  return { minMs: Math.min(min, max), maxMs: Math.max(min, max), disabled: false };
}

const DEFAULT_SERIAL_BASE_DELAY_MS = 110;
const SERIAL_JITTER_WINDOW_MS = 55;

function jitterSerialAmount(): number {
  return Math.floor(Math.random() * SERIAL_JITTER_WINDOW_MS);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Apply a jittered delay between LinkedIn/browser interactions (audit-only output).
 * Default band ~0.8–2.5 s; tunable via FRONDOSE_PACE_MIN_MS / FRONDOSE_PACE_MAX_MS; either
 * set to 0 disables pacing (waitedMs:0, no sleep). Read-only tools never call this.
 */
export async function applyPacing(): Promise<PacingResult> {
  if (_pacingFn) return _pacingFn();
  const { minMs, maxMs, disabled } = resolvePaceBand();
  if (disabled) return { waitedMs: 0, jitterMs: 0, serial: true };
  const jitterMs = Math.floor(Math.random() * (maxMs - minMs + 1));
  const total = minMs + jitterMs;
  await sleep(total);
  return { waitedMs: total, jitterMs, serial: true };
}

export async function applySerialPacing(baseDelayMs = DEFAULT_SERIAL_BASE_DELAY_MS): Promise<PacingResult> {
  const jitterMs = jitterSerialAmount();
  const waitedMs = baseDelayMs + jitterMs;
  await sleep(waitedMs);
  return { waitedMs, jitterMs, serial: true };
}

export async function applyTypingPacing(text: string): Promise<PacingResult> {
  const extraDelay = Math.min(Math.max(text.length * 8, 20), 220);
  return applySerialPacing(DEFAULT_SERIAL_BASE_DELAY_MS + extraDelay);
}
