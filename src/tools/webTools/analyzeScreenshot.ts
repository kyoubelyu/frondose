import { readFileSync } from "node:fs";
import path from "node:path";
import { generateText, type LanguageModel, tool } from "ai";
import { z } from "zod";
import { resolveModel } from "../../agent/modelResolver.js";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";
import { assertFileReadable } from "../../linkedin/uploadAllowlist.js";
import { readAuth } from "../../persistence/auth.js";

const DEFAULT_VISION_MODEL = "anthropic:claude-sonnet-4-5";
const DEFAULT_PROMPT = "Describe what you see, focusing on UI elements, text content, and notable structure.";

const analyzeScreenshotParams = z.object({
  path: z.string().describe("Absolute path to a PNG/JPEG screenshot. Must be readable per the file sandbox."),
  prompt: z.string().max(2000).default(DEFAULT_PROMPT).describe("Question or instruction for the vision model."),
});

/**
 * P-9 F-4 / D-6: analyze_screenshot tool. Secondary generateText call to a
 * vision-capable model (default anthropic:claude-sonnet-4-5; override via
 * MAI_VISION_MODEL). Main streamText session model UNCHANGED — vision call
 * is fully isolated.
 *
 * D-7 file sandbox: assertFileReadable() called on the supplied path BEFORE
 * readFileSync. Allowed: ~/.mai/agent/**, MAI_UPLOAD_ALLOWLIST, os.tmpdir(),
 * tests/fixtures/** (when cwd is repo root).
 *
 * D-13: NOT in IDEMPOTENT_TOOLS (vision tokens cost; retry could double-bill).
 *
 * CONCERN-1 (guardian): thread Vercel SDK `opts.abortSignal` into the inner
 * generateText so a top-level abort (stop tool, Ctrl-C) cancels the vision call
 * promptly instead of dangling on the Anthropic API.
 */
export function makeAnalyzeScreenshotTool() {
  return tool({
    description:
      "Analyze a screenshot file via a vision-capable LLM. " +
      "Pass an absolute path to a PNG/JPEG file (typically the path returned by the screenshot tool). " +
      "Returns a text description. Vision model defaults to anthropic:claude-sonnet-4-5 (override via MAI_VISION_MODEL env). " +
      "Costs vision tokens billed against the vision provider's API key.",
    parameters: analyzeScreenshotParams,
    execute: async ({ path: filePath, prompt }, opts) => {
      try {
        assertFileReadable(filePath);
        const buffer = readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
        const auth = readAuth();
        const visionSpec = process.env.MAI_VISION_MODEL ?? auth?.visionModel ?? DEFAULT_VISION_MODEL;
        let model: LanguageModel;
        try {
          model = resolveModel({ factory: visionSpec });
        } catch (e) {
          return fail(
            "analyze_screenshot",
            "runtime_error",
            `Vision model resolution failed for '${visionSpec}': ${e instanceof Error ? e.message : String(e)}. ` +
              `Set ANTHROPIC_API_KEY or change MAI_VISION_MODEL.`,
          );
        }
        const result = await generateText({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", image: buffer, mimeType },
                { type: "text", text: prompt },
              ],
            },
          ],
          abortSignal: opts?.abortSignal,
        });
        return ok("analyze_screenshot", {
          description: result.text,
          visionModel: visionSpec,
          mimeType,
          bytes: buffer.length,
        });
      } catch (e) {
        return failFromError("analyze_screenshot", e);
      }
    },
  });
}
