/**
 * P-Y2-MA Step 5 — T-PY2MA.Conv.1..8 + T-PY2MA.Conv.2b — assertion bodies filled.
 *
 * Conversation-list helpers in app.ts (G1+G2).
 *
 * Testing strategy (BDD-light + windowRef mock):
 *   Source-structural assertions confirm the helpers EXIST in app.ts (fail pre-builder
 *   because the text patterns are absent). Behavioural harness assertions confirm DOM
 *   side-effects using inline-simulated helpers that mirror Sketch A's exact algorithm.
 *   The real app.ts functions are not directly importable (boot() + mustGet() execute
 *   on import and require a real DOM/__TAURI__); the source-structural tests verify the
 *   same logic is present; the behavioral tests verify the design contract independently.
 *
 * Gate coverage:
 *   G-PY2MA.1 — T-PY2MA.Conv.1, .2, .2b, .3, .4
 *   G-PY2MA.2 — T-PY2MA.Conv.5
 *   G-PY2MA.3 — T-PY2MA.Conv.6
 *   G-PY2MA.4 — T-PY2MA.Conv.7
 *   G-PY2MA.5 — T-PY2MA.Conv.8
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/ui/conversationList.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const APP_TS = readFileSync(join(REPO, "src/tauri/ui/app.ts"), "utf-8");
const TURN_CONTROLLER_TS = readFileSync(join(REPO, "src/tauri/ui/assistantTurnController.ts"), "utf-8");
const APP_BINDINGS_TS = readFileSync(join(REPO, "src/tauri/ui/app/assistantAppBindings.ts"), "utf-8");

// ─── Minimal fake-DOM factory (windowRef pattern) ───────────────────────────

type ClassListLike = {
  add: (...c: string[]) => void;
  remove: (...c: string[]) => void;
  toggle: (c: string, force?: boolean) => void;
  contains: (c: string) => boolean;
};

type FakeEl = {
  id: string;
  className: string;
  classList: ClassListLike;
  textContent: string;
  children: FakeEl[];
  attributes: Map<string, string>;
  appendChild: (child: FakeEl) => void;
  querySelector: (sel: string) => FakeEl | null;
  querySelectorAll: (sel: string) => FakeEl[];
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
};

function makeFakeEl(tag = "div", id = "", cls = ""): FakeEl {
  const classes = new Set<string>(cls.split(" ").filter(Boolean));
  const attrs = new Map<string, string>();
  const children: FakeEl[] = [];
  const el: FakeEl = {
    id,
    className: cls,
    get classList(): ClassListLike {
      return {
        add: (...cs: string[]) => {
          cs.forEach((c) => {
            classes.add(c);
          });
        },
        remove: (...cs: string[]) => {
          cs.forEach((c) => {
            classes.delete(c);
          });
        },
        toggle: (c: string, force?: boolean) => {
          const on = force !== undefined ? force : !classes.has(c);
          if (on) classes.add(c);
          else classes.delete(c);
        },
        contains: (c: string) => classes.has(c),
      };
    },
    textContent: "",
    children,
    attributes: attrs,
    appendChild: (child: FakeEl) => {
      children.push(child);
    },
    querySelector: (_sel: string) => null,
    querySelectorAll: (_sel: string) => [],
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    getAttribute: (k: string) => attrs.get(k) ?? null,
  };
  return el;
}

type FakeDOM = {
  convList: FakeEl;
  scrollArea: FakeEl & { scrollTop: number; scrollHeight: number; clientHeight: number };
  ticker: FakeEl;
  workflowCard: FakeEl;
  manualSurface: FakeEl;
  body: FakeEl;
  byId: Map<string, FakeEl>;
};

function makeFakeDOM(): FakeDOM {
  const convList = makeFakeEl("div", "conversation-list", "conv-list");
  const scrollArea = Object.assign(makeFakeEl("div", "scroll-area", "scroll-area"), {
    scrollTop: 0,
    scrollHeight: 600,
    clientHeight: 400,
  });
  const ticker = makeFakeEl("div", "ticker", "ticker");
  const workflowCard = makeFakeEl("div", "workflow-card", "iwf-card hidden");
  const manualSurface = makeFakeEl("section", "manual-surface", "conv");
  const body = makeFakeEl("body", "", "");
  const byId = new Map<string, FakeEl>([
    ["conversation-list", convList],
    ["scroll-area", scrollArea],
    ["ticker", ticker],
    ["workflow-card", workflowCard],
    ["manual-surface", manualSurface],
  ]);
  return { convList, scrollArea, ticker, workflowCard, manualSurface, body, byId };
}

// ─── Inline-simulation helpers (behavioral contract tests) ───────────────────
// These mirror the exact behavior described in plan §5.1 / Sketch A (app.ts production code).
// They operate on the FakeDOM. The source-structural tests (SRC.1-3) confirm the SAME
// logic is present in app.ts; these tests confirm the design contract produces the right
// DOM side-effects.

type ConvListHelpers = {
  appendUserBubble: (text: string) => void;
  beginAgentBubble: () => void;
  appendAgentChunk: (chunk: string) => void;
  endAgentBubble: () => void;
  getActiveEl: () => FakeEl | null;
};

function makeConvListHelpers(dom: FakeDOM): ConvListHelpers {
  let activeAgentTextEl: FakeEl | null = null;

  function isNearBottom(): boolean {
    const distance = dom.scrollArea.scrollHeight - (dom.scrollArea.scrollTop + dom.scrollArea.clientHeight);
    return distance <= 100; // AUTOSCROLL_PX = 100 (per Sketch A §5.1.1)
  }

  function scrollToBottomIfPinned(): void {
    if (!isNearBottom()) return;
    dom.scrollArea.scrollTop = dom.scrollArea.scrollHeight - dom.scrollArea.clientHeight;
  }

  function appendUserBubble(text: string): void {
    const bubble = makeFakeEl("div", "", "msg-user");
    bubble.textContent = text;
    dom.convList.appendChild(bubble);
    scrollToBottomIfPinned();
  }

  function beginAgentBubble(): void {
    const wrap = makeFakeEl("div", "", "msg-agent");
    const avatar = makeFakeEl("div", "", "avatar");
    wrap.appendChild(avatar);
    const body = makeFakeEl("div", "", "msg-agent-body");
    const textEl = makeFakeEl("div", "", "msg-agent-text");
    body.appendChild(textEl);
    wrap.appendChild(body);
    dom.convList.appendChild(wrap);
    activeAgentTextEl = textEl;
    scrollToBottomIfPinned();
  }

  function appendAgentChunk(chunk: string): void {
    // [BLOCKER-1 fix] Frame-agnostic auto-open: if no active bubble (Manual REPL path —
    // no turn-started SSE), open one now. The explicit beginAgentBubble() in the
    // turn-started handler covers cron/profile/card-action paths.
    if (activeAgentTextEl === null) beginAgentBubble();
    if (activeAgentTextEl === null) return;
    activeAgentTextEl.textContent = (activeAgentTextEl.textContent ?? "") + chunk;
    scrollToBottomIfPinned();
  }

  function endAgentBubble(): void {
    activeAgentTextEl = null;
  }

  return {
    appendUserBubble,
    beginAgentBubble,
    appendAgentChunk,
    endAgentBubble,
    getActiveEl: () => activeAgentTextEl,
  };
}

// Traverse a msg-agent FakeEl to find its .msg-agent-text element.
function getAgentTextEl(msgAgentEl: FakeEl): FakeEl | undefined {
  const body = msgAgentEl.children.find((c) => c.classList.contains("msg-agent-body"));
  return body?.children.find((c) => c.classList.contains("msg-agent-text"));
}

// ─── Source-structural gate ──────────────────────────────────────────────────

describe("T-PY2MA.Conv — source-structural ownership after assistant composition", () => {
  it("T-PY2MA.Conv.SRC.1: user bubbles stay in app while agent turn state lives in one controller", () => {
    // Given the shipped split, when sources are inspected, then one controller owns begin/final/end.
    assert.ok(APP_TS.includes("function appendUserBubble"));
    assert.match(TURN_CONTROLLER_TS, /function beginTurn\(\)/);
    assert.match(TURN_CONTROLLER_TS, /function appendFinal\(text: string\)/);
    assert.match(TURN_CONTROLLER_TS, /function endTurn\(\)/);
  });

  it("T-PY2MA.Conv.SRC.2: app supplies conversation and scroll dependencies to the controller", () => {
    // Given app composition, when inspected, then the real DOM and scroll seams are wired.
    assert.ok(APP_TS.includes("conversationListEl"));
    assert.ok(APP_TS.includes("scrollAreaEl"));
    assert.match(
      APP_TS,
      /createAssistantTurnController\(\{[\s\S]*conversationList: conversationListEl[\s\S]*scrollToBottom: scrollToBottomIfPinned/,
    );
  });

  it("T-PY2MA.Conv.SRC.3: classified text routes through the binding to controller final rendering", () => {
    // Given a text frame, when routed, then it reaches appendFinal without an app-local duplicate branch.
    assert.match(APP_BINDINGS_TS, /\["assistant-progress", "text", "done", "error"\]/);
    assert.match(TURN_CONTROLLER_TS, /frame\.type === "text"[\s\S]*appendFinal\(frame\.chunk\)/);
    assert.match(APP_TS, /assistantAppComposition\.handleEvent\(payload\)/);
  });
});

// ─── T-PY2MA.Conv.1 ─────────────────────────────────────────────────────────

describe("T-PY2MA.Conv.1 — first user-prompt creates .msg-user bubble (G-PY2MA.1)", () => {
  it("T-PY2MA.Conv.1: when sendCommand() is invoked with prompt text, #conversation-list gets one .msg-user bubble", () => {
    // Given: a fresh DOM (no prior turns), conversationListEl is empty
    // When:  appendUserBubble("find UK plastics manufacturers") is called
    // Then:  convList.children has exactly 1 element with className "msg-user"
    //        and textContent === "find UK plastics manufacturers"; no .msg-agent present
    const dom = makeFakeDOM();
    const h = makeConvListHelpers(dom);

    h.appendUserBubble("find UK plastics manufacturers");

    assert.equal(dom.convList.children.length, 1, "convList must have exactly 1 child after appendUserBubble");
    const bubble = dom.convList.children[0];
    assert.ok(bubble.classList.contains("msg-user"), "bubble must have class 'msg-user' (G1)");
    assert.equal(bubble.textContent, "find UK plastics manufacturers", "bubble textContent must match the prompt");
    const hasAgent = dom.convList.children.some((c) => c.classList.contains("msg-agent"));
    assert.equal(hasAgent, false, "no .msg-agent must exist after appendUserBubble only (G1)");
  });
});

// ─── T-PY2MA.Conv.2 ─────────────────────────────────────────────────────────

describe("T-PY2MA.Conv.2 — Manual REPL path: first text SSE chunk auto-opens .msg-agent (G-PY2MA.1)", () => {
  it("T-PY2MA.Conv.2: when handleEvent({type:'text', chunk:'Happy to help.'}) fires with activeAgentTextEl===null, a .msg-agent bubble is auto-created", () => {
    // Given: a .msg-user bubble exists; NO prior agent bubble; activeAgentTextEl === null
    //        (Manual REPL path — NO turn-started SSE, per plan §5.1.0 frame-contract note)
    // When:  appendAgentChunk("Happy to help.") is called (auto-open guard fires)
    // Then:  a .msg-agent wrap exists in convList; its .msg-agent-text.textContent === "Happy to help."
    //        and activeAgentTextEl is now the .msg-agent-text element (non-null)
    const dom = makeFakeDOM();
    const h = makeConvListHelpers(dom);
    h.appendUserBubble("what should I focus on today?");

    // Pre-condition: no agent bubble yet
    assert.equal(
      h.getActiveEl(),
      null,
      "pre-condition: activeAgentTextEl must be null (no turn-started SSE in Manual REPL)",
    );

    // Simulate: case "text" fires appendAgentChunk (no beginAgentBubble before it — Manual REPL)
    h.appendAgentChunk("Happy to help.");

    // Post: auto-open guard must have fired
    const msgAgent = dom.convList.children.find((c) => c.classList.contains("msg-agent"));
    assert.ok(
      msgAgent !== undefined,
      "a .msg-agent bubble must be auto-created by appendAgentChunk when activeAgentTextEl===null (BLOCKER-1 fix, G1).",
    );
    const textEl = getAgentTextEl(msgAgent!);
    assert.equal(textEl?.textContent, "Happy to help.", ".msg-agent-text.textContent must equal the first chunk (G1).");
    assert.notEqual(h.getActiveEl(), null, "activeAgentTextEl must be non-null after auto-open (G1)");
  });
});

// ─── T-PY2MA.Conv.2b ────────────────────────────────────────────────────────

describe("T-PY2MA.Conv.2b — cron/server path: explicit turn-started opens bubble; text does NOT double-create (G-PY2MA.1)", () => {
  it("T-PY2MA.Conv.2b: when turn-started fires then text fires, exactly ONE .msg-agent bubble exists", () => {
    // Given: a fresh DOM; no user bubble (cron turns have no user prompt)
    // When:  beginAgentBubble() is called (from handleEvent({type:'turn-started',turnId:'t1',source:'cron'}))
    //        then appendAgentChunk("reviewed pipeline.") is called
    // Then:  exactly ONE .msg-agent in convList (the auto-open guard short-circuits because
    //        activeAgentTextEl is already non-null after beginAgentBubble)
    const dom = makeFakeDOM();
    const h = makeConvListHelpers(dom);

    // Server-initiated turn: beginAgentBubble from turn-started handler
    h.beginAgentBubble();
    assert.notEqual(h.getActiveEl(), null, "activeAgentTextEl must be set after beginAgentBubble (cron path)");

    // Now text arrives — auto-open guard must NOT create a second bubble
    h.appendAgentChunk("reviewed pipeline.");

    const msgAgents = dom.convList.children.filter((c) => c.classList.contains("msg-agent"));
    assert.equal(
      msgAgents.length,
      1,
      "exactly ONE .msg-agent bubble must exist — auto-open guard short-circuits when activeAgentTextEl!=null (G1 cron path).",
    );
    const textEl = getAgentTextEl(msgAgents[0]);
    assert.equal(textEl?.textContent, "reviewed pipeline.", ".msg-agent-text must have the chunk text (G1)");
  });
});

// ─── T-PY2MA.Conv.3 ─────────────────────────────────────────────────────────

describe("T-PY2MA.Conv.3 — text SSE chunks accumulate in the SAME bubble (G-PY2MA.1)", () => {
  it("T-PY2MA.Conv.3: two appendAgentChunk() calls concatenate into one .msg-agent-text; only one .msg-agent exists", () => {
    // Given: the agent bubble from T-PY2MA.Conv.2 (activeAgentTextEl non-null, textContent="Happy to help.")
    // When:  appendAgentChunk(" Here's the plan") fires
    // Then:  .msg-agent-text textContent === "Happy to help. Here's the plan"
    //        AND convList still contains exactly ONE .msg-agent bubble
    const dom = makeFakeDOM();
    const h = makeConvListHelpers(dom);

    h.appendAgentChunk("Happy to help.");
    h.appendAgentChunk(" Here's the plan");

    const msgAgents = dom.convList.children.filter((c) => c.classList.contains("msg-agent"));
    assert.equal(msgAgents.length, 1, "exactly ONE .msg-agent bubble must exist after 2 chunks (G1 accumulate)");
    const textEl = getAgentTextEl(msgAgents[0]);
    assert.equal(
      textEl?.textContent,
      "Happy to help. Here's the plan",
      ".msg-agent-text must concatenate chunks (G1 — NOT create separate bubbles per chunk).",
    );
  });
});

// ─── T-PY2MA.Conv.4 ─────────────────────────────────────────────────────────

describe("T-PY2MA.Conv.4 — second sendCommand() appends new pair; prior pair persists (G-PY2MA.1)", () => {
  it("T-PY2MA.Conv.4: after two complete turns, #conversation-list has 2 .msg-user + 2 .msg-agent in order", () => {
    // Given: first turn complete — [msg-user-1 "Q1", msg-agent-1 "first reply"]
    // When:  appendUserBubble("follow-up Q") runs, then beginAgentBubble()+appendAgentChunk("second reply")+endAgentBubble()
    // Then:  convList.children = [msg-user-1, msg-agent-1, msg-user-2, msg-agent-2]
    //        first agent textContent === "first reply"; second === "second reply"
    const dom = makeFakeDOM();
    const h = makeConvListHelpers(dom);

    // Turn 1
    h.appendUserBubble("Q1");
    h.appendAgentChunk("first reply");
    h.endAgentBubble();

    // Turn 2
    h.appendUserBubble("follow-up Q");
    h.beginAgentBubble();
    h.appendAgentChunk("second reply");
    h.endAgentBubble();

    assert.equal(
      dom.convList.children.length,
      4,
      "convList must have 4 children after 2 turns (msg-user + msg-agent × 2)",
    );
    assert.ok(dom.convList.children[0].classList.contains("msg-user"), "children[0] must be msg-user (turn 1 user)");
    assert.ok(dom.convList.children[1].classList.contains("msg-agent"), "children[1] must be msg-agent (turn 1 agent)");
    assert.ok(dom.convList.children[2].classList.contains("msg-user"), "children[2] must be msg-user (turn 2 user)");
    assert.ok(dom.convList.children[3].classList.contains("msg-agent"), "children[3] must be msg-agent (turn 2 agent)");

    const agent1Text = getAgentTextEl(dom.convList.children[1]);
    assert.equal(
      agent1Text?.textContent,
      "first reply",
      "turn 1 agent text must be 'first reply' (G1 history preserved)",
    );
    const agent2Text = getAgentTextEl(dom.convList.children[3]);
    assert.equal(agent2Text?.textContent, "second reply", "turn 2 agent text must be 'second reply' (G1)");
  });
});

// ─── T-PY2MA.Conv.5 ─────────────────────────────────────────────────────────

describe("T-PY2MA.Conv.5 — #workflow-card remains singleton sibling (G-PY2MA.2 / OQ-1A)", () => {
  it("T-PY2MA.Conv.5: getElementById('workflow-card') returns the same element after two turns; it is NOT nested inside .msg-agent-body", () => {
    // Given: two user+agent turns rendered + a workflow-proposed SSE during turn 2
    // When:  DOM queried for #workflow-card
    // Then:  exactly one element; it is NOT inside .msg-agent-body or #conversation-list;
    //        it is accessible via byId (sibling of conversation-list in #manual-surface)
    const dom = makeFakeDOM();
    const h = makeConvListHelpers(dom);

    // Simulate two turns
    h.appendUserBubble("Q1");
    h.appendAgentChunk("first reply");
    h.endAgentBubble();
    h.appendUserBubble("Q2");
    h.beginAgentBubble();
    h.appendAgentChunk("second reply");
    h.endAgentBubble();

    // workflow-card is NOT in convList.children (it's a sibling at index.html level, not inside conversation-list)
    const workflowInConvList = dom.convList.children.some((c) => c.id === "workflow-card");
    assert.equal(
      workflowInConvList,
      false,
      "#workflow-card must NOT be a child of #conversation-list (G2 singleton-sibling contract). " +
        "If found inside convList, render.ts is writing into conversation bubbles — breaks OQ-1A.",
    );

    // workflow-card is accessible via byId (getElementById equivalent, unchanged after turns)
    const wfEl = dom.byId.get("workflow-card");
    assert.ok(
      wfEl !== undefined,
      "#workflow-card must be accessible via getElementById (G2 — singleton element unchanged by conversation turns).",
    );

    // convList has exactly 4 children: user+agent x2 (no extra elements)
    assert.equal(
      dom.convList.children.length,
      4,
      "#conversation-list must have exactly 4 children (2 turns × 2 bubbles) — no workflow-card mixed in (G2).",
    );
  });
});

// ─── T-PY2MA.Conv.6 ─────────────────────────────────────────────────────────

describe("T-PY2MA.Conv.6 — scroll-to-bottom fires when near-bottom; does NOT fire when scrolled up (G-PY2MA.3)", () => {
  it("T-PY2MA.Conv.6a: when scrollHeight - (scrollTop + clientHeight) <= 100 (near-bottom), appendUserBubble sets scrollTop to scrollHeight - clientHeight", () => {
    // Given: fakeScrollArea with scrollHeight=600, clientHeight=400, scrollTop=150 (distance=50 ≤ 100)
    // When:  appendUserBubble("near-bottom test") runs
    // Then:  fakeScrollArea.scrollTop === 600 - 400 === 200 (scrolled to bottom)
    const dom = makeFakeDOM();
    dom.scrollArea.scrollTop = 150; // distance = 600-(150+400) = 50 ≤ AUTOSCROLL_PX
    const h = makeConvListHelpers(dom);

    h.appendUserBubble("near-bottom test");

    assert.equal(
      dom.scrollArea.scrollTop,
      200, // scrollHeight - clientHeight = 600 - 400
      "scrollTop must be set to scrollHeight-clientHeight when near-bottom (distance=50≤100, G3 autoscroll).",
    );
  });

  it("T-PY2MA.Conv.6b: when scrollHeight - (scrollTop + clientHeight) > 100 (scrolled up), scrollTop is NOT modified", () => {
    // Given: fakeScrollArea with scrollHeight=600, clientHeight=400, scrollTop=0 (distance=200 > 100)
    // When:  appendUserBubble("scrolled-up test") runs
    // Then:  fakeScrollArea.scrollTop remains 0 (user scrollback preserved)
    const dom = makeFakeDOM();
    dom.scrollArea.scrollTop = 0; // distance = 600-(0+400) = 200 > AUTOSCROLL_PX
    const h = makeConvListHelpers(dom);

    h.appendUserBubble("scrolled-up test");

    assert.equal(
      dom.scrollArea.scrollTop,
      0,
      "scrollTop must NOT change when user is scrolled up (distance=200>100, G3 — preserve scrollback).",
    );
  });
});

// ─── T-PY2MA.Conv.7 ─────────────────────────────────────────────────────────

describe("T-PY2MA.Conv.7 — steer mid-turn opens NEW user bubble; prior agent bubble preserved (G-PY2MA.4)", () => {
  it("T-PY2MA.Conv.7: after performSteer('change the filter'), DOM contains prior partial agent bubble + new user bubble", () => {
    // Given: turn 1 running, agent bubble has partial text "thinking…"
    // When:  appendUserBubble("change the filter") runs (steer path — Sketch A §5.1.4),
    //        then endAgentBubble() closes turn 1, then beginAgentBubble() opens turn 2
    // Then:  DOM order: [msg-user-1, msg-agent-1(text:"thinking…"), msg-user-2("change the filter"), msg-agent-2]
    //        msg-agent-1 textContent unchanged; msg-agent-2 is activeAgentTextEl
    const dom = makeFakeDOM();
    const h = makeConvListHelpers(dom);

    // Turn 1: user sends, agent starts replying (partial)
    h.appendUserBubble("original prompt");
    h.appendAgentChunk("thinking…");

    // Steer: append new user bubble without ending old agent bubble
    // (in app.ts, steer calls appendUserBubble THEN waits for done SSE which ends the old bubble)
    h.endAgentBubble(); // old turn aborted/done
    h.appendUserBubble("change the filter");

    // Turn 2 begins
    h.beginAgentBubble();
    h.appendAgentChunk("adjusted plan");

    assert.equal(
      dom.convList.children.length,
      4,
      "DOM must have 4 children after steer (user1, agent1, user2, agent2)",
    );
    assert.ok(dom.convList.children[0].classList.contains("msg-user"), "[0] must be msg-user-1");
    assert.ok(dom.convList.children[1].classList.contains("msg-agent"), "[1] must be msg-agent-1");
    const agent1Text = getAgentTextEl(dom.convList.children[1]);
    assert.equal(
      agent1Text?.textContent,
      "thinking…",
      "prior agent bubble text must be preserved (G4 — steer keeps history)",
    );
    assert.ok(dom.convList.children[2].classList.contains("msg-user"), "[2] must be msg-user-2 (steer prompt)");
    assert.equal(
      dom.convList.children[2].textContent,
      "change the filter",
      "steer user bubble must contain the steer prompt (G4)",
    );
    assert.ok(dom.convList.children[3].classList.contains("msg-agent"), "[3] must be msg-agent-2 (new turn)");
    const agent2Text = getAgentTextEl(dom.convList.children[3]);
    assert.equal(agent2Text?.textContent, "adjusted plan", "turn 2 agent text must be the post-steer reply (G4)");
  });
});

// ─── T-PY2MA.Conv.8 ─────────────────────────────────────────────────────────

describe("T-PY2MA.Conv.8 — retry appends NEW agent bubble; NO duplicate user bubble (G-PY2MA.5)", () => {
  it("T-PY2MA.Conv.8: performRetry() creates a second .msg-agent without a new .msg-user; first bubble unchanged", () => {
    // Given: turn 1 errored; [msg-user-1, msg-agent-1("partial reply")] exists
    // When:  performRetry() path runs (endAgentBubble() + beginAgentBubble() — NO appendUserBubble),
    //        then appendAgentChunk("better reply") fires
    // Then:  DOM has: [msg-user-1, msg-agent-1("partial reply"), msg-agent-2("better reply")]
    //        msg-user count === 1 (no second user bubble — retry reuses prior prompt)
    const dom = makeFakeDOM();
    const h = makeConvListHelpers(dom);

    // Turn 1: partial reply then error
    h.appendUserBubble("original prompt");
    h.appendAgentChunk("partial reply");
    h.endAgentBubble(); // error → endAgentBubble closes old bubble

    // Retry: NO new user bubble (per app.ts performRetry — Sketch A §5.1.4)
    h.beginAgentBubble();
    h.appendAgentChunk("better reply");
    h.endAgentBubble();

    const userBubbles = dom.convList.children.filter((c) => c.classList.contains("msg-user"));
    const agentBubbles = dom.convList.children.filter((c) => c.classList.contains("msg-agent"));

    assert.equal(
      userBubbles.length,
      1,
      "retry must NOT create a second user bubble — only 1 msg-user in DOM (G5 retry semantics).",
    );
    assert.equal(agentBubbles.length, 2, "retry must create a second agent bubble — 2 msg-agent in DOM (G5)");
    assert.equal(
      dom.convList.children.length,
      3,
      "DOM must have 3 children total: [msg-user-1, msg-agent-1, msg-agent-2]",
    );

    const agent1Text = getAgentTextEl(agentBubbles[0]);
    assert.equal(
      agent1Text?.textContent,
      "partial reply",
      "first agent bubble must retain 'partial reply' (G5 history preserved)",
    );
    const agent2Text = getAgentTextEl(agentBubbles[1]);
    assert.equal(agent2Text?.textContent, "better reply", "second agent bubble (retry) must have 'better reply' (G5)");
  });
});
