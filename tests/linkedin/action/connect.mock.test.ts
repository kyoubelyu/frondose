/**
 * Phase NATIVE-PORT SLICE 3 — connect flow mock tests (fake-CDP fixtures).
 *
 * Source-under-test: src/linkedin/action/connect.ts
 *
 * Harness mirrors tests/linkedin/action/publishPost.mock.test.ts (fake CdpClient:
 * counted clickAt / raceHandle+insertText) + tests/linkedin/action/resolveScopedTarget.mock.test.ts
 * (hand-built CurrentSurfaceContext, but here WITH visible-scope inspections via
 * createVisibleScopeFromEntries so the "actions" / "connectPrompt" visible-scope handles resolve).
 *
 * Scope: profile-page connect ONLY (the personCard:N/network path is deferred to Slice 4 —
 * see connect.ts header). Behaviors: Connect-under-More resolution, connectPrompt scope poll,
 * with-note happy, without-note happy + advice/remember_recommended, no-double-dispatch.
 *
 * Runner:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/linkedin/action/connect.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import type { ActiveLayer, InspectSummary } from "../../../src/linkedin/logic/contracts/inspect.js";
import { connectViaAction } from "../../../src/linkedin/action/connect.js";
import type { CurrentSurfaceContext, RuntimeVisibleScopeInspection } from "../../../src/linkedin/logic/surface/currentSurfaceTypes.js";
import { createVisibleScopeFromEntries } from "../../../src/linkedin/logic/surface/visibleScopeCommon.js";

// Disable inter-tool pacing for the mock suite.
process.env.FRONDOSE_PACE_MIN_MS = "0";

const ROOT = resolve(import.meta.dirname, "../../..");

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function entry(role: string, name: string, ref: string): { ref: string; role: string; name: string } {
  return { ref, role, name };
}

function scopedContext(opts: {
  pageUrl: string;
  surface: string;
  activeLayer?: ActiveLayer;
  entries?: ReturnType<typeof entry>[];
  inspections?: RuntimeVisibleScopeInspection[];
  availableScopes?: { id: string; label: string }[];
}): CurrentSurfaceContext {
  const activeLayer = opts.activeLayer ?? "page";
  const inspections = opts.inspections ?? [];
  const summary: InspectSummary = {
    surface: opts.surface,
    activeLayer,
    availableScopes: opts.availableScopes ?? [],
    visibleScopes: inspections.map((i) => i.scope),
    text: [],
    buttons: [],
    inputs: [],
    interactiveRegions: [],
    ambiguityCases: [],
  };
  return {
    pageUrl: opts.pageUrl,
    surface: opts.surface,
    activeLayer,
    entries: opts.entries ?? [],
    repeatedControls: [],
    visibleScopeInspections: inspections,
    summary,
  };
}

const PROFILE_URL = "https://www.linkedin.com/in/jane-doe/";

function actionsScope(entries: ReturnType<typeof entry>[]): RuntimeVisibleScopeInspection {
  return createVisibleScopeFromEntries("actions", "profileActions", "Profile actions", "profileView", entries);
}

/** connectPrompt overlay with the without-note send control. */
function connectPromptWithoutNoteScope(): RuntimeVisibleScopeInspection {
  return createVisibleScopeFromEntries(
    "connectPrompt",
    "profileActions",
    "Connect prompt",
    "profileView",
    [entry("button", "Add a note", "@e30"), entry("button", "Send without a note", "@e31")],
  );
}

/** connectPrompt overlay in the note-entry state: Add-a-note button, note textbox, Send invitation. */
function connectPromptWithNoteScope(): RuntimeVisibleScopeInspection {
  return createVisibleScopeFromEntries("connectPrompt", "profileActions", "Connect prompt", "profileView", [
    entry("button", "Add a note", "@e30"),
    entry("textbox", "Please limit personal note to 300 characters", "@e32"),
    entry("button", "Send invitation", "@e33"),
  ]);
}

/** A profile context that already exposes both the Connect opener and the connect prompt. */
function profileReadyContext(promptScope: RuntimeVisibleScopeInspection): CurrentSurfaceContext {
  return scopedContext({
    pageUrl: PROFILE_URL,
    surface: "profile",
    entries: [entry("link", "Connect", "@e1")],
    inspections: [actionsScope([entry("link", "Connect", "@e1")]), promptScope],
    availableScopes: [{ id: "profileView", label: "Profile view" }],
  });
}

