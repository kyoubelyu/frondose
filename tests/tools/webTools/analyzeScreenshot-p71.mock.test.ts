import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CoreMessage, ToolExecutionOptions } from "ai";
import { writeAuth } from "../../../src/persistence/auth.js";
import { makeAnalyzeScreenshotTool } from "../../../src/tools/webTools/analyzeScreenshot.js";
import { cleanupTmpDir } from "../../_helpers/tmp";

const FIXTURE_PNG = join(process.cwd(), "tests", "fixtures", "test-screenshot.png");
const FAKE_OPTS: ToolExecutionOptions = { toolCallId: "p71-analyze-screenshot", messages: [] as CoreMessage[] };
const VISION_ENV_KEYS = [
  "HOME",
  "FRONDOSE_HOME_BASE",
  "FRONDOSE_MODEL",
  "FRONDOSE_VISION_MODEL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;
type VisionEnvKey = (typeof VISION_ENV_KEYS)[number];

function saveEnv(): Record<VisionEnvKey, string | undefined> {
  const saved = {} as Record<VisionEnvKey, string | undefined>;
  for (const key of VISION_ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<VisionEnvKey, string | undefined>): void {
  for (const key of VISION_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function withIsolatedVisionHome(fn: () => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "mai-p71-vision-"));
  const saved = saveEnv();
  process.env.HOME = home;
  process.env.FRONDOSE_HOME_BASE = home;
  process.env.FRONDOSE_MODEL = "deepseek:deepseek-chat";
  delete process.env.FRONDOSE_VISION_MODEL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    await fn();
  } finally {
    restoreEnv(saved);
    cleanupTmpDir(home);
  }
}

async function withMockFetch(
  mockFn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
  fn: (calls: string[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(url.toString());
    return mockFn(url, init);
  }) as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function makeOpenAIResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-p71",
      object: "chat.completion",
      model: "vision-1",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function assertNoDirectKeyGuidance(message: string): void {
  assert.doesNotMatch(message, /ANTHROPIC_API_KEY|OPENAI_API_KEY/i);
}

describe("P-71 analyze_screenshot provider scope", () => {
  it("T-P71.Vision.1: direct Anthropic vision specs are blocked", async () => {
    await withIsolatedVisionHome(async () => {
      // Given: FRONDOSE_VISION_MODEL is anthropic:* and legacy Anthropic provider data exists.
      // When: analyze_screenshot resolves its vision model.
      // Then: it fails with custom-URL/DeepSeek guidance before any direct Anthropic fetch.
      process.env.FRONDOSE_VISION_MODEL = "anthropic:claude-sonnet-4-5";
      writeAuth({
        providers: {
          anthropic: { key: "sk-ant-legacy", baseUrl: "https://api.anthropic.com/v1", type: "anthropic" },
        },
      });

      await withMockFetch(
        async () =>
          new Response(JSON.stringify({ error: { message: "direct Anthropic fetch reached" } }), { status: 500 }),
        async (calls) => {
          const tool = makeAnalyzeScreenshotTool();
          const result = (await tool.execute?.({ path: FIXTURE_PNG, prompt: "describe" }, FAKE_OPTS)) as {
            ok: boolean;
            error: { message: string };
          };

          assert.equal(result.ok, false);
          assert.equal(calls.length, 0, `direct Anthropic vision fetch is forbidden; calls=${calls.join(", ")}`);
          assert.match(result.error.message, /custom|DeepSeek|direct|disabled|scope/i);
          assertNoDirectKeyGuidance(result.error.message);
        },
      );
    });
  });

  it("T-P71.Vision.2: direct OpenAI vision specs are blocked", async () => {
    await withIsolatedVisionHome(async () => {
      // Given: FRONDOSE_VISION_MODEL is openai:* and legacy OpenAI provider data exists.
      // When: analyze_screenshot resolves its vision model.
      // Then: it fails with custom-URL guidance before any direct OpenAI fetch.
      process.env.FRONDOSE_VISION_MODEL = "openai:gpt-4o";
      writeAuth({
        providers: {
          openai: { key: "sk-openai-legacy", baseUrl: "https://api.openai.com/v1", type: "openai" },
        },
      });

      await withMockFetch(
        async () =>
          new Response(JSON.stringify({ error: { message: "direct OpenAI fetch reached" } }), { status: 500 }),
        async (calls) => {
          const tool = makeAnalyzeScreenshotTool();
          const result = (await tool.execute?.({ path: FIXTURE_PNG, prompt: "describe" }, FAKE_OPTS)) as {
            ok: boolean;
            error: { message: string };
          };

          assert.equal(result.ok, false);
          assert.equal(calls.length, 0, `direct OpenAI vision fetch is forbidden; calls=${calls.join(", ")}`);
          assert.match(result.error.message, /custom|DeepSeek|direct|disabled|scope/i);
          assertNoDirectKeyGuidance(result.error.message);
        },
      );
    });
  });

  it("T-P71.Vision.3: custom non-official vision providers are preserved", async () => {
    await withIsolatedVisionHome(async () => {
      // Given: FRONDOSE_VISION_MODEL points to an allowed custom provider with a non-official baseUrl and key.
      // When: analyze_screenshot resolves and calls the vision model.
      // Then: the custom OpenAI-compatible path still succeeds.
      process.env.FRONDOSE_VISION_MODEL = "vision:vision-1";
      writeAuth({
        providers: {
          vision: { key: "sk-vision", baseUrl: "https://vision.example/v1", type: "openai" },
        },
      });

      await withMockFetch(
        async () => makeOpenAIResponse("custom vision description"),
        async (calls) => {
          const tool = makeAnalyzeScreenshotTool();
          const result = (await tool.execute?.({ path: FIXTURE_PNG, prompt: "describe" }, FAKE_OPTS)) as {
            ok: boolean;
            data: { description: string; visionModel: string };
          };

          assert.equal(
            result.ok,
            true,
            `custom vision provider should remain usable; result=${JSON.stringify(result)}`,
          );
          assert.equal(result.data.visionModel, "vision:vision-1");
          assert.equal(result.data.description, "custom vision description");
          assert.ok(
            calls.some((url) => url.includes("vision.example")),
            `custom provider URL must be used; calls=${calls}`,
          );
        },
      );
    });
  });

  it("T-P71.Vision.4: vision failure guidance does not point at direct provider keys", async () => {
    await withIsolatedVisionHome(async () => {
      // Given: FRONDOSE_VISION_MODEL names an unconfigured custom provider.
      // When: analyze_screenshot returns configuration guidance.
      // Then: the message does not tell the operator to set direct Anthropic/OpenAI keys.
      process.env.FRONDOSE_VISION_MODEL = "missingvision:vision-1";
      const tool = makeAnalyzeScreenshotTool();
      const result = (await tool.execute?.({ path: FIXTURE_PNG, prompt: "describe" }, FAKE_OPTS)) as {
        ok: boolean;
        error: { message: string };
      };

      assert.equal(result.ok, false);
      assertNoDirectKeyGuidance(result.error.message);
      assert.match(result.error.message, /custom|DeepSeek|provider|configured/i);
    });
  });
});
