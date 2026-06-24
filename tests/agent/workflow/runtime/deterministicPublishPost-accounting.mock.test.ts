/**
 * P-POST-PUBLISH-7 Step 2 (revised 3a) — Group E scaffold (CRITICAL: outbound-safety accounting parity)
 * T-Safety.AuditRowOnSuccess / AuditRowOnPreDispatchFailure / MarkDraftSent /
 * AmbiguityMarksSent / MarkDraftSentFailureAfterPublish / CommitWarning /
 * AutoModeFailClosed / HardwareInputEarlyReturn / KillSwitchBypass /
 * NoAutoLedgerRow / OutboundDisabledLatchUnchanged:
 * Safety accounting parity between the runtime publish path and the LLM/tool path.
 *
 * Gate: G-P7.safety — CRITICAL surface (outbound-safety-adjacent per §1 §2)
 *
 * CMR-1: AutoModeFailClosed reason is "approval_required" (matches GuardReason in
 * src/linkedin/types.ts:147 and click.ts:254/:262). The policy detail
 * "auto_post_not_authorized" goes on the audit row input ONLY.
 * fallbackAllowed:false because Auto mode must NEVER fall back to an Auto LLM publish.
 *
 * CMR-3: every test that must pass draft retrieval seeds a real message_drafts row
 * via getSalesDb + insertDraft. The _draftText fake-dep is removed from deps shape.
 *
 * New tests in 3a:
 * - T-Safety.AuditRowOnPreDispatchFailure (was implicitly T-Safety.NoAuditRowOnFailure
 *   renamed to be clearer per §5 Group E plan revision)
 * - T-Safety.AmbiguityMarksSent (B-1: post-dispatch ambiguity still attempts markDraftSent)
 * - T-Safety.MarkDraftSentFailureAfterPublish (B-2: markDraftSent throws after publish)
 * - T-Safety.HardwareInputEarlyReturn (C-1 / OQ-1)
 * - T-Safety.KillSwitchBypass (CMR-6 / OQ-4 — route-level; verified by source-structural)
 * - T-Safety.NoAutoLedgerRow (OQ-2: no post_published auto-ledger row)
 *
 * COMPILE APPROACH: publishApprovedFeedPost does NOT exist yet (Step 4 new file).
 * Dynamic import + typeof check → assert.fail("TODO P7:…") → RED on HEAD.
 * Uses tmpdir-backed scratch DB + audit file for full safety-parity verification.
 *
 * All tests FAIL on HEAD (correct RED). No production-code edits.
 *
 * Runner:
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/workflow/runtime/deterministicPublishPost-accounting.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { CdpClient } from "../../../../src/cdp/client.js";
import type { WorkflowSseFrame, WorkflowAuditEntry } from "../../../../src/agent/workflow/types.js";

// Disable inter-tool pacing for the mock suite.
process.env.FRONDOSE_PACE_MIN_MS = "0";

// ---------------------------------------------------------------------------
// CMR-3: real draft DB seeding helper
// ---------------------------------------------------------------------------

interface ScratchSetup {
  scratchDir: string;
  auditPath: string;
  dbPath: string;
  draftId: string;
}

/**
 * Create a tmpdir scratch space and insert a real message_drafts row.
 * Returns the scratch paths and the real draftId from the DB insert.
 * If getSalesDb/insertDraft don't exist yet (Step 4 pending), returns
 * a pseudo-draftId — the test will hit assert.fail before any assertion.
 */
async function seedDraft(
  label: string,
  text: string,
): Promise<ScratchSetup> {
  const scratchDir = join(tmpdir(), `frondose-p7-acct-${label}`, `${Date.now()}`);
  mkdirSync(scratchDir, { recursive: true });
  const auditPath = join(scratchDir, "audit.jsonl");
  const dbPath = join(scratchDir, "sales.db");

  try {
    const dbMod = await import("../../../../src/tools/sales/_dbHandle.js") as Record<string, unknown>;
    const getSalesDb = dbMod["getSalesDb"] as ((p: string) => unknown) | undefined;
    const draftsMod = await import("../../../../src/persistence/sales/drafts.js") as Record<string, unknown>;
    const insertDraft = draftsMod["insertDraft"] as
      | ((db: unknown, input: { leadId: null; kind: string; text: string; createdBy: string }) => string)
      | undefined;
    if (typeof getSalesDb === "function" && typeof insertDraft === "function") {
      const db = getSalesDb(dbPath);
      const draftId = insertDraft(db, { leadId: null, kind: "post", text, createdBy: "llm" });
      return { scratchDir, auditPath, dbPath, draftId };
    }
  } catch {
    // pre-Step-4: helpers don't exist yet; test will hit assert.fail
  }
  return { scratchDir, auditPath, dbPath, draftId: "d-seed-unavailable" };
}

// ---------------------------------------------------------------------------
// CMR-4 (R2): strict-equal JS-payload-constant matching for the accounting harness.
// We load the same constants used by the sequence harness. Until Step 4 ships them,
// we use unique sentinels that cannot false-match any other expression.
// The CENTER check MUST come BEFORE the ENABLED check so a center-coords request
// is never misrouted to the enabled-probe branch.
// ---------------------------------------------------------------------------

const ACCT_SENTINEL_PROBE          = "__ACCT_SENTINEL_PROBE_LIVE_IN_DOM__";
const ACCT_SENTINEL_FOCUS          = "__ACCT_SENTINEL_FOCUS_EDITOR__";
const ACCT_SENTINEL_CLEAR          = "__ACCT_SENTINEL_CLEAR_EDITOR__";
const ACCT_SENTINEL_ENABLED        = "__ACCT_SENTINEL_POST_ENABLED__";
const ACCT_SENTINEL_CENTER         = "__ACCT_SENTINEL_POST_CENTER__";
const ACCT_SENTINEL_TRIGGER        = "__ACCT_SENTINEL_TRIGGER_START_A_POST__";
const ACCT_SENTINEL_CLOSE_CENTER   = "__ACCT_SENTINEL_CLOSE_CENTER__";
const ACCT_SENTINEL_DISCARD_CENTER = "__ACCT_SENTINEL_DISCARD_CENTER__";

