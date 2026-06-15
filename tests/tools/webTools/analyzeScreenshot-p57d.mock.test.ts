/**
 * P-57d Step 5 — T-Vision.1, T-Vision.2 — FILLED
 * (G-P57d.1, G-P57d.2)
 *
 * Per source grep at Step 5 baseline (post-Step 4b):
 *   - src/tools/webTools/analyzeScreenshot.ts L12: DEFAULT_VISION_MODEL = "" (empty).
 *   - L60-71: when visionSpec === "" → return {ok:false, error:{kind:"vision_unavailable",
 *     message: "Vision unavailable — current MAI_MODEL doesn't support vision. " +
 *              "Set FRONDOSE_VISION_MODEL to a custom-URL vision-capable provider OR use the inspect tool instead. " +
 *              "operator scope: FRONDOSE_VISION_MODEL not configured; external vision APIs (Anthropic/OpenAI direct) are disabled."}}
 *   - tool description at L46-50: contains "vision-capable provider", "inspect", "operator scope",
 *     "vision_unavailable", "FRONDOSE_VISION_MODEL".
 *   - boundary.ts L30: contains "Tool-preference hints (P-57d scope lock)" with vision keywords.
 *
 * Test strategy:
 *   - T-Vision.1: write tmp PNG fixture under os.tmpdir() (passes assertFileReadable allowlist);
 *     clear process.env.FRONDOSE_VISION_MODEL; point FRONDOSE_HOME_BASE to tmp dir (no auth.json so readAuth → null);
 *     invoke execute(); assert envelope shape.
 *   - T-Vision.2: pure substring grep against BOUNDARY constant.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/tools/webTools/analyzeScreenshot-p57d.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { BOUNDARY } from "../../../src/agent/systemPrompt/boundary.js";
import { makeAnalyzeScreenshotTool } from "../../../src/tools/webTools/analyzeScreenshot.js";

// ─── T-Vision.1 — analyze_screenshot graceful vision_unavailable envelope ────

describe("analyze_screenshot tool — graceful vision_unavailable envelope when FRONDOSE_VISION_MODEL unset (G-P57d.1 + F-REN-3 flip)", () => {
  it("T-Vision.1: given process.env.FRONDOSE_VISION_MODEL cleared + FRONDOSE_HOME_BASE pointed at tmp dir (no auth.json, so readAuth returns null + auth.visionModel undefined) + tmp PNG fixture in os.tmpdir() (passes assertFileReadable allowlist), WHEN analyze_screenshot.execute({path:<tmp-png>, prompt:'describe'}) is called, THEN result is {ok:false, error:{kind:'vision_unavailable', message: contains 'Vision unavailable' + 'FRONDOSE_VISION_MODEL' + 'inspect' + 'operator scope'}}; tool.description contains 'operator scope', 'inspect', 'vision-capable' substrings (P-57d scope-lock messaging per plan §5.1.3; F-REN-3: FRONDOSE_VISION_MODEL → FRONDOSE_VISION_MODEL)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "p57d-vision-"));
    const origHome = process.env.FRONDOSE_HOME_BASE;
    const origVisionModel = process.env.FRONDOSE_VISION_MODEL;
    process.env.FRONDOSE_HOME_BASE = tmpDir;
    delete process.env.FRONDOSE_VISION_MODEL;

    try {
      // Write minimal PNG fixture under os.tmpdir() (allowlist OK; just needs to exist + readable)
      const fixturePath = join(tmpDir, "fixture.png");
      writeFileSync(fixturePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { flag: "w" });

      const tool = makeAnalyzeScreenshotTool();

      // Tool description substring assertions (per plan §5.1.3 rewrite)
      assert.ok(typeof tool.description === "string" && tool.description.length > 0, "tool.description must be set");
      assert.ok(
        tool.description.includes("vision-capable"),
        `tool.description must contain 'vision-capable'; got: ${tool.description}`,
      );
      assert.ok(
        tool.description.includes("inspect"),
        `tool.description must contain 'inspect'; got: ${tool.description}`,
      );
      assert.ok(
        tool.description.includes("scope-disabled") || tool.description.includes("operator scope"),
        `tool.description must reference scope lock; got: ${tool.description}`,
      );

      // Behavioral envelope assertion
      // biome-ignore lint/suspicious/noExplicitAny: Tool execute signature varies by Vercel SDK version
      const result: any = await (tool.execute as any)(
        { path: fixturePath, prompt: "describe" },
        { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
      );

      assert.equal(result?.ok, false, `result.ok must be false; got: ${JSON.stringify(result)}`);
      assert.equal(
        result?.error?.kind,
        "vision_unavailable",
        `result.error.kind must be 'vision_unavailable'; got: ${result?.error?.kind}`,
      );
      const message = String(result?.error?.message ?? "");
      assert.ok(
        message.includes("Vision unavailable"),
        `error message must contain 'Vision unavailable'; got: ${message}`,
      );
      assert.ok(message.includes("FRONDOSE_VISION_MODEL"), `error message must contain 'FRONDOSE_VISION_MODEL' (F-REN-3 flip); got: ${message}`);
      assert.ok(message.includes("inspect"), `error message must reference 'inspect' fallback; got: ${message}`);
      assert.ok(
        message.includes("operator scope") || message.includes("Operator scope"),
        `error message must reference 'operator scope'; got: ${message}`,
      );
    } finally {
      if (origHome === undefined) delete process.env.FRONDOSE_HOME_BASE;
      else process.env.FRONDOSE_HOME_BASE = origHome;
      if (origVisionModel === undefined) delete process.env.FRONDOSE_VISION_MODEL;
      else process.env.FRONDOSE_VISION_MODEL = origVisionModel;
    }
  });
});

// ─── T-Vision.2 — BOUNDARY band has analyze_screenshot tool-preference hint ──

describe("BOUNDARY constant — contains analyze_screenshot tool-preference hint (G-P57d.2)", () => {
  it("T-Vision.2: given BOUNDARY import from src/agent/systemPrompt/boundary.ts, WHEN substring searches applied for the P-57d vision directive, THEN string contains 'inspect' + 'analyze_screenshot' + 'vision_unavailable' + 'accessibility-tree primitive' — all from the P-57d-appended Tool-preference paragraph per plan §5.3", () => {
    assert.ok(BOUNDARY.includes("inspect"), "BOUNDARY must contain 'inspect' (preference directive)");
    assert.ok(BOUNDARY.includes("analyze_screenshot"), "BOUNDARY must contain 'analyze_screenshot' (tool name)");
    assert.ok(
      BOUNDARY.includes("vision_unavailable"),
      "BOUNDARY must contain 'vision_unavailable' (graceful envelope kind)",
    );
    assert.ok(
      BOUNDARY.includes("accessibility-tree primitive"),
      "BOUNDARY must contain 'accessibility-tree primitive' (inspect explanation)",
    );
  });
});
