/**
 * P-AUTO-L3FIX-2 — T1 mock tests: click ref-staleness retry + abort threading.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/tools/browser/click-refStale-pAutoL3fix2.mock.test.ts
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { before, beforeEach, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { CurrentSurfaceContext, LinkedinSession, SnapshotEntry } from "../../../src/linkedin/types.js";

type ClickTool = {
  execute: (
    args: { ref?: string; label?: string; scope?: string },
    opts: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal },
  ) => Promise<{ ok: boolean; data?: { target?: string }; error?: { message?: string; kind?: string } }>;
};
type MakeClickTool = (session: LinkedinSession) => ClickTool;

process.env.FRONDOSE_PACE_MIN_MS = "0";
process.env.FRONDOSE_PACE_MAX_MS = "0";

let makeClickTool: MakeClickTool | null = null;
let nextCapture: CurrentSurfaceContext | null = null;

before(async () => {
  const linkedinIndexUrl = pathToFileURL(resolve(process.cwd(), "src/linkedin/index.js")).href;
  const realLinkedinIndex = await import(linkedinIndexUrl);
  mock.module(linkedinIndexUrl, {
    namedExports: {
      ...realLinkedinIndex,
      captureCurrentSurfaceContext: async () => {
        if (nextCapture === null) throw new Error("captureCurrentSurfaceContext mock: nextCapture not set");
        return nextCapture;
      },
    },
  });

  const clickMod = await import("../../../src/tools/browser/click.js");
  makeClickTool = clickMod.makeClickTool as MakeClickTool;
});

beforeEach(() => {
  nextCapture = null;
});

function makeContext(entries: SnapshotEntry[]): CurrentSurfaceContext {
  return {
    pageUrl: "https://www.linkedin.com/in/test/",
    surface: "profile",
    activeLayer: "page",
    entries,
  };
}

function makeSession(opts: {
  initialEntries: SnapshotEntry[];
  verifyResults: Array<{ matches: boolean; currentRole?: string; currentName?: string }>;
  clickCalls: string[];
}): LinkedinSession {
  let context = makeContext(opts.initialEntries);
  const client = {
    currentRefMap: {
      e1: { backendNodeId: 1, role: "button", name: "More" },
      e2: { backendNodeId: 2, role: "button", name: "More" },
    },
    getBox: async () => ({ x: 0, y: 0, w: 10, h: 10 }),
    verifyRef: async () => opts.verifyResults.shift() ?? { matches: true },
    clickAt: async (target: string) => {
      opts.clickCalls.push(target);
    },
  };

  return {
    inputMode: "cdp",
    getOrInitClient: async () => ({ ok: true as const, client }),
    getClient: () => client,
    getLastContext: () => context,
    setLastContext: (next: CurrentSurfaceContext) => {
      context = next;
    },
  } as unknown as LinkedinSession;
}

describe("T1 — click ref-staleness retry", () => {
  it("T1.a: when a stale ref re-resolves by role/name after recapture, click retries on the fresh ref", async () => {
    // Given: @e1 verifies stale, then recapture exposes a single fresh button named More at @e2.
    // When: click executes against ref @e1.
    // Then: verify retries against @e2 and clickAt dispatches @e2 successfully.
    assert.ok(makeClickTool !== null, "makeClickTool must be imported");
    const clickCalls: string[] = [];
    const initial = [{ ref: "@e1", role: "button", name: "More" }] satisfies SnapshotEntry[];
    nextCapture = makeContext([{ ref: "@e2", role: "button", name: "More" }]);
    const session = makeSession({
      initialEntries: initial,
      verifyResults: [
        { matches: false, currentRole: "button", currentName: "Share" },
        { matches: true, currentRole: "button", currentName: "More" },
      ],
      clickCalls,
    });

    const result = await makeClickTool(session).execute({ ref: "@e1" }, { toolCallId: "t1", messages: [] });

    assert.equal(result.ok, true);
    assert.equal(result.data?.target, "@e2");
    assert.deepEqual(clickCalls, ["@e2"]);
  });

  it("T1.b: when a ref remains stale after bounded retries, click returns the existing ref_stale failure", async () => {
    // Given: every verifyRef call reports stale, even after recapture.
    // When: click executes against the stale ref.
    // Then: clickAt is never called and the failure message contains ref_stale.
    assert.ok(makeClickTool !== null, "makeClickTool must be imported");
    const clickCalls: string[] = [];
    const initial = [{ ref: "@e1", role: "button", name: "More" }] satisfies SnapshotEntry[];
    nextCapture = makeContext([{ ref: "@e2", role: "button", name: "More" }]);
    const session = makeSession({
      initialEntries: initial,
      verifyResults: [
        { matches: false, currentRole: "button", currentName: "Share" },
        { matches: false, currentRole: "button", currentName: "Share" },
        { matches: false, currentRole: "button", currentName: "Share" },
      ],
      clickCalls,
    });

    const result = await makeClickTool(session).execute({ ref: "@e1" }, { toolCallId: "t2", messages: [] });

    assert.equal(result.ok, false);
    assert.match(result.error?.message ?? "", /ref_stale/);
    assert.deepEqual(clickCalls, []);
  });

  it("T1.c: when the tool abort signal fires mid ref-retry sleep, click exits without dispatching", async () => {
    // Given: @e1 verifies stale and the execute abortSignal fires before the recapture sleep completes.
    // When: click enters the ref retry loop.
    // Then: it returns promptly with an AbortError-shaped failure and does not click.
    assert.ok(makeClickTool !== null, "makeClickTool must be imported");
    const clickCalls: string[] = [];
    const ac = new AbortController();
    const initial = [{ ref: "@e1", role: "button", name: "More" }] satisfies SnapshotEntry[];
    nextCapture = makeContext([{ ref: "@e2", role: "button", name: "More" }]);
    const session = makeSession({
      initialEntries: initial,
      verifyResults: [{ matches: false, currentRole: "button", currentName: "Share" }],
      clickCalls,
    });

    const pending = makeClickTool(session).execute(
      { ref: "@e1" },
      { toolCallId: "t3", messages: [], abortSignal: ac.signal },
    );
    setTimeout(() => ac.abort(), 20);
    const result = await pending;

    assert.equal(result.ok, false);
    assert.match(result.error?.message ?? "", /aborted/i);
    assert.deepEqual(clickCalls, []);
  });
});