// ---------------------------------------------------------------------------
// Fake CdpClient (mirrors publishPost.mock.test.ts makeFakeActionClient)
// ---------------------------------------------------------------------------

interface FakeClientOpts {
  clickAtLog: string[];
  raceHandleLog: Array<{ label: string; text?: string }>;
  insertTextLog?: string[];
  clickAtThrowOnCall?: number;
  clickAtThrowError?: Error;
}

function makeFakeClient(opts: FakeClientOpts): unknown {
  let clickAtCallCount = 0;
  return {
    getCurrentUrl: async () => PROFILE_URL,
    clickAt: async (selector: string) => {
      clickAtCallCount++;
      opts.clickAtLog.push(selector);
      if (opts.clickAtThrowOnCall !== undefined && clickAtCallCount >= opts.clickAtThrowOnCall && opts.clickAtThrowError) {
        throw opts.clickAtThrowError;
      }
    },
    raceHandle: async <T>(p: Promise<T>, label: string): Promise<T> => {
      opts.raceHandleLog.push({ label });
      return p;
    },
    handle: {
      Input: {
        insertText: async (args: { text: string }) => {
          opts.insertTextLog?.push(args.text);
          return {};
        },
      },
    },
  };
}

interface CapturedAuditRow {
  toolName?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

function makeDeps(opts: {
  client: unknown;
  capture: () => Promise<CurrentSurfaceContext>;
  auditRowLog: CapturedAuditRow[];
  note?: string;
}): Record<string, unknown> {
  return {
    session: { inputMode: "cdp" },
    client: opts.client,
    auditPath: "/tmp/frondose-connect-audit.jsonl",
    workflowDeps: { emitFrame: () => {}, writeWorkflowAudit: () => {} },
    workflowId: "wf-connect-001",
    stepId: "step-connect-001",
    ...(opts.note !== undefined ? { note: opts.note } : {}),
    writeAuditRow: (_path: string, row: CapturedAuditRow) => opts.auditRowLog.push(row),
    captureCurrentSurfaceContext: opts.capture,
  };
}

// setTimeout spy — records ms, runs callbacks at 0ms.
function installSleepSpy(): { sleepLog: number[]; restore: () => void } {
  // biome-ignore lint/suspicious/noExplicitAny: spy override
  const orig: typeof setTimeout = (globalThis as any).setTimeout;
  const sleepLog: number[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: spy override
  (globalThis as any).setTimeout = (cb: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    sleepLog.push(ms ?? 0);
    // biome-ignore lint/suspicious/noExplicitAny: run at 0ms
    return orig(cb as any, 0, ...rest);
  };
  return { sleepLog, restore: () => { (globalThis as any).setTimeout = orig; } };
}

// ===========================================================================
// T-Connect.WithoutNote.1 — profile without-note happy path
// ===========================================================================

describe("connectViaAction — without-note happy path (T-Connect.WithoutNote.1)", () => {
  it(
    "T-Connect.WithoutNote.1: given a profile with a Connect action and a connect prompt exposing 'Send without a note' (no note supplied), " +
      "when connectViaAction runs, " +
      "then connected:true, dispatchAttempted:true, withNote:false, clickAt fires exactly twice (Connect open + Send), and advice contains a remember_recommended/connect entry",
    async () => {
      // Given: profile ready with Connect + without-note prompt.
      // When: connectViaAction runs with no note.
      // Then: connected; clickAt×2; remember_recommended advice for interaction 'connect'.
      const ctx = profileReadyContext(connectPromptWithoutNoteScope());
      const clickAtLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];
      const auditRowLog: CapturedAuditRow[] = [];
      const client = makeFakeClient({ clickAtLog, raceHandleLog });
      const deps = makeDeps({ client, capture: async () => ctx, auditRowLog });

      const { restore } = installSleepSpy();
      let result: Awaited<ReturnType<typeof connectViaAction>>;
      try {
        result = await connectViaAction(deps as never);
      } finally {
        restore();
      }

      assert.equal(result.connected, true, "connected must be true");
      assert.equal(result.dispatchAttempted, true, "dispatchAttempted must be true");
      assert.equal(result.fallbackAllowed, false, "fallbackAllowed must be false on success");
      assert.equal(result.withNote, false, "withNote must be false");
      assert.equal(clickAtLog.length, 2, "exactly 2 clickAt (Connect open + Send without a note)");

      const advice = result.advice ?? [];
      const remember = advice.find((a) => a.kind === "remember_recommended");
      assert.ok(remember, "advice must include remember_recommended");
      assert.equal(remember?.interaction, "connect", "remember_recommended interaction must be 'connect'");

      const row = auditRowLog[auditRowLog.length - 1];
      assert.equal(row?.output?.connected, true, "audit row output.connected must be true");
    },
  );
});

// ===========================================================================
// T-Connect.WithNote.1 — profile with-note happy path
// ===========================================================================

describe("connectViaAction — with-note happy path (T-Connect.WithNote.1)", () => {
  it(
    "T-Connect.WithNote.1: given a note is supplied and the connect prompt exposes 'Add a note', a note input, and 'Send invitation', " +
      "when connectViaAction runs, " +
      "then connected:true, withNote:true, clickAt fires 4× (Connect, Add a note, focus note, Send invitation), and the note text is inserted exactly once via Input.insertText",
    async () => {
      // Given: profile ready with Connect + note-state prompt; note = 'Hi Jane'.
      // When: connectViaAction runs with the note.
      // Then: connected; clickAt×4; one insertText carrying the note.
      const ctx = profileReadyContext(connectPromptWithNoteScope());
      const clickAtLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];
      const insertTextLog: string[] = [];
      const auditRowLog: CapturedAuditRow[] = [];
      const client = makeFakeClient({ clickAtLog, raceHandleLog, insertTextLog });
      const deps = makeDeps({ client, capture: async () => ctx, auditRowLog, note: "Hi Jane" });

      const { restore } = installSleepSpy();
      let result: Awaited<ReturnType<typeof connectViaAction>>;
      try {
        result = await connectViaAction(deps as never);
      } finally {
        restore();
      }

      assert.equal(result.connected, true, "connected must be true");
      assert.equal(result.withNote, true, "withNote must be true");
      assert.equal(clickAtLog.length, 4, "exactly 4 clickAt (Connect + Add a note + focus note + Send invitation)");

      const inserts = raceHandleLog.filter((e) => e.label === "Input.insertText");
      assert.equal(inserts.length, 1, "exactly one Input.insertText for the note");
      assert.equal(insertTextLog.length, 1, "exactly one insertText payload recorded");
      assert.equal(insertTextLog[0], "Hi Jane", "the inserted note text must equal the supplied note");
    },
  );
});

