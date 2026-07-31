import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("legacy reasoning presentation is retired", () => {
  it("T-Think.UI.1: provider reasoning has no app event branch or visible DOM surface", () => {
    // Given the shipped app composition, when its assistant surfaces are inspected, then reasoning is consumed privately and never rendered.
    const app = readFileSync(resolve("src/tauri/ui/app.ts"), "utf8");
    const binding = readFileSync(resolve("src/tauri/ui/app/assistantAppBindings.ts"), "utf8");
    const bubble = readFileSync(resolve("src/tauri/ui/app/agentBubble.ts"), "utf8");
    assert.doesNotMatch(app, /case "reasoning":|appendReasoningChunk|activeAgentThinking/);
    assert.match(binding, /if \(event\.type === "reasoning"\) return true/);
    assert.doesNotMatch(bubble, /agent-thinking|thinking-line|thinking-text|status\.thinking/);
  });

  it("T-Think.UI.2: the replacement surface is one unlabeled assistant-progress region", () => {
    // Given the compiled-bubble source, when the temporary surface is inspected, then it is accessible, separate from the answer, and label-free.
    const bubble = readFileSync(resolve("src/tauri/ui/app/agentBubble.ts"), "utf8");
    assert.match(bubble, /progress\.classList\.add\("assistant-progress"\)/);
    assert.match(bubble, /progressText\.classList\.add\("assistant-progress-text"\)/);
    assert.match(bubble, /progress\.setAttribute\?\.\("aria-live", "polite"\)/);
    assert.match(bubble, /progress\.setAttribute\?\.\("role", "status"\)/);
    assert.match(bubble, /return \{ textEl: text, progressWrap: progress, progressTextEl: progressText \}/);
  });
});
