/**
 * P-63 Step 5 — T-Guard.1..11 (filled)
 * click.ts outbound-send safety guard integration tests (mock session + fake CDP).
 *
 * Assertions filled per plan §5.3 (F-3 guard sketch) + §6.2.
 *
 * Expected failures at Step 5 due to builder deviations:
 *   D-P63-B: guard returns {success:false, blocked:true, reason:...} instead of
 *     fail("click","invalid_input","Outbound action blocked:...") = {ok:false,error:{kind:"invalid_input"}}
 *   D-P63-C: surface:"unknown" not bypassed (requiresApproval ignores surface for non-Follow labels)
 *   D-P63-D: Follow on profile not blocked (requiresApproval("Follow","profile") returns false)
 *
 * Note: "allow" tests call `await session.getClient().snapshot()` to populate the
 * CdpClient.refMap so `clickAt("@e1")` resolves the ref. "block" tests skip this since
 * the guard returns before clickAt is reached.
 *
 * MAI_PACE_MIN_MS=0 to disable inter-tool pacing.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/browser/click-outboundGuard.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/types.js";
import { makeClickTool } from "../../../src/tools/browser/click.js";

process.env.FRONDOSE_PACE_MIN_MS = "0";

const abortSignal = new AbortController().signal;

/** Minimal box-model border for a 20×10 button at (10,20). */
const FAKE_BORDER = [10, 20, 30, 20, 30, 30, 10, 30];

/** Tool-call context required by Vercel AI SDK execute(). */
const CTX = { toolCallId: "t-guard", messages: [] as never[], abortSignal };

interface FakeSessionOpts {
  surface?: CurrentSurfaceContext["surface"];
  entries?: CurrentSurfaceContext["entries"];
  pageUrl?: string;
  canClickOutbound?: (label: string, surface: string) => boolean;
}

interface FakeHandle {
  Accessibility: {
    enable: () => Promise<void>;
    getFullAXTree: (_args?: unknown) => Promise<{ nodes: unknown[] }>;
  };
  DOM: {
    getDocument: (_args: unknown) => Promise<{ root: { nodeId: number } }>;
    querySelectorAll: (_args: unknown) => Promise<{ nodeIds: number[] }>;
    getBoxModel: (_args: unknown) => Promise<{ model: { border: number[] } }>;
  };
  Input: {
    dispatchMouseEvent: (_args: unknown) => Promise<void>;
    callCount: number;
  };
}

function makeFakeSession(opts: FakeSessionOpts = {}) {
  const { surface = "network", entries = [], pageUrl, canClickOutbound } = opts;

  // Build AX tree nodes from supplied entries so CdpClient.snapshot() populates refMap.
  const nodes = entries.map((e, idx) => ({
    nodeId: `ax${idx + 1}`,
    role: { type: "role", value: e.role },
    name: { type: "string", value: e.name },
    backendDOMNodeId: 100 + idx,
  }));

  const fakeHandle: FakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async (_args?: unknown) => ({ nodes }),
    },
    DOM: {
      getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (_args: unknown) => ({ nodeIds: [] }),
      scrollIntoViewIfNeeded: async (_arg: unknown) => {},
      getBoxModel: async (_args: unknown) => ({ model: { border: FAKE_BORDER } }),
    },
    Input: {
      dispatchMouseEvent: async (_args: unknown) => {},
      callCount: 0,
    },
  };

  // Wrap dispatchMouseEvent with a spy.
  const originalDispatch = fakeHandle.Input.dispatchMouseEvent.bind(fakeHandle.Input);
  fakeHandle.Input.dispatchMouseEvent = async (args: unknown) => {
    fakeHandle.Input.callCount++;
    return originalDispatch(args);
  };

  const client = CdpClient.fromHandle(fakeHandle);

  const defaultUrl =
    surface === "unknown"
      ? "https://github.com/kyoubelyu/frondose"
      : `https://www.linkedin.com/${surface ?? "mynetwork"}/`;

  const lastCtx: CurrentSurfaceContext | undefined =
    entries.length > 0
      ? {
          pageUrl: pageUrl ?? defaultUrl,
          surface,
          activeLayer: "page" as const,
          entries,
        }
      : undefined;

  const session = {
    inputMode: "cdp" as const,
    getOrInitClient: () => Promise.resolve({ ok: true as const, client }),
    getClient: () => client,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => lastCtx,
    ...(canClickOutbound !== undefined ? { canClickOutbound } : {}),
  };

  return { session, fakeHandle };
}

