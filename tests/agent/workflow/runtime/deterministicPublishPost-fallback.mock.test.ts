/**
 * P-POST-PUBLISH-7 Step 2 — Group F (fallback side) scaffold
 * T-Safety.NoDoublePost:
 * When publishApprovedFeedPost returns {published:true}, the route does NOT call
 * turn.resumeWorkflowTurn (idempotency — no second publish path).
 *
 * Gate: G-P7.route (fallback / idempotency side)
 *
 * Note: The full route-level fallback tests (T-Route.*) live in
 * tests/cli/serve/routes/workflow-postPublishRouting.mock.test.ts.
 * This file covers the fallback contract from the publishApprovedFeedPost side —
 * specifically the NoDoublePost guarantee (when published:true, no LLM resume).
 *
 * COMPILE APPROACH: publishApprovedFeedPost does NOT exist yet (Step 4 new file).
 * Dynamic import + typeof check → assert.fail("TODO P7:…") → RED on HEAD.
 *
 * All tests FAIL on HEAD (correct RED). No production-code edits.
 *
 * Runner:
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/workflow/runtime/deterministicPublishPost-fallback.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { CdpClient } from "../../../../src/cdp/client.js";
import type { WorkflowSseFrame, WorkflowAuditEntry } from "../../../../src/agent/workflow/types.js";

// Disable inter-tool pacing for the mock suite.
process.env.FRONDOSE_PACE_MIN_MS = "0";

// ---------------------------------------------------------------------------
// Minimal harness
// ---------------------------------------------------------------------------

function makeFakeHappyPathClient(draftText: string): CdpClient {
  let probeIdx = 0;
  // Step-5a: initial probe present → close → trigger → re-probe → happy path.
  // [0] initial probe: present (triggers close path)
  // [1] close internal probe: absent (Escape succeeded)
  // [2] re-probe after trigger: present empty (fresh)
  // [3] readback: draftText
  // [4] post-click: gone
  const probeSeq = [
    { present: true,  editorText: "" },          // [0] initial probe
    { present: false, editorText: "" },           // [1] close internal probe
    { present: true,  editorText: "" },           // [2] re-probe after trigger
    { present: true,  editorText: draftText },   // [3] readback
    { present: false, editorText: "" },           // [4] post-click: gone
  ];
  const fakeHandle = {
    Accessibility: { enable: async () => {}, getFullAXTree: async () => ({ nodes: [] }) },
    Runtime: {
      evaluate: async (args: { expression: string }) => {
        // Step-5a: CLOSE_CENTER and DISCARD_CENTER return null (Escape-only close path).
        // CLOSE_RE is unique to FEED_COMPOSER_CLOSE_CENTER_JS; DISCARD_RE to FEED_COMPOSER_DISCARD_CENTER_JS.
        if (args.expression.includes("CLOSE_RE")) {
          return { result: { value: JSON.stringify(null) } };
        }
        if (args.expression.includes("DISCARD_RE")) {
          return { result: { value: JSON.stringify(null) } };
        }
        if (args.expression.includes("el.focus()") && args.expression.includes("activeElement")) {
          return { result: { value: true } };
        }
        if (args.expression.includes("deleteContentBackward") || args.expression.includes("selectAll")) {
          return { result: { value: true } };
        }
        // CMR4-R2: center-coords check BEFORE enabled-substring check so a
        // FEED_COMPOSER_POST_CENTER_JS request is never misrouted to the enabled-probe branch.
        if (args.expression.includes("getBoundingClientRect") && args.expression.includes("cx")) {
          return { result: { value: JSON.stringify({ cx: 480, cy: 320 }) } };
        }
        if (args.expression.includes("button.disabled") || args.expression.includes("POST_RE")) {
          return { result: { value: true } };
        }
        if (args.expression.includes("Start a post") || args.expression.includes("START_RE")) {
          return { result: { value: true } };
        }
        const res = probeSeq[probeIdx] ?? { present: false, editorText: "" };
        probeIdx++;
        return { result: { value: JSON.stringify(res) } };
      },
    },
    DOM: {
      getDocument: async () => ({ root: { nodeId: 1 } }),
      querySelectorAll: async () => ({ nodeIds: [] }),
      scrollIntoViewIfNeeded: async () => {},
      getBoxModel: async () => ({ model: { border: [0, 0, 10, 0, 10, 10, 0, 10] } }),
    },
    Input: {
      dispatchMouseEvent: async () => {},
      dispatchKeyEvent: async () => {},
      insertText: async () => {},
      synthesizeScrollGesture: async () => {},
    },
    Browser: { close: async () => {} },
    Page: {
      enable: async () => {},
      navigate: async () => ({}),
      loadEventFired: (cb: (p: unknown) => void) => { setTimeout(() => cb({}), 0); return () => {}; },
      frameNavigated: (cb: (p: unknown) => void) => { setTimeout(() => cb({ frame: { url: "" } }), 0); return () => {}; },
      lifecycleEvent: (cb: (p: unknown) => void) => { setTimeout(() => cb({ name: "networkIdle" }), 0); return () => {}; },
      setLifecycleEventsEnabled: async () => {},
      getLayoutMetrics: async () => ({
        visualViewport: { pageX: 0, pageY: 0, clientWidth: 1440, clientHeight: 900 },
        cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1440, clientHeight: 900 },
        cssLayoutViewport: { clientWidth: 1440, clientHeight: 900 },
      }),
      reload: async () => {},
    },
  };
  return CdpClient.fromHandle(fakeHandle);
}

// ---------------------------------------------------------------------------
// T-Safety.NoDoublePost
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost + route idempotency — when routine returns {published:true}, the LLM resume is NOT called (G-P7.route — NoDoublePost)", () => {
  it(
    "T-Safety.NoDoublePost: when publishApprovedFeedPost returns {published:true}, the caller (route) does NOT invoke turn.resumeWorkflowTurn — no second outbound publish path",
    { timeout: 10000 },
    async () => {
      // Given: the route's async IIFE receives {published:true} from publishApprovedFeedPost.
      // When:  the IIFE's published===true branch executes.
      // Then:  turn.resumeWorkflowTurn is NOT called (the LLM resume is suppressed —
      //        idempotency gate: no double-post via the LLM fallback after a successful runtime publish).
      //        This test models the contract by calling publishApprovedFeedPost directly and
      //        verifying its return value, then asserting the caller-side contract:
      //        IF result.published === true THEN resumeWorkflowTurn must not fire.
      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const draftText = "No double post test";
        const client = makeFakeHappyPathClient(draftText);
        const scratchDir = join(tmpdir(), "frondose-p7-fallback", `${Date.now()}`);
        mkdirSync(scratchDir, { recursive: true });
        const auditPath = join(scratchDir, "audit.jsonl");
        const dbPath = join(scratchDir, "sales.db");

        // CMR-3: seed a real draft row so getDraft succeeds (without this the routine returns
        // draft_missing pre-dispatch, which has fallbackAllowed:true, causing resumeCallCount=1)
        let realDraftId = "d-no-double-seed-unavailable";
        try {
          const dbMod = await import("../../../../src/tools/sales/_dbHandle.js") as Record<string, unknown>;
          const getSalesDb = dbMod["getSalesDb"] as ((p: string) => unknown) | undefined;
          const draftsMod = await import("../../../../src/persistence/sales/drafts.js") as Record<string, unknown>;
          const insertDraft = draftsMod["insertDraft"] as
            | ((db: unknown, input: { leadId: null; kind: string; text: string; createdBy: string }) => string)
            | undefined;
          if (typeof getSalesDb === "function" && typeof insertDraft === "function") {
            const db = getSalesDb(dbPath);
            realDraftId = insertDraft(db, { leadId: null, kind: "post", text: draftText, createdBy: "llm" });
          }
        } catch {
          // getSalesDb/insertDraft not available — test will fail at result assertion if published:false
        }

        const emittedFrames: WorkflowSseFrame[] = [];
        const auditedEvents: WorkflowAuditEntry["event"][] = [];
        let resumeCallCount = 0;

        const deps = {
          session: {
            inputMode: "cdp" as const,
            getOrInitClient: () => Promise.resolve(client),
            getClient: () => client,
            setLastContext: () => {},
            getLastContext: () => undefined,
            resolvedMode: () => "manual" as const,
          },
          client,
          salesDbPath: dbPath,
          auditPath,
          workflowDeps: {
            emitFrame: (frame: WorkflowSseFrame) => emittedFrames.push(frame),
            writeWorkflowAudit: (event: WorkflowAuditEntry["event"]) => auditedEvents.push(event),
          },
          workflowId: "wf-no-double",
          stepId: "step-no-double",
          draftId: realDraftId,
        };

        const result = await fn(deps);

        // Simulate the route's IIFE logic from §6.5 (workflow.ts:112-113):
        //   if (result.dispatchAttempted) return;
        //   if (result.fallbackAllowed) await turn.resumeWorkflowTurn(resumePrompt);
        if (result) {
          if (!result.dispatchAttempted && result.fallbackAllowed) {
            resumeCallCount++;
          }
        }

        // T-Safety.NoDoublePost assertions
        assert.equal((result as Record<string, unknown>)["published"], true,
          `T-Safety.NoDoublePost: result.published should be true (draft seeded, happy-path client). Got: ${JSON.stringify(result)}`);
        assert.equal(resumeCallCount, 0,
          `T-Safety.NoDoublePost: resumeCallCount should be 0 (route must NOT call resumeWorkflowTurn when published:true). Got: resumeCallCount=${resumeCallCount}, result=${JSON.stringify(result)}`);

        void scratchDir;
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Safety.NoDoublePost: dynamic import failed. " + String(err));
      }
    },
  );
});
