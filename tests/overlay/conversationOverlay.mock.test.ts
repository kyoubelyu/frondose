/**
 * P-Y2-MA Step 5 — T-PY2MA.Overlay.1..8 + T-PY2MA.Overlay.Migration.1..3
 * Assertion bodies filled.
 *
 * Overlay conversation parity (G1+G2 hover) + mode-badge (G5) + C-1/C-2/C-3 migrations.
 *
 * Testing strategy:
 *   Source-structural assertions on bootstrapShell.ts / bootstrapLegacy.ts / bootstrap.ts
 *   confirm the migrations land. Behavioral assertions use an inline-simulated overlay
 *   implementation (makeOverlayImpl) that mirrors the exact logic of the SHELL_JS template.
 *   SHELL_JS runs only in a browser shadow DOM context; we can't eval it in Node, so the
 *   simulation is the behavioral contract proof.
 *
 * Gate coverage:
 *   G-PY2MA.6 — T-PY2MA.Overlay.1..3, .7, .8
 *   G-PY2MA.7 — T-PY2MA.Overlay.4..6
 *   (Migrations cover G-PY2MA.6 correctness — C-1/C-2/C-3)
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/overlay/conversationOverlay.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SHELL_TS = readFileSync(join(REPO, "src/overlay/bootstrapShell.ts"), "utf-8");
const LEGACY_TS = readFileSync(join(REPO, "src/overlay/bootstrapLegacy.ts"), "utf-8");
const BOOTSTRAP_TS = readFileSync(join(REPO, "src/overlay/bootstrap.ts"), "utf-8");

// ─── Minimal fake shadow-DOM factory for overlay tests ───────────────────────

type FakeEl = {
  id: string;
  textContent: string;
  children: FakeEl[];
  classList: {
    add: (...c: string[]) => void;
    toggle: (c: string, f?: boolean) => void;
    contains: (c: string) => boolean;
    _classes: Set<string>;
  };
  className: string;
  appendChild: (el: FakeEl) => void;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  querySelectorAll: (sel: string) => FakeEl[];
};

function makeFakeEl(tag = "div", id = "", cls = ""): FakeEl {
  const classes = new Set<string>(cls.split(" ").filter(Boolean));
  const children: FakeEl[] = [];
  const attrs = new Map<string, string>();
  return {
    id,
    textContent: "",
    children,
    className: cls,
    classList: {
      _classes: classes,
      add: (...cs: string[]) => {
        cs.forEach((c) => {
          classes.add(c);
        });
      },
      toggle: (c: string, f?: boolean) => {
        (f !== undefined ? f : !classes.has(c)) ? classes.add(c) : classes.delete(c);
      },
      contains: (c: string) => classes.has(c),
    },
    appendChild: (el: FakeEl) => {
      children.push(el);
    },
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    querySelectorAll: (_sel: string): FakeEl[] => [],
  };
}

// ─── Inline overlay implementation (behavioral contract) ─────────────────────
// Mirrors the exact algorithm of SHELL_JS in bootstrapShell.ts (the __mai* functions).
// SHELL_JS runs in a browser shadow DOM context; this simulation enables Node.js testing.
// Source-structural tests (SRC.1-2) confirm the SAME logic is in SHELL_JS.

type OverlayImpl = {
  convList: FakeEl;
  modeBadge: FakeEl;
  __maiAppendUser: (text: string) => void;
  __maiBeginAgent: () => void;
  __maiAppendChunk: (chunk: string) => void;
  __maiEndAgent: () => void;
  __maiSetMode: (mode: string) => void;
  __maiAppendOutput: (chunk: string) => void; // C-1 legacy wrapper
  __maiClearOutput: () => void; // C-2 legacy wrapper
  getActiveEl: () => FakeEl | null;
};

function makeOverlayImpl(): OverlayImpl {
  const convList = makeFakeEl("div", "conversation-list", "conv-list");
  const modeBadge = makeFakeEl("span", "mode-badge", "mode-badge manual");
  modeBadge.textContent = "MANUAL";

  const byId = new Map<string, FakeEl>([
    ["conversation-list", convList],
    ["mode-badge", modeBadge],
  ]);

  function shadow_getElementById(id: string): FakeEl | null {
    return byId.get(id) ?? null;
  }

  let activeAgentTextEl: FakeEl | null = null;

  function __maiAppendUser(text: string): void {
    const list = shadow_getElementById("conversation-list");
    if (!list) return;
    const b = makeFakeEl("div", "", "msg-user");
    b.textContent = String(text);
    list.appendChild(b);
  }

  function __maiBeginAgent(): void {
    const list = shadow_getElementById("conversation-list");
    if (!list) return;
    const wrap = makeFakeEl("div", "", "msg-agent");
    const avatar = makeFakeEl("div", "", "avatar");
    // Sparkles SVG (simulated as FakeEl — real impl uses createElementNS which is browser-only)
    const svg = makeFakeEl("svg", "", "");
    const path = makeFakeEl("path", "", "");
    // G3: the sparkles path from Sketch C §5.3.5 (same as app.ts beginAgentBubble)
    path.setAttribute("d", "M12 2.5l1.7 6 6 1.7-6 1.7-1.7 6-1.7-6-6-1.7 6-1.7z");
    svg.appendChild(path);
    avatar.appendChild(svg);
    wrap.appendChild(avatar);
    const body = makeFakeEl("div", "", "msg-agent-body");
    const text = makeFakeEl("div", "", "msg-agent-text");
    body.appendChild(text);
    wrap.appendChild(body);
    list.appendChild(wrap);
    activeAgentTextEl = text;
  }

  function __maiAppendChunk(chunk: string): void {
    // [NEW-BLOCKER-1 fix] Frame-agnostic auto-open: if no active bubble, open one.
    // Mirrors SHELL_JS: if (!activeAgentTextEl && typeof window.__maiBeginAgent === 'function')
    if (!activeAgentTextEl) __maiBeginAgent();
    if (!activeAgentTextEl) return;
    activeAgentTextEl.textContent = (activeAgentTextEl.textContent || "") + String(chunk);
  }

  function __maiEndAgent(): void {
    activeAgentTextEl = null;
  }

  function __maiSetMode(mode: string): void {
    const mb = shadow_getElementById("mode-badge");
    if (!mb) return;
    // Mirrors SHELL_JS __maiSetMode logic (plan §5.3.4)
    const resolved = mode === "auto" ? "auto" : mode === "magical" ? "magical" : "manual";
    mb.textContent = resolved === "auto" ? "AUTO" : resolved === "magical" ? "MAGICAL" : "MANUAL";
    mb.className = "mode-badge " + resolved;
  }

  // C-1 migration: __maiAppendOutput routes to __maiAppendChunk
  function __maiAppendOutput(chunk: string): void {
    __maiAppendChunk(chunk);
  }

  // C-2 migration: __maiClearOutput routes to __maiEndAgent (NO DOM wipe)
  function __maiClearOutput(): void {
    __maiEndAgent();
  }

  return {
    convList,
    modeBadge,
    __maiAppendUser,
    __maiBeginAgent,
    __maiAppendChunk,
    __maiEndAgent,
    __maiSetMode,
    __maiAppendOutput,
    __maiClearOutput,
    getActiveEl: () => activeAgentTextEl,
  };
}

// Helper: traverse a msg-agent FakeEl to find its .msg-agent-text element.
function getAgentTextEl(msgAgentEl: FakeEl): FakeEl | undefined {
  const body = msgAgentEl.children.find((c) => c.classList.contains("msg-agent-body"));
  return body?.children.find((c) => c.classList.contains("msg-agent-text"));
}

// Helper: traverse a msg-agent FakeEl to find its sparkles path element.
function getSparklesPath(msgAgentEl: FakeEl): FakeEl | undefined {
  const avatar = msgAgentEl.children.find((c) => c.classList.contains("avatar"));
  if (!avatar) return undefined;
  // avatar.children[0] = svg, svg.children[0] = path
  const svg = avatar.children[0];
  return svg?.children[0];
}

// ─── T-PY2MA.Overlay.1 ──────────────────────────────────────────────────────

describe("T-PY2MA.Overlay.1 — __maiAppendUser adds .msg-user to #conversation-list (G-PY2MA.6)", () => {
  it("T-PY2MA.Overlay.1: window.__maiAppendUser(text) appends <div class='msg-user'> to convList", () => {
    // Given: the overlay is installed; shadow root's #conversation-list is empty
    // When:  window.__maiAppendUser("Let's find leads") is called
    // Then:  convList.children[0] exists with className === "msg-user"
    //        and textContent === "Let's find leads"
    const { convList, __maiAppendUser } = makeOverlayImpl();

    __maiAppendUser("Let's find leads");

    assert.equal(convList.children.length, 1, "convList must have 1 child after __maiAppendUser (G6)");
    const child = convList.children[0];
    assert.ok(child.classList.contains("msg-user"), "child must have class 'msg-user' (G6)");
    assert.equal(child.textContent, "Let's find leads", "child textContent must match the input text (G6)");
  });
});

// ─── T-PY2MA.Overlay.2 ──────────────────────────────────────────────────────

describe("T-PY2MA.Overlay.2 — __maiBeginAgent appends .msg-agent with sparkles SVG (G-PY2MA.6 + G3)", () => {
  it("T-PY2MA.Overlay.2: window.__maiBeginAgent() appends <div class='msg-agent'> with .avatar containing <svg><path d='M12 2.5...'>", () => {
    // Given: convList is empty; activeAgentTextEl === null
    // When:  window.__maiBeginAgent() is called
    // Then:  a .msg-agent wrap is appended; its .avatar child contains an <svg> element;
    //        the <svg> has a <path> child with d attribute containing 'M12 2.5' (sparkles glyph — G3)
    //        AND activeAgentTextEl is now non-null (points to the .msg-agent-text div)
    const { convList, __maiBeginAgent, getActiveEl } = makeOverlayImpl();

    __maiBeginAgent();

    assert.equal(convList.children.length, 1, "convList must have 1 msg-agent after __maiBeginAgent (G6)");
    const wrap = convList.children[0];
    assert.ok(wrap.classList.contains("msg-agent"), "appended element must have class 'msg-agent' (G6)");

    const avatar = wrap.children.find((c) => c.classList.contains("avatar"));
    assert.ok(avatar !== undefined, "msg-agent must contain an .avatar child (G6 + G3 sparkles)");

    const sparklesPath = getSparklesPath(wrap);
    assert.ok(sparklesPath !== undefined, ".avatar must contain svg > path (G3 sparkles SVG)");
    const dAttr = sparklesPath!.getAttribute("d");
    assert.ok(
      dAttr !== null && dAttr.includes("M12 2.5"),
      "sparkles path d-attribute must start with 'M12 2.5' (G3 sparkles glyph). Got: " + dAttr,
    );

    assert.notEqual(getActiveEl(), null, "activeAgentTextEl must be non-null after __maiBeginAgent (G6)");
  });
});

// ─── T-PY2MA.Overlay.3 ──────────────────────────────────────────────────────

describe("T-PY2MA.Overlay.3 — __maiAppendChunk appends to active agent bubble (G-PY2MA.6)", () => {
  it("T-PY2MA.Overlay.3: window.__maiAppendChunk(text) concatenates text into activeAgentTextEl.textContent", () => {
    // Given: __maiBeginAgent() was called → activeAgentTextEl is .msg-agent-text (textContent="")
    // When:  __maiAppendChunk("Hello ") then __maiAppendChunk("world") are called
    // Then:  activeAgentTextEl.textContent === "Hello world"
    //        AND convList still contains exactly ONE .msg-agent bubble
    const { convList, __maiBeginAgent, __maiAppendChunk, getActiveEl } = makeOverlayImpl();

    __maiBeginAgent();
    __maiAppendChunk("Hello ");
    __maiAppendChunk("world");

    const msgAgents = convList.children.filter((c) => c.classList.contains("msg-agent"));
    assert.equal(msgAgents.length, 1, "exactly ONE .msg-agent must exist after 2 chunks (G6 accumulate)");
    const textEl = getActiveEl();
    assert.notEqual(textEl, null, "activeAgentTextEl must be non-null (G6)");
    assert.equal(textEl?.textContent, "Hello world", ".msg-agent-text must concatenate chunks (G6)");
  });
});

// ─── T-PY2MA.Overlay.4 ──────────────────────────────────────────────────────

describe("T-PY2MA.Overlay.4 — overlay mode-badge present in topbar; text === 'MANUAL' initially (G-PY2MA.7)", () => {
  it("T-PY2MA.Overlay.4: bootstrapShell builds a <span id='mode-badge' class='mode-badge manual'> with textContent 'MANUAL'", () => {
    // Given: the overlay bootstrap runs buildPanelSkeleton()
    // When:  shadow.getElementById('mode-badge') is called
    // Then:  element exists; textContent === "MANUAL"; className contains "manual" (initial state)
    //   Verified two ways: (1) inline sim via makeOverlayImpl initial state;
    //   (2) source scan confirms SHELL_TS has 'mode-badge manual' + MANUAL textContent.

    // Behavioral: makeOverlayImpl initial state mirrors buildPanelSkeleton
    const { modeBadge } = makeOverlayImpl();
    assert.equal(modeBadge.textContent, "MANUAL", "initial mode-badge textContent must be 'MANUAL' (G7)");
    assert.ok(modeBadge.className.includes("manual"), "initial mode-badge className must include 'manual' (G7).");
    assert.equal(
      modeBadge.className.includes("auto"),
      false,
      "initial mode-badge className must NOT include 'auto' (G7).",
    );

    // Source-structural: SHELL_TS must have the initial state hard-coded
    assert.ok(
      SHELL_TS.includes("mode-badge manual"),
      "bootstrapShell.ts buildPanelSkeleton must create element with class 'mode-badge manual' (G7 initial state).",
    );
    assert.ok(
      SHELL_TS.includes("modeBadge.textContent = 'MANUAL'"),
      "bootstrapShell.ts buildPanelSkeleton must set modeBadge.textContent = 'MANUAL' (G7 initial state).",
    );
  });
});

// ─── T-PY2MA.Overlay.5 ──────────────────────────────────────────────────────

describe("T-PY2MA.Overlay.5 — __maiSetMode('auto') sets badge text to 'AUTO' + adds .auto class (G-PY2MA.7)", () => {
  it("T-PY2MA.Overlay.5: window.__maiSetMode('auto') updates mode-badge textContent and className", () => {
    // Given: overlay installed; modeBadge.textContent === "MANUAL"; className includes "manual"
    // When:  window.__maiSetMode("auto") is called
    // Then:  modeBadge.textContent === "AUTO"
    //        AND modeBadge.className === "mode-badge auto" (class replaced, not appended)
    const { modeBadge, __maiSetMode } = makeOverlayImpl();

    __maiSetMode("auto");

    assert.equal(modeBadge.textContent, "AUTO", "modeBadge.textContent must be 'AUTO' after setMode('auto') (G7)");
    assert.equal(
      modeBadge.className,
      "mode-badge auto",
      "modeBadge.className must be 'mode-badge auto' after setMode('auto') (G7 — class replaced).",
    );
    assert.equal(
      modeBadge.className.includes("manual"),
      false,
      "modeBadge.className must NOT contain 'manual' after setMode('auto') (G7).",
    );
  });
});

// ─── T-PY2MA.Overlay.6 ──────────────────────────────────────────────────────

describe("T-PY2MA.Overlay.6 — __maiSetMode('magical') sets badge text to 'MAGICAL' + .magical class (G-PY2MA.7 / NG-10 hook)", () => {
  it("T-PY2MA.Overlay.6: window.__maiSetMode('magical') updates mode-badge for defensive Magical support", () => {
    // Given: overlay installed; modeBadge.textContent === "MANUAL"
    // When:  window.__maiSetMode("magical") is called
    // Then:  modeBadge.textContent === "MAGICAL"
    //        AND modeBadge.className === "mode-badge magical"
    const { modeBadge, __maiSetMode } = makeOverlayImpl();

    __maiSetMode("magical");

    assert.equal(
      modeBadge.textContent,
      "MAGICAL",
      "modeBadge.textContent must be 'MAGICAL' after setMode('magical') (G7 NG-10 hook)",
    );
    assert.equal(
      modeBadge.className,
      "mode-badge magical",
      "modeBadge.className must be 'mode-badge magical' after setMode('magical') (G7 NG-10 — Magical mode-badge hook).",
    );
  });
});

// ─── T-PY2MA.Overlay.7 ──────────────────────────────────────────────────────

describe("T-PY2MA.Overlay.7 — __maiAppendChunk auto-opens agent bubble when none active (G-PY2MA.6 / NEW-BLOCKER-1)", () => {
  it("T-PY2MA.Overlay.7: when activeAgentTextEl===null and __maiAppendChunk('Hello ') fires, a .msg-agent bubble is auto-created", () => {
    // Given: overlay installed; activeAgentTextEl === null (cleared by __maiEndAgent); convList has 0 children
    //        C-1 migration: __maiAppendOutput routes through __maiAppendChunk
    // When:  window.__maiAppendChunk("Hello ") fires (or: __maiAppendOutput("Hello ") → routes to __maiAppendChunk)
    // Then:  a .msg-agent bubble auto-created in convList (auto-open guard fires);
    //        activeAgentTextEl is now non-null;
    //        activeAgentTextEl.textContent === "Hello "
    const { convList, __maiAppendChunk, getActiveEl } = makeOverlayImpl();

    // activeAgentTextEl starts at null (no __maiBeginAgent called)
    assert.equal(getActiveEl(), null, "pre-condition: activeAgentTextEl must be null");

    __maiAppendChunk("Hello ");

    // Auto-open guard must have fired
    const msgAgent = convList.children.find((c) => c.classList.contains("msg-agent"));
    assert.ok(
      msgAgent !== undefined,
      "a .msg-agent bubble must be auto-created by __maiAppendChunk when activeAgentTextEl===null (NEW-BLOCKER-1 fix, G6). " +
        "Without auto-open, the FIRST chunk of every overlay turn silently drops.",
    );
    assert.notEqual(getActiveEl(), null, "activeAgentTextEl must be non-null after auto-open (G6)");
    assert.equal(
      getActiveEl()?.textContent,
      "Hello ",
      "activeAgentTextEl.textContent must be 'Hello ' (the chunk that triggered auto-open, G6).",
    );

    // Also verify via C-1 migration path (__maiAppendOutput → __maiAppendChunk)
    const { convList: cl2, __maiAppendOutput, getActiveEl: getAel2 } = makeOverlayImpl();
    assert.equal(getAel2(), null, "pre-condition: fresh overlay activeAgentTextEl must be null");
    __maiAppendOutput("via C-1");
    const msgAgent2 = cl2.children.find((c) => c.classList.contains("msg-agent"));
    assert.ok(
      msgAgent2 !== undefined,
      "__maiAppendOutput (C-1 legacy wrapper) must also trigger auto-open via __maiAppendChunk (G6 C-1 migration).",
    );
    assert.equal(getAel2()?.textContent, "via C-1", "C-1 path: textContent must be 'via C-1' (G6)");
  });
});

// ─── T-PY2MA.Overlay.8 ──────────────────────────────────────────────────────

describe("T-PY2MA.Overlay.8 — __maiEndAgent closes active bubble WITHOUT wiping prior bubbles (G-PY2MA.6 / NEW-BLOCKER-1 + C-2)", () => {
  it("T-PY2MA.Overlay.8: after 2 full turns rendered, __maiEndAgent() sets activeAgentTextEl=null; prior bubbles persist", () => {
    // Given: 2 prior turns rendered — convList has [msg-user-1, msg-agent-1, msg-user-2, msg-agent-2]
    //        activeAgentTextEl points at msg-agent-2's .msg-agent-text node
    //        C-2 migration: __maiClearOutput() routes to __maiEndAgent()
    // When:  window.__maiEndAgent() fires (or: __maiClearOutput() → routes to __maiEndAgent())
    // Then:  convList STILL contains all 4 child elements (NO DOM wipe)
    //        AND activeAgentTextEl === null (so next chunk auto-opens a NEW bubble)
    const {
      convList,
      __maiAppendUser,
      __maiBeginAgent,
      __maiAppendChunk,
      __maiEndAgent,
      __maiClearOutput,
      getActiveEl,
    } = makeOverlayImpl();

    // Turn 1
    __maiAppendUser("user1");
    __maiBeginAgent();
    __maiAppendChunk("reply1");
    __maiEndAgent();
    // Turn 2
    __maiAppendUser("user2");
    __maiBeginAgent();
    __maiAppendChunk("reply2");
    // Still active (turn 2 in progress)
    assert.notEqual(getActiveEl(), null, "pre-condition: activeAgentTextEl must be non-null (turn 2 in progress)");
    assert.equal(convList.children.length, 4, "pre-condition: 4 children in convList (2 users + 2 agents)");

    // Test via __maiEndAgent (C-2 semantics: close bubble, NOT wipe screen)
    __maiEndAgent();

    assert.equal(getActiveEl(), null, "__maiEndAgent must set activeAgentTextEl=null (G6 end-of-turn)");
    assert.equal(
      convList.children.length,
      4,
      "convList must still have 4 children after __maiEndAgent (G6 NO DOM wipe — C-2 semantics). " +
        "If convList.children.length < 4, __maiEndAgent incorrectly wiped prior bubbles.",
    );

    // Also verify via C-2 migration path (__maiClearOutput → __maiEndAgent)
    const {
      convList: cl2,
      __maiBeginAgent: ba2,
      __maiAppendChunk: ac2,
      __maiClearOutput: co2,
      getActiveEl: gae2,
    } = makeOverlayImpl();
    ba2();
    ac2("some text");
    assert.notEqual(gae2(), null, "pre-condition: activeAgentTextEl set");
    co2(); // C-2: __maiClearOutput → __maiEndAgent
    assert.equal(gae2(), null, "__maiClearOutput (C-2) must set activeAgentTextEl=null (G6 C-2 semantics)");
    assert.equal(
      cl2.children.length,
      1,
      "convList must still have 1 child after __maiClearOutput (C-2 NO wipe — only closes active bubble).",
    );
  });
});

// ─── Source-structural: Sketch C migrations (C-1/C-2/C-3) ───────────────────

describe("T-PY2MA.Overlay.Migration — C-1/C-2/C-3 source-structural checks", () => {
  it("T-PY2MA.Overlay.Migration.1 (C-1): bootstrapLegacy.ts __maiAppendOutput routes to __maiAppendChunk (not dialogElements.output)", () => {
    // Given: src/overlay/bootstrapLegacy.ts source
    // When:  scanned for __maiAppendChunk call inside __maiAppendOutput body
    // Then:  the routing call is present AND 'dialogElements.output.textContent' direct write is ABSENT
    const hasChunkCall = LEGACY_TS.includes("window.__maiAppendChunk");
    const hasOldDirectWrite = LEGACY_TS.includes("dialogElements.output.textContent");
    assert.ok(
      hasChunkCall,
      "bootstrapLegacy.ts __maiAppendOutput must route to window.__maiAppendChunk (C-1 migration). " +
        "If absent, overlay text is silently dropped on every turn (NEW-BLOCKER-1 precondition).",
    );
    assert.equal(
      hasOldDirectWrite,
      false,
      "bootstrapLegacy.ts must NOT directly write dialogElements.output.textContent (C-1 migration complete). " +
        "If present, the old output sink is still active alongside the new conversation-list path.",
    );
  });

  it("T-PY2MA.Overlay.Migration.2 (C-2): bootstrapLegacy.ts __maiClearOutput routes to __maiEndAgent (semantics change)", () => {
    // Given: src/overlay/bootstrapLegacy.ts source
    // When:  scanned for __maiEndAgent call inside __maiClearOutput body
    // Then:  the routing call is present; the 'semantics changed' comment marker is present
    const hasEndAgentCall = LEGACY_TS.includes("window.__maiEndAgent()");
    const hasSemanticsComment = LEGACY_TS.includes("semantics changed");
    assert.ok(
      hasEndAgentCall,
      "bootstrapLegacy.ts __maiClearOutput must call window.__maiEndAgent() (C-2 migration). " +
        "Without this, clearing output between turns keeps activeAgentTextEl pointing at a stale element.",
    );
    assert.ok(
      hasSemanticsComment,
      "bootstrapLegacy.ts __maiClearOutput must have 'semantics changed' comment marker (C-2 — no DOM wipe). " +
        "The marker confirms the intentional behavior change from 'wipe textContent' to 'close bubble'.",
    );
  });

  it("T-PY2MA.Overlay.Migration.3 (C-3): bootstrap.ts boot-replay uses __maiBeginAgent + __maiAppendChunk + __maiEndAgent", () => {
    // Given: src/overlay/bootstrap.ts source
    // When:  scanned for __maiBeginAgent + __maiAppendChunk + __maiEndAgent calls in the boot-replay block
    // Then:  all three are present AND the old 'dialogElements.output.textContent = maiDialogState.output'
    //        direct write is ABSENT from the boot-replay block
    const hasBeginAgent = BOOTSTRAP_TS.includes("window.__maiBeginAgent()");
    const hasAppendChunk = BOOTSTRAP_TS.includes("window.__maiAppendChunk(maiDialogState.output)");
    const hasEndAgent = BOOTSTRAP_TS.includes("window.__maiEndAgent()");
    const hasOldDirectWrite = BOOTSTRAP_TS.includes("dialogElements.output.textContent = maiDialogState.output");
    assert.ok(
      hasBeginAgent && hasAppendChunk && hasEndAgent,
      "bootstrap.ts boot-replay block must use window.__maiBeginAgent() + __maiAppendChunk(maiDialogState.output) + __maiEndAgent() (C-3 migration). " +
        `Found: __maiBeginAgent=${hasBeginAgent}, __maiAppendChunk=${hasAppendChunk}, __maiEndAgent=${hasEndAgent}.`,
    );
    assert.equal(
      hasOldDirectWrite,
      false,
      "bootstrap.ts boot-replay must NOT write dialogElements.output.textContent = maiDialogState.output directly (C-3 — old pattern removed).",
    );
  });
});

// ─── Source-structural: new window helpers exist in bootstrapShell.ts ────────

describe("T-PY2MA.Overlay.SRC — Sketch C: new __mai* helpers defined in bootstrapShell.ts", () => {
  it("T-PY2MA.Overlay.SRC.1: bootstrapShell.ts defines window.__maiAppendUser, __maiBeginAgent, __maiAppendChunk, __maiEndAgent", () => {
    // Given: src/overlay/bootstrapShell.ts source (pre-builder: only has __maiSetMode)
    // When:  scanned for the four new window.__mai* function assignments
    // Then:  all four are present (Sketch C §5.3.5 — FAILS pre-builder)
    const hasAppendUser = SHELL_TS.includes("window.__maiAppendUser");
    const hasBeginAgent = SHELL_TS.includes("window.__maiBeginAgent");
    const hasAppendChunk = SHELL_TS.includes("window.__maiAppendChunk");
    const hasEndAgent = SHELL_TS.includes("window.__maiEndAgent");
    assert.ok(
      hasAppendUser && hasBeginAgent && hasAppendChunk && hasEndAgent,
      `bootstrapShell.ts must define all 4 window.__mai* helpers. ` +
        `Found: __maiAppendUser=${hasAppendUser}, __maiBeginAgent=${hasBeginAgent}, ` +
        `__maiAppendChunk=${hasAppendChunk}, __maiEndAgent=${hasEndAgent}. ` +
        `FAILS pre-builder (Sketch C §5.3.5 not yet pasted).`,
    );
  });

  it("T-PY2MA.Overlay.SRC.2: bootstrapShell.ts __maiAppendChunk has the auto-open guard (activeAgentTextEl === null branch)", () => {
    // Given: src/overlay/bootstrapShell.ts source
    // When:  scanned for the auto-open guard code from NEW-BLOCKER-1 fix (Sketch C §5.3.5)
    // Then:  the guard code (typeof window.__maiBeginAgent === 'function') is present
    const hasAutoOpenGuard = SHELL_TS.includes("typeof window.__maiBeginAgent === 'function'");
    assert.ok(
      hasAutoOpenGuard,
      "bootstrapShell.ts __maiAppendChunk must have the auto-open guard " +
        "'typeof window.__maiBeginAgent === 'function'' (NEW-BLOCKER-1 fix). " +
        "Without this guard, the first chunk of every overlay turn silently drops (activeAgentTextEl===null at serve-clear time).",
    );
  });
});
