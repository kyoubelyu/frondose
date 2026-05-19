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
  return parseMaxSteps(cliFlag) ?? parseMaxSteps(process.env.MAI_MAX_STEPS) ?? DEFAULT_MAX_STEPS;
}
