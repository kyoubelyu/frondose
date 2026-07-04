/**
 * P-AUTO-ISOLATE Step 2 — Test Scaffold — FE composer lock + Terminate button +
 * SSE handlers for the new Auto-session model (`src/tauri/ui/app.ts` +
 * `src/tauri/ui/index.html`, plan §3.2 / §6.7).
 *
 * Covers (plan §5): T-FE.LockOnAuto, T-FE.UnlockOnCompleted, T-FE.EmptyPromptRejected,
 * T-FE.NonEmptyPromptStarts, T-FE.TerminateInvokes, T-FE.SteerBypassBlocked.
 *
 * app.ts has zero exports + boot()/mustGet() run on import (no DOM harness at this
 * tier) — same established SOURCE-STRUCTURAL pattern as
 * tests/tauri/ui/imeAndClear-tfeChat.mock.test.ts / autoRunCompletedUi-pWLC.mock.test.ts:
 * read app.ts + index.html as raw source text and assert on structure/markers.
 *
 * Per outside-in TDD + BDD-light: ALL assertion bodies are
 * `assert.fail("TODO Step 5: …")` — RED at Step 2/3/4a. None of the markers this
 * file scans for (autoTerminateEl, frondose_agent_auto_start/stop invokes, the
 * prompt-gate, the auto-session-started/completed SSE cases, the #auto-terminate
 * element, the disabled-composer bypass guard) exist in app.ts / index.html yet.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/ui/autoIsolate-pAutoIsolate.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP_TS = readFileSync(join(REPO, "src/tauri/ui/app.ts"), "utf-8");
const INDEX_HTML = readFileSync(join(REPO, "src/tauri/ui/index.html"), "utf-8");

/** Bounded slice from `sig` to the NEXT top-level (async or not) function declaration. */
function fnBody(sig: string): string {
  const start = APP_TS.indexOf(sig);
  assert.ok(start >= 0, `app.ts must define ${sig}`);
  const rest = APP_TS.slice(start + sig.length);
  const match = /\n(async )?function /.exec(rest);
  return match && match.index > 0 ? rest.slice(0, match.index) : rest;
}

/** The handleEvent switch body runs to end-of-file in the established pattern (autoRunCompletedUi-pWLC). */
function handleEventBody(): string {
  const start = APP_TS.indexOf("function handleEvent(");
  assert.ok(start >= 0, "app.ts must define handleEvent()");
  return APP_TS.slice(start);
}

// ─── T-FE.LockOnAuto ─────────────────────────────────────────────────────────

