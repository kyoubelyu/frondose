import { readFileSync } from "node:fs";
import path from "node:path";
import { generateText, type LanguageModel, tool } from "ai";
import { z } from "zod";
import { resolveModel, resolveModelSpec } from "../../agent/modelResolver.js";
import { frondoseEnv } from "../../env.js";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";
import { assertFileReadable } from "../../linkedin/uploadAllowlist.js";
import { readAuth } from "../../persistence/auth.js";

// P-57d (item b): default unset. Operator must configure FRONDOSE_VISION_MODEL to a
// custom-URL vision-capable provider per project_llm_scope_custom_url_only.
const DEFAULT_VISION_MODEL = "";

/** P-37 B5: conservative name heuristic for vision-capable models. Used ONLY to
 *  decide whether a fallback retry on the MAIN model is safe — an unknown model
 *  does not match → no fallback → a clear error (never garbage from a text-only
 *  model). NOT a capability registry. */
const VISION_CAPABLE_MODEL_RE = /claude|gpt-4o|gpt-4\.1|gemini/i;
const DEFAULT_PROMPT = "Describe what you see, focusing on UI elements, text content, and notable structure.";

const analyzeScreenshotParams = z.object({
  path: z.string().describe("Absolute path to a PNG/JPEG screenshot. Must be readable per the file sandbox."),
  prompt: z.string().max(2000).default(DEFAULT_PROMPT).describe("Question or instruction for the vision model."),
});

/**
 * P-9 F-4 / D-6: analyze_screenshot tool. Secondary generateText call to a
 * vision-capable model via FRONDOSE_VISION_MODEL. Main streamText session model
 * UNCHANGED — vision call is fully isolated.
 *
 * D-7 file sandbox: assertFileReadable() called on the supplied path BEFORE
 * readFileSync. Allowed: ~/.frondose/agent/**, FRONDOSE_UPLOAD_ALLOWLIST, os.tmpdir(),
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
      "Returns a text description. P-57d: default unset — operator must set `FRONDOSE_VISION_MODEL` " +
      " " +
      "to a custom-URL vision-capable provider to enable this tool. Otherwise prefer `inspect` " +
      "(accessibility tree primitive). External vision APIs (anthropic-direct/openai-direct) " +
      "are scope-disabled per `project_llm_scope_custom_url_only`. " +
      'Returns {ok:false, error:{kind:"vision_unavailable"}} when FRONDOSE_VISION_MODEL is unset (operator scope lock).',
    parameters: analyzeScreenshotParams,
    execute: async ({ path: filePath, prompt }, opts) => {
      try {
        assertFileReadable(filePath);
        const buffer = readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
        const auth = readAuth();
        const visionSpec = frondoseEnv("VISION_MODEL") ?? auth?.visionModel ?? DEFAULT_VISION_MODEL;
        if (visionSpec === "") {
          return {
            ok: false,
            error: {
              kind: "vision_unavailable",
              message:
                "Vision unavailable — current FRONDOSE_MODEL doesn't support vision. " +
                "Set FRONDOSE_VISION_MODEL to a custom-URL vision-capable provider OR use the inspect tool instead. " +
                "operator scope: FRONDOSE_VISION_MODEL not configured; external vision APIs (Anthropic/OpenAI direct) are disabled.",
            },
          };
        }
        let model: LanguageModel;
        try {
          model = resolveModel({ factory: visionSpec });
        } catch (e) {
          return fail(
            "analyze_screenshot",
            "runtime_error",
            `Vision model resolution failed for '${visionSpec}': ${e instanceof Error ? e.message : String(e)}. ` +
              "Use FRONDOSE_VISION_MODEL=<provider>:<modelId> with a configured DeepSeek/custom OpenAI-compatible provider; direct Anthropic/OpenAI vision providers are scope-disabled.",
          );
        }
        const runVision = (m: LanguageModel) =>
          generateText({
            model: m,
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
        try {
          const result = await runVision(model);
          return ok("analyze_screenshot", {
            description: result.text,
            visionModel: visionSpec,
            mimeType,
            bytes: buffer.length,
          });
        } catch (visionErr) {
          // P-37 B5: name-gated fallback to the main model.
          const mainSpec = resolveModelSpec();
          const mainModelId = mainSpec.includes(":") ? mainSpec.slice(mainSpec.indexOf(":") + 1) : "";
          if (mainSpec === visionSpec || !VISION_CAPABLE_MODEL_RE.test(mainModelId)) {
            return fail(
              "analyze_screenshot",
              "runtime_error",
              `Vision call failed for '${visionSpec}': ${visionErr instanceof Error ? visionErr.message : String(visionErr)}. ` +
                `Set FRONDOSE_VISION_MODEL=<provider>:<modelId> to a reachable vision-capable provider ` +
                `(the main model '${mainSpec}' is not recognized as vision-capable, so no fallback was attempted).`,
            );
          }
          // NIT-2: keep resolution failure distinct from the vision-call failure.
          let mainModel: LanguageModel;
          try {
            mainModel = resolveModel({ factory: mainSpec });
          } catch (resolveErr) {
            return fail(
              "analyze_screenshot",
              "runtime_error",
              `Vision call failed on '${visionSpec}' and the fallback model '${mainSpec}' could not be resolved: ` +
                `${resolveErr instanceof Error ? resolveErr.message : String(resolveErr)}. ` +
                `Set FRONDOSE_VISION_MODEL to a reachable vision-capable provider.`,
            );
          }
          try {
            const result = await runVision(mainModel);
            return ok("analyze_screenshot", {
              description: result.text,
              visionModel: mainSpec,
              mimeType,
              bytes: buffer.length,
            });
          } catch {
            return fail(
              "analyze_screenshot",
              "runtime_error",
              `Vision call failed on '${visionSpec}' and the fallback '${mainSpec}'. ` +
                `Set FRONDOSE_VISION_MODEL to a reachable vision-capable provider.`,
            );
          }
        }
      } catch (e) {
        return failFromError("analyze_screenshot", e);
      }
    },
  });
}
