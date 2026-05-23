/**
 * P-37 Step 5 — T-B5.1..T-B5.5 (assertions filled; T-B5.5 is new edge-case)
 *
 * B5: analyze_screenshot vision failure → improved error + name-capability-gated fallback.
 *
 * Gate coverage:
 *   G-P37.7 (error message names MAI_VISION_MODEL; tool description mentions it),
 *   G-P37.8 (fallback fires for vision-capable main model; no fallback for non-vision-capable)
 *
 * DI: globalThis.fetch mocked to simulate generateText throw (first call → throw).
 * Follows the same withMockFetch pattern as tests/tools/webTools/analyzeScreenshot.test.ts.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CoreMessage, ToolExecutionOptions } from "ai";
import { writeAuth } from "../../src/persistence/auth.js";
import { makeAnalyzeScreenshotTool } from "../../src/tools/webTools/analyzeScreenshot.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FIXTURE_PNG = `${process.cwd()}/tests/fixtures/test-screenshot.png`;

const FAKE_OPTS: ToolExecutionOptions = { toolCallId: "b5-1", messages: [] as CoreMessage[] };

// P-Z3: the fallback name-gating logic only runs once resolveModel succeeds (buildModel,
// modelResolver.ts:162, throws "not configured" before generateText when no provider ENTRY exists —
// env keys are consulted only after the entry is found). Seed a CUSTOM-URL OpenAI-compatible provider
// "vis" (the only provider type allowed post-P-57d) under an isolated HOME; tests use claude-/deepseek-
// named modelIds under it so VISION_CAPABLE_MODEL_RE (analyzeScreenshot.ts:18) gates as before.
function withSeededVisionProvider(fn: () => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "mai-p37-b5-home-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  writeAuth({ providers: { vis: { key: "test-key", baseUrl: "https://vis.test/v1", type: "openai" } } });
  return fn().finally(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });
}

/** Minimal OpenAI-compatible chat.completion response (P-57d custom-URL provider shape). */
function makeOpenAIChatResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-b5",
      object: "chat.completion",
      model: "vis-model",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function withEnvMulti(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const savedKeys = Object.keys(vars);
  const saved: Record<string, string | undefined> = {};
  for (const k of savedKeys) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    await fn();
  } finally {
    for (const k of savedKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Fetch mock that always throws — both vision and fallback calls fail. */
function makeAlwaysThrowFetch(message: string): typeof globalThis.fetch {
  return async (_url: string | URL | Request, _init?: RequestInit) => {
    throw new Error(message);
  };
}

async function withMockFetch(mockFn: typeof globalThis.fetch, fn: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFn;
  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

// ─── T-B5.1 ──────────────────────────────────────────────────────────────────

describe("B5: analyze_screenshot — name-gated fallback to main model (G-P37.8)", () => {
  it("T-B5.1: when vision generateText throws AND main modelId matches vision-capable pattern (claude-*), a second generateText runs with the main model; ok result visionModel reflects the fallback", async () => {
    // Given: MAI_VISION_MODEL='anthropic:claude-opus-4-7' (vision spec, different from main);
    //        MAI_MODEL='anthropic:claude-sonnet-4-5' (vision-capable — matches /claude/);
    //        first fetch throws; second fetch returns success
    // When:  analyze_screenshot.execute is called
    // Then:  result.ok === true; result.data.visionModel === 'anthropic:claude-sonnet-4-5' (fallback main spec)

    const tool = makeAnalyzeScreenshotTool();

    // P-Z3: model-keyed mock (retry-proof) — the vision modelId (claude-opus) ALWAYS throws on every
    // attempt incl. SDK retries; the fallback main modelId (claude-sonnet) succeeds. Provider "vis" is
    // seeded so resolveModel succeeds and the vision generateText actually runs (then throws → fallback).
    const modelKeyedMock: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { model?: string };
      if ((body.model ?? "").includes("opus")) throw new Error("MOCK TLS connection error: ECONNRESET");
      return makeOpenAIChatResponse("Fallback vision description");
    };

    await withSeededVisionProvider(async () =>
      withEnvMulti(
        {
          MAI_VISION_MODEL: "vis:claude-opus-4-7",
          MAI_MODEL: "vis:claude-sonnet-4-5",
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          DEEPSEEK_API_KEY: undefined,
        },
        async () =>
          withMockFetch(modelKeyedMock, async () => {
            const result = (await tool.execute?.({ path: FIXTURE_PNG, prompt: "describe" }, FAKE_OPTS)) as {
              ok: boolean;
              data?: { description: string; visionModel: string; mimeType: string; bytes: number };
              error?: { message: string };
            };

            assert.equal(
              result.ok,
              true,
              `result must be ok:true after fallback succeeds; got: ${JSON.stringify(result.error)}`,
            );
            assert.equal(
              result.data?.visionModel,
              "vis:claude-sonnet-4-5",
              "visionModel must be the fallback main spec (not the original vision spec)",
            );
            assert.equal(
              result.data?.description,
              "Fallback vision description",
              "description must come from the fallback model's response",
            );
          }),
      ),
    );
  });

  it("T-B5.2: when vision generateText throws AND main modelId is 'deepseek-v4-flash' (not vision-capable), NO retry; fail envelope names MAI_VISION_MODEL", async () => {
    // Given: MAI_VISION_MODEL='anthropic:claude-sonnet-4-5'; MAI_MODEL='deepseek:deepseek-v4-flash' (not vision-capable);
    //        all fetch calls throw
    // When:  analyze_screenshot.execute is called
    // Then:  result.ok === false; result.error.message contains "MAI_VISION_MODEL"; no second fetch (deepseek not vision-capable)

    const tool = makeAnalyzeScreenshotTool();

    // P-Z3: seed "vis" so resolveModel(vision) succeeds → the vision call runs (always-throws) →
    // fallback decision: main modelId "deepseek-v4-flash" fails VISION_CAPABLE_MODEL_RE → NO fallback →
    // runtime_error naming MAI_VISION_MODEL + the non-vision-capable main spec (L110-116).
    await withSeededVisionProvider(async () =>
      withEnvMulti(
        {
          MAI_VISION_MODEL: "vis:claude-sonnet-4-5",
          MAI_MODEL: "vis:deepseek-v4-flash",
          ANTHROPIC_API_KEY: undefined,
          DEEPSEEK_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
        },
        async () =>
          withMockFetch(makeAlwaysThrowFetch("MOCK TLS error for B5.2"), async () => {
            const result = (await tool.execute?.({ path: FIXTURE_PNG, prompt: "describe" }, FAKE_OPTS)) as {
              ok: boolean;
              error?: { message: string };
            };

            assert.equal(result.ok, false, "result must be ok:false (no retry for non-vision-capable main)");
            assert.ok(
              result.error?.message.includes("MAI_VISION_MODEL"),
              `error message must name MAI_VISION_MODEL; got: "${result.error?.message}"`,
            );
            assert.ok(
              result.error?.message.includes("vis:deepseek-v4-flash") ||
                result.error?.message.includes("not recognized as vision-capable"),
              "error must indicate why fallback was not attempted",
            );
          }),
      ),
    );
  });
});

// ─── T-B5.3 ──────────────────────────────────────────────────────────────────

describe("B5: analyze_screenshot — resolveModel failure path (G-P37.7)", () => {
  it("T-B5.3: when resolveModel throws (no provider key configured for vision spec), the pre-generateText fail envelope message names MAI_VISION_MODEL", async () => {
    // Given: MAI_VISION_MODEL='unknown_provider_b53:some-model'; no key for that provider
    // When:  analyze_screenshot.execute is called (resolveModel fails before generateText)
    // Then:  result.ok === false; result.error.message contains "MAI_VISION_MODEL"

    const tool = makeAnalyzeScreenshotTool();

    await withEnvMulti(
      {
        MAI_VISION_MODEL: "unknown_provider_b53:some-model",
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        DEEPSEEK_API_KEY: undefined,
      },
      async () => {
        const result = (await tool.execute?.({ path: FIXTURE_PNG, prompt: "describe" }, FAKE_OPTS)) as {
          ok: boolean;
          error?: { message: string };
        };

        assert.equal(result.ok, false, "result must be ok:false when resolveModel throws");
        assert.ok(
          result.error?.message.includes("MAI_VISION_MODEL"),
          `error message must name MAI_VISION_MODEL; got: "${result.error?.message}"`,
        );
      },
    );
  });
});

// ─── T-B5.4 ──────────────────────────────────────────────────────────────────

describe("B5: analyze_screenshot — tool description mentions MAI_VISION_MODEL (G-P37.7)", () => {
  it("T-B5.4: the analyze_screenshot tool description string contains 'MAI_VISION_MODEL' (operator override path documented in description)", () => {
    // Given: makeAnalyzeScreenshotTool() called with no arguments
    // When:  tool.description string is read
    // Then:  the description contains "MAI_VISION_MODEL" — operator is informed of the override env var

    const tool = makeAnalyzeScreenshotTool();
    const description = tool.description ?? "";

    assert.ok(description.length > 0, "analyze_screenshot tool must have a non-empty description");
    assert.ok(
      description.includes("MAI_VISION_MODEL"),
      "tool description must contain 'MAI_VISION_MODEL' (operator needs to know about the override env var)",
    );
  });
});

// ─── T-B5.5 (edge case) ──────────────────────────────────────────────────────

describe("B5: analyze_screenshot — both vision and fallback calls fail (G-P37.8 double-fail)", () => {
  it("T-B5.5: when both the vision call AND the fallback main-model call throw, the fail envelope names MAI_VISION_MODEL and both specs", async () => {
    // Given: MAI_VISION_MODEL='anthropic:claude-opus-4-7'; MAI_MODEL='anthropic:claude-sonnet-4-5' (vision-capable);
    //        ALL fetch calls throw (vision fails AND fallback fails)
    // When:  analyze_screenshot.execute is called
    // Then:  result.ok === false; error message references both specs and MAI_VISION_MODEL

    const tool = makeAnalyzeScreenshotTool();

    await withEnvMulti(
      {
        ANTHROPIC_API_KEY: "test-key-b5-5",
        MAI_VISION_MODEL: "anthropic:claude-opus-4-7",
        MAI_MODEL: "anthropic:claude-sonnet-4-5",
        OPENAI_API_KEY: undefined,
        DEEPSEEK_API_KEY: undefined,
      },
      async () =>
        withMockFetch(makeAlwaysThrowFetch("MOCK persistent API error"), async () => {
          const result = (await tool.execute?.({ path: FIXTURE_PNG, prompt: "describe" }, FAKE_OPTS)) as {
            ok: boolean;
            error?: { message: string };
          };

          assert.equal(result.ok, false, "result must be ok:false when both vision and fallback fail");
          assert.ok(
            result.error?.message.includes("MAI_VISION_MODEL"),
            `error must reference MAI_VISION_MODEL; got: "${result.error?.message}"`,
          );
          // Either the visionSpec or the fallback MAI_VISION_MODEL guidance must be present
          const msg = result.error?.message ?? "";
          assert.ok(
            msg.includes("claude-opus-4-7") || msg.includes("claude-sonnet-4-5") || msg.includes("fallback"),
            "error must reference the affected model specs or the fallback",
          );
        }),
    );
  });
});
