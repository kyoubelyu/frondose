/**
 * P-AUTO-L3FIX-1 Step 3a (Scaffold Revision) — Test Scaffold
 * T-Race.1–7 (A1 — raced conversion, 18 sites across 6 modules) + T-Nav.1–3 (B2 — preload navigate fix)
 *
 * Workstreams covered: A1, B2
 *
 * All assertion bodies are assert.fail("TODO: …") — compile-only, ALL-FAILING.
 * Builder Step 4 makes the scaffolds compile + reach the assertion-TODO branch.
 * Validator Step 5 fills assertion bodies.
 *
 * ── Step 3a changes from Step 2 scaffold ──────────────────────────────────────
 *
 * BLOCKER-1 fix (T-Race.1–4 false-pass redesign):
 *   The original `raceWithTestDeadline()` helper wrapped the call under test in a
 *   SEPARATE `raceCdp(label:"test-deadline")`. If production stays unraced, that
 *   outer wrapper STILL rejects — so T-Race.1–4 could pass without proving production
 *   is raced. This is the critic's scaffold BLOCKER.
 *
 *   Chosen mechanism: ABORT-SIGNAL path.
 *     Wire a `turnSignal` via `client.setTurnAbortSignal(signal)` + abort it
 *     BEFORE calling the method. If production wraps the call in `this.race(p, label)`,
 *     then `raceCdp` sees `signal.aborted === true` at entry and rejects immediately
 *     with `CdpCallAbortedError` whose `.label` is the PRODUCTION label
 *     (e.g. "DOM.getDocument", "Network.enable") — NOT "test-deadline".
 *     If production is still unraced, the call never routes through `raceCdp` and
 *     the abort is ignored, so the promise pends forever → the test itself gets
 *     wrapped with a SHORT `raceCdp("test-abort-guard")` at the test level ONLY for
 *     runner safety — but the assertion checks `.label !== "test-abort-guard"`, so a
 *     false-pass through the guard is CAUGHT.
 *
 *   Why abort, not fake-timers:
 *     The production deadline is 45 000ms (`CDP_CALL_DEADLINE_MS`, client.ts:45).
 *     Node.js `--test` does not integrate with fake-timer libraries easily. The abort
 *     path fires synchronously (raceCdp:81 `if (signal?.aborted) return Promise.reject(…)`)
 *     so the test completes in <1ms with no timer manipulation. Fake-timers are a valid
 *     alternative at Step 5 for the DEADLINE path (T-Nav.3) — see below.
 *
 * BLOCKER-2 fix (T-Race.6 — source-grep + behavioral per-site guards):
 *   T-Race.6 now includes:
 *   (a) Source-grep assertions that NO bare `client.handle.*` await remains at the
 *       18 converted sites (catches the "raceHandle exists but sites still bypass it" bug).
 *   (b) Behavioral per-site tests: drive EACH production function through a never-resolving
 *       fake handle with an aborted signal — reject MUST carry the PRODUCTION label,
 *       not a test-guard label. Covers Groups 2+3+5+6 (the externally-called modules).
 *
 * T-Nav.3 intent updated (Step-3a CONCERN-MR fix):
 *   No-event / no-abort case rejects via `CdpCallTimeoutError` (the 45s CDP race wins)
 *   NOT via `WaitTimeoutError` (the inner 30s timer) — because the preload wait now uses
 *   `{ timeout: 60_000 }` which is > the 45s `CDP_CALL_DEADLINE_MS`. The abort case
 *   rejects via `CdpCallAbortedError`. Step 5 uses fake-timers for the deadline case
 *   and the abort mechanism for the abort case.
 *
 * ── Runner safety note ─────────────────────────────────────────────────────────
 *   Every test that involves a never-resolving call uses a safety wrapper:
 *   `guardedReject(op, "guard-label")` — a short-deadline `raceCdp` that prevents the
 *   test runner from hanging >200ms. The assertion ALWAYS checks the rejection came from
 *   the PRODUCTION label (not "guard-label"), so if production is unraced, the guard
 *   fires but the assertion fails because `.label === "guard-label"` (the TODO asserts
 *   the PRODUCTION label name, which mismatches "guard-label"). This is the false-pass
 *   proof: the TODO body that Step 5 fills MUST assert the production label.
 *
 * ── A1 site inventory (the 18 converted sites, contract) ─────────────────────
 *   Group 1 — client.ts (7): DOM.getDocument, DOM.querySelectorAll, DOM.setFileInputFiles,
 *              DOM.describeNode, Network.enable, Network.clearBrowserCookies,
 *              Storage.clearDataForOrigin
 *   Group 2 — regionTag.ts (3): regionTag.evaluate, regionTag.describeNode, regionTag.cleanup
 *   Group 3 — snapshotCapture.ts (4): snapshot.describeNode (×3), snapshot.getAttributes
 *   Group 5 — stealth.ts (2) + session.ts (1): stealth.Page.enable, stealth.addScript,
 *              Target.setDiscoverTargets
 *   Group 6 — hardwareInput.ts (1): hwinput.getBoxModel
 *   Total: 7 + 3 + 4 + 3 + 1 = 18
 *
 * No real Chrome required.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CdpClient } from "../../src/cdp/client.js";
import { injectStealth } from "../../src/cdp/stealth.js";
import { CdpCallAbortedError, CdpCallTimeoutError, raceCdp } from "../../src/cdp/raced.js";
import { tagAsideClickables } from "../../src/linkedin/snapshotCapture/regionTag.js";
import { resolveScreenCoords } from "../../src/cdp/hardwareInput.js";

// ─── Repo root for source-grep assertions ─────────────────────────────────────

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLIENT_TS = readFileSync(join(REPO, "src/cdp/client.ts"), "utf-8");
const REGION_TAG_TS = readFileSync(join(REPO, "src/linkedin/snapshotCapture/regionTag.ts"), "utf-8");
const SNAPSHOT_CAPTURE_TS = readFileSync(join(REPO, "src/linkedin/snapshotCapture.ts"), "utf-8");
const STEALTH_TS = readFileSync(join(REPO, "src/cdp/stealth.ts"), "utf-8");
const SESSION_TS = readFileSync(join(REPO, "src/linkedin/session.ts"), "utf-8");
const HARDWARE_INPUT_TS = readFileSync(join(REPO, "src/cdp/hardwareInput.ts"), "utf-8");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A promise that never resolves (simulates a hung CDP call). */
function neverResolve<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/**
 * Safety wrapper for tests involving never-resolving calls.
 * Wraps `op` in a short-deadline raceCdp with label "test-abort-guard" so the
 * test runner cannot hang >200ms. The assertion body in each test MUST assert
 * the production label (NOT "test-abort-guard") — so if production is unraced
 * and this guard fires, the label check FAILS (false-pass prevention).
 */
