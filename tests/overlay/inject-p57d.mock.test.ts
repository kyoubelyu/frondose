/**
 * P-57d Step 5 — T-SS.1, T-SS.2 — FILLED
 * (G-P57d.5, G-P57d.6)
 *
 * Per source grep at Step 5 baseline (post-Step 4b):
 *   - L43-45: MAI_DIALOG_KEY='__mai_dialog_state' + MAI_OUTPUT_CAP=2000 + MAI_FRAMES_CAP=20.
 *   - L47-54: maiReadDialogState helper (try/catch + sessionStorage.getItem).
 *   - L55-66: maiWriteDialogState helper (cap-trim via .slice(-N) + sessionStorage.setItem).
 *   - L68-: maiDialogState initialization (ts, ticker:null, output:'', card:null, frames:[]).
 *   - L215-: __maiAppendOutput writes state.output + state.frames.push({content:text}) [normalized
 *     'text' post-JSON.parse, NOT raw 'chunk', per rev-1 MR-1 fix].
 *   - L307-320: bootstrap-time replay block: `const saved = maiReadDialogState(); if (saved) { ... }`.
 *
 * Test strategy:
 *   - Pure substring-grep verification against OVERLAY_BOOTSTRAP_JS exported constant.
 *   - Behavioral round-trip verification deferred to T-LIVE.CLICK on real Chrome where
 *     dialog persists across SPA nav (matches scaffold strategy from Step 4a).
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/overlay/inject-p57d.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OVERLAY_BOOTSTRAP_JS } from "../../src/overlay/inject.js";

// ─── T-SS.1 — sessionStorage round-trip + JSON.parse normalization ──────────

describe("OVERLAY_BOOTSTRAP_JS — sessionStorage round-trip helpers + bootstrap-time replay (G-P57d.5)", () => {
  it("T-SS.1: given OVERLAY_BOOTSTRAP_JS exported post-P-57d, WHEN substring greps applied, THEN string contains MAI_DIALOG_KEY constant + verbatim '__mai_dialog_state' key + maiReadDialogState + maiWriteDialogState helpers + sessionStorage.getItem + sessionStorage.setItem calls + maiDialogState.output write + maiDialogState.frames.push write + rev-1 MR-1 'content: text' normalized form (NOT 'content: chunk') + bootstrap-time replay restoring dialogElements.output.textContent", () => {
    assert.ok(
      typeof OVERLAY_BOOTSTRAP_JS === "string" && OVERLAY_BOOTSTRAP_JS.length > 0,
      "OVERLAY_BOOTSTRAP_JS must be non-empty exported string",
    );

    // (a) Key namespace constant
    assert.ok(OVERLAY_BOOTSTRAP_JS.includes("MAI_DIALOG_KEY"), "must contain 'MAI_DIALOG_KEY' constant declaration");
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("'__mai_dialog_state'"),
      "must contain verbatim '__mai_dialog_state' key namespace string per plan §5.4.1",
    );

    // (b) Helper functions
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("function maiReadDialogState"),
      "must contain 'function maiReadDialogState' read helper",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("function maiWriteDialogState"),
      "must contain 'function maiWriteDialogState' write helper",
    );

    // (c) sessionStorage API calls
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("sessionStorage.getItem("),
      "must contain 'sessionStorage.getItem(' call in read helper",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("sessionStorage.setItem("),
      "must contain 'sessionStorage.setItem(' call in write helper",
    );

    // (d) Per-call writes — output accumulator + frames ring-buffer
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("maiDialogState.output"),
      "must contain 'maiDialogState.output' write site (output accumulator)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("maiDialogState.frames.push(") ||
        OVERLAY_BOOTSTRAP_JS.includes("maiDialogState.frames = maiDialogState.frames"),
      "must contain frames ring-buffer push pattern",
    );

    // (e) rev-1 MR-1 fix: frame.content writes normalized 'text' (post-JSON.parse),
    // NOT raw 'chunk'. This matches the DOM-shown value via the existing try/parse normalization.
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("content: text"),
      "must contain 'content: text' (frame.content uses NORMALIZED text post-JSON.parse per rev-1 MR-1)",
    );

    // (f) Bootstrap-time replay — restore output.textContent from sessionStorage state
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("maiReadDialogState()"),
      "must contain bootstrap-time 'maiReadDialogState()' call",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("dialogElements.output.textContent = maiDialogState.output"),
      "must contain bootstrap-time replay line restoring dialogElements.output.textContent from sessionStorage",
    );
  });
});

// ─── T-SS.2 — sessionStorage caps (MAI_OUTPUT_CAP + MAI_FRAMES_CAP) ─────────

describe("OVERLAY_BOOTSTRAP_JS — sessionStorage caps prevent quota issues (G-P57d.6)", () => {
  it("T-SS.2: given OVERLAY_BOOTSTRAP_JS exported post-P-57d, WHEN substring greps applied for cap constants + trim operations, THEN string contains MAI_OUTPUT_CAP=2000 + MAI_FRAMES_CAP=20 constants + the actual slice operations (state.output.slice + state.frames.slice) that enforce caps per plan §5.4.1 maiWriteDialogState helper", () => {
    // Cap constants
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("MAI_OUTPUT_CAP = 2000"),
      "must contain 'MAI_OUTPUT_CAP = 2000' constant (output char cap)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("MAI_FRAMES_CAP = 20"),
      "must contain 'MAI_FRAMES_CAP = 20' constant (frames ring-buffer cap)",
    );

    // Trim operations applied inside maiWriteDialogState
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("state.output.slice(-MAI_OUTPUT_CAP)") ||
        OVERLAY_BOOTSTRAP_JS.includes("state.output.slice("),
      "must contain 'state.output.slice(' (FIFO trim to MAI_OUTPUT_CAP)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("state.frames.slice(-MAI_FRAMES_CAP)") ||
        OVERLAY_BOOTSTRAP_JS.includes("state.frames.slice("),
      "must contain 'state.frames.slice(' (ring-buffer trim to MAI_FRAMES_CAP)",
    );
  });
});
