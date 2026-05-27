/**
 * P-SP-E Step 5 — T-E.Cancel.1..3 + T-E.ServeDeps.1 (G-PSPE.12) — assertions filled.
 * /workflow/cancel extension: closes active auto-run; regression tests + CONCERN-MR-3 no-workflow case.
 * T-E.ServeDeps.1: ServeDeps.salesDbPath field type-check (regression guard).
 *
 * RESULTS NOTE (Step 5):
 *   T-E.Cancel.1/2/3: FAIL — routes.ts cancel extension (OQ-E5) was NOT implemented
 *     by the builder. The /workflow/cancel handler at lines 232-238 routes entirely
 *     through deps.workflow.handleEndpoint without checking state.autoRunId or calling
 *     endAutoRun. These are recorded as DEFECT D-SP-E-Cancel.1/2/3.
 *   T-E.ServeDeps.1: PASS — context.ts ServeDeps has salesDbPath: string. ✓
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/serve/workflowCancelAutoRun.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const ROUTES_SRC = readFileSync(resolve(ROOT, "src/cli/subcommands/serve/routes.ts"), "utf-8");
const CONTEXT_SRC = readFileSync(resolve(ROOT, "src/cli/subcommands/serve/context.ts"), "utf-8");

describe("T-E.Cancel — /workflow/cancel auto-run extension (P-SP-E routes.ts + OQ-E5)", () => {
  // ─── T-E.Cancel.1 ────────────────────────────────────────────────────────────
  it("T-E.Cancel.1: routes.ts extension present — /workflow/cancel + state.autoRunId set → BOTH workflow cancel AND endAutoRun called AND auto-run-completed emitted", () => {
    // Given: routes.ts handles POST /workflow/cancel
    // When:  handler executes with state.autoRunId !== null AND active workflow
    // Then:  routes.ts source contains extension code:
    //        (1) checks `state.autoRunId !== null` after the controller call;
    //        (2) calls endAutoRun with status='stopped_by_user';
    //        (3) calls emitFrame with type='auto-run-completed'
    //   Covers G-PSPE.12 — T-E.Cancel.1 source-structural assertion
    //
    // DEFECT D-SP-E-Cancel.1: routes.ts /workflow/ handler does NOT implement
    // the auto-run extension. Lines 232-238 just call deps.workflow.handleEndpoint()
    // and sendJson the result — no autoRunId check, no endAutoRun, no emitFrame.
    assert.ok(
      ROUTES_SRC.includes("autoRunId") &&
        ROUTES_SRC.includes("endAutoRun") &&
        ROUTES_SRC.includes("auto-run-completed"),
      "T-E.Cancel.1: routes.ts MUST contain autoRunId check + endAutoRun call + auto-run-completed emission for /workflow/cancel [DEFECT D-SP-E-Cancel.1: OQ-E5 extension not implemented]",
    );
  });

  // ─── T-E.Cancel.2 ────────────────────────────────────────────────────────────
  it("T-E.Cancel.2: regression — state.autoRunId === null + /workflow/cancel → ONLY existing cancel behavior; source shows auto-run extension guarded by autoRunId null-check", () => {
    // Given: routes.ts cancel extension exists (per T-E.Cancel.1)
    // When:  handler executes with state.autoRunId === null
    // Then:  routes.ts source guards the auto-run close path with `state.autoRunId !== null`
    //
    // DEFECT D-SP-E-Cancel.2: routes.ts has no autoRunId guard in cancel handler.
    // The entire extension is missing (D-SP-E-Cancel.1). This test also fails.
    assert.ok(
      ROUTES_SRC.includes("autoRunId !== null") || ROUTES_SRC.includes("state.autoRunId"),
      "T-E.Cancel.2: routes.ts must guard the auto-run close path with state.autoRunId check [DEFECT D-SP-E-Cancel.2: guard not present]",
    );
  });

  // ─── T-E.Cancel.3 ────────────────────────────────────────────────────────────
  it("T-E.Cancel.3 (G-PSPE.12 / CONCERN-MR-3 NEW): state.autoRunId set + NO workflow → controller returns {ok:false, reason:'no_workflow'} BUT extension closes auto-run AND responds {ok:true, closedAutoRun:true}", () => {
    // Given: routes.ts has the P-SP-E cancel extension (per OQ-E5 round-1 revision)
    //        state.autoRunId !== null but state.currentTurn === null (no workflow active)
    // When:  POST /workflow/cancel received
    // Then:  routes.ts source: (a) calls controller.handleEndpoint; (b) checks {ok:false} result;
    //        (c) OVERRIDES with {ok:true, closedAutoRun:true} when autoRunId was set
    //
    // DEFECT D-SP-E-Cancel.3: no override logic present (extension not implemented).
    assert.ok(
      ROUTES_SRC.includes("closedAutoRun") || ROUTES_SRC.includes("stopped_by_user"),
      "T-E.Cancel.3: routes.ts must contain closedAutoRun override or stopped_by_user call [DEFECT D-SP-E-Cancel.3: CONCERN-MR-3 override not implemented]",
    );
  });
});

describe("T-E.ServeDeps — ServeDeps.salesDbPath type-check regression (P-SP-E Sketch F.4)", () => {
  // ─── T-E.ServeDeps.1 ─────────────────────────────────────────────────────────
  it("T-E.ServeDeps.1: context.ts ServeDeps interface has salesDbPath: string field (CONCERN-MR-1 / Sketch F.4)", () => {
    // Given: src/cli/subcommands/serve/context.ts ServeDeps interface
    // When:  source inspected for salesDbPath field declaration
    // Then:  source contains 'salesDbPath' within the ServeDeps interface body
    //   (Prevents regression: removing the field breaks all cron.ts + routes.ts wiring)
    assert.ok(
      CONTEXT_SRC.includes("salesDbPath"),
      "T-E.ServeDeps.1: context.ts ServeDeps must declare 'salesDbPath' field",
    );
    // More specific: verify it's declared as a string (not just mentioned in a comment)
    assert.ok(
      /salesDbPath\s*:\s*string/.test(CONTEXT_SRC),
      "T-E.ServeDeps.1: salesDbPath must be typed as 'string' in ServeDeps",
    );
  });
});
