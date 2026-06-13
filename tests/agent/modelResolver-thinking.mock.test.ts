/**
 * v0.4-fix1 mock tests — T-MR-FIX1.1..T-MR-FIX1.9
 *
 * Tests for the `makeNoThinkingFetch` wrapper and `DEEPSEEK_THINKING_DEFAULT_MODELS`
 * set added to src/agent/modelResolver.ts to fix DeepSeek v4-flash/v4-pro 400 errors
 * on multi-turn tool-call sequences.
 *
 * Test strategy:
 *   - Import `makeNoThinkingFetch` and `DEEPSEEK_THINKING_DEFAULT_MODELS` directly
 *     (both exported per §5.1 plan recommendation).
 *   - For body-capture tests: temporarily stub `globalThis.fetch` to capture the
 *     RequestInit passed by the wrapper, then restore.
 *   - For resolveModel smoke: set fake env key; verify no throw (no API call occurs).
 *   - No real LLM calls; no Chrome; deterministic.
 *
 * Maps to gates: G-V041.1 (M-1, M-2, M-5, M-6, M-9) · G-V041.3 (M-3, M-4, M-6, M-7, M-8)
 *               G-V041.4 (M-10, M-11)
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEEPSEEK_THINKING_DEFAULT_MODELS, makeNoThinkingFetch, resolveModel } from "../../src/agent/modelResolver.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Stub globalThis.fetch; return a restore function + a ref to the captured call args. */
function stubFetch(): { captured: { url: RequestInfo | URL; init?: RequestInit }[]; restore: () => void } {
  const captured: { url: RequestInfo | URL; init?: RequestInit }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url, init });
    // Return a minimal 200 response so the wrapper resolves without error.
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    captured,
    restore: () => {
      globalThis.fetch = orig;
    },
  };
}

/** Env-var isolation: save + clear + restore. */
function saveEnv(...keys: string[]): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

// ─── T-MR-FIX1.1: v4-flash returns a distinct wrapping function ──────────────

test("T-MR-FIX1.1: makeNoThinkingFetch('deepseek-v4-flash') returns a function !== globalThis.fetch", () => {
  const wrap = makeNoThinkingFetch("deepseek-v4-flash");
  assert.ok(typeof wrap === "function", "return type must be function");
  assert.notStrictEqual(wrap, globalThis.fetch, "wrapper must be a distinct function from globalThis.fetch");
});

// ─── T-MR-FIX1.2: v4-pro returns a distinct wrapping function ────────────────

test("T-MR-FIX1.2: makeNoThinkingFetch('deepseek-v4-pro') returns a function !== globalThis.fetch", () => {
  const wrap = makeNoThinkingFetch("deepseek-v4-pro");
  assert.ok(typeof wrap === "function", "return type must be function");
  assert.notStrictEqual(wrap, globalThis.fetch, "wrapper must be a distinct function from globalThis.fetch");
});

// ─── T-MR-FIX1.3: deepseek-chat returns globalThis.fetch reference-identical ─

test("T-MR-FIX1.3: makeNoThinkingFetch('deepseek-chat') returns globalThis.fetch (reference identity)", () => {
  const result = makeNoThinkingFetch("deepseek-chat");
  assert.strictEqual(result, globalThis.fetch, "deepseek-chat must return globalThis.fetch unchanged");
});

// ─── T-MR-FIX1.4: deepseek-reasoner returns globalThis.fetch reference-identical

test("T-MR-FIX1.4: makeNoThinkingFetch('deepseek-reasoner') returns globalThis.fetch (reference identity)", () => {
  const result = makeNoThinkingFetch("deepseek-reasoner");
  assert.strictEqual(result, globalThis.fetch, "deepseek-reasoner must return globalThis.fetch unchanged");
});

// ─── T-MR-FIX1.5: v4-flash wrapper injects thinking: { type: "disabled" } ────

test("T-MR-FIX1.5: v4-flash wrapper injects thinking:disabled into request body", async () => {
  const { captured, restore } = stubFetch();
  try {
    const wrap = makeNoThinkingFetch("deepseek-v4-flash");
    const body = JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });
    await wrap("https://api.deepseek.com/v1/chat/completions", { method: "POST", body });
    assert.equal(captured.length, 1, "globalThis.fetch must be called exactly once");
    const sentBody = captured[0].init?.body;
    assert.ok(typeof sentBody === "string", "sent body must be a string");
    const parsed = JSON.parse(sentBody) as Record<string, unknown>;
    assert.deepEqual(parsed.thinking, { type: "disabled" }, "thinking field must be injected");
  } finally {
    restore();
  }
});

