import type { Tool } from "ai";

/**
 * P-9 D-1: idempotent tool classification. Centralized lookup table; per-tool
 * declarative `retryPolicy` field rejected (operator decision).
 *
 * Source: scout F-1 idempotency analysis (docs/phase-9-research.md §351-381).
 * Update this set when adding new tools or after operator's empirical retry experience.
 */
export const IDEMPOTENT_TOOLS: ReadonlySet<string> = new Set([
  "echo",
  "getMemory",
  "getIdentity",
  "qualify_profile",
  "launch",
  "inspect",
  "scroll",
  "screenshot",
  "reload",
  "close",
  "sleep",
  "web_fetch", // P-9 D-13: GET-style; idempotent
  "web_search", // P-9 D-13: GET/POST search query; idempotent at protocol level
  // analyze_screenshot is NOT idempotent for retry purposes (D-13: vision-token cost on each call)
  // P-26: query_lead_globally is read-only ⇒ safe to retry. publish_event is
  // fire-and-forget write ⇒ NOT idempotent (retry would double-event).
  "query_lead_globally",
]);

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, backoffMs: 1000 };

/**
 * Wrap a Vercel tool's execute with retry-on-throw. Error envelopes (ok:false)
 * are NOT retried — those mean "tool ran, found a problem"; LLM observes and
 * decides. Only THROWS (network/CDP timeout, sqlite-locked, kernel error)
 * are caught and retried.
 */
export function withRetry<T extends Tool>(t: T, policy: RetryPolicy = DEFAULT_RETRY_POLICY): T {
  const original = t.execute;
  if (!original) return t;
  const wrapped: typeof original = async (args, opts) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      try {
        return await original(args, opts);
      } catch (e) {
        lastErr = e;
        if (attempt === policy.maxAttempts) break;
        await new Promise((resolve) => setTimeout(resolve, policy.backoffMs));
      }
    }
    throw lastErr;
  };
  return { ...t, execute: wrapped } as T;
}
