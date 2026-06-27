/**
 * P-3 mock tests — T-M62..T-M64: click tool.
 *
 * Tests makeClickTool() schema, ref-based dispatch, and label-based dispatch.
 * NOTE: execute() calls applyPacing(). P-Y5 D-RUN-2 raises the default band to
 * 800-2500ms, so this suite disables pacing via MAI_PACE_MIN_MS=0 (resolvePaceBand
 * → disabled → no sleep; data.pacing is still {waitedMs:0,...} so presence checks hold).
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import type { CurrentSurfaceContext, SnapshotEntry } from "../../../src/linkedin/types.js";
import { makeClickTool } from "../../../src/tools/browser/click.js";
import { resolveByLabelWithRetry } from "../../../src/linkedin/labelResolver.js";

// P-Y5 D-RUN-2: keep the mock suite fast — disable inter-tool pacing for this file.
process.env.FRONDOSE_PACE_MIN_MS = "0";

const abortSignal = new AbortController().signal;

const FAKE_BORDER = [10, 20, 30, 20, 30, 40, 10, 40]; // center: x=20, y=30

function makeFakeSession(opts: { withLastCtx?: boolean } = {}) {
  const fakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: [
          {
            nodeId: "ax1",
            role: { type: "role", value: "button" },
            name: { type: "string", value: "Start a post" },
            backendDOMNodeId: 99,
          },
          {
            nodeId: "ax2",
            role: { type: "role", value: "link" },
            name: { type: "string", value: "Home" },
            backendDOMNodeId: 100,
          },
        ],
      }),
    },
    DOM: {
      getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (_args: unknown) => ({ nodeIds: [] }),
      scrollIntoViewIfNeeded: async (_arg: unknown) => {},
      getBoxModel: async (_args: unknown) => ({ model: { border: FAKE_BORDER } }),
    },
    Input: {
      dispatchMouseEvent: async (_args: unknown) => {},
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);

  const lastCtx: CurrentSurfaceContext | undefined = opts.withLastCtx
    ? {
        pageUrl: "https://www.linkedin.com/feed/",
        surface: "feed",
        activeLayer: "page",
        entries: [
          { ref: "@e1", role: "button", name: "Start a post" },
          { ref: "@e2", role: "link", name: "Home" },
        ],
      }
    : undefined;

  return {
    inputMode: "cdp" as const,
    getOrInitClient: () => Promise.resolve({ ok: true as const, client }),
    getClient: () => client,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => lastCtx,
  };
}

// ─── T-M62 ─────────────────────────────────────────────────────────────────────

test("T-M62: makeClickTool has description and requires ref OR label schema", () => {
  const session = makeFakeSession();
  const tool = makeClickTool(session);

  assert.ok(typeof tool.description === "string", "tool must have a description");
  assert.ok(tool.description.toLowerCase().includes("click"), "description must mention click");

  // Both ref and label present → valid
  const withRef = tool.parameters.safeParse({ ref: "@e1" });
  assert.equal(withRef.success, true, "ref alone is valid");

  const withLabel = tool.parameters.safeParse({ label: "Submit" });
  assert.equal(withLabel.success, true, "label alone is valid");

  // Neither ref nor label → invalid (refine rejects)
  const neither = tool.parameters.safeParse({});
  assert.equal(neither.success, false, "neither ref nor label must fail schema validation");
});

// ─── T-M63 ─────────────────────────────────────────────────────────────────────

test(
  "T-M63: click tool execute via ref=@e1 returns withHint(ok) envelope (state-changing)",
  { timeout: 5000 },
  async () => {
    const session = makeFakeSession({ withLastCtx: true });
    // Populate refMap so @e1 is resolvable
    await session.getClient().snapshot();

    const tool = makeClickTool(session);

    const result = await tool.execute({ ref: "@e1" }, { toolCallId: "t1", messages: [], abortSignal });

    assert.equal(result.ok, true, "result.ok must be true");
    assert.equal(result.command, "click");

    // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
    const data = (result as any).data;
    assert.ok(typeof data.target === "string", "data.target must be a string");
    assert.ok(data.target.startsWith("@"), "data.target must start with @");

    // click is state-changing — must include hint
    assert.ok(
      typeof data.hint === "string" && data.hint.length > 0,
      "data.hint must be present (click is state-changing)",
    );
  },
);

// ─── T-M64 ─────────────────────────────────────────────────────────────────────

test(
  "T-M64: click tool execute via label resolves from session.getLastContext(); fails without prior inspect",
  { timeout: 10000 },
  async () => {
    const session = makeFakeSession({ withLastCtx: true });
    await session.getClient().snapshot(); // populate refMap

    const tool = makeClickTool(session);

    const result = await tool.execute({ label: "Start a post" }, { toolCallId: "t2", messages: [], abortSignal });

    assert.equal(result.ok, true, "label-resolved click must succeed");

    // When no ctx is available, click fails
    const sessionNoCtx = makeFakeSession({ withLastCtx: false });
    const toolNoCtx = makeClickTool(sessionNoCtx);

    const result2 = await toolNoCtx.execute({ label: "nonexistent" }, { toolCallId: "t3", messages: [], abortSignal });
    assert.equal(result2.ok, false, "label click without prior inspect must fail");
  },
);

// ─── T-D11.R3-Click: label-resolve retry-poll ──────────────────────────────────
// [P-75 D-11 round 3] resolveByLabelWithRetry — when click(label=…) misses in current ctx,
// recapture surface up to ~3s before failing. Restores mai-linkedin's per-command
// re-resolution property so AX-tree lag (Chrome debounces 500-1500ms after DOM mutations,
// esp. disabled→enabled state changes LinkedIn does in React after type) doesn't force
// the agent into linkedin_connect-style specialized primitives. ref-based clicks bypass.

describe("T-D11.R3-Click: resolveByLabelWithRetry (round-3)", () => {
  // resolveByLabelWithRetry is unit-tested directly with a stubbed capture function
  // so the test exercises the retry/deadline logic in isolation from the full CDP stack.
  const lead: SnapshotEntry = { ref: "@e2", role: "button", name: "Send invitation" };
  const onlyConnect: SnapshotEntry[] = [{ ref: "@e1", role: "button", name: "Connect" }];
  const withSend: SnapshotEntry[] = [...onlyConnect, lead];

  // Given: initial ctx has only [Connect] but the capture function returns [Connect, Send] starting
  //        on its 2nd call (simulates LinkedIn React enabling Send after type debounce).
  // When:  resolveByLabelWithRetry asks for "Send invitation"
  // Then:  succeeds on the 2nd capture, well under the 3s deadline; captured at least twice.
  it("RETRIES capture when label not in initial ctx, succeeds when it appears", async () => {
    let captureCount = 0;
    const capture = async () => {
      captureCount++;
      return { entries: captureCount >= 2 ? withSend : onlyConnect };
    };
    const fakeSession = { getLastContext: () => ({ entries: onlyConnect }) };
    const t0 = Date.now();
    const found = await resolveByLabelWithRetry(fakeSession, "Send invitation", undefined, capture, {
      timeoutMs: 3000,
      stepMs: 80,
    });
    const elapsed = Date.now() - t0;
    assert.equal(found.ref, "@e2", "must resolve to the Send-invitation entry");
    assert.equal(found.name, "Send invitation");
    assert.ok(captureCount >= 2, `must have re-captured at least once; got ${captureCount}`);
    assert.ok(elapsed < 1500, `should resolve quickly when entry appears mid-retry; took ${elapsed}ms`);
  });

  // Given: capture function NEVER returns the requested label
  // When:  resolveByLabelWithRetry asks for "Send invitation"
  // Then:  loops until the deadline, then throws a "no click target matches" error;
  //        elapsed time approximately equals timeoutMs (proves the deadline gate works).
  it("FAILS after timeoutMs when label never appears", async () => {
    const capture = async () => ({ entries: onlyConnect });
    const fakeSession = { getLastContext: () => ({ entries: onlyConnect }) };
    const t0 = Date.now();
    await assert.rejects(
      () =>
        resolveByLabelWithRetry(fakeSession, "Send invitation", undefined, capture, {
          timeoutMs: 500,
          stepMs: 80,
        }),
      /no click target matches/i,
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 400, `must wait near the full deadline; only waited ${elapsed}ms`);
    assert.ok(elapsed < 900, `should not significantly exceed deadline; took ${elapsed}ms`);
  });

  // Given: capture throws on EVERY call (transient CDP failure)
  // When:  resolveByLabelWithRetry asks for any label
  // Then:  retries through the deadline (capture failures are treated as transient, not fatal),
  //        then throws the final captured error rather than crashing on the first capture-throw.
  //        Defensive design — a single AX hiccup mid-deadline shouldn't kill a valid click.
  it("treats capture-throws as transient, retries until deadline, then throws", async () => {
    let captureCount = 0;
    const capture = async (): Promise<{ entries: SnapshotEntry[] }> => {
      captureCount++;
      throw new Error("transient CDP hiccup");
    };
    const fakeSession = { getLastContext: () => ({ entries: onlyConnect }) };
    await assert.rejects(
      () =>
        resolveByLabelWithRetry(fakeSession, "Send invitation", undefined, capture, {
          timeoutMs: 400,
          stepMs: 80,
        }),
      /no label.*visible|no click target matches|transient/i,
    );
    assert.ok(captureCount >= 2, `must have retried capture at least once; got ${captureCount}`);
  });

  // Given: initial ctx ALREADY contains the requested label
  // When:  resolveByLabelWithRetry asks for that label
  // Then:  resolves immediately from ctx0 — capture is NEVER called (fast path holds).
  it("resolves immediately from initial ctx when label is already visible (no retry)", async () => {
    let captureCount = 0;
    const capture = async () => {
      captureCount++;
      return { entries: withSend };
    };
    const fakeSession = { getLastContext: () => ({ entries: withSend }) };
    const found = await resolveByLabelWithRetry(fakeSession, "Send invitation", undefined, capture);
    assert.equal(found.ref, "@e2");
    assert.equal(captureCount, 0, "capture must not be called when initial ctx already has the label");
  });
});