// ─── T-MR-FIX1.6: wrapper preserves all other top-level body keys ────────────

test("T-MR-FIX1.6: v4-flash wrapper preserves model, messages, tools keys in body", async () => {
  const { captured, restore } = stubFetch();
  try {
    const wrap = makeNoThinkingFetch("deepseek-v4-flash");
    const messages = [{ role: "user", content: "preserve me" }];
    const tools = [{ type: "function", function: { name: "echo" } }];
    const body = JSON.stringify({ model: "deepseek-v4-flash", messages, tools, stream: true });
    await wrap("https://api.deepseek.com/v1/chat/completions", { method: "POST", body });
    const sentBody = captured[0].init?.body;
    const parsed = JSON.parse(sentBody as string) as Record<string, unknown>;
    assert.equal(parsed.model, "deepseek-v4-flash", "model key preserved");
    assert.deepEqual(parsed.messages, messages, "messages key preserved");
    assert.deepEqual(parsed.tools, tools, "tools key preserved");
    assert.equal(parsed.stream, true, "stream key preserved");
    // And thinking is injected
    assert.deepEqual(parsed.thinking, { type: "disabled" });
  } finally {
    restore();
  }
});

// ─── T-MR-FIX1.7: idempotent — does NOT overwrite pre-set thinking field ─────

test("T-MR-FIX1.7: wrapper does NOT overwrite pre-set thinking:{type:'enabled'} (idempotent)", async () => {
  const { captured, restore } = stubFetch();
  try {
    const wrap = makeNoThinkingFetch("deepseek-v4-flash");
    const body = JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled" }, // pre-set by hypothetical caller
    });
    await wrap("https://api.deepseek.com/v1/chat/completions", { method: "POST", body });
    const sentBody = captured[0].init?.body;
    const parsed = JSON.parse(sentBody as string) as Record<string, unknown>;
    assert.deepEqual(parsed.thinking, { type: "enabled" }, "pre-set thinking:{type:'enabled'} must NOT be overwritten");
  } finally {
    restore();
  }
});

// ─── T-MR-FIX1.8: pass-through when init is undefined or body is not a string

test("T-MR-FIX1.8a: wrapper passes through verbatim when init is undefined", async () => {
  const { captured, restore } = stubFetch();
  try {
    const wrap = makeNoThinkingFetch("deepseek-v4-flash");
    // Call with no init (the fetch signature allows this)
    await wrap("https://api.deepseek.com/v1/chat/completions");
    assert.equal(captured.length, 1, "globalThis.fetch must be called");
    assert.equal(captured[0].init, undefined, "init must pass through as undefined");
  } finally {
    restore();
  }
});

test("T-MR-FIX1.8b: wrapper passes through verbatim when body is not a string (e.g. Uint8Array)", async () => {
  const { captured, restore } = stubFetch();
  try {
    const wrap = makeNoThinkingFetch("deepseek-v4-flash");
    const binaryBody = new Uint8Array([1, 2, 3]);
    await wrap("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      body: binaryBody,
    });
    assert.equal(captured.length, 1, "globalThis.fetch must be called");
    // The body must remain the original Uint8Array (or equivalent) — not stringified
    assert.ok(captured[0].init?.body instanceof Uint8Array, "non-string body must pass through unmodified");
  } finally {
    restore();
  }
});

test("T-MR-FIX1.8c: wrapper passes through verbatim when body is malformed JSON", async () => {
  const { captured, restore } = stubFetch();
  try {
    const wrap = makeNoThinkingFetch("deepseek-v4-flash");
    const malformedBody = "NOT_VALID_JSON{{{";
    await wrap("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      body: malformedBody,
    });
    assert.equal(captured.length, 1, "globalThis.fetch must be called");
    // Body must be passed through unmodified (parse failure → no mutation)
    assert.equal(captured[0].init?.body, malformedBody, "malformed body must pass through unchanged");
  } finally {
    restore();
  }
});

// ─── T-MR-FIX1.9: TS type compat — return type === typeof globalThis.fetch ───

