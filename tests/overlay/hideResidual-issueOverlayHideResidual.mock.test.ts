/**
 * ISSUE-OVERLAY-HIDE-RESIDUAL (Fast Mode) — two more frondose-branded document-level
 * widgets, the collapsed suggestion card and the cron banner, are feature-hidden on
 * agent-driven pages, reusing the SAME OVERLAY_WIDGET_ENABLED flag introduced by the
 * parent ISSUE-OVERLAY-HIDE phase (commit 3001c23, bootstrapShell.ts:37).
 *
 * Operator scope (2026-07-24, "approve, tag and cron banner"; "tag" = the collapsed
 * suggestion card): hide both, kill the collapsed card's click dead-end, keep the
 * takeover layer untouched. Pause-compatible feature-hide only — no re-wire, no backend
 * change (P-UI-CONVERGE stays deferred).
 *
 * Testing strategy (same split as hideWidget-issueOverlayHide.mock.test.ts): LEGACY_JS
 * runs only in a browser shadow-DOM/document context, so source-structural assertions
 * pin bootstrapLegacy.ts's gating construct, and behavioral simulations (mirroring the
 * exact show-card / show-cron-banner algorithms) prove the runtime behavior without a
 * real browser.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/overlay/hideResidual-issueOverlayHideResidual.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LEGACY_TS = readFileSync(join(REPO, "src/overlay/bootstrapLegacy.ts"), "utf-8");
const TAKEOVER_TS = readFileSync(join(REPO, "src/overlay/bootstrapTakeover.ts"), "utf-8");

// ─── Source-structural: both guards exist, first statement, right placement ──────────────────

describe("bootstrapLegacy.ts — the collapsed card + cron banner are feature-hidden behind OVERLAY_WIDGET_ENABLED (ISSUE-OVERLAY-HIDE-RESIDUAL)", () => {
  it("T-HideResidual.SRC.1: window.__frondoseShowCollapsedCard opens with the OVERLAY_WIDGET_ENABLED guard as its first statement", () => {
    // Given: the LEGACY_JS __frondoseShowCollapsedCard definition
    // When:  scanned for the guard vs the payload-parse line ordering
    // Then:  the guard is the FIRST statement — the card element, its click listener, and
    //        its auto-dismiss timer are never created at all when the flag is false
    const fnIdx = LEGACY_TS.indexOf("window.__frondoseShowCollapsedCard = function(payloadJson) {");
    assert.ok(fnIdx >= 0, "__frondoseShowCollapsedCard must be defined");
    const guardIdx = LEGACY_TS.indexOf("if (!OVERLAY_WIDGET_ENABLED) return;", fnIdx);
    const parseIdx = LEGACY_TS.indexOf("try { payload = JSON.parse(payloadJson); }", fnIdx);
    assert.ok(
      guardIdx >= 0 && guardIdx > fnIdx,
      "the OVERLAY_WIDGET_ENABLED guard must exist inside __frondoseShowCollapsedCard",
    );
    assert.ok(parseIdx > guardIdx, "the guard must run BEFORE the payload is parsed / any DOM is built");
  });

  it("T-HideResidual.SRC.2: window.__frondoseShowCronBanner opens with the OVERLAY_WIDGET_ENABLED guard, before the self-cleanup call", () => {
    // Given: the LEGACY_JS __frondoseShowCronBanner definition
    // When:  scanned for the guard vs the __frondoseHideCronBanner self-cleanup call ordering
    // Then:  the guard runs first — with the flag off, no banner was ever created by this
    //        installation, so skipping the self-cleanup call ahead of the guard is correct
    //        (FM-1 Codex critic: safe because the flag is fixed for one bootstrap install)
    const fnIdx = LEGACY_TS.indexOf("window.__frondoseShowCronBanner = function(text) {");
    assert.ok(fnIdx >= 0, "__frondoseShowCronBanner must be defined");
    const guardIdx = LEGACY_TS.indexOf("if (!OVERLAY_WIDGET_ENABLED) return;", fnIdx);
    const cleanupIdx = LEGACY_TS.indexOf(
      "if (window.__frondoseHideCronBanner) window.__frondoseHideCronBanner();",
      fnIdx,
    );
    assert.ok(
      guardIdx >= 0 && guardIdx > fnIdx,
      "the OVERLAY_WIDGET_ENABLED guard must exist inside __frondoseShowCronBanner",
    );
    assert.ok(cleanupIdx > guardIdx, "the guard must run BEFORE the self-cleanup call");
  });

  it("T-HideResidual.SRC.3: __frondoseHideCollapsedCard and __frondoseHideCronBanner are unchanged (no new guard needed — already no-ops when nothing was shown)", () => {
    // Given: the LEGACY_JS hide-function definitions
    // When:  scanned for their existing null-guards
    // Then:  both already guard on their tracked element being non-null — correct as-is,
    //        since the show-guards above prevent the element from ever being created
    assert.ok(
      LEGACY_TS.includes(
        "if (activeCardEl && activeCardEl.parentNode) {\n      activeCardEl.parentNode.removeChild(activeCardEl);\n    }",
      ),
      "__frondoseHideCollapsedCard's existing null-guard must be untouched",
    );
    assert.ok(
      LEGACY_TS.includes(
        "if (cronBannerEl && cronBannerEl.parentNode) {\n      cronBannerEl.parentNode.removeChild(cronBannerEl);\n    }",
      ),
      "__frondoseHideCronBanner's existing null-guard must be untouched",
    );
  });

  it("T-HideResidual.SRC.4: takeover layer builders in bootstrapTakeover.ts contain NO reference to OVERLAY_WIDGET_ENABLED (regression pin)", () => {
    // Given: bootstrapTakeover.ts (TAKEOVER_JS)
    // When:  scanned for the widget flag
    // Then:  it is absent — the takeover layer stays a completely independent append path,
    //        ungated by this phase's flag (same pin as the parent phase's SRC.6)
    assert.ok(
      !TAKEOVER_TS.includes("OVERLAY_WIDGET_ENABLED"),
      "bootstrapTakeover.ts must not reference OVERLAY_WIDGET_ENABLED",
    );
  });
});

// ─── Behavioral — collapsed card + cron banner never construct when the flag is off ──────────

type FakeEl = {
  tag: string;
  id: string;
  style: Record<string, string>;
  parentNode: FakeDoc | null;
  listeners: Record<string, Array<() => void>>;
  addEventListener: (type: string, fn: () => void) => void;
  fireClick: () => void;
};

type FakeDoc = {
  children: FakeEl[];
  appendChild: (el: FakeEl) => void;
  removeChild: (el: FakeEl) => void;
};

function makeFakeEl(tag = "div", id = ""): FakeEl {
  const el: FakeEl = {
    tag,
    id,
    style: {},
    parentNode: null,
    listeners: {},
    addEventListener(type, fn) {
      el.listeners[type] = el.listeners[type] || [];
      el.listeners[type].push(fn);
    },
    fireClick() {
      for (const fn of el.listeners.click || []) fn();
    },
  };
  return el;
}

function makeFakeDoc(): FakeDoc {
  const doc: FakeDoc = {
    children: [],
    appendChild(el) {
      el.parentNode = doc;
      doc.children.push(el);
    },
    removeChild(el) {
      el.parentNode = null;
      doc.children = doc.children.filter((c) => c !== el);
    },
  };
  return doc;
}

// Mirrors the relevant slice of LEGACY_JS: __frondoseShowCollapsedCard's entry guard +
// element/listener construction (bootstrapLegacy.ts:348-355,367-385 post-guard).
function mirrorShowCollapsedCard(overlayWidgetEnabled: boolean) {
  const documentElement = makeFakeDoc();
  let activeCardEl: FakeEl | null = null;
  let expandDialogCalls = 0;
  let showCardCalls = 0;

  function frondoseShowCollapsedCard(payload: { title?: string; fullCardJson?: string }) {
    if (!overlayWidgetEnabled) return;
    activeCardEl = makeFakeEl("div", "__frondose_collapsed_card");
    activeCardEl.addEventListener("click", () => {
      const fullCardJson = payload.fullCardJson;
      activeCardEl = null; // __frondoseHideCollapsedCard removes it
      expandDialogCalls++;
      if (fullCardJson) showCardCalls++;
    });
    documentElement.appendChild(activeCardEl);
  }

  return {
    documentElement,
    frondoseShowCollapsedCard,
    getActiveCardEl: () => activeCardEl,
    getExpandDialogCalls: () => expandDialogCalls,
    getShowCardCalls: () => showCardCalls,
  };
}

describe("collapsed suggestion card visibility mirrors OVERLAY_WIDGET_ENABLED (ISSUE-OVERLAY-HIDE-RESIDUAL behavioral proof)", () => {
  it("T-HideResidual.1: with the flag false (shipped default), the card is never constructed, appended, or clickable — no dead-end click possible", () => {
    // Given: OVERLAY_WIDGET_ENABLED = false (the shipped default)
    // When:  __frondoseShowCollapsedCard is invoked (simulating the serve backend pushing
    //        a suggestion, src/app/backend/passive.ts:227)
    // Then:  no card element is created or appended to document.documentElement, so there
    //        is nothing to click — the previous dead-end (card vanishes, panel-expand no-ops,
    //        nothing opens) is eliminated by never entering the reachable code at all
    const { documentElement, frondoseShowCollapsedCard, getActiveCardEl } = mirrorShowCollapsedCard(false);
    frondoseShowCollapsedCard({ title: "Suggestion", fullCardJson: "{}" });
    assert.equal(getActiveCardEl(), null, "no card element must be constructed when the flag is false");
    assert.equal(documentElement.children.length, 0, "document.documentElement must receive no append");
  });

  it("T-HideResidual.2: with the flag true (re-enable path), the card is constructed, appended, and its click still drives expand+show-card", () => {
    // Given: OVERLAY_WIDGET_ENABLED = true (the documented re-enable flip)
    // When:  __frondoseShowCollapsedCard is invoked, then the card is clicked
    // Then:  the card is appended to document.documentElement and its click handler fires
    //        exactly as before this phase — one-line flip fully restores the feature
    const { documentElement, frondoseShowCollapsedCard, getActiveCardEl, getExpandDialogCalls, getShowCardCalls } =
      mirrorShowCollapsedCard(true);
    frondoseShowCollapsedCard({ title: "Suggestion", fullCardJson: '{"title":"x"}' });
    assert.notEqual(getActiveCardEl(), null, "the card element must be constructed when the flag is true");
    assert.equal(documentElement.children.length, 1, "document.documentElement must receive the card append");
    getActiveCardEl()!.fireClick();
    assert.equal(getExpandDialogCalls(), 1, "clicking the card must still call the expand-dialog path when enabled");
    assert.equal(getShowCardCalls(), 1, "clicking the card must still call the show-card path when enabled");
  });
});

// Mirrors the relevant slice of LEGACY_JS: __frondoseShowCronBanner's entry guard +
// element/interval construction (bootstrapLegacy.ts:284-332 post-guard).
function mirrorShowCronBanner(overlayWidgetEnabled: boolean) {
  const documentElement = makeFakeDoc();
  let cronBannerEl: FakeEl | null = null;
  let intervalsStarted = 0;
  const fakeSetInterval = () => {
    intervalsStarted++;
    return intervalsStarted; // fake interval id
  };

  function frondoseShowCronBanner(text: string) {
    if (!overlayWidgetEnabled) return;
    cronBannerEl = makeFakeEl("div", "__frondose_cron_banner");
    documentElement.appendChild(cronBannerEl);
    fakeSetInterval();
  }

  return {
    documentElement,
    frondoseShowCronBanner,
    getCronBannerEl: () => cronBannerEl,
    getIntervalsStarted: () => intervalsStarted,
  };
}

describe("cron banner visibility mirrors OVERLAY_WIDGET_ENABLED (ISSUE-OVERLAY-HIDE-RESIDUAL behavioral proof)", () => {
  it("T-HideResidual.3: with the flag false (shipped default), the banner is never constructed, appended, or animated", () => {
    // Given: OVERLAY_WIDGET_ENABLED = false (the shipped default)
    // When:  __frondoseShowCronBanner is invoked (simulating a real cron tick,
    //        src/app/backend/cron.ts:157)
    // Then:  no banner element is created, nothing is appended to document.documentElement,
    //        and no pulse interval is started
    const { documentElement, frondoseShowCronBanner, getCronBannerEl, getIntervalsStarted } =
      mirrorShowCronBanner(false);
    frondoseShowCronBanner("running task X");
    assert.equal(getCronBannerEl(), null, "no banner element must be constructed when the flag is false");
    assert.equal(documentElement.children.length, 0, "document.documentElement must receive no append");
    assert.equal(getIntervalsStarted(), 0, "no pulse interval must be started when the flag is false");
  });

  it("T-HideResidual.4: with the flag true (re-enable path), the banner is constructed, appended, and its pulse interval starts", () => {
    // Given: OVERLAY_WIDGET_ENABLED = true (the documented re-enable flip)
    // When:  __frondoseShowCronBanner is invoked
    // Then:  the banner is appended and the pulse interval starts — one-line flip fully
    //        restores the feature
    const { documentElement, frondoseShowCronBanner, getCronBannerEl, getIntervalsStarted } =
      mirrorShowCronBanner(true);
    frondoseShowCronBanner("running task X");
    assert.notEqual(getCronBannerEl(), null, "the banner element must be constructed when the flag is true");
    assert.equal(documentElement.children.length, 1, "document.documentElement must receive the banner append");
    assert.equal(getIntervalsStarted(), 1, "the pulse interval must start when the flag is true");
  });
});

// ─── the gates survive the ASSEMBLED bootstrap bundle (mirrors T-HideWidget.ASM.1) ────────────

describe("OVERLAY_BOOTSTRAP_JS — the residual-hide gates survive bundle assembly (ISSUE-OVERLAY-HIDE-RESIDUAL)", () => {
  it("T-HideResidual.ASM.1: the assembled bootstrap contains both new guards", async () => {
    // Given: the production assembler src/overlay/bootstrap.ts (LEGACY_JS interpolated)
    // When:  OVERLAY_BOOTSTRAP_JS is imported and scanned
    // Then:  both guards are present in the final injected source — catches an
    //        interpolation/codegen regression
    const { OVERLAY_BOOTSTRAP_JS } = await import("../../src/overlay/bootstrap.js");
    const collapsedCardFnIdx = OVERLAY_BOOTSTRAP_JS.indexOf(
      "window.__frondoseShowCollapsedCard = function(payloadJson) {",
    );
    const cronBannerFnIdx = OVERLAY_BOOTSTRAP_JS.indexOf("window.__frondoseShowCronBanner = function(text) {");
    assert.ok(collapsedCardFnIdx >= 0, "assembled bundle must carry __frondoseShowCollapsedCard");
    assert.ok(cronBannerFnIdx >= 0, "assembled bundle must carry __frondoseShowCronBanner");
    const collapsedGuardIdx = OVERLAY_BOOTSTRAP_JS.indexOf("if (!OVERLAY_WIDGET_ENABLED) return;", collapsedCardFnIdx);
    const cronGuardIdx = OVERLAY_BOOTSTRAP_JS.indexOf("if (!OVERLAY_WIDGET_ENABLED) return;", cronBannerFnIdx);
    assert.ok(
      collapsedGuardIdx >= 0 &&
        collapsedGuardIdx < OVERLAY_BOOTSTRAP_JS.indexOf("activeCardEl = document.createElement", collapsedCardFnIdx),
      "assembled bundle must carry the collapsed-card guard BEFORE its DOM construction",
    );
    assert.ok(
      cronGuardIdx >= 0 &&
        cronGuardIdx <
          cronBannerFnIdx +
            OVERLAY_BOOTSTRAP_JS.slice(cronBannerFnIdx).indexOf("cronBannerEl = document.createElement"),
      "assembled bundle must carry the cron-banner guard BEFORE its DOM construction",
    );
  });

  it("T-HideResidual.ASM.2: OVERLAY_WIDGET_ENABLED is declared exactly once in the assembled bundle (single flag, reused — not redeclared)", async () => {
    // Given: the assembled OVERLAY_BOOTSTRAP_JS
    // When:  scanned for the flag declaration count
    // Then:  it appears exactly once (from SHELL_JS) — LEGACY_JS's two new guards reference
    //        the same var, they do not declare a second one
    const { OVERLAY_BOOTSTRAP_JS } = await import("../../src/overlay/bootstrap.js");
    const matches = OVERLAY_BOOTSTRAP_JS.match(/var OVERLAY_WIDGET_ENABLED = false;/g) || [];
    assert.equal(matches.length, 1, "OVERLAY_WIDGET_ENABLED must be declared exactly once in the assembled bundle");
  });
});