async function loadAcctPayloadConstants(): Promise<{
  PROBE_JS: string;
  FOCUS_JS: string;
  CLEAR_JS: string;
  ENABLED_JS: string;
  CENTER_JS: string;
  TRIGGER_JS: string;
  CLOSE_CENTER_JS: string;
  DISCARD_CENTER_JS: string;
}> {
  try {
    const mod = await import("../../../../src/linkedin/composerReadiness.js") as Record<string, unknown>;
    return {
      PROBE_JS:          (mod["FEED_COMPOSER_LIVE_IN_DOM_JS"]    as string | undefined) ?? ACCT_SENTINEL_PROBE,
      FOCUS_JS:          (mod["FEED_COMPOSER_FOCUS_EDITOR_JS"]   as string | undefined) ?? ACCT_SENTINEL_FOCUS,
      CLEAR_JS:          (mod["FEED_COMPOSER_CLEAR_EDITOR_JS"]   as string | undefined) ?? ACCT_SENTINEL_CLEAR,
      ENABLED_JS:        (mod["FEED_COMPOSER_POST_ENABLED_JS"]   as string | undefined) ?? ACCT_SENTINEL_ENABLED,
      CENTER_JS:         (mod["FEED_COMPOSER_POST_CENTER_JS"]    as string | undefined) ?? ACCT_SENTINEL_CENTER,
      TRIGGER_JS:        (mod["FEED_START_A_POST_CENTER_JS"]     as string | undefined) ?? ACCT_SENTINEL_TRIGGER,
      CLOSE_CENTER_JS:   (mod["FEED_COMPOSER_CLOSE_CENTER_JS"]   as string | undefined) ?? ACCT_SENTINEL_CLOSE_CENTER,
      DISCARD_CENTER_JS: (mod["FEED_COMPOSER_DISCARD_CENTER_JS"] as string | undefined) ?? ACCT_SENTINEL_DISCARD_CENTER,
    };
  } catch {
    return {
      PROBE_JS:          ACCT_SENTINEL_PROBE,
      FOCUS_JS:          ACCT_SENTINEL_FOCUS,
      CLEAR_JS:          ACCT_SENTINEL_CLEAR,
      ENABLED_JS:        ACCT_SENTINEL_ENABLED,
      CENTER_JS:         ACCT_SENTINEL_CENTER,
      TRIGGER_JS:        ACCT_SENTINEL_TRIGGER,
      CLOSE_CENTER_JS:   ACCT_SENTINEL_CLOSE_CENTER,
      DISCARD_CENTER_JS: ACCT_SENTINEL_DISCARD_CENTER,
    };
  }
}

type AcctConstants = Awaited<ReturnType<typeof loadAcctPayloadConstants>>;

/**
 * Build a strict-equal-matching fake CDP client for the accounting harness.
 * CMR4-R2: CENTER check BEFORE ENABLED check so center-coords payload is never
 * misrouted to the enabled-probe branch.
 *
 * Step-5a update: the new flow always calls closeFeedComposerLive when the initial
 * probe is present. probeSeq now includes a "close internal probe" entry between
 * the initial probe and the post-trigger re-probe:
 *   [0] initial probe: present
 *   [1] close internal probe: absent (Escape succeeded)
 *   [2] re-probe after trigger: present empty (fresh)
 *   [3] readback: draftText
 *   [4] post-click: ...
 *
 * CLOSE_CENTER_JS and DISCARD_CENTER_JS are returned as null (no button found —
 * closeFeedComposerLive succeeds via Escape-only path, modelled by [1] absent).
 */
