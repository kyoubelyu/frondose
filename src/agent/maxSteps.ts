import { frondoseEnv } from "../env.js";

/**
 * P-46 D-1 / D-1b: agent-loop step-budget default + resolver.
 *
 * The step budget bounds the number of LLM round-trips (tool-call steps) in a
 * single agent turn. It is NOT a safety valve — the `stop` tool + `abortSignal`
 * are the real operational bounds; the budget is a cost/runaway guardrail.
 */

/** Default agent-loop step budget. Raised 10 → 200 in P-46 (D-1). */
export const DEFAULT_MAX_STEPS = 200;

/**
 * Parse a positive-integer step count. Returns null for absent, empty, or
 * invalid input — callers fall through to the next precedence source.
 *
 * N-2: accepts ONLY a plain positive-integer decimal — no sign, no leading
 * zero, no decimal point, no exponent notation. Strings like "1e3", "0",
 * "-5", "3.5", "007", and "" are all rejected.
 */
export function parseMaxSteps(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const n = Number(trimmed);
  // Guards an absurdly long digit string that overflows to Infinity.
  return Number.isInteger(n) ? n : null;
}

/**
 * Resolve the effective step budget.
 * Precedence: CLI flag > MAI_MAX_STEPS env var > DEFAULT_MAX_STEPS.
 */
export function resolveMaxSteps(cliFlag?: string): number {
  return parseMaxSteps(cliFlag) ?? parseMaxSteps(frondoseEnv("MAX_STEPS")) ?? DEFAULT_MAX_STEPS;
}

/**
 * P-AUTO-12 part (a): default cron-tick step budget.
 * Mirrors the Magical/passive tighter cap (passive.ts:205 maxSteps=20) but
 * is 2x larger because cron turns are outbound-capable (a productive
 * lead-advancement cycle is ~10-15 steps + retries).
 * Cron-only — operator/Magical/resume turns continue to use DEFAULT_MAX_STEPS.
 */
export const DEFAULT_CRON_MAX_STEPS = 40;

/**
 * Resolve the cron step budget.
 * Precedence: FRONDOSE_CRON_MAX_STEPS env (back-compat MAI_CRON_MAX_STEPS
 * via src/env.ts:12) > DEFAULT_CRON_MAX_STEPS. Reuses parseMaxSteps so
 * invalid input (`"0"`, `"-5"`, `"abc"`, `""`, `"1.5"`) falls through to
 * the default — never a silent zero.
 */
export function resolveCronMaxSteps(): number {
  return parseMaxSteps(frondoseEnv("CRON_MAX_STEPS")) ?? DEFAULT_CRON_MAX_STEPS;
}

/**
 * P-AUTO-12 part (b): default no-progress cap. Consecutive cron ticks
 * against the same running auto_run that fail to advance ANY of the four
 * durable-funnel-progress signals (outbound ledger / lead_timeline /
 * message_drafts / raw_candidates.last_seen_at) AND were not
 * inter-outbound cooldown waits. After this many such ticks the cron
 * post-handler closes the run as stopped_by_agent.
 *
 * 10 is a STUCK-run breaker, not a front-funnel timeout. With a productive
 * tick advancing any signal, the counter resets. With the run waiting out
 * cooldown, the counter HOLDS (neither increments nor resets).
 */
export const DEFAULT_CRON_NOPROGRESS_LIMIT = 10;

export function resolveCronNoProgressLimit(): number {
  return parseMaxSteps(frondoseEnv("CRON_NOPROGRESS_LIMIT")) ?? DEFAULT_CRON_NOPROGRESS_LIMIT;
}
