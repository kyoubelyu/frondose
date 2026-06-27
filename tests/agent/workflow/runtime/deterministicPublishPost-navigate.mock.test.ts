/**
 * P-POST-PUBLISH-11 Step 5 — T-Nav mock tests (validator, Sonnet)
 * Tests for the P11 navigate-on-fail block: when surfaceLooksComposerCapable returns
 * false on the first check, the runtime calls deps.client.navigate(FEED_URL), settles,
 * then re-checks before deciding whether to proceed or fail.
 *
 * Behaviors covered (plan §5, SC-1..SC-5):
 *   T-Nav.1 — (SC-1, CONCERN-MR) full F-B end-to-end: surface false → navigate → surface true
 *              → fresh/closed composer → P9 open+type path → published:true, fastPath:false
 *   T-Nav.2 — (SC-2) surface capable on first check → navigate NOT called (fast-path preserved)
 *   T-Nav.3 — (SC-3) surface false → navigate → still false → surface_not_composer_capable
 *   T-Nav.4 — (SC-4) navigate throws → caught → re-check → surface_not_composer_capable (no crash)
 *   T-Nav.5 — (SC-5) on all fail paths, dispatchHumanLikeClickAtCoords count=0;
 *              source-grep: dispatchAttempted = true appears exactly once
 *
 * Harness: extends the P10 fake CdpClient idiom with a navigate spy + multi-entry
 * surfaceCheckQueue (two TRIGGER_JS calls: first for the initial check, second for
 * the post-navigate re-check). Uses the same seedDraft / makePublishDeps pattern.
 *
 * Runner:
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/workflow/runtime/deterministicPublishPost-navigate.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CdpClient } from "../../../../src/cdp/client.js";

// Disable inter-tool pacing.
process.env.FRONDOSE_PACE_MIN_MS = "0";

// ---------------------------------------------------------------------------
// Root path (for source-introspection T-Nav.5)
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, "../../../..");
const PUBLISH_SRC = readFileSync(
  resolve(ROOT, "src/agent/workflow/runtime/deterministicPublishPost.ts"),
  "utf-8",
);
const FEED_URL = "https://www.linkedin.com/feed/";

// ---------------------------------------------------------------------------
// Payload-constant loader (same pattern as P9/P10 tests)
// ---------------------------------------------------------------------------

const SENTINEL_PROBE = "__P11NAV_SENTINEL_PROBE__";
const SENTINEL_FOCUS = "__P11NAV_SENTINEL_FOCUS__";
const SENTINEL_CLEAR = "__P11NAV_SENTINEL_CLEAR__";
const SENTINEL_ENABLED = "__P11NAV_SENTINEL_ENABLED__";
const SENTINEL_CENTER = "__P11NAV_SENTINEL_POST_CENTER__";
const SENTINEL_TRIGGER = "__P11NAV_SENTINEL_TRIGGER__";
const SENTINEL_CLOSE_CENTER = "__P11NAV_SENTINEL_CLOSE_CENTER__";
const SENTINEL_DISCARD_CENTER = "__P11NAV_SENTINEL_DISCARD_CENTER__";

interface PayloadConstants {
  PROBE_JS: string;
  FOCUS_JS: string;
  CLEAR_JS: string;
  ENABLED_JS: string;
  CENTER_JS: string;
  TRIGGER_JS: string;
  CLOSE_CENTER_JS: string;
  DISCARD_CENTER_JS: string;
}

async function loadPayloadConstants(): Promise<PayloadConstants> {
  try {
    const mod = (await import(
      "../../../../src/linkedin/composerReadiness.js"
    )) as Record<string, unknown>;
    return {
      PROBE_JS:
        (mod["FEED_COMPOSER_LIVE_IN_DOM_JS"] as string | undefined) ??
        SENTINEL_PROBE,
      FOCUS_JS:
        (mod["FEED_COMPOSER_FOCUS_JS"] as string | undefined) ??
        (mod["FEED_COMPOSER_FOCUS_EDITOR_JS"] as string | undefined) ??
        SENTINEL_FOCUS,
      CLEAR_JS:
        (mod["FEED_COMPOSER_CLEAR_JS"] as string | undefined) ??
        SENTINEL_CLEAR,
      ENABLED_JS:
        (mod["FEED_COMPOSER_POST_ENABLED_JS"] as string | undefined) ??
        SENTINEL_ENABLED,
      CENTER_JS:
        (mod["FEED_COMPOSER_POST_CENTER_JS"] as string | undefined) ??
        SENTINEL_CENTER,
      TRIGGER_JS:
        (mod["FEED_START_A_POST_CENTER_JS"] as string | undefined) ??
        SENTINEL_TRIGGER,
      CLOSE_CENTER_JS:
        (mod["FEED_COMPOSER_CLOSE_CENTER_JS"] as string | undefined) ??
        SENTINEL_CLOSE_CENTER,
      DISCARD_CENTER_JS:
        (mod["FEED_COMPOSER_DISCARD_CENTER_JS"] as string | undefined) ??
        SENTINEL_DISCARD_CENTER,
    };
  } catch {
    return {
      PROBE_JS: SENTINEL_PROBE,
      FOCUS_JS: SENTINEL_FOCUS,
      CLEAR_JS: SENTINEL_CLEAR,
      ENABLED_JS: SENTINEL_ENABLED,
      CENTER_JS: SENTINEL_CENTER,
      TRIGGER_JS: SENTINEL_TRIGGER,
      CLOSE_CENTER_JS: SENTINEL_CLOSE_CENTER,
      DISCARD_CENTER_JS: SENTINEL_DISCARD_CENTER,
    };
  }
}

// ---------------------------------------------------------------------------
// Navigate-aware fake CdpClient harness
//
// Key design: TRIGGER_JS routes through a single `triggerCallQueue` — all calls
// in sequence (surface check 1, surface check 2, triggerStartAPostLive) pull
// from the same FIFO. This gives precise control without the "surfaceCheckConsumed"
// one-shot limit of the P10 harness, allowing tests to script exact behavior at
// each surface check without depending on internal fake routing state.
//
// Call counters tracked:
//   navigateCallCount  — counts client.navigate() calls
//   navigateUrlLog     — captures URL passed to navigate()
//   probeCallCount     — counts PROBE_JS (FEED_COMPOSER_LIVE_IN_DOM_JS) evaluates
//   triggerCallCount   — counts ALL TRIGGER_JS evaluates (surface checks + open calls)
//   surfaceCheckCount  — not tracked separately; use triggerCallCount split knowledge
//   insertTextLog      — captures per-char insertText calls
//   dispatchClickLog   — captures dispatchHumanLikeClickAtCoords calls
//   focusCallCount     — counts FOCUS_JS evaluates
//   clearCallCount     — counts CLEAR_JS evaluates
//   closeCallCount     — counts CLOSE_CENTER_JS evaluates
// ---------------------------------------------------------------------------

interface NavFakeClientOpts {
  constants: PayloadConstants;
  // ALL TRIGGER_JS calls (surface checks + triggerStartAPostLive) pull from this queue in order.
  triggerCallQueue: Array<{ cx: number; cy: number } | null>;
  // PROBE_JS (FEED_COMPOSER_LIVE_IN_DOM_JS) FIFO — all probeFeedComposerLive calls.
  probeQueue: Array<{ present: boolean; editorText: string }>;
  // CLOSE_CENTER_JS results.
  closeCenterQueue: Array<{ cx: number; cy: number } | null>;
  // DISCARD_CENTER_JS results.
  discardCenterQueue: Array<{ cx: number; cy: number } | null>;
  // FOCUS_JS result (boolean, constant).
  focusResult: boolean;
  // CLEAR_JS result (boolean, constant).
  clearResult: boolean;
  // ENABLED_JS: FIFO queue.
  enabledQueue: boolean[];
  // POST_CENTER_JS result.
  postCenterResult: { cx: number; cy: number } | null;
  // navigate behavior: if true, fake navigate() throws.
  navigateShouldThrow?: boolean;
  // P12: AX tree queue — successive getFullAXTree calls draw from this FIFO.
  // Used by resolveByLabelWithRetry for open stage ("Start a post") and Post stage ("Post").
  axTreeQueue?: Array<Array<{ nodeId: number; role?: { value?: string }; name?: { value?: string }; ignored?: boolean; backendDOMNodeId?: number }>>;
  // P12: clickAt spy log (mutated by the fake).
  clickAtLog?: string[];
  // Spy logs (mutated by the fake):
  navigateCallCount: { n: number };
  navigateUrlLog: string[];
  probeCallCount: { n: number };
  triggerCallCount: { n: number };
  insertTextLog: Array<{ text: string }>;
  dispatchClickLog: Array<{ x: number; y: number }>;
  focusCallCount: { n: number };
  clearCallCount: { n: number };
  closeCallCount: { n: number };
  pressKeyLog: string[];
}

// P12: AX node factory for getFullAXTree queue entries.
function makeAXNode(
  nodeId: number,
  role: string,
  name: string,
  backendDOMNodeId?: number,
): { nodeId: number; role?: { value?: string }; name?: { value?: string }; ignored?: boolean; backendDOMNodeId?: number } {
  return {
    nodeId,
    role: { value: role },
    name: { value: name },
    ignored: false,
    backendDOMNodeId: backendDOMNodeId ?? nodeId + 3000,
  };
}

function peekOrLast<T>(queue: T[]): T | undefined {
  if (queue.length === 0) return undefined;
  return queue.length === 1 ? queue[0] : queue.shift();
}

function makeNavFakeClient(opts: NavFakeClientOpts): CdpClient {
  const { constants: c } = opts;
  let enabledIdx = 0;
  let axTreeIdx = 0;

  const fakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => {
        const queue = opts.axTreeQueue;
        if (!queue || queue.length === 0) return { nodes: [] };
        const entry = axTreeIdx < queue.length ? queue[axTreeIdx++] : queue[queue.length - 1];
        return { nodes: entry };
      },
    },
    Runtime: {
      evaluate: async (args: { expression: string }) => {
        const expr = args.expression;

        // CLOSE_CENTER_JS
        if (expr === c.CLOSE_CENTER_JS) {
          opts.closeCallCount.n++;
          const raw = peekOrLast(opts.closeCenterQueue) ?? null;
          return { result: { value: JSON.stringify(raw) } };
        }
        // DISCARD_CENTER_JS
        if (expr === c.DISCARD_CENTER_JS) {
          const raw = peekOrLast(opts.discardCenterQueue) ?? null;
          return { result: { value: JSON.stringify(raw) } };
        }
        // POST_CENTER_JS
        if (expr === c.CENTER_JS) {
          return { result: { value: JSON.stringify(opts.postCenterResult) } };
        }
        // TRIGGER_JS — ALL calls pull from triggerCallQueue in order.
        // This includes: first surface check, second surface check (post-navigate),
        // and triggerStartAPostLive calls (which click the returned center).
        if (expr === c.TRIGGER_JS) {
          opts.triggerCallCount.n++;
          const raw = peekOrLast(opts.triggerCallQueue) ?? null;
          return { result: { value: JSON.stringify(raw) } };
        }
        // ENABLED_JS
        if (expr === c.ENABLED_JS) {
          const res =
            enabledIdx < opts.enabledQueue.length
              ? opts.enabledQueue[enabledIdx++]
              : false;
          return { result: { value: res } };
        }
        // PROBE_JS (FEED_COMPOSER_LIVE_IN_DOM_JS)
        if (expr === c.PROBE_JS) {
          opts.probeCallCount.n++;
          const res = peekOrLast(opts.probeQueue) ?? {
            present: false,
            editorText: "",
          };
          return { result: { value: JSON.stringify(res) } };
        }
        // FOCUS_JS
        if (expr === c.FOCUS_JS) {
          opts.focusCallCount.n++;
          return { result: { value: opts.focusResult } };
        }
        // CLEAR_JS
        if (expr === c.CLEAR_JS) {
          opts.clearCallCount.n++;
          return { result: { value: opts.clearResult } };
        }

        // Fallback sentinel routing (for when real JS constants are unavailable)
        if (expr.includes("CLOSE_RE") || expr.includes("FEED_COMPOSER_CLOSE")) {
          opts.closeCallCount.n++;
          return { result: { value: JSON.stringify(null) } };
        }
        if (expr.includes("DISCARD_RE") || expr.includes("FEED_COMPOSER_DISCARD")) {
          return { result: { value: JSON.stringify(null) } };
        }
        if (
          expr.includes("Start a post") ||
          expr.includes("START_RE") ||
          expr.includes("start|create")
        ) {
          opts.triggerCallCount.n++;
          const raw = peekOrLast(opts.triggerCallQueue) ?? null;
          return { result: { value: JSON.stringify(raw) } };
        }
        if (
          expr.includes("button.disabled") ||
          // POST_RE guard: POST_COMPOSER_SYNTH_JS also contains "POST_RE" as a JS variable name.
          // Must NOT match it for the ENABLED handler. Guard with data-frondose-pc absence.
          (expr.includes("POST_RE") && !expr.includes("data-frondose-pc")) ||
          expr.includes("post_button")
        ) {
          const res =
            enabledIdx < opts.enabledQueue.length
              ? opts.enabledQueue[enabledIdx++]
              : false;
          return { result: { value: res } };
        }
        if (
          expr.includes("el.focus()") ||
          expr.includes("activeElement") ||
          expr.includes("FOCUS")
        ) {
          opts.focusCallCount.n++;
          return { result: { value: opts.focusResult } };
        }
        if (
          expr.includes("deleteContentBackward") ||
          expr.includes("selectAll") ||
          expr.includes("CLEAR")
        ) {
          opts.clearCallCount.n++;
          return { result: { value: opts.clearResult } };
        }
        // P12: captureCurrentSurfaceContext evaluate calls — needed by resolveByLabelWithRetry.
        // REGION_TAG_JS (data-frondose-rg-aside) → empty JSON.
        if (expr.includes("data-frondose-rg-aside") || expr.includes("frondose-rg")) {
          return { result: { value: "{}" } };
        }
        // window.location.href → feed URL so inferSurface returns "feed".
        if (expr === "window.location.href") {
          return { result: { value: "https://www.linkedin.com/feed/" } };
        }
        // OVERLAY_SYNTH_JS — return a dummy item so items.length>0, preventing the 350ms retry sleep.
        if (
          (expr.includes("menuitem") || expr.includes('role="dialog"')) &&
          expr.includes("const vis = (el)")
        ) {
          return { result: { value: JSON.stringify([{ i: 999, role: "button", label: "fake-overlay" }]) } };
        }
        // FEED_POST_SYNTH_JS → empty.
        if (expr.includes("repost") || expr.includes("SIGNALS")) {
          return { result: { value: JSON.stringify([]) } };
        }
        // POST_COMPOSER_SYNTH_JS — contains "data-frondose-pc".
        // Return [] (shadow-DOM sim: zero @pc* entries on real shadow-rooted LinkedIn composers).
        // Post resolver uses the native-AX @e ref from axTreeQueue instead.
        // Prevents native+synth ambiguity after the filterEntriesByScope removal (P12 fix).
        if (expr.includes("data-frondose-pc") && !expr.includes("forEach")) {
          return { result: { value: JSON.stringify([]) } };
        }
        // Cleanup forEach calls (data-frondose-* attribute removal) → undefined/null.
        if (expr.includes("forEach") && expr.includes("removeAttribute")) {
          return { result: { value: undefined } };
        }
        // Other data-frondose-ov/pa/pm/ph synthesize calls → empty.
        if (expr.includes("data-frondose-")) {
          return { result: { value: JSON.stringify([]) } };
        }
        // Default: treat as probe
        opts.probeCallCount.n++;
        const res = peekOrLast(opts.probeQueue) ?? {
          present: false,
          editorText: "",
        };
        return { result: { value: JSON.stringify(res) } };
      },
    },
    DOM: {
      getDocument: async () => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (args: { selector?: string }) => {
        const sel = args?.selector ?? "";
        // P12: POST_COMPOSER_SYNTH_JS queries for [data-frondose-pc="N"] selectors.
        // Return [] — no synth node (shadow-DOM sim; POST_COMPOSER_SYNTH_JS returns []).
        if (sel.includes("data-frondose-pc")) return { nodeIds: [] };
        return { nodeIds: [] };
      },
      describeNode: async (args: { backendNodeId?: number; nodeId?: number }) => ({
        node: {
          nodeId: ((args.backendNodeId ?? args.nodeId ?? 0)) + 1000,
          backendNodeId: args.backendNodeId ?? args.nodeId ?? 0,
          localName: "button",
          nodeName: "BUTTON",
          nodeType: 1,
        },
      }),
      scrollIntoViewIfNeeded: async () => {},
      getBoxModel: async () => ({
        model: { border: [0, 0, 10, 0, 10, 0, 10, 10] },
      }),
    },
    Input: {
      dispatchMouseEvent: async (_args: unknown) => {},
      dispatchKeyEvent: async (_args: unknown) => {},
      insertText: async (args: { text: string }) => {
        opts.insertTextLog.push({ text: args.text });
      },
      synthesizeScrollGesture: async () => {},
    },
    Browser: { close: async () => {} },
    Page: {
      enable: async () => {},
      navigate: async () => ({}), // raw Page.navigate (not the raced CdpClient wrapper)
      loadEventFired: (cb: (p: unknown) => void) => {
        setTimeout(() => cb({ timestamp: 0 }), 0);
        return () => {};
      },
      frameNavigated: (cb: (p: unknown) => void) => {
        setTimeout(() => cb({ frame: { url: "" } }), 0);
        return () => {};
      },
      lifecycleEvent: (cb: (p: unknown) => void) => {
        setTimeout(() => cb({ name: "networkIdle" }), 0);
        return () => {};
      },
      setLifecycleEventsEnabled: async () => {},
      getLayoutMetrics: async () => ({
        visualViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: 1440,
          clientHeight: 900,
        },
        cssVisualViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: 1440,
          clientHeight: 900,
        },
        cssLayoutViewport: { clientWidth: 1440, clientHeight: 900 },
      }),
      reload: async () => {},
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);

  // Override pressKey spy.
  const origPressKey = client.pressKey.bind(client);
  client.pressKey = async (key: string) => {
    opts.pressKeyLog.push(key);
    return origPressKey(key);
  };

  // Override dispatchHumanLikeClickAtCoords spy.
  const origDispatch = client.dispatchHumanLikeClickAtCoords.bind(client);
  client.dispatchHumanLikeClickAtCoords = async (x: number, y: number) => {
    opts.dispatchClickLog.push({ x, y });
    return origDispatch(x, y);
  };

  // Override client.navigate — replaces the real CdpClient.navigate (requires stealthInjected)
  // with a controllable spy that counts calls, records URLs, and optionally throws.
  client.navigate = async (url: string) => {
    if (opts.navigateShouldThrow) {
      throw new Error("fake-navigate-error: stealth not injected / nav error");
    }
    opts.navigateCallCount.n++;
    opts.navigateUrlLog.push(url);
  };

  // P12: override clickAt spy — records every ref passed to clickAt.
  const origClickAt = client.clickAt.bind(client);
  client.clickAt = async (ref: string) => {
    if (opts.clickAtLog) opts.clickAtLog.push(ref);
    return origClickAt(ref);
  };

  return client;
}

// ---------------------------------------------------------------------------
// Draft seeding helper (mirrors P9/P10 pattern)
// ---------------------------------------------------------------------------

interface ScratchSetup {
  scratchDir: string;
  auditPath: string;
  dbPath: string;
  draftId: string;
}

async function seedDraft(label: string, text: string): Promise<ScratchSetup> {
  const scratchDir = join(
    tmpdir(),
    `frondose-p11-nav-${label}`,
    `${Date.now()}`,
  );
  mkdirSync(scratchDir, { recursive: true });
  const auditPath = join(scratchDir, "audit.jsonl");
  const dbPath = join(scratchDir, "sales.db");

  try {
    const dbMod = (await import(
      "../../../../src/tools/sales/_dbHandle.js"
    )) as Record<string, unknown>;
    const getSalesDb = dbMod["getSalesDb"] as
      | ((p: string) => unknown)
      | undefined;
    const draftsMod = (await import(
      "../../../../src/persistence/sales/drafts.js"
    )) as Record<string, unknown>;
    const insertDraft = draftsMod["insertDraft"] as
      | ((
          db: unknown,
          input: { leadId: null; kind: string; text: string; createdBy: string },
        ) => string)
      | undefined;
    if (typeof getSalesDb === "function" && typeof insertDraft === "function") {
      const db = getSalesDb(dbPath);
      const draftId = insertDraft(db, {
        leadId: null,
        kind: "post",
        text,
        createdBy: "llm",
      });
      return { scratchDir, auditPath, dbPath, draftId };
    }
  } catch {
    // helpers unavailable; test will hit assert.fail
  }
  return { scratchDir, auditPath, dbPath, draftId: "d-seed-unavailable" };
}

// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------

function makePublishDeps(
  client: CdpClient,
  setup: ScratchSetup,
  mode: "manual" | "auto" = "manual",
): Record<string, unknown> {
  return {
    session: {
      inputMode: "cdp" as const,
      getOrInitClient: () => Promise.resolve(client),
      getClient: () => client,
      setLastContext: () => {},
      getLastContext: () => undefined,
      resolvedMode: () => mode,
    },
    client,
    salesDbPath: setup.dbPath,
    auditPath: setup.auditPath,
    workflowDeps: {
      emitFrame: () => {},
      writeWorkflowAudit: () => {},
    },
    workflowId: "wf-p11-nav",
    stepId: "step-p11-nav",
    draftId: setup.draftId,
  };
}

// ---------------------------------------------------------------------------
// publishApprovedFeedPost dynamic import helper
// ---------------------------------------------------------------------------

type PublishResult = {
  published: boolean;
  reason?: string;
  fallbackAllowed: boolean;
  dispatchAttempted: boolean;
  draftMarkedSent?: boolean;
  accountingError?: string;
};

async function importPublishFn(): Promise<
  ((deps: unknown) => Promise<PublishResult>) | undefined
> {
  try {
    const mod = (await import(
      "../../../../src/agent/workflow/runtime/deterministicPublishPost.js"
    )) as Record<string, unknown>;
    return mod["publishApprovedFeedPost"] as
      | ((deps: unknown) => Promise<PublishResult>)
      | undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Spy counter factory
// ---------------------------------------------------------------------------

function makeSpies() {
  return {
    navigateCallCount: { n: 0 },
    navigateUrlLog: [] as string[],
    probeCallCount: { n: 0 },
    triggerCallCount: { n: 0 },
    insertTextLog: [] as Array<{ text: string }>,
    dispatchClickLog: [] as Array<{ x: number; y: number }>,
    focusCallCount: { n: 0 },
    clearCallCount: { n: 0 },
    closeCallCount: { n: 0 },
    pressKeyLog: [] as string[],
    clickAtLog: [] as string[],
  };
}

// ===========================================================================
// T-Nav.1 — SC-1 CONCERN-MR: full F-B end-to-end proof
//   surface false → navigate → surface true → fresh/closed composer → P9 open+type
//   → published:true, fastPath:false (no agent pre-typing needed)
// ===========================================================================

describe(
  "publishApprovedFeedPost — P11 navigate: surface false → navigate → surface true → P9 open+type → published:true, fastPath:false (T-Nav.1, SC-1 F-B end-to-end)",
  () => {
    it(
      "T-Nav.1: when first surfaceLooksComposerCapable=false, navigate called once with FEED_URL, second surface check returns true; fresh/closed composer (probe.present:false, composerAlreadyValid:false) → triggerStartAPostLive used + post-open probe present + focus + insertTextHumanLike receives FULL draft.text + dispatchHumanLikeClickAtCoords fires exactly ONCE after insert → {published:true, dispatchAttempted:true, fallbackAllowed:false} with input.fastPath===false",
      { timeout: 30000 }, // insertTextHumanLike is per-char with delays; budget for realistic draft
      async () => {
        // P12 UPDATE: P12 replaced surfaceLooksComposerCapable (TRIGGER_JS-based surface check)
        //             with probe0.present as the surface indicator. The navigate block fires when
        //             probe0.present===false. After navigate (if it succeeds), the runtime
        //             re-probes (probe1) and proceeds to the open resolver (AX-based).
        //
        // Given: probe0: present=false (composer not open) → navigate(FEED_URL) called.
        //        navigate succeeds (no throw) → navigated=true.
        //        probe1 (post-navigate): present=false (composer still not open after nav).
        //        navigated=true → NOT surface_not_composer_capable.
        //        composerAlreadyValid = probe1.present && ... = false → P9 open+type path.
        //        probe1.present=false → skip close block.
        //        Open resolver (P12 AX-based): 300ms sleep → captureCurrentSurfaceContext →
        //          AX tree has "Start a post" node → resolveByLabel returns ref → clickAt(@e ref).
        //        probeOpen: present=true, editorText="" → open succeeded.
        //        Focus: true. editorText.trim()==="": clear NOT called.
        //        insertTextHumanLike: inserts draft.text per-char.
        //        Readback probe: present=true, editorText=draftText → matches.
        //        isFeedComposerPostButtonEnabled: true.
        //        Post resolver (P12 AX-based): 300ms sleep → AX tree has "Post" node →
        //          POST_COMPOSER_SYNTH_JS → [] (shadow-DOM sim) → native @e ref → clickAt(@e ref).
        //        Post-click probe: present=false → composer gone → finishSuccess.
        // When:  publishApprovedFeedPost is invoked.
        // Then:  navigateCallCount.n===1; navigateUrlLog includes FEED_URL.
        //        Open stage used AX resolver: clickAt called with a native @e ref (non-@pc).
        //        Post stage used AX resolver: clickAt called with a native @e ref.
        //        insertTextLog concatenated === draft.text (FULL text, no truncation).
        //        result.published===true; result.dispatchAttempted===true;
        //        result.fallbackAllowed===false.
        //        No close/clear calls (entry probe.present=false → skip close; empty editor → no clear).
        // Covers SC-1 (navigate-on-fail → proceeds) + CONCERN-MR F-B proof.
        const constants = await loadPayloadConstants();
        // Keep draft short enough for practical test speed, long enough to verify insertion.
        const draftText = "T-Nav.1 post-navigate publish proof — full F-B path verified";
        const setup = await seedDraft("nav1-endtoend", draftText);

        const spies = makeSpies();

        // P12: no TRIGGER_JS surface check. triggerCallQueue unused but required by opts interface.
        const triggerCallQueue: Array<{ cx: number; cy: number } | null> = [];

        // P13 probe layout: [0]=close, [1]=probe0 preNavigate, [2]=probe1 postNavigate,
        //   [3]=in-round open probe (probeAtOpen), [4]=readback, [5]=post-click.
        // P13 always runs closeUnconditionally before navigate; [0] is the close probe.
        // probeAtOpen.editorText="" → skip clear (clearResult=false is not exercised).
        const probeQueue: Array<{ present: boolean; editorText: string }> = [
          { present: false, editorText: "" },           // [0] close probe: closed (1 probe)
          { present: false, editorText: "" },           // [1] probe0 preNavigate
          { present: false, editorText: "" },           // [2] probe1 postNavigate: not open → open resolver
          { present: true,  editorText: "" },           // [3] in-round open: probeAtOpen.editorText="" → no clear
          { present: true,  editorText: draftText },    // [4] readback → matches
          { present: false, editorText: "" },           // [5] post-click → gone
        ];

        const opts: NavFakeClientOpts = {
          constants,
          triggerCallQueue,
          probeQueue,
          closeCenterQueue: [],       // closeSucceeds not controlled here; fake navigate uses pressKeyLog
          discardCenterQueue: [null],
          focusResult: true,
          clearResult: false,         // clear not called (empty editor after open)
          enabledQueue: [true],
          postCenterResult: null,     // P12: Post uses AX resolver, not CENTER_JS
          navigateShouldThrow: false,
          // P12: AX tree queue for open resolver + Post resolver.
          axTreeQueue: [
            [makeAXNode(101, "button", "Start a post", 9001)], // open resolver
            [makeAXNode(20, "button", "Post", 201)],           // Post resolver
          ],
          ...spies,
        };
        const client = makeNavFakeClient(opts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail("T-Nav.1: publishApprovedFeedPost not exported");
        }
        const result = await fn(deps);

        // --- Navigate assertions ---
        assert.equal(spies.navigateCallCount.n, 1,
          `T-Nav.1: navigate must be called exactly once. Got ${spies.navigateCallCount.n}.`);
        assert.ok(spies.navigateUrlLog.includes(FEED_URL),
          `T-Nav.1: navigate must be called with FEED_URL="${FEED_URL}". Got ${JSON.stringify(spies.navigateUrlLog)}.`);

        // --- P12 open stage: AX resolver used open → clickAt(non-@pc) ---
        assert.ok(spies.focusCallCount.n >= 1,
          `T-Nav.1: focusFeedComposerEditorLive must be called at least once. Got ${spies.focusCallCount.n}.`);
        const openClicks = spies.clickAtLog.filter((r) => !r.startsWith("@pc"));
        assert.ok(openClicks.length > 0,
          `T-Nav.1: open stage must call clickAt(non-@pc ref) via P12 AX resolver. clickAtLog=${JSON.stringify(spies.clickAtLog)}.`);

        // --- Full draft insertion assertion (CONCERN-MR F-B proof) ---
        // insertTextHumanLike inserts per-char; concatenation must equal full draft.text.
        const insertedText = spies.insertTextLog.map((e) => e.text).join("");
        assert.ok(spies.insertTextLog.length > 0,
          "T-Nav.1: insertTextHumanLike must be called (insertTextLog must not be empty)."),
        assert.equal(insertedText, draftText,
          `T-Nav.1 (F-B proof): concatenated insertTextLog must equal draft.text. ` +
          `Expected ${draftText.length} chars, got ${insertedText.length} chars.`);

        // --- P12 Post stage: AX resolver → clickAt(native @e ref) ---
        // Post-live-diagnosis: shadow-DOM sim (postSynthItems:[]) → zero @pc* entries.
        // Resolver finds the native-AX "Post" button and returns @e ref.
        const postClicks = spies.clickAtLog.filter((r) => r.startsWith("@e"));
        assert.ok(postClicks.length > 0,
          `T-Nav.1: Post stage must call clickAt(native-AX @e ref) via P12 AX resolver. clickAtLog=${JSON.stringify(spies.clickAtLog)}.`);

        // --- Result assertions ---
        assert.equal(result.published, true,
          "T-Nav.1: result.published must be true (F-B: runtime publishes without agent pre-typing).");
        assert.equal(result.dispatchAttempted, true,
          "T-Nav.1: result.dispatchAttempted must be true.");
        assert.equal(result.fallbackAllowed, false,
          "T-Nav.1: result.fallbackAllowed must be false (successful publish).");
        // fastPath=false: no composerAlreadyValid=true. Absence of close/clear proves no fast-path.
        assert.equal(spies.closeCallCount.n, 0,
          "T-Nav.1: closeFeedComposerLive must NOT be called (probe1.present=false → skip close block).");
        assert.equal(spies.clearCallCount.n, 0,
          "T-Nav.1: clearFeedComposerEditorLive must NOT be called (fresh empty editor after open).");
      },
    );
  },
);

// ===========================================================================
// T-Nav.2 — SC-2: surface capable on first check → navigate NOT called
//   fast-path preservation: a pre-typed open composer is never navigated away from.
// ===========================================================================

describe(
  // P13 UPDATE: P13 removed composerAlreadyValid fast-path; navigate fires UNCONDITIONALLY.
  // SC-2 is now: even when probe0.present=true (composer is open), P13 ALWAYS navigates.
  "publishApprovedFeedPost — P13 update: navigate fires unconditionally even when probe0.present=true (T-Nav.2, SC-2)",
  () => {
    it(
      "T-Nav.2 (P13): navigate fires unconditionally even when probe0.present=true + editorText matches draft; no composerAlreadyValid fast-path in P13 → navigateCallCount.n>=1; published=true after close+navigate+open+type",
      { timeout: 15000 },
      async () => {
        // P13 UPDATE: P13 removed composerAlreadyValid fast-path. navigate fires unconditionally
        //             regardless of probe0.present. Even if the composer was open and already
        //             contained the correct text, P13 closes, navigates, opens, and re-types.
        //
        // Given: probe0.present=true, editorText=draftText (was P12 fast-path trigger).
        //        P13: close (probe1=false → closed) → probe0 preNavigate → navigate(FEED_URL)
        //        → probe1 postNavigate → open resolver → in-round probe → readback → Post.
        // When:  publishApprovedFeedPost is invoked.
        // Then:  navigateCallCount.n>=1 (P13: navigate always fires).
        //        result.published===true (close+navigate+open+type path succeeds).
        //        result.dispatchAttempted===true; result.fallbackAllowed===false.
        // Covers SC-2 (P13 semantics: navigate fires even when composer already had correct text).
        const constants = await loadPayloadConstants();
        const draftText = "T-Nav.2 — P13 always navigates even when already capable";
        const setup = await seedDraft("nav2-p13-alwaysnav", draftText);

        const spies = makeSpies();
        const triggerCallQueue: Array<{ cx: number; cy: number } | null> = [];

        // P13 probe layout: [0]=close, [1]=probe0, [2]=probe1, [3]=in-round open, [4]=readback, [5]=post-click.
        const probeQueue: Array<{ present: boolean; editorText: string }> = [
          { present: false, editorText: "" },          // [0] close probe: closed (1 probe)
          { present: true,  editorText: draftText },   // [1] probe0 preNavigate: was P12 fast-path trigger
          { present: false, editorText: "" },          // [2] probe1 postNavigate
          { present: true,  editorText: "" },          // [3] in-round open probe: empty editor after open
          { present: true,  editorText: draftText },   // [4] readback → matches
          { present: false, editorText: "" },          // [5] post-click → gone
        ];

        const opts: NavFakeClientOpts = {
          constants,
          triggerCallQueue,
          probeQueue,
          closeCenterQueue: [],
          discardCenterQueue: [],
          focusResult: true,
          clearResult: false,
          enabledQueue: [true],
          postCenterResult: null,
          navigateShouldThrow: false,
          // AX tree: open resolver needs "Start a post"; Post resolver needs "Post".
          axTreeQueue: [
            [makeAXNode(101, "button", "Start a post", 9001)], // open resolver
            [makeAXNode(20,  "button", "Post", 201)],          // Post resolver
          ],
          ...spies,
        };
        const client = makeNavFakeClient(opts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail("T-Nav.2: publishApprovedFeedPost not exported");
        }
        const result = await fn(deps);

        // P13: navigate ALWAYS fires (no composerAlreadyValid fast-path).
        assert.ok(spies.navigateCallCount.n >= 1,
          `T-Nav.2: navigate must be called at least once in P13 (no fast-path). Got ${spies.navigateCallCount.n}.`);
        assert.ok(spies.navigateUrlLog.includes(FEED_URL),
          `T-Nav.2: navigate must be called with FEED_URL. Got ${JSON.stringify(spies.navigateUrlLog)}.`);

        // Publish succeeds via close+navigate+open+type path.
        assert.equal(result.published, true, "T-Nav.2: result.published must be true (P13 full path).");
        assert.equal(result.dispatchAttempted, true, "T-Nav.2: result.dispatchAttempted must be true.");
        assert.equal(result.fallbackAllowed, false, "T-Nav.2: result.fallbackAllowed must be false.");
      },
    );
  },
);

// ===========================================================================
// T-Nav.3 — SC-3: surface false → navigate → still false → surface_not_composer_capable
// ===========================================================================

describe(
  "publishApprovedFeedPost — P12 update: navigate succeeds but AX resolver fails → composer_open_click_failed (T-Nav.3, SC-3)",
  () => {
    it(
      "T-Nav.3 (P12 update): when probe0.present===false, navigate succeeds, probe1.present===false, and AX resolver cannot find 'Start a post' within budget → reason===composer_open_click_failed; navigate IS called (navigated=true → NOT surface_not_composer_capable); dispatchAttempted===false; no insert/Post-click",
      { timeout: 20000 }, // P13: 4 rounds × 3000ms open budget + between-round backoffs ≈ 12-13s
      async () => {
        // P12 DESIGN UPDATE: In P12, surface_not_composer_capable fires ONLY when navigate THROWS.
        //   When navigate succeeds but neither probe shows composer present, the runtime falls into
        //   the open resolver (AX-based). If the AX resolver times out without finding "Start a post"
        //   (axTreeQueue=[] → nodes=[] → resolveByLabel never matches), the reason is
        //   composer_open_click_failed (NOT surface_not_composer_capable).
        //
        // Given: probe0: present=false → navigate(FEED_URL) called, succeeds → navigated=true.
        //        probe1 (post-navigate): present=false → composerAlreadyValid=false.
        //        probe1.present=false → skip close block.
        //        Open resolver: axTreeQueue=[] → getFullAXTree → nodes=[] → no entries →
        //          resolveByLabel throws → retries × 10 × 300ms = 3000ms → composer_open_click_failed.
        //        No clickAt, no insert, no Post-click.
        // When:  publishApprovedFeedPost is invoked.
        // Then:  navigateCallCount.n===1; navigateUrlLog includes FEED_URL.
        //        result.reason==="composer_open_click_failed" (NOT surface_not_composer_capable).
        //        result.dispatchAttempted===false; result.fallbackAllowed===true; result.published===false.
        //        clickAtLog.length===0; insertTextLog.length===0.
        // Covers SC-3 (P12 semantics: navigate+AX-fail → composer_open_click_failed).
        const constants = await loadPayloadConstants();
        const draftText = "T-Nav.3 — navigate succeeds, open AX resolver fails";
        const setup = await seedDraft("nav3-axfail", draftText);

        const spies = makeSpies();

        // P12: triggerCallQueue irrelevant (no TRIGGER_JS surface check).
        const triggerCallQueue: Array<{ cx: number; cy: number } | null> = [];

        // probeQueue for P12:
        //   [0] probe0: present=false → navigate
        //   [1] probe1 (post-navigate): present=false → not composerAlreadyValid, skip close
        //       open resolver runs → AX empty → timeout → composer_open_click_failed
        const probeQueue: Array<{ present: boolean; editorText: string }> = [
          { present: false, editorText: "" }, // [0] probe0: not open → navigate
          { present: false, editorText: "" }, // [1] probe1: not open → open resolver
        ];

        const opts: NavFakeClientOpts = {
          constants,
          triggerCallQueue,
          probeQueue,
          closeCenterQueue: [],
          discardCenterQueue: [],
          focusResult: false,
          clearResult: false,
          enabledQueue: [],
          postCenterResult: null,
          navigateShouldThrow: false,
          // axTreeQueue: empty → AX resolver never finds "Start a post" → timeout
          axTreeQueue: [],
          ...spies,
        };
        const client = makeNavFakeClient(opts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail("T-Nav.3: publishApprovedFeedPost not exported");
        }
        const result = await fn(deps);

        assert.equal(spies.navigateCallCount.n, 1,
          `T-Nav.3: navigate must be called exactly once. Got ${spies.navigateCallCount.n}.`);
        assert.ok(spies.navigateUrlLog.includes(FEED_URL),
          `T-Nav.3: navigate must be called with FEED_URL. Got ${JSON.stringify(spies.navigateUrlLog)}.`);
        // P12: navigate succeeds → NOT surface_not_composer_capable; open AX resolver fails → composer_open_click_failed.
        assert.equal(result.reason, "composer_open_click_failed",
          `T-Nav.3: P12 reason must be composer_open_click_failed (navigate succeeded; open AX resolver timed out). Got ${result.reason}.`);
        assert.equal(result.dispatchAttempted, false,
          "T-Nav.3: dispatchAttempted must be false.");
        assert.equal(result.fallbackAllowed, true,
          "T-Nav.3: fallbackAllowed must be true (LLM can retry).");
        assert.equal(result.published, false,
          "T-Nav.3: published must be false.");
        assert.equal(spies.clickAtLog.length, 0,
          `T-Nav.3: clickAt must NOT be called (open resolver timed out). clickAtLog=${JSON.stringify(spies.clickAtLog)}.`);
        assert.equal(spies.insertTextLog.length, 0,
          "T-Nav.3: insertTextHumanLike must NOT be called on this path.");
      },
    );
  },
);

// ===========================================================================
// T-Nav.4 — SC-4: navigate throws → caught → re-check → surface_not_composer_capable
//   No crash escapes the try/catch in the P11 navigate block.
// ===========================================================================

describe(
  "publishApprovedFeedPost — P11 navigate: navigate throws → caught → re-check → surface_not_composer_capable (T-Nav.4, SC-4)",
  () => {
    it(
      "T-Nav.4: when navigate() rejects (stealth not injected / nav error), the error is caught; second surface check still runs; if false → {reason:'surface_not_composer_capable', fallbackAllowed:true}; no crash propagates",
      { timeout: 10000 },
      async () => {
        // Given: first surface check: TRIGGER_JS → null → probe → false → not capable.
        //        navigate() THROWS (fake navigateShouldThrow=true).
        //        The P11 try/catch catches the throw; fall through to second surface check.
        //        Second surface check: TRIGGER_JS → null → probe → false → still not capable.
        //        Runtime returns surface_not_composer_capable (no crash).
        // When:  publishApprovedFeedPost is invoked.
        // Then:  navigateCallCount.n===0 (throw happened before increment, or navigate rejected).
        //        result.reason==="surface_not_composer_capable".
        //        result.fallbackAllowed===true; result.dispatchAttempted===false.
        //        No exception propagates out of publishApprovedFeedPost.
        // Covers SC-4 (navigate throws → safe).
        const constants = await loadPayloadConstants();
        const draftText = "T-Nav.4 — navigate throws, must not crash";
        const setup = await seedDraft("nav4-navthrow", draftText);

        const spies = makeSpies();

        // Both surface checks return null (navigate threw → second check gets null too).
        const triggerCallQueue: Array<{ cx: number; cy: number } | null> = [
          null, // [0] first surface check
          null, // [1] second surface check (navigate threw, still on original page → not capable)
        ];

        const probeQueue: Array<{ present: boolean; editorText: string }> = [
          { present: false, editorText: "" }, // [0] first surface check secondary probe
          { present: false, editorText: "" }, // [1] second surface check secondary probe
        ];

        const opts: NavFakeClientOpts = {
          constants,
          triggerCallQueue,
          probeQueue,
          closeCenterQueue: [],
          discardCenterQueue: [],
          focusResult: false,
          clearResult: false,
          enabledQueue: [],
          postCenterResult: null,
          navigateShouldThrow: true, // navigate THROWS — must be caught
          ...spies,
        };
        const client = makeNavFakeClient(opts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail("T-Nav.4: publishApprovedFeedPost not exported");
        }

        // Assert no exception escapes.
        let result: PublishResult;
        try {
          result = await fn(deps);
        } catch (e) {
          assert.fail(
            `T-Nav.4: publishApprovedFeedPost must not throw when navigate() rejects. ` +
            `Got: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        assert.equal(result!.reason, "surface_not_composer_capable",
          "T-Nav.4: reason must be surface_not_composer_capable (navigate threw → re-check also false).");
        assert.equal(result!.fallbackAllowed, true,
          "T-Nav.4: fallbackAllowed must be true.");
        assert.equal(result!.dispatchAttempted, false,
          "T-Nav.4: dispatchAttempted must be false.");
        assert.equal(result!.published, false,
          "T-Nav.4: published must be false.");
        // navigate threw → navigateCallCount.n stays 0 (the fake throws before incrementing).
        assert.equal(spies.navigateCallCount.n, 0,
          `T-Nav.4: navigateCallCount must be 0 (threw before recording). Got ${spies.navigateCallCount.n}.`);
        assert.equal(spies.dispatchClickLog.length, 0,
          "T-Nav.4: no Post-button click must have been dispatched.");
      },
    );
  },
);

// ===========================================================================
// T-Nav.5 — SC-5/no-double-post: on every fail path, Post-click count=0;
//   source-grep: dispatchAttempted = true appears exactly once in the source.
// ===========================================================================

describe(
  "publishApprovedFeedPost — P11 navigate: no-double-post invariant — dispatchAttempted=true appears exactly once in source; Post-click count=0 on all fail paths (T-Nav.5, SC-5)",
  () => {
    it(
      "T-Nav.5: source literal 'dispatchAttempted = true' appears exactly once in deterministicPublishPost.ts; on navigate-fail (surface false→navigate→false) dispatchClickLog.length===0",
      { timeout: 20000 }, // P13: 4 rounds × 3000ms open budget + between-round backoffs ≈ 12-13s
      async () => {
        // Given: source-level: 'dispatchAttempted = true' must appear exactly once (no P11
        //        navigate block added a second assignment). Behavioral: on the navigate-fail
        //        path (surface not capable after navigate) dispatchHumanLikeClickAtCoords is
        //        never called.
        // When:  (a) grep the source file; (b) run a navigate-fail scenario.
        // Then:  (a) exactly one 'dispatchAttempted = true' assignment in source.
        //        (b) dispatchClickLog.length === 0 on the navigate-fail path.
        // Covers SC-5 (no-double-post invariant across P11 code paths).
        const constants = await loadPayloadConstants();
        const draftText = "T-Nav.5 — no-double-post invariant";
        const setup = await seedDraft("nav5-nodoublepost", draftText);

        // --- (a) Source-level structural assertion ---
        const assignmentMatches = (
          PUBLISH_SRC.match(/dispatchAttempted\s*=\s*true/g) ?? []
        ).length;
        assert.equal(assignmentMatches, 1,
          `T-Nav.5: 'dispatchAttempted = true' must appear exactly once in deterministicPublishPost.ts. ` +
          `Found ${assignmentMatches}. The P11 navigate block must not have added a second assignment.`);

        // --- (b) Behavioral: navigate-fail path → no Post-click ---
        const spies = makeSpies();
        const triggerCallQueue: Array<{ cx: number; cy: number } | null> = [
          null, // first surface check → not capable
          null, // second surface check → still not capable
        ];
        const probeQueue: Array<{ present: boolean; editorText: string }> = [
          { present: false, editorText: "" },
          { present: false, editorText: "" },
        ];
        const opts: NavFakeClientOpts = {
          constants,
          triggerCallQueue,
          probeQueue,
          closeCenterQueue: [],
          discardCenterQueue: [],
          focusResult: false,
          clearResult: false,
          enabledQueue: [],
          postCenterResult: null,
          navigateShouldThrow: false,
          ...spies,
        };
        const client = makeNavFakeClient(opts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail("T-Nav.5: publishApprovedFeedPost not exported");
        }
        const result = await fn(deps);

        // No Post-click on fail path.
        assert.equal(spies.dispatchClickLog.length, 0,
          `T-Nav.5: dispatchHumanLikeClickAtCoords must NOT be called on the navigate-fail path. ` +
          `Got ${spies.dispatchClickLog.length} calls.`);
        assert.equal(result.dispatchAttempted, false,
          "T-Nav.5: dispatchAttempted must be false on the navigate-fail path.");
        assert.equal(result.published, false,
          "T-Nav.5: published must be false on the navigate-fail path.");
      },
    );
  },
);
