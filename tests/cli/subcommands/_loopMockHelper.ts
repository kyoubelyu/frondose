/**
 * Shared loop.js mock helper for tests that use mock.module to stub runAgentLoop.
 *
 * Why this helper exists (P-PI cutover follow-up): after the Pi cutover (bea6023),
 * src/agent/loop.ts is a thin delegate that imports src/agent/pi/loop.ts, which in
 * turn re-imports 5 named exports back from loop.ts (STALL_STEP_THRESHOLD +
 * 4 retry-detector helpers). A mock.module on loop.js that only provides
 * runAgentLoop will fail the chain with "does not provide an export named
 * 'STALL_STEP_THRESHOLD'" and every test cancels before its body runs.
 *
 * This helper returns the full set of loop.ts named exports so the caller can
 * spread them into mock.module(...).namedExports along with its own runAgentLoop
 * stub. Stubs are safe defaults — they're never reached by tests whose
 * runAgentLoop sleep-stubs short-circuit message iteration.
 */
import type { CoreMessage } from "ai";

export function piLoopTransitiveStubs() {
  return {
    STALL_STEP_THRESHOLD: 4,
    lastAssistantMessageHasNoToolCalls: (_messages: CoreMessage[]): boolean => false,
    lastAssistantMessageMissedExecute: (_messages: CoreMessage[]): boolean => false,
    narrationContinueMessage: (): CoreMessage => ({ role: "user", content: "" }),
    stalledContinueMessage: (): CoreMessage => ({ role: "user", content: "" }),
  };
}
