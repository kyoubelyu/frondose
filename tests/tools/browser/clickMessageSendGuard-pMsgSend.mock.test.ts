/**
 * P-MSG-SEND Scope A — message_send approval gate.
 *
 * Covers the narrowed approval-only phase:
 * - Manual unapproved Send on messaging surfaces is blocked.
 * - Manual approved Send is allowed.
 * - General-web Send remains ungated.
 * - Auto-mode message_send is fail-closed before CDP dispatch.
 *
 * T-MsgSend.6..9 are deferred to P-MSG-SEND-LEDGER: daily quota, cooldown, ledger write, and latch tests.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/tools/browser/clickMessageSendGuard-pMsgSend.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.FRONDOSE_PACE_MIN_MS = "0";
process.env.FRONDOSE_PACE_MAX_MS = "0";

// biome-ignore lint/suspicious/noExplicitAny: runtime resolution
type AnyFn = (...args: any[]) => any;
// biome-ignore lint/suspicious/noExplicitAny: mock session shape
type AnyObj = Record<string, any>;

type ClickAtSpy = {
  called: boolean;
  calledWith?: string;
};

type ApprovalSpy = {
  calls: Array<{ label: string; surface: string }>;
  result: boolean;
};

function reasonOf(result: AnyObj): string | undefined {
  return result.reason ?? result.error?.reason;
}

async function loadMakeClickTool(): Promise<AnyFn> {
  const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
  const makeClickTool: AnyFn | null = (mod as AnyObj | null)?.makeClickTool ?? null;
  if (!makeClickTool) {
    assert.fail("makeClickTool not importable from src/tools/browser/click.ts");
  }
  return makeClickTool;
}

function makeApprovalSpy(result: boolean): ApprovalSpy & ((label: string, surface: string) => boolean) {
  const spy = ((label: string, surface: string) => {
    spy.calls.push({ label, surface });
    return spy.result;
  }) as ApprovalSpy & ((label: string, surface: string) => boolean);
  spy.calls = [];
  spy.result = result;
  return spy;
}

function makeMockSession(opts: {
  clickLabel?: string;
  clickSurface?: string;
  clickAtSpy?: ClickAtSpy;
  canClickOutbound?: ((label: string, surface: string) => boolean) | undefined;
  resolvedMode?: (() => "manual" | "magical" | "auto") | undefined;
  autoRun?: (() => { runId: string; maxConnects: number | null; connectSentCount: number } | null) | undefined;
  dailyOutbound?: (() => { remaining: number; cooldownRemainingMs: number } | null) | undefined;
}): AnyObj {
  const {
    clickLabel = "Send",
    clickSurface = "messaging-thread",
    clickAtSpy,
    canClickOutbound,
    resolvedMode,
    autoRun,
    dailyOutbound,
  } = opts;

  const fakeRef = "@e42";
  const fakeClient = {
    currentRefMap: {} as AnyObj,
    clickAt: async (ref: string) => {
      if (clickAtSpy) {
        clickAtSpy.called = true;
        clickAtSpy.calledWith = ref;
      }
    },
    getBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
    verifyRef: async (_refKey: string, _expected: { role: string; name?: string }) => ({
      matches: true,
    }),
  };

  let currentContext: AnyObj = {
    surface: clickSurface,
    entries: [{ ref: fakeRef, name: clickLabel, role: "button", clickable: true }],
  };

  return {
    getOrInitClient: async () => ({ ok: true, client: fakeClient }),
    getLastContext: () => currentContext,
    setLastContext: (ctx: AnyObj) => {
      currentContext = ctx;
    },
    showAgentTarget: undefined,
    inputMode: "cdp",
    canClickOutbound,
    resolvedMode,
    autoRun,
    dailyOutbound,
  };
}

describe("T-MsgSend: Manual approval gate", () => {
  it("T-MsgSend.1: unapproved Manual Send on messaging-thread is blocked before CDP dispatch", async () => {
    // Given: Manual mode, messaging-thread surface, and no operator approval.
    // When: click(label:"Send") runs.
    // Then: the approval gate returns approval_required and clickAt is not dispatched.
    const clickAtSpy: ClickAtSpy = { called: false };
    const approvalSpy = makeApprovalSpy(false);
    const session = makeMockSession({
      clickLabel: "Send",
      clickSurface: "messaging-thread",
      clickAtSpy,
      canClickOutbound: approvalSpy,
      resolvedMode: () => "manual",
    });

    const makeClickTool = await loadMakeClickTool();
    const result = await makeClickTool(session).execute({ label: "Send" });

    assert.equal(result.ok, false, `unapproved message_send must fail; got ${JSON.stringify(result)}`);
    assert.equal(result.error?.kind, "invalid_input");
    assert.equal(reasonOf(result), "approval_required");
    assert.match(result.error?.message ?? "", /messaging-thread/);
    assert.equal(clickAtSpy.called, false, "clickAt must not fire before approval");
    assert.deepEqual(approvalSpy.calls, [{ label: "Send", surface: "messaging-thread" }]);
  });

  it("T-MsgSend.2: approved Manual Send on messaging-thread is allowed and dispatches one click", async () => {
    // Given: Manual mode, messaging-thread surface, and operator approval.
    // When: click(label:"Send") runs.
    // Then: the click succeeds and CDP receives exactly one dispatch.
    const clickAtSpy: ClickAtSpy = { called: false };
    const approvalSpy = makeApprovalSpy(true);
    const session = makeMockSession({
      clickLabel: "Send",
      clickSurface: "messaging-thread",
      clickAtSpy,
      canClickOutbound: approvalSpy,
      resolvedMode: () => "manual",
    });

    const makeClickTool = await loadMakeClickTool();
    const result = await makeClickTool(session).execute({ label: "Send" });

    assert.equal(result.ok, true, `approved message_send must succeed; got ${JSON.stringify(result)}`);
    assert.equal(clickAtSpy.called, true, "clickAt must fire after approval");
    assert.equal(clickAtSpy.calledWith, "@e42");
    assert.deepEqual(approvalSpy.calls, [{ label: "Send", surface: "messaging-thread" }]);
  });

  it("T-MsgSend.3: Manual Send on messaging also requires approval", async () => {
    // Given: Manual mode, messaging surface, and no operator approval.
    // When: click(label:"Send") runs.
    // Then: the approval gate blocks and CDP is not dispatched.
    const clickAtSpy: ClickAtSpy = { called: false };
    const approvalSpy = makeApprovalSpy(false);
    const session = makeMockSession({
      clickLabel: "Send",
      clickSurface: "messaging",
      clickAtSpy,
      canClickOutbound: approvalSpy,
      resolvedMode: () => "manual",
    });

    const makeClickTool = await loadMakeClickTool();
    const result = await makeClickTool(session).execute({ label: "Send" });

    assert.equal(
      result.ok,
      false,
      `message_send on messaging must fail without approval; got ${JSON.stringify(result)}`,
    );
    assert.equal(reasonOf(result), "approval_required");
    assert.equal(clickAtSpy.called, false, "clickAt must not fire before approval");
    assert.deepEqual(approvalSpy.calls, [{ label: "Send", surface: "messaging" }]);
  });

  it("T-MsgSend.4: non-LinkedIn Send is not gated by the LinkedIn approval guard", async () => {
    // Given: a general-web surface and a Send label.
    // When: click(label:"Send") runs.
    // Then: the LinkedIn outbound approval hook is not called and the click dispatches.
    const clickAtSpy: ClickAtSpy = { called: false };
    const approvalSpy = makeApprovalSpy(false);
    const session = makeMockSession({
      clickLabel: "Send",
      clickSurface: "",
      clickAtSpy,
      canClickOutbound: approvalSpy,
      resolvedMode: () => "manual",
    });

    const makeClickTool = await loadMakeClickTool();
    const result = await makeClickTool(session).execute({ label: "Send" });

    assert.equal(result.ok, true, `general-web Send must remain allowed; got ${JSON.stringify(result)}`);
    assert.equal(clickAtSpy.called, true, "general-web click should dispatch");
    assert.deepEqual(approvalSpy.calls, [], "general-web carve-out must not call the outbound approval hook");
  });

  it("T-MsgSend.Localized.1: Chinese Send on messaging-thread is gated before CDP dispatch", async () => {
    // Given: a localized Chinese message-send label on messaging-thread with no approval.
    // When: click(label:"发送消息") runs.
    // Then: the localized Send family still routes through approval_required.
    const clickAtSpy: ClickAtSpy = { called: false };
    const approvalSpy = makeApprovalSpy(false);
    const session = makeMockSession({
      clickLabel: "发送消息",
      clickSurface: "messaging-thread",
      clickAtSpy,
      canClickOutbound: approvalSpy,
      resolvedMode: () => "manual",
    });

    const makeClickTool = await loadMakeClickTool();
    const result = await makeClickTool(session).execute({ label: "发送消息" });

    assert.equal(result.ok, false, `localized message_send must fail without approval; got ${JSON.stringify(result)}`);
    assert.equal(reasonOf(result), "approval_required");
    assert.equal(clickAtSpy.called, false, "clickAt must not fire before approval");
    assert.deepEqual(approvalSpy.calls, [{ label: "发送消息", surface: "messaging-thread" }]);
  });
});

describe("T-MsgSend: Auto fail-closed", () => {
  it("T-MsgSend.5: Auto-mode Send on messaging-thread is fail-closed even when approval hook returns true", async () => {
    // Given: Auto mode, a running auto-run seam, and canClickOutbound returning true.
    // When: click(label:"Send") runs without any dailyOutbound hook wired.
    // Then: Auto message_send is rejected unconditionally before CDP dispatch.
    const clickAtSpy: ClickAtSpy = { called: false };
    const approvalSpy = makeApprovalSpy(true);
    const session = makeMockSession({
      clickLabel: "Send",
      clickSurface: "messaging-thread",
      clickAtSpy,
      canClickOutbound: approvalSpy,
      resolvedMode: () => "auto",
      autoRun: () => ({ runId: "r1", maxConnects: 5, connectSentCount: 0 }),
    });

    const makeClickTool = await loadMakeClickTool();
    const result = await makeClickTool(session).execute({ label: "Send" });

    assert.equal(result.ok, false, `Auto message_send must fail closed; got ${JSON.stringify(result)}`);
    assert.equal(result.error?.kind, "invalid_input");
    assert.equal(reasonOf(result), "approval_required");
    assert.equal(clickAtSpy.called, false, "Auto message_send must not dispatch CDP clickAt");
    assert.deepEqual(approvalSpy.calls, [{ label: "Send", surface: "messaging-thread" }]);
  });
});