// ─── Shared entry fixtures ────────────────────────────────────────────────────
const INVITE_ENTRY = { ref: "@e1", role: "button" as const, name: "Invite 杨哲 to connect" };
const CONNECT_ENTRY = { ref: "@e1", role: "button" as const, name: "Connect" };
const READ_MORE_ENTRY = { ref: "@e1", role: "button" as const, name: "Read more" };
const FOLLOW_ENTRY = { ref: "@e1", role: "button" as const, name: "Follow" };
const CHINESE_INVITE_ENTRY = { ref: "@e1", role: "button" as const, name: "邀请杨哲加入领英" };

describe("T-Guard — click.ts outbound-send safety guard (P-63)", () => {
  // ─── T-Guard.1 ──────────────────────────────────────────────────────────────
  it(
    "T-Guard.1: when hook denies + Invite-to-connect on network surface, click returns failure envelope; CDP not dispatched",
    { timeout: 5000 },
    async () => {
      // Given: session whose getLastContext() returns surface:"network" with
      //   entries:[{ref:"@e1", role:"button", name:"Invite 杨哲 to connect"}]
      //   AND canClickOutbound = () => false
      // When:  clickTool.execute({ref:"@e1"})
      // Then:  {ok:false, command:"click", error:{kind:"invalid_input", message: /Outbound.*Invite.*network/}}
      //        AND Input.dispatchMouseEvent spy was NEVER invoked
      //   Covers G-P63.4 (scout-incident reproduction)
      const { session, fakeHandle } = makeFakeSession({
        surface: "network",
        entries: [INVITE_ENTRY],
        canClickOutbound: () => false,
      });
      const tool = makeClickTool(session);

      // biome-ignore lint/suspicious/noExplicitAny: envelope type assertion
      const result = (await tool.execute({ ref: "@e1" }, CTX)) as any;

      // Plan spec: ok:false + error.kind:invalid_input + message cites label + surface
      assert.strictEqual(result.ok, false, "blocked click must return ok:false (plan §5.3 fail() return)");
      assert.strictEqual(
        result.error?.kind,
        "invalid_input",
        'blocked click error.kind must be \'invalid_input\' (plan §5.3 fail("click","invalid_input",...))',
      );
      assert.ok(
        /Outbound/i.test(result.error?.message ?? ""),
        `blocked message must mention "Outbound" — got: ${result.error?.message}`,
      );
      // Outcome-anchored: CDP must NOT have fired
      assert.strictEqual(fakeHandle.Input.callCount, 0, "Input.dispatchMouseEvent must NOT fire when blocked");
    },
  );

  // ─── T-Guard.2 ──────────────────────────────────────────────────────────────
  it(
    "T-Guard.2: when hook permits + same Invite-to-connect on network surface, click dispatches normally",
    { timeout: 5000 },
    async () => {
      // Given: same context + canClickOutbound = () => true (approved step)
      // When:  clickTool.execute({ref:"@e1"})
      // Then:  envelope is ok:true with data.hint present
      //        AND Input.dispatchMouseEvent spy was invoked at least once
      //   Covers G-P63.5 (post-approval pass-through)
      const { session, fakeHandle } = makeFakeSession({
        surface: "network",
        entries: [INVITE_ENTRY],
        canClickOutbound: () => true,
      });
      // Populate refMap so clickAt("@e1") resolves without error.
      await session.getClient().snapshot();

      const tool = makeClickTool(session);
      // biome-ignore lint/suspicious/noExplicitAny: envelope type assertion
      const result = (await tool.execute({ ref: "@e1" }, CTX)) as any;

      assert.strictEqual(result.ok, true, "approved click must return ok:true");
      assert.ok(result.data?.hint != null, "approved click must carry state-change hint");
      assert.ok(fakeHandle.Input.callCount >= 1, "CDP dispatchMouseEvent must fire when guard permits");
    },
  );

  // ─── T-Guard.3 ──────────────────────────────────────────────────────────────
  it(
    "T-Guard.3: when bare 'Connect' label on network surface + deny hook, click is blocked",
    { timeout: 5000 },
    async () => {
      // Given: entries:[{ref:"@e1", role:"button", name:"Connect"}], surface:"network",
      //   canClickOutbound = () => false
      // When:  clickTool.execute({ref:"@e1"})
      // Then:  {ok:false, error:{kind:"invalid_input"}} — covers sidebar bare-Connect variant
      //   Covers G-P63.4 (bare Connect sidebar variant)
      const { session, fakeHandle } = makeFakeSession({
        surface: "network",
        entries: [CONNECT_ENTRY],
        canClickOutbound: () => false,
      });
      const tool = makeClickTool(session);
      // biome-ignore lint/suspicious/noExplicitAny: envelope type assertion
      const result = (await tool.execute({ ref: "@e1" }, CTX)) as any;

      assert.strictEqual(result.ok, false, "bare Connect + deny must return ok:false");
      assert.strictEqual(result.error?.kind, "invalid_input", "blocked error.kind must be 'invalid_input'");
      assert.strictEqual(fakeHandle.Input.callCount, 0, "CDP must NOT fire when blocked");
    },
  );

  // ─── T-Guard.4 ──────────────────────────────────────────────────────────────
  it(
    "T-Guard.4: when surface='unknown' (general web) + English 'Connect' + deny hook, guard does NOT fire → ok:true",
    { timeout: 5000 },
    async () => {
      // Given: context with surface:"unknown", pageUrl:"https://github.com/...",
      //   name:"Connect", canClickOutbound = () => false
      // When:  clickTool.execute({ref:"@e1"})
      // Then:  envelope ok:true (guard bypassed for non-LinkedIn surfaces)
      //        Covers G-P63.6 — P-33 general-web capability unaffected
      const { session, fakeHandle } = makeFakeSession({
        surface: "unknown",
        entries: [CONNECT_ENTRY],
        canClickOutbound: () => false,
      });
      // Populate refMap for the allow path.
      await session.getClient().snapshot();

      const tool = makeClickTool(session);
      // biome-ignore lint/suspicious/noExplicitAny: envelope type assertion
      const result = (await tool.execute({ ref: "@e1" }, CTX)) as any;

      assert.strictEqual(
        result.ok,
        true,
        "guard must NOT fire on surface:unknown — P-33 general web must be unaffected",
      );
      assert.ok(fakeHandle.Input.callCount >= 1, "CDP must dispatch when surface is unknown");
    },
  );

  // ─── T-Guard.5 ──────────────────────────────────────────────────────────────
  it(
    "T-Guard.5: when canClickOutbound undefined (REPL mode) + Invite-to-connect on network, guard does NOT fire → ok:true",
    { timeout: 5000 },
    async () => {
      // Given: fake session does NOT have canClickOutbound set (REPL/no-hook mode)
      //   surface:"network", name:"Invite 杨哲 to connect"
      // When:  clickTool.execute({ref:"@e1"})
      // Then:  envelope ok:true — guard is bypassed (OQ-4 REPL exclusion)
      //   Covers G-P63.7
      const { session, fakeHandle } = makeFakeSession({
        surface: "network",
        entries: [INVITE_ENTRY],
        // No canClickOutbound → REPL mode
      });
      await session.getClient().snapshot();

      const tool = makeClickTool(session);
      // biome-ignore lint/suspicious/noExplicitAny: envelope type assertion
      const result = (await tool.execute({ ref: "@e1" }, CTX)) as any;

      assert.strictEqual(result.ok, true, "REPL mode (no hook) must allow the click");
      assert.ok(fakeHandle.Input.callCount >= 1, "CDP must dispatch in REPL mode");
    },
  );

  // ─── T-Guard.6 ──────────────────────────────────────────────────────────────
  it(
    "T-Guard.6: when benign label 'Read more' on profile surface + deny hook, guard does NOT fire → ok:true",
    { timeout: 5000 },
    async () => {
      // Given: name:"Read more", surface:"profile", canClickOutbound = () => false
      // When:  clickTool.execute({ref:"@e1"})
      // Then:  envelope ok:true — benign label never triggers guard
      //   Covers G-P63.8 (regex anti-false-positive)
      const { session, fakeHandle } = makeFakeSession({
        surface: "profile",
        entries: [READ_MORE_ENTRY],
        canClickOutbound: () => false,
      });
      await session.getClient().snapshot();

      const tool = makeClickTool(session);
      // biome-ignore lint/suspicious/noExplicitAny: envelope type assertion
      const result = (await tool.execute({ ref: "@e1" }, CTX)) as any;

      assert.strictEqual(result.ok, true, "benign label must not be blocked");
      assert.ok(fakeHandle.Input.callCount >= 1, "CDP must dispatch for benign label");
    },
  );

  // ─── T-Guard.7 ──────────────────────────────────────────────────────────────
  it("T-Guard.7: when 'Follow' on profile surface + deny hook, click is blocked", { timeout: 5000 }, async () => {
    // Given: name:"Follow", surface:"profile", canClickOutbound = () => false
    // When:  clickTool.execute({ref:"@e1"})
    // Then:  {ok:false, error:{kind:"invalid_input"}}
    //   OQ-1: Follow on profile is a social outbound signal → guarded
    //   Covers G-P63.9 (profile-surface Follow guard)
    const { session, fakeHandle } = makeFakeSession({
      surface: "profile",
      entries: [FOLLOW_ENTRY],
      canClickOutbound: () => false,
    });
    const tool = makeClickTool(session);
    // biome-ignore lint/suspicious/noExplicitAny: envelope type assertion
    const result = (await tool.execute({ ref: "@e1" }, CTX)) as any;

    assert.strictEqual(
      result.ok,
      false,
      "Follow on profile + deny must return ok:false (OQ-1 surface-conditional guard)",
    );
    assert.strictEqual(result.error?.kind, "invalid_input", "blocked Follow error.kind must be 'invalid_input'");
    assert.strictEqual(fakeHandle.Input.callCount, 0, "CDP must NOT fire for Follow on profile when denied");
  });

  // ─── T-Guard.8 ──────────────────────────────────────────────────────────────
  it(
    "T-Guard.8: when 'Follow' on company surface + deny hook, guard does NOT fire → ok:true",
    { timeout: 5000 },
    async () => {
      // Given: name:"Follow", surface:"company", canClickOutbound = () => false
      // When:  clickTool.execute({ref:"@e1"})
      // Then:  envelope ok:true — company Follow is benign content interest (OQ-1 carve-out)
      //   Covers G-P63.9 (company-Follow carve-out)
      const { session, fakeHandle } = makeFakeSession({
        surface: "company",
        entries: [FOLLOW_ENTRY],
        canClickOutbound: () => false,
      });
      await session.getClient().snapshot();

      const tool = makeClickTool(session);
      // biome-ignore lint/suspicious/noExplicitAny: envelope type assertion
      const result = (await tool.execute({ ref: "@e1" }, CTX)) as any;

      assert.strictEqual(result.ok, true, "Follow on company must not be blocked (OQ-1 carve-out)");
      assert.ok(fakeHandle.Input.callCount >= 1, "CDP must dispatch for company Follow");
    },
  );

  // ─── T-Guard.9 ──────────────────────────────────────────────────────────────
  it(
    "T-Guard.9: when Chinese label '邀请杨哲加入领英' on network surface + deny hook, click is blocked",
    { timeout: 5000 },
    async () => {
      // Given: name:"邀请杨哲加入领英", surface:"network", canClickOutbound = () => false
      // When:  clickTool.execute({ref:"@e1"})
      // Then:  {ok:false, error:{kind:"invalid_input"}} — covers OQ-3 multi-language
      //   Covers G-P63.4 (Chinese pattern match)
      const { session, fakeHandle } = makeFakeSession({
        surface: "network",
        entries: [CHINESE_INVITE_ENTRY],
        canClickOutbound: () => false,
      });
      const tool = makeClickTool(session);
      // biome-ignore lint/suspicious/noExplicitAny: envelope type assertion
      const result = (await tool.execute({ ref: "@e1" }, CTX)) as any;

      assert.strictEqual(result.ok, false, "Chinese outbound label + deny must return ok:false (OQ-3)");
      assert.strictEqual(result.error?.kind, "invalid_input", "error.kind must be 'invalid_input'");
      assert.strictEqual(fakeHandle.Input.callCount, 0, "CDP must NOT fire for Chinese outbound label");
    },
  );

  // ─── T-Guard.10 ─────────────────────────────────────────────────────────────
  it(
    "T-Guard.10: ref-first precedence — input label='Read more' does NOT bypass guard when ref target AX name='Connect'",
    { timeout: 5000 },
    async () => {
      // Given: entries:[{ref:"@e1", role:"button", name:"Connect"}], surface:"network",
      //   canClickOutbound = () => false
      // When:  clickTool.execute({ref:"@e1", label:"Read more"})
      //   (caller-supplied label is benign; ref-target AX name is outbound)
      // Then:  returns failure envelope; message contains "Connect" (the AX name),
      //        NOT "Read more"; Input.dispatchMouseEvent spy NEVER invoked
      //   BLOCKER-1 fix: guard reads resolved AX name from ref, not caller label
      //   Covers G-P63.11 (ref-wins precedence parity)
      const { session, fakeHandle } = makeFakeSession({
        surface: "network",
        entries: [CONNECT_ENTRY],
        canClickOutbound: () => false,
      });
      const tool = makeClickTool(session);
      // biome-ignore lint/suspicious/noExplicitAny: envelope type assertion
      const result = (await tool.execute({ ref: "@e1", label: "Read more" }, CTX)) as any;

      assert.strictEqual(
        result.ok,
        false,
        "ref-target AX name 'Connect' must be guarded even when caller label='Read more'",
      );
      assert.strictEqual(result.error?.kind, "invalid_input", "error.kind must be 'invalid_input'");
      // The failure message must cite the AX name ("Connect"), NOT the caller-supplied label
      assert.ok(
        result.error?.message?.includes("Connect"),
        `failure message must contain "Connect" (AX name) — got: ${result.error?.message}`,
      );
      assert.ok(
        !result.error?.message?.toLowerCase().includes("read more"),
        `failure message must NOT cite "Read more" (caller-supplied label should be ignored)`,
      );
      assert.strictEqual(fakeHandle.Input.callCount, 0, "CDP must NOT fire when ref-target is outbound");
    },
  );

  // ─── T-Guard.11 ─────────────────────────────────────────────────────────────
  it(
    "T-Guard.11: label-path — no-ref click on 'Connect' entry is blocked; failure message cites AX entry name",
    { timeout: 5000 },
    async () => {
      // Given: entries:[{ref:"@e1", role:"button", name:"Connect"}], surface:"network",
      //   canClickOutbound = () => false
      // When:  clickTool.execute({label:"Connect"}) (no ref — label-path resolution)
      // Then:  blocked; failure message contains "Connect" resolved from the ENTRY
      //   (BLOCKER-1 coverage of label-path code branch)
      //   Covers G-P63.11 (label-path branch)
      const { session, fakeHandle } = makeFakeSession({
        surface: "network",
        entries: [CONNECT_ENTRY],
        canClickOutbound: () => false,
      });
      const tool = makeClickTool(session);
      // biome-ignore lint/suspicious/noExplicitAny: envelope type assertion
      const result = (await tool.execute({ label: "Connect" }, CTX)) as any;

      assert.strictEqual(result.ok, false, "label-path 'Connect' + deny must return ok:false");
      assert.strictEqual(result.error?.kind, "invalid_input", "error.kind must be 'invalid_input'");
      assert.ok(
        result.error?.message?.includes("Connect"),
        `failure message must contain "Connect" — got: ${result.error?.message}`,
      );
      assert.strictEqual(fakeHandle.Input.callCount, 0, "CDP must NOT fire for label-path blocked click");
    },
  );
});
