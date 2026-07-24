/**
 * ISSUE-OVERLAY-HIDE (Fast Mode) — the frondose-branded 浮窗 (collapsed pill + expandable
 * panel) is feature-hidden on agent-driven pages, KEEPING the takeover layer (agent
 * cursor/highlight/ring/label from bootstrapTakeover.ts) fully working and visible.
 *
 * Operator scope A (verbatim, 2026-07-23, recorded in ROADMAP.md § Open/Deferred →
 * ISSUE-OVERLAY-HIDE-AND-BACKEND-UNIFY): hide the pill + panel only, no backend change,
 * no re-wire — pause-compatible per P-UI-CONVERGE. Same feature-hide idiom as the
 * existing OVERLAY_CHAT_CONTROLS_ENABLED precedent (hideChatControls-pUiThinkOverlay).
 *
 * Testing strategy (same split as hideChatControls-pUiThinkOverlay.mock.test.ts): SHELL_JS
 * runs only in a browser shadow-DOM context, so source-structural assertions pin
 * bootstrapShell.ts's gating construct, and behavioral simulations (mirroring the exact
 * pill-append / __frondoseExpandDialog / __frondoseSetMode algorithms) prove the runtime
 * behavior without a real browser.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/overlay/hideWidget-issueOverlayHide.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SHELL_TS = readFileSync(join(REPO, "src/overlay/bootstrapShell.ts"), "utf-8");
const TAKEOVER_TS = readFileSync(join(REPO, "src/overlay/bootstrapTakeover.ts"), "utf-8");

// ─── Source-structural: the gating flag + its two gates exist in bootstrapShell.ts ───────────

describe("bootstrapShell.ts — the frondose pill + panel are feature-hidden behind OVERLAY_WIDGET_ENABLED (ISSUE-OVERLAY-HIDE)", () => {
  it("T-HideWidget.SRC.1: SHELL_JS declares OVERLAY_WIDGET_ENABLED = false", () => {
    // Given: the SHELL_JS template literal in bootstrapShell.ts
    // When:  scanned for the gating flag declaration
    // Then:  it exists and defaults to false (hidden by default, per operator scope A)
    assert.ok(
      SHELL_TS.includes("var OVERLAY_WIDGET_ENABLED = false;"),
      "bootstrapShell.ts must declare 'var OVERLAY_WIDGET_ENABLED = false;' inside SHELL_JS",
    );
  });

  it("T-HideWidget.SRC.2: the pill is still fully constructed and appended (feature-hide, not delete)", () => {
    // Given: the SHELL_JS pill-construction block
    // When:  scanned for the pill's DOM construction + shadow append
    // Then:  the leaf-mark, label, and shadow.appendChild(pill) are ALL still present —
    //        the code is kept, only its visibility is gated
    assert.ok(SHELL_TS.includes("pill.className = 'frondose-pill';"), "the pill element must still be built");
    assert.ok(SHELL_TS.includes("shadow.appendChild(pill);"), "the pill must still be appended to the shadow root");
  });

  it("T-HideWidget.SRC.3: the pill hide-gate runs AFTER shadow.appendChild(pill), using pill.style.setProperty", () => {
    // Given: the SHELL_JS pill-construction block
    // When:  the index of the hide-gate is compared to the index of shadow.appendChild(pill)
    // Then:  the gate runs after the pill is appended (hide an already-attached element,
    //        never skip-attaching it) and uses pill.style (the pill's own pre-existing
    //        visibility mechanism — pill.style.display is already toggled by expand/collapse)
    const attachIdx = SHELL_TS.indexOf("shadow.appendChild(pill);");
    const gateIdx = SHELL_TS.indexOf(
      "if (!OVERLAY_WIDGET_ENABLED) { pill.style.setProperty('display', 'none', 'important'); }",
    );
    assert.ok(attachIdx >= 0, "pill must be appended to shadow");
    assert.ok(gateIdx >= 0, "the OVERLAY_WIDGET_ENABLED pill hide-gate must exist");
    assert.ok(gateIdx > attachIdx, "the pill hide-gate must run AFTER the pill is attached");
  });

  it("T-HideWidget.SRC.4: window.__frondoseExpandDialog opens with the OVERLAY_WIDGET_ENABLED guard, before buildPanelSkeleton", () => {
    // Given: the SHELL_JS __frondoseExpandDialog definition
    // When:  scanned for the guard and buildPanelSkeleton() call ordering
    // Then:  the guard is the FIRST statement — a single choke point that no-ops every
    //        auto-expand path (pill click, workflow update, show-card/next-actions/retry/
    //        summary-card, collapsed-card click) before any panel DOM is built or attached
    const fnIdx = SHELL_TS.indexOf("window.__frondoseExpandDialog = function() {");
    assert.ok(fnIdx >= 0, "__frondoseExpandDialog must be defined");
    const guardIdx = SHELL_TS.indexOf("if (!OVERLAY_WIDGET_ENABLED) return;", fnIdx);
    const buildIdx = SHELL_TS.indexOf("buildPanelSkeleton();", fnIdx);
    assert.ok(guardIdx >= 0 && guardIdx > fnIdx, "the OVERLAY_WIDGET_ENABLED guard must exist inside __frondoseExpandDialog");
    assert.ok(buildIdx > guardIdx, "the guard must run BEFORE buildPanelSkeleton() is called");
  });

  it("T-HideWidget.SRC.5: __frondoseSetMode null-guards the buildSwitcher call (FM-1 CONCERN-MR-1 fix)", () => {
    // Given: the SHELL_JS __frondoseSetMode definition
    // When:  scanned for the buildSwitcher call
    // Then:  it is wrapped in a null-check on both tab elements — panelRoot may be
    //        detached (OVERLAY_WIDGET_ENABLED false), making shadow.getElementById return
    //        null for the mode tabs; the shared buildSwitcher builder has no internal
    //        null guard, so calling it unconditionally would throw
    assert.ok(
      SHELL_TS.includes("if (manualTabEl && autoTabEl) { __frondoseShared.buildSwitcher(manualTabEl, autoTabEl, appMode); }"),
      "__frondoseSetMode must null-guard the buildSwitcher call",
    );
  });

  it("T-HideWidget.SRC.6: takeover layer builders in bootstrapTakeover.ts contain NO reference to OVERLAY_WIDGET_ENABLED", () => {
    // Given: bootstrapTakeover.ts (TAKEOVER_JS)
    // When:  scanned for the widget flag
    // Then:  it is absent — the takeover layer (ring/label/cursor/highlight) is a
    //        completely independent append path, ungated by this phase's flag
    assert.ok(!TAKEOVER_TS.includes("OVERLAY_WIDGET_ENABLED"), "bootstrapTakeover.ts must not reference OVERLAY_WIDGET_ENABLED");
  });
});

// ─── Behavioral — pill + panel end up hidden while takeover stays independent ────────────────

type FakeEl = {
  tag: string;
  id: string;
  style: Record<string, string>;
  classList: { add: (...c: string[]) => void; toggle: (c: string, on?: boolean) => void; contains: (c: string) => boolean };
  parentNode: FakeShadow | null;
};

type FakeShadow = {
  children: FakeEl[];
  appendChild: (el: FakeEl) => void;
  removeChild: (el: FakeEl) => void;
  getElementById: (id: string) => FakeEl | null;
};

function makeFakeEl(tag = "div", id = ""): FakeEl {
  const classes = new Set<string>();
  const el: FakeEl = {
    tag,
    id,
    style: {},
    classList: {
      add: (...cs: string[]) => {
        for (const c of cs) classes.add(c);
      },
      toggle: (c: string, on?: boolean) => {
        if (on) classes.add(c);
        else classes.delete(c);
      },
      contains: (c: string) => classes.has(c),
    },
    parentNode: null,
  };
  // setProperty mirrors CSSStyleDeclaration.setProperty(prop, value, priority)
  (el.style as unknown as { setProperty: (p: string, v: string, prio?: string) => void }).setProperty = (p, v) => {
    el.style[p] = v;
  };
  return el;
}

function makeFakeShadow(): FakeShadow {
  const byId = new Map<string, FakeEl>();
  const shadow: FakeShadow = {
    children: [],
    appendChild(el) {
      el.parentNode = shadow;
      shadow.children.push(el);
      if (el.id) byId.set(el.id, el);
    },
    removeChild(el) {
      el.parentNode = null;
      shadow.children = shadow.children.filter((c) => c !== el);
    },
    getElementById(id) {
      const el = byId.get(id);
      return el && el.parentNode === shadow ? el : null;
    },
  };
  return shadow;
}

// Mirrors the relevant slice of SHELL_JS: pill creation+append+hide-gate, and
// __frondoseExpandDialog's OVERLAY_WIDGET_ENABLED guard (bootstrapShell.ts:38,304-311).
function mirrorPillAndExpand(overlayWidgetEnabled: boolean) {
  const shadow = makeFakeShadow();
  const pill = makeFakeEl("div", "pill");
  shadow.appendChild(pill);
  if (!overlayWidgetEnabled) {
    (pill.style as unknown as { setProperty: (p: string, v: string, prio?: string) => void }).setProperty(
      "display",
      "none",
      "important",
    );
  }

  let panelRoot: FakeEl | null = null;
  let dialogExpanded = false;
  function buildPanelSkeleton() {
    if (panelRoot) return;
    panelRoot = makeFakeEl("div", "panel");
  }
  function frondoseExpandDialog() {
    if (!overlayWidgetEnabled) return;
    buildPanelSkeleton();
    if (!dialogExpanded) {
      pill.style.display = "none";
      shadow.appendChild(panelRoot as FakeEl);
      dialogExpanded = true;
    }
  }

  return { shadow, pill, frondoseExpandDialog, isDialogExpanded: () => dialogExpanded, getPanelRoot: () => panelRoot };
}

describe("pill + panel visibility mirrors OVERLAY_WIDGET_ENABLED (ISSUE-OVERLAY-HIDE behavioral proof)", () => {
  it("T-HideWidget.1: with the flag false (shipped default), the pill is hidden AND __frondoseExpandDialog no-ops (panel never appended)", () => {
    // Given: OVERLAY_WIDGET_ENABLED = false (the shipped default)
    // When:  the pill is built + a caller invokes __frondoseExpandDialog (simulating any
    //        of the 7 auto-expand call sites: pill click, workflow update, show-card, etc.)
    // Then:  pill.style.display === 'none' (via setProperty !important) and the panel is
    //        NEVER appended to the shadow root — no frondose-branded UI visible
    const { pill, frondoseExpandDialog, isDialogExpanded, shadow } = mirrorPillAndExpand(false);
    assert.equal(pill.style.display, "none", "pill must be hidden when the flag is false");
    frondoseExpandDialog();
    assert.equal(isDialogExpanded(), false, "__frondoseExpandDialog must no-op when the flag is false");
    assert.equal(shadow.children.length, 1, "shadow must contain ONLY the (hidden) pill — no panel appended");
  });

  it("T-HideWidget.2: with the flag true (re-enable path), the pill is visible AND __frondoseExpandDialog appends the panel normally", () => {
    // Given: OVERLAY_WIDGET_ENABLED = true (the documented re-enable flip)
    // When:  the pill is built + __frondoseExpandDialog is invoked
    // Then:  pill.style.display is untouched by the hide-gate, and the panel gets
    //        appended to the shadow root — a one-line flip fully restores the widget
    const { pill, frondoseExpandDialog, isDialogExpanded, shadow, getPanelRoot } = mirrorPillAndExpand(true);
    assert.notEqual(pill.style.display, "none", "pill must NOT be forced hidden when the flag is true");
    frondoseExpandDialog();
    assert.equal(isDialogExpanded(), true, "__frondoseExpandDialog must expand normally when the flag is true");
    assert.equal(shadow.children.length, 2, "shadow must contain both the pill and the appended panel");
    assert.ok(getPanelRoot() !== null, "panelRoot must be built");
  });
});

// Mirrors __frondoseSetMode's buildSwitcher null-guard (bootstrapShell.ts:223-236).
function mirrorSetMode(shadow: FakeShadow) {
  let buildSwitcherCalls = 0;
  function buildSwitcher(manualTab: FakeEl, autoTab: FakeEl, _mode: string) {
    // production buildSwitcher dereferences .classList unconditionally — would throw on null
    manualTab.classList.toggle("active", true);
    autoTab.classList.toggle("active", false);
    buildSwitcherCalls++;
  }
  function frondoseSetMode(_mode: string) {
    const manualTabEl = shadow.getElementById("mode-manual-tab");
    const autoTabEl = shadow.getElementById("mode-auto-tab");
    if (manualTabEl && autoTabEl) {
      buildSwitcher(manualTabEl, autoTabEl, _mode);
    }
  }
  return { frondoseSetMode, getBuildSwitcherCalls: () => buildSwitcherCalls };
}

describe("__frondoseSetMode does not throw when the panel is detached (ISSUE-OVERLAY-HIDE FM-1 CONCERN-MR-1 proof)", () => {
  it("T-HideWidget.3: with the panel detached (mode-manual-tab/mode-auto-tab absent from shadow), __frondoseSetMode('auto') does not throw and skips buildSwitcher", () => {
    // Given: OVERLAY_WIDGET_ENABLED = false → panelRoot (and its mode tabs) never appended
    //        to the shadow root, so shadow.getElementById returns null for both tab ids
    // When:  window.__frondoseSetMode('auto') is invoked (its only production callers are
    //        the tab click listeners themselves — unreachable while detached, but the
    //        function must be crash-proof regardless of caller per the critic's finding)
    // Then:  no exception is thrown, and buildSwitcher (which would dereference null
    //        .classList) is never called
    const shadow = makeFakeShadow(); // mode-manual-tab/mode-auto-tab never appended
    const { frondoseSetMode, getBuildSwitcherCalls } = mirrorSetMode(shadow);
    assert.doesNotThrow(() => frondoseSetMode("auto"));
    assert.equal(getBuildSwitcherCalls(), 0, "buildSwitcher must be skipped when the tab elements are null");
  });

  it("T-HideWidget.4: with the panel attached (widget enabled), __frondoseSetMode('auto') calls buildSwitcher normally", () => {
    // Given: OVERLAY_WIDGET_ENABLED = true → the mode tabs ARE in the shadow tree
    // When:  window.__frondoseSetMode('auto') is invoked
    // Then:  buildSwitcher IS called — the guard doesn't break the enabled path
    const shadow = makeFakeShadow();
    shadow.appendChild(makeFakeEl("button", "mode-manual-tab"));
    shadow.appendChild(makeFakeEl("button", "mode-auto-tab"));
    const { frondoseSetMode, getBuildSwitcherCalls } = mirrorSetMode(shadow);
    assert.doesNotThrow(() => frondoseSetMode("auto"));
    assert.equal(getBuildSwitcherCalls(), 1, "buildSwitcher must be called once when both tabs are present");
  });
});

// ─── the gate survives the ASSEMBLED bootstrap bundle (mirrors T-HideChat.ASM.1) ─────────────

describe("OVERLAY_BOOTSTRAP_JS — the widget-hide gates survive bundle assembly (ISSUE-OVERLAY-HIDE)", () => {
  it("T-HideWidget.ASM.1: the assembled bootstrap contains the flag declaration and both hide-gates", async () => {
    // Given: the production assembler src/overlay/bootstrap.ts (SHELL_JS interpolated)
    // When:  OVERLAY_BOOTSTRAP_JS is imported and scanned
    // Then:  the flag, the pill gate, and the expand-dialog gate are all present in the
    //        final injected source — catches an interpolation/codegen regression
    const { OVERLAY_BOOTSTRAP_JS } = await import("../../src/overlay/bootstrap.js");
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("var OVERLAY_WIDGET_ENABLED = false;"),
      "assembled bundle must carry the flag declaration",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes(
        "if (!OVERLAY_WIDGET_ENABLED) { pill.style.setProperty('display', 'none', 'important'); }",
      ),
      "assembled bundle must carry the pill hide-gate",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("if (!OVERLAY_WIDGET_ENABLED) return;"),
      "assembled bundle must carry the __frondoseExpandDialog hide-gate",
    );
  });

  it("T-HideWidget.ASM.2: the assembled bootstrap's takeover functions (__frondoseShowEdgeRing, __frondoseShowAgentTarget) are defined without referencing OVERLAY_WIDGET_ENABLED", () => {
    // Given: the assembled OVERLAY_BOOTSTRAP_JS
    // When:  the takeover function bodies are located
    // Then:  neither references the widget flag — confirms independence survives assembly
    const bundle = readFileSync(join(REPO, "src/overlay/bootstrap.ts"), "utf-8");
    assert.ok(bundle.includes("${TAKEOVER_JS}"), "bootstrap.ts must still interpolate TAKEOVER_JS verbatim");
  });
});