// ===========================================================================
// T-Connect.More.1 — Connect-under-"More" overflow resolution
// ===========================================================================

describe("connectViaAction — Connect-under-More overflow (T-Connect.More.1)", () => {
  it(
    "T-Connect.More.1: given the primary profile action is Follow (Connect absent from the actions scope) with a 'More' overflow, " +
      "when connectViaAction runs, " +
      "then it clicks 'More' to reveal the overflow Connect, then opens the prompt and sends — connected:true and the first click targets the More control",
    async () => {
      // Given: actions scope has Follow + More (no Connect) until More is clicked, then a top-level Connect menuitem appears.
      // When: connectViaAction runs without a note.
      // Then: More click precedes the Connect open; connected:true; clickAt = [More, Connect, Send].
      const followCtx = scopedContext({
        pageUrl: PROFILE_URL,
        surface: "profile",
        entries: [entry("link", "Follow", "@e1"), entry("button", "More", "@e2")],
        inspections: [
          actionsScope([entry("link", "Follow", "@e1"), entry("button", "More", "@e2")]),
          connectPromptWithoutNoteScope(),
        ],
        availableScopes: [{ id: "profileView", label: "Profile view" }],
      });
      // After clicking More, Connect surfaces as a top-level menuitem entry (resolved without a scope).
      const afterMoreCtx = scopedContext({
        pageUrl: PROFILE_URL,
        surface: "profile",
        entries: [entry("menuitem", "Connect", "@e5")],
        inspections: [
          actionsScope([entry("link", "Follow", "@e1"), entry("button", "More", "@e2")]),
          connectPromptWithoutNoteScope(),
        ],
        availableScopes: [{ id: "profileView", label: "Profile view" }],
      });

      const clickAtLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];
      const auditRowLog: CapturedAuditRow[] = [];
      let moreClicked = false;
      const client = makeFakeClient({ clickAtLog, raceHandleLog });
      // Wrap clickAt to flip the surface once "More" (@e2) is clicked.
      const rawClick = (client as { clickAt: (s: string) => Promise<void> }).clickAt;
      (client as { clickAt: (s: string) => Promise<void> }).clickAt = async (selector: string) => {
        if (selector.includes("e2")) moreClicked = true;
        await rawClick(selector);
      };
      const capture = async () => (moreClicked ? afterMoreCtx : followCtx);
      const deps = makeDeps({ client, capture, auditRowLog });

      const { restore } = installSleepSpy();
      let result: Awaited<ReturnType<typeof connectViaAction>>;
      try {
        result = await connectViaAction(deps as never);
      } finally {
        restore();
      }

      assert.equal(result.connected, true, "connected must be true via the More-overflow path");
      assert.equal(clickAtLog.length, 3, "clickAt = [More, Connect(open), Send without a note]");
      assert.ok(clickAtLog[0]?.includes("e2"), "the first click must target the 'More' control (@e2)");
    },
  );
});

