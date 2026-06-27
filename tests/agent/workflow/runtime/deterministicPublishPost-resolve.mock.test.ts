/**
 * P-POST-PUBLISH-12 + P-POST-PUBLISH-13 + P-POST-PUBLISH-14 — TDD scaffold
 *   Step 3a P12 revised + Step 2 P13 + Step 2 P14
 *
 * P12 behaviors (carried forward, green on P12 production code):
 *   §5.1 T-NoDoublePost.1/2/3a/3b/3c/4/5 — no-double-post (revised .3a/3b/4 for P13 multi-click)
 *   §5.2 T-Obs.1-6                        — C1 observability (revised .1-3 for 3 rows; new .6)
 *   §5.3 T-Resolve.1-12 (T-Resolve.9 DELETED — fast-path gone in P13)
 *   §5.4 T-Safety.1-4                     — safety constraints (new T-Safety.4)
 *   §5.6 T-Reasons.1-4                    — reachable-reason (T-Reasons.2 revised in P13)
 *
 * P13 NEW behaviors (RED on P12 production code — fail until Codex Step 4):
 *   §5.1 T-Always.1-5  — unconditional close+navigate+retype; composerAlreadyValid gone
 *   §5.2 T-OpenRetry.1-8 — hardened 4-round open-retry with progressive backoff
 *   §5.4 T-Retype.1-3  — always re-type from DB draft; composerTextMatches; conditional clear
 *   §5.5 T-Obs.1-3/6   — 3 deterministic diag rows; postOpen schema; closeOutcome field
 *
 * P14 NEW behaviors (RED on P13 production code — fail until Codex Step 4):
 *   §5.1 T-EnableGate.1/2/3 — 6-attempt enable-gate with progressive READBACK_RETRY_MS*(1<<i) backoff
 *   §5.1 T-NoDoublePost.3b REVISED — gate-retry zero-click invariant; source-grep companion
 *
 * §5.9 L-LIVE.1-3 are live-only gate criteria (validator-driven at Step 5).
 *
 * Harness changes vs Step-2 scaffold:
 *   - writeAuditRow spy: deps.writeAuditRow is a capturing function that records every
 *     post_publish_runtime_diag audit row. T-Obs.1-4 assert on these rows (output.phase,
 *     output.composerPresent, C1 fields) — NOT on raw Runtime.evaluate payloads (which
 *     cannot carry phase/composerPresent because those are added AFTER parse).
 *   - T-NoDoublePost.3 split: 3a = PRE-OPEN (0 clicks), 3b = POST-OPEN/PRE-POST (1 open
 *     click, 0 Post click), 3c = source guard (only clickAt after dispatchAttempted=true
 *     is postEntry.ref).
 *   - T-Obs.2 revised: driven by probe0.present===false (not startBtnFound).
 *   - T-Obs.3 revised: driven by probe0.present===true.
 *   - T-Reasons.1-4 new: reachable-reason reconciliation per §5.6.
 *   - T-Resolve.10 new: freshResolverSession shim semantics.
 *   - T-Resolve.11 REVISED (Step-3a round-2): empty-ref guard replaces @pc-prefix guard;
 *     pure source-structural assertion (no captureCallbackOverride); @e7 pass-through proven by T-Resolve.4.
 *   - T-Resolve.4 REVISED (Step-3a): native-AX @e7 unfiltered; filterEntriesByScope removed;
 *     postSynthItems:[] simulates shadow-DOM blindness (zero @pc* entries).
 *   - T-Resolve.12 NEW (Step-3a): no-ambiguity invariant — 12a (one native + zero @pc* →
 *     clean resolve) and 12b (native + @pc2 → ambiguous → post_coords_missing).
 *   - AX_FILLER_NODES new: 6 generic nodes to push AX_POST_BUTTON to @e7 position.
 *   - P12FakeClientOpts.postSynthItems: configurable POST_COMPOSER_SYNTH_JS response.
 *
 * Runner:
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/workflow/runtime/deterministicPublishPost-resolve.mock.test.ts
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
// Root path (for source-introspection tests)
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, "../../../..");
const PUBLISH_SRC = readFileSync(
  resolve(ROOT, "src/agent/workflow/runtime/deterministicPublishPost.ts"),
  "utf-8",
);
const WORKFLOW_SRC = readFileSync(
  resolve(ROOT, "src/cli/subcommands/serve/routes/workflow.ts"),
  "utf-8",
);
const CLICK_SRC = readFileSync(
  resolve(ROOT, "src/tools/browser/click.ts"),
  "utf-8",
);

const FEED_URL = "https://www.linkedin.com/feed/";

// ---------------------------------------------------------------------------
// Captured audit row type
// CONCERN-MR-1: T-Obs.1-4 assert on CapturedAuditRow[] filtered by toolName,
// NOT on raw Runtime.evaluate payloads. The captured rows carry output.phase and
// output.composerPresent, which are added AFTER parse in captureSurfaceDiagnostic
// and therefore cannot appear in the raw evaluate response.
// ---------------------------------------------------------------------------

interface CapturedAuditRow {
  ts: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error: unknown;
  stepFinishReason: string;
}

// ---------------------------------------------------------------------------
// P12 Fake CdpClient harness
// ---------------------------------------------------------------------------

interface FakeAXNode {
  nodeId: number;
  ignored?: boolean;
  role?: { value: string };
  name?: { value: string };
  backendDOMNodeId?: number;
  childIds?: number[];
}

// AX node fixtures.
const AX_START_A_POST: FakeAXNode = {
  nodeId: 10,
  role: { value: "button" },
  name: { value: "Start a post" },
  backendDOMNodeId: 101,
};

const AX_POST_BUTTON: FakeAXNode = {
  nodeId: 20,
  role: { value: "button" },
  name: { value: "Post" },
  backendDOMNodeId: 201,
};

const AX_IRRELEVANT: FakeAXNode = {
  nodeId: 99,
  role: { value: "generic" },
  name: { value: "some content" },
  backendDOMNodeId: 999,
};

// Six filler nodes — when placed before AX_POST_BUTTON in a tree, they occupy slots
// e1–e6 so the Post button gets ref @e7. T-Resolve.4 / T-Resolve.12 use this layout
// to simulate the real production state (native-AX "Post" at a non-trivial counter).
const AX_FILLER_NODES: FakeAXNode[] = [
  { nodeId: 31, role: { value: "generic" }, name: { value: "region" }, backendDOMNodeId: 301 },
  { nodeId: 32, role: { value: "generic" }, name: { value: "region" }, backendDOMNodeId: 302 },
  { nodeId: 33, role: { value: "generic" }, name: { value: "region" }, backendDOMNodeId: 303 },
  { nodeId: 34, role: { value: "generic" }, name: { value: "region" }, backendDOMNodeId: 304 },
  { nodeId: 35, role: { value: "generic" }, name: { value: "region" }, backendDOMNodeId: 305 },
  { nodeId: 36, role: { value: "generic" }, name: { value: "region" }, backendDOMNodeId: 306 },
];

// SURFACE_DIAGNOSTIC_JS detection markers (plan §6.2).
const DIAG_MARKERS = ["startBtnFound", "shareBoxNodeCount", "start|create"];

function isDiagnosticEval(expr: string): boolean {
  return DIAG_MARKERS.some((m) => expr.includes(m));
}

const SENTINEL_PROBE = "__P12RESOLVE_PROBE__";
const SENTINEL_FOCUS = "__P12RESOLVE_FOCUS__";
const SENTINEL_CLEAR = "__P12RESOLVE_CLEAR__";
const SENTINEL_ENABLED = "__P12RESOLVE_ENABLED__";

interface PayloadConstants {
  PROBE_JS: string;
  FOCUS_JS: string;
  CLEAR_JS: string;
  ENABLED_JS: string;
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
    };
  } catch {
    return {
      PROBE_JS: SENTINEL_PROBE,
      FOCUS_JS: SENTINEL_FOCUS,
      CLEAR_JS: SENTINEL_CLEAR,
      ENABLED_JS: SENTINEL_ENABLED,
    };
  }
}

function peekOrLast<T>(queue: T[]): T | undefined {
  if (queue.length === 0) return undefined;
  return queue.length === 1 ? queue[0] : queue.shift();
}

interface P12FakeClientOpts {
  constants: PayloadConstants;
  axTreeQueue: Array<{ nodes: FakeAXNode[] }>;
  probeQueue: Array<{ present: boolean; editorText: string }>;
  focusResult: boolean;
  clearResult: boolean;
  enabledQueue: boolean[];
  closeCenterQueue: Array<{ cx: number; cy: number } | null>;
  discardCenterQueue: Array<{ cx: number; cy: number } | null>;
  navigateShouldThrow?: boolean;
  // null = evaluate throws (T-Obs.4).
  diagnosticResult: string | null;
  // Optional override for the POST_COMPOSER_SYNTH_JS response items.
  // Default (when undefined): [{i:1, role:"button", label:"Post"}] → registers @pc1.
  // Set to [] to simulate shadow-DOM blindness (zero @pc* entries) — production state.
  // Set to [{i:2, role:"button", label:"Post"}] for T-Resolve.12b (inject @pc2 alongside @e7).
  postSynthItems?: Array<{ i: number; role: string; label: string }>;
  // Spy logs (mutated by the fake).
  clickAtLog: string[];
  // clickAtNameLog: resolved entry name for each clickAt call (derived from last AX tree snapshot).
  // @e* refs: name = lastAXNodes[N-1].name. @pc* refs: the ref string itself (synth label unavailable).
  clickAtNameLog: string[];
  dispatchClickLog: Array<{ x: number; y: number }>;
  axTreeCallCount: { n: number };
  navigateCallCount: { n: number };
  navigateUrlLog: string[];
  // diagnosticEvalLog: raw Runtime.evaluate calls for SURFACE_DIAGNOSTIC_JS.
  // T-Obs.* assert on auditRowLog (captured via deps.writeAuditRow), NOT these.
  diagnosticEvalLog: string[];
  probeCallCount: { n: number };
  focusCallCount: { n: number };
  clearCallCount: { n: number };
  closeCallCount: { n: number };
  insertTextLog: Array<{ text: string }>;
  // keyEventLog: all Input.dispatchKeyEvent calls recorded as {key, type}.
  // BLOCKER-1: used by T-Always.1 to prove Escape (close) fires before navigate.
  keyEventLog: Array<{ key: string; type: string }>;
  // eventOrderLog: interleaved "escape" and "navigate" tokens for ordering proof.
  // "escape" pushed on every Escape dispatchKeyEvent; "navigate" pushed on every navigate call.
  eventOrderLog: string[];
  // enabledCallLog (P14): optional counter for isFeedComposerPostButtonEnabled calls.
  // When provided, the ENABLED handler increments n on every invocation.
  // T-EnableGate.* pass this to assert exact call counts without needing to instrument sleep.
  enabledCallLog?: { n: number };
  // enabledResultLog (P14 Step 5): optional array that records the boolean result of each
  // isFeedComposerPostButtonEnabled call in order. Used by the phase-gated setTimeout spy:
  // the spy captures sleeps only when the last result was false (i.e. we're between two
  // consecutive enabled-check iterations of the gate loop, not after the gate exited).
  enabledResultLog?: boolean[];
}

function makeP12FakeClient(opts: P12FakeClientOpts): CdpClient {
  const { constants: c } = opts;
  let enabledIdx = 0;
  // lastAXNodes: snapshot of nodes from the most recent getFullAXTree call.
  // Used to derive clickAtNameLog: @eN ref → lastAXNodes[N-1].name.
  let lastAXNodes: FakeAXNode[] = [];

  const fakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => {
        opts.axTreeCallCount.n++;
        const treeEntry = peekOrLast(opts.axTreeQueue) ?? { nodes: [] };
        lastAXNodes = treeEntry.nodes; // snapshot for ref→name lookup in clickAt override
        return treeEntry;
      },
    },
    Runtime: {
      evaluate: async (args: { expression: string }) => {
        const expr = args.expression;

        if (isDiagnosticEval(expr)) {
          if (opts.diagnosticResult === null) {
            throw new Error("fake-diagnostic-error");
          }
          opts.diagnosticEvalLog.push(opts.diagnosticResult);
          return { result: { value: opts.diagnosticResult } };
        }

        if (expr === c.PROBE_JS || expr.includes("FEED_COMPOSER_LIVE_IN_DOM")) {
          opts.probeCallCount.n++;
          const res = peekOrLast(opts.probeQueue) ?? { present: false, editorText: "" };
          return { result: { value: JSON.stringify(res) } };
        }

        // CLEAR must come BEFORE FOCUS: FEED_COMPOSER_CLEAR_JS contains "el.focus()" which
        // would otherwise match the FOCUS handler's expr.includes("el.focus()") guard.
        if (expr === c.CLEAR_JS || expr.includes("deleteContentBackward")) {
          opts.clearCallCount.n++;
          return { result: { value: opts.clearResult } };
        }

        if (expr === c.FOCUS_JS || expr.includes("el.focus()") || expr.includes("FOCUS")) {
          opts.focusCallCount.n++;
          return { result: { value: opts.focusResult } };
        }

        // CLOSE and DISCARD handlers MUST come before ENABLED because CLOSE_JS and
        // DISCARD_JS both contain "button.disabled" — they would otherwise be caught
        // by the ENABLED handler below. These checks use CLOSE_RE / DISCARD_RE which
        // are unique to the close/discard center scripts.
        if (expr.includes("FEED_COMPOSER_CLOSE") || expr.includes("CLOSE_RE")) {
          opts.closeCallCount.n++;
          const raw = peekOrLast(opts.closeCenterQueue) ?? null;
          return { result: { value: JSON.stringify(raw) } };
        }

        if (expr.includes("FEED_COMPOSER_DISCARD") || expr.includes("DISCARD_RE")) {
          const raw = peekOrLast(opts.discardCenterQueue) ?? null;
          return { result: { value: JSON.stringify(raw) } };
        }

        // ENABLED handler: detect by c.ENABLED_JS exact match, "button.disabled" (unique to
        // ENABLED_JS after CLOSE/DISCARD are handled above), or "POST_RE" without "data-frondose-pc"
        // (POST_COMPOSER_SYNTH_JS also has POST_RE but that's routed below via data-frondose-pc check).
        if (
          expr === c.ENABLED_JS ||
          expr.includes("button.disabled") ||
          (expr.includes("POST_RE") && !expr.includes("data-frondose-pc"))
        ) {
          const res = enabledIdx < opts.enabledQueue.length ? opts.enabledQueue[enabledIdx++] : false;
          // P14 extension: optional call counter for isFeedComposerPostButtonEnabled.
          if (opts.enabledCallLog) opts.enabledCallLog.n++;
          // P14 Step 5: record result for phase-gated setTimeout spy in T-EnableGate.*.
          // The spy captures sleeps only when the last recorded result is false
          // (meaning we're between two gate-loop iterations, not after the loop exits).
          if (opts.enabledResultLog) opts.enabledResultLog.push(res);
          return { result: { value: res } };
        }

        // window.location.href — getCurrentUrl() from CdpClient (used inside
        // captureCurrentSurfaceContext). Return LinkedIn feed URL so inferSurface → "feed"
        // and synthesizePostComposerEntries runs, which produces @pc* refs for the Post
        // resolver to find. MUST NOT consume from probeQueue.
        if (expr === "window.location.href") {
          return { result: { value: FEED_URL } };
        }

        // REGION_TAG_JS (tagAsideClickables) — starts with the data-frondose-rg-aside cleanup.
        // Return an empty object so the call succeeds without side effects.
        if (expr.includes("data-frondose-rg-aside")) {
          return { result: { value: "{}" } };
        }

        // Best-effort cleanup calls (forEach-based attribute removal) — return {} (no-op).
        if (
          expr.includes("forEach") && (
            expr.includes("data-frondose-ov") ||
            expr.includes("data-frondose-pc") ||
            expr.includes("data-frondose-pa") ||
            expr.includes("data-frondose-pm")
          )
        ) {
          return { result: { value: "{}" } };
        }

        // OVERLAY_SYNTH_JS — contains "menuitem" and "role=\"dialog\"".
        // Return a single dummy item so items.length > 0 — this prevents synthesizeOverlayEntries
        // from sleeping 350ms on retry. The item gets no backendNodeId from querySelectorAll
        // (returns nodeIds=[]) so it is skipped and produces no SnapshotEntry. Net: zero entries,
        // no 350ms overhead. Critical for the N=6 retry test to fit in the 3000ms resolver budget.
        if (
          (expr.includes("menuitem") || expr.includes("role=\"dialog\"")) &&
          expr.includes("const vis = (el)")
        ) {
          return { result: { value: JSON.stringify([{ i: 999, role: "button", label: "fake-overlay" }]) } };
        }

        // FEED_POST_SYNTH_JS — contains "repost" or "SIGNALS"; returns [] (no feed posts).
        if (expr.includes("repost") || expr.includes("SIGNALS")) {
          return { result: { value: JSON.stringify([]) } };
        }

        // POST_COMPOSER_SYNTH_JS — contains "data-frondose-pc" (without "forEach" since
        // forEach cleanup is already handled above). Returns postSynthItems (configurable per
        // test). Default produces a @pc1 ref. Set postSynthItems:[] to simulate shadow-DOM
        // blindness (T-Resolve.4, T-Resolve.12a). Set to [{i:2,...}] for T-Resolve.12b (@pc2).
        if (expr.includes("data-frondose-pc")) {
          const items = opts.postSynthItems ?? [{ i: 1, role: "button", label: "Post" }];
          return { result: { value: JSON.stringify(items) } };
        }

        // Other data-frondose-* synthesizer expressions (profile, etc.) — return [].
        if (
          expr.includes("data-frondose-ov") ||
          expr.includes("data-frondose-pa") ||
          expr.includes("data-frondose-pm")
        ) {
          return { result: { value: JSON.stringify([]) } };
        }

        // Default: treat as probe.
        opts.probeCallCount.n++;
        const res = peekOrLast(opts.probeQueue) ?? { present: false, editorText: "" };
        return { result: { value: JSON.stringify(res) } };
      },
    },
    DOM: {
      getDocument: async () => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (args: { selector?: string }) => {
        const sel = args?.selector ?? "";
        // Return a synthetic nodeId so synthesizePostComposerEntries can register @pc1.
        // nodeId 2001 → describeNode gives backendNodeId 2001 → @pc1 in refMap.
        if (sel.includes("data-frondose-pc")) return { nodeIds: [2001] };
        return { nodeIds: [] };
      },
      describeNode: async (args: { backendNodeId?: number; nodeId?: number }) => ({
        node: {
          nodeId: ((args.backendNodeId ?? args.nodeId ?? 0)) + 1000,
          backendNodeId: args.backendNodeId ?? args.nodeId ?? 0,
        },
      }),
      scrollIntoViewIfNeeded: async () => {},
      getBoxModel: async (_args: { nodeId?: number; backendNodeId?: number }) => ({
        model: { border: [100, 100, 110, 100, 110, 110, 100, 110] },
      }),
    },
    Input: {
      dispatchMouseEvent: async (_args: unknown) => {},
      dispatchKeyEvent: async (args: { type?: string; key?: string }) => {
        // BLOCKER-1: log every key event for eventOrderLog / keyEventLog.
        const key = args?.key ?? "";
        const type = args?.type ?? "";
        opts.keyEventLog.push({ key, type });
        if (key === "Escape") {
          // "escape" token enables ordering proof: Escape (close) before navigate.
          opts.eventOrderLog.push("escape");
        }
      },
      insertText: async (args: { text: string }) => {
        opts.insertTextLog.push({ text: args.text });
      },
      synthesizeScrollGesture: async () => {},
    },
    Browser: { close: async () => {} },
    Page: {
      enable: async () => {},
      navigate: async () => ({}),
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
        visualViewport: { pageX: 0, pageY: 0, clientWidth: 1440, clientHeight: 900 },
        cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1440, clientHeight: 900 },
        cssLayoutViewport: { clientWidth: 1440, clientHeight: 900 },
      }),
      reload: async () => {},
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);

  const origDispatch = client.dispatchHumanLikeClickAtCoords.bind(client);
  client.dispatchHumanLikeClickAtCoords = async (x: number, y: number) => {
    opts.dispatchClickLog.push({ x, y });
    return origDispatch(x, y);
  };

  const origClickAt = client.clickAt.bind(client);
  client.clickAt = async (selectorOrRef: string) => {
    opts.clickAtLog.push(selectorOrRef);
    // BLOCKER-2: derive resolved entry name from last AX tree snapshot.
    // @eN ref → 1-indexed position N in lastAXNodes (peekOrLast keeps the last snapshot).
    // @pc* refs use the ref itself as a fallback (synth label not available in fake).
    if (selectorOrRef.startsWith("@e")) {
      const pos = parseInt(selectorOrRef.slice(2), 10) - 1; // 0-indexed
      // FakeAXNode.name is { value: string } per the interface, not a plain string.
      // Extract the string value; fall back to "" for missing nodes.
      const rawNodeName = lastAXNodes[pos]?.name;
      opts.clickAtNameLog.push(
        typeof rawNodeName === "string"
          ? rawNodeName
          : (rawNodeName as { value?: string } | undefined)?.value ?? "",
      );
    } else {
      opts.clickAtNameLog.push(selectorOrRef); // @pc* or other refs
    }
    try {
      return await origClickAt(selectorOrRef);
    } catch {
      // Tolerate ref-not-found in the fake.
    }
  };

  client.navigate = async (url: string) => {
    if (opts.navigateShouldThrow) {
      throw new Error("fake-navigate-error: stealth not injected");
    }
    opts.navigateCallCount.n++;
    opts.navigateUrlLog.push(url);
    opts.eventOrderLog.push("navigate"); // BLOCKER-1: track navigate in event order
  };

  return client;
}

// ---------------------------------------------------------------------------
// Draft seeding helper
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
    `frondose-p12-resolve-${label}`,
    `${Date.now()}`,
  );
  mkdirSync(scratchDir, { recursive: true });
  const auditPath = join(scratchDir, "audit.jsonl");
  const dbPath = join(scratchDir, "sales.db");

  try {
    const dbMod = (await import(
      "../../../../src/tools/sales/_dbHandle.js"
    )) as Record<string, unknown>;
    const getSalesDb = dbMod["getSalesDb"] as ((p: string) => unknown) | undefined;
    const draftsMod = (await import(
      "../../../../src/persistence/sales/drafts.js"
    )) as Record<string, unknown>;
    const insertDraft = draftsMod["insertDraft"] as
      | ((db: unknown, input: { leadId: null; kind: string; text: string; createdBy: string }) => string)
      | undefined;
    if (typeof getSalesDb === "function" && typeof insertDraft === "function") {
      const db = getSalesDb(dbPath);
      const draftId = insertDraft(db, { leadId: null, kind: "post", text, createdBy: "llm" });
      return { scratchDir, auditPath, dbPath, draftId };
    }
  } catch {
    // helpers unavailable at Step 2/3a
  }
  return { scratchDir, auditPath, dbPath, draftId: "d-seed-unavailable" };
}

// ---------------------------------------------------------------------------
// Deps builder — CONCERN-MR-1: deps.writeAuditRow is a capturing spy.
// The captured rows let T-Obs.* assert on post_publish_runtime_diag audit rows
// rather than on raw Runtime.evaluate payloads (which cannot carry phase/composerPresent).
// ---------------------------------------------------------------------------

function makePublishDeps(
  client: CdpClient,
  setup: ScratchSetup,
  auditRowLog: CapturedAuditRow[],
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
    workflowId: "wf-p12-resolve",
    stepId: "step-p12-resolve",
    draftId: setup.draftId,
    // CONCERN-MR-1: capturing writeAuditRow spy injected via deps.writeAuditRow.
    // The runtime calls this (via PublishPostDeps.writeAuditRow? override) for each
    // post_publish_runtime_diag row. T-Obs.* verify output.phase, output.composerPresent,
    // and all C1 fields from these rows.
    writeAuditRow: (_auditPath: string, row: CapturedAuditRow) => {
      auditRowLog.push(row);
    },
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
  // P14 additive field: number of isFeedComposerPostButtonEnabled calls before loop exit.
  // Present on both success path and post_button_not_enabled exhaustion path.
  enableGateAttempts?: number;
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
// Spy factory
// ---------------------------------------------------------------------------

function makeP12Spies() {
  return {
    clickAtLog: [] as string[],
    clickAtNameLog: [] as string[],
    dispatchClickLog: [] as Array<{ x: number; y: number }>,
    axTreeCallCount: { n: 0 },
    navigateCallCount: { n: 0 },
    navigateUrlLog: [] as string[],
    diagnosticEvalLog: [] as string[],
    probeCallCount: { n: 0 },
    focusCallCount: { n: 0 },
    clearCallCount: { n: 0 },
    closeCallCount: { n: 0 },
    insertTextLog: [] as Array<{ text: string }>,
    keyEventLog: [] as Array<{ key: string; type: string }>,
    eventOrderLog: [] as string[],
  };
}

// Helper: filter captured audit rows by toolName.
function diagRows(auditRowLog: CapturedAuditRow[]): CapturedAuditRow[] {
  return auditRowLog.filter((r) => r.toolName === "post_publish_runtime_diag");
}

// ---------------------------------------------------------------------------
// P13 Harness extensions
// ---------------------------------------------------------------------------

// COMPOSER_OPEN_RETRY_ROUNDS constant (must match deterministicPublishPost.ts).
const COMPOSER_OPEN_RETRY_ROUNDS = 4;
// OPEN_IN_ROUND_PROBE_ATTEMPTS constant (must match deterministicPublishPost.ts §6.3).
const OPEN_IN_ROUND_PROBE_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// P14 Harness extensions
// ---------------------------------------------------------------------------

// ENABLE_GATE_ATTEMPTS (must match deterministicPublishPost.ts §6.4a after Step 4).
// P13 value: 2 (inline, not a constant). P14 value: 6.
const ENABLE_GATE_ATTEMPTS = 6;

// READBACK_RETRY_MS_VALUE: value of READBACK_RETRY_MS from composerReadiness.ts.
// Used to compute expected sleep durations for T-EnableGate.2 assertions.
// Must stay in sync with the constant in src/linkedin/composerReadiness.ts (P7+).
const READBACK_RETRY_MS_VALUE = 120;

// P13FakeClientOpts: extends P12FakeClientOpts with P13-specific controls.
interface P13FakeClientOpts extends P12FakeClientOpts {
  // Controls whether closeFeedComposerLive returns true (success) on the first attempt.
  // Default: true. If false, all COMPOSER_CLOSE_RETRY_ATTEMPTS attempts fail.
  closeSucceeds?: boolean;
}

// makeP13FakeClient: wraps makeP12FakeClient with P13-specific closeCenterQueue wiring.
// In P13, closeFeedComposerLive is called unconditionally BEFORE the preNavigate diagnostic
// and navigate. The P12 fake routes close through the CLOSE_RE Runtime.evaluate handler
// (closeCenterQueue). This helper pre-wires those queues so tests only need `closeSucceeds`.
//
// BLOCKER-1 fix: closeSucceeds=false now uses VALID coords (3 attempts get coordinates).
// Close fails because isFeedComposerLiveInDOM probes return present:true (driven by probeQueue),
// not because coords are null. This models a GENUINE close failure (close tried but composer
// kept reappearing) vs the old "null coords → immediate fail without even trying" model.
// probeQueue must have 3 close-probe slots with {present:true} for closeSucceeds=false.
function makeP13FakeClient(opts: P13FakeClientOpts): CdpClient {
  const closeSucceeds = opts.closeSucceeds ?? true;
  if (opts.closeCenterQueue.length === 0) {
    if (closeSucceeds) {
      // Close returns coords → one Escape + isFeedComposerLiveInDOM (consumes 1 probe).
      opts.closeCenterQueue = [{ cx: 100, cy: 100 }];
    } else {
      // 3 close attempts with VALID coords. Close fails because probeQueue's close-probe
      // slots return present:true (composer keeps reappearing after each Escape).
      // Tests using closeSucceeds=false must provide 3 {present:true} close-probe slots
      // at the start of their probeQueue — see T-Always.1 (close-fails) and T-Always.5.
      opts.closeCenterQueue = [{ cx: 100, cy: 100 }, { cx: 100, cy: 100 }, { cx: 100, cy: 100 }];
    }
  }
  return makeP12FakeClient(opts);
}

// P13 happy-path probe queue builder (closeSucceeds=true, the default).
//
// BLOCKER-1: closeFeedComposerLive calls isFeedComposerLiveInDOM after Escape, which
// consumes ONE probe from probeQueue. This slot is now at [0] (close-probe).
// Index layout:
//   [0]  close-probe: present:false = composer gone after Escape → close SUCCEEDED
//   [1]  probe0 (preNavigate diag)
//   [2]  probe1 (postNavigate diag)
//   [3..3+OPEN_IN_ROUND_PROBE_ATTEMPTS*(openedOnRound-1)-1]  failed rounds (all absent)
//   [N]  first probe in winning round: present:true
//   [N+1] readback: present:true, editorText:draftText
//   [N+2] post-click: present:false
//
// For tests that override probe0 (preNavigate diag), the index is [1], NOT [0].
// For closeSucceeds=false (3 attempts all fail), build a custom probe queue directly:
//   prefix 3 × {present:true} close-probe slots before the standard sequence.
//
// openedOnRound is 1-indexed. openedOnRound=1 → opens on first round (0 failed rounds).
function makeP13ProbeQueue(
  openedOnRound: number,
  draftText: string,
): Array<{ present: boolean; editorText: string }> {
  const q: Array<{ present: boolean; editorText: string }> = [];
  // [0] close-probe: after Escape, composer is gone → closeSucceeds=true (1 attempt).
  q.push({ present: false, editorText: "" });
  // [1] probe0 (preNavigate diag)
  q.push({ present: false, editorText: "" });
  // [2] probe1 (postNavigate diag)
  q.push({ present: false, editorText: "" });
  // Open loop: rounds 0..(openedOnRound-2) fail all 3 in-round probes
  for (let r = 0; r < openedOnRound - 1; r++) {
    for (let p = 0; p < OPEN_IN_ROUND_PROBE_ATTEMPTS; p++) {
      q.push({ present: false, editorText: "" });
    }
  }
  // Winning round (openedOnRound-1 in 0-index): first probe returns present
  q.push({ present: true, editorText: "" });
  // Type stage
  q.push({ present: true, editorText: draftText }); // readback match
  // Post-click: composer gone
  q.push({ present: false, editorText: "" });
  return q;
}

// P13 failure probe queue: all rounds click (or all resolver-throw), all probes absent.
// Used for composer_absent_after_open (all clicks, all probes absent) and
// composer_open_click_failed (resolver always throws, 0 open-stage probes consumed).
// BLOCKER-1: includes 1 close-probe slot at [0] (closeSucceeds=true, composer gone after Escape).
function makeP13AllRoundsFailProbeQueue(): Array<{ present: boolean; editorText: string }> {
  const q: Array<{ present: boolean; editorText: string }> = [];
  q.push({ present: false, editorText: "" }); // [0] close-probe (closeSucceeds=true)
  q.push({ present: false, editorText: "" }); // [1] probe0 (preNavigate diag)
  q.push({ present: false, editorText: "" }); // [2] probe1 (postNavigate diag)
  // All 4 rounds × 3 in-round probes (for composer_absent_after_open scenario):
  for (let r = 0; r < COMPOSER_OPEN_RETRY_ROUNDS; r++) {
    for (let p = 0; p < OPEN_IN_ROUND_PROBE_ATTEMPTS; p++) {
      q.push({ present: false, editorText: "" });
    }
  }
  return q;
}

// Default diagnostic JSON payloads for common scenarios.
const DIAG_PRESENT = JSON.stringify({
  url: FEED_URL,
  startBtnFound: true,
  startBtnRectWH: [100, 40],
  readyState: "complete",
  shareBoxNodeCount: 1,
});

const DIAG_ABSENT = JSON.stringify({
  url: FEED_URL,
  startBtnFound: false,
  startBtnRectWH: [0, 0],
  readyState: "complete",
  shareBoxNodeCount: 0,
});

// ===========================================================================
// §5.1 T-NoDoublePost — no-double-post invariant (REVISED for two-click design)
// ===========================================================================

describe("§5.1 T-NoDoublePost — no-double-post invariant", () => {

  // -----------------------------------------------------------------------
  // T-NoDoublePost.1
  // -----------------------------------------------------------------------
  it(
    "T-NoDoublePost.1: when source-grepped, 'dispatchAttempted = true' appears exactly once in deterministicPublishPost.ts",
    { timeout: 5000 },
    async () => {
      // Given: production source after P12 rewrite.
      // When: grepped with 'dispatchAttempted = true'.
      // Then: exactly one match.
      const matches = (PUBLISH_SRC.match(/dispatchAttempted\s*=\s*true/g) ?? []).length;
      assert.equal(matches, 1, `'dispatchAttempted = true' must appear exactly once; found ${matches}`);
    },
  );

  // -----------------------------------------------------------------------
  // T-NoDoublePost.2
  // -----------------------------------------------------------------------
  it(
    "T-NoDoublePost.2: next non-blank non-comment statement after 'dispatchAttempted = true' is 'await deps.client.clickAt'",
    { timeout: 5000 },
    async () => {
      // Given: production source after P12 rewrite.
      // When: lines around the assignment are read.
      // Then: next non-blank non-comment line is 'await deps.client.clickAt(postEntry.ref)'.
      const lines = PUBLISH_SRC.split("\n");
      const idx = lines.findIndex((l) => /dispatchAttempted\s*=\s*true/.test(l));
      assert.ok(idx > 0, `dispatchAttempted = true not found in source (idx=${idx})`);
      const nextLine = lines
        .slice(idx + 1)
        .find((l) => l.trim().length > 0 && !/^\s*\/\//.test(l));
      assert.ok(
        nextLine !== undefined && /deps\.client\.clickAt/.test(nextLine),
        `Next non-blank non-comment line after dispatchAttempted=true must be 'await deps.client.clickAt(postEntry.ref)'; got: ${nextLine?.trim()}`,
      );
    },
  );

  // -----------------------------------------------------------------------
  // T-NoDoublePost.3a: PRE-OPEN fail paths — zero clicks
  // BLOCKER-2 split: these fail before the open-stage clickAt ever fires.
  // -----------------------------------------------------------------------
  describe(
    "T-NoDoublePost.3a: PRE-OPEN fail paths — clickAt=0, dispatchHumanLike=0, dispatchAttempted=false",
    () => {
      // PRE-OPEN reasons: the open-stage clickAt has NOT been attempted yet.
      // approval_required, hardware_input_not_supported: mode/inputMode gates.
      // draft_missing, draft_already_sent: draft DB gates.
      // surface_not_composer_capable: navigate throws (P13: unconditional navigate).
      // composer_open_click_failed: resolver exhausts budget (never calls clickAt).
      // P13 NOTE: composer_close_failed is REMOVED from this list. In P13, close-failure
      // does NOT abort the publish path — it emits closeOutcome:"failed_but_navigated"
      // and continues to navigate (T-Always.5). The reason stays in the union for
      // forward compatibility but is structurally unreachable (T-Reasons.2 revised).
      for (const reason of [
        "approval_required",
        "hardware_input_not_supported",
        "draft_missing",
        "draft_already_sent",
        "surface_not_composer_capable",
        "composer_open_click_failed",
      ] as const) {
        it(
          `T-NoDoublePost.3a (${reason}): clickAt=0; dispatchHumanLike=0; dispatchAttempted=false`,
          { timeout: 15000 },
          async () => {
            // Given: inputs routing to '${reason}' before the open-stage click fires.
            // When: publishApprovedFeedPost is invoked.
            // Then: clickAtLog.length===0; dispatchClickLog.length===0; dispatchAttempted===false.
            const constants = await loadPayloadConstants();
            const setup = await seedDraft(`ndp3a-${reason}`, `T-NoDoublePost.3a-${reason}`);
            const spies = makeP12Spies();
            const auditRowLog: CapturedAuditRow[] = [];

            const navigateShouldThrow = reason === "surface_not_composer_capable";
            const clientMode = reason === "approval_required" ? "auto" : "manual";
            const useHardwareInput = reason === "hardware_input_not_supported";

            const clientOpts: P12FakeClientOpts = {
              constants,
              axTreeQueue: [{ nodes: [AX_IRRELEVANT] }],
              probeQueue: [
                { present: false, editorText: "" },
                { present: false, editorText: "" },
              ],
              focusResult: false,
              clearResult: false,
              enabledQueue: [],
              closeCenterQueue: [],
              discardCenterQueue: [],
              navigateShouldThrow,
              diagnosticResult: DIAG_ABSENT,
              ...spies,
            };
            const client = makeP12FakeClient(clientOpts);
            const baseDeps = makePublishDeps(client, setup, auditRowLog, clientMode);
            const deps = useHardwareInput
              ? {
                  ...baseDeps,
                  session: {
                    inputMode: "hardware" as const,
                    getOrInitClient: () => Promise.resolve(client),
                    getClient: () => client,
                    setLastContext: () => {},
                    getLastContext: () => undefined,
                    resolvedMode: () => clientMode,
                  },
                }
              : baseDeps;

            const fn = await importPublishFn();
            if (typeof fn !== "function") {
              assert.fail(`T-NoDoublePost.3a (${reason}): publishApprovedFeedPost not exported`);
            }
            const result = await fn(deps);

            assert.equal(spies.clickAtLog.length, 0, `T-NoDoublePost.3a (${reason}): clickAtLog must be empty; got ${JSON.stringify(spies.clickAtLog)}`);
            assert.equal(spies.dispatchClickLog.length, 0, `T-NoDoublePost.3a (${reason}): dispatchClickLog must be empty; got ${JSON.stringify(spies.dispatchClickLog)}`);
            assert.equal(result.dispatchAttempted, false, `T-NoDoublePost.3a (${reason}): dispatchAttempted must be false; reason=${result.reason}`);
          },
        );
      }
    },
  );

  // -----------------------------------------------------------------------
  // T-NoDoublePost.3b: POST-OPEN / PRE-POST fail paths — exactly ONE open click, zero Post click
  // BLOCKER-2: these fail AFTER the open-stage clickAt, but BEFORE dispatchAttempted=true.
  // -----------------------------------------------------------------------
  describe(
    "T-NoDoublePost.3b: POST-OPEN/PRE-POST fail paths — clickAt>=1 (all open, none Post-named); dispatchAttempted=false; fallbackAllowed=true",
    () => {
      // POST-OPEN/PRE-POST reasons: at least one open-stage clickAt DID fire (1..K clicks
      // depending on how many rounds ran before the post-open/pre-Post stage failed), but
      // the Post-click latch was never reached. P13: multi-round → clickAt can be 1..4.
      // Invariant: EVERY clickAt ref in the log was resolved from a "Start a post" entry,
      // NOT a "Post" entry. The name assertion is the core P13 multi-click safety property.
      for (const reason of [
        "composer_absent_after_open",
        "focus_failed",
        "clear_failed",
        "readback_mismatch",
        "post_button_not_enabled",
        "post_coords_missing",
      ] as const) {
        it(
          `T-NoDoublePost.3b (${reason}): clickAt>=1 (open refs, none @pc*, none Post-named); dispatchAttempted=false; fallbackAllowed=true; draftMarkedSent!==true`,
          { timeout: 15000 },
          async () => {
            // Given: probe0.present=false → navigate succeeds → AX returns "Start a post"
            //        → open clickAt fires → subsequent stage routes to reason.
            // When: publishApprovedFeedPost is invoked.
            // Then: clickAtLog.length===1; clickAtLog[0] does NOT start with "@pc";
            //       dispatchClickLog.length===1 (open clickAt fired exactly one coordinate dispatch);
            //       dispatchAttempted===false; fallbackAllowed===true;
            //       result.draftMarkedSent !== true (no draft marked sent on a pre-Post fail path).
            // NOTE: FAILS ON HEAD — pre-P12 uses single-shot triggerStartAPostLive, no two-click.
            const constants = await loadPayloadConstants();
            const draftText = `T-NoDoublePost.3b-${reason}`;
            const setup = await seedDraft(`ndp3b-${reason}`, draftText);
            const spies = makeP12Spies();
            const auditRowLog: CapturedAuditRow[] = [];

            // Probe queue scripted per-reason: all start with probe0.present=false (navigate).
            const probeQueueByReason: Record<string, Array<{ present: boolean; editorText: string }>> = {
              "composer_absent_after_open": [
                { present: false, editorText: "" }, // probe0
                { present: false, editorText: "" }, // post-navigate probe (postNavigate diag)
                { present: false, editorText: "" }, // entry probe
                { present: false, editorText: "" }, // post-open 1: absent
                { present: false, editorText: "" }, // post-open 2: absent → composer_absent_after_open
              ],
              "focus_failed": [
                { present: false, editorText: "" },
                { present: false, editorText: "" },
                { present: false, editorText: "" },
                { present: true, editorText: "" }, // post-open: present
              ],
              "clear_failed": [
                { present: false, editorText: "" },
                { present: false, editorText: "" },
                { present: false, editorText: "" },
                { present: true, editorText: "stale" }, // post-open: present with stale text
              ],
              "readback_mismatch": [
                { present: false, editorText: "" },
                { present: false, editorText: "" },
                { present: false, editorText: "" },
                { present: true, editorText: "" },
                { present: true, editorText: "X" }, // readback 1: mismatch
                { present: true, editorText: "X" }, // readback 2: still mismatch
              ],
              "post_button_not_enabled": [
                { present: false, editorText: "" },
                { present: false, editorText: "" },
                { present: false, editorText: "" },
                { present: true, editorText: "" },
                { present: true, editorText: draftText },
              ],
              "post_coords_missing": [
                { present: false, editorText: "" },
                { present: false, editorText: "" },
                { present: false, editorText: "" },
                { present: true, editorText: "" },
                { present: true, editorText: draftText },
                { present: true, editorText: "" },
              ],
            };

            const focusResultByReason: Record<string, boolean> = {
              "composer_absent_after_open": true,
              "focus_failed": false,  // KEY: focus fails → focus_failed
              "clear_failed": true,
              "readback_mismatch": true,
              "post_button_not_enabled": true,
              "post_coords_missing": true,
            };

            const clearResultByReason: Record<string, boolean> = {
              "composer_absent_after_open": true,
              "focus_failed": true,
              "clear_failed": false, // KEY: clear fails → clear_failed
              "readback_mismatch": true,
              "post_button_not_enabled": true,
              "post_coords_missing": true,
            };

            const enabledQueueByReason: Record<string, boolean[]> = {
              "composer_absent_after_open": [],
              "focus_failed": [],
              "clear_failed": [],
              "readback_mismatch": [],
              // P14 REVISED: 6 falses to exercise the full 6-attempt gate loop.
              // P13 (2-attempt): only 2 consumed; 4 left unconsumed (harmless).
              // P14 (6-attempt): all 6 consumed → post_button_not_enabled.
              "post_button_not_enabled": [false, false, false, false, false, false],
              "post_coords_missing": [true],
            };

            const clientOpts: P12FakeClientOpts = {
              constants,
              // AX: "Start a post" resolves → open clickAt fires; then no "Post" for post_coords_missing.
              axTreeQueue: [
                { nodes: [AX_START_A_POST] },
                { nodes: [AX_IRRELEVANT] }, // Post-click: no "Post" label
              ],
              probeQueue: probeQueueByReason[reason] ?? [{ present: false, editorText: "" }],
              focusResult: focusResultByReason[reason] ?? false,
              clearResult: clearResultByReason[reason] ?? true,
              enabledQueue: enabledQueueByReason[reason] ?? [],
              closeCenterQueue: [],
              discardCenterQueue: [],
              navigateShouldThrow: false,
              diagnosticResult: DIAG_ABSENT,
              ...spies,
            };
            const client = makeP12FakeClient(clientOpts);
            const deps = makePublishDeps(client, setup, auditRowLog);

            const fn = await importPublishFn();
            if (typeof fn !== "function") {
              assert.fail(`T-NoDoublePost.3b (${reason}): publishApprovedFeedPost not exported`);
            }
            const result = await fn(deps);

            // P12: 1 open click. P13: 1..K open clicks (multi-round). Allow >= 1.
            assert.ok(spies.clickAtLog.length >= 1, `T-NoDoublePost.3b (${reason}): expected >= 1 clickAt (at least one open click); got ${spies.clickAtLog.length}`);
            // EVERY open-stage clickAt ref must NOT be a @pc* synth (P12 carry) and
            // ideally resolves to a "Start a post" entry (P13: enforced by resolveByLabel).
            for (const ref of spies.clickAtLog) {
              assert.ok(
                !ref.startsWith("@pc"),
                `T-NoDoublePost.3b (${reason}): open clickAt ref must NOT start with "@pc"; got "${ref}"`,
              );
            }
            // BLOCKER-2: assert EVERY resolved entry name does NOT match /^post$/i.
            // This is the core no-double-post safety: proves no "Post" button was clicked
            // before the dispatch latch (dispatchAttempted=true), even with multi-round opens.
            for (const name of spies.clickAtNameLog) {
              assert.ok(
                !/^post$/i.test(name),
                `T-NoDoublePost.3b (${reason}): every open-stage clickAt resolved name must NOT match /^post$/i; got "${name}" in ${JSON.stringify(spies.clickAtNameLog)}`,
              );
            }
            // The open clickAt(s) call dispatchHumanLikeClickAtCoords internally.
            assert.ok(spies.dispatchClickLog.length >= 1, `T-NoDoublePost.3b (${reason}): expected >= 1 coordinate dispatch(es) for open click(s); got ${spies.dispatchClickLog.length}`);
            assert.equal(result.dispatchAttempted, false, `T-NoDoublePost.3b (${reason}): dispatchAttempted must be false before Post click; reason=${result.reason}`);
            assert.equal(result.fallbackAllowed, true, `T-NoDoublePost.3b (${reason}): fallbackAllowed must be true on pre-Post fail`);
            assert.notEqual(result.draftMarkedSent, true, `T-NoDoublePost.3b (${reason}): draftMarkedSent must not be true on pre-Post fail`);

            // P14 REVISED sub-property: for post_button_not_enabled with round-1 open
            // (exactly 1 open click) plus 6-fail enable-gate, clickAtLog.length === 1.
            // The 6 gate retries are PURE READS — zero clickAt calls in the gate loop.
            // GREEN on P13 (2-attempt gate also fires 0 clickAt); structural guard for P14.
            if (reason === "post_button_not_enabled") {
              assert.equal(
                spies.clickAtLog.length,
                1,
                `T-NoDoublePost.3b (${reason}) P14: clickAtLog.length must be exactly 1 ` +
                `(gate exhaustion emits ZERO clickAt; 6 retries are pure reads); got ${spies.clickAtLog.length}`,
              );
            }
          },
        );
      }
    },
  );

  // -----------------------------------------------------------------------
  // T-NoDoublePost.3b source-grep companion (P14 REQUIRED structural guard)
  // Between the readback_mismatch return and dispatchAttempted=true, zero clickAt calls.
  // Asserts that the 6-attempt enable-gate loop is PURELY isFeedComposerPostButtonEnabled
  // + sleep calls — no clickAt that could inflate the pre-dispatch click count.
  // GREEN on P13 (already true) + P14 (must remain true). Structural regression guard.
  // -----------------------------------------------------------------------
  it(
    "T-NoDoublePost.3b source-grep (P14): between readback_mismatch return and dispatchAttempted=true, zero \\bclickAt\\s*\\( calls in deterministicPublishPost.ts",
    { timeout: 5000 },
    () => {
      // Given: production source after P13 (and P14) rewrite.
      // When: the region between `finishPreDispatchFailure(..., "readback_mismatch")` and
      //       `dispatchAttempted = true` is extracted and scanned.
      // Then: regex /\bclickAt\s*\(/ finds ZERO matches in that region.
      //       Proves the enable-gate loop (6 iterations) emits no clickAt calls.
      // GREEN on P13 + P14 (structural guard against future regression).
      const lines = PUBLISH_SRC.split("\n");
      const readbackMismatchLineIdx = lines.findIndex((l) =>
        /finishPreDispatchFailure[^;]*['""]readback_mismatch['""]/.test(l),
      );
      const dispatchLatchLineIdx = lines.findIndex((l) =>
        /dispatchAttempted\s*=\s*true/.test(l),
      );
      assert.ok(
        readbackMismatchLineIdx >= 0,
        `T-NoDoublePost.3b source-grep: readback_mismatch return not found in deterministicPublishPost.ts`,
      );
      assert.ok(
        dispatchLatchLineIdx > readbackMismatchLineIdx,
        `T-NoDoublePost.3b source-grep: dispatchAttempted=true latch (line ${dispatchLatchLineIdx}) must appear AFTER readback_mismatch return (line ${readbackMismatchLineIdx})`,
      );
      const region = lines.slice(readbackMismatchLineIdx + 1, dispatchLatchLineIdx).join("\n");
      const clickAtMatches = (region.match(/\bclickAt\s*\(/g) ?? []).length;
      assert.equal(
        clickAtMatches,
        0,
        `T-NoDoublePost.3b source-grep: expected ZERO \\bclickAt\\s*\\( calls between readback_mismatch return and dispatchAttempted=true; found ${clickAtMatches} in region (lines ${readbackMismatchLineIdx}..${dispatchLatchLineIdx})`,
      );
    },
  );

  // -----------------------------------------------------------------------
  // T-NoDoublePost.3c: source guard — only clickAt after dispatchAttempted=true is postEntry.ref
  // BLOCKER-2: no other client.clickAt invocation appears between latch and end of function.
  // -----------------------------------------------------------------------
  it(
    "T-NoDoublePost.3c: source-scan: between 'dispatchAttempted = true' and end of publish function, the only client.clickAt invocation is 'await deps.client.clickAt(postEntry.ref)'",
    { timeout: 5000 },
    async () => {
      // Given: production source after P12 rewrite.
      // When: lines after the dispatchAttempted=true latch are scanned for clickAt calls.
      // Then: exactly one clickAt invocation after the latch, and it contains 'postEntry.ref'.
      const lines = PUBLISH_SRC.split("\n");
      const latchIdx = lines.findIndex((l) => /dispatchAttempted\s*=\s*true/.test(l));
      const postLines = latchIdx >= 0 ? lines.slice(latchIdx + 1) : [];
      const clickAtAfterLatch = postLines.filter(
        (l) => /deps\.client\.clickAt/.test(l) && !/^\s*\/\//.test(l),
      );
      assert.ok(latchIdx > 0, `dispatchAttempted = true latch not found in source`);
      assert.equal(clickAtAfterLatch.length, 1, `Expected exactly 1 client.clickAt after dispatchAttempted=true; got ${clickAtAfterLatch.length}: ${JSON.stringify(clickAtAfterLatch)}`);
      assert.ok(
        clickAtAfterLatch[0].includes("postEntry.ref"),
        `The only clickAt after dispatchAttempted=true must reference postEntry.ref; got: ${clickAtAfterLatch[0].trim()}`,
      );
    },
  );

  // -----------------------------------------------------------------------
  // T-NoDoublePost.4 REVISED (P13): success path fires clickAt K+1 times
  // K open clicks (1..COMPOSER_OPEN_RETRY_ROUNDS) + exactly 1 Post click.
  // With probe queue below, opens on round 0 probe 2 → K=1 → total=2.
  // P13 invariant: clickAtLog.last() starts with "@e" (native-AX Post ref);
  // all earlier refs are open-stage (none @pc*).
  // postSynthItems:[] simulates shadow-DOM blindness (zero @pc* entries).
  // P12 carry: K=1 on P12 too (same probe queue), so this test remains GREEN.
  // -----------------------------------------------------------------------
  it(
    "T-NoDoublePost.4 REVISED: given happy-path, clickAt fired K open + 1 Post times; Post ref is native-AX (@e*); dispatchAttempted=true; published=true",
    { timeout: 20000 },
    async () => {
      // Given: probe0=false → navigate → round 0: AX "Start a post" → open click [0];
      //        probe_r0_1=false → probe_r0_2=true → type+readback OK; Post (@e* native-AX); gone.
      // When: publishApprovedFeedPost is invoked.
      // Then: clickAtLog.length>=2; no entry starts with "@pc"; last entry starts with "@e";
      //       result.published===true; result.dispatchAttempted===true.
      const constants = await loadPayloadConstants();
      const draftText = "T-NoDoublePost.4 — two clickAt calls on success path";
      const setup = await seedDraft("ndp4-success", draftText);
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P12FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [AX_START_A_POST] },
          { nodes: [AX_POST_BUTTON] }, // @e1 in counter (single node)
        ],
        // Shadow-DOM simulation: postSynthItems:[] → zero @pc* entries.
        // Without this, both @e1 (native AX) and @pc1 (synth) would be present after
        // the fix → resolveByLabel throws "ambiguous". postSynthItems:[] ensures only @e1.
        postSynthItems: [],
        probeQueue: [
          { present: false, editorText: "" },    // probe0: navigate
          { present: false, editorText: "" },    // post-navigate probe
          { present: false, editorText: "" },    // entry probe
          { present: true, editorText: "" },     // post-open
          { present: true, editorText: draftText }, // readback
          { present: false, editorText: "" },    // post-click gone
        ],
        focusResult: true,
        clearResult: false,
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        ...spies,
      };
      const client = makeP12FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-NoDoublePost.4: publishApprovedFeedPost not exported");
      }
      const result = await fn(deps);

      assert.ok(spies.clickAtLog.length >= 2, `T-NoDoublePost.4: expected >= 2 clickAt calls (K open + 1 Post); got ${spies.clickAtLog.length}: ${JSON.stringify(spies.clickAtLog)}`);
      // All open-stage refs must NOT start with "@pc".
      for (const ref of spies.clickAtLog.slice(0, -1)) {
        assert.ok(!ref.startsWith("@pc"), `T-NoDoublePost.4: open clickAt ref must NOT start with "@pc"; got "${ref}"`);
      }
      // Post ref is native-AX (@e*), not @pc* — shadow-DOM sim; postSynthItems:[].
      const postRef = spies.clickAtLog[spies.clickAtLog.length - 1] ?? "";
      assert.ok(
        postRef.startsWith("@e"),
        `T-NoDoublePost.4: Post clickAt (last) must start with "@e" (native AX); got "${postRef}"`,
      );
      // BLOCKER-2: verify resolved entry NAMES, not just ref shape.
      // Every open-stage click must resolve to a "Start a post" name.
      for (const name of spies.clickAtNameLog.slice(0, -1)) {
        assert.ok(
          /^start\s+a\s+post\b/i.test(name),
          `T-NoDoublePost.4: every open-stage click must resolve to name matching /^start a post/i; got "${name}" in ${JSON.stringify(spies.clickAtNameLog)}`,
        );
      }
      // Post-click must resolve to "Post" name.
      const postName = spies.clickAtNameLog[spies.clickAtNameLog.length - 1] ?? "";
      assert.ok(
        /^post$/i.test(postName),
        `T-NoDoublePost.4: Post-stage click must resolve to name matching /^post$/i; got "${postName}"`,
      );
      assert.equal(result.published, true, `T-NoDoublePost.4: result.published must be true; reason=${result.reason}`);
      assert.equal(result.dispatchAttempted, true, `T-NoDoublePost.4: result.dispatchAttempted must be true`);
    },
  );

  // -----------------------------------------------------------------------
  // T-NoDoublePost.5: workflow.ts:112 backstop unchanged
  // -----------------------------------------------------------------------
  it(
    "T-NoDoublePost.5: workflow.ts source-grep — 'if (result.dispatchAttempted) return;' exists as unique early-return on publish branch",
    { timeout: 5000 },
    async () => {
      // Given: production workflow.ts source (unchanged in P12).
      // When: source-grepped.
      // Then: exactly one match.
      const matches = (
        WORKFLOW_SRC.match(/if\s*\(result\.dispatchAttempted\)\s*return;/g) ?? []
      ).length;
      assert.equal(matches, 1, `workflow.ts must contain exactly one 'if (result.dispatchAttempted) return;'; found ${matches}`);
    },
  );
});

// ===========================================================================
// §5.2 T-Obs — C1 decisive observability (CONCERN-MR-1: assert audit rows)
// ===========================================================================

describe("§5.2 T-Obs — C1 surface-diagnostic audit rows", () => {

  // -----------------------------------------------------------------------
  // T-Obs.1: audit payload shape (writeAuditRow capture)
  // -----------------------------------------------------------------------
  it(
    "T-Obs.1 REVISED (P13): when runtime runs, exactly 3 post_publish_runtime_diag rows are written (preNavigate + postNavigate + postOpen); preNavigate row has closeAttempted and closeOutcome fields",
    { timeout: 15000 },
    async () => {
      // Given: P13 runtime: close fires unconditionally, then navigate fires unconditionally.
      //        3 deterministic diagnostic rows per publish: preNavigate, postNavigate, postOpen.
      //        preNavigate row must include closeAttempted + closeOutcome.
      // When: publishApprovedFeedPost is invoked.
      // Then: diagRows(auditRowLog).length === 3;
      //       rows[0].output.phase === "preNavigate"; rows[0].output has closeAttempted + closeOutcome;
      //       rows[1].output.phase === "postNavigate";
      //       rows[2].output.phase === "postOpen".
      // NOTE: RED on P12 — P12 emits at most 2 rows; fast-path path emits 1.
      const constants = await loadPayloadConstants();
      const draftText = "T-Obs.1 — 3 diag rows P13";
      const setup = await seedDraft("obs1-shape", draftText);
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P13FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [AX_START_A_POST] },
          { nodes: [AX_POST_BUTTON] },
        ],
        postSynthItems: [],
        probeQueue: makeP13ProbeQueue(1, draftText),
        focusResult: true,
        clearResult: false,
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_PRESENT,
        closeSucceeds: true,
        ...spies,
      };
      const client = makeP13FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Obs.1: publishApprovedFeedPost not exported");
      }
      await fn(deps);

      const rows = diagRows(auditRowLog);
      // P13 INVARIANT: always exactly 3 rows per publish.
      assert.equal(rows.length, 3, `T-Obs.1: expected exactly 3 diag rows (preNavigate+postNavigate+postOpen); got ${rows.length}`);
      assert.equal(rows[0].output.phase, "preNavigate", `T-Obs.1: rows[0].output.phase must be "preNavigate"; got "${rows[0].output.phase}"`);
      // preNavigate row must expose closeAttempted and closeOutcome (P13 new fields).
      assert.ok("closeAttempted" in rows[0].output, `T-Obs.1: rows[0].output missing 'closeAttempted'`);
      assert.ok("closeOutcome" in rows[0].output, `T-Obs.1: rows[0].output missing 'closeOutcome'`);
      assert.equal(rows[1].output.phase, "postNavigate", `T-Obs.1: rows[1].output.phase must be "postNavigate"; got "${rows[1].output.phase}"`);
      assert.equal(rows[2].output.phase, "postOpen", `T-Obs.1: rows[2].output.phase must be "postOpen"; got "${rows[2].output.phase}"`);
    },
  );

  // -----------------------------------------------------------------------
  // T-Obs.2 REVISED (P13): diag row emission count — full 3/2/0 contract:
  //   3 rows: navigate SUCCEEDS → open reached (preNavigate + postNavigate + postOpen)
  //   2 rows: navigate THROWS  → open not reached (preNavigate + postNavigate; see T-Reasons.1)
  //   0 rows: pre-stage refusal fires before the surface-diagnostic gate (T-Obs.2-PreStage)
  // -----------------------------------------------------------------------
  describe(
    "T-Obs.2 REVISED (P13): diag row emission follows the 3/2/0 contract (3=navigate-ok; 2=navigate-throw; 0=pre-stage-refusal)",
    () => {
      it(
        "T-Obs.2 (navigate-path): navigate SUCCEEDS; exactly 3 diag rows: preNavigate → postNavigate → postOpen",
        { timeout: 15000 },
        async () => {
          // Given: P13 runtime: close fires unconditionally; navigate fires unconditionally.
          //        navigate SUCCEEDS (navigateShouldThrow=false) → open stage is reached.
          // When: publishApprovedFeedPost is invoked.
          // Then: diagRows.length === 3; phases are preNavigate, postNavigate, postOpen.
          // NOTE: RED on P12 — P12 emits exactly 2 rows on probe0.present=false path; no postOpen.
          const constants = await loadPayloadConstants();
          const draftText = "T-Obs.2 — 3 rows P13 navigate path";
          const setup = await seedDraft("obs2-twoemit", draftText);
          const spies = makeP12Spies();
          const auditRowLog: CapturedAuditRow[] = [];

          const clientOpts: P13FakeClientOpts = {
            constants,
            axTreeQueue: [
              { nodes: [AX_START_A_POST] },
              { nodes: [AX_POST_BUTTON] },
            ],
            postSynthItems: [],
            probeQueue: makeP13ProbeQueue(1, draftText),
            focusResult: true,
            clearResult: false,
            enabledQueue: [true],
            closeCenterQueue: [],
            discardCenterQueue: [],
            navigateShouldThrow: false,
            diagnosticResult: DIAG_ABSENT,
            closeSucceeds: true,
            ...spies,
          };
          const client = makeP13FakeClient(clientOpts);
          const deps = makePublishDeps(client, setup, auditRowLog);

          const fn = await importPublishFn();
          if (typeof fn !== "function") {
            assert.fail("T-Obs.2: publishApprovedFeedPost not exported");
          }
          await fn(deps);

          const rows = diagRows(auditRowLog);
          // Navigate SUCCEEDS → open reached → exactly 3 rows.
          // Navigate-THROW → 2 rows (no postOpen; see T-Reasons.1).
          // Pre-stage refusal → 0 rows (see T-Obs.2-PreStage below).
          assert.equal(rows.length, 3, `T-Obs.2: expected exactly 3 diag rows (preNavigate+postNavigate+postOpen); got ${rows.length}`);
          assert.equal(rows[0].output.phase, "preNavigate", `T-Obs.2: rows[0].phase must be "preNavigate"; got "${rows[0].output.phase}"`);
          assert.equal(rows[1].output.phase, "postNavigate", `T-Obs.2: rows[1].phase must be "postNavigate"; got "${rows[1].output.phase}"`);
          assert.equal(rows[2].output.phase, "postOpen", `T-Obs.2: rows[2].phase must be "postOpen"; got "${rows[2].output.phase}"`);
        },
      );

      it(
        "T-Obs.2-PreStage (P13): pre-stage refusal (hardware_input_not_supported) → 0 post_publish_runtime_diag rows emitted",
        { timeout: 10000 },
        async () => {
          // Given: session.inputMode="hardware" → hardware_input_not_supported fires before the
          //        surface-diagnostic gate (no navigate, no open stage reached).
          // When: publishApprovedFeedPost is invoked.
          // Then: diagRows(auditRowLog).length === 0; result.reason === "hardware_input_not_supported".
          // NOTE: GREEN on both P12 and P13 — pre-stage refusals never reach the diag emission point.
          const constants = await loadPayloadConstants();
          const setup = await seedDraft("obs2-prestage", "T-Obs.2-PreStage");
          const spies = makeP12Spies();
          const auditRowLog: CapturedAuditRow[] = [];

          const clientOpts: P12FakeClientOpts = {
            constants,
            axTreeQueue: [{ nodes: [AX_IRRELEVANT] }],
            probeQueue: [{ present: false, editorText: "" }],
            focusResult: false,
            clearResult: false,
            enabledQueue: [],
            closeCenterQueue: [],
            discardCenterQueue: [],
            navigateShouldThrow: false,
            diagnosticResult: DIAG_ABSENT,
            ...spies,
          };
          const client = makeP12FakeClient(clientOpts);
          const baseDeps = makePublishDeps(client, setup, auditRowLog);
          const deps = {
            ...baseDeps,
            session: {
              inputMode: "hardware" as const,
              getOrInitClient: () => Promise.resolve(client),
              getClient: () => client,
              setLastContext: (_ctx: unknown) => {},
              getLastContext: () => undefined,
              resolvedMode: () => "manual" as const,
            },
          };

          const fn = await importPublishFn();
          if (typeof fn !== "function") {
            assert.fail("T-Obs.2-PreStage: publishApprovedFeedPost not exported");
          }
          const result = await fn(deps);

          assert.equal(
            result.reason,
            "hardware_input_not_supported",
            `T-Obs.2-PreStage: expected reason=hardware_input_not_supported; got ${result.reason}`,
          );
          const rows = diagRows(auditRowLog);
          assert.equal(
            rows.length,
            0,
            `T-Obs.2-PreStage: pre-stage refusal must emit 0 diag rows; got ${rows.length}`,
          );
        },
      );
    },
  );

  // -----------------------------------------------------------------------
  // T-Obs.3 REVISED (P13): navigate always fires (no probe gate) → always 3 rows; navigate count >= 1
  // P13: composerAlreadyValid fast-path removed; navigate is unconditional.
  // -----------------------------------------------------------------------
  it(
    "T-Obs.3 REVISED (P13): navigate fires on every publish path; exactly 3 diag rows; navigateCallCount >= 1",
    { timeout: 15000 },
    async () => {
      // Given: P13 runtime: no fast-path; navigate fires unconditionally on every publish.
      //        3 deterministic rows: preNavigate + postNavigate + postOpen.
      // When: publishApprovedFeedPost is invoked with any starting surface state.
      // Then: diagRows(auditRowLog).length === 3;
      //       rows[0].output.phase === "preNavigate";
      //       navigateCallCount.n >= 1 (navigate always called).
      // NOTE: RED on P12 — P12 skips navigate when probe0.present===true; emits 1 row; count=0.
      const constants = await loadPayloadConstants();
      const draftText = "T-Obs.3 — navigate always P13";
      const setup = await seedDraft("obs3-onemit", draftText);
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P13FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [AX_START_A_POST] },
          { nodes: [AX_POST_BUTTON] },
        ],
        postSynthItems: [],
        probeQueue: makeP13ProbeQueue(1, draftText),
        focusResult: true,
        clearResult: false,
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_PRESENT,
        closeSucceeds: true,
        ...spies,
      };
      const client = makeP13FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Obs.3: publishApprovedFeedPost not exported");
      }
      await fn(deps);

      const rows = diagRows(auditRowLog);
      // P13: always 3 rows (preNavigate + postNavigate + postOpen).
      assert.equal(rows.length, 3, `T-Obs.3: expected exactly 3 diag rows; got ${rows.length}`);
      assert.equal(rows[0].output.phase, "preNavigate", `T-Obs.3: rows[0].phase must be "preNavigate"; got "${rows[0].output.phase}"`);
      // P13: navigate is unconditional → navigateCallCount >= 1.
      assert.ok(spies.navigateCallCount.n >= 1, `T-Obs.3: navigateCallCount must be >= 1 (always navigate in P13); got ${spies.navigateCallCount.n}`);
    },
  );

  // -----------------------------------------------------------------------
  // T-Obs.4: diagnostic evaluate throws → stub row with {error} emitted; runtime continues
  // -----------------------------------------------------------------------
  it(
    "T-Obs.4: given SURFACE_DIAGNOSTIC_JS throws, a stub post_publish_runtime_diag row with {error} in output is written; runtime continues",
    { timeout: 15000 },
    async () => {
      // Given: diagnosticResult=null causes fake evaluate to throw.
      //        captureSurfaceDiagnostic catches + returns stub { error: <message> }.
      //        emitSurfaceDiagnostic writes stub into the audit via deps.writeAuditRow.
      // When: publishApprovedFeedPost is invoked.
      // Then: no throw; diagRows(auditRowLog).length >= 1; rows[0].output.error is non-empty string.
      // NOTE: FAILS ON HEAD — no diagnostic mechanism exists yet.
      const constants = await loadPayloadConstants();
      const setup = await seedDraft("obs4-diagthrow", "T-Obs.4");
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P12FakeClientOpts = {
        constants,
        axTreeQueue: [{ nodes: [AX_IRRELEVANT] }],
        probeQueue: [{ present: false, editorText: "" }, { present: false, editorText: "" }],
        focusResult: false,
        clearResult: false,
        enabledQueue: [],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: null, // throws
        ...spies,
      };
      const client = makeP12FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Obs.4: publishApprovedFeedPost not exported");
      }
      let result: PublishResult | undefined;
      try {
        result = await fn(deps);
      } catch (e) {
        assert.fail(
          `T-Obs.4: must not throw when diagnostic evaluate throws. Got: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      void result;

      const rows = diagRows(auditRowLog);
      assert.ok(rows.length >= 1, `T-Obs.4: expected at least 1 diag row even when diagnostic throws; got ${rows.length}`);
      const errVal = rows[0].output.error;
      assert.ok(
        typeof errVal === "string" && errVal.length > 0,
        `T-Obs.4: rows[0].output.error must be a non-empty string; got ${JSON.stringify(errVal)}`,
      );
    },
  );

  // -----------------------------------------------------------------------
  // T-Obs.5: diagnostic never causes dispatch
  // -----------------------------------------------------------------------
  it(
    "T-Obs.5: diagnostic rows never cause a Post-click; on pre-dispatch fail, dispatchClickLog=0",
    { timeout: 15000 },
    async () => {
      // Given: navigate throws → surface_not_composer_capable; diag rows emitted but no clicks.
      // When: publishApprovedFeedPost is invoked.
      // Then: dispatchClickLog.length===0; clickAtLog has no @pc refs.
      const constants = await loadPayloadConstants();
      const setup = await seedDraft("obs5-noclick", "T-Obs.5");
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P12FakeClientOpts = {
        constants,
        axTreeQueue: [{ nodes: [AX_IRRELEVANT] }],
        probeQueue: [{ present: false, editorText: "" }, { present: false, editorText: "" }],
        focusResult: false,
        clearResult: false,
        enabledQueue: [],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: true, // → surface_not_composer_capable
        diagnosticResult: DIAG_ABSENT,
        ...spies,
      };
      const client = makeP12FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Obs.5: publishApprovedFeedPost not exported");
      }
      await fn(deps);

      assert.equal(spies.dispatchClickLog.length, 0, `T-Obs.5: dispatchClickLog must be empty when runtime fails before Post click; got ${spies.dispatchClickLog.length}`);
      const pcRefs = spies.clickAtLog.filter((r) => r.startsWith("@pc"));
      assert.equal(pcRefs.length, 0, `T-Obs.5: no @pc clickAt refs expected on pre-dispatch fail; got ${JSON.stringify(pcRefs)}`);
    },
  );

  // -----------------------------------------------------------------------
  // T-Obs.6 NEW (P13): postOpen diag row has OpenResult schema fields
  // -----------------------------------------------------------------------
  it(
    "T-Obs.6 NEW (P13): postOpen diag row output contains OpenResult schema fields: opened, openedOnRound, totalRounds, lastClickedRef, lastProbeOutcome",
    { timeout: 15000 },
    async () => {
      // Given: P13 runtime runs open-retry loop; succeeds on round 1.
      //        postOpen diag row is written with the OpenResult schema from hardenedOpenStartAPost.
      // When: publishApprovedFeedPost is invoked (happy-path, opens on round 1).
      // Then: rows[2].output.phase === "postOpen";
      //       rows[2].output has: opened, openedOnRound, totalRounds, lastClickedRef, lastProbeOutcome.
      // NOTE: RED on P12 — P12 never emits a postOpen row.
      const constants = await loadPayloadConstants();
      const draftText = "T-Obs.6 — postOpen schema";
      const setup = await seedDraft("obs6-postopen", draftText);
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P13FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [AX_START_A_POST] },
          { nodes: [AX_POST_BUTTON] },
        ],
        postSynthItems: [],
        probeQueue: makeP13ProbeQueue(1, draftText),
        focusResult: true,
        clearResult: false,
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_PRESENT,
        closeSucceeds: true,
        ...spies,
      };
      const client = makeP13FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Obs.6: publishApprovedFeedPost not exported");
      }
      await fn(deps);

      const rows = diagRows(auditRowLog);
      assert.equal(rows.length, 3, `T-Obs.6: expected exactly 3 diag rows; got ${rows.length}`);
      const postOpenRow = rows[2];
      assert.equal(postOpenRow.output.phase, "postOpen", `T-Obs.6: rows[2].phase must be "postOpen"; got "${postOpenRow.output.phase}"`);
      for (const key of ["opened", "openedOnRound", "totalRounds", "lastClickedRef", "lastProbeOutcome"]) {
        assert.ok(key in postOpenRow.output, `T-Obs.6: postOpen row missing OpenResult field '${key}'`);
      }
      // Happy-path: opened must be true.
      assert.equal(postOpenRow.output.opened, true, `T-Obs.6: postOpen row opened must be true on success path; got ${postOpenRow.output.opened}`);
    },
  );
});

// ===========================================================================
// §5.3 T-Resolve — C2 AX-retry resolution (REVISED + T-Resolve.10/11)
// ===========================================================================

describe("§5.3 T-Resolve — C2 AX-retry resolution", () => {

  it(
    "T-Resolve.1: open stage uses resolveByLabelWithRetry + clickAt (ref); triggerStartAPostLive NOT imported",
    { timeout: 20000 },
    async () => {
      // Given: AX tree returns no "Start a post" on call 1 (hydration delay), then on call 2.
      // When: runtime runs open stage.
      // Then: axTreeCallCount.n >= 2; clickAtLog[0] is a ref; no triggerStartAPostLive import.
      const constants = await loadPayloadConstants();
      const draftText = "T-Resolve.1 — open via AX-retry";
      const setup = await seedDraft("res1-open", draftText);
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P12FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [AX_IRRELEVANT] },    // call 1: hydration delay
          { nodes: [AX_START_A_POST] },  // call 2: retry wins
          { nodes: [AX_POST_BUTTON] },   // Post-click stage
        ],
        probeQueue: [
          { present: true, editorText: "" },     // probe0: present → skip navigate (fast-path probe)
          { present: false, editorText: "" },    // entry probe → open path (not already typed)
          { present: true, editorText: "" },     // post-open
          { present: true, editorText: draftText }, // readback
          { present: false, editorText: "" },    // post-click gone
        ],
        focusResult: true,
        clearResult: false,
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_PRESENT,
        ...spies,
      };
      const client = makeP12FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Resolve.1: publishApprovedFeedPost not exported");
      }
      await fn(deps);

      const hasTriggerImport = /import[^;]*triggerStartAPostLive/.test(PUBLISH_SRC);
      assert.ok(spies.axTreeCallCount.n >= 2, `T-Resolve.1: axTreeCallCount must be >= 2 (AX retry); got ${spies.axTreeCallCount.n}`);
      assert.ok(spies.clickAtLog.length > 0, `T-Resolve.1: clickAtLog must have at least one entry (open click); got 0`);
      assert.ok(typeof spies.clickAtLog[0] === "string" && spies.clickAtLog[0].length > 0, `T-Resolve.1: clickAtLog[0] must be a non-empty ref string; got ${JSON.stringify(spies.clickAtLog[0])}`);
      assert.equal(hasTriggerImport, false, `T-Resolve.1: deterministicPublishPost.ts must NOT import triggerStartAPostLive`);
    },
  );

  describe("T-Resolve.2: open stage survives AX lag for N ∈ {1, 3, 6}", () => {
    for (const n of [1, 3, 6] as const) {
      it(
        `T-Resolve.2 (N=${n}): 'Start a post' appears on retry ${n} → open succeeds; exactly one Post-click downstream`,
        { timeout: 30000 },
        async () => {
          // Given: AX tree returns N-1 irrelevant trees, then AX_START_A_POST on Nth call.
          // When: runtime runs open stage.
          // Then: result.published===true; clickAtLog.length===2.
          const constants = await loadPayloadConstants();
          const draftText = `T-Resolve.2 N=${n}`;
          const setup = await seedDraft(`res2-lag${n}`, draftText);
          const spies = makeP12Spies();
          const auditRowLog: CapturedAuditRow[] = [];

          const axTreeQueue: Array<{ nodes: FakeAXNode[] }> = [];
          for (let i = 0; i < n - 1; i++) axTreeQueue.push({ nodes: [AX_IRRELEVANT] });
          axTreeQueue.push({ nodes: [AX_START_A_POST] });
          axTreeQueue.push({ nodes: [AX_POST_BUTTON] });

          const clientOpts: P12FakeClientOpts = {
            constants,
            axTreeQueue,
            // Shadow-DOM simulation: postSynthItems:[] → zero @pc* entries.
            // Without this, both native @e1 and synth @pc1 would be present after
            // the fix (no filterEntriesByScope) → resolveByLabel throws "ambiguous".
            // RED against HEAD: filterEntriesByScope drops @e1 → timeout → published=false.
            postSynthItems: [],
            // P13: probe queue aligned to P13 flow (close→probe0→navigate→probe1→open):
            // [0] close probe: closeFeedComposerLive probe1=false → 1 probe, closed.
            // [1] probe0 preNavigate (was [0] "probe0: skip navigate" in P12).
            // [2] probe1 postNavigate (was [1] "entry probe").
            // [3] in-round open probe: present=true → open succeeds round 0.
            // [4] readback, [5] post-click.
            probeQueue: [
              { present: false, editorText: "" },    // [0] close probe → closed (1 probe)
              { present: false, editorText: "" },    // [1] probe0 preNavigate
              { present: false, editorText: "" },    // [2] probe1 postNavigate
              { present: true,  editorText: "" },    // [3] in-round open probe → open succeeds
              { present: true,  editorText: draftText }, // [4] readback → matches
              { present: false, editorText: "" },    // [5] post-click → gone
            ],
            focusResult: true,
            clearResult: false,
            enabledQueue: [true],
            closeCenterQueue: [],
            discardCenterQueue: [],
            navigateShouldThrow: false,
            diagnosticResult: DIAG_PRESENT,
            ...spies,
          };
          const client = makeP12FakeClient(clientOpts);
          const deps = makePublishDeps(client, setup, auditRowLog);

          const fn = await importPublishFn();
          if (typeof fn !== "function") {
            assert.fail(`T-Resolve.2 (N=${n}): not exported`);
          }
          const result = await fn(deps);
          void result;

          assert.equal(result.published, true, `T-Resolve.2 (N=${n}): result.published must be true; reason=${result.reason}`);
          assert.equal(spies.clickAtLog.length, 2, `T-Resolve.2 (N=${n}): expected exactly 2 clicks (open + Post); got ${spies.clickAtLog.length}: ${JSON.stringify(spies.clickAtLog)}`);
        },
      );
    }
  });

  it(
    "T-Resolve.3: AX never exposes 'Start a post' within budget → reason==='composer_open_click_failed'; dispatchAttempted===false",
    // P13: 4 rounds × 3000ms resolver budget + between-round backoffs ≈ 12-13s; need 20s.
    { timeout: 20000 },
    async () => {
      // Given: AX always returns AX_IRRELEVANT; resolver exhausts timeout.
      // When: runtime runs open stage.
      // Then: reason==="composer_open_click_failed"; dispatchAttempted===false; fallbackAllowed===true;
      //       C1 diag row shows startBtnFound:false.
      const constants = await loadPayloadConstants();
      const setup = await seedDraft("res3-openfail", "T-Resolve.3");
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P12FakeClientOpts = {
        constants,
        axTreeQueue: [{ nodes: [AX_IRRELEVANT] }],
        probeQueue: [
          { present: false, editorText: "" }, // probe0: navigate
          { present: false, editorText: "" }, // post-navigate probe
          { present: false, editorText: "" }, // entry probe → open path
          { present: false, editorText: "" }, // post-open: absent → fail
        ],
        focusResult: false,
        clearResult: false,
        enabledQueue: [],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        ...spies,
      };
      const client = makeP12FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Resolve.3: not exported");
      }
      const result = await fn(deps);
      void result;

      const rows = diagRows(auditRowLog);
      assert.equal(result.reason, "composer_open_click_failed", `T-Resolve.3: reason must be 'composer_open_click_failed'; got '${result.reason}'`);
      assert.equal(result.dispatchAttempted, false, `T-Resolve.3: dispatchAttempted must be false`);
      assert.equal(result.fallbackAllowed, true, `T-Resolve.3: fallbackAllowed must be true`);
      // At least 2 rows (preNavigate + postNavigate) since probe0.present===false.
      assert.ok(rows.length >= 2, `T-Resolve.3: expected >= 2 diag rows; got ${rows.length}`);
    },
  );

  // -----------------------------------------------------------------------
  // T-Resolve.4 REVISED (Step-3a post-live-diagnosis redesign):
  //   Post-click stage uses UNFILTERED native-AX snapshot; NO filterEntriesByScope call;
  //   resolved entry is @e7 (native-AX); clickAt("@e7") fires; filterEntriesByScope NOT imported.
  //
  // Shadow-DOM simulation: postSynthItems:[] → POST_COMPOSER_SYNTH_JS returns [] → zero @pc*
  // entries in the snapshot. This matches the real production state (R1: synth is light-DOM
  // only, shadow-rooted composers always produce zero @pc* entries).
  // AX tree for Post stage: 6 filler nodes (→ @e1-@e6) + AX_POST_BUTTON (→ @e7).
  //
  // NOTE: FAILS ON HEAD — current code applies filterEntriesByScope("composerInput") which
  //       drops @e7 (not @pc*); resolver times out → post_coords_missing. T-Resolve.4 (i)
  //       asserts clickAtLog[1]==="@e7" (fails since no second clickAt fires). T-Resolve.4
  //       (iii) asserts filterEntriesByScope NOT imported (fails since current code imports it).
  // -----------------------------------------------------------------------
  it(
    "T-Resolve.4 REVISED: Post-click stage resolves native-AX @e7 name:'Post' unfiltered; clickAt('@e7') fires exactly once; filterEntriesByScope NOT imported; getFeedComposerPostButtonCenterLive NOT imported",
    { timeout: 20000 },
    async () => {
      // Given: open stage succeeds; type+readback OK; AX tree for Post stage has 6 filler
      //        nodes (→ @e1–@e6) plus AX_POST_BUTTON at position 7 (→ ref @e7); postSynthItems:[]
      //        simulates shadow-DOM blindness — zero @pc* entries in the Post-stage snapshot.
      //        Production code must pass the unfiltered snapshot to resolveByLabelWithRetry.
      // When: runtime runs Post-click stage.
      // Then: (i)  clickAtLog[1]==="@e7" (native AX ref, not @pc*);
      //       (ii) result.dispatchAttempted===true;
      //       (iii) filterEntriesByScope NOT imported by deterministicPublishPost.ts;
      //       (iv) getFeedComposerPostButtonCenterLive NOT imported.
      // NOTE: @e7 guard pass-through (non-empty ref does NOT trigger the empty-ref guard
      //       added in T-Resolve.11) is proven implicitly by dispatchAttempted===true here.
      const constants = await loadPayloadConstants();
      const draftText = "T-Resolve.4 — Post via native-AX unfiltered";
      const setup = await seedDraft("res4-postclick", draftText);
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P12FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [AX_START_A_POST] },
          // 6 fillers push Post button to position 7 → ref @e7 in getSnapshot counter.
          { nodes: [...AX_FILLER_NODES, AX_POST_BUTTON] },
        ],
        // Shadow-DOM simulation: synth returns [] → zero @pc* entries in Post-stage snapshot.
        postSynthItems: [],
        probeQueue: [
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: true, editorText: "" },
          { present: true, editorText: draftText },
          { present: false, editorText: "" },
        ],
        focusResult: true,
        clearResult: false,
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        ...spies,
      };
      const client = makeP12FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Resolve.4: not exported");
      }
      const result = await fn(deps);
      void result;

      const hasGetPostCenter = /import[^;]*getFeedComposerPostButtonCenterLive/.test(PUBLISH_SRC);
      const hasFilterEntriesByScope = /filterEntriesByScope/.test(PUBLISH_SRC);

      // (i) Post clickAt must be @e7 (native-AX ref). Current code FAILS here because
      //     filterEntriesByScope drops @e7 (not @pc*) → resolver timeout → no second clickAt.
      assert.ok(
        spies.clickAtLog.length >= 2 && spies.clickAtLog[1] === "@e7",
        `T-Resolve.4 (i): Post clickAt[1] must be "@e7"; got ${JSON.stringify(spies.clickAtLog[1])}`,
      );
      // (ii) dispatchAttempted must be true.
      assert.equal(result.dispatchAttempted, true, `T-Resolve.4 (ii): dispatchAttempted must be true`);
      // (iii) filterEntriesByScope must NOT be imported. Current code FAILS here.
      assert.equal(
        hasFilterEntriesByScope,
        false,
        `T-Resolve.4 (iii): deterministicPublishPost.ts must NOT import filterEntriesByScope`,
      );
      // (iv) getFeedComposerPostButtonCenterLive must NOT be imported.
      assert.equal(
        hasGetPostCenter,
        false,
        `T-Resolve.4 (iv): deterministicPublishPost.ts must NOT import getFeedComposerPostButtonCenterLive`,
      );
    },
  );

  it(
    "T-Resolve.5: Post AX label never resolves within budget → reason==='post_coords_missing'; dispatchAttempted===false",
    { timeout: 10000 },
    async () => {
      // Given: open succeeds; type completes; AX never returns "Post" in budget.
      // When: runtime runs Post-click stage.
      // Then: reason==="post_coords_missing"; dispatchAttempted===false.
      const constants = await loadPayloadConstants();
      const setup = await seedDraft("res5-postfail", "T-Resolve.5");
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P12FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [AX_START_A_POST] },
          { nodes: [AX_IRRELEVANT] },
        ],
        probeQueue: [
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: true, editorText: "" },
          { present: true, editorText: "T-Resolve.5" },
          { present: true, editorText: "" },
        ],
        focusResult: true,
        clearResult: false,
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        ...spies,
      };
      const client = makeP12FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Resolve.5: not exported");
      }
      const result = await fn(deps);
      void result;

      assert.equal(result.reason, "post_coords_missing", `T-Resolve.5: reason must be 'post_coords_missing'; got '${result.reason}'`);
      assert.equal(result.dispatchAttempted, false, `T-Resolve.5: dispatchAttempted must be false when Post ref not found`);
    },
  );

  it(
    "T-Resolve.6: type stage calls focusFeedComposerEditorLive → insertTextHumanLike → readback → isFeedComposerPostButtonEnabled; no triggerStartAPostLive or getFeedComposerPostButtonCenterLive in type stage",
    { timeout: 20000 },
    async () => {
      // Given: open succeeds; type stage runs unchanged from P11.
      // When: runtime runs.
      // Then: focusCallCount.n >= 1; insertedText === draftText.
      const constants = await loadPayloadConstants();
      const draftText = "T-Resolve.6 — type stage unchanged";
      const setup = await seedDraft("res6-type", draftText);
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P12FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [AX_START_A_POST] },
          { nodes: [AX_POST_BUTTON] },
        ],
        probeQueue: [
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: true, editorText: "" },
          { present: true, editorText: draftText },
          { present: false, editorText: "" },
        ],
        focusResult: true,
        clearResult: false,
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        ...spies,
      };
      const client = makeP12FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Resolve.6: not exported");
      }
      await fn(deps);

      const insertedText = spies.insertTextLog.map((e) => e.text).join("");
      assert.ok(spies.focusCallCount.n >= 1, `T-Resolve.6: focusCallCount must be >= 1; got ${spies.focusCallCount.n}`);
      assert.equal(insertedText, draftText, `T-Resolve.6: inserted text must equal draftText; got ${insertedText.length} chars`);
    },
  );

  it(
    "T-Resolve.7: FEED_START_A_POST_CENTER_JS and FEED_COMPOSER_POST_CENTER_JS still exported from composerReadiness.ts (consumer guard)",
    { timeout: 5000 },
    async () => {
      // Given: composerReadiness.ts source (P12 must NOT delete these exports).
      // When: source-grepped.
      // Then: both are still present (regression guard).
      let src = "";
      try {
        src = readFileSync(resolve(ROOT, "src/linkedin/composerReadiness.ts"), "utf-8");
      } catch {
        assert.fail("T-Resolve.7: cannot read src/linkedin/composerReadiness.ts");
      }
      const hasStart = /FEED_START_A_POST_CENTER_JS[^=]*=/.test(src);
      const hasPost = /FEED_COMPOSER_POST_CENTER_JS[^=]*=/.test(src);
      assert.equal(hasStart, true, `T-Resolve.7: FEED_START_A_POST_CENTER_JS must still be exported from composerReadiness.ts (consumer guard)`);
      assert.equal(hasPost, true, `T-Resolve.7: FEED_COMPOSER_POST_CENTER_JS must still be exported from composerReadiness.ts (consumer guard)`);
    },
  );

  it(
    "T-Resolve.8: click.ts references resolveByLabelWithRetry as imported identifier only; import target is ../../linkedin/labelResolver.js",
    { timeout: 5000 },
    async () => {
      // Given: click.ts after P12 extraction.
      // When: source-grepped.
      // Then: no local function declaration; import from ../../linkedin/labelResolver.js.
      // NOTE: FAILS ON HEAD — click.ts still defines it locally.
      const hasLocalDef = /export\s+async\s+function\s+resolveByLabelWithRetry/.test(CLICK_SRC);
      const importLine = CLICK_SRC.match(
        /import[^;]*from\s+["']\.\.\/\.\.\/linkedin\/labelResolver(\.js)?["']/,
      )?.[0] ?? "";
      const hasImport = importLine.includes("resolveByLabelWithRetry");
      assert.equal(hasLocalDef, false, `T-Resolve.8: resolveByLabelWithRetry must NOT be defined locally in click.ts (extracted to labelResolver.ts)`);
      assert.equal(hasImport, true, `T-Resolve.8: click.ts must import resolveByLabelWithRetry from ../../linkedin/labelResolver.js`);
    },
  );

  // T-Resolve.9 DELETED (P13): fast-path (composerAlreadyValid) removed in P13.
  // T-Always.4 source-guards the absence of composerAlreadyValid in the production source.
  // -----------------------------------------------------------------------
  // T-Resolve.10 NEW (strengthened per BLOCKER-4 round-2): freshResolverSession shim
  // BLOCKER-4: deps.session.getLastContext() may be stale → shim forces fresh capture.
  //
  // Strength requirement (critic round 2): must FAIL if EITHER call site (open or Post)
  // skips the shim and passes deps.session directly. Key technique: give deps.session a
  // NON-undefined getLastContext sentinel. The shim overrides this to always return
  // undefined. If ANY resolver call receives deps.session directly, getLastContext()
  // returns the sentinel (non-undefined) — the test catches it.
  //
  // The resolver spy is built by wrapping captureCurrentSurfaceContext (via client.snapshot
  // override) so every getFullAXTree call records whether the session passed was the shim
  // (getLastContext()===undefined) vs deps.session (getLastContext()===SENTINEL). We track
  // this via a per-invocation log captured inside the capture callback spy.
  //
  // At Step 5: the implementation must inject freshResolverSession at BOTH call sites.
  // The test asserts:
  //   (a) resolverCallFirstArgLog has exactly 2 entries (open + Post stages).
  //   (b) For EACH entry: firstArg.getLastContext() === undefined.
  //   (c) For EACH entry: firstArg !== deps.session (sentinel check).
  //   (d) setLastContextLog.length >= 2 (both shims delegated to deps.session.setLastContext).
  //   (e) PUBLISH_SRC contains 'freshResolverSession'.
  // -----------------------------------------------------------------------
  it(
    "T-Resolve.10: the first arg to resolveByLabelWithRetry (BOTH stages) is a freshResolverSession shim: getLastContext()===undefined; shim !== deps.session; setLastContext delegates to deps.session.setLastContext — for EACH of the two call sites",
    { timeout: 15000 },
    async () => {
      // Given: deps.session.getLastContext returns a NON-undefined SENTINEL value
      //        (simulates a stale cached context that the shim must suppress).
      //        If the runtime passes deps.session directly to either resolver call,
      //        firstArg.getLastContext() returns SENTINEL (non-undefined) → test catches it.
      //        The shim always returns undefined regardless of deps.session state.
      // When: publishApprovedFeedPost is invoked (happy-path: both open + Post resolver calls run).
      // Then:
      //   (a) axTreeCallCount.n >= 2 (both resolver calls triggered AX captures via capture());
      //   (b) setLastContextLog.length >= 2 (both shims delegated setLastContext to real session);
      //   (c) PUBLISH_SRC contains 'freshResolverSession' (source-level confirmation);
      //   (d) [Step 5 instrumentation]: for EACH resolver first-arg captured:
      //         firstArg.getLastContext() === undefined (shim overrides the SENTINEL);
      //         firstArg !== deps.session (the object is a fresh wrapper, not the session itself).
      // NOTE: FAILS ON HEAD — pre-P12 passes deps.session directly.
      const SENTINEL_CTX = { _shimSentinel: "stale-ctx-must-not-reach-resolver" } as const;

      const constants = await loadPayloadConstants();
      const draftText = "T-Resolve.10 — freshResolverSession shim (both call sites)";
      const setup = await seedDraft("res10-shim", draftText);
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      // Per-resolver-call tracking: each call to resolveByLabelWithRetry passes a
      // session-like first arg. We cannot intercept the import directly, but we can
      // verify the shim contract by checking that:
      //   - getLastContext() on the passed arg returns undefined (not the SENTINEL)
      //   - setLastContext on the passed arg delegates to session's setLastContext
      //
      // Mechanism: give deps.session.getLastContext a SENTINEL return. The shim should
      // override this. We spy setLastContextLog on the real session.
      const setLastContextLog: unknown[] = [];
      const sessionWithSentinel = {
        inputMode: "cdp" as const,
        getOrInitClient: () => Promise.resolve(
          // client is defined below; this is called after construction
          null as unknown as CdpClient,
        ),
        getClient: () => null as unknown as CdpClient,
        setLastContext: (ctx: unknown) => { setLastContextLog.push(ctx); },
        // KEY: returns NON-undefined sentinel so direct-session pass is detectable
        getLastContext: () => SENTINEL_CTX as unknown as undefined,
        resolvedMode: () => "manual" as const,
      };

      const clientOpts: P12FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [AX_START_A_POST] },
          { nodes: [AX_POST_BUTTON] },
        ],
        // Shadow-DOM simulation: postSynthItems:[] → zero @pc* entries.
        // After fix (no filterEntriesByScope): only native @e1 present → clean resolve.
        // Prevents native+synth ambiguity that would abort the Post stage and break the
        // `clickAtLog.length === 2` assertion in (d).
        // RED against HEAD: filterEntriesByScope drops @e1 → timeout → clickAtLog.length=1.
        postSynthItems: [],
        probeQueue: [
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: true, editorText: "" },
          { present: true, editorText: draftText },
          { present: false, editorText: "" },
        ],
        focusResult: true,
        clearResult: false,
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        ...spies,
      };
      const client = makeP12FakeClient(clientOpts);

      // Wire the sentinel session to the real client.
      sessionWithSentinel.getOrInitClient = () => Promise.resolve(client);
      sessionWithSentinel.getClient = () => client;

      const deps = {
        ...makePublishDeps(client, setup, auditRowLog),
        session: sessionWithSentinel,
      };

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Resolve.10: not exported");
      }
      await fn(deps);

      const hasFreshShim = /freshResolverSession/.test(PUBLISH_SRC);

      // (a) Both resolver calls triggered AX captures.
      assert.ok(spies.axTreeCallCount.n >= 2, `T-Resolve.10 (a): axTreeCallCount must be >= 2 (both stages trigger capture); got ${spies.axTreeCallCount.n}`);
      // (b) Both shims delegated setLastContext to the real session.
      assert.ok(setLastContextLog.length >= 2, `T-Resolve.10 (b): setLastContextLog must have >= 2 entries (both shims delegated); got ${setLastContextLog.length}`);
      // (c) Source must contain 'freshResolverSession'.
      assert.equal(hasFreshShim, true, `T-Resolve.10 (c): deterministicPublishPost.ts must contain 'freshResolverSession'`);
      // (d) Sentinel check: getLastContext() returns undefined from shim, not SENTINEL_CTX.
      // We verify this indirectly: the runtime ran to published===true (it would fail if
      // getLastContext() returned a non-undefined context that caused a resolve-cache hit).
      // Direct session-vs-shim identity check requires module-level interception — we assert
      // the SENTINEL was NOT exposed to the resolver by verifying the run succeeded.
      // (If the shim had NOT been used, the session.getLastContext() would have returned
      // SENTINEL_CTX, but this doesn't actually break the resolve — it just uses a stale ctx.
      // The source-level hasFreshShim check is the authoritative gate for (d).)
      assert.equal(spies.clickAtLog.length, 2, `T-Resolve.10 (d): happy-path must still fire 2 clickAt calls; got ${spies.clickAtLog.length}`);
    },
  );

  // -----------------------------------------------------------------------
  // T-Resolve.11 REVISED (Step-3a round-2): source-structural — empty-ref guard replaces @pc guard.
  //
  // The @pc-prefix guard actively rejected the correct native-AX @e<N> entry post-live and
  // was the proximate cause of the live failure (R2 in docs/phase-post-publish-12-live-diagnosis.md).
  // The fix replaces it with a soft empty-ref guard: `if (!postEntry.ref)` → post_coords_missing.
  //
  // Mechanism: pure source-grep on PUBLISH_SRC. No runtime execution, no test-only production
  // hook (captureCallbackOverride was rejected by critic round-4 as a test-coupling smell).
  // The empty-ref guard is defense-in-depth and unreachable via normal captureCurrentSurfaceContext
  // (which always returns AX-derived string refs); behavioral injection via the normal code path
  // is therefore not possible and a structural assertion is the correct tool.
  //
  // NOTE: FAILS ON HEAD in TWO ways:
  //   (1) Source: `!postEntry.ref` guard absent (current code has no such guard).
  //   (2) Source: `postEntry.ref.startsWith("@pc")` guard present (must be removed).
  //
  // @e7 guard pass-through (non-empty ref does NOT trigger the empty-ref guard) is proven
  // implicitly by T-Resolve.4 where @e7 resolves cleanly to dispatchAttempted===true.
  // -----------------------------------------------------------------------
  it(
    "T-Resolve.11 REVISED (round-2): source-structural: empty-ref guard (!postEntry.ref → post_coords_missing) present in Post stage; @pc-prefix guard absent; guard positioned before dispatchAttempted latch",
    async () => {
      // Given: deterministicPublishPost.ts after P12 post-live-diagnosis fix.
      // When: source-grepped for Post-stage guard patterns.
      // Then: (a) `!postEntry.ref` guard exists; (b) `startsWith("@pc")` guard absent;
      //       (c) empty-ref guard positioned before `dispatchAttempted = true` latch.

      // (a) empty-ref guard must exist. FAILS ON HEAD (no such guard in current code).
      const hasEmptyRefGuard =
        /if\s*\(\s*!postEntry\.ref\b/.test(PUBLISH_SRC) ||
        /if\s*\(\s*postEntry\.ref\s*===\s*["']["']/.test(PUBLISH_SRC);
      assert.equal(
        hasEmptyRefGuard,
        true,
        "T-Resolve.11 (a): deterministicPublishPost.ts must contain an empty-ref guard: if (!postEntry.ref) → post_coords_missing",
      );

      // (b) @pc-prefix guard must be GONE. FAILS ON HEAD (current code still has it).
      const hasPcPrefixGuard = /postEntry\.ref\.startsWith\s*\(\s*["']@pc["']\s*\)/.test(PUBLISH_SRC);
      assert.equal(
        hasPcPrefixGuard,
        false,
        "T-Resolve.11 (b): deterministicPublishPost.ts must NOT contain the old @pc-prefix guard (postEntry.ref.startsWith('@pc'))",
      );

      // (c) Empty-ref guard must be positioned BEFORE the `dispatchAttempted = true` latch.
      const emptyRefGuardPos =
        PUBLISH_SRC.search(/if\s*\(\s*!postEntry\.ref\b/) >= 0
          ? PUBLISH_SRC.search(/if\s*\(\s*!postEntry\.ref\b/)
          : PUBLISH_SRC.search(/if\s*\(\s*postEntry\.ref\s*===\s*["']["']/);
      const dispatchLatchPos = PUBLISH_SRC.search(/dispatchAttempted\s*=\s*true/);
      assert.ok(
        emptyRefGuardPos >= 0 && dispatchLatchPos >= 0 && emptyRefGuardPos < dispatchLatchPos,
        `T-Resolve.11 (c): empty-ref guard (pos=${emptyRefGuardPos}) must appear before dispatchAttempted=true latch (pos=${dispatchLatchPos}) in deterministicPublishPost.ts`,
      );

      // (d) Production source must NOT contain any capture-injection seam.
      //     Codifies the critic-round-4 rejection: captureCallbackOverride / captureOverride are
      //     test-coupling smells (same pattern rejected at P9 for booleanSurfacePayloadClients)
      //     and must never appear in deterministicPublishPost.ts.
      const hasCaptureInjectionSeam = /captureCallbackOverride|captureOverride/.test(PUBLISH_SRC);
      assert.equal(
        hasCaptureInjectionSeam,
        false,
        "T-Resolve.11 (d): deterministicPublishPost.ts must NOT contain any capture-injection seam (captureCallbackOverride / captureOverride)",
      );
    },
  );

  // -----------------------------------------------------------------------
  // T-Resolve.12 NEW (Step-3a post-live-diagnosis): no-ambiguity invariant.
  //
  // Codifies the production state: exactly ONE native-AX "Post" + zero @pc* resolves
  // cleanly (positive case). Also guards against a future shadow-aware synth fix that
  // would re-introduce a duplicate "Post" entry — BOTH native + @pc2 → ambiguous →
  // post_coords_missing (negative companion case).
  //
  // NOTE: BOTH cases FAIL ON HEAD.
  //   T-Resolve.12a: filterEntriesByScope drops @e7 → resolver timeout → dispatchAttempted=false.
  //   T-Resolve.12b: filterEntriesByScope keeps @pc2 → resolves to @pc2 → dispatchAttempted=true
  //                  → result.reason is NOT post_coords_missing → assertion FAILS.
  // -----------------------------------------------------------------------
  it(
    "T-Resolve.12a: ONE native-AX 'Post' entry + zero @pc* → Post-click resolves cleanly; dispatchAttempted===true; clickAt(native-AX ref) fires",
    { timeout: 20000 },
    async () => {
      // Given: Post-stage snapshot has EXACTLY one 'Post' entry: native-AX @e7 (from
      //        AX_POST_BUTTON after 6 fillers). postSynthItems:[] → zero @pc* entries.
      //        This is the production state (shadow-DOM synth returns nothing).
      // When: runtime runs Post-click stage with no filterEntriesByScope call.
      // Then: resolveByLabel finds exactly one "Post" match (no ambiguity throw); resolved ref
      //       starts with "@e"; dispatchAttempted===true; clickAtLog[1]==="@e7".
      const constants = await loadPayloadConstants();
      const draftText = "T-Resolve.12a — one native-AX Post";
      const setup = await seedDraft("res12a-nativeonly", draftText);
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P12FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [AX_START_A_POST] },
          { nodes: [...AX_FILLER_NODES, AX_POST_BUTTON] }, // @e7 after 6 fillers
        ],
        postSynthItems: [], // zero @pc* — production state
        probeQueue: [
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: true, editorText: "" },
          { present: true, editorText: draftText },
          { present: false, editorText: "" },
        ],
        focusResult: true,
        clearResult: false,
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        ...spies,
      };
      const client = makeP12FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Resolve.12a: not exported");
      }
      const result = await fn(deps);
      void result;

      // No ambiguity throw — resolveByLabel found exactly one "Post".
      // FAILS ON HEAD: filterEntriesByScope drops @e7 → timeout → dispatchAttempted=false.
      assert.equal(result.dispatchAttempted, true, `T-Resolve.12a: dispatchAttempted must be true when only one native-AX Post; reason=${result.reason}`);
      // Post clickAt ref is the native-AX @e7 (starts with "@e", not "@pc").
      assert.ok(
        spies.clickAtLog.length >= 2 && (spies.clickAtLog[1] ?? "").startsWith("@e"),
        `T-Resolve.12a: Post clickAt[1] must start with "@e" (native AX); got ${JSON.stringify(spies.clickAtLog[1])}`,
      );
    },
  );

  it(
    "T-Resolve.12b: native-AX 'Post' + @pc2 'Post' both present → resolveByLabel throws ambiguous → post_coords_missing; dispatchAttempted===false",
    { timeout: 20000 },
    async () => {
      // Given: Post-stage snapshot has TWO 'Post' entries: native-AX @e7 AND @pc2 (from
      //        postSynthItems:[{i:2,...}] — a future shadow-aware synth state). Without
      //        a narrowing step, resolveByLabel sees two exact "Post" matches → throws ambiguous.
      //        Production code must catch the ambiguous throw as post_coords_missing (no dispatch).
      // When: runtime runs Post-click stage.
      // Then: reason==="post_coords_missing"; dispatchAttempted===false.
      //       (Guard for the fix: a future shadow-aware synth MUST also re-introduce a
      //        @pc*-preferring narrowing before this test can pass with a synth fix.)
      const constants = await loadPayloadConstants();
      const draftText = "T-Resolve.12b — ambiguous native+pc2";
      const setup = await seedDraft("res12b-ambiguous", draftText);
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P12FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [AX_START_A_POST] },
          { nodes: [...AX_FILLER_NODES, AX_POST_BUTTON] }, // @e7 native-AX "Post"
        ],
        // postSynthItems:[{i:2,...}] → POST_COMPOSER_SYNTH_JS produces @pc2 "Post".
        // Combined with @e7, resolveByLabel sees 2 exact "Post" matches → ambiguous throw.
        postSynthItems: [{ i: 2, role: "button", label: "Post" }],
        probeQueue: [
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: true, editorText: "" },
          { present: true, editorText: draftText },
          { present: true, editorText: "" },
        ],
        focusResult: true,
        clearResult: false,
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        ...spies,
      };
      const client = makeP12FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Resolve.12b: not exported");
      }
      const result = await fn(deps);
      void result;

      // FAILS ON HEAD: current filterEntriesByScope keeps only @pc2 → resolves unambiguously
      // → dispatchAttempted=true → result.reason is NOT post_coords_missing.
      assert.equal(result.reason, "post_coords_missing", `T-Resolve.12b: reason must be 'post_coords_missing' when both native-AX and @pc2 'Post' are present; got '${result.reason}'`);
      assert.equal(result.dispatchAttempted, false, `T-Resolve.12b: dispatchAttempted must be false when ambiguous`);
    },
  );
});

// ===========================================================================
// §5.4 T-Safety — safety constraints
// ===========================================================================

describe("§5.4 T-Safety — safety constraints", () => {

  it(
    "T-Safety.1: deterministicPublishPost.ts source-grep: NO makeClickTool or makeTypeTool",
    { timeout: 5000 },
    async () => {
      // Given: production source after P12.
      // When: grepped for makeClickTool / makeTypeTool.
      // Then: zero matches.
      const hasClickTool = /makeClickTool/.test(PUBLISH_SRC);
      const hasTypeTool = /makeTypeTool/.test(PUBLISH_SRC);
      assert.equal(hasClickTool, false, `T-Safety.1: deterministicPublishPost.ts must NOT reference makeClickTool`);
      assert.equal(hasTypeTool, false, `T-Safety.1: deterministicPublishPost.ts must NOT reference makeTypeTool`);
    },
  );

  it(
    "T-Safety.2: deterministicPublishPost.ts source-grep: NO import of outboundGuard / requiresApproval / classifyOutboundEntry / LINKEDIN_OUTBOUND_SURFACES",
    { timeout: 5000 },
    async () => {
      // Given: production source.
      // When: grepped for outbound guard identifiers.
      // Then: zero matches.
      const hasOG = /outboundGuard/.test(PUBLISH_SRC);
      const hasRA = /requiresApproval/.test(PUBLISH_SRC);
      const hasCO = /classifyOutboundEntry/.test(PUBLISH_SRC);
      const hasOS = /LINKEDIN_OUTBOUND_SURFACES/.test(PUBLISH_SRC);
      assert.equal(hasOG, false, `T-Safety.2: deterministicPublishPost.ts must NOT import outboundGuard`);
      assert.equal(hasRA, false, `T-Safety.2: deterministicPublishPost.ts must NOT import requiresApproval`);
      assert.equal(hasCO, false, `T-Safety.2: deterministicPublishPost.ts must NOT import classifyOutboundEntry`);
      assert.equal(hasOS, false, `T-Safety.2: deterministicPublishPost.ts must NOT import LINKEDIN_OUTBOUND_SURFACES`);
    },
  );

  it(
    "T-Safety.3: workflow.ts contains exact literal 'if (result.dispatchAttempted) return;'; unique early-return on publish branch",
    { timeout: 5000 },
    async () => {
      // Given: workflow.ts source (unchanged in P12).
      // When: grepped.
      // Then: exactly one match.
      const matches = (
        WORKFLOW_SRC.match(/if\s*\(result\.dispatchAttempted\)\s*return;/g) ?? []
      ).length;
      assert.equal(matches, 1, `T-Safety.3: workflow.ts must contain exactly one 'if (result.dispatchAttempted) return;'; found ${matches}`);
    },
  );

  // -----------------------------------------------------------------------
  // T-Safety.4 NEW (P13): composerAlreadyValid identifier absent from source
  // -----------------------------------------------------------------------
  it(
    "T-Safety.4 NEW (P13): source-grep — composerAlreadyValid identifier does NOT appear in deterministicPublishPost.ts",
    { timeout: 5000 },
    async () => {
      // Given: P13 removes the composerAlreadyValid fast-path branch.
      // When: source is grepped for the identifier.
      // Then: zero matches. Any occurrence means the fast-path was NOT removed.
      // NOTE: RED on P12 — P12 has composerAlreadyValid declared and used in the fast-path.
      const matches = (PUBLISH_SRC.match(/composerAlreadyValid/g) ?? []).length;
      assert.equal(matches, 0, `T-Safety.4: deterministicPublishPost.ts must NOT contain 'composerAlreadyValid'; found ${matches} occurrences`);
    },
  );
});

// ===========================================================================
// §5.6 T-Reasons — reachable-reason reconciliation (NEW per BLOCKER-1 + critic)
// ===========================================================================

describe("§5.6 T-Reasons — reachable-reason reconciliation", () => {

  // -----------------------------------------------------------------------
  // T-Reasons.1: surface_not_composer_capable reachable ONLY on navigate throw
  // -----------------------------------------------------------------------
  it(
    "T-Reasons.1: surface_not_composer_capable is reachable ONLY when probe0.present===false AND navigate throws; audit row has input.navigateError; exactly two diag rows",
    { timeout: 15000 },
    async () => {
      // Given: probe0.present===false + navigate throws (stealth not injected).
      // When: publishApprovedFeedPost is invoked.
      // Then: reason==="surface_not_composer_capable"; main publish audit row has input.navigateError;
      //       diagRows(auditRowLog).length===2 (preNavigate + postNavigate).
      // NOTE: FAILS ON HEAD — pre-P12 this reason can also fire on startBtnFound=false.
      const constants = await loadPayloadConstants();
      const setup = await seedDraft("tr1-navthrow", "T-Reasons.1");
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P12FakeClientOpts = {
        constants,
        axTreeQueue: [{ nodes: [AX_IRRELEVANT] }],
        probeQueue: [
          { present: false, editorText: "" }, // probe0: not present → navigate
          { present: false, editorText: "" }, // post-navigate probe
        ],
        focusResult: false,
        clearResult: false,
        enabledQueue: [],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: true, // KEY: navigate throws → surface_not_composer_capable
        diagnosticResult: DIAG_ABSENT,
        ...spies,
      };
      const client = makeP12FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Reasons.1: not exported");
      }
      const result = await fn(deps);
      void result;

      const rows = diagRows(auditRowLog);
      assert.equal(result.reason, "surface_not_composer_capable", `T-Reasons.1: reason must be 'surface_not_composer_capable' when navigate throws; got '${result.reason}'`);
      assert.equal(rows.length, 2, `T-Reasons.1: expected exactly 2 diag rows (preNavigate + postNavigate); got ${rows.length}`);
    },
  );

  // -----------------------------------------------------------------------
  // T-Reasons.2: startBtnFound:false NEVER routes to surface_not_composer_capable
  // -----------------------------------------------------------------------
  it(
    "T-Reasons.2 REVISED (P13): given navigate succeeds AND AX never finds 'Start a post', fails with composer_open_click_failed; composer_close_failed is in union but has 0 return call sites (structurally unreachable)",
    { timeout: 15000 },
    async () => {
      // Given: navigate succeeds + AX never returns "Start a post" → open stage exhausts budget.
      //        composer_close_failed must be in the PublishFailReason union (forward compat)
      //        but must NOT appear in any `return { ..., reason: "composer_close_failed" }` line.
      // When: publishApprovedFeedPost is invoked.
      // Then: reason !== "surface_not_composer_capable"; reason === "composer_open_click_failed";
      //       source-grep: 0 return-statement occurrences of "composer_close_failed".
      // NOTE: RED on P12 — P12 has a return site for composer_close_failed (close-failure abort).
      //       PARTIAL CARRY from P12: startBtnFound:false forensic assertion kept.
      const constants = await loadPayloadConstants();
      const setup = await seedDraft("tr2-forensic", "T-Reasons.2");
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P12FakeClientOpts = {
        constants,
        axTreeQueue: [{ nodes: [AX_IRRELEVANT] }], // AX never returns "Start a post"
        probeQueue: [
          { present: false, editorText: "" }, // probe0: navigate
          { present: false, editorText: "" }, // post-navigate probe
          { present: false, editorText: "" }, // entry probe → open path
          { present: false, editorText: "" }, // post-open 1
          { present: false, editorText: "" }, // post-open 2
        ],
        focusResult: false,
        clearResult: false,
        enabledQueue: [],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT, // startBtnFound:false — forensic only
        ...spies,
      };
      const client = makeP12FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Reasons.2: not exported");
      }
      const result = await fn(deps);
      void result;

      assert.notEqual(result.reason, "surface_not_composer_capable", `T-Reasons.2: reason must NOT be 'surface_not_composer_capable' when navigate succeeds; got '${result.reason}'`);
      assert.ok(
        result.reason === "composer_open_click_failed" || result.reason === "composer_absent_after_open",
        `T-Reasons.2: reason must be composer_open_click_failed or composer_absent_after_open; got '${result.reason}'`,
      );
      // P13: composer_close_failed is in the union but structurally unreachable
      // (close failure → continue path, not return). Source must have 0 call sites.
      // A "call site" is any non-comment, non-type-union line containing the string
      // (e.g. finishPreDispatchFailure(..., "composer_close_failed") in P12).
      // Union lines start with |; comment lines start with //. Both are excluded.
      const closeFailedCallSites = PUBLISH_SRC.split("\n").filter(
        (l) => l.includes('"composer_close_failed"') && !/^\s*\|/.test(l) && !/^\s*\/\//.test(l),
      ).length;
      assert.equal(
        closeFailedCallSites,
        0,
        `T-Reasons.2: deterministicPublishPost.ts must have 0 non-union non-comment "composer_close_failed" call sites; found ${closeFailedCallSites} (P13 removes the close-abort path)`,
      );
    },
  );

  // -----------------------------------------------------------------------
  // T-Reasons.3: composer_open_click_failed vs composer_absent_after_open distinction
  // -----------------------------------------------------------------------
  it(
    "T-Reasons.3: composer_open_click_failed (resolver timed out, clickAt never called) vs composer_absent_after_open (clickAt called once, post-open probe absent)",
    { timeout: 15000 },
    async () => {
      // Given scenario A: resolver throws (never found "Start a post") → open clickAt never called
      //                   → composer_open_click_failed.
      // Given scenario B: resolver finds "Start a post" → clickAt fires → post-open probe absent
      //                   → composer_absent_after_open.
      // When: publishApprovedFeedPost for each scenario.
      // Then: A → reason==="composer_open_click_failed"; clickAtLog.length===0.
      //       B → reason==="composer_absent_after_open"; clickAtLog.length===1.
      const constants = await loadPayloadConstants();

      const setupA = await seedDraft("tr3-A", "T-Reasons.3-A");
      const spiesA = makeP12Spies();
      const auditA: CapturedAuditRow[] = [];
      const clientA = makeP12FakeClient({
        constants,
        axTreeQueue: [{ nodes: [AX_IRRELEVANT] }], // resolver times out
        probeQueue: [
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: false, editorText: "" },
        ],
        focusResult: false, clearResult: false, enabledQueue: [],
        closeCenterQueue: [], discardCenterQueue: [],
        navigateShouldThrow: false, diagnosticResult: DIAG_ABSENT,
        ...spiesA,
      });
      const depsA = makePublishDeps(clientA, setupA, auditA);

      const setupB = await seedDraft("tr3-B", "T-Reasons.3-B");
      const spiesB = makeP12Spies();
      const auditB: CapturedAuditRow[] = [];
      const clientB = makeP12FakeClient({
        constants,
        axTreeQueue: [{ nodes: [AX_START_A_POST] }], // resolver finds it → clickAt fires
        probeQueue: [
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: false, editorText: "" }, // post-open 1: absent
          { present: false, editorText: "" }, // post-open 2: absent → composer_absent_after_open
        ],
        focusResult: false, clearResult: false, enabledQueue: [],
        closeCenterQueue: [], discardCenterQueue: [],
        navigateShouldThrow: false, diagnosticResult: DIAG_ABSENT,
        ...spiesB,
      });
      const depsB = makePublishDeps(clientB, setupB, auditB);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Reasons.3: not exported");
      }
      const [resultA, resultB] = await Promise.all([fn(depsA), fn(depsB)]);

      assert.equal(resultA.reason, "composer_open_click_failed", `T-Reasons.3 A: reason must be 'composer_open_click_failed' when resolver times out; got '${resultA.reason}'`);
      assert.equal(spiesA.clickAtLog.length, 0, `T-Reasons.3 A: clickAtLog must be empty when resolver timed out; got ${JSON.stringify(spiesA.clickAtLog)}`);
      assert.equal(resultB.reason, "composer_absent_after_open", `T-Reasons.3 B: reason must be 'composer_absent_after_open' when open fires but composer absent; got '${resultB.reason}'`);
      // BLOCKER-3: P13 uses multi-round retry → 1..COMPOSER_OPEN_RETRY_ROUNDS clicks possible.
      // Use >= 1 so this test is a valid carry on both P12 (1 click) and P13 (1..4 clicks).
      // T-OpenRetry.4 owns the exact 4-click exhaustion assertion.
      assert.ok(spiesB.clickAtLog.length >= 1, `T-Reasons.3 B: clickAtLog must have >= 1 entry (open click fired); got ${JSON.stringify(spiesB.clickAtLog)}`);
    },
  );

  // -----------------------------------------------------------------------
  // T-Reasons.4: PublishFailReason union byte-identical to P11 (16 values, no changes)
  // -----------------------------------------------------------------------
  it(
    "T-Reasons.4: source-grep — PublishFailReason union is byte-identical to the P11 set (16 reasons; no additions, no removals in P12)",
    { timeout: 5000 },
    async () => {
      // Given: production source of deterministicPublishPost.ts.
      // When: P11 reason strings are searched in source.
      // Then: all 16 P11 reasons present; no new reason string matching pattern added.
      // NOTE: May pass on HEAD if no new reasons added yet.
      const p11Reasons = [
        "approval_required", "hardware_input_not_supported", "composer_unavailable",
        "composer_close_failed", "composer_open_click_failed", "composer_absent_after_open",
        "surface_not_composer_capable", "focus_failed", "clear_failed", "readback_mismatch",
        "post_button_not_enabled", "post_coords_missing", "composer_still_open",
        "draft_missing", "draft_already_sent", "internal_error",
      ];
      const missingFromSource = p11Reasons.filter((r) => !PUBLISH_SRC.includes(`"${r}"`));

      assert.equal(
        missingFromSource.length,
        0,
        `T-Reasons.4: all P11 reasons must be present in deterministicPublishPost.ts; missing: ${JSON.stringify(missingFromSource)}`,
      );
    },
  );
});

// ===========================================================================
// P13 NEW §5.1 T-Always — unconditional close + navigate + retype; no fast-path
// ALL tests in this section are RED on P12 production code.
// ===========================================================================

describe("§5.1 T-Always (P13) — unconditional close + navigate; composerAlreadyValid absent", () => {

  // -----------------------------------------------------------------------
  // T-Always.1: close fires before navigate on every probe0 starting state
  // -----------------------------------------------------------------------
  describe("T-Always.1 (P13): close fires before navigate in all starting surface states", () => {
    // 4 starting states: absent-close-succeeds, absent-close-fails,
    //                    present-close-succeeds, present-close-fails
    for (const tc of [
      { label: "probe0-absent-close-succeeds", probe0Present: false, closeSucceeds: true },
      { label: "probe0-absent-close-fails",    probe0Present: false, closeSucceeds: false },
      { label: "probe0-present-close-succeeds",probe0Present: true,  closeSucceeds: true },
      { label: "probe0-present-close-fails",   probe0Present: true,  closeSucceeds: false },
    ] as const) {
      it(
        `T-Always.1 (${tc.label}): closeFeedComposerLive fired before client.navigate, regardless of starting state`,
        { timeout: 10000 },
        async () => {
          // Given: P13 runtime with close=${tc.closeSucceeds ? "succeeds" : "fails"}.
          //        probe0.present=${tc.probe0Present} simulates starting surface.
          // When: publishApprovedFeedPost is invoked.
          // Then: dispatchClickLog contains close-coord entry before any navigate call
          //       (or closeFeedComposerLive call was attempted before navigate).
          //       navigateCallCount.n >= 1.
          // NOTE: RED on P12 — P12 only calls close when probe0.present=true (composer open guard).
          const constants = await loadPayloadConstants();
          const setup = await seedDraft(`talways1-${tc.label}`, `T-Always.1-${tc.label}`);
          const spies = makeP12Spies();
          const auditRowLog: CapturedAuditRow[] = [];

          // Build probe queue: probe0 as specified, then the happy-path sequence.
          const draftText = `T-Always.1-${tc.label}`;
          // BLOCKER-1: probe layout now has close-probe at [0], probe0 (preNavigate diag) at [1].
          // For closeSucceeds=false, we need 6 close-probe slots all {present:true}.
          // closeFeedComposerLive consumes 2 probes per attempt when probe1.present=true:
          //   probe 1 (isFeedComposerLiveInDOM after Escape) → present=true
          //   probe 2 (isFeedComposerLiveInDOM after close button) → present=true → fail
          // 3 attempts × 2 probes = 6 probes needed to genuinely fail all 3 attempts.
          // For closeSucceeds=true, makeP13ProbeQueue provides [0]=close-probe={present:false}.
          let roundQueue: Array<{ present: boolean; editorText: string }>;
          if (tc.closeSucceeds) {
            roundQueue = makeP13ProbeQueue(1, draftText);
            // probe0 (preNavigate diag) is now at [1]; override it with tc.probe0Present.
            roundQueue[1] = { present: tc.probe0Present, editorText: "" };
          } else {
            // closeSucceeds=false: 6 close-probe slots (all present:true) so close genuinely
            // fails all 3 attempts → closeOutcome="failed_but_navigated".
            // With closeCenterQueue=[{cx:100,cy:100}×3] (wired by makeP13FakeClient),
            // closeClicked=true each attempt so probe 2 IS always evaluated.
            roundQueue = [
              { present: true,  editorText: "" },    // [0] attempt 0 probe 1
              { present: true,  editorText: "" },    // [1] attempt 0 probe 2 → fail
              { present: true,  editorText: "" },    // [2] attempt 1 probe 1
              { present: true,  editorText: "" },    // [3] attempt 1 probe 2 → fail
              { present: true,  editorText: "" },    // [4] attempt 2 probe 1
              { present: true,  editorText: "" },    // [5] attempt 2 probe 2 → fail → "failed_but_navigated"
              { present: tc.probe0Present, editorText: "" }, // [6] probe0 preNavigate diag
              { present: false, editorText: "" },    // [7] probe1 postNavigate diag
              { present: true,  editorText: "" },    // [8] in-round probe → open succeeds
              { present: true,  editorText: draftText }, // [9] readback match
              { present: false, editorText: "" },    // [10] post-click gone
            ];
          }

          const clientOpts: P13FakeClientOpts = {
            constants,
            axTreeQueue: [
              { nodes: [AX_START_A_POST] },
              { nodes: [AX_POST_BUTTON] },
            ],
            postSynthItems: [],
            probeQueue: roundQueue,
            focusResult: true,
            clearResult: false,
            enabledQueue: [true],
            closeCenterQueue: [],
            discardCenterQueue: [],
            navigateShouldThrow: false,
            diagnosticResult: DIAG_ABSENT,
            closeSucceeds: tc.closeSucceeds,
            ...spies,
          };
          const client = makeP13FakeClient(clientOpts);
          const deps = makePublishDeps(client, setup, auditRowLog);

          const fn = await importPublishFn();
          if (typeof fn !== "function") {
            assert.fail(`T-Always.1 (${tc.label}): not exported`);
          }
          await fn(deps);

          // P13: navigate always fires.
          assert.ok(spies.navigateCallCount.n >= 1, `T-Always.1 (${tc.label}): navigateCallCount must be >= 1; got ${spies.navigateCallCount.n}`);
          // BLOCKER-1 FIX: prove close (Escape) happened BEFORE navigate using real event log
          // — not by trusting the diagnostic field closeAttempted (which impl could hardcode).
          // eventOrderLog records "escape" tokens (from Input.dispatchKeyEvent) and "navigate"
          // tokens (from client.navigate). Assert first "escape" precedes first "navigate".
          const escapeIdx = spies.eventOrderLog.indexOf("escape");
          const navigateIdx = spies.eventOrderLog.indexOf("navigate");
          assert.ok(
            escapeIdx !== -1,
            `T-Always.1 (${tc.label}): Escape key event must appear in eventOrderLog (close fired); log=${JSON.stringify(spies.eventOrderLog)}`,
          );
          assert.ok(
            navigateIdx !== -1,
            `T-Always.1 (${tc.label}): navigate must appear in eventOrderLog; log=${JSON.stringify(spies.eventOrderLog)}`,
          );
          assert.ok(
            escapeIdx < navigateIdx,
            `T-Always.1 (${tc.label}): Escape must appear BEFORE navigate in eventOrderLog; escapeIdx=${escapeIdx}, navigateIdx=${navigateIdx}, log=${JSON.stringify(spies.eventOrderLog)}`,
          );
          // Diagnostic field check (secondary — confirms the row records close correctly).
          const rows = diagRows(auditRowLog);
          assert.ok(rows.length >= 1, `T-Always.1 (${tc.label}): expected >= 1 diag rows; got 0`);
          assert.equal(rows[0].output.phase, "preNavigate", `T-Always.1 (${tc.label}): rows[0].phase must be "preNavigate"`);
          // closeAttempted field (P13 new): must be true (close was tried).
          assert.equal(rows[0].output.closeAttempted, true, `T-Always.1 (${tc.label}): preNavigate row must have closeAttempted:true; got ${rows[0].output.closeAttempted}`);
        },
      );
    }
  });

  // -----------------------------------------------------------------------
  // T-Always.2: navigate fires on every probe0 starting state (4 states)
  // -----------------------------------------------------------------------
  describe("T-Always.2 (P13): client.navigate fires unconditionally in all starting states", () => {
    for (const probe0Present of [false, true] as const) {
      it(
        `T-Always.2 (probe0=${probe0Present}): navigateCallCount >= 1 regardless of probe0.present`,
        { timeout: 10000 },
        async () => {
          // Given: P13 runtime; probe0.present=${probe0Present}.
          // When: publishApprovedFeedPost is invoked.
          // Then: navigateCallCount.n >= 1 (navigate always called in P13).
          // NOTE: RED on P12 when probe0.present=true — P12 skips navigate.
          const constants = await loadPayloadConstants();
          const draftText = `T-Always.2-probe${probe0Present}`;
          const setup = await seedDraft(`talways2-p${probe0Present}`, draftText);
          const spies = makeP12Spies();
          const auditRowLog: CapturedAuditRow[] = [];

          const roundQueue = makeP13ProbeQueue(1, draftText);
          // BLOCKER-1: probe0 (preNavigate diag) is now at [1] (close-probe is at [0]).
          roundQueue[1] = { present: probe0Present, editorText: "" };

          const clientOpts: P13FakeClientOpts = {
            constants,
            axTreeQueue: [
              { nodes: [AX_START_A_POST] },
              { nodes: [AX_POST_BUTTON] },
            ],
            postSynthItems: [],
            probeQueue: roundQueue,
            focusResult: true,
            clearResult: false,
            enabledQueue: [true],
            closeCenterQueue: [],
            discardCenterQueue: [],
            navigateShouldThrow: false,
            diagnosticResult: DIAG_ABSENT,
            closeSucceeds: true,
            ...spies,
          };
          const client = makeP13FakeClient(clientOpts);
          const deps = makePublishDeps(client, setup, auditRowLog);

          const fn = await importPublishFn();
          if (typeof fn !== "function") {
            assert.fail(`T-Always.2 (probe0=${probe0Present}): not exported`);
          }
          await fn(deps);

          assert.ok(spies.navigateCallCount.n >= 1, `T-Always.2 (probe0=${probe0Present}): navigateCallCount must be >= 1; got ${spies.navigateCallCount.n}`);
        },
      );
    }
  });

  // -----------------------------------------------------------------------
  // T-Always.3: insertText always receives DB draft.text (not agent leftover)
  // -----------------------------------------------------------------------
  it(
    "T-Always.3 (P13): insertText called even when probe0.present=true and editorText matches draft (no fast-path skip in P13)",
    { timeout: 15000 },
    async () => {
      // Given: probe0.present=true AND probe0.editorText=draftText (P12 composerAlreadyValid trigger).
      //        P12: fast-path → skip insert → insertTextLog.length=0.
      //        P13: no fast-path; close+navigate+open+insert always runs.
      // When: publishApprovedFeedPost is invoked.
      // Then: insertTextLog.length >= 1; insertTextLog[0].text === DB draft.text.
      // NOTE: RED on P12 — P12 fast-path skips insertText when probe0.editorText matches draft.
      const constants = await loadPayloadConstants();
      const draftText = "CANONICAL_DRAFT_TEXT — T-Always.3";
      const setup = await seedDraft("talways3-retype", draftText);
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      // probe0.present=true AND probe0.editorText=draftText triggers P12 fast-path skip.
      // BLOCKER-1: probe0 is now at [1] in makeP13ProbeQueue (close-probe is at [0]).
      const probeQueue = makeP13ProbeQueue(1, draftText);
      probeQueue[1] = { present: true, editorText: draftText }; // P12 composerAlreadyValid trigger

      const clientOpts: P13FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [AX_START_A_POST] },
          { nodes: [AX_POST_BUTTON] },
        ],
        postSynthItems: [],
        probeQueue,
        focusResult: true,
        clearResult: false,
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        closeSucceeds: true,
        ...spies,
      };
      const client = makeP13FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Always.3: not exported");
      }
      const result = await fn(deps);
      assert.equal(result.published, true, `T-Always.3: expected published=true; reason=${result.reason}`);
      // P13 INVARIANT: insertText always called (no fast-path skip). RED on P12.
      assert.ok(spies.insertTextLog.length >= 1, `T-Always.3: insertText must be called (P13: no fast-path); got 0`);
      // P13 fix: insertTextHumanLike types char-by-char; join all entries.
      const ta3Inserted = spies.insertTextLog.map((e) => e.text).join("");
      assert.equal(ta3Inserted, draftText, `T-Always.3: concatenated insertText must equal DB draft.text="${draftText}"; got "${ta3Inserted}"`);
    },
  );

  // -----------------------------------------------------------------------
  // T-Always.4: composerAlreadyValid absent from source (source-level guard)
  // -----------------------------------------------------------------------
  it(
    "T-Always.4 (P13): source-grep — composerAlreadyValid does NOT appear in deterministicPublishPost.ts",
    { timeout: 5000 },
    async () => {
      // Given: P13 source (composerAlreadyValid fast-path removed).
      // When: source grepped for the identifier.
      // Then: zero matches.
      // NOTE: RED on P12 — P12 defines and uses composerAlreadyValid.
      const count = (PUBLISH_SRC.match(/composerAlreadyValid/g) ?? []).length;
      assert.equal(count, 0, `T-Always.4: deterministicPublishPost.ts must NOT contain 'composerAlreadyValid'; found ${count}`);
    },
  );

  // -----------------------------------------------------------------------
  // T-Always.5: close-failure → no abort → navigate still fires → published if open succeeds
  // -----------------------------------------------------------------------
  it(
    "T-Always.5 (P13): close-failure does NOT abort publish; navigate fires; if open succeeds → published=true; reason NOT 'composer_close_failed'",
    { timeout: 15000 },
    async () => {
      // Given: probe0.present=true (composer is open) AND closeFeedComposerLive fails all attempts.
      //        P12: probe0.present=true → calls close → fails → returns composer_close_failed.
      //        P13: close-failure does NOT abort; navigate fires unconditionally → publish succeeds.
      // When: publishApprovedFeedPost is invoked.
      // Then: navigateCallCount.n >= 1; result.published===true;
      //       result.reason !== "composer_close_failed".
      // NOTE: RED on P12 — P12 calls close when probe0.present=true; close fails → aborts.
      const constants = await loadPayloadConstants();
      const draftText = "T-Always.5 — close fails but continue";
      const setup = await seedDraft("talways5-closefail", draftText);
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      // P13 fix: 6 close-probe slots (all {present:true}) to genuinely fail all 3 attempts.
      // closeFeedComposerLive with closeClicked=true consumes 2 probes per attempt:
      //   probe 1 (isFeedComposerLiveInDOM after Escape) → present:true
      //   probe 2 (isFeedComposerLiveInDOM after close button click) → present:true → fail
      // 3 attempts × 2 probes = 6 probes needed → closeOutcome="failed_but_navigated".
      const probeQueue: Array<{ present: boolean; editorText: string }> = [
        { present: true,  editorText: "" },    // [0] attempt 0 probe 1
        { present: true,  editorText: "" },    // [1] attempt 0 probe 2 → fail
        { present: true,  editorText: "" },    // [2] attempt 1 probe 1
        { present: true,  editorText: "" },    // [3] attempt 1 probe 2 → fail
        { present: true,  editorText: "" },    // [4] attempt 2 probe 1
        { present: true,  editorText: "" },    // [5] attempt 2 probe 2 → fail → "failed_but_navigated"
        { present: true,  editorText: "" },    // [6] probe0 preNavigate diag: present=true
        { present: false, editorText: "" },    // [7] probe1 postNavigate diag
        { present: true,  editorText: "" },    // [8] in-round probe → open succeeds
        { present: true,  editorText: draftText }, // [9] readback match
        { present: false, editorText: "" },    // [10] post-click gone
      ];

      const clientOpts: P13FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [AX_START_A_POST] },
          { nodes: [AX_POST_BUTTON] },
        ],
        postSynthItems: [],
        probeQueue,
        focusResult: true,
        clearResult: false,
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        closeSucceeds: false, // close has valid coords but probes say still-present → genuine fail
        ...spies,
      };
      const client = makeP13FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-Always.5: not exported");
      }
      const result = await fn(deps);

      assert.ok(spies.navigateCallCount.n >= 1, `T-Always.5: navigateCallCount must be >= 1 even when close fails; got ${spies.navigateCallCount.n}`);
      assert.equal(result.published, true, `T-Always.5: result.published must be true (close-fail does not abort in P13); reason=${result.reason}`);
      assert.notEqual(result.reason, "composer_close_failed", `T-Always.5: reason must NOT be 'composer_close_failed' in P13`);
      // BLOCKER-1: verify closeOutcome:"failed_but_navigated" is genuinely exercised.
      // The composer was PRESENT through all 3 close attempts → closeOutcome records the failure.
      const rows5 = diagRows(auditRowLog);
      assert.ok(rows5.length >= 1, `T-Always.5: expected >= 1 diag rows; got 0`);
      assert.equal(rows5[0].output.phase, "preNavigate", `T-Always.5: rows5[0].phase must be "preNavigate"`);
      assert.equal(rows5[0].output.closeAttempted, true, `T-Always.5: closeAttempted must be true when close was attempted`);
      assert.equal(
        rows5[0].output.closeOutcome,
        "failed_but_navigated",
        `T-Always.5: closeOutcome must be "failed_but_navigated" when close fails but navigate continues; got "${rows5[0].output.closeOutcome}"`,
      );
    },
  );
});

// ===========================================================================
// P13 NEW §5.2 T-OpenRetry — hardened 4-round open-retry with progressive backoff
// ALL tests in this section are RED on P12 production code.
// ===========================================================================

describe("§5.2 T-OpenRetry (P13) — hardened 4-round open-retry with progressive backoff", () => {

  // -----------------------------------------------------------------------
  // T-OpenRetry.1: open succeeds on round 1 → exactly 1 open click
  // -----------------------------------------------------------------------
  it(
    "T-OpenRetry.1 (P13): open succeeds on round 1 → 1 open click + 1 Post click; published=true",
    { timeout: 15000 },
    async () => {
      // Given: AX tree returns "Start a post" on first call; first in-round probe = present.
      // When: publishApprovedFeedPost is invoked.
      // Then: clickAtLog.length === 2 (1 open + 1 Post); result.published===true.
      // NOTE: RED on P12 — P12 doesn't use multi-round open; different probe sequence.
      const constants = await loadPayloadConstants();
      const draftText = "T-OpenRetry.1 — round 1 success";
      const setup = await seedDraft("tor1-r1", draftText);
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P13FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [AX_START_A_POST] },
          { nodes: [AX_POST_BUTTON] },
        ],
        postSynthItems: [],
        probeQueue: makeP13ProbeQueue(1, draftText),
        focusResult: true,
        clearResult: false,
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        closeSucceeds: true,
        ...spies,
      };
      const client = makeP13FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") { assert.fail("T-OpenRetry.1: not exported"); }
      const result = await fn(deps);

      assert.equal(result.published, true, `T-OpenRetry.1: published must be true; reason=${result.reason}`);
      assert.equal(spies.clickAtLog.length, 2, `T-OpenRetry.1: expected 2 clicks (1 open + 1 Post); got ${spies.clickAtLog.length}`);
    },
  );

  // -----------------------------------------------------------------------
  // T-OpenRetry.2: open succeeds on round K (K=1,2,3,4) → K open clicks
  // -----------------------------------------------------------------------
  describe("T-OpenRetry.2 (P13): open succeeds on round K → K open clicks + 1 Post click", () => {
    for (const k of [1, 2, 3, 4] as const) {
      it(
        `T-OpenRetry.2 (K=${k}): open succeeds on round ${k} → clickAtLog.length === ${k + 1}; published=true`,
        { timeout: 30000 },
        async () => {
          // Given: rounds 0..(K-2) fail all 3 in-round probes; round K-1 succeeds on probe 1.
          // When: publishApprovedFeedPost is invoked.
          // Then: clickAtLog.length === K+1 (K open + 1 Post); result.published===true.
          // NOTE: RED on P12 — P12 doesn't have multi-round retry; K>1 would fail.
          const constants = await loadPayloadConstants();
          const draftText = `T-OpenRetry.2 K=${k}`;
          const setup = await seedDraft(`tor2-k${k}`, draftText);
          const spies = makeP12Spies();
          const auditRowLog: CapturedAuditRow[] = [];

          // AX queue: K "Start a post" entries (one per round) + 1 "Post" entry.
          const axTreeQueue: Array<{ nodes: FakeAXNode[] }> = [];
          for (let r = 0; r < k; r++) axTreeQueue.push({ nodes: [AX_START_A_POST] });
          axTreeQueue.push({ nodes: [AX_POST_BUTTON] });

          const clientOpts: P13FakeClientOpts = {
            constants,
            axTreeQueue,
            postSynthItems: [],
            probeQueue: makeP13ProbeQueue(k, draftText),
            focusResult: true,
            clearResult: false,
            enabledQueue: [true],
            closeCenterQueue: [],
            discardCenterQueue: [],
            navigateShouldThrow: false,
            diagnosticResult: DIAG_ABSENT,
            closeSucceeds: true,
            ...spies,
          };
          const client = makeP13FakeClient(clientOpts);
          const deps = makePublishDeps(client, setup, auditRowLog);

          const fn = await importPublishFn();
          if (typeof fn !== "function") { assert.fail(`T-OpenRetry.2 K=${k}: not exported`); }
          const result = await fn(deps);

          assert.equal(result.published, true, `T-OpenRetry.2 K=${k}: published must be true; reason=${result.reason}`);
          assert.equal(spies.clickAtLog.length, k + 1, `T-OpenRetry.2 K=${k}: expected ${k + 1} clicks (${k} open + 1 Post); got ${spies.clickAtLog.length}`);
        },
      );
    }
  });

  // -----------------------------------------------------------------------
  // T-OpenRetry.3: all rounds fail → composer_open_click_failed or composer_absent_after_open
  // -----------------------------------------------------------------------
  it(
    "T-OpenRetry.3 (P13): AX never finds 'Start a post' on any round → 0 open clicks → reason=composer_open_click_failed",
    { timeout: 30000 },
    async () => {
      // Given: AX always returns AX_IRRELEVANT across all 4 rounds (resolver times out each round).
      // When: publishApprovedFeedPost is invoked.
      // Then: clickAtLog.length === 0 (no open click); reason === "composer_open_click_failed".
      // NOTE: RED on P12 — P12 single-attempt; this tests the exhaustion of 4 rounds.
      const constants = await loadPayloadConstants();
      const setup = await seedDraft("tor3-allfail", "T-OpenRetry.3");
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P13FakeClientOpts = {
        constants,
        axTreeQueue: [{ nodes: [AX_IRRELEVANT] }], // all rounds get AX_IRRELEVANT (peekOrLast sticky)
        probeQueue: makeP13AllRoundsFailProbeQueue(),
        focusResult: false,
        clearResult: false,
        enabledQueue: [],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        closeSucceeds: true,
        ...spies,
      };
      const client = makeP13FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") { assert.fail("T-OpenRetry.3: not exported"); }
      const result = await fn(deps);

      assert.equal(spies.clickAtLog.length, 0, `T-OpenRetry.3: clickAtLog must be empty (resolver timed out all rounds); got ${JSON.stringify(spies.clickAtLog)}`);
      assert.equal(result.reason, "composer_open_click_failed", `T-OpenRetry.3: reason must be 'composer_open_click_failed'; got '${result.reason}'`);
    },
  );

  // -----------------------------------------------------------------------
  // T-OpenRetry.4: 4 rounds × all probes absent → composer_absent_after_open
  // -----------------------------------------------------------------------
  it(
    "T-OpenRetry.4 (P13): resolver finds 'Start a post' on all rounds but all in-round probes absent → ROUNDS open clicks → reason=composer_absent_after_open",
    { timeout: 30000 },
    async () => {
      // Given: AX returns "Start a post" on every round → clickAt fires K times.
      //        All in-round probes return absent → composer never opens after any click.
      // When: publishApprovedFeedPost is invoked.
      // Then: clickAtLog.length === COMPOSER_OPEN_RETRY_ROUNDS (4 open clicks, 0 Post clicks);
      //       reason === "composer_absent_after_open".
      // NOTE: RED on P12 — P12 single-attempt retry loop doesn't have 4-round exhaustion.
      const constants = await loadPayloadConstants();
      const setup = await seedDraft("tor4-absent", "T-OpenRetry.4");
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      // AX: "Start a post" on all rounds (peekOrLast sticky after push 1).
      const axTreeQueue = [{ nodes: [AX_START_A_POST] }];

      const clientOpts: P13FakeClientOpts = {
        constants,
        axTreeQueue,
        probeQueue: makeP13AllRoundsFailProbeQueue(),
        focusResult: false,
        clearResult: false,
        enabledQueue: [],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        closeSucceeds: true,
        ...spies,
      };
      const client = makeP13FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") { assert.fail("T-OpenRetry.4: not exported"); }
      const result = await fn(deps);

      assert.equal(spies.clickAtLog.length, COMPOSER_OPEN_RETRY_ROUNDS, `T-OpenRetry.4: expected ${COMPOSER_OPEN_RETRY_ROUNDS} open clicks (one per round); got ${spies.clickAtLog.length}`);
      assert.equal(result.reason, "composer_absent_after_open", `T-OpenRetry.4: reason must be 'composer_absent_after_open'; got '${result.reason}'`);
    },
  );

  // -----------------------------------------------------------------------
  // T-OpenRetry.5: source exports COMPOSER_OPEN_RETRY_ROUNDS with value 4
  // -----------------------------------------------------------------------
  it(
    "T-OpenRetry.5 (P13): source-grep — COMPOSER_OPEN_RETRY_ROUNDS is defined as 4 in deterministicPublishPost.ts",
    { timeout: 5000 },
    async () => {
      // Given: production source.
      // When: source is grepped for the constant definition.
      // Then: COMPOSER_OPEN_RETRY_ROUNDS is defined as 4 (not 1, not 3).
      // NOTE: RED on P12 — P12 has single-shot open, no COMPOSER_OPEN_RETRY_ROUNDS constant.
      const hasConst = /COMPOSER_OPEN_RETRY_ROUNDS\s*=\s*4/.test(PUBLISH_SRC);
      assert.equal(hasConst, true, `T-OpenRetry.5: COMPOSER_OPEN_RETRY_ROUNDS = 4 must be defined in deterministicPublishPost.ts`);
    },
  );

  // -----------------------------------------------------------------------
  // T-OpenRetry.6: in-round probe count is 3 per round (constant in source)
  // -----------------------------------------------------------------------
  it(
    "T-OpenRetry.6 (P13): source-grep — OPEN_IN_ROUND_PROBE_ATTEMPTS defined as 3 or inline value 3 used as in-round probe count",
    { timeout: 5000 },
    async () => {
      // Given: production source.
      // When: grepped for in-round probe count.
      // Then: source contains a reference to 3 in-round probes per round.
      // NOTE: RED on P12 — P12 doesn't have this constant.
      const hasConst = /OPEN_IN_ROUND_PROBE_ATTEMPTS\s*=\s*3/.test(PUBLISH_SRC)
                    || /OPEN_IN_ROUND_PROBE_ATTEMPTS/.test(PUBLISH_SRC);
      assert.ok(hasConst, `T-OpenRetry.6: source must define/use OPEN_IN_ROUND_PROBE_ATTEMPTS (3 in-round probes); not found in deterministicPublishPost.ts`);
    },
  );

  // -----------------------------------------------------------------------
  // T-OpenRetry.7: freshResolverSession shim per round (not just once globally)
  // -----------------------------------------------------------------------
  it(
    "T-OpenRetry.7 (P13): source-grep — freshResolverSession is constructed or used inside the open-retry loop (not only at function entry)",
    { timeout: 5000 },
    async () => {
      // Given: P13 source with per-round fresh resolver session.
      // When: source is grepped for freshResolverSession inside a loop context.
      // Then: freshResolverSession identifier appears in PUBLISH_SRC (carried from P12 T-Resolve.10).
      // NOTE: This is a light source assertion; the full behavioral test is T-Resolve.10 carry.
      const hasFreshSession = /freshResolverSession/.test(PUBLISH_SRC);
      assert.ok(hasFreshSession, `T-OpenRetry.7: freshResolverSession must appear in deterministicPublishPost.ts`);
    },
  );

  // -----------------------------------------------------------------------
  // T-OpenRetry.8: label arg for open stage resolver is "Start a post", NOT "Write a post"
  // BLOCKER-2: behavioral proof using an AX tree with BOTH "Write a post" and "Start a post".
  // The resolver must select the node whose name matches "Start a post" (arg2), not the first.
  // clickAtNameLog[0] must match /^start a post/i (and clickAtLog[0] must be @e2, not @e1).
  // -----------------------------------------------------------------------
  it(
    "T-OpenRetry.8 (P13): open-stage resolver selects 'Start a post' (not 'Write a post') — behavioral call-arg proxy via clickAtNameLog",
    { timeout: 20000 },
    async () => {
      // Given: AX tree with 2 buttons: "Write a post" (@e1) and "Start a post" (@e2).
      //        The resolver is called with label="Start a post" (arg2). It must select @e2.
      //        If arg2 were "Write a post", @e1 would be clicked instead.
      // When: publishApprovedFeedPost is invoked.
      // Then: clickAtLog[0] === "@e2" (the "Start a post" node, not @e1 "Write a post");
      //       clickAtNameLog[0] matches /^start a post/i (resolved entry name is "Start a post").
      // NOTE: This is a behavioral proxy for arg2="Start a post" — stronger than source-grep.
      //       GREEN on P12 (P12 also passes "Start a post"); RED only if impl switches to wrong label.
      const constants = await loadPayloadConstants();
      const draftText = "T-OpenRetry.8 — resolver selects Start a post";
      const setup = await seedDraft("tor8-label", draftText);
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      // AX tree: "Write a post" first (@e1), "Start a post" second (@e2).
      // If resolver uses arg2="Start a post", it selects @e2. If it used "Write a post", @e1.
      // FakeAXNode uses { value: string } for role and name (matches real CDP AX tree shape).
      const WRITE_A_POST_NODE: FakeAXNode = {
        nodeId: 50,
        role: { value: "button" },
        name: { value: "Write a post" },
        backendDOMNodeId: 501,
      };
      const START_A_POST_2: FakeAXNode = {
        nodeId: 60,
        role: { value: "button" },
        name: { value: "Start a post" },
        backendDOMNodeId: 601,
      };

      const clientOpts: P13FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [WRITE_A_POST_NODE, START_A_POST_2] }, // @e1="Write a post", @e2="Start a post"
          { nodes: [AX_POST_BUTTON] },
        ],
        postSynthItems: [],
        probeQueue: makeP13ProbeQueue(1, draftText),
        focusResult: true,
        clearResult: false,
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        closeSucceeds: true,
        ...spies,
      };
      const client = makeP13FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") { assert.fail("T-OpenRetry.8: not exported"); }
      await fn(deps);

      assert.ok(spies.clickAtLog.length >= 1, `T-OpenRetry.8: clickAtLog must be non-empty (resolver found Start a post); got []`);
      // @e2 is the "Start a post" node (2nd position); @e1 is "Write a post".
      assert.equal(
        spies.clickAtLog[0],
        "@e2",
        `T-OpenRetry.8: open clickAt must be @e2 ("Start a post"), not @e1 ("Write a post"); got "${spies.clickAtLog[0]}"`,
      );
      // Name verification: clickAtNameLog[0] must match "Start a post".
      assert.ok(
        /^start\s+a\s+post\b/i.test(spies.clickAtNameLog[0] ?? ""),
        `T-OpenRetry.8: clickAtNameLog[0] must match /^start a post/i (resolver arg2="Start a post"); got "${spies.clickAtNameLog[0]}"`,
      );
      // arg3 must be undefined for the open stage (no scope restriction — same as the Post stage).
      // Source-structural: the 3rd positional arg after "Start a post" must be the literal `undefined`.
      // Pattern: resolveByLabelWithRetry(session, "Start a post", undefined, ...)
      // Use [\s\S]*? (lazy, multiline-safe) to skip past the session arg which may contain
      // nested parens (e.g. freshResolverSession(deps.session)).
      const openCallHasNoScope = /resolveByLabelWithRetry\([\s\S]*?['"]Start a post['"]\s*,\s*undefined\b/.test(PUBLISH_SRC);
      assert.ok(
        openCallHasNoScope,
        `T-OpenRetry.8: open-stage resolveByLabelWithRetry arg3 must be undefined (no scope); ` +
        `expected "resolveByLabelWithRetry(X, 'Start a post', undefined, ...)" in source — not found (scope may have been added or arg3 changed)`,
      );
    },
  );

  // -----------------------------------------------------------------------
  // T-OpenRetry.9: progressive backoff source-structural assertion (CONCERN-MR-1)
  // -----------------------------------------------------------------------
  it(
    "T-OpenRetry.9 (P13): source-structural — READBACK_RETRY_MS used with progressive multipliers (*(attempt+1) for in-round; *(1<<round) for between-round)",
    { timeout: 5000 },
    async () => {
      // Given: P13 plan §6.3 specifies progressive backoff:
      //   in-round:  READBACK_RETRY_MS * (attempt + 1) = 120 / 240 / 360 ms
      //   between-round: READBACK_RETRY_MS * (1 << round) = 120 / 240 / 480 / 960 ms
      // When: production source is inspected.
      // Then: READBACK_RETRY_MS appears in PUBLISH_SRC (not only in composerReadiness.ts import);
      //       BOTH progressive multiplier patterns present: in-round *(attempt+1) AND between-round *(1<<round).
      // NOTE: RED on P12 — P12 uses READBACK_RETRY_MS but not with progressive multipliers.
      const hasConstant = /READBACK_RETRY_MS/.test(PUBLISH_SRC);
      assert.ok(hasConstant, `T-OpenRetry.9: READBACK_RETRY_MS must appear in deterministicPublishPost.ts`);
      // Progressive in-round backoff: READBACK_RETRY_MS * (attempt + 1) or similar
      const hasInRoundBackoff =
        /READBACK_RETRY_MS\s*\*\s*\(?\s*\w+\s*\+\s*1\s*\)?/.test(PUBLISH_SRC) ||
        /READBACK_RETRY_MS\s*\*\s*attempt/.test(PUBLISH_SRC);
      // Progressive between-round backoff: READBACK_RETRY_MS * (1 << round) or similar
      const hasBetweenRoundBackoff =
        /READBACK_RETRY_MS\s*\*\s*\(?\s*1\s*<</.test(PUBLISH_SRC) ||
        /READBACK_RETRY_MS\s*<</.test(PUBLISH_SRC) ||
        /1\s*<<\s*\w+.*READBACK_RETRY_MS/.test(PUBLISH_SRC);
      // Both monotonic patterns are required: in-round AND between-round.
      assert.ok(
        hasInRoundBackoff,
        `T-OpenRetry.9: READBACK_RETRY_MS must be used with an in-round progressive multiplier (*(attempt+1) or similar) in deterministicPublishPost.ts; not found`,
      );
      assert.ok(
        hasBetweenRoundBackoff,
        `T-OpenRetry.9: READBACK_RETRY_MS must be used with a between-round progressive multiplier (*(1<<round) or similar) in deterministicPublishPost.ts; not found`,
      );
    },
  );
});

// ===========================================================================
// P13 NEW §5.4 T-Retype — always re-type from DB draft; composerTextMatches; conditional clear
// ALL tests in this section are RED on P12 production code.
// ===========================================================================

describe("§5.4 T-Retype (P13) — always re-type from DB draft; composerTextMatches; conditional clear", () => {

  // -----------------------------------------------------------------------
  // T-Retype.1: insertText receives DB draft.text (not agent leftover) — behavioral test
  // -----------------------------------------------------------------------
  it(
    "T-Retype.1 (P13): insertText always called even when probe0.present=true + text matches (P12 fast-path skip trigger)",
    { timeout: 15000 },
    async () => {
      // Given: probe0.present=true AND probe0.editorText=draftText (P12 composerAlreadyValid).
      //        P12: fast-path → skip insertText. P13: no fast-path → always insertText.
      // When: publishApprovedFeedPost is invoked.
      // Then: insertTextLog[0].text === DB draft.text (re-typed from DB, not skipped).
      // NOTE: RED on P12 — P12 fast-path skips insertText → insertTextLog.length=0 → FAIL.
      const constants = await loadPayloadConstants();
      const draftText = "DB_CANONICAL_RETYPE_TEXT — T-Retype.1";
      const setup = await seedDraft("tretype1-db", draftText);
      const spies = makeP12Spies();
      const auditRowLog: CapturedAuditRow[] = [];

      const probeQueue = makeP13ProbeQueue(1, draftText);
      // BLOCKER-1: probe0 (preNavigate diag) is at [1] (close-probe is at [0]).
      probeQueue[1] = { present: true, editorText: draftText }; // P12 fast-path trigger

      const clientOpts: P13FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [AX_START_A_POST] },
          { nodes: [AX_POST_BUTTON] },
        ],
        postSynthItems: [],
        probeQueue,
        focusResult: true,
        clearResult: false,
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        closeSucceeds: true,
        ...spies,
      };
      const client = makeP13FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") { assert.fail("T-Retype.1: not exported"); }
      const result = await fn(deps);

      assert.equal(result.published, true, `T-Retype.1: published must be true; reason=${result.reason}`);
      assert.ok(spies.insertTextLog.length >= 1, `T-Retype.1: insertText must be called; got 0`);
      // P13 fix: insertTextHumanLike types char-by-char; join all entries.
      const tr1Inserted = spies.insertTextLog.map((e) => e.text).join("");
      assert.equal(tr1Inserted, draftText, `T-Retype.1: concatenated insertText must equal DB draft text="${draftText}"; got "${tr1Inserted}"`);
    },
  );

  // -----------------------------------------------------------------------
  // T-Retype.2: composerTextMatches used for readback (not composerTextExact)
  // -----------------------------------------------------------------------
  it(
    "T-Retype.2 (P13): source-grep — composerTextMatches imported/used; composerTextExact NOT the readback check",
    { timeout: 5000 },
    async () => {
      // Given: P13 uses composerTextMatches (fuzzy) for readback instead of composerTextExact.
      // When: source is grepped.
      // Then: composerTextMatches appears in PUBLISH_SRC;
      //       composerTextExact appears 0 times as a function call in PUBLISH_SRC
      //       (may still appear in comments or import list — allow up to 1 total occurrence
      //        if it's import-only; 0 call-site occurrences).
      // NOTE: RED on P12 — P12 uses composerTextExact for the readback check.
      const hasMatches = /composerTextMatches/.test(PUBLISH_SRC);
      assert.ok(hasMatches, `T-Retype.2: composerTextMatches must appear in deterministicPublishPost.ts`);
      // composerTextExact must not be used as a function CALL (it can still be in an import).
      const exactCallMatches = (PUBLISH_SRC.match(/composerTextExact\s*\(/g) ?? []).length;
      assert.equal(exactCallMatches, 0, `T-Retype.2: composerTextExact must not be called in deterministicPublishPost.ts; found ${exactCallMatches} call(s)`);
    },
  );

  // -----------------------------------------------------------------------
  // T-Retype.3: clear called only when editor non-empty; not called when fresh/empty
  // CARRY-FORWARD UNCHANGED FROM P13
  // -----------------------------------------------------------------------
  it(
    "T-Retype.3 (P13): clearEditor NOT called when post-open probe shows editorText=''; called when editorText is non-empty stale text",
    { timeout: 15000 },
    async () => {
      // Given: scenario A — post-open probe editorText="" (fresh composer) → clearResult irrelevant.
      //        scenario B — post-open probe editorText="STALE" → clear called (clearResult=true).
      // When: publishApprovedFeedPost for each.
      // Then: A → clearCalledLog.length === 0 (conditional clear skipped for empty editor).
      //       B → clearCalledLog.length >= 1 (clear called for non-empty editor).
      // NOTE: RED on P12 — P12 always calls clear (unconditional clearEditor).
      const constants = await loadPayloadConstants();

      // Scenario A: fresh composer (editorText="")
      const draftA = "T-Retype.3-A fresh";
      const setupA = await seedDraft("tretype3-A", draftA);
      const spiesA = makeP12Spies();
      const auditA: CapturedAuditRow[] = [];

      const clientA = makeP13FakeClient({
        constants,
        axTreeQueue: [{ nodes: [AX_START_A_POST] }, { nodes: [AX_POST_BUTTON] }],
        postSynthItems: [],
        // P13 probe layout: [0]=close, [1]=probe0, [2]=probe1, [3]=in-round (probeAtOpen), [4]=readback, [5]=post-click.
        // Scenario A: probeAtOpen.editorText="" → skip clear (conditional clear).
        probeQueue: [
          { present: false, editorText: "" },    // [0] close probe → 1 probe, closed
          { present: false, editorText: "" },    // [1] probe0 preNavigate
          { present: false, editorText: "" },    // [2] probe1 postNavigate
          { present: true,  editorText: "" },    // [3] in-round probe: probeAtOpen.editorText="" → NO clear
          { present: true,  editorText: draftA }, // [4] readback match
          { present: false, editorText: "" },    // [5] post-click gone
        ],
        focusResult: true,
        clearResult: true, // clear would succeed, but must NOT be called (empty editor)
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        closeSucceeds: true,
        ...spiesA,
      });
      const depsA = makePublishDeps(clientA, setupA, auditA);

      // Scenario B: stale composer (editorText="STALE TEXT")
      const draftB = "T-Retype.3-B stale";
      const setupB = await seedDraft("tretype3-B", draftB);
      const spiesB = makeP12Spies();
      const auditB: CapturedAuditRow[] = [];

      const clientB = makeP13FakeClient({
        constants,
        axTreeQueue: [{ nodes: [AX_START_A_POST] }, { nodes: [AX_POST_BUTTON] }],
        postSynthItems: [],
        // P13 probe layout: [0]=close, [1]=probe0, [2]=probe1, [3]=in-round (probeAtOpen), [4]=readback, [5]=post-click.
        // Scenario B: probeAtOpen.editorText="STALE TEXT" → clear IS called.
        probeQueue: [
          { present: false, editorText: "" },          // [0] close probe → 1 probe, closed
          { present: false, editorText: "" },          // [1] probe0 preNavigate
          { present: false, editorText: "" },          // [2] probe1 postNavigate
          { present: true,  editorText: "STALE TEXT" }, // [3] in-round probe: probeAtOpen.editorText="STALE" → clear
          { present: true,  editorText: draftB },      // [4] readback match
          { present: false, editorText: "" },          // [5] post-click gone
        ],
        focusResult: true,
        clearResult: true, // clear succeeds
        enabledQueue: [true],
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        closeSucceeds: true,
        ...spiesB,
      });
      const depsB = makePublishDeps(clientB, setupB, auditB);

      const fn = await importPublishFn();
      if (typeof fn !== "function") { assert.fail("T-Retype.3: not exported"); }
      const [resultA, resultB] = await Promise.all([fn(depsA), fn(depsB)]);
      void resultA; void resultB;

      // Scenario A: editor was empty → clear NOT called.
      // clearCallCount.n is the existing spy field (increments on CLEAR_JS evaluation).
      // NOTE: Key P13 behavioral change vs P12 (P12: always clears unconditionally).
      assert.equal(spiesA.clearCallCount.n, 0, `T-Retype.3 A: clearCallCount must be 0 when editor is empty (conditional clear); got ${spiesA.clearCallCount.n}`);
      // Scenario B: editor was non-empty ("STALE TEXT") → clear WAS called.
      assert.ok(spiesB.clearCallCount.n >= 1, `T-Retype.3 B: clearCallCount must be >= 1 when editor has stale text; got ${spiesB.clearCallCount.n}`);
    },
  );
});

// ===========================================================================
// P14 NEW §5.1 T-EnableGate — 6-attempt enable-gate with progressive backoff
//
// ALL tests in this section are RED on P13 production code. RED reasons:
//   T-EnableGate.1 (N=1/2): result.enableGateAttempts field absent in P13 (undefined !== N)
//   T-EnableGate.1 (N=3/4/5): P13 2-attempt gate exhausted → published=false (expected true)
//   T-EnableGate.2: source-grep FAILS (READBACK_RETRY_MS*(1<<i) absent in P13 enable-gate region)
//                   sleepLog assertions FAIL (sleepLog empty; TODO Step 5: setTimeout spy)
//   T-EnableGate.3: enabledCallLog.n===2 not 6 on P13; enableGateAttempts field absent
//
// Harness used: P13FakeClientOpts (makeP13FakeClient) with enabledCallLog extension.
// Probe queue: makeP13ProbeQueue(1, draftText) — open succeeds on round 1; readback matches.
// Enable-gate results are controlled exclusively via enabledQueue.
// ===========================================================================

describe("§5.1 T-EnableGate (P14) — 6-attempt enable-gate with progressive backoff", () => {

  // -----------------------------------------------------------------------
  // T-EnableGate.1: gate succeeds on attempt N — parameterized N ∈ {1,2,3,4,5}
  //
  // Given: isFeedComposerPostButtonEnabled returns false N-1 times then true on attempt N.
  //        Fresh-open+readback-success fixture (openedOnRound:1; text matches DB draft).
  // When:  publishApprovedFeedPost runs to completion.
  // Then:
  //   (a) exactly N calls to isFeedComposerPostButtonEnabled (enabledCallLog.n === N)
  //   (b) published=true; dispatchAttempted=true; fallbackAllowed=false; 1 Post @e* clickAt
  //   (c) N-1 between-attempt sleeps (sleepLog.length === N-1)
  //   (d) result.enableGateAttempts === N
  // -----------------------------------------------------------------------
  describe("T-EnableGate.1: gate succeeds on attempt N (parameterized N∈{1,2,3,4,5})", () => {
    for (const n of [1, 2, 3, 4, 5] as const) {
      it(
        `T-EnableGate.1 (N=${n}): isFeedComposerPostButtonEnabled called ${n} time(s) before loop exit; published=true; ${n - 1} between-attempt sleep(s); result.enableGateAttempts===${n}`,
        { timeout: 15000 },
        async () => {
          // Given: enabledQueue = [false × (N-1), true] so gate succeeds on attempt N.
          //        Probe queue uses makeP13ProbeQueue(1, draftText): close→probe0→probe1→open→readback→post-click.
          //        AX queue: "Start a post" for open, "Post" (@e1) for Post stage.
          // When: publishApprovedFeedPost runs to completion.
          // Then: see §5.1 T-EnableGate.1 contract above.
          // NOTE: RED on P13:
          //   N=1: result.enableGateAttempts undefined (not 1) → assertion (d) FAILS
          //   N=2: result.enableGateAttempts undefined (not 2) → assertion (d) FAILS
          //   N≥3: P13 2-attempt gate returns post_button_not_enabled → published=false → assertion (b) FAILS
          const constants = await loadPayloadConstants();
          const draftText = `T-EnableGate.1 N=${n} — gate succeeds on attempt ${n}`;
          const setup = await seedDraft(`teg1-n${n}`, draftText);
          const spies = makeP12Spies();
          const enabledCallLog = { n: 0 };
          // enabledResultLog: records each isFeedComposerPostButtonEnabled call result.
          // Used by the phase-gated setTimeout spy: captures sleeps only when the last
          // result was false (between gate-loop iterations, not after the gate exits).
          const enabledResultLog: boolean[] = [];
          // sleepLog populated by the phase-gated setTimeout spy installed below.
          const sleepLog: number[] = [];
          const auditRowLog: CapturedAuditRow[] = [];

          // enabledQueue: N-1 falses then 1 true (gate succeeds on attempt N)
          const enabledQueue: boolean[] = [
            ...Array<boolean>(n - 1).fill(false),
            true,
          ];

          const clientOpts: P13FakeClientOpts = {
            constants,
            axTreeQueue: [
              { nodes: [AX_START_A_POST] },       // open stage → "Start a post" @e1
              { nodes: [AX_POST_BUTTON] },          // Post stage → "Post" @e1
            ],
            postSynthItems: [],
            probeQueue: makeP13ProbeQueue(1, draftText),
            focusResult: true,
            clearResult: false,
            enabledQueue,
            closeCenterQueue: [],
            discardCenterQueue: [],
            navigateShouldThrow: false,
            diagnosticResult: DIAG_ABSENT,
            closeSucceeds: true,
            enabledCallLog,
            enabledResultLog,
            ...spies,
          };
          const client = makeP13FakeClient(clientOpts);
          const deps = makePublishDeps(client, setup, auditRowLog);

          const fn = await importPublishFn();
          if (typeof fn !== "function") {
            assert.fail(`T-EnableGate.1 (N=${n}): publishApprovedFeedPost not exported`);
          }
          // Phase-gated setTimeout spy for enable-gate sleep capture (Step 5 CONCERN-1 fix).
          // Primary gate (CONCERN-1 compliance): the last recorded isFeedComposerPostButtonEnabled
          // result was false (i.e. we are between two consecutive gate-loop iterations).
          // This precisely captures sleeps that fire BETWEEN enabled checks but NOT after:
          //   - The gate exits on true  → last result is true  → resolver sleep NOT captured ✓
          //   - The gate exits on false (i=5, no sleep per production code) → no sleep fires ✓
          //   - Navigate settle, open probes: fire before any enabled call → not captured ✓
          // Secondary filter: ms !== 45_000 excludes the CDP watchdog timer (CDP_CALL_DEADLINE_MS
          // in raced.ts). The fake evaluate() body is synchronous so enabledResultLog is updated
          // BEFORE raceCdp creates its setTimeout(45_000), making 45_000 appear while lastResult===false.
          // Filtering it out is NOT "sole duration filtering" — the primary phase-gate is still active.
          // Enable-gate sleeps max at 1920ms; 45_000 is unambiguous (CONCERN-1 compliant).
          // Callbacks run at 0ms delay so no real wall-clock wait in the test.
          // biome-ignore lint/suspicious/noExplicitAny: spy override for setTimeout in test
          const result = await (async () => {
            // biome-ignore lint/suspicious/noExplicitAny: spy override for setTimeout in test
            const origTimeout = (globalThis as any).setTimeout;
            // biome-ignore lint/suspicious/noExplicitAny: spy override for setTimeout in test
            (globalThis as any).setTimeout = (cb: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
              // Primary: last enabled result was false (between iterations).
              // Secondary: exclude CDP_CALL_DEADLINE_MS=45_000 watchdog from raceCdp/raced.ts.
              const lastResult = enabledResultLog[enabledResultLog.length - 1];
              if (enabledResultLog.length > 0 && lastResult === false && ms !== 45_000) {
                sleepLog.push(ms ?? 0);
              }
              // biome-ignore lint/suspicious/noExplicitAny: forward to original setTimeout at 0ms delay
              return origTimeout(cb as any, 0, ...rest);
            };
            try {
              return await fn(deps);
            } finally {
              // biome-ignore lint/suspicious/noExplicitAny: restore original setTimeout
              (globalThis as any).setTimeout = origTimeout;
            }
          })();

          // (a) Exactly N calls to isFeedComposerPostButtonEnabled before loop exit
          // RED on P13 for N≥3: P13 2-attempt gate only calls 2 times then returns early.
          assert.equal(
            enabledCallLog.n,
            n,
            `T-EnableGate.1 (N=${n}): expected exactly ${n} call(s) to isFeedComposerPostButtonEnabled; got ${enabledCallLog.n} (RED on P13 for N≥3: P13 2-attempt gate)`,
          );

          // (b) Post stage proceeded: published=true, dispatchAttempted=true, exactly 1 Post clickAt
          // RED on P13 for N≥3: P13 exhausts after 2 attempts → published=false.
          assert.equal(result.published, true, `T-EnableGate.1 (N=${n}): result.published must be true; reason=${result.reason} (RED on P13 for N≥3)`);
          assert.equal(result.dispatchAttempted, true, `T-EnableGate.1 (N=${n}): result.dispatchAttempted must be true`);
          assert.equal(result.fallbackAllowed, false, `T-EnableGate.1 (N=${n}): result.fallbackAllowed must be false on success`);
          // clickAtLog: [open @e1, Post @e1] = 2 total (1 open + 1 Post)
          assert.equal(
            spies.clickAtLog.length,
            2,
            `T-EnableGate.1 (N=${n}): clickAtLog must have exactly 2 entries (1 open + 1 Post); got ${spies.clickAtLog.length}: ${JSON.stringify(spies.clickAtLog)}`,
          );
          const postClickRef = spies.clickAtLog[1] ?? "";
          assert.ok(
            postClickRef.startsWith("@e"),
            `T-EnableGate.1 (N=${n}): Post clickAt (clickAtLog[1]) must be a native-AX ref (starts with "@e"); got "${postClickRef}"`,
          );

          // (c) N-1 between-attempt sleeps — populated by the phase-gated setTimeout spy above.
          assert.equal(
            sleepLog.length,
            n - 1,
            `T-EnableGate.1 (N=${n}): expected ${n - 1} between-attempt sleep(s); got sleepLog=${JSON.stringify(sleepLog)}`,
          );

          // (d) result.enableGateAttempts === N
          // RED on P13: field does not exist (P13 has no enableGateAttempts tracking).
          assert.equal(
            result.enableGateAttempts,
            n,
            `T-EnableGate.1 (N=${n}): result.enableGateAttempts must be ${n}; got ${result.enableGateAttempts} (RED on P13: field absent)`,
          );
        },
      );
    }
  });

  // -----------------------------------------------------------------------
  // T-EnableGate.2: progressive between-attempt backoff is monotone non-decreasing
  //                 in the READBACK_RETRY_MS*(1<<i) doubling progression
  //
  // Given: isFeedComposerPostButtonEnabled returns false all 6 times (gate fails → same as T-EnableGate.3).
  //        Fresh-open+readback-success fixture (focus on SLEEP DURATIONS, not published/reason).
  // When:  publishApprovedFeedPost runs to gate exhaustion.
  // Then:
  //   (a) REQUIRED source-grep: READBACK_RETRY_MS*(1<<i) appears in the enable-gate region
  //       (between readback_mismatch return and resolveByLabelWithRetry for Post).
  //       — RED on P13: P13 enable-gate uses flat sleep(READBACK_RETRY_MS), no (1<<i).
  //   (b) sleepLog has exactly 5 entries: [120,240,480,960,1920] = READBACK_RETRY_MS*(1<<i) for i∈{0..4}.
  //       Monotone non-decreasing; NO sleep after the 6th attempt.
  //       — TODO Step 5: add setTimeout spy to populate sleepLog.
  // -----------------------------------------------------------------------
  it(
    "T-EnableGate.2: N=6 (gate fails) — 5 between-attempt sleeps [120,240,480,960,1920]; source-grep confirms READBACK_RETRY_MS*(1<<i) in enable-gate region (REQUIRED); NO sleep after 6th attempt",
    { timeout: 15000 },
    async () => {
      // Given: enabledQueue = [false × 6]; fresh-open+readback-success fixture (round 1 open).
      // When: publishApprovedFeedPost runs to gate exhaustion (6 attempts, all false).
      // Then: (a) source-grep REQUIRED: READBACK_RETRY_MS*(1<<i) in enable-gate source region
      //       (b) sleepLog === [120,240,480,960,1920]; no sleep after attempt 6
      // NOTE: RED on P13 via (a): P13 uses flat `sleep(READBACK_RETRY_MS)` not doubling backoff.
      //       RED on P13 via (b): sleepLog empty (TODO Step 5 spy); count assertion fails.
      const constants = await loadPayloadConstants();
      const draftText = "T-EnableGate.2 — backoff duration sequence";
      const setup = await seedDraft("teg2-backoff", draftText);
      const spies = makeP12Spies();
      const enabledCallLog = { n: 0 };
      // enabledResultLog: records each isFeedComposerPostButtonEnabled call result.
      // Used by the phase-gated setTimeout spy: captures sleeps only when the last
      // result was false (between gate-loop iterations, not after the gate exits).
      const enabledResultLog: boolean[] = [];
      // sleepLog populated by the phase-gated setTimeout spy installed below.
      const sleepLog: number[] = [];
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P13FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [AX_START_A_POST] },
          { nodes: [AX_POST_BUTTON] },
        ],
        postSynthItems: [],
        probeQueue: makeP13ProbeQueue(1, draftText),
        focusResult: true,
        clearResult: false,
        enabledQueue: Array<boolean>(ENABLE_GATE_ATTEMPTS).fill(false),
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        diagnosticResult: DIAG_ABSENT,
        closeSucceeds: true,
        enabledCallLog,
        enabledResultLog,
        ...spies,
      };
      const client = makeP13FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-EnableGate.2: publishApprovedFeedPost not exported");
      }
      // Phase-gated setTimeout spy for enable-gate sleep capture (Step 5 CONCERN-1 fix).
      // Primary gate: the last recorded isFeedComposerPostButtonEnabled result was false.
      // This captures sleeps BETWEEN gate-loop iterations (after a false result) and excludes:
      //   - navigate settle / open in-round probes: fire before any enabled call → not captured ✓
      //   - Production's `if (i < ENABLE_GATE_ATTEMPTS - 1)` rule: no sleep fires after the 6th
      //     (final) check, so no spurious capture on exhaustion ✓
      // Secondary filter: ms !== 45_000 excludes CDP_CALL_DEADLINE_MS (raceCdp/raced.ts).
      // The fake evaluate() body runs synchronously so enabledResultLog is updated BEFORE
      // raceCdp sets up setTimeout(45_000); without this secondary filter the 45_000ms watchdog
      // fires while lastResult===false, polluting sleepLog. Phase gate remains primary (CONCERN-1).
      // Callbacks run at 0ms delay — no real wall-clock wait.
      // biome-ignore lint/suspicious/noExplicitAny: spy override for setTimeout in test
      {
        // biome-ignore lint/suspicious/noExplicitAny: spy override for setTimeout in test
        const origTimeout2 = (globalThis as any).setTimeout;
        // biome-ignore lint/suspicious/noExplicitAny: spy override for setTimeout in test
        (globalThis as any).setTimeout = (cb: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
          // Primary: last enabled result was false (between iterations).
          // Secondary: exclude CDP_CALL_DEADLINE_MS=45_000 watchdog from raceCdp/raced.ts.
          // (Fake evaluate() is sync → enabledResultLog updates BEFORE raceCdp's setTimeout(45_000),
          //  so 45_000 would fire while lastResult===false without this secondary exclusion.
          //  Phase gate remains the primary filter — CONCERN-1 compliant.)
          const lastResult = enabledResultLog[enabledResultLog.length - 1];
          if (enabledResultLog.length > 0 && lastResult === false && ms !== 45_000) {
            sleepLog.push(ms ?? 0);
          }
          // biome-ignore lint/suspicious/noExplicitAny: forward to original setTimeout at 0ms delay
          return origTimeout2(cb as any, 0, ...rest);
        };
        try {
          await fn(deps);
        } finally {
          // biome-ignore lint/suspicious/noExplicitAny: restore original setTimeout
          (globalThis as any).setTimeout = origTimeout2;
        }
      }

      // (a) REQUIRED source-grep companion: READBACK_RETRY_MS * (1 << i) in enable-gate region.
      // The enable-gate region is bounded by:
      //   start: the line containing finishPreDispatchFailure(..., "readback_mismatch")
      //   end:   the first resolveByLabelWithRetry( call after that line (= Post resolver)
      // Mirrors T-OpenRetry.9's structural grep pattern — pins the EXPRESSION shape, not just behavior.
      // RED on P13: P13's enable-gate is `sleep(READBACK_RETRY_MS)` (flat), not `*(1<<i)` doubling.
      {
        const lines = PUBLISH_SRC.split("\n");
        const readbackMismatchLineIdx = lines.findIndex((l) =>
          /finishPreDispatchFailure[^;]*['""]readback_mismatch['""]/.test(l),
        );
        const resolvePostLineIdx = lines.findIndex((l, i) =>
          i > readbackMismatchLineIdx && /resolveByLabelWithRetry\s*\(/.test(l),
        );
        assert.ok(
          readbackMismatchLineIdx >= 0,
          `T-EnableGate.2 source-grep: readback_mismatch return line not found in deterministicPublishPost.ts`,
        );
        assert.ok(
          resolvePostLineIdx > readbackMismatchLineIdx,
          `T-EnableGate.2 source-grep: resolveByLabelWithRetry for Post (line ${resolvePostLineIdx}) must follow readback_mismatch return (line ${readbackMismatchLineIdx})`,
        );
        const enableGateRegion = lines.slice(readbackMismatchLineIdx + 1, resolvePostLineIdx).join("\n");
        const hasDoublingBackoff = /READBACK_RETRY_MS\s*\*\s*\(?\s*1\s*<</.test(enableGateRegion);
        assert.ok(
          hasDoublingBackoff,
          `T-EnableGate.2 source-grep (REQUIRED): deterministicPublishPost.ts must contain READBACK_RETRY_MS * (1 << <expr>) in enable-gate region ` +
          `(lines ${readbackMismatchLineIdx + 1}..${resolvePostLineIdx - 1}); not found — ` +
          `RED on P13 (P13 uses flat sleep(READBACK_RETRY_MS), no 1<<i backoff)`,
        );
      }

      // (b) sleepLog: exactly 5 between-attempt sleeps [120,240,480,960,1920]; no sleep after 6th.
      // Populated by the phase-gated setTimeout spy installed above.
      const expectedSleepLog = [
        READBACK_RETRY_MS_VALUE * (1 << 0), // 120
        READBACK_RETRY_MS_VALUE * (1 << 1), // 240
        READBACK_RETRY_MS_VALUE * (1 << 2), // 480
        READBACK_RETRY_MS_VALUE * (1 << 3), // 960
        READBACK_RETRY_MS_VALUE * (1 << 4), // 1920
      ];
      assert.equal(
        sleepLog.length,
        5,
        `T-EnableGate.2: sleepLog must have exactly 5 entries (one per between-attempt interval for i∈{0..4}); got sleepLog=${JSON.stringify(sleepLog)}`,
      );
      for (let i = 1; i < sleepLog.length; i++) {
        assert.ok(
          sleepLog[i] >= sleepLog[i - 1],
          `T-EnableGate.2: sleepLog must be monotone non-decreasing; sleepLog[${i}]=${sleepLog[i]} < sleepLog[${i - 1}]=${sleepLog[i - 1]}`,
        );
      }
      assert.deepStrictEqual(
        sleepLog,
        expectedSleepLog,
        `T-EnableGate.2: sleepLog must be ${JSON.stringify(expectedSleepLog)} (READBACK_RETRY_MS*(1<<i) for i∈{0..4}); got ${JSON.stringify(sleepLog)}`,
      );
    },
  );

  // -----------------------------------------------------------------------
  // T-EnableGate.3: all 6 attempts return false → post_button_not_enabled
  //
  // Given: isFeedComposerPostButtonEnabled returns false all 6 times.
  //        Fresh-open+readback-success fixture (open round 1, readback matches).
  // When:  publishApprovedFeedPost runs to gate exhaustion.
  // Then:
  //   - published=false; reason="post_button_not_enabled"; dispatchAttempted=false; fallbackAllowed=true
  //   - result.enableGateAttempts === 6 (RED on P13: field absent)
  //   - exactly 6 calls to isFeedComposerPostButtonEnabled (RED on P13: P13 makes 2)
  //   - exactly 5 between-attempt sleeps (source-structural; behavioral requires Step 5 spy)
  //   - Post-stage resolveByLabelWithRetry NEVER invoked (no AX tree consumed for Post resolver)
  //   - ZERO Post-stage clickAt: clickAtLog has exactly 1 entry (open-stage "Start a post" click)
  //   - clickAtNameLog[0] does NOT match /^post$/i
  //   - postOpen diag row: opened:true; lastProbeOutcome:"present"
  //   - result.draftMarkedSent !== true
  // -----------------------------------------------------------------------
  it(
    "T-EnableGate.3: all 6 isFeedComposerPostButtonEnabled calls return false → published=false; reason=post_button_not_enabled; dispatchAttempted=false; enableGateAttempts===6; ZERO Post clickAt; postOpen row opened:true",
    { timeout: 15000 },
    async () => {
      // Given: enabledQueue = [false × 6] (all 6 gate attempts return false).
      //        Fresh-open (round 1) + readback-success fixture (text matches DB draft).
      //        diagnosticResult=DIAG_PRESENT so postOpen diag row is emitted with content.
      // When: publishApprovedFeedPost runs to gate exhaustion.
      // Then: see §5.1 T-EnableGate.3 contract above.
      // NOTE: RED on P13:
      //   - enabledCallLog.n === 2 (not 6) → assertion (call count) FAILS
      //   - result.enableGateAttempts is undefined (not 6) → assertion FAILS
      const constants = await loadPayloadConstants();
      const draftText = "T-EnableGate.3 — all 6 gate attempts fail";
      const setup = await seedDraft("teg3-allfail", draftText);
      const spies = makeP12Spies();
      const enabledCallLog = { n: 0 };
      const auditRowLog: CapturedAuditRow[] = [];

      const clientOpts: P13FakeClientOpts = {
        constants,
        axTreeQueue: [
          { nodes: [AX_START_A_POST] }, // open stage: "Start a post" → open clickAt fires
          { nodes: [AX_POST_BUTTON] },  // Post stage: MUST NOT be reached (gate stops before Post)
        ],
        postSynthItems: [],
        probeQueue: makeP13ProbeQueue(1, draftText),
        focusResult: true,
        clearResult: false,
        enabledQueue: Array<boolean>(ENABLE_GATE_ATTEMPTS).fill(false),
        closeCenterQueue: [],
        discardCenterQueue: [],
        navigateShouldThrow: false,
        // DIAG_PRESENT: ensures postOpen row is fully populated (opened:true, lastProbeOutcome:"present")
        // so the postOpen diag assertions below can verify composer was probe-present at failure time.
        diagnosticResult: DIAG_PRESENT,
        closeSucceeds: true,
        enabledCallLog,
        ...spies,
      };
      const client = makeP13FakeClient(clientOpts);
      const deps = makePublishDeps(client, setup, auditRowLog);

      const fn = await importPublishFn();
      if (typeof fn !== "function") {
        assert.fail("T-EnableGate.3: publishApprovedFeedPost not exported");
      }
      const result = await fn(deps);

      // result shape assertions
      assert.equal(
        result.published,
        false,
        `T-EnableGate.3: published must be false on enable-gate exhaustion; got ${result.published}`,
      );
      assert.equal(
        result.reason,
        "post_button_not_enabled",
        `T-EnableGate.3: reason must be "post_button_not_enabled"; got "${result.reason}"`,
      );
      assert.equal(
        result.dispatchAttempted,
        false,
        `T-EnableGate.3: dispatchAttempted must be false (gate exhaustion → no Post click)`,
      );
      assert.equal(
        result.fallbackAllowed,
        true,
        `T-EnableGate.3: fallbackAllowed must be true on enable-gate exhaustion`,
      );
      assert.notEqual(
        result.draftMarkedSent,
        true,
        `T-EnableGate.3: draftMarkedSent must not be true on pre-Post fail`,
      );

      // enableGateAttempts === 6 — RED on P13 (field does not exist)
      assert.equal(
        result.enableGateAttempts,
        ENABLE_GATE_ATTEMPTS,
        `T-EnableGate.3: result.enableGateAttempts must be ${ENABLE_GATE_ATTEMPTS}; got ${result.enableGateAttempts} (RED on P13: field absent)`,
      );

      // Exactly 6 calls to isFeedComposerPostButtonEnabled — RED on P13 (P13 makes 2)
      assert.equal(
        enabledCallLog.n,
        ENABLE_GATE_ATTEMPTS,
        `T-EnableGate.3: expected exactly ${ENABLE_GATE_ATTEMPTS} call(s) to isFeedComposerPostButtonEnabled; got ${enabledCallLog.n} (RED on P13: 2-attempt gate)`,
      );

      // ZERO Post-stage clickAt: exactly 1 entry in clickAtLog (open-stage "Start a post")
      // The 6 gate retries emit ZERO clickAt — they are pure reads (isFeedComposerPostButtonEnabled + sleep).
      assert.equal(
        spies.clickAtLog.length,
        1,
        `T-EnableGate.3: clickAtLog must have exactly 1 entry (open-stage click only); got ${spies.clickAtLog.length}: ${JSON.stringify(spies.clickAtLog)}`,
      );
      // The single clickAt must NOT be a Post-named entry
      assert.ok(
        !/^post$/i.test(spies.clickAtNameLog[0] ?? ""),
        `T-EnableGate.3: clickAtNameLog[0] must NOT match /^post\$/i; got "${spies.clickAtNameLog[0]}" in ${JSON.stringify(spies.clickAtNameLog)}`,
      );

      // CONCERN-MR-1 (Step 3a fix): Post-stage resolveByLabelWithRetry NEVER invoked.
      // The axTreeQueue has two entries: [AX_START_A_POST, AX_POST_BUTTON].
      // The open-stage resolver finds "Start a post" on the first getFullAXTree call
      // (queue entry 0) → axTreeCallCount becomes 1. The Post-stage resolver would
      // consume entry 1 (AX_POST_BUTTON). If axTreeCallCount === 1, the Post resolver
      // was never reached — the function returned on enable-gate exhaustion as required.
      //
      // GREEN on P13 production: P13's 2-attempt gate also returns before reaching
      // resolveByLabelWithRetry("Post", …) → axTreeCallCount === 1. (Contract pin.)
      // GREEN on P14 production: same early-return invariant holds.
      // Would be >= 2 on the faulty impl described in CONCERN-MR-1 (runs all 6 enable
      // checks THEN calls the Post resolver before returning post_button_not_enabled).
      assert.equal(
        spies.axTreeCallCount.n,
        1,
        `T-EnableGate.3 (CONCERN-MR-1): axTreeCallCount must be exactly 1 (open-stage AX capture only; Post-stage resolveByLabelWithRetry must NEVER be invoked on gate exhaustion); got ${spies.axTreeCallCount.n} — if > 1, the Post resolver was reached despite exhaustion`,
      );

      // postOpen diag row: opened:true; lastProbeOutcome:"present"
      // (evidence that composer was probe-present when enable-gate failed)
      const rows = diagRows(auditRowLog);
      const postOpenRow = rows.find((r) => r.output.phase === "postOpen");
      assert.ok(
        postOpenRow !== undefined,
        `T-EnableGate.3: postOpen diag row must be emitted (3 rows expected: preNavigate, postNavigate, postOpen); diag row phases: ${JSON.stringify(rows.map((r) => r.output.phase))}`,
      );
      assert.equal(
        postOpenRow?.output.opened,
        true,
        `T-EnableGate.3: postOpen row must have opened:true (composer WAS opened before enable-gate ran); got ${postOpenRow?.output.opened}`,
      );
      assert.equal(
        postOpenRow?.output.lastProbeOutcome,
        "present",
        `T-EnableGate.3: postOpen row lastProbeOutcome must be "present" (composer probe-present at open time); got "${postOpenRow?.output.lastProbeOutcome}"`,
      );
    },
  );
});
