/**
 * P-9 mock tests — T-Retry.1..T-Retry.8
 *
 * Tests for withRetry() and IDEMPOTENT_TOOLS from src/agent/retryWrapper.ts.
 *
 * T-Retry.1 — idempotent throws twice then succeeds → 3 calls, result returned
 * T-Retry.2 — non-wrapped tool throws → 1 call, re-throws (pass-through)
 * T-Retry.3 — withRetry exhausts maxAttempts → re-throws last error
 * T-Retry.4 — error envelope (ok:false) NOT retried (returned, not thrown)
 * T-Retry.5 — IDEMPOTENT_TOOLS set membership: 16 members; analyze_screenshot absent
 * T-Retry.6 — IDEMPOTENT_TOOLS set membership: all 16 expected names present
 * T-Retry.7 — tool with no execute returns unchanged (guard)
 * T-Retry.8 — withRetry preserves tool.description and tool.parameters
 *
 * Gate coverage: G-P9.1 (retry semantics)
 *
 * No LLM, no Chrome, no filesystem. Backoff set to 1ms for speed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoreMessage, ToolExecutionOptions } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { IDEMPOTENT_TOOLS, withRetry } from "../../src/agent/retryWrapper.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Minimal ToolExecutionOptions for test invocations. */
const FAKE_OPTS: ToolExecutionOptions = {
  toolCallId: "test-call-1",
  messages: [] as CoreMessage[],
};

/** Build a minimal Vercel tool with a spy execute. */
function makeTool(executeFn: (args: { msg: string }) => Promise<unknown>) {
  return tool({
    description: "test tool",
    parameters: z.object({ msg: z.string() }),
    execute: executeFn,
  });
}

// ─── T-Retry.1: throws twice, then succeeds ───────────────────────────────────

test("T-Retry.1: idempotent tool throws twice then succeeds → 3 total calls, returns result", async () => {
  let callCount = 0;
  const base = makeTool(async () => {
    callCount++;
    if (callCount < 3) throw new Error(`transient failure attempt ${callCount}`);
    return { ok: true, command: "test", data: { value: "success" } };
  });

  const wrapped = withRetry(base, { maxAttempts: 3, backoffMs: 1 });
  const result = await wrapped.execute?.({ msg: "go" }, FAKE_OPTS);

  assert.equal(callCount, 3, "execute must be called exactly 3 times");
  assert.deepEqual(result, { ok: true, command: "test", data: { value: "success" } });
});

// ─── T-Retry.2: non-wrapped tool throws → 1 call, re-throws ──────────────────

test("T-Retry.2: non-wrapped tool throws → 1 call, error propagates directly", async () => {
  let callCount = 0;
  const base = makeTool(async () => {
    callCount++;
    throw new Error("persistent failure");
  });

  // Do NOT wrap with withRetry
  await assert.rejects(() => base.execute?.({ msg: "go" }, FAKE_OPTS), /persistent failure/, "error should propagate");
  assert.equal(callCount, 1, "non-wrapped tool: only 1 call");
});

// ─── T-Retry.3: exhausts maxAttempts → re-throws last error ─────────────────

test("T-Retry.3: withRetry exhausts maxAttempts → re-throws last error", async () => {
  let callCount = 0;
  const errors: string[] = [];
  const base = makeTool(async () => {
    callCount++;
    const msg = `error attempt ${callCount}`;
    errors.push(msg);
    throw new Error(msg);
  });

  const wrapped = withRetry(base, { maxAttempts: 3, backoffMs: 1 });
  await assert.rejects(
    () => wrapped.execute?.({ msg: "go" }, FAKE_OPTS),
    /error attempt 3/,
    "must re-throw last error after exhausting maxAttempts",
  );
  assert.equal(callCount, 3, "must attempt exactly maxAttempts=3 times");
});

// ─── T-Retry.4: error envelope NOT retried (returned, not thrown) ────────────