// ===========================================================================
// T-Connect.PromptPoll.1 — connectPrompt scope appears after polling
// ===========================================================================

describe("connectViaAction — connectPrompt scope poll (T-Connect.PromptPoll.1)", () => {
  it(
    "T-Connect.PromptPoll.1: given the connect prompt is absent for the first two capture attempts then appears, " +
      "when connectViaAction runs, " +
      "then it polls (>=1 sleep of 250ms) and still completes with connected:true",
    async () => {
      // Given: actions scope always present; connectPrompt appears only from the 3rd capture call.
      // When: connectViaAction runs without a note.
      // Then: connected:true and at least one 250ms scope-ready sleep is observed.
      const noPrompt = scopedContext({
        pageUrl: PROFILE_URL,
        surface: "profile",
        entries: [entry("link", "Connect", "@e1")],
        inspections: [actionsScope([entry("link", "Connect", "@e1")])],
        availableScopes: [{ id: "profileView", label: "Profile view" }],
      });
      const withPrompt = profileReadyContext(connectPromptWithoutNoteScope());

      // Captures before the send-resolve poll: auth(1) + Connect-resolve(2). The send resolve's
      // first connectPrompt capture is call 3; make the prompt appear only at call 5 so the
      // send resolve must poll (sleep 250ms) twice before it succeeds.
      let captureCalls = 0;
      const capture = async () => {
        captureCalls++;
        return captureCalls >= 5 ? withPrompt : noPrompt;
      };
      const clickAtLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];
      const auditRowLog: CapturedAuditRow[] = [];
      const client = makeFakeClient({ clickAtLog, raceHandleLog });
      const deps = makeDeps({ client, capture, auditRowLog });

      const { sleepLog, restore } = installSleepSpy();
      let result: Awaited<ReturnType<typeof connectViaAction>>;
      try {
        result = await connectViaAction(deps as never);
      } finally {
        restore();
      }

      assert.equal(result.connected, true, "connected must be true after polling");
      const promptSleeps = sleepLog.filter((ms) => ms === 250);
      assert.ok(promptSleeps.length >= 1, `expected >=1 250ms scope-ready sleep, got [${sleepLog.join(",")}]`);
    },
  );
});

// ===========================================================================
// T-Connect.PromptUnavailable.1 — prompt never appears → no send, fallback
// ===========================================================================

