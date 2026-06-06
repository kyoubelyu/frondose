import type { Tool as PiTool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolSet } from "ai";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * [P-PI Gate 1] Adapt the existing Vercel `tool()` objects (the ~53 makeAllTools tools)
 * to Pi without modifying any tool under `src/tools/**`.
 *
 * - parameters: Zod -> JSON Schema (verified live: Pi accepts a plain JSON-Schema object as
 *   `Tool.parameters`; DeepSeek tool-called correctly through it).
 * - execute: preserved unchanged. The result envelope is JSON-serialized into a Pi
 *   ToolResultMessage; an `ok:false` envelope sets `isError`. A thrown error is caught and
 *   returned as an error envelope (parity with the tools' own failFromError).
 *
 * This is a thin loop-LAYER adapter — the no-bash boundary + the tool contract (names + Zod
 * param schemas) are untouched; only the loop that drives them changes (Vercel -> Pi).
 */

interface VercelToolLike {
  description?: string;
  parameters?: unknown; // Zod schema
  execute?: (args: unknown, opts: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<unknown>;
}

export interface PiToolBundle {
  /** Pi tool definitions (JSON-Schema parameters) for pi-ai Context.tools. */
  tools: PiTool[];
  /** Run a tool call against the original Vercel execute fn; return a Pi ToolResultMessage. */
  dispatch: (call: ToolCall, abortSignal?: AbortSignal) => Promise<ToolResultMessage>;
  /** Tool names present (for diagnostics / activeTools filtering). */
  names: string[];
}

/** Build the Pi tool bundle from a Vercel ToolSet. Optionally restrict to `activeTools`. */
export function buildPiToolBundle(toolSet: ToolSet, activeTools?: string[]): PiToolBundle {
  const active = activeTools ? new Set(activeTools) : null;
  const tools: PiTool[] = [];
  const names: string[] = [];
  const execMap = new Map<string, NonNullable<VercelToolLike["execute"]>>();

  for (const [name, raw] of Object.entries(toolSet)) {
    if (active && !active.has(name)) continue;
    const t = raw as VercelToolLike;
    let parameters: Record<string, unknown> = { type: "object", properties: {}, additionalProperties: false };
    if (t.parameters) {
      try {
        parameters = zodToJsonSchema(t.parameters as never, { target: "openApi3", $refStrategy: "none" }) as Record<
          string,
          unknown
        >;
      } catch {
        // keep the empty-object schema; the tool still registers + dispatches
      }
    }
    // Pi types `parameters` as typebox TSchema but JSON-serializes it for the OpenAI tools
    // payload at runtime, so a plain JSON-Schema object is the correct value (verified).
    tools.push({ name, description: t.description ?? name, parameters: parameters as unknown as PiTool["parameters"] });
    names.push(name);
    if (typeof t.execute === "function") execMap.set(name, t.execute);
  }

  const dispatch = async (call: ToolCall, abortSignal?: AbortSignal): Promise<ToolResultMessage> => {
    const timestamp = Date.now();
    const exec = execMap.get(call.name);
    const result = exec ? await runExec(exec, call, abortSignal) : { ok: false, error: `unknown tool: ${call.name}` };
    const text = typeof result === "string" ? result : safeStringify(result);
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text }],
      isError: isErrorEnvelope(result),
      timestamp,
    };
  };

  return { tools, dispatch, names };
}

async function runExec(
  exec: NonNullable<VercelToolLike["execute"]>,
  call: ToolCall,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  try {
    return await exec(call.arguments, { toolCallId: call.id, abortSignal });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function isErrorEnvelope(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && (result as { ok?: boolean }).ok === false);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
