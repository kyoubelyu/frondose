/**
 * Phase native-port-S2-HARDEN — Step 5 (validator, Sonnet) — filled assertions
 *
 * Covers §5 harden-specific families:
 *   T-OpenRetry.1–5, T-ScopeBudget.1–4
 *
 * Runner:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/linkedin/action/publishPost-harden-open.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { SCOPE_READY_ATTEMPTS } from "../../../src/linkedin/logic/scopeResolver/shared.js";
import { resolveScopedTarget } from "../../../src/linkedin/logic/scopeResolver/targetResolution.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/logic/surface/currentSurfaceTypes.js";
import type { AuditRow } from "./publishPost-harden.helpers.js";
import {
  installSleepSpy,
  loadPublish,
  loadReadiness,
  makeEmptyPageContext,
  makeFakeHardenedClient,
  makeHappyHardenedEvalQueues,
  makeHardenedPublishDeps,
  makeModalContext,
  makeModalContextNoComposerModal,
  makePageContext,
  seedDraft,
} from "./publishPost-harden.helpers.js";

// ===========================================================================
// T-OpenRetry — hardened multi-round "Start a post" open
// ===========================================================================

describe("openComposerHardened — hardened multi-round open (T-OpenRetry)", () => {
  it(
    "T-OpenRetry.1: given round-1 click lands but all 3 in-round probes see activeLayer!==modal, " +
      "when openComposerHardened runs, " +
      "then it sleeps OPEN_PROBE_BASE_MS (120ms) between rounds before attempting round 2",
    async () => {
      // Given: captureQueue returns page contexts for round-1 probes then modal on round-2.
      // When: openComposerHardened drives the 4-round × 3-probe retry loop.
      // Then: sleepLog contains a 120ms between-round sleep after round-1 fails all probes.
      const { openComposerHardened } = await loadReadiness();
      const pageCtx = makePageContext();
      const modalCtx = makeModalContext();
      // [0]=initial, [1]=r0-resolve, [2-4]=r0-probes, [5]=r1-resolve, [6]=r1-probe-0 (modal)
      const captureQueue = [pageCtx, pageCtx, pageCtx, pageCtx, pageCtx, pageCtx, modalCtx];
      let captureIdx = 0;
      const capture = async (): Promise<CurrentSurfaceContext> => {
        const ctx = captureQueue[captureIdx];
        if (captureIdx < captureQueue.length - 1) captureIdx++;
        return ctx ?? makePageContext();
      };
      const clickAtLog: string[] = [];
      const fakeClient = {
        clickAt: async (sel: string) => {
          clickAtLog.push(sel);
        },
      };
      const { sleepLog, restore } = installSleepSpy();
      try {
        const result = await openComposerHardened({ client: fakeClient, capture });
        assert.ok(result.opened, "T-OpenRetry.1: opened should be true");
        // in-round probe sleeps: 120×(attempt+1) → 120, 240, 360; then between-round: 120*(1<<0)=120
        assert.deepEqual(
          sleepLog.slice(0, 4),
          [120, 240, 360, 120],
          "T-OpenRetry.1: 3 in-round probe sleeps (120/240/360ms) then 120ms between-round sleep",
        );
      } finally {
        restore();
      }
    },
  );

  it(
    "T-OpenRetry.2: given round-2 click lands and the first in-round probe sees activeLayer=modal + composerInput scope, " +
      "when openComposerHardened loops, " +
      "then returns {opened:true, openedOnRound:2, everClicked:true} with contextAtOpen defined",
    async () => {
      // Given: page context for round-1 probes; modal context at round-2 probe-1.
      // When: openComposerHardened runs.
      // Then: result.opened===true; result.openedOnRound===2; result.everClicked===true; contextAtOpen defined.
      const { openComposerHardened } = await loadReadiness();
      const pageCtx = makePageContext();
      const modalCtx = makeModalContext();
      const captureQueue = [pageCtx, pageCtx, pageCtx, pageCtx, pageCtx, pageCtx, modalCtx];
      let captureIdx = 0;
      const capture = async (): Promise<CurrentSurfaceContext> => {
        const ctx = captureQueue[captureIdx];
        if (captureIdx < captureQueue.length - 1) captureIdx++;
        return ctx ?? makePageContext();
      };
      const fakeClient = { clickAt: async (_sel: string) => {} };
      const result = await openComposerHardened({ client: fakeClient, capture });
      assert.equal(result.opened, true, "T-OpenRetry.2: opened");
      assert.equal(result.openedOnRound, 2, "T-OpenRetry.2: openedOnRound===2 (second click round, 1-indexed)");
      assert.equal(result.everClicked, true, "T-OpenRetry.2: everClicked");
      assert.ok(result.contextAtOpen !== undefined, "T-OpenRetry.2: contextAtOpen defined");
      assert.equal(result.contextAtOpen?.activeLayer, "modal", "T-OpenRetry.2: contextAtOpen is modal layer");
    },
  );

  it(
    "T-OpenRetry.3: given all 4 rounds × 3 probes fail to observe modal layer but at least one click landed, " +
      "when the loop ends, " +
      "then publishApprovedFeedPostViaAction returns {published:false, reason:'composer_absent_after_open', dispatchAttempted:false, fallbackAllowed:true}",
    async () => {
      // Given: captureQueue returns only page contexts (composer never opens).
      // When: publishApprovedFeedPostViaAction runs; openComposerHardened exhausts all rounds.
      // Then: result.published===false; result.reason==='composer_absent_after_open'; result.dispatchAttempted===false; result.fallbackAllowed===true.
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const tmpDir = join(tmpdir(), `harden-or3-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      const salesDbPath = join(tmpDir, "sales.db");
      const auditPath = join(tmpDir, "audit.jsonl");
      const draftId = "draft-or3";
      seedDraft(salesDbPath, draftId, "T-OpenRetry.3 post text");
      const evaluateQueues = new Map<string, unknown[]>();
      const clickAtLog: string[] = [];
      const client = makeFakeHardenedClient({
        urlQueue: [],
        navigateLog: [],
        evaluateQueues,
        clickAtLog,
        raceHandleLog: [],
      });
      const auditRowLog: AuditRow[] = [];
      const captureQueue = [makePageContext()]; // single element repeated → always page
      const deps = makeHardenedPublishDeps({ client, salesDbPath, auditPath, draftId, auditRowLog, captureQueue });
      const result = await publishApprovedFeedPostViaAction(deps);
      assert.equal(result.published, false, "T-OpenRetry.3: not published");
      assert.equal(result.reason, "composer_absent_after_open", "T-OpenRetry.3: reason is composer_absent_after_open");
      assert.equal(result.dispatchAttempted, false, "T-OpenRetry.3: dispatchAttempted false");
      assert.equal(result.fallbackAllowed, true, "T-OpenRetry.3: fallbackAllowed true (pre-dispatch failure)");
    },
  );

  it(
    "T-OpenRetry.4: given resolveScopedTarget throws ScopedTargetResolutionError on every round (button never in AX tree), " +
      "when openComposerHardened runs, " +
      "then publishApprovedFeedPostViaAction returns reason:'composer_open_click_failed' with dispatchAttempted:false",
    async () => {
      // Given: fake capture returns empty page context (no 'Start a post' button) → resolve throws each round.
      // When: publishApprovedFeedPostViaAction runs; everClicked stays false.
      // Then: result.reason==='composer_open_click_failed'; result.dispatchAttempted===false.
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const tmpDir = join(tmpdir(), `harden-or4-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      const salesDbPath = join(tmpDir, "sales.db");
      const auditPath = join(tmpDir, "audit.jsonl");
      const draftId = "draft-or4";
      seedDraft(salesDbPath, draftId, "T-OpenRetry.4 post text");
      const evaluateQueues = new Map<string, unknown[]>();
      const clickAtLog: string[] = [];
      const client = makeFakeHardenedClient({
        urlQueue: [],
        navigateLog: [],
        evaluateQueues,
        clickAtLog,
        raceHandleLog: [],
      });
      const auditRowLog: AuditRow[] = [];
      // Empty page: no "Start a post" entry → resolveScopedTarget throws every round
      const captureQueue = [makeEmptyPageContext()];
      const deps = makeHardenedPublishDeps({ client, salesDbPath, auditPath, draftId, auditRowLog, captureQueue });
      const result = await publishApprovedFeedPostViaAction(deps);
      assert.equal(result.published, false, "T-OpenRetry.4: not published");
      assert.equal(
        result.reason,
        "composer_open_click_failed",
        "T-OpenRetry.4: reason is composer_open_click_failed (everClicked===false)",
      );
      assert.equal(result.dispatchAttempted, false, "T-OpenRetry.4: dispatchAttempted false");
    },
  );

  it(
    "T-OpenRetry.5: given entry context already has activeLayer=modal and composerInput scope before the first click, " +
      "when publishApprovedFeedPostViaAction starts, " +
      "then openComposerHardened fast-returns {openedOnRound:0, everClicked:false} (no spurious click to open)",
    async () => {
      // Given: initial captureQueue starts with a modal context (composer already open).
      // When: publishApprovedFeedPostViaAction runs.
      // Then: clickAtLog contains only the dispatch click (no open-composer click); openRound===0.
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const tmpDir = join(tmpdir(), `harden-or5-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      const salesDbPath = join(tmpDir, "sales.db");
      const auditPath = join(tmpDir, "audit.jsonl");
      const draftId = "draft-or5";
      const draftText = "T-OpenRetry.5 fast-path post";
      seedDraft(salesDbPath, draftId, draftText);
      const evaluateQueues = makeHappyHardenedEvalQueues(draftText);
      const clickAtLog: string[] = [];
      const client = makeFakeHardenedClient({
        urlQueue: [],
        navigateLog: [],
        evaluateQueues,
        clickAtLog,
        raceHandleLog: [],
      });
      const auditRowLog: AuditRow[] = [];
      // modal initially → fast-path; modal again for step-3 composerInput; modal for step-8 post button
      const captureQueue = [makeModalContext(), makeModalContext(), makeModalContext()];
      const deps = makeHardenedPublishDeps({ client, salesDbPath, auditPath, draftId, auditRowLog, captureQueue });
      const result = await publishApprovedFeedPostViaAction(deps);
      assert.equal(result.published, true, "T-OpenRetry.5: published");
      assert.equal(result.openRound, 0, "T-OpenRetry.5: openRound===0 (fast-path, no click needed to open)");
      // Fast-path: no open click. Only dispatch click in clickAtLog.
      assert.equal(clickAtLog.length, 1, "T-OpenRetry.5: exactly 1 click (dispatch only, no open-composer click)");
    },
  );
});

// ===========================================================================
// T-ScopeBudget — per-call scope-ready budget override
// ===========================================================================

describe("resolveScopedTarget — per-call scope-ready budget override (T-ScopeBudget)", () => {
  it(
    "T-ScopeBudget.1: given captureCurrentSurfaceContext returns scope-unavailable 7 times then available on the 8th call, " +
      "when resolveScopedTarget is called with {scopeReadyAttempts:8, scopeReadyRetryMs:400}, " +
      "then the resolve succeeds (the 5-attempt default would have given up at attempt 5)",
    async () => {
      // Given: fake capture returns 7 page (composerInput unavailable) then 1 modal context.
      // When: resolveScopedTarget({kind:'input',scope:'composerInput'}, {captureCurrentSurfaceContext, scopeReadyAttempts:8, scopeReadyRetryMs:400}).
      // Then: resolve returns a result (does not throw); capture was called exactly 8 times.
      let callCount = 0;
      const mockCapture = async (): Promise<CurrentSurfaceContext> => {
        callCount++;
        return callCount >= 8 ? makeModalContext() : makePageContext();
      };
      const result = await resolveScopedTarget(
        { kind: "input", scope: "composerInput" },
        { captureCurrentSurfaceContext: mockCapture, scopeReadyAttempts: 8, scopeReadyRetryMs: 400 },
      );
      assert.ok(result, "T-ScopeBudget.1: resolve succeeded with 8-attempt budget");
      assert.equal(callCount, 8, "T-ScopeBudget.1: exactly 8 capture calls (default 5 would fail at attempt 5)");
    },
  );

  it(
    "T-ScopeBudget.2: given captureCurrentSurfaceContext returns scope-unavailable 5 times, " +
      "when resolveScopedTarget is called with no budget override, " +
      "then the resolve gives up after exactly 5 attempts (SCOPE_READY_ATTEMPTS default — no regression for any other caller)",
    async () => {
      // Given: fake capture always returns page context (composerInput scope never available).
      // When: resolveScopedTarget({kind:'input',scope:'composerInput'}, {captureCurrentSurfaceContext}).
      // Then: throws after exactly SCOPE_READY_ATTEMPTS (5) calls.
      let callCount = 0;
      const alwaysPage = async (): Promise<CurrentSurfaceContext> => {
        callCount++;
        return makePageContext();
      };
      await assert.rejects(
        () =>
          resolveScopedTarget({ kind: "input", scope: "composerInput" }, { captureCurrentSurfaceContext: alwaysPage }),
        "T-ScopeBudget.2: resolve rejects when scope never available within default budget",
      );
      assert.equal(
        callCount,
        SCOPE_READY_ATTEMPTS,
        `T-ScopeBudget.2: exactly SCOPE_READY_ATTEMPTS=${SCOPE_READY_ATTEMPTS} capture calls`,
      );
    },
  );

  it(
    "T-ScopeBudget.3: given a fake CDP where composer-modal scope appears at exactly the 6th capture, " +
      "when publishApprovedFeedPostViaAction runs, " +
      "then the step-3 composerInput resolve succeeds (proves the publish path opts in to the 8-attempt budget)",
    async () => {
      // Given: captureQueue: [0]=fast-path modal, [1-5]=page (composerInput unavailable), [6]=modal (available), [7]=modal for step-8.
      // When: publishApprovedFeedPostViaAction runs; step-3 resolve uses scopeReadyAttempts:8.
      // Then: result.published===true (resolve succeeds on 6th capture, within the 8-attempt budget).
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const tmpDir = join(tmpdir(), `harden-sb3-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      const salesDbPath = join(tmpDir, "sales.db");
      const auditPath = join(tmpDir, "audit.jsonl");
      const draftId = "draft-sb3";
      const draftText = "T-ScopeBudget.3 post";
      seedDraft(salesDbPath, draftId, draftText);
      const evaluateQueues = makeHappyHardenedEvalQueues(draftText);
      const clickAtLog: string[] = [];
      const client = makeFakeHardenedClient({
        urlQueue: [],
        navigateLog: [],
        evaluateQueues,
        clickAtLog,
        raceHandleLog: [],
      });
      const auditRowLog: AuditRow[] = [];
      const captureQueue = [
        makeModalContext(), // [0] fast-path open (composerInput available → no click)
        makePageContext(), // [1] step-3 composerInput resolve, capture #1 (not available)
        makePageContext(), // [2] capture #2
        makePageContext(), // [3] capture #3
        makePageContext(), // [4] capture #4
        makePageContext(), // [5] capture #5
        makeModalContext(), // [6] capture #6 → composerInput available!
        makeModalContext(), // [7] step-8 post button resolve (composerModal available)
      ];
      const deps = makeHardenedPublishDeps({ client, salesDbPath, auditPath, draftId, auditRowLog, captureQueue });
      const result = await publishApprovedFeedPostViaAction(deps);
      assert.equal(
        result.published,
        true,
        "T-ScopeBudget.3: published — step-3 composerInput resolve succeeded within 8-attempt budget",
      );
    },
  );

  it(
    "T-ScopeBudget.4: given a fake CDP where composerModal scope appears at exactly the 6th capture of the step-8 Post resolve, " +
      "when publishApprovedFeedPostViaAction runs the step-8 Post resolve, " +
      "then the resolve succeeds (proves the 8×400 budget override is applied at the Post resolve call site)",
    async () => {
      // Given: [0]=fast-path open, [1]=step-3 composerInput immediate, [2-6]=no composerModal, [7]=composerModal available.
      // When: publishApprovedFeedPostViaAction; step-8 uses scopeReadyAttempts:8, scopeReadyRetryMs:400.
      // Then: result.published===true (step-8 resolve succeeds on 6th scope-check, within 8-attempt budget).
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const tmpDir = join(tmpdir(), `harden-sb4-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      const salesDbPath = join(tmpDir, "sales.db");
      const auditPath = join(tmpDir, "audit.jsonl");
      const draftId = "draft-sb4";
      const draftText = "T-ScopeBudget.4 post";
      seedDraft(salesDbPath, draftId, draftText);
      const evaluateQueues = makeHappyHardenedEvalQueues(draftText);
      const clickAtLog: string[] = [];
      const client = makeFakeHardenedClient({
        urlQueue: [],
        navigateLog: [],
        evaluateQueues,
        clickAtLog,
        raceHandleLog: [],
      });
      const auditRowLog: AuditRow[] = [];
      const noComposerModal = makeModalContextNoComposerModal();
      const captureQueue = [
        makeModalContext(), // [0] fast-path open (composerInput available)
        makeModalContext(), // [1] step-3 composerInput resolve → immediate
        noComposerModal, // [2] step-8 capture #1 (composerModal NOT available)
        noComposerModal, // [3] step-8 capture #2
        noComposerModal, // [4] step-8 capture #3
        noComposerModal, // [5] step-8 capture #4
        noComposerModal, // [6] step-8 capture #5
        makeModalContext(), // [7] step-8 capture #6 (composerModal available!)
      ];
      const deps = makeHardenedPublishDeps({ client, salesDbPath, auditPath, draftId, auditRowLog, captureQueue });
      const result = await publishApprovedFeedPostViaAction(deps);
      assert.equal(
        result.published,
        true,
        "T-ScopeBudget.4: published — step-8 Post resolve succeeded within 8-attempt budget",
      );
    },
  );
});