describe("app.ts — SSE auto-session-started locks the composer + shows Terminate (T-FE.LockOnAuto, LOCKED-4)", () => {
  it("T-FE.LockOnAuto: handleEvent has a case 'auto-session-started' arm that disables commandEl, shows the Terminate button, and hides the Send button", () => {
    // Given: the handleEvent switch body
    // When:  scanned for a case "auto-session-started" arm
    // Then:  the arm sets commandEl.disabled = true, removes 'hidden' from the Terminate
    //        element's classList, and adds 'hidden' to the Send button's classList
    const body = handleEventBody();
    const hasCase = body.includes('case "auto-session-started"');
    const caseIdx = body.indexOf('case "auto-session-started"');
    const arm = caseIdx >= 0 ? body.slice(caseIdx, caseIdx + 500) : "";
    const disablesComposer = arm.includes("commandEl.disabled = true");
    const showsTerminate = /autoTerminateEl.*classList\.remove\(\s*["']hidden["']\s*\)/.test(arm);
    const hidesSend = /sendEl.*classList\.add\(\s*["']hidden["']\s*\)/.test(arm);

    assert.fail(
      `TODO Step 5: assert hasCase===true (currently ${hasCase}), disablesComposer===true (currently ` +
        `${disablesComposer}), showsTerminate===true (currently ${showsTerminate}), hidesSend===true ` +
        `(currently ${hidesSend}) — app.ts has no auto-session-started handling yet at Step 2`,
    );
  });
});

// ─── T-FE.UnlockOnCompleted ──────────────────────────────────────────────────

describe("app.ts — SSE auto-session-completed unlocks the composer + hides Terminate (T-FE.UnlockOnCompleted)", () => {
  it("T-FE.UnlockOnCompleted: handleEvent has a case 'auto-session-completed' arm that re-enables commandEl, hides the Terminate button, and shows the Send button", () => {
    // Given: the handleEvent switch body
    // When:  scanned for a case "auto-session-completed" arm
    // Then:  the arm sets commandEl.disabled = false (or via syncModeUi), hides Terminate,
    //        and shows Send
    const body = handleEventBody();
    const hasCase = body.includes('case "auto-session-completed"');
    const caseIdx = body.indexOf('case "auto-session-completed"');
    const arm = caseIdx >= 0 ? body.slice(caseIdx, caseIdx + 500) : "";
    const unlocksComposer = arm.includes("commandEl.disabled = false") || arm.includes("syncModeUi(");
    const hidesTerminate = /autoTerminateEl.*classList\.add\(\s*["']hidden["']\s*\)/.test(arm);
    const showsSend = /sendEl.*classList\.remove\(\s*["']hidden["']\s*\)/.test(arm);

    assert.fail(
      `TODO Step 5: assert hasCase===true (currently ${hasCase}), unlocksComposer===true (currently ` +
        `${unlocksComposer}), hidesTerminate===true (currently ${hidesTerminate}), showsSend===true ` +
        `(currently ${showsSend})`,
    );
  });
});

// ─── T-FE.EmptyPromptRejected ────────────────────────────────────────────────

describe("app.ts applyMode('auto') — empty prompt is rejected before any invoke (T-FE.EmptyPromptRejected, LOCKED-5)", () => {
  it("T-FE.EmptyPromptRejected: applyMode captures previousMode, checks commandEl.value.trim().length===0 for mode==='auto', calls surfaceError with error.autoStartEmpty, and reverts via syncModeUi(previousMode) WITHOUT calling frondose_agent_auto_start", () => {
    // Given: applyMode's body (async function applyMode(mode))
    // When:  scanned for the empty-prompt gate on the 'auto' branch
    // Then:  a `const previousMode = appMode;` capture exists; an empty-prompt branch calls
    //        surfaceError(...error.autoStartEmpty...) and syncModeUi(previousMode), and does
    //        NOT call invoke("frondose_agent_auto_start", ...) on that branch
    const body = fnBody("async function applyMode(");
    const capturesPreviousMode = /const\s+previousMode\s*=\s*appMode/.test(body);
    const hasEmptyGuard = body.includes("error.autoStartEmpty");
    const revertsViaSyncModeUi = /syncModeUi\(\s*previousMode\s*\)/.test(body);
    const callsAutoStart = body.includes("frondose_agent_auto_start");

    assert.fail(
      `TODO Step 5: assert capturesPreviousMode===true (currently ${capturesPreviousMode}), ` +
        `hasEmptyGuard===true (currently ${hasEmptyGuard}), revertsViaSyncModeUi===true (currently ` +
        `${revertsViaSyncModeUi}), and callsAutoStart===true overall (currently ${callsAutoStart}, but ` +
        "must be gated so the empty-prompt path never reaches it) — applyMode has no prompt gate yet at Step 2",
    );
  });
});

// ─── T-FE.NonEmptyPromptStarts ───────────────────────────────────────────────

describe("app.ts applyMode('auto') — non-empty prompt invokes frondose_agent_auto_start (T-FE.NonEmptyPromptStarts, LOCKED-2)", () => {
  it("T-FE.NonEmptyPromptStarts: applyMode('auto') with a non-empty commandEl.value invokes frondose_agent_auto_start with {prompt, intervalMinutes:null} exactly once", () => {
    // Given: applyMode's body
    // When:  scanned for the invoke call on the non-empty-prompt path
    // Then:  invoke("frondose_agent_auto_start", { prompt, intervalMinutes: null }) appears
    const body = fnBody("async function applyMode(");
    const callsAutoStart = /invoke[^(]*\(\s*["']frondose_agent_auto_start["']/.test(body);
    const passesIntervalNull = body.includes("intervalMinutes: null") || body.includes("intervalMinutes:null");

    assert.fail(
      `TODO Step 5: assert callsAutoStart===true (currently ${callsAutoStart}) AND passesIntervalNull===true ` +
        `(currently ${passesIntervalNull}) — applyMode does not call frondose_agent_auto_start at Step 2 ` +
        "(it unconditionally calls frondose_set_cron_mode today)",
    );
  });
});

// ─── T-FE.TerminateInvokes ───────────────────────────────────────────────────

describe("app.ts — Terminate button invokes frondose_agent_auto_stop (T-FE.TerminateInvokes, LOCKED-4)", () => {
  it("T-FE.TerminateInvokes: an autoTerminateEl click listener invokes frondose_agent_auto_stop exactly once", () => {
    // Given: app.ts top-level wiring source
    // When:  scanned for an autoTerminateEl click listener
    // Then:  autoTerminateEl.addEventListener("click", ...) exists and its body invokes
    //        frondose_agent_auto_stop (no args)
    const hasElement = APP_TS.includes('mustGet<ButtonElementLike>("auto-terminate")') || APP_TS.includes("autoTerminateEl");
    const listenerIdx = APP_TS.indexOf('autoTerminateEl.addEventListener("click"');
    const hasListener = listenerIdx >= 0;
    const listenerBody = hasListener ? APP_TS.slice(listenerIdx, listenerIdx + 300) : "";
    const invokesStop = listenerBody.includes("frondose_agent_auto_stop");

    assert.fail(
      `TODO Step 5: assert hasElement===true (currently ${hasElement}), hasListener===true (currently ` +
        `${hasListener}), invokesStop===true (currently ${invokesStop}) — no autoTerminateEl exists in ` +
        "app.ts at Step 2, and index.html has no #auto-terminate button " +
        `(indexHtmlHasButton=${INDEX_HTML.includes('id="auto-terminate"')})`,
    );
  });
});

// ─── T-FE.SteerBypassBlocked ─────────────────────────────────────────────────

describe("app.ts sendCommand — a disabled composer cannot bypass the Auto lock via steer (T-FE.SteerBypassBlocked, defense-in-depth)", () => {
  it("T-FE.SteerBypassBlocked: sendCommand checks commandEl.disabled and returns without invoking frondose_agent_turn when the composer is disabled (Auto mode), even if the DOM Enter handler somehow still fires", () => {
    // Given: sendCommand's body
    // When:  scanned for a commandEl.disabled guard
    // Then:  sendCommand early-returns (or is otherwise blocked) when commandEl.disabled===true,
    //        BEFORE reading commandEl.value / dispatching frondose_agent_turn or performSteer
    const body = fnBody("async function sendCommand(");
    const hasDisabledGuard = /commandEl\.disabled/.test(body);

    assert.fail(
      `TODO Step 5: assert hasDisabledGuard===true (currently ${hasDisabledGuard}) — sendCommand has no ` +
        "commandEl.disabled check at Step 2 (defense-in-depth on top of the DOM disabled attribute; " +
        "plan §3.2 does not name the exact mechanism — Step 5 confirms whichever guard builder lands, " +
        "e.g. an early return or a keydown-level disabled check, actually blocks dispatch)",
    );
  });
});
