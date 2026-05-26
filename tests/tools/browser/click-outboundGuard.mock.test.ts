/**
 * P-63 scaffold — T-Guard.1..11
 * click.ts outbound-send safety guard integration tests (mock session + fake CDP).
 *
 * Step 4a: assertion bodies are TODO stubs — ALL FAIL pre-builder.
 * Step 5:  builder adds guard block to click.ts + outboundGuard.ts → assertions filled.
 *
 * Uses an enhanced makeFakeSession() that:
 *  - Accepts per-test surface/entries for getLastContext()
 *  - Supports optional canClickOutbound injection
 *  - Has a spy counter on Input.dispatchMouseEvent
 *
 * MAI_PACE_MIN_MS=0 to disable inter-tool pacing (keeps suite fast).
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

// Disable inter-tool pacing for the mock suite (same as click.mock.test.ts).
process.env.MAI_PACE_MIN_MS = "0";

const abortSignal = new AbortController().signal;

/** Minimal box-model border for a 20×10 button at (10,20). */
const FAKE_BORDER = [10, 20, 30, 20, 30, 30, 10, 30];

/** Tool-call context required by Vercel AI SDK execute(). */
const CTX = { toolCallId: "t-guard", messages: [] as never[], abortSignal };

interface FakeSessionOpts {
  /** Surface context to return from getLastContext(). undefined → no context. */
  surface?: CurrentSurfaceContext["surface"];
  /** AX entries to include. At minimum one entry with ref + name for the target button. */
  entries?: CurrentSurfaceContext["entries"];
  /** URL placed in pageUrl; defaults to a LinkedIn URL for the given surface. */
  pageUrl?: string;
  /** If provided, injected as session.canClickOutbound. Omit for REPL/no-hook mode. */
  canClickOutbound?: (label: string, surface: string) => boolean;
}

interface FakeHandle {
  Accessibility: {
    enable: () => Promise<void>;
    getFullAXTree: () => Promise<{ nodes: unknown[] }>;
  };
  DOM: {
    getDocument: (_args: unknown) => Promise<{ root: { nodeId: number } }>;
    querySelectorAll: (_args: unknown) => Promise<{ nodeIds: number[] }>;
    getBoxModel: (_args: unknown) => Promise<{ model: { border: number[] } }>;
  };
  Input: {
    dispatchMouseEvent: (_args: unknown) => Promise<void>;
    /** Spy counter — incremented every time dispatchMouseEvent is called. */
    callCount: number;
  };
}

function makeFakeSession(opts: FakeSessionOpts = {}) {
  const { surface = "network", entries = [], pageUrl, canClickOutbound } = opts;

  // Build AX tree nodes from the supplied entries.
  const nodes = entries.map((e, idx) => ({
    nodeId: `ax${idx + 1}`,
    role: { type: "role", value: e.role },
    name: { type: "string", value: e.name },
    backendDOMNodeId: 100 + idx,
  }));

  const fakeHandle: FakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({ nodes }),
    },
    DOM: {
      getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (_args: unknown) => ({ nodeIds: [] }),
      getBoxModel: async (_args: unknown) => ({ model: { border: FAKE_BORDER } }),
    },
    Input: {
      dispatchMouseEvent: async (_args: unknown) => {},
      callCount: 0,
    },
  };

  // Wrap dispatchMouseEvent with a spy.
  const originalDispatch = fakeHandle.Input.dispatchMouseEvent;
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
    // canClickOutbound is optional — only injected when provided.
    ...(canClickOutbound !== undefined ? { canClickOutbound } : {}),
  };

  return { session, fakeHandle };
}

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
      assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
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
      assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
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
      assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
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
      //        covers false-positive non-LinkedIn risk + P-33 general-web capability
      assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
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
      assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
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
      //        (covers regex anti-false-positive gate G-P63.8)
      assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
    },
  );

  // ─── T-Guard.7 ──────────────────────────────────────────────────────────────
  it(
    "T-Guard.7: when 'Follow' on profile surface + deny hook, click is blocked",
    { timeout: 5000 },
    async () => {
      // Given: name:"Follow", surface:"profile", canClickOutbound = () => false
      // When:  clickTool.execute({ref:"@e1"})
      // Then:  {ok:false, error:{kind:"invalid_input"}}
      //        (OQ-1: Follow on profile is a social outbound signal → guarded)
      assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
    },
  );

  // ─── T-Guard.8 ──────────────────────────────────────────────────────────────
  it(
    "T-Guard.8: when 'Follow' on company surface + deny hook, guard does NOT fire → ok:true",
    { timeout: 5000 },
    async () => {
      // Given: name:"Follow", surface:"company", canClickOutbound = () => false
      // When:  clickTool.execute({ref:"@e1"})
      // Then:  envelope ok:true — company Follow is benign content interest (OQ-1 carve-out)
      assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
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
      assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
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
      //   (BLOCKER-1 fix: guard reads resolved AX name from ref, not caller label)
      assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
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
      //        (proves the label-path code branch uses the same ref-lookup-after-resolve
      //         approach as the ref-path — BLOCKER-1 coverage of both code paths)
      assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
    },
  );
});