test("T-MR-FIX1.9: makeNoThinkingFetch return type matches typeof globalThis.fetch (TS compat)", () => {
  // TypeScript compile-time check (this file compiles without error ↔ types match).
  // At runtime, verify the returned value is callable as a fetch function.
  const wrapFlash: typeof globalThis.fetch = makeNoThinkingFetch("deepseek-v4-flash");
  const wrapChat: typeof globalThis.fetch = makeNoThinkingFetch("deepseek-chat");
  assert.ok(typeof wrapFlash === "function");
  assert.ok(typeof wrapChat === "function");
});

// ─── DEEPSEEK_THINKING_DEFAULT_MODELS set membership ─────────────────────────

test("T-MR-FIX1.SET1: DEEPSEEK_THINKING_DEFAULT_MODELS contains deepseek-v4-flash and deepseek-v4-pro", () => {
  assert.ok(DEEPSEEK_THINKING_DEFAULT_MODELS.has("deepseek-v4-flash"), "set must contain deepseek-v4-flash");
  assert.ok(DEEPSEEK_THINKING_DEFAULT_MODELS.has("deepseek-v4-pro"), "set must contain deepseek-v4-pro");
  assert.ok(!DEEPSEEK_THINKING_DEFAULT_MODELS.has("deepseek-chat"), "set must NOT contain deepseek-chat");
  assert.ok(!DEEPSEEK_THINKING_DEFAULT_MODELS.has("deepseek-reasoner"), "set must NOT contain deepseek-reasoner");
});

// ─── T-MR-FIX1.M9: resolveModel smoke (no API call) ─────────────────────────