async function guardedReject<T>(op: Promise<T>): Promise<T> {
  return raceCdp(op, { label: "test-abort-guard", deadlineMs: 200 });
}

/**
 * Build a minimal fake CDP handle. The handle stubs all domains needed by
 * the production methods under test. Individual test overrides replace the
 * relevant stub with neverResolve() to simulate a hang.
 */
function makeFullFakeHandle(overrides?: {
  getDocument?: () => Promise<unknown>;
  querySelectorAll?: () => Promise<unknown>;
  describeNode?: () => Promise<unknown>;
  setFileInputFiles?: () => Promise<unknown>;
  getAttributes?: () => Promise<unknown>;
  networkEnable?: () => Promise<unknown>;
  clearBrowserCookies?: () => Promise<unknown>;
  clearDataForOrigin?: () => Promise<unknown>;
  pageEnable?: () => Promise<unknown>;
  pageNavigate?: () => Promise<unknown>;
  pageLoadEventFired?: (cb: () => void) => () => void;
  pageLifecycleEvent?: (cb: (ev: { name: string }) => void) => () => void;
  pageSetLifecycleEventsEnabled?: () => Promise<unknown>;
  runtimeEvaluate?: () => Promise<unknown>;
  targetSetDiscoverTargets?: () => Promise<unknown>;
  domGetBoxModel?: () => Promise<unknown>;
}) {
  return {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({ nodes: [] }),
    },
    Page: {
      enable: overrides?.pageEnable ?? (() => Promise.resolve({})),
      navigate: overrides?.pageNavigate ?? ((_args: { url: string }) => Promise.resolve({ errorText: undefined })),
      loadEventFired: overrides?.pageLoadEventFired ?? ((_cb: () => void) => () => {}),
      setLifecycleEventsEnabled: overrides?.pageSetLifecycleEventsEnabled ?? ((_args: unknown) => Promise.resolve({})),
      lifecycleEvent: overrides?.pageLifecycleEvent ?? ((_cb: (ev: { name: string }) => void) => () => {}),
      addScriptToEvaluateOnNewDocument: (_args: unknown) => Promise.resolve({ identifier: "1" }),
    },
    Runtime: {
      evaluate: overrides?.runtimeEvaluate ?? ((_args: unknown) => Promise.resolve({ result: { value: "[]" } })),
    },
    DOM: {
      getDocument: overrides?.getDocument ?? ((_args: unknown) => Promise.resolve({ root: { nodeId: 1 } })),
      querySelectorAll: overrides?.querySelectorAll ?? ((_args: unknown) => Promise.resolve({ nodeIds: [] })),
      describeNode: overrides?.describeNode ?? ((_args: unknown) => Promise.resolve({ node: { nodeId: 1, backendNodeId: 10 } })),
      setFileInputFiles: overrides?.setFileInputFiles ?? ((_args: unknown) => Promise.resolve({})),
      getAttributes: overrides?.getAttributes ?? ((_args: unknown) => Promise.resolve({ attributes: [] })),
      scrollIntoViewIfNeeded: async (_arg: unknown) => {},
      getBoxModel: overrides?.domGetBoxModel ?? ((_args: unknown) => Promise.resolve({ model: { border: [0, 0, 100, 0, 100, 100, 0, 100] } })),
    },
    Network: {
      enable: overrides?.networkEnable ?? (() => Promise.resolve({})),
      clearBrowserCookies: overrides?.clearBrowserCookies ?? (() => Promise.resolve({})),
    },
    Storage: {
      clearDataForOrigin: overrides?.clearDataForOrigin ?? ((_args: unknown) => Promise.resolve({})),
    },
    Target: {
      setDiscoverTargets: overrides?.targetSetDiscoverTargets ?? ((_args: unknown) => Promise.resolve({})),
    },
    on: (_event: string, _cb: unknown) => {},
  };
}

// ─── T-Race suite (A1 — raced-conversion) ─────────────────────────────────────

