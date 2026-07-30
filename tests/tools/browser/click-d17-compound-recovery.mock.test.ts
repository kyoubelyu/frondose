/**
 * P-FIX-D17-COMPOUND-RECOVERY — D-17 identity-lineage and fail-closed carriers.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/tools/browser/click-d17-compound-recovery.mock.test.ts
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { before, beforeEach, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { CurrentSurfaceContext, LinkedinSession, SnapshotEntry } from "../../../src/linkedin/types.js";

type VerifyResult = { matches: boolean; currentRole?: string; currentName?: string };
type VerifyCall = { ref: string; expected: { role: string; name?: string } };
type ClickResult = { ok: boolean; data?: { target?: string }; error?: { message?: string; kind?: string } };
type ClickTool = {
  execute: (
    args: { ref?: string; label?: string; scope?: string },
    opts: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal },
  ) => Promise<ClickResult>;
};
type MakeClickTool = (session: LinkedinSession) => ClickTool;

process.env.FRONDOSE_PACE_MIN_MS = "0";
process.env.FRONDOSE_PACE_MAX_MS = "0";

const NEW_MESSAGE_URL = "https://www.linkedin.com/messaging/thread/new/";
const OLD_NAME = "Joyce HE • 1st 普通职业";
const PHOTO_NAME = `Photo of Joyce HE ${OLD_NAME}`;

let makeClickTool: MakeClickTool | null = null;
let captureQueue: CurrentSurfaceContext[] = [];

before(async () => {
  const linkedinIndexUrl = pathToFileURL(resolve(process.cwd(), "src/linkedin/index.js")).href;
  const realLinkedinIndex = await import(linkedinIndexUrl);
  mock.module(linkedinIndexUrl, {
    namedExports: {
      ...realLinkedinIndex,
      captureCurrentSurfaceContext: async () => {
        const next = captureQueue.shift();
        if (!next) throw new Error("captureCurrentSurfaceContext mock: captureQueue empty");
        return next;
      },
    },
  });
  const clickMod = await import("../../../src/tools/browser/click.js");
  makeClickTool = clickMod.makeClickTool as MakeClickTool;
});

beforeEach(() => {
  delete process.env.FRONDOSE_SCOPED_RESOLVE;
  captureQueue = [];
});

function context(
  entries: SnapshotEntry[],
  opts: {
    surface?: string;
    activeLayer?: "page" | "overlay";
    pageUrl?: string;
  } = {},
): CurrentSurfaceContext {
  return {
    pageUrl: opts.pageUrl ?? NEW_MESSAGE_URL,
    surface: opts.surface ?? "messaging-thread",
    activeLayer: opts.activeLayer ?? "overlay",
    entries,
  };
}

function harness(opts: {
  initialContext: CurrentSurfaceContext;
  verifyResults: VerifyResult[];
  clickCalls?: string[];
  boxCalls?: string[];
  verifyCalls?: VerifyCall[];
}) {
  let currentContext = opts.initialContext;
  const clickCalls = opts.clickCalls ?? [];
  const boxCalls = opts.boxCalls ?? [];
  const verifyCalls = opts.verifyCalls ?? [];
  const client = {
    currentRefMap: { ov1: { backendNodeId: 1, role: "menuitem", name: OLD_NAME } },
    verifyRef: async (ref: string, expected: { role: string; name?: string }) => {
      verifyCalls.push({ ref, expected: { ...expected } });
      return opts.verifyResults.shift() ?? { matches: true };
    },
    getBox: async (target: string) => {
      boxCalls.push(target);
      return { x: 0, y: 0, w: 10, h: 10 };
    },
    clickAt: async (target: string) => {
      clickCalls.push(target);
    },
    evaluate: async () => false,
  };
  const session = {
    inputMode: "cdp",
    resolvedMode: () => "manual" as const,
    getOrInitClient: async () => ({ ok: true as const, client }),
    getClient: () => client,
    getLastContext: () => currentContext,
    setLastContext: (next: CurrentSurfaceContext) => {
      currentContext = next;
    },
  } as unknown as LinkedinSession;
  return { session, clickCalls, boxCalls, verifyCalls, getContext: () => currentContext };
}

async function executeRef(h: ReturnType<typeof harness>, ref = "@ov1"): Promise<ClickResult> {
  assert.ok(makeClickTool);
  return makeClickTool(h.session).execute({ ref }, { toolCallId: `d17-${ref}`, messages: [] });
}

describe("D-17 picker candidate identity survives only the evidenced re-render lineage", () => {
  // Given two successive valid picker recaptures, when each verification is stale, then expected identity advances old → fresh-1 → fresh-2 before dispatch.
  it("T-D17C.3: every successful retarget refreshes the next verification identity", async () => {
    captureQueue = [
      context([{ ref: "@ov2", role: "option", name: PHOTO_NAME }]),
      context([{ ref: "@ov3", role: "option", name: PHOTO_NAME }]),
    ];
    const h = harness({
      initialContext: context([{ ref: "@ov1", role: "menuitem", name: OLD_NAME }]),
      verifyResults: [{ matches: false }, { matches: false }, { matches: true }],
    });

    const result = await executeRef(h);

    assert.equal(result.ok, true);
    assert.equal(result.data?.target, "@ov3");
    assert.deepEqual(
      h.verifyCalls.map((call) => [call.ref, call.expected.role, call.expected.name]),
      [
        ["ov1", "menuitem", OLD_NAME],
        ["ov2", "option", PHOTO_NAME],
        ["ov3", "option", PHOTO_NAME],
      ],
    );
    assert.deepEqual(h.boxCalls, ["@ov3"]);
    assert.deepEqual(h.clickCalls, ["@ov3"]);
  });

  // Given the overlay snapshot still reports the obsolete menuitem while verifyRef sees the same @ov ref's safe photo-envelope option, when recapture runs, then the verified identity replaces the stale snapshot identity before dispatch.
  it("T-D17C.3a: same-ref verified picker transition supersedes a stale synthesized snapshot", async () => {
    const stale = context([{ ref: "@ov1", role: "menuitem", name: OLD_NAME }]);
    captureQueue = [stale];
    const h = harness({
      initialContext: stale,
      verifyResults: [{ matches: false, currentRole: "option", currentName: PHOTO_NAME }, { matches: true }],
    });

    const result = await executeRef(h);

    assert.equal(result.ok, true);
    assert.deepEqual(
      h.verifyCalls.map((call) => [call.ref, call.expected.role, call.expected.name]),
      [
        ["ov1", "menuitem", OLD_NAME],
        ["ov1", "option", PHOTO_NAME],
      ],
    );
    assert.deepEqual(h.getContext().entries, [{ ref: "@ov1", role: "option", name: PHOTO_NAME }]);
    assert.deepEqual(h.boxCalls, ["@ov1"]);
    assert.deepEqual(h.clickCalls, ["@ov1"]);
  });

  // Given verifyRef reports a same-ref transition outside the exact safe envelope, when the synthesized snapshot is still stale, then direct identity replacement surrenders without dispatch.
  it("T-D17C.3b: same-ref verified transition remains exact and unique or surrenders", async () => {
    const scenarios: Array<{
      name: string;
      freshEntries: SnapshotEntry[];
      currentRole: string;
      currentName: string;
    }> = [
      {
        name: "wrong photo subject",
        freshEntries: [{ ref: "@ov1", role: "menuitem", name: OLD_NAME }],
        currentRole: "option",
        currentName: `Photo of Alice Example ${OLD_NAME}`,
      },
      {
        name: "wrong role transition",
        freshEntries: [{ ref: "@ov1", role: "menuitem", name: OLD_NAME }],
        currentRole: "menuitem",
        currentName: OLD_NAME,
      },
      {
        name: "region drift",
        freshEntries: [{ ref: "@ov1", role: "menuitem", name: OLD_NAME, region: "aside" }],
        currentRole: "option",
        currentName: PHOTO_NAME,
      },
      {
        name: "duplicate same ref",
        freshEntries: [
          { ref: "@ov1", role: "menuitem", name: OLD_NAME },
          { ref: "@ov1", role: "menuitem", name: OLD_NAME },
        ],
        currentRole: "option",
        currentName: PHOTO_NAME,
      },
    ];

    for (const scenario of scenarios) {
      const initial = context([{ ref: "@ov1", role: "menuitem", name: OLD_NAME }]);
      const fresh = context(scenario.freshEntries);
      captureQueue = [fresh, fresh];
      const h = harness({
        initialContext: initial,
        verifyResults: [
          {
            matches: false,
            currentRole: scenario.currentRole,
            currentName: scenario.currentName,
          },
        ],
      });

      const result = await executeRef(h);

      assert.equal(result.ok, false, scenario.name);
      assert.match(result.error?.message ?? "", /ref_stale/, scenario.name);
      assert.deepEqual(h.boxCalls, [], scenario.name);
      assert.deepEqual(h.clickCalls, [], scenario.name);
    }
  });

  // Given picker lineage begins valid, when a first or later fresh capture leaves the exact picker context, then it cannot replace context or dispatch.
  it("T-D17C.4: every fresh capture preserves exact new-message picker context", async () => {
    const initial = context([{ ref: "@ov1", role: "menuitem", name: OLD_NAME }]);
    const invalid = context([{ ref: "@ov2", role: "option", name: PHOTO_NAME }], {
      surface: "profile",
      pageUrl: "https://www.linkedin.com/in/joyce-he/",
    });
    captureQueue = [invalid, invalid];
    const firstDrift = harness({ initialContext: initial, verifyResults: [{ matches: false }] });

    const firstResult = await executeRef(firstDrift);

    assert.equal(firstResult.ok, false);
    assert.match(firstResult.error?.message ?? "", /ref_stale/);
    assert.equal(firstDrift.getContext(), initial);
    assert.deepEqual(firstDrift.clickCalls, []);

    const fresh1 = context([{ ref: "@ov2", role: "option", name: PHOTO_NAME }]);
    captureQueue = [fresh1, invalid, invalid];
    const laterDrift = harness({
      initialContext: initial,
      verifyResults: [{ matches: false }, { matches: false }],
    });

    const laterResult = await executeRef(laterDrift);

    assert.equal(laterResult.ok, false);
    assert.equal(laterDrift.verifyCalls.length, 2);
    assert.equal(laterDrift.verifyCalls[1]?.ref, "ov2");
    assert.equal(laterDrift.getContext(), fresh1);
    assert.deepEqual(laterDrift.clickCalls, []);
  });

  // Given an ordinary button starts inside the new-message overlay, when exact-name recapture changes surface, then legacy guarded retarget still dispatches.
  it("T-D17C.4b: context alone does not mark an ordinary overlay button as picker lineage", async () => {
    captureQueue = [
      context([{ ref: "@ov2", role: "button", name: "Cancel" }], {
        surface: "profile",
        pageUrl: "https://www.linkedin.com/in/joyce-he/",
      }),
    ];
    const h = harness({
      initialContext: context([{ ref: "@ov1", role: "button", name: "Cancel" }]),
      verifyResults: [{ matches: false }, { matches: true }],
    });

    const result = await executeRef(h);

    assert.equal(result.ok, true);
    assert.deepEqual(h.clickCalls, ["@ov2"]);
  });

  // Given the photo-envelope grammar is satisfied but the obsolete identity is outbound, when recapture runs, then both-identity benign gating prevents dispatch.
  it("T-D17C.5: obsolete outbound identity cannot hide behind a benign photo wrapper", async () => {
    const outboundOld = "Invite Alice to connect • 1st";
    const wrappedFresh = `Photo of Invite Alice to connect ${outboundOld}`;
    const fresh = context([{ ref: "@ov2", role: "option", name: wrappedFresh }]);
    captureQueue = [fresh, fresh];
    const h = harness({
      initialContext: context([{ ref: "@ov1", role: "menuitem", name: outboundOld }]),
      verifyResults: [{ matches: false }],
    });

    const result = await executeRef(h);

    assert.equal(result.ok, false);
    assert.match(result.error?.message ?? "", /ref_stale/);
    assert.deepEqual(h.boxCalls, []);
    assert.deepEqual(h.clickCalls, []);
  });
});

describe("D-17 widened carrier fails closed outside the exact evidence", () => {
  // Given branch-adjacent wrong-subject, separator, role, scope, region, ref, and ambiguity variants, when recapture runs, then every case surrenders without dispatch.
  it("T-D17C.6-.9: negative matrix remains unique-or-surrender", async () => {
    const validOld: SnapshotEntry = { ref: "@ov1", role: "menuitem", name: OLD_NAME };
    const validFresh: SnapshotEntry = { ref: "@ov2", role: "option", name: PHOTO_NAME };
    const scenarios: Array<{
      name: string;
      initial: CurrentSurfaceContext;
      fresh: CurrentSurfaceContext;
    }> = [
      {
        name: "wrong photo subject",
        initial: context([validOld]),
        fresh: context([{ ...validFresh, name: `Photo of Alice Example ${OLD_NAME}` }]),
      },
      {
        name: "subject suffix collision",
        initial: context([validOld]),
        fresh: context([{ ...validFresh, name: `Photo of Joyce HE Senior ${OLD_NAME}` }]),
      },
      {
        name: "U+00B7 middle dot",
        initial: context([{ ...validOld, name: "Joyce HE · 1st 普通职业" }]),
        fresh: context([{ ...validFresh, name: "Photo of Joyce HE Joyce HE · 1st 普通职业" }]),
      },
      {
        name: "same role",
        initial: context([validOld]),
        fresh: context([{ ...validFresh, role: "menuitem" }]),
      },
      {
        name: "reverse role",
        initial: context([{ ...validOld, role: "option" }]),
        fresh: context([{ ...validFresh, role: "menuitem" }]),
      },
      {
        name: "wrong initial surface",
        initial: context([validOld], { surface: "profile" }),
        fresh: context([validFresh]),
      },
      {
        name: "wrong initial path",
        initial: context([validOld], { pageUrl: "https://www.linkedin.com/messaging/" }),
        fresh: context([validFresh]),
      },
      {
        name: "wrong initial layer",
        initial: context([validOld], { activeLayer: "page" }),
        fresh: context([validFresh], { activeLayer: "page" }),
      },
      {
        name: "ordinary refs",
        initial: context([{ ...validOld, ref: "@e1" }]),
        fresh: context([{ ...validFresh, ref: "@e2" }]),
      },
      {
        name: "undefined to aside region",
        initial: context([validOld]),
        fresh: context([{ ...validFresh, region: "aside" }]),
      },
      {
        name: "aside to undefined region",
        initial: context([{ ...validOld, region: "aside" }]),
        fresh: context([validFresh]),
      },
      {
        name: "two valid fresh candidates",
        initial: context([validOld]),
        fresh: context([validFresh, { ...validFresh, ref: "@ov3" }]),
      },
    ];

    for (const scenario of scenarios) {
      captureQueue = [scenario.fresh, scenario.fresh];
      const h = harness({ initialContext: scenario.initial, verifyResults: [{ matches: false }] });
      const initialRef = scenario.initial.entries[0]?.ref ?? "@ov1";

      const result = await executeRef(h, initialRef);

      assert.equal(result.ok, false, scenario.name);
      assert.match(result.error?.message ?? "", /ref_stale/, scenario.name);
      assert.deepEqual(h.boxCalls, [], scenario.name);
      assert.deepEqual(h.clickCalls, [], scenario.name);
    }
  });
});
