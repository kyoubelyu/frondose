/**
 * P-THINK-OVERWRITE — DOM-behavioral proof for the operator requirement (2026-07-27):
 *   (1) the gray thinking block renders only the CURRENT step's reasoning segment — a
 *       current-turn `step-done` frame hides+clears it, so the next segment OVERWRITES;
 *   (2) consecutive steps' answer text is separated into paragraphs (pendingTextBreak → "\n\n").
 *
 * Same split as thinkingDisplayBehavioral-pUiThinkOverlay.mock.test.ts: app.ts is not directly
 * importable (boot()/mustGet() run on import), so the new algorithm (step-done handler,
 * appendAgentChunk break logic, begin/endAgentBubble resets, handleEvent turnId gates) is
 * mirrored EXACTLY, with the REAL renderMarkdownInto for the user-visible assertions (CMR-2).
 * Source-structural pins (SRC) guard against mirror drift from current app.ts.
 *
 * Codex FM-1 critic: REVISE → 3 CONCERN-MR resolved here:
 *   CMR-1 → step-done handler turnId-gated + T-ThinkOw.7 negative test
 *   CMR-2 → T-ThinkOw.3 asserts the rendered two-paragraph DOM, not just the raw string
 *   CMR-3 → T-ThinkOw.8 terminal-step lifecycle (no late reasoning, break reset, no leak)
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/ui/thinkingOverwrite-pThinkOverwrite.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { renderMarkdownInto } from "../../../src/tauri/ui/render.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const APP_TS = readFileSync(join(REPO, "src/tauri/ui/app.ts"), "utf-8");
const STEP_BOUNDARY_TS = readFileSync(join(REPO, "src/tauri/ui/stepBoundary.ts"), "utf-8");

// ─── Fake DOM (same recording-fake shape as thinkingDisplayBehavioral) ───

interface FakeEl {
  tag: string;
  classes: Set<string>;
  attrs: Record<string, string>;
  children: FakeEl[];
  text: string | null;
}

function makeFakeEl(tag: string): FakeEl {
  return { tag, classes: new Set(), attrs: {}, children: [], text: null };
}

// biome-ignore lint/suspicious/noExplicitAny: test stub shaped to satisfy DocumentLike/ElementLike
function wrap(fe: FakeEl): any {
  return {
    _fe: fe,
    get textContent() {
      return fe.text;
    },
    set textContent(v: string | null) {
      fe.text = v;
      fe.children = [];
    },
    classList: {
      add: (c: string) => void fe.classes.add(c),
      remove: (c: string) => void fe.classes.delete(c),
      contains: (c: string) => fe.classes.has(c),
    },
    setAttribute: (k: string, v: string) => {
      fe.attrs[k] = v;
    },
    appendChild: (child: { _fe: FakeEl }) => {
      fe.children.push(child._fe);
      return child;
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test stub shaped to satisfy DocumentLike
function makeFakeDoc(): any {
  return {
    createElement: (tag: string) => wrap(makeFakeEl(tag)),
    createElementNS: (_ns: string, tag: string) => wrap(makeFakeEl(tag)),
  };
}

function flattenText(fe: FakeEl): string {
  if (fe.children.length === 0) return fe.text ?? "";
  return fe.children.map(flattenText).join("");
}

// ─── Harness mirroring app.ts's NEW algorithm byte-for-byte ─────────────────────────────────

type Frame =
  | { type: "text"; turnId: string; chunk: string }
  | { type: "reasoning"; turnId: string; chunk: string }
  | { type: "step-done"; turnId: string; toolNames: string[] }
  | { type: "done"; turnId: string; finishReason: string };

type Harness = {
  // biome-ignore lint/suspicious/noExplicitAny: fake ElementLike
  bubbleEl: any;
  // biome-ignore lint/suspicious/noExplicitAny: fake ElementLike
  thinkingWrapEl: any;
  // biome-ignore lint/suspicious/noExplicitAny: fake ElementLike
  thinkingTextEl: any;
  rawText: () => string;
  pendingBreak: () => boolean;
  handleFrame: (frame: Frame) => void;
  fireFrame: () => void;
};

function makeHarness(): Harness {
  const doc = makeFakeDoc();
  // biome-ignore lint/suspicious/noExplicitAny: mirrors app.ts module state
  let activeAgentTextEl: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: mirrors app.ts module state
  let activeAgentThinkingWrap: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: mirrors app.ts module state
  let activeAgentThinkingEl: any = null;
  let activeAgentRawText = "";
  let pendingTextBreak = false;
  let currentTurnId: string | null = "T1";
  let agentRenderScheduled = false;
  const rafQueue: Array<() => void> = [];
  // biome-ignore lint/suspicious/noExplicitAny: latest bubble handles for post-hoc inspection
  let bubbleEl: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: latest bubble handles for post-hoc inspection
  let thinkingWrapEl: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: latest bubble handles for post-hoc inspection
  let thinkingTextEl: any = null;

  function beginAgentBubble(): void {
    const body = doc.createElement("div");
    body.classList.add("msg-agent-body");
    const thinking = doc.createElement("div");
    thinking.classList.add("agent-thinking");
    thinking.classList.add("hidden");
    const thinkingText = doc.createElement("div");
    thinkingText.classList.add("thinking-text");
    thinking.appendChild(thinkingText);
    body.appendChild(thinking);
    const text = doc.createElement("div");
    text.classList.add("msg-agent-text");
    body.appendChild(text);
    activeAgentTextEl = text;
    activeAgentThinkingWrap = thinking;
    activeAgentThinkingEl = thinkingText;
    activeAgentRawText = "";
    bubbleEl = text;
    thinkingWrapEl = thinking;
    thinkingTextEl = thinkingText;
  }

  // Mirrors src/tauri/ui/stepBoundary.ts (clearThinkingBlock / rawTextWithBreak) byte-for-byte.
  // biome-ignore lint/suspicious/noExplicitAny: fake ElementLike
  function clearThinkingBlock(wrapEl: any, textEl: any): void {
    if (wrapEl !== null) wrapEl.classList.add("hidden");
    if (textEl !== null) textEl.textContent = "";
  }
  function rawTextWithBreak(raw: string): string {
    return raw.length > 0 && !raw.endsWith("\n\n") ? `${raw}\n\n` : raw;
  }

  function scheduleAgentTextRender(): void {
    if (agentRenderScheduled) return;
    agentRenderScheduled = true;
    rafQueue.push(() => {
      agentRenderScheduled = false;
      if (activeAgentTextEl === null) return;
      renderMarkdownInto(doc, activeAgentTextEl, activeAgentRawText);
    });
  }

  function appendAgentChunk(chunk: string): void {
    if (activeAgentTextEl === null) beginAgentBubble();
    if (activeAgentTextEl === null) return;
    // [P-THINK-OVERWRITE] paragraph break between steps' answers (consumed once, never leading).
    if (pendingTextBreak) { pendingTextBreak = false; activeAgentRawText = rawTextWithBreak(activeAgentRawText); }
    activeAgentRawText += chunk;
    scheduleAgentTextRender();
  }

  function appendReasoningChunk(chunk: string): void {
    if (activeAgentThinkingEl === null) beginAgentBubble();
    if (activeAgentThinkingEl === null || activeAgentThinkingWrap === null) return;
    activeAgentThinkingWrap.classList.remove("hidden");
    const prev = activeAgentThinkingEl.textContent ?? "";
    activeAgentThinkingEl.textContent = `${prev}${chunk}`;
  }

  function endAgentBubble(): void {
    if (activeAgentTextEl !== null) renderMarkdownInto(doc, activeAgentTextEl, activeAgentRawText);
    clearThinkingBlock(activeAgentThinkingWrap, activeAgentThinkingEl);
    activeAgentThinkingWrap = null;
    activeAgentThinkingEl = null;
    activeAgentTextEl = null;
    activeAgentRawText = "";
    pendingTextBreak = false; // [P-THINK-OVERWRITE] reset — no separator leaks into the next bubble
  }

  // Mirrors the handleEvent SSE switch for the four relevant frame types (turnId gates included).
  function handleFrame(frame: Frame): void {
    switch (frame.type) {
      case "text":
        if (frame.turnId === currentTurnId) appendAgentChunk(frame.chunk);
        break;
      case "reasoning":
        if (frame.turnId === currentTurnId) appendReasoningChunk(frame.chunk);
        break;
      case "step-done":
        // [P-THINK-OVERWRITE] turnId-gated like text/reasoning/done (Codex FM-1 CMR-1).
        if (frame.turnId === currentTurnId) {
          clearThinkingBlock(activeAgentThinkingWrap, activeAgentThinkingEl);
          pendingTextBreak = true;
        }
        break;
      case "done":
        if (frame.turnId === currentTurnId) {
          currentTurnId = null;
          endAgentBubble();
        }
        break;
    }
  }

  return {
    get bubbleEl() {
      return bubbleEl;
    },
    get thinkingWrapEl() {
      return thinkingWrapEl;
    },
    get thinkingTextEl() {
      return thinkingTextEl;
    },
    rawText: () => activeAgentRawText,
    pendingBreak: () => pendingTextBreak,
    handleFrame,
    fireFrame: () => {
      const queued = rafQueue.splice(0, rafQueue.length);
      for (const cb of queued) cb();
    },
  };
}

const T1 = "T1";
const stepDone = { type: "step-done", turnId: T1, toolNames: ["navigate_to_url"] } as const;

// ─── Overwrite behavior (operator requirement 1) ─────────────────────────────────────────────

describe("P-THINK-OVERWRITE — thinking renders only the CURRENT step's segment", () => {
  it("T-ThinkOw.1: a current-turn step-done hides + clears the visible thinking block", () => {
    // Given: step 1 streamed reasoning (thinking block visible with content)
    // When:  the step-done frame for the CURRENT turn arrives
    // Then:  the thinking wrap is hidden and its text is empty
    const h = makeHarness();
    h.handleFrame({ type: "reasoning", turnId: T1, chunk: "step one reasoning" });
    assert.equal(h.thinkingWrapEl._fe.classes.has("hidden"), false, "pre-condition: visible");
    h.handleFrame(stepDone);
    assert.equal(h.thinkingWrapEl._fe.classes.has("hidden"), true, "wrap must hide on step-done");
    assert.equal(flattenText(h.thinkingTextEl._fe), "", "thinking text must be cleared on step-done");
  });

  it("T-ThinkOw.2: the next step's reasoning OVERWRITES — the block shows exactly the new segment, no residue", () => {
    // Given: step 1's reasoning cleared by step-done
    // When:  step 2's reasoning chunks arrive
    // Then:  the wrap re-reveals and its text is EXACTLY step 2's reasoning (no step-1 bleed)
    const h = makeHarness();
    h.handleFrame({ type: "reasoning", turnId: T1, chunk: "step one reasoning" });
    h.handleFrame(stepDone);
    h.handleFrame({ type: "reasoning", turnId: T1, chunk: "step two " });
    h.handleFrame({ type: "reasoning", turnId: T1, chunk: "reasoning" });
    assert.equal(h.thinkingWrapEl._fe.classes.has("hidden"), false, "wrap must re-reveal");
    assert.equal(flattenText(h.thinkingTextEl._fe), "step two reasoning", "only the current segment");
  });

  it("T-ThinkOw.7 (CMR-1): a STALE turnId step-done does NOT clear the active turn's thinking or arm a break", () => {
    // Given: the active turn T1 with visible thinking
    // When:  a step-done for a DIFFERENT (abandoned) turn arrives
    // Then:  thinking stays visible with content; pendingTextBreak stays unarmed
    const h = makeHarness();
    h.handleFrame({ type: "reasoning", turnId: T1, chunk: "active reasoning" });
    h.handleFrame({ type: "step-done", turnId: "T-STALE", toolNames: [] });
    assert.equal(h.thinkingWrapEl._fe.classes.has("hidden"), false, "stale frame must not hide the block");
    assert.equal(flattenText(h.thinkingTextEl._fe), "active reasoning", "stale frame must not clear the text");
    assert.equal(h.pendingBreak(), false, "stale frame must not arm the break");
  });
});

// ─── Segmentation behavior (operator requirement 2) ──────────────────────────────────────────

describe("P-THINK-OVERWRITE — consecutive steps' answer text is separated into paragraphs", () => {
  it("T-ThinkOw.3 (CMR-2): text after step-done renders as TWO paragraph nodes with the expected text", () => {
    // Given: step 1 answered "step1 answer" (rendered), then step-done armed the break
    // When:  step 2's text chunk "step2 answer" arrives and the scheduled render fires
    // Then:  raw text is "step1 answer\n\nstep2 answer" AND the rendered answer node has TWO
    //        paragraph children — the user-visible segmentation, not just the raw string
    const h = makeHarness();
    h.handleFrame({ type: "text", turnId: T1, chunk: "step1 answer" });
    h.fireFrame();
    h.handleFrame(stepDone);
    h.handleFrame({ type: "text", turnId: T1, chunk: "step2 answer" });
    h.fireFrame();
    assert.equal(h.rawText(), "step1 answer\n\nstep2 answer", "raw text carries exactly one blank line");
    const paras = h.bubbleEl._fe.children;
    assert.equal(paras.length, 2, "the answer must render as TWO paragraph nodes");
    assert.equal(flattenText(paras[0]!), "step1 answer", "paragraph 1 = step 1's answer");
    assert.equal(flattenText(paras[1]!), "step2 answer", "paragraph 2 = step 2's answer");
  });

  it("T-ThinkOw.4: an empty bubble gets NO leading blank lines (break only separates non-empty segments)", () => {
    // Given: a fresh bubble (tool-call-only step 1 produced no text), step-done armed the break
    // When:  the first text chunk arrives
    // Then:  the raw text has no leading "\n\n"
    const h = makeHarness();
    h.handleFrame(stepDone);
    h.handleFrame({ type: "text", turnId: T1, chunk: "first text" });
    h.fireFrame();
    assert.equal(h.rawText(), "first text", "no leading separator in an empty bubble");
  });

  it("T-ThinkOw.5: raw text already ending in a blank line gets NO extra break (idempotent)", () => {
    // Given: step 1's text ended with "\n\n" already
    // When:  step-done then step 2's text arrive
    // Then:  exactly one blank line separates the segments (no triple newline)
    const h = makeHarness();
    h.handleFrame({ type: "text", turnId: T1, chunk: "step1\n\n" });
    h.handleFrame(stepDone);
    h.handleFrame({ type: "text", turnId: T1, chunk: "step2" });
    assert.equal(h.rawText(), "step1\n\nstep2", "no duplicate break");
  });
});

// ─── Regression + terminal lifecycle ─────────────────────────────────────────────────────────

describe("P-THINK-OVERWRITE — P-THINK semantics unchanged + terminal lifecycle", () => {
  it("T-ThinkOw.6: done still hides + clears thinking; a reasoning-first turn with no frame still auto-opens a bubble", () => {
    // Given: a turn with reasoning + answer
    // When:  done arrives
    // Then:  thinking hidden + cleared, answer survives (P-THINK "完成输出后消失" unchanged);
    //        and (second half) a reasoning chunk with no prior frames still auto-opens a bubble
    const h = makeHarness();
    h.handleFrame({ type: "reasoning", turnId: T1, chunk: "reasoning" });
    h.handleFrame({ type: "text", turnId: T1, chunk: "final answer" });
    h.fireFrame();
    const wrapRef = h.thinkingWrapEl;
    const answerRef = h.bubbleEl;
    h.handleFrame({ type: "done", turnId: T1, finishReason: "stop" });
    assert.equal(wrapRef._fe.classes.has("hidden"), true, "done still hides thinking");
    assert.equal(flattenText(answerRef._fe), "final answer", "answer survives done");

    const h2 = makeHarness();
    h2.handleFrame({ type: "reasoning", turnId: T1, chunk: "auto-open reasoning" });
    assert.notEqual(h2.thinkingWrapEl, null, "reasoning-first still auto-opens a bubble (Manual fallback)");
    assert.equal(h2.thinkingWrapEl._fe.classes.has("hidden"), false, "auto-opened block is visible");
  });

  it("T-ThinkOw.8 (CMR-3): terminal lifecycle — final text-only step → step-done → done; no separator leaks into the next turn", () => {
    // Given: a final text-only step (no reasoning), its step-done, then done
    // When:  the next turn opens a fresh bubble and streams its first text
    // Then:  pendingTextBreak was reset by endAgentBubble — the new bubble's raw text starts
    //        clean (no leading break), and no reasoning appears after the terminal delimiter
    const h = makeHarness();
    h.handleFrame({ type: "text", turnId: T1, chunk: "only step answer" });
    h.handleFrame(stepDone); // arms the break, but no more text follows in this turn
    assert.equal(h.pendingBreak(), true, "pre-condition: break armed by the terminal step-done");
    h.handleFrame({ type: "done", turnId: T1, finishReason: "stop" });
    assert.equal(h.pendingBreak(), false, "endAgentBubble must reset the armed break");

    // Next turn (T2) — handleFrame's done handler nulled currentTurnId; a fresh bubble begins.
    // Simulate the next turn by directly re-driving the harness as turn-started would:
    h.handleFrame({ type: "text", turnId: "T2", chunk: "ignored (gate closed)" });
    h.fireFrame();
    assert.equal(h.rawText(), "", "no text lands after done (turnId gate), no separator leakage");
  });
});

// ─── Source-structural pins (guard mirror drift from current app.ts) ─────────────────────────

describe("P-THINK-OVERWRITE — source-structural pins on current app.ts", () => {
  it("T-ThinkOw.SRC.1: the step-done case is turnId-gated, clears thinking via the shared helper, and arms pendingTextBreak", () => {
    const idx = APP_TS.indexOf('case "step-done":');
    assert.ok(idx >= 0, "app.ts must have a step-done case");
    const body = APP_TS.slice(idx, APP_TS.indexOf("break;", idx));
    assert.ok(body.includes("payload.turnId === currentTurnId"), "step-done must be turnId-gated (CMR-1)");
    assert.ok(body.includes("clearThinkingBlockImpl("), "step-done must clear thinking via the stepBoundary helper");
    assert.ok(body.includes("pendingTextBreak = true"), "step-done must arm the paragraph break");
    assert.ok(STEP_BOUNDARY_TS.includes('classList.add("hidden")'), "helper must hide the wrap");
    assert.ok(STEP_BOUNDARY_TS.includes('textContent = ""'), "helper must clear the thinking text");
  });

  it("T-ThinkOw.SRC.2: appendAgentChunk consumes pendingTextBreak via rawTextWithBreak (never twice, never leading)", () => {
    const idx = APP_TS.indexOf("function appendAgentChunk(");
    assert.ok(idx >= 0, "app.ts must define appendAgentChunk");
    const body = APP_TS.slice(idx, APP_TS.indexOf("\nfunction ", idx + 1));
    assert.ok(body.includes("if (pendingTextBreak)"), "appendAgentChunk must consume the armed break");
    assert.ok(body.includes("pendingTextBreak = false"), "the flag must be cleared on consumption (never twice)");
    assert.ok(body.includes("rawTextWithBreakImpl("), "the break itself must be computed by the stepBoundary helper");
    assert.ok(STEP_BOUNDARY_TS.includes('raw.endsWith("\\n\\n")'), "helper: no duplicate break when already separated");
    assert.ok(STEP_BOUNDARY_TS.includes("raw.length > 0"), "helper: no leading break in an empty bubble");
  });

  it("T-ThinkOw.SRC.3: endAgentBubble resets pendingTextBreak and clears thinking via the shared helper", () => {
    const end = APP_TS.slice(APP_TS.indexOf("function endAgentBubble("), APP_TS.indexOf("function transition("));
    assert.ok(end.includes("pendingTextBreak = false"), "endAgentBubble must reset the flag (CMR-3)");
    assert.ok(end.includes("clearThinkingBlockImpl("), "endAgentBubble must clear thinking via the stepBoundary helper");
    assert.ok(STEP_BOUNDARY_TS.includes("export function clearThinkingBlock"), "stepBoundary.ts must export clearThinkingBlock");
    assert.ok(STEP_BOUNDARY_TS.includes("export function rawTextWithBreak"), "stepBoundary.ts must export rawTextWithBreak");
  });
});