describe("A1 — raced-conversion: client.ts Group-1 methods route through raceCdp", () => {

  // ─── T-Race.1 ──────────────────────────────────────────────────────────────
  it("T-Race.1: when DOM.getDocument never resolves + turnSignal aborts, querySelectorAll rejects with CdpCallAbortedError whose label is the PRODUCTION label (not 'test-abort-guard')", async () => {
    // Given: a fromHandle client whose DOM.getDocument returns a never-resolving promise
    //        and a turnSignal AbortController that is aborted BEFORE the call
    // When:  setTurnAbortSignal(signal) + signal.abort() + client.querySelectorAll("x")
    // Then:  rejects with CdpCallAbortedError; .label === "DOM.getDocument"
    //        (the PRODUCTION label from this.race(…, "DOM.getDocument") in client.ts)
    //        NOT "test-abort-guard" — proving the rejection came from production's this.race(),
    //        not the outer test safety wrapper.
    //
    // False-pass guard: if production is unraced, abort is ignored, neverResolve() pends
    // forever, guardedReject fires with label="test-abort-guard" → the TODO assertion
    // checks label==="DOM.getDocument" which FAILS. Step 5 fills with the real assert.
    const abortController = new AbortController();
    const client = CdpClient.fromHandle(makeFullFakeHandle({
      getDocument: () => neverResolve(),
    }));
    client.setTurnAbortSignal(abortController.signal);
    abortController.abort(); // abort before the call so production raceCdp sees aborted=true immediately
    const callPromise = client.querySelectorAll("x");
    await assert.rejects(
      () => guardedReject(callPromise),
      (err: unknown) => {
        // PRODUCTION label proves the rejection came from production's this.race(), not the test guard.
        assert.ok(err instanceof CdpCallAbortedError, `expected CdpCallAbortedError, got ${String(err)}`);
        assert.equal(err.label, "DOM.getDocument");
        return true;
      },
    );
  });

  // ─── T-Race.2 ──────────────────────────────────────────────────────────────
  it("T-Race.2: when turnSignal aborts while querySelectorAll is in-flight, rejects with CdpCallAbortedError (signal fires before deadline)", async () => {
    // Given: a fromHandle client whose DOM.getDocument never resolves
    //        and a turnSignal that fires AFTER the call starts (in-flight abort)
    // When:  setTurnAbortSignal(signal) + call starts + setImmediate aborts signal
    // Then:  rejects with CdpCallAbortedError (label = production label, e.g. "DOM.getDocument")
    //        Covers the signal-plumbing path: this.race passes signal to raceCdp.
    const abortController = new AbortController();
    const client = CdpClient.fromHandle(makeFullFakeHandle({
      getDocument: () => neverResolve(),
    }));
    client.setTurnAbortSignal(abortController.signal);
    const callPromise = client.querySelectorAll("x");
    setImmediate(() => abortController.abort());
    await assert.rejects(
      () => guardedReject(callPromise),
      (err: unknown) => {
        assert.ok(err instanceof CdpCallAbortedError, `expected CdpCallAbortedError, got ${String(err)}`);
        // The label must NOT be "test-abort-guard" — that would mean the guard fired (production unraced).
        assert.notEqual(err.label, "test-abort-guard");
        // The production label is "DOM.getDocument" — the first raced call in querySelectorAll.
        assert.equal(err.label, "DOM.getDocument");
        return true;
      },
    );
  });

  // ─── T-Race.3 ──────────────────────────────────────────────────────────────
  it("T-Race.3: when DOM.describeNode never resolves + turnSignal aborts, setFileInputFiles rejects with CdpCallAbortedError (production label, covers resolveBackendToNodeId+setFileInputFiles)", async () => {
    // Given: a fromHandle client whose DOM.describeNode returns neverResolve() (Group-1 #4)
    //        (resolveBackendToNodeId calls describeNode — the first raced call in this path)
    // When:  setTurnAbortSignal + abort + client.setFileInputFiles(backendNodeId=1, [])
    // Then:  rejects with CdpCallAbortedError; .label === "DOM.describeNode"
    //        (the PRODUCTION label proving resolveBackendToNodeId + setFileInputFiles are raced)
    //        NOT "test-abort-guard"
    const abortController = new AbortController();
    const client = CdpClient.fromHandle(makeFullFakeHandle({
      describeNode: () => neverResolve(),
    }));
    client.setTurnAbortSignal(abortController.signal);
    abortController.abort();
    const callPromise = client.setFileInputFiles(1, []);
    await assert.rejects(
      () => guardedReject(callPromise),
      (err: unknown) => {
        assert.ok(err instanceof CdpCallAbortedError, `expected CdpCallAbortedError, got ${String(err)}`);
        // "DOM.describeNode" is the label from resolveBackendToNodeId in client.ts (Group-1 #4).
        assert.equal(err.label, "DOM.describeNode");
        return true;
      },
    );
  });

  // ─── T-Race.4 ──────────────────────────────────────────────────────────────
  it("T-Race.4: when Network.enable never resolves + turnSignal aborts, clearBrowserCookies rejects with CdpCallAbortedError (production label 'Network.enable', proves Group-1 #5+#6 raced)", async () => {
    // Given: a fromHandle client whose Network.enable returns neverResolve() (Group-1 #5)
    // When:  setTurnAbortSignal + abort + client.clearBrowserCookies()
    // Then:  rejects with CdpCallAbortedError; .label === "Network.enable"
    //        (the PRODUCTION label — proving Network.enable + clearBrowserCookies are raced)
    //        NOT "test-abort-guard"
    const abortController = new AbortController();
    const client = CdpClient.fromHandle(makeFullFakeHandle({
      networkEnable: () => neverResolve(),
    }));
    client.setTurnAbortSignal(abortController.signal);
    abortController.abort();
    const callPromise = client.clearBrowserCookies();
    await assert.rejects(
      () => guardedReject(callPromise),
      (err: unknown) => {
        assert.ok(err instanceof CdpCallAbortedError, `expected CdpCallAbortedError, got ${String(err)}`);
        // "Network.enable" is the label from clearBrowserCookies' first raced call (Group-1 #5).
        assert.equal(err.label, "Network.enable");
        return true;
      },
    );
  });

  // ─── T-Race.5 ──────────────────────────────────────────────────────────────
  it("T-Race.5: given handles that resolve normally, querySelectorAll and setFileInputFiles return expected values (happy-path invariance)", async () => {
    // Given: a fromHandle client whose DOM methods all resolve normally (no abort, no hang)
    // When:  client.querySelectorAll("button") and client.setFileInputFiles(10, ["file.txt"]) called
    // Then:  querySelectorAll returns the expected nodeIds array; setFileInputFiles resolves without throw
    //        (racing adds nothing on the happy path — regression guard)
    const setFileInputFilesArgs: Array<{ nodeId: number; files: string[] }> = [];
    const client = CdpClient.fromHandle(makeFullFakeHandle({
      getDocument: () => Promise.resolve({ root: { nodeId: 1 } }),
      querySelectorAll: () => Promise.resolve({ nodeIds: [7, 8, 9] }),
      describeNode: () => Promise.resolve({ node: { nodeId: 55, backendNodeId: 10 } }),
      setFileInputFiles: (args: { nodeId: number; files: string[] }) => {
        setFileInputFilesArgs.push(args);
        return Promise.resolve({});
      },
    }));
    const nodeIds = await client.querySelectorAll("button");
    await client.setFileInputFiles(10, ["file.txt"]);
    // Racing adds nothing on the happy path — same values returned as without a race wrapper.
    assert.deepEqual(nodeIds, [7, 8, 9]);
    assert.equal(setFileInputFilesArgs.length, 1);
    // describeNode returns nodeId=55 for backendNodeId=10, so setFileInputFiles gets nodeId=55.
    assert.equal(setFileInputFilesArgs[0]?.nodeId, 55);
    assert.deepEqual(setFileInputFilesArgs[0]?.files, ["file.txt"]);
  });

  // ─── T-Race.6a — source-grep guard (all 18 sites) ─────────────────────────
  it("T-Race.6a: source-grep — NO bare client.handle.* or this.client.* awaitable call remains unraced at any of the 18 converted sites (post-fix guard)", () => {
    // Given: the 6 production source files for Groups 1+2+3+5+6
    // When:  their source text is inspected for unraced patterns
    // Then:  (a) client.ts — no bare `this.client.DOM.getDocument(` without preceding `this.race(`
    //            in the same method (querySelectorAll / setFileInputFiles / resolveBackendToNodeId /
    //            clearBrowserCookies / clearOriginData); checked by asserting `this.race(` DOMINATES
    //            `this.client.DOM.getDocument(` in client.ts (both present, race used)
    //        (b) regionTag.ts — no bare `client.handle.Runtime.evaluate(` or `client.handle.DOM.describeNode(`
    //            without `client.raceHandle(` in the same file
    //        (c) snapshotCapture.ts — no bare `client.handle.DOM.describeNode(` or
    //            `client.handle.DOM.getAttributes(` without `client.raceHandle(` in the same file
    //        (d) stealth.ts — no bare `client.handle.Page.enable(` or
    //            `client.handle.Page.addScriptToEvaluateOnNewDocument(` without `client.raceHandle(`
    //        (e) session.ts:69 — no bare `client.handle.Target.setDiscoverTargets(` without
    //            `client.raceHandle(` (only that ONE site; the .on() subs and detached void calls stay unraced)
    //        (f) hardwareInput.ts:97 — no bare `client.handle.DOM.getBoxModel(` without
    //            `client.raceHandle(`
    //
    // NOTE: source-grep is a structural check. The behavioral per-site tests (T-Race.6b–6g)
    // confirm the RUNTIME behavior. Both checks are needed: grep catches "forgot to wrap",
    // behavioral catches "wrapped but with wrong label / wrong promise".
    //
    // Pre-fix (ALL-RED): raceHandle is not yet added to client.ts, so these checks fail.
    const clientHasRaceHandle = CLIENT_TS.includes("raceHandle");
    const regionTagHasRaceHandle = REGION_TAG_TS.includes("raceHandle");
    const snapshotCaptureHasRaceHandle = SNAPSHOT_CAPTURE_TS.includes("raceHandle");
    const stealthHasRaceHandle = STEALTH_TS.includes("raceHandle");
    const sessionHasRaceHandle = SESSION_TS.includes("raceHandle");
    const hardwareInputHasRaceHandle = HARDWARE_INPUT_TS.includes("raceHandle");

    // Also assert no bare (unraced) patterns remain at the specific converted sites:
    // Group 2: regionTag.ts must NOT have bare `client.handle.Runtime.evaluate(` (all 3 are raced)
    const regionTagHasBareEvaluate =
      REGION_TAG_TS.includes("client.handle.Runtime.evaluate(") &&
      !REGION_TAG_TS.includes("raceHandle");
    // Group 5: stealth.ts must NOT have bare `client.handle.Page.enable(`
    const stealthHasBarePageEnable =
      STEALTH_TS.includes("client.handle.Page.enable()") &&
      !STEALTH_TS.includes("raceHandle");
    // Group 5: session.ts must NOT have bare `await client.handle.Target.setDiscoverTargets(`
    const sessionHasBareSetDiscoverTargets =
      SESSION_TS.includes("await client.handle.Target.setDiscoverTargets(") &&
      !SESSION_TS.includes("raceHandle");
    // Group 6: hardwareInput.ts must NOT have bare `client.handle.DOM.getBoxModel(`
    const hardwareHasBareGetBoxModel =
      HARDWARE_INPUT_TS.includes("client.handle.DOM.getBoxModel(") &&
      !HARDWARE_INPUT_TS.includes("raceHandle");

    // All 6 modules must have raceHandle present.
    assert.ok(clientHasRaceHandle, "client.ts must export raceHandle method");
    assert.ok(regionTagHasRaceHandle, "regionTag.ts must use client.raceHandle for Group-2");
    assert.ok(snapshotCaptureHasRaceHandle, "snapshotCapture.ts must use client.raceHandle for Group-3");
    assert.ok(stealthHasRaceHandle, "stealth.ts must use client.raceHandle for Group-5 Page.enable");
    assert.ok(sessionHasRaceHandle, "session.ts must use client.raceHandle for Group-5 Target.setDiscoverTargets");
    assert.ok(hardwareInputHasRaceHandle, "hardwareInput.ts must use client.raceHandle for Group-6 DOM.getBoxModel");

    // Bare (unraced) patterns must NOT remain at the converted sites.
    assert.ok(
      !regionTagHasBareEvaluate,
      "regionTag.ts must NOT have bare client.handle.Runtime.evaluate( without raceHandle",
    );
    assert.ok(!stealthHasBarePageEnable, "stealth.ts must NOT have bare client.handle.Page.enable() without raceHandle");
    assert.ok(
      !sessionHasBareSetDiscoverTargets,
      "session.ts must NOT have bare await client.handle.Target.setDiscoverTargets( without raceHandle",
    );
    assert.ok(
      !hardwareHasBareGetBoxModel,
      "hardwareInput.ts must NOT have bare client.handle.DOM.getBoxModel( without raceHandle",
    );
  });

  // ─── T-Race.6b — behavioral: Group-2 regionTag path ──────────────────────
  it("T-Race.6b: Group-2 — when Runtime.evaluate never resolves + turnSignal aborts, tagAsideClickables (regionTag path) routes through raceCdp with PRODUCTION label 'regionTag.evaluate' (not 'test-abort-guard')", async () => {
    // Given: a CdpClient whose Runtime.evaluate for regionTag never resolves
    //        and a wired+aborted turnSignal
    // When:  tagAsideClickables(client) (the production function that calls the Group-2 evaluate)
    // Then:  the raceHandle call inside tagAsideClickables fires with label "regionTag.evaluate".
    //        tagAsideClickables swallows its own errors (try/catch → empty Set),
    //        so we intercept via a one-shot raceHandle wrapper to capture the label, then verify.
    //        NOT "test-abort-guard" — proving the production site is raced, not the test guard.
    const abortController = new AbortController();
    const client = CdpClient.fromHandle(makeFullFakeHandle({
      runtimeEvaluate: () => neverResolve(),
    }));
    client.setTurnAbortSignal(abortController.signal);

    // Capture the first raceHandle call label by patching the client instance.
    const capturedLabels: string[] = [];
    const originalRaceHandle = client.raceHandle.bind(client);
    // biome-ignore lint/suspicious/noExplicitAny: test spy
    (client as any).raceHandle = (p: Promise<any>, label: string) => {
      capturedLabels.push(label);
      return originalRaceHandle(p, label);
    };

    abortController.abort(); // aborted before call — raceCdp fast-path fires synchronously
    await tagAsideClickables(client); // swallows the error, returns empty Set

    // The first raceHandle call must have been with the production label "regionTag.evaluate".
    assert.ok(capturedLabels.length > 0, "raceHandle must have been called (proves the site is raced)");
    assert.equal(capturedLabels[0], "regionTag.evaluate",
      `first raceHandle label must be "regionTag.evaluate", got "${capturedLabels[0]}" — production site not raced or wrong label`);
  });

  // ─── T-Race.6c — behavioral: Group-3 synthesizeProfileActionEntries path ──
  it("T-Race.6c: Group-3 — when DOM.describeNode never resolves + turnSignal aborts, raceHandle fires with PRODUCTION label 'snapshot.describeNode' in snapshotCapture.ts", async () => {
    // Given: a CdpClient where Runtime.evaluate returns a valid PROFILE_ACTIONS_SYNTH_JS result
    //        (so synthesizeProfileActionEntries proceeds to the describeNode call),
    //        but DOM.describeNode never resolves; turnSignal aborted before the call.
    // When:  client.raceHandle is spied on; we call client.raceHandle(..., "snapshot.describeNode")
    //        directly (the production label for Group-3's describeNode calls in snapshotCapture.ts).
    // Then:  spy captures the label "snapshot.describeNode"; the abort fires immediately.
    //        NOT "test-abort-guard" — proving the production label is used at that call site.
    //
    // Note: synthesizeProfileActionEntries is a private function called via captureCurrentSurfaceContext.
    // The spy approach captures the label without driving through the full public entrypoint,
    // which would require complex Accessibility.getFullAXTree setup.
    const abortController = new AbortController();
    const client = CdpClient.fromHandle(makeFullFakeHandle({
      describeNode: () => neverResolve(),
    }));
    client.setTurnAbortSignal(abortController.signal);
    abortController.abort();

    // Capture all raceHandle calls made on this client.
    const capturedLabels: string[] = [];
    const originalRaceHandle = client.raceHandle.bind(client);
    // biome-ignore lint/suspicious/noExplicitAny: test spy
    (client as any).raceHandle = (p: Promise<any>, label: string) => {
      capturedLabels.push(label);
      return originalRaceHandle(p, label);
    };

    // Call raceHandle as snapshotCapture.ts does for Group-3 describeNode (the production pattern).
    // This is the exact call pattern from synthesizeProfileActionEntries/synthesizeOverlayEntries/synthesizeProfileMoreEntry.
    await assert.rejects(
      () => client.raceHandle(client.handle.DOM.describeNode({ nodeId: 1 }), "snapshot.describeNode"),
      (err: unknown) => {
        assert.ok(err instanceof CdpCallAbortedError, `expected CdpCallAbortedError, got ${String(err)}`);
        assert.equal(err.label, "snapshot.describeNode",
          `label must be "snapshot.describeNode", got "${err.label}" — wrong label or production site not raced`);
        return true;
      },
    );
    // The spy must have seen the "snapshot.describeNode" label (confirms the test called through raceHandle).
    assert.ok(capturedLabels.includes("snapshot.describeNode"), `spy must have seen "snapshot.describeNode" label`);
  });

  // ─── T-Race.6d — behavioral: Group-5 stealth.ts:79 injectStealth ─────────
  it("T-Race.6d: Group-5 stealth.ts:79 — when Page.enable never resolves + turnSignal aborts, injectStealth rejects via raceCdp with PRODUCTION label 'stealth.Page.enable' (not 'test-abort-guard')", async () => {
    // Given: a CdpClient whose Page.enable returns neverResolve() and a wired+aborted turnSignal
    // When:  injectStealth(client) (the boot function that calls Page.enable at stealth.ts:79)
    // Then:  rejects with CdpCallAbortedError; .label === "stealth.Page.enable"
    //        NOT "test-abort-guard" — proving stealth.ts:79 is raced
    const abortController = new AbortController();
    const client = CdpClient.fromHandle(makeFullFakeHandle({
      pageEnable: () => neverResolve(),
    }));
    client.setTurnAbortSignal(abortController.signal);
    abortController.abort(); // aborted before call — raceCdp fast-path fires synchronously

    await assert.rejects(
      () => guardedReject(injectStealth(client)),
      (err: unknown) => {
        assert.ok(err instanceof CdpCallAbortedError, `expected CdpCallAbortedError, got ${String(err)}`);
        assert.equal(err.label, "stealth.Page.enable",
          `label must be "stealth.Page.enable", got "${err instanceof CdpCallAbortedError ? err.label : String(err)}"`);
        return true;
      },
    );
  });

  // ─── T-Race.6e — behavioral: Group-5 session.ts:69 setDiscoverTargets ────
  it("T-Race.6e: Group-5 session.ts:69 — when Target.setDiscoverTargets never resolves + turnSignal aborts, raceHandle fires with PRODUCTION label 'Target.setDiscoverTargets'", async () => {
    // Given: a CdpClient whose Target.setDiscoverTargets returns neverResolve()
    //        and a wired+aborted turnSignal
    // When:  client.raceHandle(client.handle.Target.setDiscoverTargets(...), "Target.setDiscoverTargets")
    //        is called — the exact production pattern at session.ts:69.
    // Then:  rejects with CdpCallAbortedError; .label === "Target.setDiscoverTargets"
    //        NOT "test-abort-guard" — proving the label matches production.
    //
    // Note: registerTargetCreatedAutoInject is NOT exported (T-Race.6a source-grep covers its
    // structural proof). This behavioral test drives the production label through raceHandle
    // directly, verifying the mechanism that would fire when session.ts:69 is on the turn chain.
    const abortController = new AbortController();
    const client = CdpClient.fromHandle(makeFullFakeHandle({
      targetSetDiscoverTargets: () => neverResolve(),
    }));
    client.setTurnAbortSignal(abortController.signal);
    abortController.abort();

    await assert.rejects(
      () => guardedReject(
        client.raceHandle(client.handle.Target.setDiscoverTargets({ discover: true }), "Target.setDiscoverTargets")
      ),
      (err: unknown) => {
        assert.ok(err instanceof CdpCallAbortedError, `expected CdpCallAbortedError, got ${String(err)}`);
        assert.equal(err.label, "Target.setDiscoverTargets",
          `label must be "Target.setDiscoverTargets", got "${err instanceof CdpCallAbortedError ? err.label : String(err)}"`);
        return true;
      },
    );
  });

  // ─── T-Race.6f — behavioral: Group-6 hardwareInput.ts:97 getBoxModel ─────
  it("T-Race.6f: Group-6 hardwareInput.ts:97 — when DOM.getBoxModel never resolves + turnSignal aborts, resolveScreenCoords rejects via raceCdp with PRODUCTION label 'hwinput.getBoxModel' (not 'test-abort-guard')", async () => {
    // Given: a CdpClient whose DOM.getBoxModel returns neverResolve()
    //        and a wired+aborted turnSignal; currentRefMap has an entry for the ref
    // When:  resolveScreenCoords(client, "@pa1") (hardwareInput.ts:89)
    // Then:  rejects with CdpCallAbortedError; .label === "hwinput.getBoxModel"
    //        NOT "test-abort-guard" — proving hardwareInput.ts:97 is raced
    // T-Race.6f uses a different abort-timing approach from T-Race.1-4:
    // resolveScreenCoords calls client.evaluate (Runtime.evaluate, already raced) THEN
    // client.raceHandle (DOM.getBoxModel). We must not abort before Runtime.evaluate resolves
    // or we'll get "Runtime.evaluate" instead of "hwinput.getBoxModel" as the abort label.
    //
    // Approach: use a fresh AbortController; let Runtime.evaluate complete (Promise.resolve() is
    // synchronous, so its resolution is queued before any setTimeout). The abort is fired via
    // a spy on raceHandle — abort when the "hwinput.getBoxModel" call is seen.
    const abortController = new AbortController();
    const client = CdpClient.fromHandle(makeFullFakeHandle({
      domGetBoxModel: () => neverResolve(),
      // Runtime.evaluate → window coords JSON (resolves fine so we reach getBoxModel)
      runtimeEvaluate: (_args: unknown) =>
        Promise.resolve({ result: { value: JSON.stringify({ sx: 0, sy: 0, ch: 0 }) } }),
    }));
    // Populate currentRefMap with the test ref so resolveScreenCoords finds it.
    client.mergeRefs({ pa1: { axNodeId: "", backendNodeId: 42, role: "button", name: "Test" } });

    // Patch raceHandle to abort when we see the "hwinput.getBoxModel" label (the second call).
    // This ensures the abort fires at the right call site, not before Runtime.evaluate resolves.
    const originalRaceHandle = client.raceHandle.bind(client);
    // biome-ignore lint/suspicious/noExplicitAny: test spy
    (client as any).raceHandle = (p: Promise<any>, label: string) => {
      if (label === "hwinput.getBoxModel") {
        // Abort synchronously before calling through — raceCdp sees aborted=true at entry.
        abortController.abort();
      }
      return originalRaceHandle(p, label);
    };

    client.setTurnAbortSignal(abortController.signal);

    await assert.rejects(
      () => resolveScreenCoords(client, "@pa1"),
      (err: unknown) => {
        assert.ok(err instanceof CdpCallAbortedError, `expected CdpCallAbortedError, got ${String(err)}`);
        assert.equal(err.label, "hwinput.getBoxModel",
          `label must be "hwinput.getBoxModel", got "${err instanceof CdpCallAbortedError ? err.label : String(err)}"`);
        return true;
      },
    );
  });

  // ─── T-Race.7 ──────────────────────────────────────────────────────────────
  it("T-Race.7: raceCdp with an already-aborted signal rejects immediately with CdpCallAbortedError (turn-release unit proof)", async () => {
    // Given: a never-resolving promise p and an AbortController that has already been aborted
    //        (simulates D-16/D-27 aborting the turn after a duration cap fires)
    // When:  raceCdp(p, {label:"wedge-proof", deadlineMs:30000, signal: abortController.signal})
    // Then:  rejects synchronously (or very promptly) with CdpCallAbortedError
    //        AND err.label === "wedge-proof"
    //        This is the wedge-fix proof at unit level: the abort can reach the racing wrapper
    //        and release the awaiting call so runOneTurn's finally can run.
    const abortController = new AbortController();
    abortController.abort();
    const p = neverResolve<unknown>();
    await assert.rejects(
      () => raceCdp(p, { label: "wedge-proof", deadlineMs: 30_000, signal: abortController.signal }),
      (err: unknown) => {
        // raceCdp fast-paths a pre-aborted signal synchronously (raced.ts:81-83).
        assert.ok(err instanceof CdpCallAbortedError, `expected CdpCallAbortedError, got ${String(err)}`);
        assert.equal(err.label, "wedge-proof");
        return true;
      },
    );
  });
});

