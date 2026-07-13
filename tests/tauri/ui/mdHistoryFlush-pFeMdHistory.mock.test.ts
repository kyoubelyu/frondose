/**
 * P-FE-MD-HISTORY — endAgentBubble() finalize-flush of the rAF-coalesced markdown render.
 *
 * Bug (operator-reported 2026-07-13): the ACTIVE streamed answer renders markdown, but OLD
 * (finalized) agent bubbles freeze showing literal **, |, ## — because a `text` chunk landing in
 * the same animation-frame window as `done`/`error` left a scheduled-but-unfired rAF render, and
 * endAgentBubble() nulled activeAgentTextEl without flushing, so the orphaned frame no-op'd and
 * the bubble kept its last (intermediate, legitimately-literal mid-stream) parse forever.
 *
 * Fix under test (src/tauri/ui/app.ts endAgentBubble): synchronously flush
 * `renderMarkdownInto(document, activeAgentTextEl, activeAgentRawText)` BEFORE detaching.
 *
 * Strategy (same split as tests/tauri/ui/conversationList.mock.test.ts): app.ts is not directly
 * importable (boot() + mustGet() run on import), so source-structural assertions pin the flush's
 * presence + ordering in app.ts, and behavioral tests drive an inline simulation that mirrors the
 * production algorithm exactly — using the REAL renderMarkdownInto (via the render.js barrel;
 * R-Source.2 forbids leaf imports) and a controllable fake requestAnimationFrame queue.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/ui/mdHistoryFlush-pFeMdHistory.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { renderMarkdownInto } from "../../../src/tauri/ui/render.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const APP_TS = readFileSync(join(REPO, "src/tauri/ui/app.ts"), "utf-8");

// ─── Fake DOM (same recording-fake shape as markdownRenderer-tfeChat.mock.test.ts) ───

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
      toggle: (c: string, force?: boolean) => {
        const on = force ?? !fe.classes.has(c);
        if (on) fe.classes.add(c);
        else fe.classes.delete(c);
      },
    },
    setAttribute: (k: string, v: string) => {
      fe.attrs[k] = v;
    },
    getAttribute: (k: string) => fe.attrs[k] ?? null,
    appendChild: (child: { _fe: FakeEl }) => {
      fe.children.push(child._fe);
      return child;
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test stub shaped to satisfy DocumentLike
function makeFakeDoc(): any {
  return {
    documentElement: wrap(makeFakeEl("html")),
    getElementById: () => null,
    createElement: (tag: string) => wrap(makeFakeEl(tag)),
    createElementNS: (_ns: string, tag: string) => wrap(makeFakeEl(tag)),
  };
}

function flattenText(fe: FakeEl): string {
  if (fe.children.length === 0) return fe.text ?? "";
  return fe.children.map(flattenText).join("");
}

function findAll(fe: FakeEl, tag: string): FakeEl[] {
  const hits: FakeEl[] = [];
  if (fe.tag === tag) hits.push(fe);
  for (const c of fe.children) hits.push(...findAll(c, tag));
  return hits;
}

// ─── Inline simulation mirroring app.ts's streaming/finalize algorithm exactly ───
// (scheduleAgentTextRender / appendAgentChunk / endAgentBubble incl. the P-FE-MD-HISTORY flush;
// rAF is an injectable queue so tests control exactly when the coalesced frame fires.)

type Harness = {
  // biome-ignore lint/suspicious/noExplicitAny: fake ElementLike
  bubbleEl: any;
  appendAgentChunk: (chunk: string) => void;
  endAgentBubble: () => void;
  beginAgentBubble: () => void;
  fireFrame: () => void; // runs ALL queued rAF callbacks (in order)
  pendingFrames: () => number;
  renderCount: () => number;
};

function makeHarness(): Harness {
  const doc = makeFakeDoc();
  // biome-ignore lint/suspicious/noExplicitAny: fake ElementLike
  let activeAgentTextEl: any = null;
  let activeAgentRawText = "";
  let agentRenderScheduled = false;
  let renders = 0;
  const rafQueue: Array<() => void> = [];
  // biome-ignore lint/suspicious/noExplicitAny: latest bubble handle for post-finalize inspection
  let bubbleEl: any = null;

  function beginAgentBubble(): void {
    activeAgentTextEl = doc.createElement("div");
    activeAgentTextEl.classList.add("msg-agent-text");
    bubbleEl = activeAgentTextEl;
    activeAgentRawText = "";
  }

  function scheduleAgentTextRender(): void {
    if (agentRenderScheduled) return;
    agentRenderScheduled = true;
    rafQueue.push(() => {
      agentRenderScheduled = false;
      if (activeAgentTextEl === null) return; // turn ended before this frame ran
      renders++;
      renderMarkdownInto(doc, activeAgentTextEl, activeAgentRawText);
    });
  }

  function appendAgentChunk(chunk: string): void {
    if (activeAgentTextEl === null) beginAgentBubble();
    activeAgentRawText += chunk;
    scheduleAgentTextRender();
  }

  function endAgentBubble(): void {
    // P-FE-MD-HISTORY finalize-flush (mirrors app.ts): render BEFORE detaching.
    if (activeAgentTextEl !== null) {
      renders++;
      renderMarkdownInto(doc, activeAgentTextEl, activeAgentRawText);
    }
    activeAgentTextEl = null;
    activeAgentRawText = "";
  }

  return {
    get bubbleEl() {
      return bubbleEl;
    },
    appendAgentChunk,
    endAgentBubble,
    beginAgentBubble,
    fireFrame: () => {
      const queued = rafQueue.splice(0, rafQueue.length);
      for (const cb of queued) cb();
    },
    pendingFrames: () => rafQueue.length,
    renderCount: () => renders,
  };
}

// ─── Source-structural pins on app.ts ────────────────────────────────────────

describe("P-FE-MD-HISTORY source-structural — endAgentBubble flushes before detach (app.ts)", () => {
  it("T-MdHist.SRC.1: endAgentBubble contains the guarded renderMarkdownInto finalize-flush", () => {
    // Given: src/tauri/ui/app.ts post-fix
    // When:  the endAgentBubble function body is scanned
    // Then:  the flush line `if (activeAgentTextEl !== null) renderMarkdownInto(` is present
    const fnStart = APP_TS.indexOf("function endAgentBubble()");
    assert.ok(fnStart >= 0, "app.ts must define endAgentBubble()");
    const body = APP_TS.slice(fnStart, APP_TS.indexOf("\n}", fnStart) + 2);
    assert.ok(
      body.includes("if (activeAgentTextEl !== null) renderMarkdownInto("),
      "endAgentBubble must synchronously flush the markdown render (P-FE-MD-HISTORY fix)",
    );
  });

  it("T-MdHist.SRC.2: the finalize-flush runs BEFORE activeAgentTextEl is nulled (flush-before-detach ordering)", () => {
    // Given: the endAgentBubble function body
    // When:  the index of the flush is compared to the index of `activeAgentTextEl = null;`
    // Then:  flush comes first — flushing after detach cannot recover the final message
    const fnStart = APP_TS.indexOf("function endAgentBubble()");
    const body = APP_TS.slice(fnStart, APP_TS.indexOf("\n}", fnStart) + 2);
    const flushIdx = body.indexOf("renderMarkdownInto(");
    const detachIdx = body.indexOf("activeAgentTextEl = null;");
    assert.ok(flushIdx >= 0 && detachIdx >= 0, "endAgentBubble must contain both the flush and the detach");
    assert.ok(flushIdx < detachIdx, "the flush must run BEFORE activeAgentTextEl = null (P-FE-MD-HISTORY ordering)");
  });

  it("T-MdHist.SRC.3: both the done and error SSE cases finalize through endAgentBubble()", () => {
    // Given: app.ts handleEvent
    // When:  the `case "done":` and `case "error":` arms are scanned
    // Then:  each calls endAgentBubble() — both finalize paths get the flush (regression pin)
    const doneStart = APP_TS.indexOf('case "done":');
    const errorStart = APP_TS.indexOf('case "error":');
    assert.ok(doneStart >= 0 && errorStart >= 0, "handleEvent must have done + error cases");
    const doneArm = APP_TS.slice(doneStart, errorStart);
    const errorArm = APP_TS.slice(errorStart, APP_TS.indexOf("break;", errorStart));
    assert.ok(doneArm.includes("endAgentBubble()"), 'case "done" must call endAgentBubble()');
    assert.ok(errorArm.includes("endAgentBubble()"), 'case "error" must call endAgentBubble()');
  });
});

// ─── Behavioral — the race is closed (real renderMarkdownInto, controllable rAF) ───

describe("P-FE-MD-HISTORY behavioral — finalize-flush closes the done-before-frame race", () => {
  it("T-MdHist.1: when done arrives BEFORE the queued frame fires, the finalized bubble shows fully parsed markdown (no literal **)", () => {
    // Given: a chunk stream whose FIRST frame rendered an intermediate snapshot with an unclosed
    //        `**`, and whose final chunk (closing the bold) is still pending an unfired frame
    // When:  endAgentBubble() runs (done SSE) before that frame fires
    // Then:  the bubble contains a md-bold span and no literal ** anywhere
    const h = makeHarness();
    h.appendAgentChunk("Here is **imp"); // frame 1 scheduled
    h.fireFrame(); // renders the intermediate snapshot — literal "**imp" visible (by design mid-stream)
    assert.ok(flattenText(h.bubbleEl._fe).includes("**"), "pre-condition: mid-stream snapshot shows literal **");
    h.appendAgentChunk("ortant** advice."); // frame 2 scheduled…
    h.endAgentBubble(); // …but done lands first (the race) — flush must save it
    const spans = findAll(h.bubbleEl._fe, "span").filter((s) => s.classes.has("md-bold"));
    assert.equal(spans.length, 1, "finalized bubble must contain the parsed bold span");
    assert.equal(flattenText(spans[0]), "important", "bold span must contain the joined cross-chunk text");
    assert.ok(!flattenText(h.bubbleEl._fe).includes("**"), "no literal ** may remain after finalize-flush");
  });

  it("T-MdHist.2: a table completed by the final chunk renders as a real <table> after finalize, not a frozen pipe paragraph", () => {
    // Given: an intermediate frame rendered the header row as a plain paragraph (no separator yet),
    //        then the separator+body rows arrive in a final chunk with no frame before done
    // When:  endAgentBubble() flushes
    // Then:  the bubble contains a <table> with the header + 1 body row
    const h = makeHarness();
    h.appendAgentChunk("| Name | Role |\n");
    h.fireFrame(); // header-only pipe block → paragraph fallback (documented streaming degradation)
    assert.equal(findAll(h.bubbleEl._fe, "table").length, 0, "pre-condition: no table mid-stream");
    h.appendAgentChunk("| --- | --- |\n| Ana | CEO |\n");
    h.endAgentBubble(); // done before the second frame — flush must promote the table
    const tables = findAll(h.bubbleEl._fe, "table");
    assert.equal(tables.length, 1, "finalized bubble must contain the parsed <table>");
    assert.equal(findAll(tables[0], "td").length, 2, "table body row must have 2 cells (Ana, CEO)");
  });

  it("T-MdHist.3: the orphaned frame firing AFTER finalize is a harmless no-op (no crash, finalized DOM unchanged)", () => {
    // Given: a finalized bubble (flush done, activeAgentTextEl detached) with its stale frame queued
    // When:  the orphaned rAF callback finally fires
    // Then:  it returns without rendering (null target) and the finalized DOM is untouched
    const h = makeHarness();
    h.appendAgentChunk("**done** text");
    h.endAgentBubble(); // flush; the chunk's frame is still queued
    const before = JSON.stringify(h.bubbleEl._fe);
    const rendersBefore = h.renderCount();
    h.fireFrame(); // orphaned frame
    assert.equal(h.renderCount(), rendersBefore, "orphaned frame must not render (null-target guard)");
    assert.equal(JSON.stringify(h.bubbleEl._fe), before, "finalized bubble DOM must be byte-identical");
  });

  it("T-MdHist.4: rAF coalescing is preserved — a burst of chunks still renders at most once per frame", () => {
    // Given: three chunks appended with no frame fired in between
    // When:  the single queued frame fires
    // Then:  exactly ONE render ran and it reflects all three chunks (regression guard for T-FE-CHAT)
    const h = makeHarness();
    h.appendAgentChunk("a ");
    h.appendAgentChunk("b ");
    h.appendAgentChunk("c");
    assert.equal(h.pendingFrames(), 1, "burst must coalesce into a single queued frame");
    h.fireFrame();
    assert.equal(h.renderCount(), 1, "exactly one render per frame");
    assert.equal(flattenText(h.bubbleEl._fe), "a b c", "the coalesced render must include all chunks");
  });

  it("T-MdHist.5: a new turn's bubble does not inherit the previous turn's text after finalize", () => {
    // Given: turn 1 finalized via the flush path
    // When:  turn 2 begins and streams its own chunk + fires its frame
    // Then:  turn 2's bubble contains only turn 2's text (raw buffer was reset at finalize)
    const h = makeHarness();
    h.appendAgentChunk("turn one text");
    h.endAgentBubble();
    h.beginAgentBubble();
    h.appendAgentChunk("turn two");
    h.fireFrame();
    assert.equal(flattenText(h.bubbleEl._fe), "turn two", "turn 2 bubble must not contain turn 1 text");
  });

  it("T-MdHist.6: finalize with no streamed text renders nothing and does not throw (reasoning-only turn)", () => {
    // Given: a bubble opened by turn-started that received zero text chunks
    // When:  endAgentBubble() runs
    // Then:  no throw; the bubble stays empty
    const h = makeHarness();
    h.beginAgentBubble();
    h.endAgentBubble();
    assert.equal(flattenText(h.bubbleEl._fe), "", "empty turn must finalize to an empty bubble");
  });
});