test("T-Retry.4: error envelope (ok:false) is NOT retried — it is returned, not thrown", async () => {
  let callCount = 0;
  const base = makeTool(async () => {
    callCount++;
    // Return an error envelope — not a throw
    return { ok: false, command: "test", error: { kind: "runtime_error", message: "tool found a problem" } };
  });

  const wrapped = withRetry(base, { maxAttempts: 3, backoffMs: 1 });
  const result = (await wrapped.execute?.({ msg: "go" }, FAKE_OPTS)) as {
    ok: boolean;
    error: { message: string };
  };

  assert.equal(callCount, 1, "error envelope is returned not thrown; must only be called once");
  assert.equal(result.ok, false, "must return the error envelope unchanged");
  assert.equal(result.error.message, "tool found a problem");
});

// ─── T-Retry.5: IDEMPOTENT_TOOLS count ───────────────────────────────────────

test("T-Retry.5: IDEMPOTENT_TOOLS has exactly 16 members (11 existing + web_fetch + web_search + query_lead_globally + navigate_to_url + clear_cookies)", () => {
  // P-26: +query_lead_globally (14). P-28.5: +navigate_to_url +clear_cookies (16).
  assert.equal(
    IDEMPOTENT_TOOLS.size,
    16,
    `expected 16, got ${IDEMPOTENT_TOOLS.size}: ${[...IDEMPOTENT_TOOLS].join(", ")}`,
  );

  // analyze_screenshot MUST NOT be in the set (D-13: vision-token cost per call)
  assert.ok(
    !IDEMPOTENT_TOOLS.has("analyze_screenshot"),
    "analyze_screenshot must NOT be in IDEMPOTENT_TOOLS (D-13 vision-token cost)",
  );

  // Non-idempotent tools MUST NOT be in the set
  const nonIdempotent = [
    "remember",
    "click",
    "type",
    "upload",
    "telegram_notify",
    "gh_issue",
    "stop",
    "escalate_for_capability",
  ];
  for (const name of nonIdempotent) {
    assert.ok(!IDEMPOTENT_TOOLS.has(name), `'${name}' must NOT be in IDEMPOTENT_TOOLS (side-effect risk)`);
  }
});

// ─── T-Retry.6: IDEMPOTENT_TOOLS exact membership ────────────────────────────

test("T-Retry.6: IDEMPOTENT_TOOLS contains all expected idempotent tool names", () => {
  // P-44: updated from 13 to 16 (adding query_lead_globally from P-26, navigate_to_url + clear_cookies from P-28.5)
  const expected = [
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
    "web_fetch",
    "web_search",
    "query_lead_globally",
    "navigate_to_url",
    "clear_cookies",
  ];

  for (const name of expected) {
    assert.ok(IDEMPOTENT_TOOLS.has(name), `'${name}' must be in IDEMPOTENT_TOOLS per scout F-1 / D-13`);
  }
});

// ─── T-Retry.7: tool with no execute returns unchanged ───────────────────────

test("T-Retry.7: withRetry on tool with no execute returns tool unchanged", () => {
  // Vercel tools always have execute, but the guard must not crash
  const bare = {
    description: "bare tool",
    parameters: z.object({}),
    execute: undefined,
  } as unknown as ReturnType<typeof makeTool>;

  const wrapped = withRetry(bare, { maxAttempts: 3, backoffMs: 1 });
  assert.equal(wrapped, bare, "tool with no execute must be returned as-is");
});

// ─── T-Retry.8: withRetry preserves description and parameters ───────────────

test("T-Retry.8: withRetry preserves tool.description and tool.parameters unchanged", async () => {
  const base = makeTool(async () => ({ ok: true, command: "t", data: {} }));
  const wrapped = withRetry(base, { maxAttempts: 2, backoffMs: 1 });

  assert.equal(wrapped.description, base.description, "description must be preserved");
  assert.equal(wrapped.parameters, base.parameters, "parameters must be the same Zod schema object");
  assert.notEqual(wrapped.execute, base.execute, "execute must be a NEW function (the retry wrapper)");
});
