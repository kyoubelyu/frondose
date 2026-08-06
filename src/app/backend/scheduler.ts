import type { CoreMessage, LanguageModel } from "ai";
import { runAgentLoopPi } from "../../agent/pi/loop.js";

export type RuntimeTurnInput = {
  source: "ui" | "telegram";
  text: string;
  media: string[];
};

export async function runRuntimeTurn(input: RuntimeTurnInput): Promise<{ finalText: string }> {
  const messages: CoreMessage[] = [{ role: "user", content: input.text }];
  const completion = (await runAgentLoopPi({
    model: {} as LanguageModel,
    system: "",
    messages,
    tools: {},
    assistantHistory: "final-only",
  })) as unknown as { finalText?: string };
  if (completion.finalText !== undefined) return { finalText: completion.finalText };
  const final = [...messages].reverse().find((message) => message.role === "assistant");
  const content = final?.content;
  const finalText =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part): part is Extract<(typeof content)[number], { type: "text" }> => part.type === "text")
            .map((part) => part.text)
            .join("")
        : "";
  return { finalText };
}