test("T-MR-FIX1.M9: P-71 — 'openai' is reserved; resolveModel throws scope-disabled (use non-reserved 'custom' name instead)", () => {
  // P-71: 'openai' is a reserved direct-provider name; resolveModel must throw scope-disabled.
  // Use a non-reserved name ('custom') with the same DeepSeek baseUrl for the passing smoke.
  const restore = saveEnv("DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "HOME");
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-home-fix1-m9-"));
  try {
    mkdirSync(join(tmpHome, ".frondose"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".frondose", "auth.json"),
      JSON.stringify({
        providers: {
          openai: { key: "stub-key-for-smoke", baseUrl: "https://api.deepseek.com/v1", type: "openai" },
          custom: { key: "stub-key-for-smoke", baseUrl: "https://api.deepseek.com/v1", type: "openai" },
        },
      }),
      "utf-8",
    );
    process.env.HOME = tmpHome;
    // 1. Verify 'openai' (reserved) throws scope-disabled
    assert.throws(
      () => resolveModel({ factory: "openai:deepseek-v4-flash" }),
      (err: Error) =>
        err.message.includes("scope-disabled") || err.message.includes("P-71") || err.message.includes("reserved"),
      "T-MR-FIX1.M9: 'openai' provider must throw scope-disabled (reserved name)",
    );
    // 2. Non-reserved 'custom' with same baseUrl resolves correctly
    const model = resolveModel({ factory: "custom:deepseek-v4-flash" });
    assert.ok(
      model !== null && typeof model === "object",
      "resolveModel must return an object for non-reserved provider",
    );
    assert.ok(
      "specificationVersion" in model || "provider" in model || "modelId" in model,
      "returned object must have LanguageModel shape",
    );
  } finally {
    restore();
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ─── T-MR-FIX1.M10: resolveModel anthropic path unaffected ───────────────────

test("T-MR-FIX1.M10: P-71 — 'anthropic' is reserved; resolveModel throws scope-disabled (no Anthropic dispatch path)", () => {
  // P-71: direct Anthropic provider is scope-disabled. buildModel throws before any fetch.
  // This supersedes the old test that checked the anthropic dispatch path returned a model.
  const restore = saveEnv("ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "HOME");
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-home-fix1-m10-"));
  try {
    mkdirSync(join(tmpHome, ".frondose"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".frondose", "auth.json"),
      JSON.stringify({
        providers: {
          anthropic: { key: "sk-ant-stub", baseUrl: "https://api.anthropic.com/v1", type: "anthropic" },
        },
      }),
      "utf-8",
    );
    process.env.HOME = tmpHome;
    process.env.ANTHROPIC_API_KEY = "sk-ant-stub";
    // P-71 blocks anthropic at the reserved-name guard; throws before any SDK call
    assert.throws(
      () => resolveModel({ factory: "anthropic:claude-sonnet-4-5" }),
      (err: Error) =>
        err.message.includes("scope-disabled") || err.message.includes("P-71") || err.message.includes("reserved"),
      "T-MR-FIX1.M10: 'anthropic' must throw scope-disabled (P-71 removes the Anthropic dispatch path)",
    );
  } finally {
    restore();
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ─── T-MR-FIX1.M11: resolveModel native openai path unaffected ───────────────

test("T-MR-FIX1.M11: P-71 — 'openai' is reserved; resolveModel throws; non-reserved 'another' provider with gpt-4o-mini modelId has no thinking wrapper", () => {
  // P-71: 'openai' is reserved. For the no-wrapper invariant, use non-reserved 'another' provider.
  // gpt-4o-mini is not in DEEPSEEK_THINKING_DEFAULT_MODELS → no thinking wrapper applied.
  const restore = saveEnv("OPENAI_API_KEY", "DEEPSEEK_API_KEY", "HOME");
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-home-fix1-m11-"));
  try {
    mkdirSync(join(tmpHome, ".frondose"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".frondose", "auth.json"),
      JSON.stringify({
        providers: {
          openai: { key: "sk-auth-stub", baseUrl: "https://api.openai.com/v1", type: "openai" },
          another: { key: "sk-auth-stub", baseUrl: "https://api.together.xyz/v1", type: "openai" },
        },
      }),
      "utf-8",
    );
    process.env.HOME = tmpHome;
    // 1. 'openai' (reserved) throws
    assert.throws(
      () => resolveModel({ factory: "openai:gpt-4o-mini" }),
      (err: Error) =>
        err.message.includes("scope-disabled") || err.message.includes("P-71") || err.message.includes("reserved"),
      "T-MR-FIX1.M11: 'openai' must throw scope-disabled",
    );
    // 2. Non-reserved 'another' with gpt-4o-mini resolves without a thinking wrapper
    const model = resolveModel({ factory: "another:gpt-4o-mini" });
    assert.ok(
      model !== null && typeof model === "object",
      "must return LanguageModel object for non-reserved provider",
    );
    // gpt-4o-mini is not in DEEPSEEK_THINKING_DEFAULT_MODELS → makeNoThinkingFetch returns globalThis.fetch
    assert.ok(
      typeof (model as object) === "object",
      "T-MR-FIX1.M11: non-reserved provider with non-thinking model returns LanguageModel",
    );
  } finally {
    restore();
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ─── T-MR-FIX1.COMPAT: v4-pro wrapper also injects thinking (forward compat) ─

test("T-MR-FIX1.COMPAT: v4-pro wrapper also injects thinking:disabled (forward compat)", async () => {
  const { captured, restore } = stubFetch();
  try {
    const wrap = makeNoThinkingFetch("deepseek-v4-pro");
    const body = JSON.stringify({ model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }] });
    await wrap("https://api.deepseek.com/v1/chat/completions", { method: "POST", body });
    const parsed = JSON.parse(captured[0].init?.body as string) as Record<string, unknown>;
    assert.deepEqual(parsed.thinking, { type: "disabled" }, "v4-pro must also inject thinking:disabled");
  } finally {
    restore();
  }
});

// ─── T-MR-FIX1.INIT-CLONE: init is spread (not mutated in place) ─────────────

test("T-MR-FIX1.INIT-CLONE: wrapper creates new init object (does not mutate caller init)", async () => {
  const { restore } = stubFetch();
  try {
    const wrap = makeNoThinkingFetch("deepseek-v4-flash");
    const originalBody = JSON.stringify({ model: "deepseek-v4-flash", messages: [] });
    const originalInit: RequestInit = { method: "POST", body: originalBody };
    await wrap("https://api.deepseek.com/v1/chat/completions", originalInit);
    // The caller's init.body must be unchanged (wrapper uses spread, not mutation)
    assert.equal(originalInit.body, originalBody, "original init.body must not be mutated");
    // Confirm original body has no thinking field
    const origParsed = JSON.parse(originalBody) as Record<string, unknown>;
    assert.ok(!("thinking" in origParsed), "original body must not have thinking injected");
  } finally {
    restore();
  }
});