describe("connectViaAction — connectPrompt never available (T-Connect.PromptUnavailable.1)", () => {
  it(
    "T-Connect.PromptUnavailable.1: given the connect prompt never becomes available after the Connect open click, " +
      "when connectViaAction runs, " +
      "then reason:'connect_prompt_unavailable', dispatchAttempted:false, fallbackAllowed:true, and exactly ONE clickAt (the Connect open — no send dispatched)",
    async () => {
      // Given: actions scope present, connectPrompt never present.
      // When: connectViaAction runs without a note.
      // Then: no send click; pre-dispatch failure.
      const ctx = scopedContext({
        pageUrl: PROFILE_URL,
        surface: "profile",
        entries: [entry("link", "Connect", "@e1")],
        inspections: [actionsScope([entry("link", "Connect", "@e1")])],
        availableScopes: [{ id: "profileView", label: "Profile view" }],
      });
      const clickAtLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];
      const auditRowLog: CapturedAuditRow[] = [];
      const client = makeFakeClient({ clickAtLog, raceHandleLog });
      const deps = makeDeps({ client, capture: async () => ctx, auditRowLog });

      const { restore } = installSleepSpy();
      let result: Awaited<ReturnType<typeof connectViaAction>>;
      try {
        result = await connectViaAction(deps as never);
      } finally {
        restore();
      }

      assert.equal(result.reason, "connect_prompt_unavailable", "reason must be connect_prompt_unavailable");
      assert.equal(result.dispatchAttempted, false, "dispatchAttempted must be false (no send)");
      assert.equal(result.fallbackAllowed, true, "fallbackAllowed must be true (pre-dispatch)");
      assert.equal(clickAtLog.length, 1, "exactly one clickAt (Connect open only — no send)");
    },
  );
});

// ===========================================================================
// T-Connect.NoDoubleDispatch.1 — post-dispatch throw + single-latch source invariant
// ===========================================================================

describe("connectViaAction — no-double-dispatch (T-Connect.NoDoubleDispatch.1)", () => {
  it(
    "T-Connect.NoDoubleDispatch.1: given the send clickAt THROWS post-dispatch, " +
      "when connectViaAction unwinds, " +
      "then dispatchAttempted:true, fallbackAllowed:false, reason:'connect_dispatch_ambiguous', the send is attempted exactly once, " +
      "AND source has exactly ONE `dispatchAttempted = true;` assignment and ONE `clickAt(sendResolved.target.selector)` dispatch line",
    async () => {
      // Given: the send (2nd) clickAt throws.
      // When: connectViaAction unwinds after the latch is set.
      // Then: ambiguous post-dispatch result; no retry; single-latch/single-dispatch source invariant.
      const ctx = profileReadyContext(connectPromptWithoutNoteScope());
      const clickAtLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];
      const auditRowLog: CapturedAuditRow[] = [];
      // clickAt calls: [1]=Connect open, [2]=Send → throw on the 2nd.
      const client = makeFakeClient({
        clickAtLog,
        raceHandleLog,
        clickAtThrowOnCall: 2,
        clickAtThrowError: new Error("simulated post-dispatch throw"),
      });
      const deps = makeDeps({ client, capture: async () => ctx, auditRowLog });

      const { restore } = installSleepSpy();
      let result: Awaited<ReturnType<typeof connectViaAction>>;
      try {
        result = await connectViaAction(deps as never);
      } finally {
        restore();
      }

      assert.equal(result.dispatchAttempted, true, "dispatchAttempted must be true (latch set before send)");
      assert.equal(result.fallbackAllowed, false, "fallbackAllowed must be false (post-dispatch ambiguous)");
      assert.equal(result.reason, "connect_dispatch_ambiguous", "reason must be connect_dispatch_ambiguous");
      assert.equal(clickAtLog.length, 2, "exactly 2 clickAt (Connect open + the send that threw) — no retry");

      const source = readFileSync(resolve(ROOT, "src/linkedin/action/connect.ts"), "utf-8");
      const latchLines = source.split("\n").filter((l) => /^\s*dispatchAttempted\s*=\s*true;\s*$/.test(l));
      assert.equal(latchLines.length, 1, "source must have exactly ONE `dispatchAttempted = true;` assignment line");
      const dispatchLines = source
        .split("\n")
        .filter((l) => /^\s*await deps\.client\.clickAt\(sendResolved\.target\.selector\)/.test(l));
      assert.equal(dispatchLines.length, 1, "source must have exactly ONE send-dispatch clickAt line");
    },
  );
});
