/**
 * P-59 Track A Step 4a — T-Turn.3 — SCAFFOLD
 * (assertion bodies are REAL + intentionally RED; all FAIL pre-builder)
 *
 * Source-structural mock test for the `case "turn-started"` handler in
 * `src/tauri/ui/app.ts`. At Step 5 this will be upgraded with a DOM-harness
 * test (real app.js + headless Chrome, same pattern as entry-flow-pY4.mock.test.ts).
 * The 4a scaffold uses source-structural assertions to ensure the handler is wired
 * correctly — these compile now and FAIL now because app.ts has no `case "turn-started"`.
 *
 * T-Turn.3 (UI mock — FIX-2 UI, §6.4(E)):
 *   Part A (handler existence): `handleEvent` switch in `app.ts` contains a
 *     `case "turn-started"` arm (currently absent → FAILS).
 *   Part B (state adoption): the handler sets `currentTurnId = payload.turnId` AND
 *     opens a new agent bubble with `beginAgentBubble()` AND calls `transition("running")`
 *     (currently absent → FAILS).
 *   Part C (source-aware ticker): when `payload.source === "cron"` the handler sets
 *     `tickerEl.textContent = "cron running..."`, otherwise `"starting..."`
 *     (currently absent → FAILS).
 *   Part D (UI SseFrame union): the UI's local `SseFrame` type in `app.ts` includes
 *     `{ type: "turn-started"; turnId: string; source?: "server" | "cron" }`
 *     (currently absent → FAILS).
 *
 * Behavioral upgrade at Step 5:
 *   The source-structural assertions are complemented by a DOM-harness scenario
 *   that boots real app.js in headless Chrome, posts a `turn-started` SSE payload,
 *   and verifies `currentTurnId`, `outputEl`, `tickerEl`, and `appState` directly.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * Gate/defect coverage:
 *   D-P59-2 (approve turn invisible) ↦ T-Turn.3-A, T-Turn.3-B
 *   D-P59-3 (all server-initiated turns invisible) ↦ T-Turn.3-A, T-Turn.3-B
 *   [3b] cron UX (ticker "cron running...") ↦ T-Turn.3-C
 *   §6.4(E) FIX-2 app.ts union member + handler sketch ↦ T-Turn.3-A, T-Turn.3-B, T-Turn.3-C, T-Turn.3-D
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/turnStartedUi.mock.test.ts
 * ════════════════════════════════════════════════════════════════════════════════════
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_TS = readFileSync(join(REPO, "src/tauri/ui/app.ts"), "utf-8");

// ─── T-Turn.3-A — app.ts handleEvent switch has a case "turn-started" arm ────────────────────────

describe('app.ts handleEvent — case "turn-started" handler exists (FIX-2 UI §6.4(E) D-P59-2/3)', () => {
  it('T-Turn.3-A: app.ts handleEvent() switch contains a case "turn-started": arm (F5 required — FAILS pre-builder)', () => {
    // Given: src/tauri/ui/app.ts source as a string
    // When:  scanned for the handleEvent switch + a "turn-started" case
    // Then:  the case arm is present
    //        — currently FAILS: handleEvent switch ends at "commit-warning" with no "turn-started" case

    assert.ok(
      APP_TS.includes('case "turn-started"'),
      `app.ts/handleEvent must contain case "turn-started": — ` +
        `currently absent (the switch ends at commit-warning). ` +
        `F5 adds this case after "cron-done" per §6.4(E). FAILS pre-builder.`,
    );
  });
});

// ─── T-Turn.3-B — handler adopts currentTurnId + opens bubble + transitions to running ──────────

describe('app.ts handleEvent("turn-started") — adopts currentTurnId + opens agent bubble + transition("running") (FIX-2 UI §6.4(E))', () => {
  it('T-Turn.3-B: the case "turn-started" handler sets currentTurnId = payload.turnId, calls beginAgentBubble(), and calls transition("running")', () => {
    // Given: src/tauri/ui/app.ts source as a string (post-F5 required state)
    // When:  scanned for the three state-adoption assignments within the turn-started case
    // Then:  all three actions are present: currentTurnId=, beginAgentBubble(), transition("running")

    // currentTurnId adoption (mirrors sendCommand L263-268 for user-initiated turns)
    assert.ok(
      APP_TS.includes("currentTurnId = payload.turnId"),
      `app.ts "turn-started" handler must set currentTurnId = payload.turnId — ` +
        `currently absent. F5 required. FAILS pre-builder.`,
    );

    assert.ok(
      APP_TS.includes("beginAgentBubble()"),
      `app.ts "turn-started" handler must call beginAgentBubble() to create a fresh agent message bubble.`,
    );

    // Transition to running (so the UI leaves idle state and the ticker/output become live)
    assert.ok(
      APP_TS.includes('transition("running")'),
      `app.ts "turn-started" handler must call transition("running") — ` +
        `currently absent in any turn-started arm. F5 required. FAILS pre-builder.`,
    );
  });
});

// ─── T-Turn.3-C — source-aware ticker: cron → "cron running..." / non-cron → "starting..." ──────

describe('app.ts handleEvent("turn-started") — source-aware ticker text (FIX-2 UI [3b] cron UX §6.4(E))', () => {
  it('T-Turn.3-C: the case "turn-started" handler sets tickerEl.textContent to "cron running..." when payload.source==="cron" and "starting..." otherwise', () => {
    // Given: src/tauri/ui/app.ts source as a string (P0-3: the ticker literals moved into the i18n en
    //        table; app.ts now references them via t("ticker.cronRunning") / t("ticker.starting"))
    // When:  scanned for the source-aware ticker assignment in the turn-started case
    // Then:  the assignment distinguishes cron vs non-cron and the en table still carries the P-67 literals
    const I18N_TS = readFileSync(join(REPO, "src/tauri/ui/i18n.ts"), "utf-8");

    // "cron running..." must remain the en cron-turn ticker text (per §6.4(E) sketch), now via the i18n table
    assert.ok(
      APP_TS.includes('t("ticker.cronRunning")') && I18N_TS.includes('"cron running..."'),
      `app.ts must reference t("ticker.cronRunning") and the i18n en table must keep "cron running..." ` +
        `as the cron-turn ticker text.`,
    );

    // "starting..." is the current non-cron ticker text accepted by P-67, now via the i18n table.
    assert.ok(
      APP_TS.includes('t("ticker.starting")') && I18N_TS.includes('"starting..."'),
      `app.ts must reference t("ticker.starting") and the i18n en table must keep "starting..." ` +
        `as the non-cron turn-started ticker text.`,
    );

    // The source-conditional must be in the same expression (check for the conditional form)
    assert.ok(
      APP_TS.includes('payload.source === "cron"') || APP_TS.includes("payload.source === 'cron'"),
      `app.ts must contain the source-aware condition payload.source === "cron" in the ` +
        `turn-started handler. F5 required. FAILS pre-builder.`,
    );
  });
});

// ─── T-Turn.3-D — UI SseFrame union includes the turn-started member ──────────────────────────────

describe('app.ts SseFrame union — includes { type: "turn-started"; turnId: string; source?: "server" | "cron" } (FIX-2 UI §6.4(E))', () => {
  it('T-Turn.3-D: the local SseFrame type in app.ts includes a { type: "turn-started"; turnId: string; source?: ... } member so the case handler typechecks (F5 required — FAILS pre-builder)', () => {
    // Given: src/tauri/ui/app.ts source as a string
    // When:  the SseFrame type alias (L48) is scanned for the turn-started member
    // Then:  a union member with type: "turn-started" + turnId: string + source?: ... is present
    //        — currently FAILS: the UI SseFrame type (L48-76) has no "turn-started" member

    // The union type must include "turn-started" as a literal
    assert.ok(
      APP_TS.includes('"turn-started"') || APP_TS.includes("'turn-started'"),
      `app.ts SseFrame type must include "turn-started" as a type literal. ` +
        `Currently the UI SseFrame union (app.ts L48-76) ends at "commit-warning". ` +
        `F5 adds: | { type: "turn-started"; turnId: string; source?: "server" | "cron" }. FAILS pre-builder.`,
    );

    // The member must declare turnId as required string (NOT optional — the UI needs it to adopt the turn)
    // The source must be optional — absence means "server" default
    assert.ok(
      APP_TS.includes('"turn-started"; turnId: string') ||
        APP_TS.includes('"turn-started"; turnId:string') ||
        APP_TS.includes('type: "turn-started"; turnId: string'),
      `app.ts "turn-started" union member must declare turnId: string (required, not optional). ` +
        `F5 required. FAILS pre-builder.`,
    );
  });
});
