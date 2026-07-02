/**
 * Phase WORKFLOW-LIFECYCLE-COMPLETION (P-WLC) — FE mock tests.
 *
 * Source-structural tests for the `src/tauri/ui/app.ts` handler wiring (app.ts has zero
 * exports + no DOM-harness at this tier — same pattern as turnStartedUi.mock.test.ts).
 * Covers the two operator-surfaced symptoms:
 *   1. Auto stage never closes  → a `case "auto-run-completed"` finalizes the stage
 *      via the workflow-completed close path (workflowView = null; renderWorkflowCard()).
 *   2. Pause unresponsive post-run → abortTurn stops the whole auto-run via
 *      frondose_workflow_cancel when there is no live turn (not a silent no-op).
 * Plus the UI-local SseFrame union gains the auto-run-completed member so the case
 * typechecks.
 *
 * Run:
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/ui/autoRunCompletedUi-pWLC.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP_TS = readFileSync(join(REPO, "src/tauri/ui/app.ts"), "utf-8");

// Isolate the handleEvent switch body so case-arm assertions don't match the union type.
function handleEventBody(): string {
  const start = APP_TS.indexOf("function handleEvent(");
  assert.ok(start >= 0, "app.ts must define handleEvent()");
  return APP_TS.slice(start);
}

// Isolate the abortTurn function body.
function abortTurnBody(): string {
  const start = APP_TS.indexOf("async function abortTurn(");
  assert.ok(start >= 0, "app.ts must define abortTurn()");
  const rest = APP_TS.slice(start);
  const end = rest.indexOf("\nasync function ", 1);
  return end > 0 ? rest.slice(0, end) : rest;
}

describe("app.ts SseFrame union — includes the auto-run-completed member (P-WLC)", () => {
  it('WLC-UI.1: the UI-local SseFrame union declares { type: "auto-run-completed"; runId: string; ... } so the case handler typechecks', () => {
    // Given: app.ts source. When: scanned for the union member. Then: an auto-run-completed member with runId exists.
    assert.ok(
      APP_TS.includes('type: "auto-run-completed"; runId: string'),
      'app.ts SseFrame union must include a { type: "auto-run-completed"; runId: string; ... } member',
    );
    assert.ok(
      APP_TS.includes("finalCounters: Record<string, number>") && APP_TS.includes("summary: string | null"),
      "the auto-run-completed member must carry summary + finalCounters matching the BE frame shape",
    );
  });
});

describe('app.ts handleEvent — case "auto-run-completed" finalizes the Auto stage (P-WLC symptom 1)', () => {
  it('WLC-UI.2: handleEvent has a case "auto-run-completed" that nulls workflowView and re-renders via the workflow-completed close path', () => {
    // Given: the handleEvent switch. When: scanned for the terminal-frame case. Then: it resets workflowView + renderWorkflowCard().
    const body = handleEventBody();
    assert.ok(body.includes('case "auto-run-completed"'), 'handleEvent must contain a case "auto-run-completed" arm');
    // The close path mirrors case "workflow-completed": workflowView = null; renderWorkflowCard();
    const caseIdx = body.indexOf('case "auto-run-completed"');
    const arm = body.slice(caseIdx, caseIdx + 700);
    assert.ok(arm.includes("workflowView = null"), 'the auto-run-completed arm must set workflowView = null');
    assert.ok(arm.includes("renderWorkflowCard()"), "the auto-run-completed arm must call renderWorkflowCard() to rebuild the idle Auto stage");
  });
});

describe("app.ts abortTurn — Pause stops the whole auto-run when there is no live turn (P-WLC symptom 2)", () => {
  it("WLC-UI.3: abortTurn invokes frondose_workflow_cancel when there is no live turn instead of silently returning", () => {
    // Given: abortTurn. When: scanned. Then: it routes to frondose_workflow_cancel (no early no-op return on the no-live-turn branch).
    const body = abortTurnBody();
    assert.ok(body.includes("frondose_workflow_cancel"), "abortTurn must invoke frondose_workflow_cancel for the no-live-turn (Pause) case");
    assert.ok(body.includes("frondose_agent_abort"), "abortTurn must still invoke frondose_agent_abort when a live turn exists");
    // The regression the fix removes: the old silent guard `if (... || currentTurnId === null) return;`
    assert.ok(
      !/\|\|\s*currentTurnId === null\)\s*return;/.test(body),
      "abortTurn must NOT early-return (silent no-op) when currentTurnId === null — Pause must act",
    );
  });
});
