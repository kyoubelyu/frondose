/**
 * P-UI-THINK-OVERLAY item (1) — DOM-behavioral proof for the P-THINK contract (gray thinking
 * block separated from the answer + hidden on turn completion).
 *
 * Operator-reported 2026-07-13: "thinking 未能分隔,推理完成后无法隐藏,一直在对话框里" (thinking
 * doesn't separate from the answer, and after reasoning completes it never hides — it stays in
 * the dialog box). thinkingDisplay-pThink.mock.test.ts already pins the SOURCE-STRUCTURAL shape
 * (beginAgentBubble/appendReasoningChunk/endAgentBubble contain the right calls in the right
 * order), but nothing previously exercised the actual DOM outcome end-to-end. This file closes
 * that gap with a behavioral simulation — same split as mdHistoryFlush-pFeMdHistory.mock.test.ts
 * (app.ts is not directly importable: boot()/mustGet() run on import) — mirroring
 * beginAgentBubble/appendReasoningChunk/appendAgentChunk/endAgentBubble EXACTLY, using the REAL
 * renderMarkdownInto (via the render.js barrel; no leaf imports), to prove on CURRENT source:
 *   (A) the thinking block is a SEPARATE DOM element from the answer text (never merged into it)
 *   (B) endAgentBubble() reliably hides + clears it on turn completion (done/error)
 *
 * FINDING (2026-07-13 FM-0, scoped per the FM-1 critic CONCERN-MR-1): the mirrored DOM helpers
 * hold BOTH properties in every traced code path (turn-started explicit open, Manual-REPL
 * auto-open via either reasoning-first or text-first arrival, multi-turn sequencing) — a
 * mirrored simulation proves the ALGORITHM, not the compiled app; live attribution of the
 * operator's symptom stays UNVERIFIED until the FM-3/on-glass protocol in
 * docs/phase-ui-think-overlay-plan.md §1.4 runs on a rebuilt app. One REAL defect was found and
 * fixed this phase (critic CONCERN-MR-2): performSteer's timeout branch abandoned the old turn's
 * bubble without closing it — thinking could stay visible forever, and a late frame for the
 * stale turnId could reopen it. Covered by the "steer-timeout" suite below.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/ui/thinkingDisplayBehavioral-pUiThinkOverlay.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderMarkdownInto } from "../../../src/tauri/ui/render.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const APP_TS = readFileSync(join(REPO, "src/tauri/ui/app.ts"), "utf-8");

// R-Source.2 forbids static test imports of the src/tauri/ui/app/ leaf SOURCE — load the BUILT
// scrolling.js instead (same blessed pattern as app-characterization-slice11's Bucket B leaf
// loads; requires npm run build:tauri-ui first).
type ScrollAreaLike = { scrollTop: number; scrollHeight: number; clientHeight: number };
type ScrollingModule = {
  isNearBottom: (el: unknown, thresholdPx: number) => boolean;
  scrollToBottomIfPinned: (el: unknown, thresholdPx: number) => void;
};
const scrollingMod = (await import(pathToFileURL(join(REPO, "src/tauri/ui/app/scrolling.js")).href)) as ScrollingModule;
const { isNearBottom, scrollToBottomIfPinned } = scrollingMod;

// ─── Fake DOM (same recording-fake shape as mdHistoryFlush-pFeMdHistory.mock.test.ts) ───

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
      fe.children = []; // matches real DOM: assigning textContent clears prior children
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

// ─── Inline simulation mirroring app.ts's exact algorithm ───────────────────────────────────
// beginAgentBubble / appendReasoningChunk / appendAgentChunk / endAgentBubble, byte-for-byte
// equivalent to src/tauri/ui/app.ts (incl. the P-FE-MD-HISTORY finalize-flush). rAF is an
// injectable queue so tests control exactly when the coalesced answer-text frame fires.

type Harness = {
  // biome-ignore lint/suspicious/noExplicitAny: fake ElementLike
  bubbleEl: any;
  // biome-ignore lint/suspicious/noExplicitAny: fake ElementLike
  thinkingWrapEl: any;
  // biome-ignore lint/suspicious/noExplicitAny: fake ElementLike
  thinkingTextEl: any;
  beginAgentBubble: () => void;
  appendReasoningChunk: (chunk: string) => void;
  appendAgentChunk: (chunk: string) => void;
  endAgentBubble: () => void;
  fireFrame: () => void;
};

function t(key: string): string {
  return key === "status.thinking" ? "thinking…" : key;
}

function makeHarness(): Harness {
  const doc = makeFakeDoc();
  // biome-ignore lint/suspicious/noExplicitAny: mirrors app.ts module state
  let activeAgentTextEl: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: mirrors app.ts module state
  let activeAgentThinkingWrap: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: mirrors app.ts module state
  let activeAgentThinkingEl: any = null;
  let activeAgentRawText = "";
  let agentRenderScheduled = false;
  const rafQueue: Array<() => void> = [];
  // biome-ignore lint/suspicious/noExplicitAny: latest bubble handles for post-hoc inspection
  let bubbleEl: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: latest bubble handles for post-hoc inspection
  let thinkingWrapEl: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: latest bubble handles for post-hoc inspection
  let thinkingTextEl: any = null;

  // Mirrors app.ts beginAgentBubble (P-THINK block ABOVE .msg-agent-text, both children of one
  // .msg-agent-body — verifying (A): they are two DISTINCT DOM elements, never the same node).
  function beginAgentBubble(): void {
    const body = doc.createElement("div");
    body.classList.add("msg-agent-body");
    const thinking = doc.createElement("div");
    thinking.classList.add("agent-thinking");
    thinking.classList.add("hidden");
    const thinkingLine = doc.createElement("div");
    thinkingLine.classList.add("thinking-line");
    thinkingLine.textContent = t("status.thinking");
    const thinkingText = doc.createElement("div");
    thinkingText.classList.add("thinking-text");
    thinking.appendChild(thinkingLine);
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
    // P-FE-MD-HISTORY: flush the pending rAF render BEFORE detach.
    if (activeAgentTextEl !== null) renderMarkdownInto(doc, activeAgentTextEl, activeAgentRawText);
    // P-THINK: hide + clear the thinking block on turn completion ("完成输出后消失").
    if (activeAgentThinkingWrap !== null) activeAgentThinkingWrap.classList.add("hidden");
    if (activeAgentThinkingEl !== null) activeAgentThinkingEl.textContent = "";
    activeAgentThinkingWrap = null;
    activeAgentThinkingEl = null;
    activeAgentTextEl = null;
    activeAgentRawText = "";
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
    beginAgentBubble,
    appendReasoningChunk,
    appendAgentChunk,
    endAgentBubble,
    fireFrame: () => {
      const queued = rafQueue.splice(0, rafQueue.length);
      for (const cb of queued) cb();
    },
  };
}

// ─── Property (A): thinking is a separate element from the answer, never merged ─────────────

describe("P-UI-THINK-OVERLAY behavioral (A) — thinking block stays a SEPARATE element from the answer text", () => {
  it("T-ThinkBehav.1: reasoning-then-text turn — thinking-text and answer-text are two distinct nodes with distinct content", () => {
    // Given: a turn-started bubble that streams reasoning first, then the answer
    // When:  appendReasoningChunk + appendAgentChunk both fire, then the rAF frame runs
    // Then:  the thinking node and the answer node are DIFFERENT objects, each holding only
    //        its own content — reasoning text never appears inside the answer node or vice versa
    const h = makeHarness();
    h.beginAgentBubble();
    h.appendReasoningChunk("Let me think about ");
    h.appendReasoningChunk("this problem carefully.");
    h.appendAgentChunk("Here is **the answer**.");
    h.fireFrame();

    assert.notEqual(h.thinkingTextEl, h.bubbleEl, "thinking-text and answer-text must be distinct DOM nodes");
    assert.equal(
      flattenText(h.thinkingTextEl._fe),
      "Let me think about this problem carefully.",
      "thinking-text must contain ONLY the reasoning delta",
    );
    assert.equal(
      flattenText(h.bubbleEl._fe),
      "Here is the answer.",
      "answer-text must contain ONLY the answer text (rendered, no reasoning bleed)",
    );
    assert.ok(
      !flattenText(h.bubbleEl._fe).includes("think"),
      "no reasoning wording must leak into the rendered answer",
    );
  });

  it("T-ThinkBehav.2: text-first arrival (no turn-started frame, Manual-REPL fallback) still auto-opens BOTH sinks together — no dangling half-open bubble", () => {
    // Given: no beginAgentBubble() call — the FIRST event is a text chunk (Manual REPL path)
    // When:  appendAgentChunk fires before any reasoning ever arrives
    // Then:  both activeAgentTextEl and activeAgentThinkingWrap/Text get created atomically by
    //        the SAME beginAgentBubble() auto-open — a later reasoning chunk (if any) lands in
    //        the correct, already-allocated thinking sink, not a second stray bubble
    const h = makeHarness();
    h.appendAgentChunk("Quick answer, no reasoning this time.");
    h.fireFrame();
    assert.notEqual(h.thinkingWrapEl, null, "thinking wrap must exist even on the text-first auto-open path");
    assert.equal(
      h.thinkingWrapEl._fe.classes.has("hidden"),
      true,
      "thinking wrap must start hidden (no reasoning arrived)",
    );
    h.appendReasoningChunk("late reasoning");
    assert.equal(
      flattenText(h.thinkingTextEl._fe),
      "late reasoning",
      "a later reasoning chunk must land in the SAME thinking sink opened by the text-first auto-open",
    );
  });
});

// ─── Property (B): endAgentBubble reliably hides + clears thinking on completion ─────────────

describe("P-UI-THINK-OVERLAY behavioral (B) — endAgentBubble hides + clears thinking on turn completion", () => {
  it("T-ThinkBehav.3: after endAgentBubble(), the thinking wrap is hidden, its text is cleared, and the answer text survives", () => {
    // Given: a turn with both reasoning and an answer streamed
    // When:  endAgentBubble() runs (mirrors the done/error SSE handler)
    // Then:  the thinking wrap carries .hidden, its text node is emptied, and the answer text
    //        (a SEPARATE node) is untouched — "完成输出后消失" holds without erasing the reply
    const h = makeHarness();
    h.beginAgentBubble();
    h.appendReasoningChunk("reasoning content");
    h.appendAgentChunk("final answer");
    h.fireFrame();
    const thinkingWrapRef = h.thinkingWrapEl;
    const thinkingTextRef = h.thinkingTextEl;
    const answerRef = h.bubbleEl;

    h.endAgentBubble();

    assert.equal(
      thinkingWrapRef._fe.classes.has("hidden"),
      true,
      "thinking wrap must carry .hidden after endAgentBubble",
    );
    assert.equal(flattenText(thinkingTextRef._fe), "", "thinking text must be cleared after endAgentBubble");
    assert.equal(flattenText(answerRef._fe), "final answer", "the answer text must survive endAgentBubble untouched");
  });

  it("T-ThinkBehav.4: a reasoning-only turn (no text ever streamed) still hides cleanly — no throw, no stuck visible block", () => {
    // Given: a turn that streams reasoning but produces zero answer text (e.g. a pure tool-call step)
    // When:  endAgentBubble() runs
    // Then:  the thinking wrap is hidden + cleared; no exception; the (empty) answer node is untouched
    const h = makeHarness();
    h.beginAgentBubble();
    h.appendReasoningChunk("thinking without ever answering");
    const thinkingWrapRef = h.thinkingWrapEl;

    assert.doesNotThrow(() => h.endAgentBubble());
    assert.equal(
      thinkingWrapRef._fe.classes.has("hidden"),
      true,
      "reasoning-only turn must still end with the thinking block hidden",
    );
  });

  it("T-ThinkBehav.5: a SECOND turn's thinking block starts fresh (hidden, empty) — no bleed from the first turn's finalized-but-hidden block", () => {
    // Given: turn 1 fully finalized (thinking hidden+cleared) via endAgentBubble()
    // When:  turn 2 begins (a fresh beginAgentBubble()) and streams its own reasoning
    // Then:  turn 2's thinking wrap is a NEW element (distinct from turn 1's), starts hidden,
    //        and its text contains ONLY turn 2's reasoning — no cross-turn residue
    const h = makeHarness();
    h.beginAgentBubble();
    h.appendReasoningChunk("turn one reasoning");
    h.appendAgentChunk("turn one answer");
    h.fireFrame();
    const turn1ThinkingWrap = h.thinkingWrapEl;
    h.endAgentBubble();

    h.beginAgentBubble();
    const turn2ThinkingWrap = h.thinkingWrapEl;
    assert.notEqual(turn2ThinkingWrap, turn1ThinkingWrap, "turn 2 must get a NEW thinking wrap element");
    assert.equal(turn2ThinkingWrap._fe.classes.has("hidden"), true, "turn 2's thinking wrap must start hidden");
    h.appendReasoningChunk("turn two reasoning");
    assert.equal(
      flattenText(h.thinkingTextEl._fe),
      "turn two reasoning",
      "turn 2's thinking text must contain ONLY turn 2's reasoning (no turn-1 bleed)",
    );
  });

  it("T-ThinkBehav.6: done-before-frame race (P-FE-MD-HISTORY interaction) — thinking still hides correctly even when the answer's rAF render hasn't fired yet", () => {
    // Given: a chunk is appended (scheduling a pending rAF render) and endAgentBubble() runs
    //        BEFORE that frame fires (the exact race P-FE-MD-HISTORY closed for the answer text)
    // When:  endAgentBubble() flushes the answer AND hides the thinking block in the same call
    // Then:  the thinking block hides correctly regardless of the answer-text rAF race — the two
    //        properties (A) separation and (B) hide-on-done are independent and both hold
    const h = makeHarness();
    h.beginAgentBubble();
    h.appendReasoningChunk("reasoning");
    h.appendAgentChunk("Here is **imp"); // frame 1 scheduled
    h.fireFrame(); // renders the intermediate snapshot — literal "**imp" visible (by design mid-stream)
    h.appendAgentChunk("ortant** advice."); // frame 2 scheduled, NOT fired — closes the bold
    const thinkingWrapRef = h.thinkingWrapEl;

    h.endAgentBubble(); // done lands before frame 2 fires — the finalize flush must still save it

    assert.equal(
      thinkingWrapRef._fe.classes.has("hidden"),
      true,
      "thinking must hide even mid-race with the answer's pending rAF render",
    );
    assert.ok(
      !flattenText(h.bubbleEl._fe).includes("**"),
      "the answer flush (P-FE-MD-HISTORY) must still resolve the literal ** via the finalize flush",
    );
  });
});

// ─── CMR-2 — performSteer's timeout branch must close the abandoned bubble ───────────────────
// (FM-1 critic CONCERN-MR-2: without this, thinking could stay visible forever after a steer
// timeout, and a late reasoning/text frame for the stale turnId could reopen a bubble.)

describe("P-UI-THINK-OVERLAY CMR-2 — steer-timeout closes the abandoned turn's bubble (source-structural)", () => {
  function performSteerBody(): string {
    const start = APP_TS.indexOf("async function performSteer(");
    assert.ok(start >= 0, "app.ts must define performSteer()");
    const rest = APP_TS.slice(start);
    const end = rest.indexOf("\nasync function ");
    return end > 0 ? rest.slice(0, end) : rest;
  }

  it('T-SteerTimeout.SRC.1: the timeout branch nulls currentTurnId AND calls endAgentBubble() before transition("error")', () => {
    // Given: performSteer's body in current app.ts
    // When:  the steerTimeout branch is scanned
    // Then:  currentTurnId = null and endAgentBubble() both appear between the steerTimeout
    //        banner and the branch's transition("error") — terminal UI ownership is defined
    const body = performSteerBody();
    const timeoutIdx = body.indexOf("error.steerTimeout");
    assert.ok(timeoutIdx >= 0, "performSteer must have the steerTimeout branch");
    const branch = body.slice(timeoutIdx, body.indexOf("return;", timeoutIdx));
    assert.ok(branch.includes("currentTurnId = null;"), "timeout branch must drop the stale turnId (late-frame guard)");
    assert.ok(branch.includes("endAgentBubble();"), "timeout branch must close the bubble (hides the thinking block)");
    const errIdx = branch.indexOf('transition("error")');
    assert.ok(errIdx >= 0, "timeout branch must still transition to error");
    assert.ok(branch.indexOf("endAgentBubble();") < errIdx, "cleanup must run before the error transition");
    assert.ok(branch.indexOf("currentTurnId = null;") < errIdx, "turnId drop must run before the error transition");
  });
});

describe("P-UI-THINK-OVERLAY CMR-2 — late frames for the abandoned turn cannot reopen the bubble (behavioral)", () => {
  it("T-SteerTimeout.1: after the timeout cleanup, a late reasoning frame for the OLD turnId is dropped by the currentTurnId gate — no bubble reopens", () => {
    // Given: a turn "T1" streaming reasoning; a steer whose waitForDoneSse timed out ran the
    //        CMR-2 cleanup (currentTurnId = null; endAgentBubble())
    // When:  a late { type:"reasoning", turnId:"T1" } frame arrives (mirrors handleEvent's
    //        `payload.turnId === currentTurnId` gate exactly)
    // Then:  the gate drops it — appendReasoningChunk never runs, no new thinking sink is
    //        allocated, and the old (hidden) wrapper stays hidden
    const h = makeHarness();
    let currentTurnId: string | null = "T1";
    h.beginAgentBubble();
    h.appendReasoningChunk("visible reasoning mid-turn");
    const oldWrap = h.thinkingWrapEl;
    assert.equal(oldWrap._fe.classes.has("hidden"), false, "pre-condition: thinking visible mid-turn");

    // The CMR-2 timeout-branch cleanup, in app.ts order:
    currentTurnId = null;
    h.endAgentBubble();
    assert.equal(oldWrap._fe.classes.has("hidden"), true, "cleanup must hide the thinking block");

    // Late frame for the abandoned turn — handleEvent's gate:
    const lateFrame = { type: "reasoning", turnId: "T1", chunk: "late poison" } as const;
    if (lateFrame.turnId === currentTurnId) h.appendReasoningChunk(lateFrame.chunk);

    assert.equal(oldWrap._fe.classes.has("hidden"), true, "old wrapper must stay hidden after the late frame");
    assert.equal(h.thinkingWrapEl, oldWrap, "no NEW bubble/thinking sink may be allocated by the dropped frame");
  });

  it("T-SteerTimeout.2: WITHOUT the turnId drop (the pre-fix behavior), the same late frame WOULD reopen a visible thinking block — the regression this fix closes", () => {
    // Given: the identical scenario but currentTurnId left pointing at the abandoned turn
    //        (only endAgentBubble() called — the incomplete fix the critic warned against)
    // When:  the late reasoning frame arrives and passes the gate
    // Then:  appendReasoningChunk auto-opens a NEW bubble with a VISIBLE thinking block —
    //        demonstrating why the turnId drop is load-bearing, not defensive decoration
    const h = makeHarness();
    const currentTurnId: string | null = "T1"; // NOT nulled — the pre-fix state
    h.beginAgentBubble();
    h.appendReasoningChunk("visible reasoning mid-turn");
    const oldWrap = h.thinkingWrapEl;
    h.endAgentBubble(); // bubble closed, but the turnId gate still matches

    const lateFrame = { type: "reasoning", turnId: "T1", chunk: "late poison" } as const;
    if (lateFrame.turnId === currentTurnId) h.appendReasoningChunk(lateFrame.chunk);

    assert.notEqual(h.thinkingWrapEl, oldWrap, "counterfactual: the late frame auto-opens a NEW bubble");
    assert.equal(
      h.thinkingWrapEl._fe.classes.has("hidden"),
      false,
      "counterfactual: the new thinking block is VISIBLE with no turn left to ever hide it — the exact stuck-thinking symptom",
    );
  });
});

// ─── P-UI-THINK-OVERLAY extraction — app/scrolling.ts behavior byte-preserved ────────────────
// (The extraction funds the CMR-2 fix under app.ts's exhausted 800-line cap. Unlike app.ts these
// are REAL imports of the production module — no mirroring.)

describe("app/scrolling.ts — extracted scroll-pinning helpers preserve app.ts behavior (P-UI-THINK-OVERLAY)", () => {
  function makeScrollArea(scrollTop: number, scrollHeight: number, clientHeight: number): ScrollAreaLike {
    return { scrollTop, scrollHeight, clientHeight };
  }

  it("T-Scrolling.1: isNearBottom is true iff distance-to-bottom <= threshold (boundary inclusive)", () => {
    // Given: scrollHeight=600, clientHeight=400 → distance = 600 - (scrollTop + 400)
    // When:  probed at distance 50 (near), exactly 100 (boundary), and 200 (scrolled up)
    // Then:  true, true, false — matches the app.ts original's `distance <= AUTOSCROLL_PX`
    assert.equal(isNearBottom(makeScrollArea(150, 600, 400), 100), true, "distance 50 <= 100 must be near-bottom");
    assert.equal(
      isNearBottom(makeScrollArea(100, 600, 400), 100),
      true,
      "distance exactly 100 must be near-bottom (inclusive)",
    );
    assert.equal(isNearBottom(makeScrollArea(0, 600, 400), 100), false, "distance 200 > 100 must NOT be near-bottom");
  });

  it("T-Scrolling.2: scrollToBottomIfPinned scrolls to bottom when pinned, never when scrolled up", () => {
    // Given: a pinned area (distance 50) and a scrolled-up area (distance 200)
    // When:  scrollToBottomIfPinned runs on each
    // Then:  pinned → scrollTop = scrollHeight - clientHeight; scrolled-up → scrollTop untouched
    //        (matches conversationList.mock.test.ts T-PY2MA.Conv.6a/6b's contract exactly)
    const pinned = makeScrollArea(150, 600, 400);
    scrollToBottomIfPinned(pinned, 100);
    assert.equal(pinned.scrollTop, 200, "pinned area must scroll to bottom (600-400)");

    const scrolledUp = makeScrollArea(0, 600, 400);
    scrollToBottomIfPinned(scrolledUp, 100);
    assert.equal(scrolledUp.scrollTop, 0, "scrolled-up area must be left alone (preserve scrollback)");
  });

  it("T-Scrolling.3: app.ts delegates via scrollToBottomIfPinnedImpl(scrollAreaEl, AUTOSCROLL_PX) and no longer defines the bodies inline", () => {
    // Given: current app.ts source
    // When:  scanned for the delegating wrapper + the old inline bodies
    // Then:  the wrapper delegates to the extracted module; the inline distance computation is gone
    assert.ok(
      APP_TS.includes("scrollToBottomIfPinnedImpl(scrollAreaEl, AUTOSCROLL_PX)"),
      "app.ts must delegate to the extracted helper with its own scrollAreaEl + AUTOSCROLL_PX",
    );
    assert.ok(
      APP_TS.includes('from "./app/scrolling.js"'),
      "app.ts must import the extracted module via the established ./app/ leaf pattern",
    );
    assert.ok(
      !APP_TS.includes("const distance = sc.scrollHeight"),
      "the inline distance computation must no longer live in app.ts (moved to app/scrolling.ts)",
    );
  });
});
