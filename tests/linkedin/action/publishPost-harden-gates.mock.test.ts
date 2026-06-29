/**
 * Phase native-port-S2-HARDEN — Step 5 (validator, Sonnet) — filled assertions
 *
 * Covers §5 harden-specific families:
 *   T-EnableGate.1–4, T-ComposerGone.1–4
 *
 * Runner:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/linkedin/action/publishPost-harden-gates.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AuditRow } from "./publishPost-harden.helpers.js";
import {
  evalThrow,
  installSleepSpy,
  loadPublish,
  loadReadiness,
  makeFakeHardenedClient,
  makeHappyHardenedEvalQueues,
  makeHardenedPublishDeps,
  makeModalContext,
  seedDraft,
} from "./publishPost-harden.helpers.js";

// ===========================================================================
// T-EnableGate — enabled-aware Post-button gate
// ===========================================================================

describe("waitForPostButtonEnabled — enabled-aware Post-button gate (T-EnableGate)", () => {
  it(
    "T-EnableGate.1: given COMPOSER_POST_BUTTON_ENABLED_JS returns false×2 then true on attempt 3, " +
      "when waitForPostButtonEnabled is invoked, " +
      "then it returns {enabled:true, attempts:3} with 120ms and 240ms sleeps between (1<<i backoff)",
    async () => {
      // Given: evaluateQueue for 'aria-disabled' returns [false, false, true].
      // When: waitForPostButtonEnabled(client).
      // Then: result.enabled===true; result.attempts===3; sleepLog contains [120, 240].
      const { waitForPostButtonEnabled } = await loadReadiness();
      const evaluateQueues = new Map<string, unknown[]>([["aria-disabled", [false, false, true]]]);
      const client = makeFakeHardenedClient({
        urlQueue: [],
        navigateLog: [],
        evaluateQueues,
        clickAtLog: [],
        raceHandleLog: [],
      });
      const { sleepLog, restore } = installSleepSpy();
      let result: { enabled: boolean; attempts: number };
      try {
        result = await waitForPostButtonEnabled(client);
      } finally {
        restore();
      }
      assert.equal(result!.enabled, true, "T-EnableGate.1: enabled after 3 attempts");
      assert.equal(result!.attempts, 3, "T-EnableGate.1: attempts===3");
      // sleep before attempt 2: OPEN_PROBE_BASE_MS*(1<<0)=120; before attempt 3: OPEN_PROBE_BASE_MS*(1<<1)=240
      assert.deepEqual(sleepLog, [120, 240], "T-EnableGate.1: sleeps [120ms, 240ms] between attempts");
    },
  );

  it(
    "T-EnableGate.2: given the enabled predicate returns false on all 6 attempts, " +
      "when waitForPostButtonEnabled returns {enabled:false, attempts:6}, " +
      "then publishApprovedFeedPostViaAction short-circuits with {published:false, reason:'post_button_not_enabled', dispatchAttempted:false, fallbackAllowed:true, enableGateAttempts:6}",
    async () => {
      // Given: evaluateQueue for 'aria-disabled' returns [false] (single element, repeated → all 6 attempts false).
      // When: publishApprovedFeedPostViaAction runs through open → fill → verify → enable-gate.
      // Then: result.reason==='post_button_not_enabled'; result.dispatchAttempted===false; result.enableGateAttempts===6.
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const tmpDir = join(tmpdir(), `harden-eg2-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      const salesDbPath = join(tmpDir, "sales.db");
      const auditPath = join(tmpDir, "audit.jsonl");
      const draftId = "draft-eg2";
      const draftText = "T-EnableGate.2 post";
      seedDraft(salesDbPath, draftId, draftText);
      const evaluateQueues = new Map<string, unknown[]>([
        ["activeElement", [true]],
        ["execCommand", [true]],
        ["editorText", [JSON.stringify({ present: true, editorText: draftText })]],
        ["aria-disabled", [false]], // single element repeated → all 6 fail
      ]);
      const clickAtLog: string[] = [];
      const client = makeFakeHardenedClient({
        urlQueue: [],
        navigateLog: [],
        evaluateQueues,
        clickAtLog,
        raceHandleLog: [],
      });
      const auditRowLog: AuditRow[] = [];
      const captureQueue = [makeModalContext(), makeModalContext(), makeModalContext()];
      const deps = makeHardenedPublishDeps({ client, salesDbPath, auditPath, draftId, auditRowLog, captureQueue });
      const result = await publishApprovedFeedPostViaAction(deps);
      assert.equal(result.published, false, "T-EnableGate.2: not published");
      assert.equal(result.reason, "post_button_not_enabled", "T-EnableGate.2: reason");
      assert.equal(result.dispatchAttempted, false, "T-EnableGate.2: no dispatch attempted");
      assert.equal(result.fallbackAllowed, true, "T-EnableGate.2: fallbackAllowed (pre-dispatch)");
      assert.equal(result.enableGateAttempts, 6, "T-EnableGate.2: 6 enable-gate attempts exhausted");
    },
  );

  it(
    "T-EnableGate.3: given client.evaluate throws during the predicate poll, " +
      "when waitForPostButtonEnabled runs, " +
      "then the throw is swallowed, the attempt counts as enabled:false, the loop continues, and returns {enabled:false, attempts:6}",
    async () => {
      // Given: evaluate throws on every call for the 'aria-disabled' key.
      // When: waitForPostButtonEnabled runs ENABLE_GATE_ATTEMPTS times; all throw.
      // Then: returns {enabled:false, attempts:6} — throws swallowed, treated as enabled:false each time.
      const { waitForPostButtonEnabled } = await loadReadiness();
      const evaluateQueues = new Map<string, unknown[]>([["aria-disabled", [evalThrow("transient eval error")]]]);
      const client = makeFakeHardenedClient({
        urlQueue: [],
        navigateLog: [],
        evaluateQueues,
        clickAtLog: [],
        raceHandleLog: [],
      });
      const result = await waitForPostButtonEnabled(client);
      // ENABLE_GATE_ATTEMPTS=6 (from readiness.ts)
      assert.equal(result.enabled, false, "T-EnableGate.3: enabled:false when evaluate always throws");
      assert.equal(
        result.attempts,
        6,
        "T-EnableGate.3: 6 attempts made despite throws (each throw treated as enabled:false)",
      );
    },
  );

  it(
    "T-EnableGate.4: given the enabled predicate returns true on the 1st attempt, " +
      "when waitForPostButtonEnabled is called, " +
      "then it returns {enabled:true, attempts:1} immediately with no spurious sleep",
    async () => {
      // Given: evaluateQueue for 'aria-disabled' returns [true].
      // When: waitForPostButtonEnabled(client).
      // Then: result.enabled===true; result.attempts===1; sleepLog is empty (no between-attempt sleep for i===0).
      const { waitForPostButtonEnabled } = await loadReadiness();
      const evaluateQueues = new Map<string, unknown[]>([["aria-disabled", [true]]]);
      const client = makeFakeHardenedClient({
        urlQueue: [],
        navigateLog: [],
        evaluateQueues,
        clickAtLog: [],
        raceHandleLog: [],
      });
      const { sleepLog, restore } = installSleepSpy();
      let result: { enabled: boolean; attempts: number };
      try {
        result = await waitForPostButtonEnabled(client);
      } finally {
        restore();
      }
      assert.equal(result!.enabled, true, "T-EnableGate.4: enabled on 1st attempt");
      assert.equal(result!.attempts, 1, "T-EnableGate.4: attempts===1");
      assert.equal(
        sleepLog.length,
        0,
        "T-EnableGate.4: no sleep (enabled on 1st attempt, no between-attempt sleep for i===0)",
      );
    },
  );
});

// ===========================================================================
// T-ComposerGone — post-dispatch composer-gone confirmation
// ===========================================================================

describe("confirmComposerGone — post-dispatch composer-gone confirmation (T-ComposerGone)", () => {
  it(
    "T-ComposerGone.1: given COMPOSER_PRESENT_JS returns {present:true}×3 then {present:false} on attempt 4, " +
      "when confirmComposerGone is invoked, " +
      "then it returns {gone:true, attempts:4}",
    async () => {
      // Given: evaluateQueue for 'JSON.stringify({pres' returns [present:true×3, present:false].
      // When: confirmComposerGone(client).
      // Then: result.gone===true; result.attempts===4.
      const { confirmComposerGone } = await loadReadiness();
      const present = (v: boolean) => JSON.stringify({ present: v });
      const evaluateQueues = new Map<string, unknown[]>([
        ["JSON.stringify({pres", [present(true), present(true), present(true), present(false)]],
      ]);
      const client = makeFakeHardenedClient({
        urlQueue: [],
        navigateLog: [],
        evaluateQueues,
        clickAtLog: [],
        raceHandleLog: [],
      });
      const result = await confirmComposerGone(client);
      assert.equal(result.gone, true, "T-ComposerGone.1: gone after 4 attempts");
      assert.equal(result.attempts, 4, "T-ComposerGone.1: attempts===4");
    },
  );

  it(
    "T-ComposerGone.2: given COMPOSER_PRESENT_JS returns {present:true} on all 6 attempts, " +
      "when confirmComposerGone returns {gone:false, attempts:6}, " +
      "then publishApprovedFeedPostViaAction calls finishPostDispatchAmbiguous with dispatchAttempted:true, fallbackAllowed:false, and markDraftSent fires",
    async () => {
      // Given: evaluateQueue for 'JSON.stringify({pres' returns [present:true] (repeated for all 6 attempts).
      // When: publishApprovedFeedPostViaAction runs; dispatch click fires; composer never closes.
      // Then: result.dispatchAttempted===true; result.fallbackAllowed===false; result.draftMarkedSent===true; result.composerGoneAttempts===6.
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const tmpDir = join(tmpdir(), `harden-cg2-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      const salesDbPath = join(tmpDir, "sales.db");
      const auditPath = join(tmpDir, "audit.jsonl");
      const draftId = "draft-cg2";
      const draftText = "T-ComposerGone.2 post";
      seedDraft(salesDbPath, draftId, draftText);
      const present = (v: boolean) => JSON.stringify({ present: v });
      const evaluateQueues = new Map<string, unknown[]>([
        ["activeElement", [true]],
        ["execCommand", [true]],
        ["editorText", [JSON.stringify({ present: true, editorText: draftText })]],
        ["aria-disabled", [true]],
        ["JSON.stringify({pres", [present(true)]], // repeated → composer never closes
      ]);
      const clickAtLog: string[] = [];
      const client = makeFakeHardenedClient({
        urlQueue: [],
        navigateLog: [],
        evaluateQueues,
        clickAtLog,
        raceHandleLog: [],
      });
      const auditRowLog: AuditRow[] = [];
      const captureQueue = [makeModalContext(), makeModalContext(), makeModalContext()];
      const deps = makeHardenedPublishDeps({ client, salesDbPath, auditPath, draftId, auditRowLog, captureQueue });
      const result = await publishApprovedFeedPostViaAction(deps);
      assert.equal(result.published, false, "T-ComposerGone.2: not published (ambiguous)");
      assert.equal(result.dispatchAttempted, true, "T-ComposerGone.2: dispatch was attempted");
      assert.equal(result.fallbackAllowed, false, "T-ComposerGone.2: fallbackAllowed false (post-dispatch)");
      assert.equal(
        result.draftMarkedSent,
        true,
        "T-ComposerGone.2: draftMarkedSent fired (post-dispatch always marks sent)",
      );
      assert.equal(result.composerGoneAttempts, 6, "T-ComposerGone.2: 6 composer-gone attempts exhausted");
    },
  );

  it(
    "T-ComposerGone.3: given COMPOSER_PRESENT_JS returns {present:false} on the 1st attempt, " +
      "when confirmComposerGone runs, " +
      "then publishApprovedFeedPostViaAction returns finishSuccess with composerGoneAttempts:1",
    async () => {
      // Given: evaluateQueue for 'JSON.stringify({pres' returns [present:false] (composer gone immediately).
      // When: publishApprovedFeedPostViaAction runs; dispatch click fires; composer clears on first probe.
      // Then: result.published===true; result.composerGoneAttempts===1.
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const tmpDir = join(tmpdir(), `harden-cg3-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      const salesDbPath = join(tmpDir, "sales.db");
      const auditPath = join(tmpDir, "audit.jsonl");
      const draftId = "draft-cg3";
      const draftText = "T-ComposerGone.3 post";
      seedDraft(salesDbPath, draftId, draftText);
      const evaluateQueues = makeHappyHardenedEvalQueues(draftText); // JSON.stringify({pres → present:false immediately
      const clickAtLog: string[] = [];
      const client = makeFakeHardenedClient({
        urlQueue: [],
        navigateLog: [],
        evaluateQueues,
        clickAtLog,
        raceHandleLog: [],
      });
      const auditRowLog: AuditRow[] = [];
      const captureQueue = [makeModalContext(), makeModalContext(), makeModalContext()];
      const deps = makeHardenedPublishDeps({ client, salesDbPath, auditPath, draftId, auditRowLog, captureQueue });
      const result = await publishApprovedFeedPostViaAction(deps);
      assert.equal(result.published, true, "T-ComposerGone.3: published");
      assert.equal(result.composerGoneAttempts, 1, "T-ComposerGone.3: composer gone on 1st attempt");
    },
  );

  it(
    "T-ComposerGone.4: given client.evaluate THROWS on attempts 1 and 2 (transient eval error) then returns {present:false} on attempt 3, " +
      "when confirmComposerGone runs, " +
      "then it returns {gone:true, attempts:3} — swallow-and-continue on throw; publishApprovedFeedPostViaAction returns success with no re-dispatch",
    async () => {
      // Given: evaluateQueue for 'JSON.stringify({pres' = [evalThrow(), evalThrow(), JSON.stringify({present:false})].
      //   Throws on attempts 1+2 are swallowed (counted as present=true); attempt 3 → present:false → gone:true.
      // When: publishApprovedFeedPostViaAction runs through to confirmComposerGone.
      // Then: result.published===true; result.composerGoneAttempts===3; result.dispatchAttempted===true;
      //   result.draftMarkedSent===true; clickAtLog.length===1 (no re-dispatch).
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const tmpDir = join(tmpdir(), `harden-cg4-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      const salesDbPath = join(tmpDir, "sales.db");
      const auditPath = join(tmpDir, "audit.jsonl");
      const draftId = "draft-cg4";
      const draftText = "T-ComposerGone.4 post";
      seedDraft(salesDbPath, draftId, draftText);
      const present = (v: boolean) => JSON.stringify({ present: v });
      const evaluateQueues = new Map<string, unknown[]>([
        ["activeElement", [true]],
        ["execCommand", [true]],
        ["editorText", [JSON.stringify({ present: true, editorText: draftText })]],
        ["aria-disabled", [true]],
        // Two throws (each swallowed as present:true), then present:false on attempt 3
        ["JSON.stringify({pres", [evalThrow("transient 1"), evalThrow("transient 2"), present(false)]],
      ]);
      const clickAtLog: string[] = [];
      const client = makeFakeHardenedClient({
        urlQueue: [],
        navigateLog: [],
        evaluateQueues,
        clickAtLog,
        raceHandleLog: [],
      });
      const auditRowLog: AuditRow[] = [];
      const captureQueue = [makeModalContext(), makeModalContext(), makeModalContext()]; // fast-path open
      const deps = makeHardenedPublishDeps({ client, salesDbPath, auditPath, draftId, auditRowLog, captureQueue });
      const result = await publishApprovedFeedPostViaAction(deps);
      assert.equal(result.published, true, "T-ComposerGone.4: published despite transient eval throws");
      assert.equal(result.composerGoneAttempts, 3, "T-ComposerGone.4: 3 attempts (2 throws swallowed + 1 success)");
      assert.equal(result.dispatchAttempted, true, "T-ComposerGone.4: dispatch was attempted");
      assert.equal(result.draftMarkedSent, true, "T-ComposerGone.4: draftMarkedSent fired exactly once");
      // Fast-path: no open click. Only 1 dispatch click. No re-dispatch.
      assert.equal(
        clickAtLog.length,
        1,
        "T-ComposerGone.4: exactly 1 clickAt — no re-dispatch after ambiguous gone-check",
      );
    },
  );
});
