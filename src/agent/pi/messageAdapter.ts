import type { AssistantMessage, Message as PiMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CoreMessage } from "ai";

/**
 * [P-PI Gate 2] Convert between the persisted Vercel `CoreMessage[]` (state.messages — shared
 * with the audit writer + the Vercel default path) and Pi's native `Message[]`. The Pi loop
 * converts IN at turn start and converts the NEW messages OUT to push back onto state.messages,
 * so persistence + audit + the next turn stay in the Vercel format regardless of which loop ran.
 */

interface CorePart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  image?: unknown;
  mimeType?: string;
}

/** placeholder metadata for an AssistantMessage reconstructed from history (Pi re-serializes role+content).
 *  [MA-3] stopReason carries the real history state ('toolUse' when the message had tool-calls) — pi-ai's
 *  provider SKIPS replaying assistant messages with stopReason 'error'/'aborted', so a constant 'stop'
 *  would mislabel them; the loop (PI-LOOP-2) already declines to persist empty error/abort turns. */
function assistantStub(modelId: string, stopReason: AssistantMessage["stopReason"]): Omit<AssistantMessage, "content"> {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "deepseek",
    model: modelId,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
  };
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/** CoreMessage[] -> { systemPrompt, piMessages }. System messages fold into the prompt. */
export function coreMessagesToPi(
  messages: CoreMessage[],
  modelId: string,
): { systemPrompt: string | undefined; piMessages: PiMessage[] } {
  const systemParts: string[] = [];
  const piMessages: PiMessage[] = [];
  const ts = Date.now();

  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string") systemParts.push(m.content);
      continue;
    }
    if (m.role === "user") {
      if (typeof m.content === "string") {
        piMessages.push({ role: "user", content: m.content, timestamp: ts });
      } else {
        // [MA-2] Map BOTH text and image parts (e.g. analyze_screenshot base64) — dropping images
        // silently broke any vision flow. The provider's own downgrade handles non-vision placeholders.
        const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
        for (const p of m.content as CorePart[]) {
          if (p.type === "text" && typeof p.text === "string") parts.push({ type: "text", text: p.text });
          else if (p.type === "image" && p.image !== undefined) {
            const data = typeof p.image === "string" ? p.image : String(p.image);
            parts.push({ type: "image", data, mimeType: typeof p.mimeType === "string" ? p.mimeType : "image/png" });
          }
        }
        piMessages.push({ role: "user", content: parts, timestamp: ts });
      }
      continue;
    }
    if (m.role === "assistant") {
      const out: AssistantMessage["content"] = [];
      if (typeof m.content === "string") {
        if (m.content) out.push({ type: "text", text: m.content });
      } else {
        for (const p of m.content as CorePart[]) {
          if (p.type === "text" && typeof p.text === "string") out.push({ type: "text", text: p.text });
          else if (p.type === "tool-call" && p.toolCallId && p.toolName) {
            out.push({
              type: "toolCall",
              id: p.toolCallId,
              name: p.toolName,
              arguments: (p.args ?? {}) as Record<string, unknown>,
            } as ToolCall);
          }
        }
      }
      // [MA-3] preserve the history stop state: a message with tool-calls was a 'toolUse' turn.
      const stop: AssistantMessage["stopReason"] = out.some((c) => c.type === "toolCall") ? "toolUse" : "stop";
      piMessages.push({ ...assistantStub(modelId, stop), content: out });
      continue;
    }
    if (m.role === "tool") {
      for (const p of m.content as CorePart[]) {
        if (p.type !== "tool-result" || !p.toolCallId) continue;
        piMessages.push({
          role: "toolResult",
          toolCallId: p.toolCallId,
          toolName: p.toolName ?? "",
          content: [{ type: "text", text: stringifyResult(p.result) }],
          isError: p.isError === true,
          timestamp: ts,
        } as ToolResultMessage);
      }
    }
  }
  return { systemPrompt: systemParts.length ? systemParts.join("\n\n") : undefined, piMessages };
}

/** A single Pi AssistantMessage -> a Vercel CoreAssistantMessage (text + tool-call parts). */
export function piAssistantToCore(msg: AssistantMessage): CoreMessage {
  const parts: CorePart[] = [];
  for (const c of msg.content) {
    if (c.type === "text" && c.text) parts.push({ type: "text", text: c.text });
    else if (c.type === "toolCall") {
      const tc = c as ToolCall;
      parts.push({ type: "tool-call", toolCallId: tc.id, toolName: tc.name, args: tc.arguments });
    }
  }
  return { role: "assistant", content: parts as never };
}

/** A single Pi ToolResultMessage -> a Vercel CoreToolMessage. [MA-1] Parse back to the envelope ONLY
 *  when genuinely structured (object/array); a bare JSON scalar (quoted string, "1e999"→null, bare
 *  number) must stay the original string or the round-trip corrupts the tool output. */
export function piToolResultToCore(msg: ToolResultMessage): CoreMessage {
  const text = msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  let result: unknown = text;
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object") result = v;
  } catch {
    // non-JSON tool output stays a string
  }
  return {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: msg.toolCallId, toolName: msg.toolName, result, isError: msg.isError },
    ] as never,
  };
}