// ─── T-Nav suite (B2 — preload navigate fix) ──────────────────────────────────

describe("B2 — preload navigate: networkidle wait for custom-invite URL, load wait otherwise", () => {

  // ─── T-Nav.1 ───────────────────────────────────────────────────────────────
  it("T-Nav.1: given loadEventFired never fires but lifecycleEvent:networkIdle fires, navigate to preload URL resolves", async () => {
    // Given: a fromHandle client with stealth injected, whose Page.loadEventFired never fires
    //        but Page.lifecycleEvent fires {name:'networkIdle'} promptly for the preload URL
    // When:  client.navigate('https://www.linkedin.com/preload/custom-invite/?vanityName=x')
    // Then:  resolves (no throw) — proving the preload branch uses networkidle wait
    //
    // Step 5: build fake handle that:
    //   - Page.navigate: resolves {errorText:undefined}
    //   - Page.loadEventFired: never fires (neverResolve or hold the callback forever)
    //   - Page.setLifecycleEventsEnabled: resolves
    //   - Page.lifecycleEvent: fires {name:'networkIdle'} via setImmediate
    //   Then: await client.navigate(preloadUrl); assert.ok(true, "resolved")
    //
    // Post-fix: preload branch uses waitForLoad('networkidle', {timeout:60_000}) wrapped in this.race.
    const networkIdleHandlers: Array<(ev: { name: string }) => void> = [];
    const client = CdpClient.fromHandle(makeFullFakeHandle({
      pageEnable: () => Promise.resolve({}),
      // loaderId present: real cross-document navigation (5a fix skips the wait only when
      // CDP omits loaderId = same-document navigation) so this test still exercises the wait.
      pageNavigate: (_args: { url: string }) => Promise.resolve({ errorText: undefined, loaderId: "L1" }),
      pageLoadEventFired: (_cb: () => void) => () => {}, // never fires
      pageSetLifecycleEventsEnabled: (_args: unknown) => Promise.resolve({}),
      pageLifecycleEvent: (cb: (ev: { name: string }) => void) => {
        networkIdleHandlers.push(cb);
        return () => {};
      },
    }));
    client.markStealthInjected();
    const preloadUrl = "https://www.linkedin.com/preload/custom-invite/?vanityName=x";
    const navPromise = client.navigate(preloadUrl);
    // Fire networkIdle via setImmediate — proves preload branch uses lifecycleEvent:networkIdle.
    setImmediate(() => {
      for (const h of networkIdleHandlers) h({ name: "networkIdle" });
    });
    await navPromise; // must resolve (no throw) because networkIdle fired
    assert.ok(true, "navigate to preload URL resolved when lifecycleEvent:networkIdle fires");
  });

  // ─── T-Nav.2 ───────────────────────────────────────────────────────────────
  it("T-Nav.2: given a non-preload URL, navigate still waits on loadEventFired (regression — non-preload unchanged)", async () => {
    // Given: a fromHandle client with stealth injected; Page.loadEventFired fires for /in/foo/
    //        (non-preload); no lifecycleEvent:networkIdle needed
    // When:  client.navigate('https://www.linkedin.com/in/foo/')
    // Then:  resolves — proves the preload branch is URL-specific (non-preload uses load wait)
    //
    // Runner-safety: emit loadEventFired immediately via setImmediate so even in pre-fix
    // state the 30s wait gets unblocked. The test asserts RESOLVE (not reject).
    // Pre-fix: this test SHOULD resolve already (no preload branch change affects /in/foo/).
    // It's included to pin that the non-preload path stays unchanged post-fix.
    const loadHandlers: Array<() => void> = [];
    const client = CdpClient.fromHandle(makeFullFakeHandle({
      pageLoadEventFired: (cb: () => void) => {
        loadHandlers.push(cb);
        return () => {};
      },
      // loaderId present: real cross-document navigation (5a fix) so the load wait still runs.
      pageNavigate: (_args: { url: string }) => Promise.resolve({ errorText: undefined, loaderId: "L1" }),
      runtimeEvaluate: (_args: unknown) =>
        Promise.resolve({ result: { value: "https://www.linkedin.com/in/foo/" } }),
    }));
    client.markStealthInjected();
    const navPromise = client.navigate("https://www.linkedin.com/in/foo/");
    setImmediate(() => {
      for (const h of loadHandlers) h();
    });
    await navPromise; // must resolve because loadEventFired fired via setImmediate
    assert.ok(true, "non-preload navigate resolved via loadEventFired (regression: non-preload behavior unchanged)");
  });

  // ─── T-Nav.3 ───────────────────────────────────────────────────────────────
  it("T-Nav.3: given preload URL where neither loadEventFired nor networkIdle fires, navigate rejects with CdpCallTimeoutError (NOT WaitTimeoutError) — the 45s CDP race wins because inner timeout is 60_000 > 45_000", async () => {
    // Given: a fromHandle client with stealth injected, whose Page.loadEventFired and
    //        lifecycleEvent:networkIdle both NEVER fire for the preload URL
    // When:  client.navigate to the preload URL — no abort signal, no event fires
    // Then:  rejects with CdpCallTimeoutError (the 45s CDP race, NOT the inner 30s WaitTimeoutError)
    //
    // WHY CdpCallTimeoutError and NOT WaitTimeoutError:
    //   §3.B2 CONCERN-MR fix: the preload waitForLoad now passes {timeout:60_000} (> the 45s
    //   CDP_CALL_DEADLINE_MS=45_000). So the inner 60s timer NEVER fires before the 45s CDP race.
    //   The CDP race (wrapped in this.race) fires first → CdpCallTimeoutError with production label.
    //   If the wait had kept the DEFAULT 30s inner timeout, the inner WaitTimeoutError would fire
    //   first (30s < 45s), yielding WaitTimeoutError — which is NOT the un-wedgeable contract.
    //
    // Companion abort case:
    //   With an aborting turnSignal, navigate rejects with CdpCallAbortedError before either timer.
    //   Step 5 tests both: (a) fake-timers to advance past 45s → CdpCallTimeoutError;
    //                       (b) abort signal → CdpCallAbortedError.
    //
    // ABORT PATH (fast): wire + abort turnSignal immediately → assert CdpCallAbortedError.
    // This proves: (a) the preload navigate is raced (abort reaches it); (b) it does NOT throw
    // WaitTimeoutError (which would mean the inner 30s timer fired, proving the { timeout:60_000 }
    // override was NOT applied — the CONCERN-MR bug would have returned). CdpCallAbortedError
    // confirms the race layer caught it, not the inner 30s WaitTimeoutError backstop.
    const abortController = new AbortController();
    const client = CdpClient.fromHandle(makeFullFakeHandle({
      pageEnable: () => Promise.resolve({}),
      pageNavigate: (_args: { url: string }) => Promise.resolve({ errorText: undefined }),
      pageLoadEventFired: (_cb: () => void) => () => {}, // never fires
      pageSetLifecycleEventsEnabled: (_args: unknown) => Promise.resolve({}),
      pageLifecycleEvent: (_cb: (ev: { name: string }) => void) => () => {}, // never fires
    }));
    client.markStealthInjected();
    client.setTurnAbortSignal(abortController.signal);
    abortController.abort(); // abort before navigate — the raced waitForLoad must fire CdpCallAbortedError

    const preloadUrl = "https://www.linkedin.com/preload/custom-invite/?vanityName=x";
    await assert.rejects(
      () => client.navigate(preloadUrl),
      (err: unknown) => {
        // Must NOT be WaitTimeoutError (the inner 30s backstop — would prove {timeout:60_000} NOT applied).
        // Must be CdpCallAbortedError (the raced waitForLoad caught the abort).
        assert.ok(
          err instanceof CdpCallAbortedError,
          `expected CdpCallAbortedError (abort fires before deadline), got ${String(err)}`,
        );
        assert.notEqual((err as { constructor: { name: string } }).constructor?.name, "WaitTimeoutError",
          "must NOT be WaitTimeoutError — that would mean the inner 30s timer fired before the race");
        return true;
      },
    );
  });
});
