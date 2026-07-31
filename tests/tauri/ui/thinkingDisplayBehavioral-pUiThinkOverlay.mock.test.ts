import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("temporary assistant progress is owned by the shipped runtime", () => {
  it("T-ThinkOverlay.1: app events route once through composition and runtime owns bubble start", () => {
    // Given the executable app root, when assistant lifecycle wiring is inspected, then no legacy parallel renderer remains.
    const app = readFileSync(resolve("src/tauri/ui/app.ts"), "utf8");
    assert.match(app, /if \(assistantAppComposition\.handleEvent\(payload\)\) return/);
    assert.match(app, /createAssistantTurnRuntime\(\{/);
    assert.match(app, /turnController: assistantTurnController/);
    assert.doesNotMatch(app, /function beginAgentBubble|function appendAgentChunk|function endAgentBubble/);
  });

  it("T-ThinkOverlay.2: stale terminals and stale rAF callbacks are generation-gated", () => {
    // Given the production controller, when ownership or generation changes, then old terminal and paint work cannot mutate the replacement sink.
    const source = readFileSync(resolve("src/tauri/ui/assistantTurnController.ts"), "utf8");
    assert.match(source, /frame\.turnId !== owner/);
    assert.match(source, /refs !== target \|\| generation !== targetGeneration/);
    assert.match(source, /pendingGeneration === targetGeneration/);
  });

  it("T-ThinkOverlay.3: shipped CSS keeps progress absolute and bounded to two lines", () => {
    // Given the complete app stylesheet, when progress layout is inspected, then it overlays the protected answer anchor with a two-line clamp.
    const html = readFileSync(resolve("src/tauri/ui/index.html"), "utf8");
    assert.match(html, /\.msg-agent-body \{[^}]*position: relative/);
    assert.match(html, /\.assistant-progress \{[\s\S]*position: absolute[\s\S]*-webkit-line-clamp: 2/);
    assert.match(html, /max-height: 2\.7rem/);
  });
});
