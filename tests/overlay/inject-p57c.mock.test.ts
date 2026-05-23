/**
 * P-57c Step 5 — T-Overlay.11, T-Observer.1 — FILLED
 * (G-P57c.10, G-P57c.11)
 *
 * Mock tests for P-57c extensions to `src/overlay/inject.ts`:
 *   T-Overlay.11 — Cron-banner + retry-button DOM API safe + state-aware mount + JS-pulse
 *   T-Observer.1 — Input listener rollup (OQ-polish-4)
 *
 * Gate coverage:
 *   G-P57c.10 — Trusted Types DOM API for new overlay elements (T-Overlay.11)
 *   G-P57c.11 — Input observer capture-phase + 20-char guard + dead helper cleanup (T-Observer.1)
 *
 * Mock strategy:
 *   - Pure substring-grep against OVERLAY_BOOTSTRAP_JS exported constant.
 *   - No Chrome, no DOM, no LinkedIn.
 *   - Behavioral runtime verification at T-Tauri.LIVE.12/13 (real Chrome).
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/overlay/inject-p57c.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OVERLAY_BOOTSTRAP_JS } from "../../src/overlay/inject.js";

// ─── T-Overlay.11 — Cron-banner + retry-button TT-safe + observability ─────

describe("OVERLAY_BOOTSTRAP_JS — cron-banner + retry-button TT-safe + state-aware mount + JS-pulse (G-P57c.10)", () => {
  it("T-Overlay.11: given OVERLAY_BOOTSTRAP_JS exported, WHEN substring greps applied to the P-57c additions, THEN string contains __maiShowCronBanner / __maiHideCronBanner / __maiShowRetry / __maiHideRetry window-fn declarations + __mai_cron_slot id + cronSlot.appendChild (rev-1 MR-5 appendChild-only pattern) + setInterval (JS pulse) + createElement / textContent / appendChild / style.cssText; does NOT contain innerHTML / outerHTML / insertAdjacentHTML / @keyframes / insertBefore on cron banner mount", () => {
    // Given: OVERLAY_BOOTSTRAP_JS as P-57c-extended exported constant per plan §5.5
    // When:  apply substring searches for required-present + required-absent fragments
    // Then:  10 PRESENT + 5 ABSENT = 15 substring assertions total

    assert.ok(
      typeof OVERLAY_BOOTSTRAP_JS === "string" && OVERLAY_BOOTSTRAP_JS.length > 0,
      "OVERLAY_BOOTSTRAP_JS must be a non-empty exported string",
    );

    // ─── PRESENT (10) — P-57c additions present in source ───
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("window.__maiShowCronBanner = function"),
      "(a) must contain 'window.__maiShowCronBanner = function' (cron-banner render fn)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("window.__maiHideCronBanner = function"),
      "(b) must contain 'window.__maiHideCronBanner = function' (cron-banner hide fn)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("window.__maiShowRetry = function"),
      "(c) must contain 'window.__maiShowRetry = function' (retry surface render fn)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("window.__maiHideRetry = function"),
      "(d) must contain 'window.__maiHideRetry = function' (retry surface hide fn)",
    );

    // rev-1 MR-5 — pre-created cron slot + appendChild-only mount pattern
    // P-Y2.2a RECONCILED: the frondose skeleton renamed the slot id '__mai_cron_slot' → 'cron-slot'
    // (the cron-banner feature + appendChild-only mount are preserved+recolored in bootstrapLegacy).
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("cron-slot"),
      "(e) must contain the pre-created cron slot id (P-Y2.2a: '__mai_cron_slot' → 'cron-slot'; appendChild-only mount preserved)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("cronSlot.appendChild") || OVERLAY_BOOTSTRAP_JS.includes(".cronSlot.appendChild"),
      "(f) must contain cronSlot.appendChild (rev-1 MR-5 appendChild-only mount; NO insertBefore)",
    );

    // setInterval JS-driven pulse (CSP-safe per scout C-2)
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("setInterval"),
      "(g) must contain setInterval (JS-driven pulse for cron banner per §5.5.3)",
    );

    // Safe DOM API (carry-over from T-Overlay.6 / T-Overlay.10 pattern)
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("document.createElement("),
      "(h) must contain 'document.createElement(' (safe constructor)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes(".textContent ="),
      "(i) must contain '.textContent =' (safe text assignment)",
    );
    assert.ok(OVERLAY_BOOTSTRAP_JS.includes(".appendChild("), "(j) must contain '.appendChild(' (DOM assembly)");

    // ─── ABSENT (5) — TT-safe + rev-1 MR-5 constraints ───
    assert.ok(
      !OVERLAY_BOOTSTRAP_JS.includes(".innerHTML"),
      "(k) must NOT contain '.innerHTML' anywhere (TT violation)",
    );
    assert.ok(!OVERLAY_BOOTSTRAP_JS.includes(".outerHTML"), "(l) must NOT contain '.outerHTML' anywhere");
    assert.ok(
      !OVERLAY_BOOTSTRAP_JS.includes("insertAdjacentHTML"),
      "(m) must NOT contain 'insertAdjacentHTML' anywhere",
    );
    // rev-1 MR-5: cron banner mount must use cronSlot.appendChild — NOT insertBefore
    assert.ok(
      !OVERLAY_BOOTSTRAP_JS.includes("insertBefore(cronBannerEl"),
      "(n) must NOT contain 'insertBefore(cronBannerEl' (rev-1 MR-5: appendChild-only mount)",
    );
    // (o) JS-driven pulse for the CRON BANNER (scout C-2: no CSS animation for the cron pulse).
    // P-Y2.2a RECONCILED: the reskin now embeds the SHARED index.html stylesheet, which legitimately
    // carries design @keyframes (pulseSubtle / ringPulse) for OTHER components. The original global
    // !@keyframes ban is therefore over-broad. The cron-pulse intent is preserved: the cron banner uses
    // setInterval (asserted (g)) and adds NO cron-specific @keyframes — so the only @keyframes present
    // must be the known shared-design ones.
    // P-Y2.3 RECONCILED: the magical Auto-mode takeover layer adds three takeover-DESIGN @keyframes to the
    // shared stylesheet (borderFlow = the page-edge ring flow; targetPulse = the element-highlight pulse;
    // pulseDot = the agent-cursor dot). These are design keyframes for OTHER components, NOT the cron banner —
    // the cron-pulse intent of (o) is unchanged (the cron banner still adds NO cron-specific @keyframes and
    // pulses via setInterval, asserted (g)). So they join the allow-set exactly like the P-Y2.2a additions.
    const keyframeNames = [...OVERLAY_BOOTSTRAP_JS.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    const allowedDesignKeyframes = new Set(["pulseSubtle", "ringPulse", "borderFlow", "targetPulse", "pulseDot"]);
    const unexpected = keyframeNames.filter((n) => !allowedDesignKeyframes.has(n ?? ""));
    assert.deepEqual(
      unexpected,
      [],
      `(o) the only @keyframes may be the shared-design ones (pulseSubtle/ringPulse + the P-Y2.3 takeover borderFlow/targetPulse/pulseDot); the cron pulse is JS-driven (setInterval). Unexpected: ${JSON.stringify(unexpected)}`,
    );
  });
});

// ─── T-Observer.1 — Input observer rollup (OQ-polish-4) ─────────────────────

describe("OVERLAY_BOOTSTRAP_JS — input listener {capture:true, passive:true} + 20-char guard + dead helper deleted (G-P57c.11)", () => {
  it("T-Observer.1: given OVERLAY_BOOTSTRAP_JS exported, WHEN substring greps applied, THEN string contains the verbatim 'document.addEventListener(\\'input\\', debouncedInput, { capture: true, passive: true })' (rev-1 MR-2: document NOT documentElement) + 20-char guard 'if (text.length < 20) return;' in input handler body; does NOT contain 'function detectComposerKind' (dead helper deleted per §5.5.5)", () => {
    // Given: OVERLAY_BOOTSTRAP_JS as P-57c-extended baseline.
    // When:  substring greps for input listener rollup + dead helper deletion verification
    // Then:  2 PRESENT + 1 ABSENT = 3 substring assertions total

    // (a) Verbatim rev-1 MR-2 input listener form (document NOT documentElement)
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes(
        "document.addEventListener('input', debouncedInput, { capture: true, passive: true })",
      ),
      "(a) must contain verbatim 'document.addEventListener('input', debouncedInput, { capture: true, passive: true })' per rev-1 MR-2",
    );

    // (b) 20-char guard in input handler body
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("if (text.length < 20) return;"),
      "(b) must contain 'if (text.length < 20) return;' (20-char guard in input handler body per §5.5.4)",
    );

    // (c) Dead helper deleted
    assert.ok(
      !OVERLAY_BOOTSTRAP_JS.includes("function detectComposerKind"),
      "(c) must NOT contain 'function detectComposerKind' (dead helper deleted per §5.5.5; scout §1.7 confirms zero callsites)",
    );
  });
});