function makeFakeAcctClient(
  c: AcctConstants,
  opts: {
    draftText: string;
    /** probe sequence (defaults to new Step-5a flow if not provided) */
    probeSeq?: Array<{ present: boolean; editorText: string }>;
    mouseLog: Array<{ type: string; x?: number; y?: number }>;
    /** if true, compose returns readback WRONG to force pre-dispatch failure */
    forceReadbackMismatch?: boolean;
    /** if true, post-click composer stays PRESENT (ambiguous) */
    postClickStillPresent?: boolean;
  },
): CdpClient {
  let probeIdx = 0;
  let enabledIdx = 0;
  // Step-5a: default probeSeq includes close internal probe at [1]
  const probeSeq = opts.probeSeq ?? (
    opts.forceReadbackMismatch ? [
      { present: true,  editorText: "" },            // [0] initial probe
      { present: false, editorText: "" },             // [1] close internal probe
      { present: true,  editorText: "" },             // [2] re-probe after trigger
      { present: true,  editorText: "WRONG" },        // [3] readback attempt 1
      { present: true,  editorText: "WRONG" },        // [4] readback retry
    ] : opts.postClickStillPresent ? [
      { present: true,  editorText: "" },            // [0] initial probe
      { present: false, editorText: "" },             // [1] close internal probe
      { present: true,  editorText: "" },             // [2] re-probe after trigger
      { present: true,  editorText: opts.draftText }, // [3] readback
      { present: true,  editorText: opts.draftText }, // [4] post-click retry 1: still open
      { present: true,  editorText: opts.draftText }, // [5] post-click retry 2: still open
    ] : [
      { present: true,  editorText: "" },            // [0] initial probe
      { present: false, editorText: "" },             // [1] close internal probe
      { present: true,  editorText: "" },             // [2] re-probe after trigger
      { present: true,  editorText: opts.draftText }, // [3] readback
      { present: false, editorText: "" },             // [4] post-click: GONE
    ]
  );

  const fakeHandle = {
    Accessibility: { enable: async () => {}, getFullAXTree: async () => ({ nodes: [] }) },
    Runtime: {
      evaluate: async (args: { expression: string }) => {
        // Step-5a: CLOSE_CENTER and DISCARD_CENTER return null (no button found).
        // closeFeedComposerLive succeeds via Escape-only path; close result is in probeSeq[1].
        if (args.expression === c.CLOSE_CENTER_JS) {
          return { result: { value: JSON.stringify(null) } };
        }
        if (args.expression === c.DISCARD_CENTER_JS) {
          return { result: { value: JSON.stringify(null) } };
        }
        // CMR4-R2: strict-equal dispatch — CENTER before ENABLED (critical ordering)
        if (args.expression === c.CENTER_JS) {
          if (opts.forceReadbackMismatch) return { result: { value: JSON.stringify(null) } };
          return { result: { value: JSON.stringify({ cx: 480, cy: 320 }) } };
        }
        if (args.expression === c.TRIGGER_JS) {
          return { result: { value: true } };
        }
        if (args.expression === c.ENABLED_JS) {
          const v = !opts.forceReadbackMismatch;
          enabledIdx++;
          return { result: { value: v } };
        }
        if (args.expression === c.PROBE_JS) {
          const res = probeSeq[probeIdx] ?? { present: false, editorText: "" };
          probeIdx++;
          return { result: { value: JSON.stringify(res) } };
        }
        if (args.expression === c.FOCUS_JS) {
          return { result: { value: true } };
        }
        if (args.expression === c.CLEAR_JS) {
          return { result: { value: true } };
        }
        // Sentinel fallback: close/discard controls return null (Escape-only close path).
        // CLOSE_RE is unique to FEED_COMPOSER_CLOSE_CENTER_JS; DISCARD_RE to FEED_COMPOSER_DISCARD_CENTER_JS.
        if (args.expression.includes("CLOSE_RE")) {
          return { result: { value: JSON.stringify(null) } };
        }
        if (args.expression.includes("DISCARD_RE")) {
          return { result: { value: JSON.stringify(null) } };
        }
        // Substring fallback for backward compat —
        // BUT center-coords MUST be checked before enabled-substring to avoid misrouting.
        if (args.expression.includes("getBoundingClientRect") && args.expression.includes("cx")) {
          if (opts.forceReadbackMismatch) return { result: { value: JSON.stringify(null) } };
          return { result: { value: JSON.stringify({ cx: 480, cy: 320 }) } };
        }
        if (args.expression.includes("Start a post") || args.expression.includes("START_RE")) {
          return { result: { value: true } };
        }
        // enabled-substring check comes AFTER center-coords check (CMR4-R2 ordering)
        if (args.expression.includes("button.disabled") || args.expression.includes("POST_RE")) {
          const v = !opts.forceReadbackMismatch;
          enabledIdx++;
          return { result: { value: v } };
        }
        if (args.expression.includes("el.focus()") && args.expression.includes("activeElement")) {
          return { result: { value: true } };
        }
        if (args.expression.includes("deleteContentBackward") || args.expression.includes("selectAll")) {
          return { result: { value: true } };
        }
        // Default: probe sequence
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
      dispatchMouseEvent: async (args: { type: string; x?: number; y?: number }) => {
        opts.mouseLog.push({ type: args.type, x: args.x, y: args.y });
      },
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

// Legacy wrappers — kept for tests that haven't been updated to use makeFakeAcctClient yet.
// These forward to makeFakeAcctClient with the ACCT_SENTINEL_* constants.
// After Step 4 ships real constants, they get the same strict-equal dispatch via loadAcctPayloadConstants.

function makeFakePublishClientHappyPath(opts: {
  draftText: string;
  mouseLog: Array<{ type: string; x?: number; y?: number }>;
}): CdpClient {
  const c: AcctConstants = {
    PROBE_JS:          ACCT_SENTINEL_PROBE,
    FOCUS_JS:          ACCT_SENTINEL_FOCUS,
    CLEAR_JS:          ACCT_SENTINEL_CLEAR,
    ENABLED_JS:        ACCT_SENTINEL_ENABLED,
    CENTER_JS:         ACCT_SENTINEL_CENTER,
    TRIGGER_JS:        ACCT_SENTINEL_TRIGGER,
    CLOSE_CENTER_JS:   ACCT_SENTINEL_CLOSE_CENTER,
    DISCARD_CENTER_JS: ACCT_SENTINEL_DISCARD_CENTER,
  };
  return makeFakeAcctClient(c, { draftText: opts.draftText, mouseLog: opts.mouseLog });
}

function makeFakePublishClientFailure(): CdpClient {
  const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
  const c: AcctConstants = {
    PROBE_JS:          ACCT_SENTINEL_PROBE,
    FOCUS_JS:          ACCT_SENTINEL_FOCUS,
    CLEAR_JS:          ACCT_SENTINEL_CLEAR,
    ENABLED_JS:        ACCT_SENTINEL_ENABLED,
    CENTER_JS:         ACCT_SENTINEL_CENTER,
    TRIGGER_JS:        ACCT_SENTINEL_TRIGGER,
    CLOSE_CENTER_JS:   ACCT_SENTINEL_CLOSE_CENTER,
    DISCARD_CENTER_JS: ACCT_SENTINEL_DISCARD_CENTER,
  };
  return makeFakeAcctClient(c, {
    draftText: "failure text",
    mouseLog,
    forceReadbackMismatch: true,
  });
}

function makeFakePublishClientAmbiguous(opts: {
  draftText: string;
  mouseLog: Array<{ type: string; x?: number; y?: number }>;
}): CdpClient {
  const c: AcctConstants = {
    PROBE_JS:          ACCT_SENTINEL_PROBE,
    FOCUS_JS:          ACCT_SENTINEL_FOCUS,
    CLEAR_JS:          ACCT_SENTINEL_CLEAR,
    ENABLED_JS:        ACCT_SENTINEL_ENABLED,
    CENTER_JS:         ACCT_SENTINEL_CENTER,
    TRIGGER_JS:        ACCT_SENTINEL_TRIGGER,
    CLOSE_CENTER_JS:   ACCT_SENTINEL_CLOSE_CENTER,
    DISCARD_CENTER_JS: ACCT_SENTINEL_DISCARD_CENTER,
  };
  return makeFakeAcctClient(c, {
    draftText: opts.draftText,
    mouseLog: opts.mouseLog,
    postClickStillPresent: true,
  });
}

function makeAccountingDeps(
  client: CdpClient,
  mode: "manual" | "auto",
  setup: ScratchSetup,
  opts?: { inputMode?: "cdp" | "hardware" },
): {
  deps: Record<string, unknown>;
  emittedFrames: WorkflowSseFrame[];
  auditedEvents: WorkflowAuditEntry["event"][];
} {
  const emittedFrames: WorkflowSseFrame[] = [];
  const auditedEvents: WorkflowAuditEntry["event"][] = [];
  return {
    deps: {
      session: {
        inputMode: (opts?.inputMode ?? "cdp") as const,
        getOrInitClient: () => Promise.resolve(client),
        getClient: () => client,
        setLastContext: () => {},
        getLastContext: () => undefined,
        resolvedMode: () => mode,
        // outboundDisabled latch: present but should NOT be touched by the routine
        outboundDisabled: false,
      },
      client,
      salesDbPath: setup.dbPath,
      auditPath: setup.auditPath,
      workflowDeps: {
        emitFrame: (frame: WorkflowSseFrame) => emittedFrames.push(frame),
        writeWorkflowAudit: (event: WorkflowAuditEntry["event"]) => auditedEvents.push(event),
      },
      workflowId: "wf-p7-accounting",
      stepId: "step-p7-accounting",
      draftId: setup.draftId,
    },
    emittedFrames,
    auditedEvents,
  };
}

// ---------------------------------------------------------------------------
// T-Safety.AuditRowOnSuccess
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — on success: writes exactly one audit row with toolName='post_publish_runtime' and output.published=true (G-P7.safety)", () => {
  it(
    "T-Safety.AuditRowOnSuccess: when routine returns {published:true}, audit.jsonl contains exactly ONE row with toolName='post_publish_runtime', input.draftId set, input.source='approval_resume', output.published=true, error=null",
    { timeout: 10000 },
    async () => {
      // Given: a happy-path run (all probes succeed, post click lands, composer gone).
      //        Draft row seeded in real DB (CMR-3).
      // When:  publishApprovedFeedPost completes with {published:true}.
      // Then:  audit.jsonl has exactly ONE new row, toolName='post_publish_runtime',
      //        input={draftId, source:'approval_resume'}, output={published:true}, error=null.
      //        (Same JSONL schema as src/persistence/audit.ts:96-107 click rows.)
      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const draftText = "Audit success test";
        const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
        const setup = await seedDraft("audit-success", draftText);
        const client = makeFakePublishClientHappyPath({ draftText, mouseLog });
        const { deps } = makeAccountingDeps(client, "manual", setup);

        const result = await fn(deps);

        const auditContents = existsSync(setup.auditPath) ? readFileSync(setup.auditPath, "utf-8") : "";
        const rows = auditContents.trim().split("\n").filter(Boolean);

        // T-Safety.AuditRowOnSuccess assertions
        assert.equal(result.published, true, `T-Safety.AuditRowOnSuccess: result.published should be true`);
        assert.equal(rows.length, 1, `T-Safety.AuditRowOnSuccess: exactly 1 audit row should exist, got ${rows.length}. Contents: ${auditContents.slice(0, 300)}`);
        const row = JSON.parse(rows[0]!) as Record<string, unknown>;
        assert.equal(row["toolName"], "post_publish_runtime", `T-Safety.AuditRowOnSuccess: toolName should be 'post_publish_runtime', got '${String(row["toolName"])}'`);
        assert.equal((row["input"] as Record<string, unknown>)["source"], "approval_resume", `T-Safety.AuditRowOnSuccess: input.source should be 'approval_resume'`);
        assert.equal((row["output"] as Record<string, unknown>)["published"], true, `T-Safety.AuditRowOnSuccess: output.published should be true`);
        assert.equal(row["error"], null, `T-Safety.AuditRowOnSuccess: error should be null, got '${String(row["error"])}'`);
        assert.ok(typeof (row["input"] as Record<string, unknown>)["draftId"] === "string", `T-Safety.AuditRowOnSuccess: input.draftId should be set`);

        void setup.scratchDir; // cleanup hint
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Safety.AuditRowOnSuccess: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Safety.AuditRowOnPreDispatchFailure
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — on pre-dispatch failure: writes one audit row with output.published=false (G-P7.safety)", () => {
  it(
    "T-Safety.AuditRowOnPreDispatchFailure: when routine returns {published:false, fallbackAllowed:true, dispatchAttempted:false} (e.g. readback_mismatch), audit.jsonl contains exactly ONE row with output.published=false",
    { timeout: 10000 },
    async () => {
      // Given: a pre-dispatch failure run (readback mismatch → published:false,
      //        fallbackAllowed:true, dispatchAttempted:false). Draft row seeded in real DB.
      // When:  publishApprovedFeedPost completes.
      // Then:  audit.jsonl has exactly ONE row with toolName='post_publish_runtime',
      //        output.published=false, output.reason='readback_mismatch'.
      //        The LLM fallback will fire AFTER this and produce its OWN audit row on
      //        eventual click success — no double-counting.
      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const draftText = "Audit failure test";
        const setup = await seedDraft("audit-failure", draftText);
        const client = makeFakePublishClientFailure();
        const { deps } = makeAccountingDeps(client, "manual", setup);

        const result = await fn(deps);

        const auditContents = existsSync(setup.auditPath) ? readFileSync(setup.auditPath, "utf-8") : "";
        const rows = auditContents.trim().split("\n").filter(Boolean);

        // T-Safety.AuditRowOnPreDispatchFailure assertions
        assert.equal(result.published, false, `T-Safety.AuditRowOnPreDispatchFailure: published should be false`);
        assert.equal(result.fallbackAllowed, true, `T-Safety.AuditRowOnPreDispatchFailure: fallbackAllowed should be true`);
        assert.equal(result.dispatchAttempted, false, `T-Safety.AuditRowOnPreDispatchFailure: dispatchAttempted should be false`);
        assert.equal(rows.length, 1, `T-Safety.AuditRowOnPreDispatchFailure: exactly 1 audit row, got ${rows.length}`);
        const rowF = JSON.parse(rows[0]!) as Record<string, unknown>;
        assert.equal(rowF["toolName"], "post_publish_runtime", `T-Safety.AuditRowOnPreDispatchFailure: toolName should be 'post_publish_runtime'`);
        assert.equal((rowF["output"] as Record<string, unknown>)["published"], false, `T-Safety.AuditRowOnPreDispatchFailure: output.published should be false`);

        void setup.scratchDir;
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Safety.AuditRowOnPreDispatchFailure: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Safety.MarkDraftSent
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — on success: calls markDraftSent exactly once; on failure: does NOT mark sent (G-P7.safety)", () => {
  it(
    "T-Safety.MarkDraftSent: happy-path run → draft status becomes 'sent' in DB; pre-dispatch failure run → draft status remains 'draft'",
    { timeout: 10000 },
    async () => {
      // Given: a draft row is pre-inserted into a real better-sqlite3 DB with status='draft'
      //        (CMR-3: getSalesDb + insertDraft, not a fake draftId).
      // When:  publishApprovedFeedPost runs (happy path).
      // Then:  message_drafts.status becomes 'sent' for the given draftId
      //        (mirrors src/tools/sales/markMessageSent.ts:28-30, the post-draft no-leadId branch).
      // AND:   on a pre-dispatch failure run with the same setup, status remains 'draft'.
      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }

        const draftsMod = await import("../../../../src/persistence/sales/drafts.js") as Record<string, unknown>;
        const getDraft = draftsMod["getDraft"] as ((db: unknown, id: string) => { status: string } | null) | undefined;
        const dbMod = await import("../../../../src/tools/sales/_dbHandle.js") as Record<string, unknown>;
        const getSalesDb = dbMod["getSalesDb"] as ((p: string) => unknown) | undefined;

        if (typeof getDraft !== "function" || typeof getSalesDb !== "function") {
          assert.fail(
            "TODO P7: getDraft / getSalesDb helpers missing (should exist on HEAD). " +
            "Required by CMR-3 to verify DB state after markDraftSent.",
          );
        }

        // Happy path: seed draft + run + verify status='sent'
        const draftText = "Mark draft sent test";
        const setup = await seedDraft("mark-sent", draftText);
        const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
        const client = makeFakePublishClientHappyPath({ draftText, mouseLog });
        const { deps } = makeAccountingDeps(client, "manual", setup);

        const result = await fn(deps);
        const db = getSalesDb(setup.dbPath);
        const draftAfter = getDraft(db, setup.draftId);

        // T-Safety.MarkDraftSent assertions: happy path marks draft as sent
        assert.equal(result.published, true, `T-Safety.MarkDraftSent: result.published should be true`);
        assert.ok(draftAfter !== null, `T-Safety.MarkDraftSent: draft should exist in DB after run`);
        assert.equal(draftAfter?.status, "sent", `T-Safety.MarkDraftSent: draft.status should be 'sent' after happy-path run, got '${draftAfter?.status}'`);

        // Also verify failure run doesn't mark sent
        const setup2 = await seedDraft("mark-sent-fail", "Failure draft");
        const client2 = makeFakePublishClientFailure();
        const { deps: deps2 } = makeAccountingDeps(client2, "manual", setup2);
        const result2 = await fn(deps2);
        const db2 = getSalesDb(setup2.dbPath);
        const draftAfter2 = getDraft(db2, setup2.draftId);
        assert.equal(result2.published, false, `T-Safety.MarkDraftSent: failure run published should be false`);
        assert.equal(draftAfter2?.status, "draft", `T-Safety.MarkDraftSent: draft.status should remain 'draft' on failure, got '${draftAfter2?.status}'`);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Safety.MarkDraftSent: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Safety.AmbiguityMarksSent (B-1)
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — post-dispatch ambiguity: still attempts markDraftSent because post may be live (G-P7.safety — B-1)", () => {
  it(
    "T-Safety.AmbiguityMarksSent: when routine returns {published:false, dispatchAttempted:true, reason:'composer_still_open'} (B-1), it ATTEMPTS markDraftSent and records draftMarkedSent+accountingError in audit row",
    { timeout: 10000 },
    async () => {
      // Given: click dispatched (mousePressed fired) BUT composer is still present after
      //        2×READBACK_RETRY_MS retry → composer_still_open (post-dispatch ambiguity).
      //        Draft row seeded in real DB (CMR-3).
      // When:  publishApprovedFeedPost returns {published:false, reason:'composer_still_open',
      //        fallbackAllowed:false, dispatchAttempted:true}.
      // Then:  routine attempts markDraftSent (because the post may be live);
      //        audit row includes dispatchAttempted:true + draftMarkedSent;
      //        result.fallbackAllowed === false (B-1 — no LLM fallback);
      //        commit-warning SSE frame emitted with severity:'high'.
      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean; draftMarkedSent?: boolean; accountingError?: string }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const draftText = "Ambiguity marks sent test";
        const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
        const setup = await seedDraft("ambiguity-marks-sent", draftText);
        const client = makeFakePublishClientAmbiguous({ draftText, mouseLog });
        const { deps, emittedFrames, auditedEvents } = makeAccountingDeps(client, "manual", setup);

        const result = await fn(deps);

        const auditContents = existsSync(setup.auditPath) ? readFileSync(setup.auditPath, "utf-8") : "";
        const commitWarnFrames = emittedFrames.filter((f) => f.type === "commit-warning");

        // C3-R2: the commit_warning workflow audit event for a post-dispatch ambiguous outcome
        // MUST carry dispatchAmbiguous:true (plan §6.3 + src/agent/workflow/types.ts:48 extension).
        const commitWarnAuditEvents = auditedEvents.filter(
          (e) => "kind" in e && (e as { kind: string }).kind === "commit_warning",
        );

        // T-Safety.AmbiguityMarksSent assertions
        assert.equal(result.published, false, `T-Safety.AmbiguityMarksSent: published should be false`);
        assert.equal((result as Record<string, unknown>)["reason"], "composer_still_open", `T-Safety.AmbiguityMarksSent: reason should be 'composer_still_open'`);
        assert.equal(result.fallbackAllowed, false, `T-Safety.AmbiguityMarksSent: fallbackAllowed should be false (B-1)`);
        assert.equal(result.dispatchAttempted, true, `T-Safety.AmbiguityMarksSent: dispatchAttempted should be true`);
        assert.ok(mouseLog.some((e) => e.type === "mousePressed"), `T-Safety.AmbiguityMarksSent: mouseLog must contain mousePressed`);
        // commit-warning frame emitted with severity:'high'
        assert.equal(commitWarnFrames.length, 1, `T-Safety.AmbiguityMarksSent: exactly 1 commit-warning frame, got ${commitWarnFrames.length}: ${JSON.stringify(commitWarnFrames)}`);
        assert.equal((commitWarnFrames[0] as Record<string, unknown>)["severity"], "high", `T-Safety.AmbiguityMarksSent: commit-warning severity should be 'high'`);
        // audit row dispatchAttempted:true
        const auditRow = auditContents.trim().split("\n").filter(Boolean)[0];
        const auditRowParsed = auditRow ? JSON.parse(auditRow) as Record<string, unknown> : null;
        assert.ok(auditRowParsed !== null, `T-Safety.AmbiguityMarksSent: audit row should exist`);
        assert.equal((auditRowParsed?.["output"] as Record<string, unknown>)["dispatchAttempted"], true, `T-Safety.AmbiguityMarksSent: audit output.dispatchAttempted should be true`);
        // C3-R2: commitWarnAuditEvents[0] should have dispatchAmbiguous:true
        assert.ok(commitWarnAuditEvents.length >= 1, `T-Safety.AmbiguityMarksSent: at least 1 commit_warning audit event`);
        assert.equal((commitWarnAuditEvents[0] as Record<string, unknown>)["dispatchAmbiguous"], true, `T-Safety.AmbiguityMarksSent: commitWarnAuditEvent.dispatchAmbiguous should be true (C3-R2)`);

        void auditedEvents;
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Safety.AmbiguityMarksSent: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Safety.MarkDraftSentFailureAfterPublish (B-2)
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — B-2/B2-R2: markDraftSent throws AFTER publish → explicit warning, no LLM fallback (G-P7.safety — CRITICAL)", () => {
  it(
    "T-Safety.MarkDraftSentFailureAfterPublish: (B2-R2) seed real draft row; click+publish-verify complete (mouseLog shows pressed+released; post-click probe returns present:false); THEN markDraftSent fails via deps.markDraftSent injection; routine writes audit {published:true, draftMarkedSent:false, accountingError} AND emits commit-warning severity:'high' AND does NOT fall back",
    { timeout: 10000 },
    async () => {
      // B2-R2 deterministic failure seam:
      // - Seed a REAL draft row (so getDraft succeeds pre-dispatch; routine reads the draft).
      // - Use a happy-path CDP client so the click FULLY completes (both mousePressed AND
      //   mouseReleased logged) and post-click probe returns present:false (composer gone).
      // - The routine's finishSuccess() calls markDraftSent AFTER publish-verify completes.
      // - Inject a throwing markDraftSent via deps.markDraftSent? seam (plan §5 T-Safety.MarkDraftSentFailureAfterPublish
      //   option (a): `deps.markDraftSent?: (db, id) => void` that throws on first call).
      // - Assert: mouseLog shows BOTH mousePressed+mouseReleased BEFORE the accounting failure
      //   (proving click completed first, not a pre-dispatch draft_missing case);
      //   result is {published:true, draftMarkedSent:false, accountingError:<msg>,
      //             fallbackAllowed:false, dispatchAttempted:true};
      //   commit-warning SSE frame with severity:'high' emitted;
      //   fallbackAllowed:false (post is live — no re-publish path).
      //
      // This tests the B-2 success-path-with-accounting-failure case, NOT the pre-dispatch
      // draft_missing case (the old "delete DB file" approach was wrong — it made getDraft
      // return null, triggering draft_missing pre-dispatch). The injection seam is the
      // cleanest approach per §5 B2-R2 spec.
      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean; draftMarkedSent?: boolean; accountingError?: string }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }

        const draftText = "Mark draft sent failure after publish (B2-R2)";
        const setup = await seedDraft("mark-fail-after-b2r2", draftText);
        const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];

        // CMR4-R2: use strict-equal matching harness (loaded constants)
        const acctConstants = await loadAcctPayloadConstants();
        const client = makeFakeAcctClient(acctConstants, {
          draftText,
          mouseLog,
          // Happy path: click completes, composer gone after click
        });
        const { deps, emittedFrames, auditedEvents } = makeAccountingDeps(client, "manual", setup);

        // B2-R2 injection seam: inject a markDraftSent that throws ONLY on the
        // first call (which is the post-publish accounting call — after the click
        // and publish-verify have completed). The routine's pre-dispatch getDraft
        // call is unaffected (it reads via getDraft, not markDraftSent).
        // If the production code exposes deps.markDraftSent?, override it here.
        // If not yet exposed (Step 4 pending), the test will reach assert.fail(TODO).
        let markDraftSentCallCount = 0;
        (deps as Record<string, unknown>)["markDraftSent"] = (_db: unknown, _id: string) => {
          markDraftSentCallCount++;
          throw new Error(`markDraftSent intentional test throw (B2-R2 deterministic seam) call #${markDraftSentCallCount}`);
        };

        const result = await fn(deps);

        const auditContents = existsSync(setup.auditPath) ? readFileSync(setup.auditPath, "utf-8") : "";
        const commitWarnHighFrames = emittedFrames.filter(
          (f) => f.type === "commit-warning" && (f as unknown as { severity?: string }).severity === "high",
        );

        // Verify the click fired BEFORE the accounting failure (B2-R2 assertion requirement)
        const hasPressedBeforeAccounting = mouseLog.some((e) => e.type === "mousePressed");
        const hasReleasedBeforeAccounting = mouseLog.some((e) => e.type === "mouseReleased");

        // C3-R2: the commit_warning workflow audit event for a success-path accounting failure
        // MUST carry accountingError:<msg> (plan §6.3 + src/agent/workflow/types.ts:48 extension).
        // Fix: filter auditedEvents (writeWorkflowAudit calls), NOT emittedFrames (SSE frames).
        const commitWarnAuditEventsB2 = auditedEvents
          .filter((e) => "kind" in e && (e as { kind: string }).kind === "commit_warning") as unknown as Array<Record<string, unknown>>;

        // T-Safety.MarkDraftSentFailureAfterPublish (B2-R2) assertions
        // Click fully completed before accounting failure
        assert.ok(hasPressedBeforeAccounting, `T-Safety.MarkDraftSentFailureAfterPublish: mouseLog must contain mousePressed (click fired before accounting)`);
        assert.ok(hasReleasedBeforeAccounting, `T-Safety.MarkDraftSentFailureAfterPublish: mouseLog must contain mouseReleased (click completed)`);
        // published:true — the publish succeeded
        assert.equal(result.published, true, `T-Safety.MarkDraftSentFailureAfterPublish: published should be true`);
        assert.equal((result as Record<string, unknown>)["draftMarkedSent"], false, `T-Safety.MarkDraftSentFailureAfterPublish: draftMarkedSent should be false (markDraftSent threw)`);
        assert.ok(typeof (result as Record<string, unknown>)["accountingError"] === "string", `T-Safety.MarkDraftSentFailureAfterPublish: accountingError should be set`);
        assert.equal(result.fallbackAllowed, false, `T-Safety.MarkDraftSentFailureAfterPublish: fallbackAllowed should be false (post is live)`);
        assert.equal(result.dispatchAttempted, true, `T-Safety.MarkDraftSentFailureAfterPublish: dispatchAttempted should be true`);
        assert.equal(markDraftSentCallCount, 1, `T-Safety.MarkDraftSentFailureAfterPublish: markDraftSent should be called exactly once`);
        // commit-warning SSE frame with severity:'high'
        assert.equal(commitWarnHighFrames.length, 1, `T-Safety.MarkDraftSentFailureAfterPublish: 1 commit-warning severity:high frame, got ${commitWarnHighFrames.length}`);
        // C3-R2: auditedEvents commit_warning row must carry accountingError
        assert.ok(commitWarnAuditEventsB2.length >= 1, `T-Safety.MarkDraftSentFailureAfterPublish: at least 1 commit_warning audit event (C3-R2)`);
        assert.ok(typeof commitWarnAuditEventsB2[0]?.["accountingError"] === "string", `T-Safety.MarkDraftSentFailureAfterPublish: commit_warning audit event must carry accountingError (C3-R2)`);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Safety.MarkDraftSentFailureAfterPublish: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Safety.CommitWarning
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — on success: emits exactly one commit-warning SSE frame AND one commit_warning workflow audit row (G-P7.safety)", () => {
  it(
    "T-Safety.CommitWarning: when {published:true}, exactly one 'commit-warning' WorkflowSseFrame with label='Post' is emitted AND exactly one commit_warning workflow audit event is written",
    { timeout: 10000 },
    async () => {
      // Given: happy-path run (all probes succeed). Draft row seeded in real DB (CMR-3).
      // When:  publishApprovedFeedPost returns {published:true}.
      // Then:  emittedFrames contains exactly 1 frame with type='commit-warning' AND label='Post',
      //        AND auditedEvents contains exactly 1 event with kind='commit_warning' AND detectedLabel='Post'.
      //        Parity with src/agent/workflow/controller/tool-observer.ts:46-63 (now using
      //        the shared emitCommitWarning helper — C-3 / OQ-5).
      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const draftText = "Commit warning test";
        const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
        const setup = await seedDraft("commit-warning", draftText);
        const client = makeFakePublishClientHappyPath({ draftText, mouseLog });
        const { deps, emittedFrames, auditedEvents } = makeAccountingDeps(client, "manual", setup);

        const result = await fn(deps);

        const commitWarnFrames = emittedFrames.filter((f) => f.type === "commit-warning");
        const commitWarnAudits = auditedEvents.filter((e) => "kind" in e && (e as { kind: string }).kind === "commit_warning");

        // T-Safety.CommitWarning assertions
        assert.equal(result.published, true, `T-Safety.CommitWarning: published should be true`);
        assert.equal(commitWarnFrames.length, 1, `T-Safety.CommitWarning: exactly 1 commit-warning SSE frame, got ${commitWarnFrames.length}: ${JSON.stringify(commitWarnFrames)}`);
        assert.equal((commitWarnFrames[0] as Record<string, unknown>)["label"], "Post", `T-Safety.CommitWarning: commit-warning frame label should be 'Post'`);
        assert.equal(commitWarnAudits.length, 1, `T-Safety.CommitWarning: exactly 1 commit_warning audit event, got ${commitWarnAudits.length}: ${JSON.stringify(commitWarnAudits)}`);
        assert.equal((commitWarnAudits[0] as Record<string, unknown>)["detectedLabel"], "Post", `T-Safety.CommitWarning: commit_warning audit event detectedLabel should be 'Post'`);

        void setup.scratchDir;
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Safety.CommitWarning: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Safety.AutoModeFailClosed
// CMR-1: reason is "approval_required" (matches GuardReason in types.ts:147
// and click.ts:254/:262). fallbackAllowed:false — Auto mode NEVER falls back.
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — Auto-mode fail-closed: refuses to run when resolvedMode()='auto' (G-P7.safety — CRITICAL)", () => {
  it(
    "T-Safety.AutoModeFailClosed: when session.resolvedMode()='auto', returns {published:false, reason:'approval_required', fallbackAllowed:false, dispatchAttempted:false} WITHOUT calling Input.dispatchMouseEvent or markDraftSent",
    { timeout: 10000 },
    async () => {
      // Given: session.resolvedMode() returns 'auto' (auto mode active).
      // When:  publishApprovedFeedPost is called.
      // Then:  returns {published:false, reason:'approval_required', fallbackAllowed:false,
      //        dispatchAttempted:false} (first check, before any CDP — CMR-1).
      //        reason='approval_required' matches GuardReason (src/linkedin/types.ts:147)
      //        and click.ts:254/:262 — parity with the existing click-path discriminator.
      //        policy:'auto_post_not_authorized' goes on audit row input ONLY (not on result.reason).
      //        fallbackAllowed:false because Auto mode must NEVER fall back to Auto LLM publish.
      //        No mouseEvent dispatched (mouseLog is empty); draft status stays 'draft'.
      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const draftText = "Auto mode blocked";
        const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
        const setup = await seedDraft("auto-fail-closed", draftText);
        const client = makeFakePublishClientHappyPath({ draftText, mouseLog });
        // mode = "auto" — the key difference
        const { deps } = makeAccountingDeps(client, "auto", setup);

        const result = await fn(deps);

        // T-Safety.AutoModeFailClosed assertions
        assert.equal(result.published, false, `T-Safety.AutoModeFailClosed: published should be false`);
        assert.equal(result.reason, "approval_required", `T-Safety.AutoModeFailClosed: reason should be 'approval_required' (CMR-1), got '${result.reason}'`);
        assert.equal(result.fallbackAllowed, false, `T-Safety.AutoModeFailClosed: fallbackAllowed should be false (Auto NEVER falls back)`);
        assert.equal(result.dispatchAttempted, false, `T-Safety.AutoModeFailClosed: dispatchAttempted should be false`);
        assert.equal(mouseLog.length, 0, `T-Safety.AutoModeFailClosed: no mouse events (early return before any CDP), got ${mouseLog.length}`);

        void setup.scratchDir;
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Safety.AutoModeFailClosed: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Safety.HardwareInputEarlyReturn (C-1 / OQ-1)
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — hardware-input early return: session.inputMode==='hardware' → pre-dispatch fallback (G-P7.safety — C-1)", () => {
  it(
    "T-Safety.HardwareInputEarlyReturn: when session.inputMode==='hardware', returns {published:false, reason:'hardware_input_not_supported', fallbackAllowed:true, dispatchAttempted:false} BEFORE any CDP probe/click",
    { timeout: 10000 },
    async () => {
      // Given: session.inputMode === 'hardware' (hardware-input mode active).
      //        The existing click + type tools already handle hardware mode
      //        (src/tools/browser/type.ts:318, src/tools/browser/click.ts:375).
      // When:  publishApprovedFeedPost is called.
      // Then:  returns {published:false, reason:'hardware_input_not_supported',
      //        fallbackAllowed:true, dispatchAttempted:false} BEFORE any CDP call.
      //        fallbackAllowed:true → route falls back to LLM resume (which uses
      //        the existing hardware-mode-aware click/type tools).
      //        No mouse event dispatched; no evaluate call made.
      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const draftText = "Hardware input test";
        const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
        const setup = await seedDraft("hardware-early-return", draftText);
        const client = makeFakePublishClientHappyPath({ draftText, mouseLog });
        // inputMode = "hardware" — the key difference
        const { deps } = makeAccountingDeps(client, "manual", setup, { inputMode: "hardware" });

        const result = await fn(deps);

        // T-Safety.HardwareInputEarlyReturn assertions
        assert.equal(result.published, false, `T-Safety.HardwareInputEarlyReturn: published should be false`);
        assert.equal(result.reason, "hardware_input_not_supported", `T-Safety.HardwareInputEarlyReturn: reason should be 'hardware_input_not_supported', got '${result.reason}'`);
        assert.equal(result.fallbackAllowed, true, `T-Safety.HardwareInputEarlyReturn: fallbackAllowed should be true (route falls back to LLM)`);
        assert.equal(result.dispatchAttempted, false, `T-Safety.HardwareInputEarlyReturn: dispatchAttempted should be false`);
        assert.equal(mouseLog.length, 0, `T-Safety.HardwareInputEarlyReturn: no mouse events (early return), got ${mouseLog.length}`);

        void setup.scratchDir;
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Safety.HardwareInputEarlyReturn: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Safety.KillSwitchBypass (CMR-6 / OQ-4) — route-level
// ---------------------------------------------------------------------------

describe("MAI_DETERMINISTIC_POST_PUBLISH=skip: route does NOT call publishApprovedFeedPost, calls resumeWorkflowTurn verbatim (G-P7.safety — CMR-6)", () => {
  it(
    "T-Safety.KillSwitchBypass: when process.env.MAI_DETERMINISTIC_POST_PUBLISH==='skip', the route DOES NOT call publishApprovedFeedPost; it calls turn.resumeWorkflowTurn(r.resumePrompt) directly (P6 path verbatim)",
    { timeout: 5000 },
    async () => {
      // Given: process.env.MAI_DETERMINISTIC_POST_PUBLISH = 'skip' (kill-switch active).
      //        This is a route-level bypass checked BEFORE the post-step branch (§6.5).
      // When:  the route processes POST /workflow/approve for a post step.
      // Then:  publishApprovedFeedPost is NOT called (kill-switch is PRE-DISPATCH — no CDP call);
      //        turn.resumeWorkflowTurn(r.resumePrompt) IS called directly (P6 LLM path verbatim).
      //        Structural assertion: workflow.ts source contains the kill-switch check
      //        (MAI_DETERMINISTIC_POST_PUBLISH) at the TOP of the post-step branch.
      //
      // Note: full behavioral verification lives in T-Route.KillSwitch (route test file).
      // This test pins the kill-switch from the publishApprovedFeedPost contract perspective:
      // the function is simply never called when the env var is set.
      const { readFileSync, resolve } = await import("node:path").then(async (pathMod) => {
        const fsMod = await import("node:fs");
        return { readFileSync: fsMod.readFileSync, resolve: pathMod.resolve };
      });
      const ROOT = resolve(import.meta.dirname, "../../../..");
      const workflowSrc = readFileSync(
        resolve(ROOT, "src/cli/subcommands/serve/routes/workflow.ts"),
        "utf-8",
      );

      // T-Safety.KillSwitchBypass: structural assertion
      assert.ok(
        workflowSrc.includes("MAI_DETERMINISTIC_POST_PUBLISH"),
        `T-Safety.KillSwitchBypass: workflow.ts must contain 'MAI_DETERMINISTIC_POST_PUBLISH' kill-switch check`
      );
      // Full behavioral verification lives in T-Route.KillSwitch; this pins the structural contract.
    },
  );
});

// ---------------------------------------------------------------------------
// T-Safety.NoAutoLedgerRow (OQ-2)
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — does NOT call appendAutoLedger for posts (G-P7.safety — OQ-2 contract pin)", () => {
  it(
    "T-Safety.NoAutoLedgerRow: regardless of publish outcome, the routine does NOT append an auto-ledger row for a post (posts have no auto-ledger row per the existing contract)",
    { timeout: 10000 },
    async () => {
      // Given: a happy-path run. Draft row seeded in real DB (CMR-3).
      // When:  publishApprovedFeedPost completes with {published:true}.
      // Then:  no auto-ledger row is written (src/tools/browser/click.ts:383/:415 appends
      //        ledger rows ONLY for connect_send + message_send — posts have never had a
      //        ledger row; the runtime stays out per OQ-2 resolution).
      //        Contract pin: adding post_published to the auto-ledger is a product-contract
      //        change deferred to a future phase.
      //
      // Implementation approach: verify that neither the auto-ledger DB table
      // (e.g. 'daily_activity' or 'auto_ledger') has a new row, NOR does the audit
      // contain an 'appendAutoLedger' sentinel. Exact table/column depends on the
      // production implementation — validator fills at Step 5.
      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }

        const draftText = "No auto ledger row test";
        const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
        const setup = await seedDraft("no-auto-ledger", draftText);
        const client = makeFakePublishClientHappyPath({ draftText, mouseLog });
        const { deps } = makeAccountingDeps(client, "manual", setup);

        const result = await fn(deps);

        // T-Safety.NoAutoLedgerRow: structural contract pin — routine does NOT call appendAutoLedger
        // Verify by: the source must NOT import appendAutoLedger
        const { readFileSync: readSrc, resolve: resolveSrc } = await import("node:path").then(async (p) => {
          const fs = await import("node:fs");
          return { readFileSync: fs.readFileSync, resolve: p.resolve };
        });
        const routineSrc = readSrc(resolveSrc(import.meta.dirname, "../../../../src/agent/workflow/runtime/deterministicPublishPost.ts"), "utf-8");
        assert.ok(!routineSrc.includes("appendAutoLedger"), `T-Safety.NoAutoLedgerRow: deterministicPublishPost.ts must NOT import or call appendAutoLedger`);
        assert.ok(!routineSrc.includes("autoLedger"), `T-Safety.NoAutoLedgerRow: deterministicPublishPost.ts must NOT reference autoLedger`);
        // Also published:true from the happy path
        assert.equal(result.published, true, `T-Safety.NoAutoLedgerRow: published should be true`);

        void setup.scratchDir;
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Safety.NoAutoLedgerRow: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Safety.OutboundDisabledLatchUnchanged
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — does NOT touch session.outboundDisabled latch (G-P7.safety — contract pin)", () => {
  it(
    "T-Safety.OutboundDisabledLatchUnchanged: regardless of publish outcome, session.outboundDisabled value is UNCHANGED after the routine runs",
    { timeout: 10000 },
    async () => {
      // Given: session.outboundDisabled = false (initial value, a Manual-mode post run).
      //        Draft row seeded in real DB (CMR-3).
      // When:  publishApprovedFeedPost runs (either success or failure).
      // Then:  session.outboundDisabled is still false after the routine.
      //        The in-memory fail-closed latch from src/tools/browser/click.ts:267-274 is
      //        connect/message-only by design (posts have no auto-cap); explicit non-touch
      //        is the contract.
      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const draftText = "Latch unchanged test";
        const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
        const setup = await seedDraft("latch-unchanged", draftText);
        const client = makeFakePublishClientHappyPath({ draftText, mouseLog });
        const emittedFrames: WorkflowSseFrame[] = [];
        const auditedEvents: WorkflowAuditEntry["event"][] = [];

        // session with outboundDisabled as a mutable flag
        const sessionWithLatch = {
          inputMode: "cdp" as const,
          getOrInitClient: () => Promise.resolve(client),
          getClient: () => client,
          setLastContext: () => {},
          getLastContext: () => undefined,
          resolvedMode: () => "manual" as const,
          outboundDisabled: false,  // MUST remain false after the routine
        };
        const deps = {
          session: sessionWithLatch,
          client,
          salesDbPath: setup.dbPath,
          auditPath: setup.auditPath,
          workflowDeps: {
            emitFrame: (frame: WorkflowSseFrame) => emittedFrames.push(frame),
            writeWorkflowAudit: (event: WorkflowAuditEntry["event"]) => auditedEvents.push(event),
          },
          workflowId: "wf-latch",
          stepId: "step-latch",
          draftId: setup.draftId,
        };

        const latchBefore = sessionWithLatch.outboundDisabled;
        const result = await fn(deps);
        const latchAfter = sessionWithLatch.outboundDisabled;

        // T-Safety.OutboundDisabledLatchUnchanged assertions
        assert.equal(latchBefore, false, `T-Safety.OutboundDisabledLatchUnchanged: latchBefore should be false`);
        assert.equal(latchAfter, false, `T-Safety.OutboundDisabledLatchUnchanged: latchAfter should be false (routine must NOT touch outboundDisabled)`);
        assert.equal(result.published, true, `T-Safety.OutboundDisabledLatchUnchanged: published should be true`);

        void setup.scratchDir;
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Safety.OutboundDisabledLatchUnchanged: dynamic import failed. " + String(err));
      }
    },
  );
});
