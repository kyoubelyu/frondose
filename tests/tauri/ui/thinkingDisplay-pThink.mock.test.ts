/**
 * P-THINK — FE mock tests: the gray live-"thinking" display in the Tauri app.
 *
 * app.ts has zero exports + boot()/mustGet() run on import (no DOM harness at this tier), so the
 * handler-wiring assertions are source-structural (same pattern as autoRunCompletedUi-pWLC /
 * turnStartedUi). The i18n `status.thinking` key is verified functionally via the importable t().
 *
 * Run:
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/ui/thinkingDisplay-pThink.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { setLocale, t } from "../../../src/tauri/ui/i18n.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP_TS = readFileSync(join(REPO, "src/tauri/ui/app.ts"), "utf-8");
const INDEX_HTML = readFileSync(join(REPO, "src/tauri/ui/index.html"), "utf-8");

// Isolate the handleEvent switch body so case-arm assertions don't match the union type.
function handleEventBody(): string {
  const start = APP_TS.indexOf("function handleEvent(");
  assert.ok(start >= 0, "app.ts must define handleEvent()");
  return APP_TS.slice(start);
}

function fnBody(sig: string): string {
  const start = APP_TS.indexOf(sig);
  assert.ok(start >= 0, `app.ts must define ${sig}`);
  const rest = APP_TS.slice(start + sig.length);
  const end = rest.indexOf("\nfunction ");
  return end > 0 ? rest.slice(0, end) : rest;
}

describe("app.ts — SseFrame union carries the reasoning frame (P-THINK)", () => {
  it('T-Think.UI.1: the UI-local SseFrame union declares { type: "reasoning"; turnId: string; chunk: string }', () => {
    // Given: app.ts source. When: scanned for the union member. Then: a reasoning member exists.
    assert.ok(
      APP_TS.includes('type: "reasoning"; turnId: string; chunk: string'),
      "app.ts SseFrame union must include a reasoning member matching the BE frame shape",
    );
  });
});

describe("app.ts — the gray thinking block is built + streamed + removed (P-THINK)", () => {
  it("T-Think.UI.2: beginAgentBubble builds a hidden .agent-thinking wrapper with a .thinking-line (t status.thinking) and a .thinking-text, above .msg-agent-text", () => {
    // Given: beginAgentBubble source. When: scanned. Then: it creates the thinking DOM, hidden, with the i18n line.
    const begin = fnBody("function beginAgentBubble(");
    assert.ok(begin.includes('classList.add("agent-thinking")'), "must create the .agent-thinking wrapper");
    assert.ok(begin.includes('classList.add("hidden")'), "the thinking wrapper must start hidden");
    assert.ok(begin.includes('classList.add("thinking-line")'), "must create the .thinking-line label");
    assert.ok(begin.includes('t("status.thinking")'), "the thinking line text must come from i18n status.thinking");
    assert.ok(begin.includes('classList.add("thinking-text")'), "must create the .thinking-text sink");
    // The thinking wrapper is appended to the body BEFORE the .msg-agent-text element.
    assert.ok(
      begin.indexOf("body.appendChild(thinking)") < begin.indexOf('text.classList.add("msg-agent-text")'),
      "the thinking block must be inserted before the answer text element",
    );
  });

  it("T-Think.UI.3: appendReasoningChunk reveals the block and appends the delta to .thinking-text", () => {
    // Given: appendReasoningChunk source. When: scanned. Then: it un-hides the wrapper and appends the chunk.
    const append = fnBody("function appendReasoningChunk(");
    assert.ok(append.includes('classList.remove("hidden")'), "must reveal the thinking wrapper");
    assert.ok(
      append.includes("activeAgentThinkingEl.textContent = `${prev}${chunk}`"),
      "must append the reasoning delta to the thinking-text node",
    );
    assert.ok(append.includes("beginAgentBubble()"), "must auto-open the bubble if the turn had no turn-started frame");
  });

  it('T-Think.UI.4: handleEvent has a case "reasoning" that appends the chunk for the current turn only', () => {
    // Given: the handleEvent switch. When: scanned. Then: a reasoning case guards on the current turn + appends.
    const body = handleEventBody();
    assert.ok(body.includes('case "reasoning":'), 'handleEvent must have a case "reasoning"');
    const caseIdx = body.indexOf('case "reasoning":');
    const caseArm = body.slice(caseIdx, caseIdx + 400);
    assert.ok(caseArm.includes("payload.turnId === currentTurnId"), "reasoning must be gated on the current turn");
    assert.ok(caseArm.includes("appendReasoningChunk(payload.chunk)"), "reasoning must append via appendReasoningChunk");
  });

  it("T-Think.UI.5: endAgentBubble makes the thinking block disappear (hidden + cleared) on turn completion", () => {
    // Given: endAgentBubble source. When: scanned. Then: it hides + clears the thinking block ("完成输出后消失").
    const end = fnBody("function endAgentBubble(");
    assert.ok(
      end.includes('activeAgentThinkingWrap.classList.add("hidden")'),
      "the thinking block must be hidden when the turn's output completes",
    );
    assert.ok(end.includes('activeAgentThinkingEl.textContent = ""'), "the streamed thinking text must be cleared");
    assert.ok(end.includes("activeAgentThinkingWrap = null") && end.includes("activeAgentThinkingEl = null"), "sinks reset");
  });

  it("T-Think.UI.6: endAgentBubble runs on both done and error (thinking removed either way)", () => {
    // Given: the handleEvent switch. When: scanned. Then: both done and error close the bubble.
    const body = handleEventBody();
    const done = body.slice(body.indexOf('case "done":'), body.indexOf('case "error":'));
    assert.ok(done.includes("endAgentBubble()"), 'case "done" must call endAgentBubble()');
    const error = body.slice(body.indexOf('case "error":'));
    assert.ok(error.includes("endAgentBubble()"), 'case "error" must call endAgentBubble()');
  });
});

describe("index.html — the thinking block is styled gray/semi-transparent (P-THINK)", () => {
  it("T-Think.UI.7: .agent-thinking uses --ink-muted + reduced opacity, and .hidden makes it display:none", () => {
    // Given: index.html CSS. When: scanned. Then: the gray/semi-transparent + hidden rules exist.
    assert.ok(/\.agent-thinking\s*\{[^}]*var\(--ink-muted\)[^}]*opacity:\s*0?\.55/.test(INDEX_HTML), ".agent-thinking must be gray + ~0.55 opacity");
    assert.ok(/\.agent-thinking\.hidden\s*\{[^}]*display:\s*none/.test(INDEX_HTML), ".agent-thinking.hidden must be display:none");
    assert.ok(/\.thinking-line\s*\{[^}]*font-style:\s*italic/.test(INDEX_HTML), ".thinking-line must be styled");
  });
});

describe("i18n — status.thinking exists in both locales (P-THINK)", () => {
  it("T-Think.UI.8: status.thinking resolves to 'thinking…' (en) and '思考中…' (zh-CN)", () => {
    // Given: the i18n tables. When: t() is resolved per locale. Then: both translations are present.
    setLocale("en");
    assert.equal(t("status.thinking"), "thinking…");
    setLocale("zh-CN");
    assert.equal(t("status.thinking"), "思考中…");
    setLocale("en"); // restore default for any later tests in this process
  });
});
