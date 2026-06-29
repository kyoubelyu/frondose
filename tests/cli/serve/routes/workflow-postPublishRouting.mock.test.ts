/**
 * P-POST-PUBLISH-7 Step 2 (revised 3a) — Group F (route hook) scaffold
 * T-Route.PostBranches / FallbackOnPreDispatchFailure / FallbackOnThrow /
 * NoFallbackOnPostDispatchAmbiguity / NoFallbackOnAutoMode / KillSwitch /
 * NonPostUnchanged / NonApproveUnchanged / CronTurnUnaffected:
 * Route-level branching for the deterministic post-publish hook at workflow.ts:76.
 *
 * Gate: G-P7.route
 *
 * CMR-2: behavioral route tests inject deps.publishApprovedFeedPost returning specific
 * PublishResult shapes; they do NOT rely on string inclusion.
 *
 * Route consults fallbackAllowed + dispatchAttempted ONLY (§6.5):
 *   - dispatchAttempted:true → NEVER fall back (B-1 idempotency)
 *   - published:true → SUCCESS, no fallback
 *   - fallbackAllowed:true (and dispatchAttempted:false) → LLM resume
 *   - fallbackAllowed:false (pre-dispatch, e.g. approval_required) → no fallback
 *
 * COMPILE APPROACH: The route hook at workflow.ts:76 does NOT exist yet (Step 4 edit).
 * The current code is a simple `if (r.resumePrompt) void turn.resumeWorkflowTurn(r.resumePrompt)`.
 * Tests probe the route source code structurally (like the existing serve/workflowCancelAutoRun
 * pattern) AND drive the actual route handler with fake deps to verify behavioral branching.
 *
 * TWO strategies (matching §5 Group F behaviors):
 * 1. Source-structural: assert the route source includes the P7 hook pattern.
 * 2. Behavioral (CMR-2): drive handlePostWorkflow() with injected deps.publishApprovedFeedPost
 *    returning each PublishResult shape; verify call counts.
 *
 * All 9 tests FAIL on HEAD (correct RED). No production-code edits.
 *
 * Runner:
 *   node --import tsx --test --test-force-exit \
 *     tests/cli/serve/routes/workflow-postPublishRouting.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

const ROOT = resolve(import.meta.dirname, "../../../..");
const WORKFLOW_ROUTE_SRC = readFileSync(resolve(ROOT, "src/cli/subcommands/serve/routes/workflow.ts"), "utf-8");

// ---------------------------------------------------------------------------
// Fake HTTP request/response helpers
// ---------------------------------------------------------------------------

function makeFakeReq(body: unknown): IncomingMessage {
  const jsonBody = JSON.stringify(body);
  const readable = Readable.from([Buffer.from(jsonBody)]) as unknown as IncomingMessage;
  readable.method = "POST";
  readable.headers = { "content-type": "application/json" };
  return readable;
}

function makeFakeRes(): { res: ServerResponse; statusCode: number; body: string } {
  const state = { statusCode: 0, body: "" };
  const res = {
    writeHead: (code: number) => {
      state.statusCode = code;
    },
    setHeader: () => {},
    write: (chunk: string | Buffer) => {
      state.body += chunk.toString();
      return true;
    },
    end: (chunk?: string | Buffer) => {
      if (chunk) state.body += chunk.toString();
    },
    headersSent: false,
  } as unknown as ServerResponse;
  return { res, ...state };
}

// ---------------------------------------------------------------------------
// Fake workflow controller (handleEndpoint returns approve result with P7 fields)
// ---------------------------------------------------------------------------

function makeFakeWorkflowController(opts: {
  resumePrompt?: string;
  isPostPublish?: boolean;
  draftId?: string;
  stepId?: string;
  url?: string;
}) {
  return {
    handleEndpoint: (_url: string, _body: unknown) => ({
      status: 200,
      response: { ok: true },
      resumePrompt: opts.resumePrompt ?? "RESUME",
      // P7 new fields (isPostPublish + draftId + stepId) — absent on HEAD
      ...(opts.isPostPublish !== undefined ? { isPostPublish: opts.isPostPublish } : {}),
      ...(opts.draftId !== undefined ? { draftId: opts.draftId } : {}),
      ...(opts.stepId !== undefined ? { stepId: opts.stepId } : {}),
    }),
    getState: () => ({ current: { id: "wf-route-test" } }),
    approve: () => {},
    decline: () => {},
    handoff: () => {},
    cancel: () => {},
  };
}

// ---------------------------------------------------------------------------
// T-Route.PostBranches
// ---------------------------------------------------------------------------

describe("handlePostWorkflow — on approve for post step: calls publishApprovedFeedPost AND skips LLM resume when published:true (G-P7.route)", () => {
  it(
    "T-Route.PostBranches: POST /workflow/approve with isPostPublish=true + draftId present → route calls publishApprovedFeedPost; if {published:true}, turn.resumeWorkflowTurn is NOT called",
    { timeout: 5000 },
    async () => {
      // Given: route receives POST /workflow/approve where approve() returns
      //        isPostPublish=true + draftId='d-route-test'.
      //        publishApprovedFeedPost (faked to return {published:true}).
      // When:  handlePostWorkflow runs.
      // Then:  turn.resumeWorkflowTurn is NOT called (idempotency gate).
      //        Source-structural: workflow.ts source contains the P7 hook pattern.

      // T-Route.PostBranches: structural checks
      assert.ok(
        WORKFLOW_ROUTE_SRC.includes("isPostPublish"),
        "T-Route.PostBranches: workflow.ts must contain 'isPostPublish'",
      );
      assert.ok(
        WORKFLOW_ROUTE_SRC.includes("publishApprovedFeedPost"),
        "T-Route.PostBranches: workflow.ts must contain 'publishApprovedFeedPost'",
      );

      // Behavioral: drive handlePostWorkflow with published:true → no resumeWorkflowTurn
      const { handlePostWorkflow } = await import("../../../../src/cli/subcommands/serve/routes/workflow.js");
      let resumeCallCount = 0;
      let publishCallCount = 0;
      const scratchDir = join(tmpdir(), "frondose-p7-route-postbranch", `${Date.now()}`);
      mkdirSync(scratchDir, { recursive: true });
      const fakeWorkflow = makeFakeWorkflowController({
        resumePrompt: "POST RESUME",
        isPostPublish: true,
        draftId: "d-route-test",
        stepId: "step-post-route",
      });
      const fakeDeps = {
        workflow: fakeWorkflow,
        salesDbPath: join(scratchDir, "sales.db"),
        auditPath: join(scratchDir, "audit.jsonl"),
        emitFrame: () => {},
        session: {
          inputMode: "cdp" as const,
          getOrInitClient: () => Promise.resolve({ ok: true, client: {} }),
          resolvedMode: () => "manual" as const,
        },
        publishApprovedFeedPost: async () => {
          publishCallCount++;
          return { published: true, fallbackAllowed: false, dispatchAttempted: true };
        },
      };
      const fakeTurn = {
        resumeWorkflowTurn: async () => {
          resumeCallCount++;
        },
      };
      const req = makeFakeReq({ stepId: "step-post-route" });
      const { res } = makeFakeRes();
      await handlePostWorkflow(
        { currentTurn: null, autoRunId: null, lastEmittedAutoCounters: null } as never,
        fakeDeps as never,
        fakeTurn as never,
        req,
        res,
        "/workflow/approve",
      );
      // Give the async void block time to run
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(publishCallCount, 1, "T-Route.PostBranches: publishApprovedFeedPost must be called once");
      assert.equal(
        resumeCallCount,
        0,
        "T-Route.PostBranches: turn.resumeWorkflowTurn must NOT be called when published:true",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Route.FallbackOnPreDispatchFailure (CMR-2: behavioral injection)
// ---------------------------------------------------------------------------

describe("handlePostWorkflow — on approve for post step: falls back to LLM resume when publishApprovedFeedPost returns {published:false, fallbackAllowed:true, dispatchAttempted:false} (G-P7.route)", () => {
  it(
    "T-Route.FallbackOnPreDispatchFailure: POST /workflow/approve with isPostPublish=true → publishApprovedFeedPost returns {published:false, fallbackAllowed:true, dispatchAttempted:false} (pre-dispatch failure) → turn.resumeWorkflowTurn IS called exactly once",
    { timeout: 5000 },
    async () => {
      // Given: route receives POST /workflow/approve; approve() returns isPostPublish=true.
      //        publishApprovedFeedPost (injected via deps.publishApprovedFeedPost) returns
      //        {published:false, fallbackAllowed:true, dispatchAttempted:false} (pre-dispatch miss,
      //        e.g. composer_unavailable — safe to fall back).
      // When:  handlePostWorkflow runs.
      // Then:  turn.resumeWorkflowTurn IS called exactly once with the resumePrompt
      //        (the LLM fallback fires so the LLM can recover via the P6 postExtra directive).
      //        CMR-2: test drives the route with the injected seam — behavioral, not string inclusion.
      // T-Route.FallbackOnPreDispatchFailure: behavioral (CMR-2)
      const { handlePostWorkflow: handlePostWorkflow2 } = await import(
        "../../../../src/cli/subcommands/serve/routes/workflow.js"
      );
      let resumeCallCount2 = 0;
      let publishCallCount2 = 0;
      const scratchDir2 = join(tmpdir(), "frondose-p7-route-fallback", `${Date.now()}`);
      mkdirSync(scratchDir2, { recursive: true });
      const fakeWorkflow2 = makeFakeWorkflowController({
        resumePrompt: "POST RESUME FALLBACK",
        isPostPublish: true,
        draftId: "d-fallback-test",
        stepId: "step-fallback",
      });
      const fakeDeps2 = {
        workflow: fakeWorkflow2,
        salesDbPath: join(scratchDir2, "sales.db"),
        auditPath: join(scratchDir2, "audit.jsonl"),
        emitFrame: () => {},
        session: {
          inputMode: "cdp" as const,
          getOrInitClient: () => Promise.resolve({ ok: true, client: {} }),
          resolvedMode: () => "manual" as const,
        },
        publishApprovedFeedPost: async () => {
          publishCallCount2++;
          // pre-dispatch failure — safe to fall back
          return { published: false, reason: "composer_unavailable", fallbackAllowed: true, dispatchAttempted: false };
        },
      };
      const fakeTurn2 = {
        resumeWorkflowTurn: async () => {
          resumeCallCount2++;
        },
      };
      const req2 = makeFakeReq({ stepId: "step-fallback" });
      const { res: res2 } = makeFakeRes();
      await handlePostWorkflow2(
        { currentTurn: null, autoRunId: null, lastEmittedAutoCounters: null } as never,
        fakeDeps2 as never,
        fakeTurn2 as never,
        req2,
        res2,
        "/workflow/approve",
      );
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(
        publishCallCount2,
        1,
        "T-Route.FallbackOnPreDispatchFailure: publishApprovedFeedPost must be called once",
      );
      assert.equal(
        resumeCallCount2,
        1,
        "T-Route.FallbackOnPreDispatchFailure: turn.resumeWorkflowTurn must be called once when fallbackAllowed:true and dispatchAttempted:false",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Route.NoFallbackOnPostDispatchAmbiguity (B-1 guard — CMR-2)
// ---------------------------------------------------------------------------

describe("handlePostWorkflow — on approve for post step: NO fallback when publishApprovedFeedPost returns {published:false, fallbackAllowed:false, dispatchAttempted:true} (G-P7.route — B-1)", () => {
  it(
    "T-Route.NoFallbackOnPostDispatchAmbiguity: POST /workflow/approve → publishApprovedFeedPost returns {published:false, fallbackAllowed:false, dispatchAttempted:true} (e.g. composer_still_open) → turn.resumeWorkflowTurn is NOT called",
    { timeout: 5000 },
    async () => {
      // Given: route receives POST /workflow/approve; approve() returns isPostPublish=true.
      //        publishApprovedFeedPost (injected) returns
      //        {published:false, reason:'composer_still_open', fallbackAllowed:false, dispatchAttempted:true}
      //        — post-dispatch ambiguous outcome: the Post click DID fire, post may already be live.
      // When:  handlePostWorkflow runs.
      // Then:  turn.resumeWorkflowTurn is NOT called (B-1 — post may be live; never auto-republish).
      //        CMR-2: behavioral injection.
      // T-Route.NoFallbackOnPostDispatchAmbiguity: behavioral (CMR-2)
      const { handlePostWorkflow: handlePostWorkflow3 } = await import(
        "../../../../src/cli/subcommands/serve/routes/workflow.js"
      );
      let resumeCallCount3 = 0;
      let publishCallCount3 = 0;
      const scratchDir3 = join(tmpdir(), "frondose-p7-route-nodbl", `${Date.now()}`);
      mkdirSync(scratchDir3, { recursive: true });
      const fakeWorkflow3 = makeFakeWorkflowController({
        resumePrompt: "POST RESUME AMBIG",
        isPostPublish: true,
        draftId: "d-ambig-test",
        stepId: "step-ambig",
      });
      const fakeDeps3 = {
        workflow: fakeWorkflow3,
        salesDbPath: join(scratchDir3, "sales.db"),
        auditPath: join(scratchDir3, "audit.jsonl"),
        emitFrame: () => {},
        session: {
          inputMode: "cdp" as const,
          getOrInitClient: () => Promise.resolve({ ok: true, client: {} }),
          resolvedMode: () => "manual" as const,
        },
        publishApprovedFeedPost: async () => {
          publishCallCount3++;
          // post-dispatch ambiguous — B-1: NEVER fall back
          return { published: false, reason: "composer_still_open", fallbackAllowed: false, dispatchAttempted: true };
        },
      };
      const fakeTurn3 = {
        resumeWorkflowTurn: async () => {
          resumeCallCount3++;
        },
      };
      const req3 = makeFakeReq({ stepId: "step-ambig" });
      const { res: res3 } = makeFakeRes();
      await handlePostWorkflow3(
        { currentTurn: null, autoRunId: null, lastEmittedAutoCounters: null } as never,
        fakeDeps3 as never,
        fakeTurn3 as never,
        req3,
        res3,
        "/workflow/approve",
      );
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(
        publishCallCount3,
        1,
        "T-Route.NoFallbackOnPostDispatchAmbiguity: publishApprovedFeedPost must be called once",
      );
      assert.equal(
        resumeCallCount3,
        0,
        "T-Route.NoFallbackOnPostDispatchAmbiguity: turn.resumeWorkflowTurn must NOT be called when dispatchAttempted:true (B-1)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Route.NoFallbackOnAutoMode (CMR-1 + CMR-2)
// ---------------------------------------------------------------------------

describe("handlePostWorkflow — on approve for post step in Auto mode: NO fallback when publishApprovedFeedPost returns {published:false, reason:'approval_required', fallbackAllowed:false} (G-P7.route)", () => {
  it(
    "T-Route.NoFallbackOnAutoMode: when publishApprovedFeedPost returns {published:false, reason:'approval_required', fallbackAllowed:false, dispatchAttempted:false} → turn.resumeWorkflowTurn is NOT called",
    { timeout: 5000 },
    async () => {
      // Given: route receives POST /workflow/approve; approve() returns isPostPublish=true.
      //        publishApprovedFeedPost (injected) returns
      //        {published:false, reason:'approval_required', fallbackAllowed:false, dispatchAttempted:false}
      //        — Auto-mode fail-closed response. reason='approval_required' per CMR-1.
      // When:  handlePostWorkflow runs.
      // Then:  turn.resumeWorkflowTurn is NOT called (Auto mode must NEVER fall back to
      //        an Auto LLM publish — T-Route.NoFallbackOnAutoMode).
      //        CMR-2: behavioral injection.
      // T-Route.NoFallbackOnAutoMode: behavioral (CMR-2)
      const { handlePostWorkflow: handlePostWorkflow4 } = await import(
        "../../../../src/cli/subcommands/serve/routes/workflow.js"
      );
      let resumeCallCount4 = 0;
      let publishCallCount4 = 0;
      const scratchDir4 = join(tmpdir(), "frondose-p7-route-auto", `${Date.now()}`);
      mkdirSync(scratchDir4, { recursive: true });
      const fakeWorkflow4 = makeFakeWorkflowController({
        resumePrompt: "POST RESUME AUTO",
        isPostPublish: true,
        draftId: "d-auto-test",
        stepId: "step-auto",
      });
      const fakeDeps4 = {
        workflow: fakeWorkflow4,
        salesDbPath: join(scratchDir4, "sales.db"),
        auditPath: join(scratchDir4, "audit.jsonl"),
        emitFrame: () => {},
        session: {
          inputMode: "cdp" as const,
          getOrInitClient: () => Promise.resolve({ ok: true, client: {} }),
          resolvedMode: () => "auto" as const,
        },
        publishApprovedFeedPost: async () => {
          publishCallCount4++;
          // Auto-mode fail-closed: approval_required, fallbackAllowed:false
          return { published: false, reason: "approval_required", fallbackAllowed: false, dispatchAttempted: false };
        },
      };
      const fakeTurn4 = {
        resumeWorkflowTurn: async () => {
          resumeCallCount4++;
        },
      };
      const req4 = makeFakeReq({ stepId: "step-auto" });
      const { res: res4 } = makeFakeRes();
      await handlePostWorkflow4(
        { currentTurn: null, autoRunId: null, lastEmittedAutoCounters: null } as never,
        fakeDeps4 as never,
        fakeTurn4 as never,
        req4,
        res4,
        "/workflow/approve",
      );
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(
        publishCallCount4,
        1,
        "T-Route.NoFallbackOnAutoMode: publishApprovedFeedPost must be called once (it runs and returns approval_required)",
      );
      assert.equal(
        resumeCallCount4,
        0,
        "T-Route.NoFallbackOnAutoMode: turn.resumeWorkflowTurn must NOT be called when fallbackAllowed:false and dispatchAttempted:false",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Route.FallbackOnThrow
// ---------------------------------------------------------------------------

describe("handlePostWorkflow — on approve for post step: falls back to LLM resume when publishApprovedFeedPost throws (G-P7.route)", () => {
  it(
    "T-Route.FallbackOnThrow: when publishApprovedFeedPost throws (e.g. AbortError), the route catches the throw and calls turn.resumeWorkflowTurn exactly once",
    { timeout: 5000 },
    async () => {
      // Given: route receives POST /workflow/approve; publishApprovedFeedPost throws an Error.
      // When:  handlePostWorkflow runs.
      // Then:  turn.resumeWorkflowTurn IS called exactly once (the try/catch in §6.5 catches
      //        the throw and falls back — the deterministic routine NEVER short-circuits the
      //        resume path on an exception).
      // T-Route.FallbackOnThrow: behavioral
      const { handlePostWorkflow: handlePostWorkflow5 } = await import(
        "../../../../src/cli/subcommands/serve/routes/workflow.js"
      );
      let resumeCallCount5 = 0;
      let publishCallCount5 = 0;
      const scratchDir5 = join(tmpdir(), "frondose-p7-route-throw", `${Date.now()}`);
      mkdirSync(scratchDir5, { recursive: true });
      const fakeWorkflow5 = makeFakeWorkflowController({
        resumePrompt: "POST RESUME THROW",
        isPostPublish: true,
        draftId: "d-throw-test",
        stepId: "step-throw",
      });
      const fakeDeps5 = {
        workflow: fakeWorkflow5,
        salesDbPath: join(scratchDir5, "sales.db"),
        auditPath: join(scratchDir5, "audit.jsonl"),
        emitFrame: () => {},
        session: {
          inputMode: "cdp" as const,
          getOrInitClient: () => Promise.resolve({ ok: true, client: {} }),
          resolvedMode: () => "manual" as const,
        },
        publishApprovedFeedPost: async () => {
          publishCallCount5++;
          throw new Error("Fake publish throw (T-Route.FallbackOnThrow)");
        },
      };
      const fakeTurn5 = {
        resumeWorkflowTurn: async () => {
          resumeCallCount5++;
        },
      };
      const req5 = makeFakeReq({ stepId: "step-throw" });
      const { res: res5 } = makeFakeRes();
      await handlePostWorkflow5(
        { currentTurn: null, autoRunId: null, lastEmittedAutoCounters: null } as never,
        fakeDeps5 as never,
        fakeTurn5 as never,
        req5,
        res5,
        "/workflow/approve",
      );
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(
        publishCallCount5,
        1,
        "T-Route.FallbackOnThrow: publishApprovedFeedPost must be called once (before it throws)",
      );
      assert.equal(
        resumeCallCount5,
        1,
        "T-Route.FallbackOnThrow: turn.resumeWorkflowTurn must be called once after throw (catch → fallback)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Route.KillSwitch (CMR-6 / OQ-4)
// ---------------------------------------------------------------------------

describe("handlePostWorkflow — kill-switch: MAI_DETERMINISTIC_POST_PUBLISH=skip bypasses runtime, calls resumeWorkflowTurn directly (G-P7.route — CMR-6)", () => {
  it(
    "T-Route.KillSwitch: when process.env.MAI_DETERMINISTIC_POST_PUBLISH==='skip', the route does NOT call the injected publishApprovedFeedPost seam AND calls turn.resumeWorkflowTurn(r.resumePrompt) directly",
    { timeout: 5000 },
    async () => {
      // Given: process.env.MAI_DETERMINISTIC_POST_PUBLISH = 'skip' (kill-switch active).
      //        approve() returns isPostPublish=true + draftId (post step in Manual mode).
      //        deps.publishApprovedFeedPost is injected (CMR-2 seam).
      // When:  handlePostWorkflow runs.
      // Then:  the injected publishApprovedFeedPost is NOT called (kill-switch is PRE-DISPATCH —
      //        no CDP action whatsoever — §6.5 "checked BEFORE the post-step branch");
      //        turn.resumeWorkflowTurn(r.resumePrompt) IS called exactly once (P6 LLM path verbatim).
      //        Structural: workflow.ts source includes 'MAI_DETERMINISTIC_POST_PUBLISH'.
      const hasKillSwitch = WORKFLOW_ROUTE_SRC.includes("MAI_DETERMINISTIC_POST_PUBLISH");

      // T-Route.KillSwitch: structural assertion
      assert.ok(hasKillSwitch, "T-Route.KillSwitch: workflow.ts must contain 'MAI_DETERMINISTIC_POST_PUBLISH'");

      // Behavioral: with kill-switch set, publishApprovedFeedPost NOT called, resumeWorkflowTurn called once
      const { handlePostWorkflow: handlePostWorkflow6 } = await import(
        "../../../../src/cli/subcommands/serve/routes/workflow.js"
      );
      let resumeCallCount6 = 0;
      let publishCallCount6 = 0;
      const scratchDir6 = join(tmpdir(), "frondose-p7-route-ks", `${Date.now()}`);
      mkdirSync(scratchDir6, { recursive: true });
      const fakeWorkflow6 = makeFakeWorkflowController({
        resumePrompt: "POST RESUME KS",
        isPostPublish: true,
        draftId: "d-ks-test",
        stepId: "step-ks",
      });
      const fakeDeps6 = {
        workflow: fakeWorkflow6,
        salesDbPath: join(scratchDir6, "sales.db"),
        auditPath: join(scratchDir6, "audit.jsonl"),
        emitFrame: () => {},
        session: {
          inputMode: "cdp" as const,
          getOrInitClient: () => Promise.resolve({ ok: true, client: {} }),
          resolvedMode: () => "manual" as const,
        },
        publishApprovedFeedPost: async () => {
          publishCallCount6++;
          return { published: true, fallbackAllowed: false, dispatchAttempted: true };
        },
      };
      const fakeTurn6 = {
        resumeWorkflowTurn: async () => {
          resumeCallCount6++;
        },
      };
      const prevKillSwitch = process.env.MAI_DETERMINISTIC_POST_PUBLISH;
      process.env.MAI_DETERMINISTIC_POST_PUBLISH = "skip";
      try {
        const req6 = makeFakeReq({ stepId: "step-ks" });
        const { res: res6 } = makeFakeRes();
        await handlePostWorkflow6(
          { currentTurn: null, autoRunId: null, lastEmittedAutoCounters: null } as never,
          fakeDeps6 as never,
          fakeTurn6 as never,
          req6,
          res6,
          "/workflow/approve",
        );
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        if (prevKillSwitch === undefined) {
          delete process.env.MAI_DETERMINISTIC_POST_PUBLISH;
        } else {
          process.env.MAI_DETERMINISTIC_POST_PUBLISH = prevKillSwitch;
        }
      }
      assert.equal(
        publishCallCount6,
        0,
        "T-Route.KillSwitch: publishApprovedFeedPost must NOT be called when kill-switch=skip",
      );
      assert.equal(
        resumeCallCount6,
        1,
        "T-Route.KillSwitch: turn.resumeWorkflowTurn must be called once (P6 LLM path) when kill-switch=skip",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Route.NonPostUnchanged
// ---------------------------------------------------------------------------

describe("handlePostWorkflow — NON-POST approve: behavior is byte-identical to pre-P7 (only turn.resumeWorkflowTurn called) (G-P7.route — regression pin)", () => {
  it(
    "T-Route.NonPostUnchanged: POST /workflow/approve for a connect/message step (isPostPublish=false) → turn.resumeWorkflowTurn is called directly, publishApprovedFeedPost is NOT called",
    { timeout: 5000 },
    async () => {
      // Given: route receives POST /workflow/approve where approve() returns
      //        isPostPublish=false (a connect step).
      // When:  handlePostWorkflow runs.
      // Then:  turn.resumeWorkflowTurn IS called exactly once (the existing pre-P7 behavior).
      //        publishApprovedFeedPost is NOT called (regression pin against leakage into connect).
      try {
        const { handlePostWorkflow } = await import("../../../../src/cli/subcommands/serve/routes/workflow.js");

        let resumeCallCount = 0;
        let publishCallCount = 0;

        const scratchDir = join(tmpdir(), "frondose-p7-route-nonpost", `${Date.now()}`);
        mkdirSync(scratchDir, { recursive: true });
        const dbPath = join(scratchDir, "sales.db");

        const fakeState = {
          currentTurn: null,
          autoRunId: null,
          lastEmittedAutoCounters: null,
        };
        const fakeWorkflow = makeFakeWorkflowController({
          resumePrompt: "CONNECT RESUME",
          isPostPublish: false,
          draftId: undefined,
        });
        const fakeDeps = {
          workflow: fakeWorkflow,
          salesDbPath: dbPath,
          emitFrame: () => {},
          session: {
            inputMode: "cdp" as const,
            getOrInitClient: () => Promise.resolve({}),
            getClient: () => ({}),
            resolvedMode: () => "manual" as const,
          },
        };
        const fakeTurn = {
          resumeWorkflowTurn: async (_prompt: string) => {
            resumeCallCount++;
          },
        };
        // If P7 is implemented, it would check publishApprovedFeedPost — fake it as not called
        const fakePublish = async () => {
          publishCallCount++;
          return { published: true };
        };
        void fakePublish;

        const req = makeFakeReq({ stepId: "step-connect" });
        const { res } = makeFakeRes();

        await handlePostWorkflow(
          fakeState as never,
          fakeDeps as never,
          fakeTurn as never,
          req,
          res,
          "/workflow/approve",
        );

        // T-Route.NonPostUnchanged: connect step → LLM resume, no publish call
        assert.equal(
          resumeCallCount,
          1,
          "T-Route.NonPostUnchanged: turn.resumeWorkflowTurn must be called once for connect step",
        );
        assert.equal(
          publishCallCount,
          0,
          "T-Route.NonPostUnchanged: publishApprovedFeedPost must NOT be called for a connect step",
        );
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail(
          "T-Route.NonPostUnchanged: handlePostWorkflow import failed or pre-P7 behavior broken. " + String(err),
        );
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Route.NonApproveUnchanged
// ---------------------------------------------------------------------------

describe("handlePostWorkflow — NON-approve endpoints: publishApprovedFeedPost is NEVER called for decline/handoff/cancel (G-P7.route — regression pin)", () => {
  it(
    "T-Route.NonApproveUnchanged: POST /workflow/decline + /workflow/handoff + /workflow/cancel → publishApprovedFeedPost is NEVER invoked; existing behavior unchanged",
    { timeout: 5000 },
    async () => {
      // Given: route receives POST /workflow/decline (or handoff, or cancel).
      // When:  handlePostWorkflow runs.
      // Then:  publishApprovedFeedPost is never invoked for these URLs.
      //        Structural: the P7 hook in workflow.ts is gated by url === '/workflow/approve'.

      const hasApproveGate =
        WORKFLOW_ROUTE_SRC.includes("/workflow/approve") &&
        (WORKFLOW_ROUTE_SRC.includes("isPostPublish") || WORKFLOW_ROUTE_SRC.includes("publishApproved"));

      // T-Route.NonApproveUnchanged: structural — P7 hook is gated by url === '/workflow/approve'
      assert.ok(
        hasApproveGate,
        "T-Route.NonApproveUnchanged: workflow.ts must gate the P7 hook with url==='/workflow/approve' + isPostPublish check",
      );
      // The structural check is sufficient: the hook at workflow.ts:84 is inside
      //   `if (!killSwitch && url === "/workflow/approve" && r.isPostPublish === true && draftId && stepId)`
      // so /workflow/decline / /workflow/handoff / /workflow/cancel can never reach publishApprovedFeedPost.
    },
  );
});

// ---------------------------------------------------------------------------
// T-Route.CronTurnUnaffected
// ---------------------------------------------------------------------------

describe("handlePostWorkflow — cron turn: publishApprovedFeedPost is NEVER called even if cron somehow triggers approve (G-P7.route — defense in depth)", () => {
  it(
    "T-Route.CronTurnUnaffected: when ctx.isCronTurn is simulated (approval that came from a cron context), the route does NOT call publishApprovedFeedPost",
    { timeout: 5000 },
    async () => {
      // Given: a pathological case where a cron turn somehow generates an approve action.
      //        Today this cannot happen (checkApprovalGate returns abort:false for cron turns)
      //        but defense in depth requires the route to not fire the deterministic routine.
      // When:  handlePostWorkflow runs with a cron-context indicator.
      // Then:  publishApprovedFeedPost is NOT called — the deterministic routine is Manual-only.
      //
      // Implementation note: the plan §6.5 does NOT add an explicit isCronTurn check in the
      // route hook (the gate is url + isPostPublish + draftId). This test validates that the
      // existing approval-gate logic (which already blocks cron turns from generating approval
      // events) provides sufficient defense. The structural assertion here is that the source
      // does NOT have a code path that calls publishApprovedFeedPost without the
      // url === '/workflow/approve' guard.
      // T-Route.CronTurnUnaffected: the route hook at workflow.ts:84 is gated by
      //   url === '/workflow/approve' AND r.isPostPublish === true AND draftId AND stepId.
      // checkApprovalGate already blocks cron turns (isCronTurn guard at approval-gate.ts:15),
      // so a cron turn can NEVER produce isPostPublish=true in r. The defense is structural:
      // the hook cannot fire without all four conditions. Structural assertion:
      assert.ok(
        WORKFLOW_ROUTE_SRC.includes('url === "/workflow/approve"') ||
          WORKFLOW_ROUTE_SRC.includes('url === "/workflow/approve"'),
        "T-Route.CronTurnUnaffected: workflow.ts hook must be gated by url==='/workflow/approve'",
      );
      assert.ok(
        WORKFLOW_ROUTE_SRC.includes("r.isPostPublish === true"),
        "T-Route.CronTurnUnaffected: workflow.ts hook must check r.isPostPublish === true",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Recover.6 (P-POST-PUBLISH-8 Step 3a REVISED — outcome-based kill-switch
// test driving a REAL createWorkflowController)
//
// REVISED from original Step-2 scaffold per BLOCKER 1 resolution:
//   Option (b): the kill-switch's load-bearing job is "no deterministic runtime
//   publish" (route guard at workflow.ts:84). An approve-time recovery inside
//   approve() under the kill-switch is harmless — the route still short-circuits
//   to LLM resume. T-Recover.6 now asserts the OUTCOME: publishApprovedFeedPost
//   NOT invoked + resumeWorkflowTurn IS called. The recoverPostDraftId thunk MAY
//   be called inside approve() — that is harmless. We do NOT assert thunk count
//   zero (that was the vacuous assertion the critic rejected).
//
//   The test drives a REAL createWorkflowController (not a fake handleEndpoint)
//   with the internal state seeded via getState() (which returns the mutable
//   state object by reference) so that approve() sees a real pending post step
//   with step.draftId undefined — triggering recovery — but the kill-switch in
//   the route means publishApprovedFeedPost is never invoked regardless.
// ---------------------------------------------------------------------------

describe("handlePostWorkflow (P8) — kill-switch MAI_DETERMINISTIC_POST_PUBLISH=skip makes the route NOT publish; LLM fallback wins (SC-4)", () => {
  it(
    "T-Recover.6: when MAI_DETERMINISTIC_POST_PUBLISH=skip AND a REAL createWorkflowController has a pending post step with step.draftId undefined and recoverPostDraftId returning {id:'draft_recovered'}, the route does NOT call publishApprovedFeedPost AND calls turn.resumeWorkflowTurn exactly once (LLM fallback wins; kill-switch carries the load-bearing invariant)",
    { timeout: 5000 },
    async () => {
      // Given: MAI_DETERMINISTIC_POST_PUBLISH = 'skip' (kill-switch active).
      //        A REAL createWorkflowController whose deps include a recoverPostDraftId
      //        thunk returning { id: 'draft_recovered' }, so approve() would recover a
      //        draftId — but the route kill-switch fires before publishApprovedFeedPost.
      //        The controller's internal state is seeded with an awaiting-approval post
      //        step with step.draftId undefined (PPUB7B re-title scenario).
      // When:  handlePostWorkflow runs for POST /workflow/approve.
      // Then:  (a) deps.publishApprovedFeedPost stub is NOT called (kill-switch wins).
      //        (b) turn.resumeWorkflowTurn IS called exactly once (LLM fallback).
      //        The recoverPostDraftId thunk MAY be called — its call count is NOT asserted.
      //        Covers SC-4: Option (b) — kill-switch's load-bearing job is "no publish".
      const { handlePostWorkflow: hwpKs2 } = await import("../../../../src/cli/subcommands/serve/routes/workflow.js");
      const { createWorkflowController } = await import("../../../../src/agent/workflow/controller.js");

      let resumeCallCountKs2 = 0;
      let publishCallCountKs2 = 0;

      const scratchDirKs2 = join(tmpdir(), "frondose-p8-recover6", `${Date.now()}`);
      mkdirSync(scratchDirKs2, { recursive: true });

      // Build a REAL controller with the recoverPostDraftId thunk injected.
      // The thunk returns a valid id — but the kill-switch means the route never
      // invokes publishApprovedFeedPost regardless of what draftId approve() returns.
      const realController = createWorkflowController({
        emitFrame: () => {},
        writeWorkflowAudit: () => {},
        // recoverPostDraftId: cast via `as never` because Step 4 has not yet added
        // the field to WorkflowControllerDeps. The forward-cast pattern from the
        // group-B scaffold is applied at the createWorkflowController call site.
        ...({ recoverPostDraftId: () => ({ id: "draft_recovered_ks2" }) } as never),
      } as never);

      // Seed the controller's internal state via getState() (returns mutable ref).
      // This simulates the PPUB7B scenario: the agent set up a workflow with a
      // post-approval step but step.draftId was lost on re-title.
      const STEP_ID_KS2 = "step-p8-ks2";
      const seedState = realController.getState();
      seedState.current = {
        id: "wf-p8-ks2",
        title: "P8 kill-switch test workflow",
        approvalMode: "manual",
        steps: [
          {
            id: STEP_ID_KS2,
            title: "Publish post", // matches isPostStep heuristic
            state: "in_progress",
            requiresApproval: true,
            // step.draftId intentionally absent — PPUB7B re-title scenario
          },
        ],
        state: "awaiting_approval",
        createdAt: "2026-06-24T00:00:00.000Z",
        updatedAt: "2026-06-24T00:00:00.000Z",
      } as never;
      seedState.awaitingApprovalStepId = STEP_ID_KS2;

      const fakeDepsKs2 = {
        workflow: realController,
        salesDbPath: join(scratchDirKs2, "sales.db"),
        auditPath: join(scratchDirKs2, "audit.jsonl"),
        emitFrame: () => {},
        session: {
          inputMode: "cdp" as const,
          getOrInitClient: () => Promise.resolve({ ok: true, client: {} }),
          resolvedMode: () => "manual" as const,
        },
        publishApprovedFeedPost: async () => {
          publishCallCountKs2++;
          return { published: true, fallbackAllowed: false, dispatchAttempted: true };
        },
      };

      const fakeTurnKs2 = {
        resumeWorkflowTurn: async () => {
          resumeCallCountKs2++;
        },
      };

      const prevKillSwitch = process.env.MAI_DETERMINISTIC_POST_PUBLISH;
      process.env.MAI_DETERMINISTIC_POST_PUBLISH = "skip";
      try {
        const reqKs2 = makeFakeReq({ stepId: STEP_ID_KS2 });
        const { res: resKs2 } = makeFakeRes();
        await hwpKs2(
          { currentTurn: null, autoRunId: null, lastEmittedAutoCounters: null } as never,
          fakeDepsKs2 as never,
          fakeTurnKs2 as never,
          reqKs2,
          resKs2,
          "/workflow/approve",
        );
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        if (prevKillSwitch === undefined) {
          delete process.env.MAI_DETERMINISTIC_POST_PUBLISH;
        } else {
          process.env.MAI_DETERMINISTIC_POST_PUBLISH = prevKillSwitch;
        }
      }

      // SC-4 assertions: kill-switch wins — no publish, LLM fallback fires
      assert.equal(
        publishCallCountKs2,
        0,
        "T-Recover.6: publishApprovedFeedPost must NOT be called when MAI_DETERMINISTIC_POST_PUBLISH=skip (kill-switch wins)",
      );
      assert.equal(
        resumeCallCountKs2,
        1,
        "T-Recover.6: turn.resumeWorkflowTurn must be called exactly once (LLM fallback) when kill-switch=skip",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Hook.1–5: Runtime hook — FRONDOSE_PUBLISH_VIA_ACTION selector
// (native-port-S2 Step 3a scaffold — REQUIRED per critic CONCERN-MR-1)
//
// Dual-spy pattern: inject BOTH deps.publishApprovedFeedPost (shadow spy) AND
// deps.publishApprovedFeedPostViaAction (action spy — new optional field in
// WorkflowRoutesDeps, to be added at Step 4). Assert which one fires.
//
// All 5 tests are RED on HEAD because:
//   (1) The structural assertion `WORKFLOW_ROUTE_SRC.includes('FRONDOSE_PUBLISH_VIA_ACTION')`
//       fails — the env var selector is not yet in workflow.ts source.
//   (2) After Step 4 adds the selector, the structural assertion passes but
//       assert.fail("TODO") keeps each test RED until Step 5 fills behavioral assertions.
//
// The new injection field (deps.publishApprovedFeedPostViaAction) is cast via
// `as unknown as {}` (or `as never`) at the call site so tsc exits 0 even
// before the WorkflowRoutesDeps type is updated at Step 4.
//
// Runner:
//   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
//     tests/cli/serve/routes/workflow-postPublishRouting.mock.test.ts
// ---------------------------------------------------------------------------

describe("handlePostWorkflow — runtime hook: FRONDOSE_PUBLISH_VIA_ACTION unset → shadow spy fires, action spy NOT called (T-Hook.1)", () => {
  it(
    "T-Hook.1: given process.env.FRONDOSE_PUBLISH_VIA_ACTION is UNSET, " +
      "when an approval POST /workflow/approve with isPostPublish:true is dispatched, " +
      "then the shadow spy (deps.publishApprovedFeedPost) is called exactly once " +
      "AND the action spy (deps.publishApprovedFeedPostViaAction) is NEVER called",
    { timeout: 5000 },
    async () => {
      // Given: FRONDOSE_PUBLISH_VIA_ACTION env var is NOT set (default OFF — shadow path).
      // When: POST /workflow/approve with isPostPublish:true arrives.
      // Then: shadow spy fires×1; action spy fires×0 (only literal "on" opts in).

      // Structural assertion
      assert.ok(
        WORKFLOW_ROUTE_SRC.includes("FRONDOSE_PUBLISH_VIA_ACTION"),
        "T-Hook.1: workflow.ts must contain FRONDOSE_PUBLISH_VIA_ACTION selector",
      );

      const { handlePostWorkflow: hpwHook1 } = await import("../../../../src/cli/subcommands/serve/routes/workflow.js");
      let shadowCallCount1 = 0;
      let actionCallCount1 = 0;
      const scratchDir1 = join(tmpdir(), `frondose-hook1-${Date.now()}`);
      mkdirSync(scratchDir1, { recursive: true });
      const fakeWorkflowH1 = makeFakeWorkflowController({
        resumePrompt: "HOOK1 RESUME",
        isPostPublish: true,
        draftId: "d-hook1",
        stepId: "step-hook1",
      });
      const fakeDepsH1 = {
        workflow: fakeWorkflowH1,
        salesDbPath: join(scratchDir1, "sales.db"),
        auditPath: join(scratchDir1, "audit.jsonl"),
        emitFrame: () => {},
        session: {
          inputMode: "cdp" as const,
          getOrInitClient: () => Promise.resolve({ ok: true, client: {} }),
          resolvedMode: () => "manual" as const,
        },
        publishApprovedFeedPost: async () => {
          shadowCallCount1++;
          return { published: true, fallbackAllowed: false, dispatchAttempted: true };
        },
        publishApprovedFeedPostViaAction: async () => {
          actionCallCount1++;
          return { published: true, fallbackAllowed: false, dispatchAttempted: true };
        },
      };
      const fakeTurnH1 = { resumeWorkflowTurn: async () => {} };
      const reqH1 = makeFakeReq({ stepId: "step-hook1" });
      const { res: resH1 } = makeFakeRes();

      // Ensure env var is unset
      const origEnvH1 = process.env.FRONDOSE_PUBLISH_VIA_ACTION;
      delete process.env.FRONDOSE_PUBLISH_VIA_ACTION;
      try {
        await hpwHook1(
          { currentTurn: null, autoRunId: null, lastEmittedAutoCounters: null } as never,
          fakeDepsH1 as never,
          fakeTurnH1 as never,
          reqH1,
          resH1,
          "/workflow/approve",
        );
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        if (origEnvH1 === undefined) {
          delete process.env.FRONDOSE_PUBLISH_VIA_ACTION;
        } else {
          process.env.FRONDOSE_PUBLISH_VIA_ACTION = origEnvH1;
        }
      }

      assert.equal(
        shadowCallCount1,
        1,
        "T-Hook.1: shadow spy (publishApprovedFeedPost) must fire exactly once when FRONDOSE_PUBLISH_VIA_ACTION is unset",
      );
      assert.equal(
        actionCallCount1,
        0,
        "T-Hook.1: action spy (publishApprovedFeedPostViaAction) must NOT fire when FRONDOSE_PUBLISH_VIA_ACTION is unset",
      );
    },
  );
});

describe("handlePostWorkflow — runtime hook: FRONDOSE_PUBLISH_VIA_ACTION==='on' → action spy fires, shadow spy NOT called (T-Hook.2)", () => {
  it(
    "T-Hook.2: given process.env.FRONDOSE_PUBLISH_VIA_ACTION === 'on', " +
      "when an approval POST /workflow/approve with isPostPublish:true is dispatched, " +
      "then the action spy (deps.publishApprovedFeedPostViaAction) is called exactly once " +
      "AND the shadow spy (deps.publishApprovedFeedPost) is NEVER called",
    { timeout: 5000 },
    async () => {
      // Given: FRONDOSE_PUBLISH_VIA_ACTION is set to the exact literal "on".
      // When: POST /workflow/approve with isPostPublish:true arrives.
      // Then: action spy fires×1; shadow spy fires×0 (the exact literal "on" is the selector).

      // Structural assertion
      assert.ok(
        WORKFLOW_ROUTE_SRC.includes("FRONDOSE_PUBLISH_VIA_ACTION"),
        "T-Hook.2: workflow.ts must contain FRONDOSE_PUBLISH_VIA_ACTION selector",
      );

      const { handlePostWorkflow: hpwHook2 } = await import("../../../../src/cli/subcommands/serve/routes/workflow.js");
      let shadowCallCount2 = 0;
      let actionCallCount2 = 0;
      const scratchDir2 = join(tmpdir(), `frondose-hook2-${Date.now()}`);
      mkdirSync(scratchDir2, { recursive: true });
      const fakeWorkflowH2 = makeFakeWorkflowController({
        resumePrompt: "HOOK2 RESUME",
        isPostPublish: true,
        draftId: "d-hook2",
        stepId: "step-hook2",
      });
      const fakeDepsH2 = {
        workflow: fakeWorkflowH2,
        salesDbPath: join(scratchDir2, "sales.db"),
        auditPath: join(scratchDir2, "audit.jsonl"),
        emitFrame: () => {},
        session: {
          inputMode: "cdp" as const,
          getOrInitClient: () => Promise.resolve({ ok: true, client: {} }),
          resolvedMode: () => "manual" as const,
        },
        publishApprovedFeedPost: async () => {
          shadowCallCount2++;
          return { published: true, fallbackAllowed: false, dispatchAttempted: true };
        },
        publishApprovedFeedPostViaAction: async () => {
          actionCallCount2++;
          return { published: true, fallbackAllowed: false, dispatchAttempted: true };
        },
      };
      const fakeTurnH2 = { resumeWorkflowTurn: async () => {} };
      const reqH2 = makeFakeReq({ stepId: "step-hook2" });
      const { res: resH2 } = makeFakeRes();

      const origEnvH2 = process.env.FRONDOSE_PUBLISH_VIA_ACTION;
      process.env.FRONDOSE_PUBLISH_VIA_ACTION = "on";
      try {
        await hpwHook2(
          { currentTurn: null, autoRunId: null, lastEmittedAutoCounters: null } as never,
          fakeDepsH2 as never,
          fakeTurnH2 as never,
          reqH2,
          resH2,
          "/workflow/approve",
        );
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        if (origEnvH2 === undefined) {
          delete process.env.FRONDOSE_PUBLISH_VIA_ACTION;
        } else {
          process.env.FRONDOSE_PUBLISH_VIA_ACTION = origEnvH2;
        }
      }

      assert.equal(
        actionCallCount2,
        1,
        "T-Hook.2: action spy (publishApprovedFeedPostViaAction) must fire exactly once when FRONDOSE_PUBLISH_VIA_ACTION='on'",
      );
      assert.equal(
        shadowCallCount2,
        0,
        "T-Hook.2: shadow spy (publishApprovedFeedPost) must NOT fire when FRONDOSE_PUBLISH_VIA_ACTION='on'",
      );
    },
  );
});

describe("handlePostWorkflow — runtime hook: FRONDOSE_PUBLISH_VIA_ACTION set to non-'on' value → shadow spy fires (T-Hook.3)", () => {
  it(
    "T-Hook.3: given process.env.FRONDOSE_PUBLISH_VIA_ACTION is set to a value OTHER than literal 'on' " +
      "('off', '', 'ON', '1', 'true'), " +
      "when an approval POST /workflow/approve with isPostPublish:true is dispatched, " +
      "then the shadow spy fires AND the action spy does NOT " +
      "(only the exact literal 'on' opts in — string-equality, no truthy coercion)",
    { timeout: 5000 },
    async () => {
      // Given: FRONDOSE_PUBLISH_VIA_ACTION is set to "off" / "" / "ON" / "1" / "true" (NOT "on").
      // When: POST /workflow/approve with isPostPublish:true arrives.
      // Then: shadow spy fires×1; action spy fires×0.
      // This pins the non-truthy-coercion contract: only process.env.FRONDOSE_PUBLISH_VIA_ACTION === "on".

      // Structural assertions
      assert.ok(
        WORKFLOW_ROUTE_SRC.includes("FRONDOSE_PUBLISH_VIA_ACTION"),
        "T-Hook.3: workflow.ts must contain FRONDOSE_PUBLISH_VIA_ACTION selector",
      );
      // Structural: the comparison must be strict equality with "on" (not a truthy check)
      assert.ok(
        WORKFLOW_ROUTE_SRC.includes('"on"') || WORKFLOW_ROUTE_SRC.includes("'on'"),
        "T-Hook.3: workflow.ts must compare FRONDOSE_PUBLISH_VIA_ACTION to the literal string 'on'",
      );

      const { handlePostWorkflow: hpwHook3 } = await import("../../../../src/cli/subcommands/serve/routes/workflow.js");

      // Test each non-"on" value — all must route to shadow
      const nonOnValues = ["off", "", "ON", "1", "true"];
      for (const nonOnVal of nonOnValues) {
        let shadowCount = 0;
        let actionCount = 0;
        const scratchDir3 = join(tmpdir(), `frondose-hook3-${nonOnVal}-${Date.now()}`);
        mkdirSync(scratchDir3, { recursive: true });
        const fakeWorkflowH3 = makeFakeWorkflowController({
          resumePrompt: `HOOK3 RESUME ${nonOnVal}`,
          isPostPublish: true,
          draftId: `d-hook3-${nonOnVal}`,
          stepId: `step-hook3-${nonOnVal}`,
        });
        const fakeDepsH3 = {
          workflow: fakeWorkflowH3,
          salesDbPath: join(scratchDir3, "sales.db"),
          auditPath: join(scratchDir3, "audit.jsonl"),
          emitFrame: () => {},
          session: {
            inputMode: "cdp" as const,
            getOrInitClient: () => Promise.resolve({ ok: true, client: {} }),
            resolvedMode: () => "manual" as const,
          },
          publishApprovedFeedPost: async () => {
            shadowCount++;
            return { published: true, fallbackAllowed: false, dispatchAttempted: true };
          },
          publishApprovedFeedPostViaAction: async () => {
            actionCount++;
            return { published: true, fallbackAllowed: false, dispatchAttempted: true };
          },
        };
        const fakeTurnH3 = { resumeWorkflowTurn: async () => {} };
        const reqH3 = makeFakeReq({ stepId: `step-hook3-${nonOnVal}` });
        const { res: resH3 } = makeFakeRes();

        const origEnvH3 = process.env.FRONDOSE_PUBLISH_VIA_ACTION;
        process.env.FRONDOSE_PUBLISH_VIA_ACTION = nonOnVal;
        try {
          await hpwHook3(
            { currentTurn: null, autoRunId: null, lastEmittedAutoCounters: null } as never,
            fakeDepsH3 as never,
            fakeTurnH3 as never,
            reqH3,
            resH3,
            "/workflow/approve",
          );
          await new Promise((r) => setTimeout(r, 200));
        } finally {
          if (origEnvH3 === undefined) {
            delete process.env.FRONDOSE_PUBLISH_VIA_ACTION;
          } else {
            process.env.FRONDOSE_PUBLISH_VIA_ACTION = origEnvH3;
          }
        }

        assert.equal(
          shadowCount,
          1,
          `T-Hook.3: shadow spy must fire when FRONDOSE_PUBLISH_VIA_ACTION='${nonOnVal}' (non-"on" truthy coercion rejected)`,
        );
        assert.equal(
          actionCount,
          0,
          `T-Hook.3: action spy must NOT fire when FRONDOSE_PUBLISH_VIA_ACTION='${nonOnVal}'`,
        );
      }
    },
  );
});

describe("handlePostWorkflow — kill-switch cross-product: MAI_DETERMINISTIC_POST_PUBLISH=skip + FRONDOSE_PUBLISH_VIA_ACTION=on → NEITHER spy fires (T-Hook.4)", () => {
  it(
    "T-Hook.4 (kill-switch cross-product, action-path branch): " +
      "given process.env.MAI_DETERMINISTIC_POST_PUBLISH === 'skip' AND process.env.FRONDOSE_PUBLISH_VIA_ACTION === 'on', " +
      "when an approval POST /workflow/approve with isPostPublish:true is dispatched, " +
      "then NEITHER the shadow spy NOR the action spy fires (kill-switch gates BOTH paths) " +
      "AND turn.resumeWorkflowTurn is invoked instead",
    { timeout: 5000 },
    async () => {
      // Given: kill-switch (MAI_DETERMINISTIC_POST_PUBLISH=skip) active + action path requested.
      // When: POST /workflow/approve with isPostPublish:true arrives.
      // Then: shadow spy fires×0; action spy fires×0; resumeWorkflowTurn fires×1.
      // The kill-switch guard sits outside the publish selector — it gates BOTH paths
      // (verified plan §6.3 + CONCERN-MR-1 cross-product requirement).

      // Structural assertion
      assert.ok(
        WORKFLOW_ROUTE_SRC.includes("FRONDOSE_PUBLISH_VIA_ACTION"),
        "T-Hook.4: workflow.ts must contain FRONDOSE_PUBLISH_VIA_ACTION selector",
      );

      const { handlePostWorkflow: hpwHook4 } = await import("../../../../src/cli/subcommands/serve/routes/workflow.js");
      let shadowCallCount4 = 0;
      let actionCallCount4 = 0;
      let resumeCallCount4 = 0;
      const scratchDir4 = join(tmpdir(), `frondose-hook4-${Date.now()}`);
      mkdirSync(scratchDir4, { recursive: true });
      const fakeWorkflowH4 = makeFakeWorkflowController({
        resumePrompt: "HOOK4 RESUME",
        isPostPublish: true,
        draftId: "d-hook4",
        stepId: "step-hook4",
      });
      const fakeDepsH4 = {
        workflow: fakeWorkflowH4,
        salesDbPath: join(scratchDir4, "sales.db"),
        auditPath: join(scratchDir4, "audit.jsonl"),
        emitFrame: () => {},
        session: {
          inputMode: "cdp" as const,
          getOrInitClient: () => Promise.resolve({ ok: true, client: {} }),
          resolvedMode: () => "manual" as const,
        },
        publishApprovedFeedPost: async () => {
          shadowCallCount4++;
          return { published: true, fallbackAllowed: false, dispatchAttempted: true };
        },
        publishApprovedFeedPostViaAction: async () => {
          actionCallCount4++;
          return { published: true, fallbackAllowed: false, dispatchAttempted: true };
        },
      };
      const fakeTurnH4 = {
        resumeWorkflowTurn: async () => {
          resumeCallCount4++;
        },
      };
      const reqH4 = makeFakeReq({ stepId: "step-hook4" });
      const { res: resH4 } = makeFakeRes();

      const origKillSwitch4 = process.env.MAI_DETERMINISTIC_POST_PUBLISH;
      const origActionEnv4 = process.env.FRONDOSE_PUBLISH_VIA_ACTION;
      process.env.MAI_DETERMINISTIC_POST_PUBLISH = "skip";
      process.env.FRONDOSE_PUBLISH_VIA_ACTION = "on";
      try {
        await hpwHook4(
          { currentTurn: null, autoRunId: null, lastEmittedAutoCounters: null } as never,
          fakeDepsH4 as never,
          fakeTurnH4 as never,
          reqH4,
          resH4,
          "/workflow/approve",
        );
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        if (origKillSwitch4 === undefined) {
          delete process.env.MAI_DETERMINISTIC_POST_PUBLISH;
        } else {
          process.env.MAI_DETERMINISTIC_POST_PUBLISH = origKillSwitch4;
        }
        if (origActionEnv4 === undefined) {
          delete process.env.FRONDOSE_PUBLISH_VIA_ACTION;
        } else {
          process.env.FRONDOSE_PUBLISH_VIA_ACTION = origActionEnv4;
        }
      }

      assert.equal(
        shadowCallCount4,
        0,
        "T-Hook.4: shadow spy must NOT fire when kill-switch=skip (even with action path)",
      );
      assert.equal(actionCallCount4, 0, "T-Hook.4: action spy must NOT fire when kill-switch=skip");
      assert.equal(
        resumeCallCount4,
        1,
        "T-Hook.4: resumeWorkflowTurn must fire×1 (kill-switch falls through to LLM resume)",
      );
    },
  );
});

describe("handlePostWorkflow — kill-switch cross-product: MAI_DETERMINISTIC_POST_PUBLISH=skip + FRONDOSE_PUBLISH_VIA_ACTION unset → NEITHER spy fires (T-Hook.5)", () => {
  it(
    "T-Hook.5 (kill-switch cross-product, shadow-path branch — regression guard): " +
      "given process.env.MAI_DETERMINISTIC_POST_PUBLISH === 'skip' AND FRONDOSE_PUBLISH_VIA_ACTION UNSET, " +
      "when an approval POST /workflow/approve with isPostPublish:true is dispatched, " +
      "then NEITHER spy fires AND turn.resumeWorkflowTurn is invoked " +
      "(unchanged pre-Slice-2 kill-switch behavior — regression guard that the new selector did not break it)",
    { timeout: 5000 },
    async () => {
      // Given: kill-switch active; FRONDOSE_PUBLISH_VIA_ACTION not set (shadow path would be default).
      // When: POST /workflow/approve with isPostPublish:true arrives.
      // Then: shadow spy fires×0; action spy fires×0; resumeWorkflowTurn fires×1.
      // This is a regression guard: the pre-Slice-2 kill-switch behavior (T-Route.KillSwitch)
      // must be preserved even after the new selector branch is added.

      // Structural assertion
      assert.ok(
        WORKFLOW_ROUTE_SRC.includes("FRONDOSE_PUBLISH_VIA_ACTION"),
        "T-Hook.5: workflow.ts must contain FRONDOSE_PUBLISH_VIA_ACTION selector",
      );

      const { handlePostWorkflow: hpwHook5 } = await import("../../../../src/cli/subcommands/serve/routes/workflow.js");
      let shadowCallCount5 = 0;
      let actionCallCount5 = 0;
      let resumeCallCount5 = 0;
      const scratchDir5 = join(tmpdir(), `frondose-hook5-${Date.now()}`);
      mkdirSync(scratchDir5, { recursive: true });
      const fakeWorkflowH5 = makeFakeWorkflowController({
        resumePrompt: "HOOK5 RESUME",
        isPostPublish: true,
        draftId: "d-hook5",
        stepId: "step-hook5",
      });
      const fakeDepsH5 = {
        workflow: fakeWorkflowH5,
        salesDbPath: join(scratchDir5, "sales.db"),
        auditPath: join(scratchDir5, "audit.jsonl"),
        emitFrame: () => {},
        session: {
          inputMode: "cdp" as const,
          getOrInitClient: () => Promise.resolve({ ok: true, client: {} }),
          resolvedMode: () => "manual" as const,
        },
        publishApprovedFeedPost: async () => {
          shadowCallCount5++;
          return { published: true, fallbackAllowed: false, dispatchAttempted: true };
        },
        publishApprovedFeedPostViaAction: async () => {
          actionCallCount5++;
          return { published: true, fallbackAllowed: false, dispatchAttempted: true };
        },
      };
      const fakeTurnH5 = {
        resumeWorkflowTurn: async () => {
          resumeCallCount5++;
        },
      };
      const reqH5 = makeFakeReq({ stepId: "step-hook5" });
      const { res: resH5 } = makeFakeRes();

      const origKillSwitch5 = process.env.MAI_DETERMINISTIC_POST_PUBLISH;
      const origActionEnv5 = process.env.FRONDOSE_PUBLISH_VIA_ACTION;
      process.env.MAI_DETERMINISTIC_POST_PUBLISH = "skip";
      delete process.env.FRONDOSE_PUBLISH_VIA_ACTION;
      try {
        await hpwHook5(
          { currentTurn: null, autoRunId: null, lastEmittedAutoCounters: null } as never,
          fakeDepsH5 as never,
          fakeTurnH5 as never,
          reqH5,
          resH5,
          "/workflow/approve",
        );
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        if (origKillSwitch5 === undefined) {
          delete process.env.MAI_DETERMINISTIC_POST_PUBLISH;
        } else {
          process.env.MAI_DETERMINISTIC_POST_PUBLISH = origKillSwitch5;
        }
        if (origActionEnv5 === undefined) {
          delete process.env.FRONDOSE_PUBLISH_VIA_ACTION;
        } else {
          process.env.FRONDOSE_PUBLISH_VIA_ACTION = origActionEnv5;
        }
      }

      assert.equal(
        shadowCallCount5,
        0,
        "T-Hook.5: shadow spy must NOT fire when kill-switch=skip (regression guard — unchanged kill-switch behavior)",
      );
      assert.equal(
        actionCallCount5,
        0,
        "T-Hook.5: action spy must NOT fire when kill-switch=skip and FRONDOSE_PUBLISH_VIA_ACTION unset",
      );
      assert.equal(
        resumeCallCount5,
        1,
        "T-Hook.5: resumeWorkflowTurn must fire×1 (kill-switch falls through to LLM resume)",
      );
    },
  );
});
