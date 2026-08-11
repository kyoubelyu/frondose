import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { streamText } from "ai";
import { resolveModel } from "../../src/agent/modelResolver.js";
import { BOUNDARY } from "../../src/agent/systemPrompt/boundary.js";
import { CHECKPOINT } from "../../src/agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../../src/agent/systemPrompt/compose.js";
import { composeSoulBand } from "../../src/agent/systemPrompt/soul.js";
import { __setPacingFn } from "../../src/linkedin/pacing.js";
import type { LinkedinSession } from "../../src/linkedin/types.js";
import { readIdentity } from "../../src/persistence/identity.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";
import { cleanupTmpDir, makeTmpDir } from "../_helpers/tmp.js";
import { FakeLinkedInWorld } from "./fake-linkedin-world.js";

export const TEST_CONFIG_PATH = fileURLToPath(new URL("../fixtures/test-config.json", import.meta.url));

export interface ScenarioOpts {
  prompt: string;
  modelSpec?: string;
  maxSteps?: number;
}

export interface CapturedToolCall {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
}

export interface ScenarioResult {
  toolCalls: CapturedToolCall[];
  textOutput: string;
}

/**
 * Run a scenario test with real LLM against fake LinkedIn.
 *
 * Wiring:
 *   1. Read test identity from fixture
 *   2. Create FakeLinkedinWorld session (all CDP calls route through state machine)
 *   3. Compose real 3-band system prompt (Boundary → Soul → Checkpoint)
 *   4. Wire all 24 tools via makeAllTools
 *   5. Call streamText with real model + prompt
 *   6. Capture tool calls via onStepFinish callback
 *   7. Return toolCalls[] + textOutput for assertion
 */
export async function runScenario(opts: ScenarioOpts): Promise<ScenarioResult> {
  const modelSpec = opts.modelSpec ?? process.env.MAI_TEST_MODEL ?? "anthropic:claude-sonnet-4-5";
  const model = resolveModel({ factory: modelSpec });
  const scenarioRoot = makeTmpDir("frondose-scenario-config");

  try {
    const scenarioConfigPath = join(scenarioRoot, "config.json");
    writeFileSync(scenarioConfigPath, readFileSync(TEST_CONFIG_PATH));
    // Read and write only an isolated copy of the tracked schema-v2 fixture.
    const identity = readIdentity(scenarioConfigPath);

    const system = composeSystemPrompt({
      boundary: BOUNDARY,
      soul: composeSoulBand(identity),
      checkpoint: CHECKPOINT,
    });

    const world = new FakeLinkedInWorld();
    __setPacingFn(async () => ({ waitedMs: 0, jitterMs: 0, serial: true }));
    const session: LinkedinSession = world.makeSession();

    const abortController = new AbortController();
    const control: ControlSignals = {
      requestStop: () => abortController.abort(),
      auditPath: "",
    };

    const tools = makeAllTools(
      session,
      {
        memoryDbPath: ":memory:",
        configPath: scenarioConfigPath,
      },
      control,
    );

    const capturedCalls: CapturedToolCall[] = [];

    const result = streamText({
      model,
      system,
      messages: [{ role: "user", content: opts.prompt }] as any,
      tools,
      maxSteps: opts.maxSteps ?? 15,
      abortSignal: abortController.signal,
      onStepFinish: (step: any) => {
        // Fallback: toolResults preferred, toolCalls if unavailable (SDK version variance)
        const results = step.toolResults ?? step.toolCalls ?? [];
        for (const tr of results) {
          capturedCalls.push({
            toolName: tr.toolName,
            args: tr.args ?? tr.input ?? {},
            result: tr.result ?? tr.output,
          });
        }
      },
    });

    let textOutput = "";
    try {
      for await (const chunk of result.textStream) {
        textOutput += chunk;
      }
      // Drain response to finalize last step (may throw AbortError if stop/escalate called)
      await result.response;
    } catch (e: any) {
      if (abortController.signal.aborted) {
        // Graceful exit — agent called stop/escalate intentionally. textOutput and
        // capturedCalls are complete up to the abort point.
      } else {
        throw e;
      }
    }

    return { toolCalls: capturedCalls, textOutput };
  } finally {
    cleanupTmpDir(scenarioRoot);
  }
}
