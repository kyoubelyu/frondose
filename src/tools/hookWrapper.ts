import type { Tool } from "ai";
// Type-only import — NO runtime child_process / spawn references in this file.
// Lint-enforced under src/tools/** per biome.json overrides (scout V-6).
import type { HookRunner } from "../agent/hooks.js";
import { fail } from "../linkedin/envelope.js";

/**
 * P-9 D-2 / D-11: wrap a Vercel tool with PreToolUse-then-execute-then-PostToolUse
 * hook firing. Outer of withRetry (D-11): hooks gate / observe at the LLM-call
 * layer; retry is invisible to hooks.
 *
 * On PreToolUse BLOCK (D-3): returns a fail envelope to the LLM; tool execute
 * NOT called. On execute throw: re-throws to Vercel SDK; PostToolUse SKIPPED
 * (D-2 success-only). On execute success: PostToolUse fires before returning.
 */
export function wrapWithHooks<T extends Tool>(t: T, hookRunner: HookRunner, toolName: string): T {
  const original = t.execute;
  if (!original) return t;
  const wrapped: typeof original = async (args, opts) => {
    const toolCallId = opts?.toolCallId ?? "unknown";
    const pre = await hookRunner.runPreToolUse(toolName, args, toolCallId);
    if (pre.blocked) {
      return fail(toolName, "runtime_error", pre.message ?? `Blocked by PreToolUse hook for '${toolName}'.`);
    }
    const result = await original(args, opts);
    // D-2: success-only PostToolUse. Throws have already escaped via the await above.
    await hookRunner.runPostToolUse(toolName, args, result, toolCallId);
    return result;
  };
  return { ...t, execute: wrapped } as T;
}
