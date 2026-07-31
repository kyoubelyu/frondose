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
const APP_BINDINGS_TS = readFileSync(join(REPO, "src/tauri/ui/app/assistantAppBindings.ts"), "utf-8");
const APP_COMPOSITION_TS = readFileSync(join(REPO, "src/tauri/ui/app/assistantAppComposition.ts"), "utf-8");

// Isolate the handleEvent switch body so case-arm assertions don't match the union type.
function handleEventBody(): string {
  const start = APP_TS.indexOf("function handleEvent(");
  assert.ok(start >= 0, "app.ts must define handleEvent()");
  return APP_TS.slice(start);
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
    assert.ok(arm.includes("workflowView = null"), "the auto-run-completed arm must set workflowView = null");
    assert.ok(
      arm.includes("renderWorkflowCard()"),
      "the auto-run-completed arm must call renderWorkflowCard() to rebuild the idle Auto stage",
    );
  });
});

describe("assistant composition Pause stops either the live turn or the workflow (P-WLC symptom 2)", () => {
  it("WLC-UI.3: Pause uses runtime abort with an owner and workflow cancel without one", () => {
    // Given the composition, when Pause has no turn owner, then the binding calls the exact workflow cancel seam.
    assert.match(APP_BINDINGS_TS, /if \(deps\.getCurrentTurnId\(\) !== null\) return deps\.runtime\.pause\(\);/);
    assert.match(APP_BINDINGS_TS, /await deps\.cancelWorkflow\(\)/);
    assert.match(APP_COMPOSITION_TS, /"frondose_workflow_cancel"/);
    assert.match(APP_TS, /assistantAppComposition\.pause\(\)/);
  });
});
