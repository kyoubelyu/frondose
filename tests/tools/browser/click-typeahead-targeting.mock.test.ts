/**
 * P-FIX-TYPEAHEAD-TARGETING — T-TYPE.4–.12 click-path + T-TYPE.8 scoped-fallback mock tests.
 *
 * Click-path harness mirrors click-refStale-pAutoL3fix2 (mocked captureCurrentSurfaceContext,
 * fake session/client with verifyRef/clickAt/getBox spies). Scoped-fallback tests mock
 * resolveScopedTarget (throwing CommandAmbiguousTargetError) + the logic surface capture.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/tools/browser/click-typeahead-targeting.mock.test.ts
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { before, beforeEach, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type {
  CommandCandidate,
  CurrentSurfaceContext,
  LinkedinSession,
  SnapshotEntry,
} from "../../../src/linkedin/types.js";

type ClickResult = {
  ok: boolean;
  data?: { target?: string; resolution?: { candidates: number; picked: string; method: string } };
  error?: { message?: string; kind?: string; reason?: string };
};
type ClickTool = {
  execute: (
    args: { ref?: string; label?: string; scope?: string },
    opts: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal },
  ) => Promise<ClickResult>;
};
type MakeClickTool = (session: LinkedinSession) => ClickTool;
type TypeResult = { ok: boolean; error?: { message?: string; kind?: string } };
type TypeTool = {
  execute: (
    args: { text: string; ref?: string; label?: string; scope?: string },
    opts: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal },
  ) => Promise<TypeResult>;
};
type MakeTypeTool = (session: LinkedinSession) => TypeTool;

process.env.FRONDOSE_PACE_MIN_MS = "0";
process.env.FRONDOSE_PACE_MAX_MS = "0";

let makeClickTool: MakeClickTool | null = null;
let makeTypeTool: MakeTypeTool | null = null;
let resolveScopedForTool:
  | ((client: unknown, kind: "button" | "input", label?: string, scope?: string) => Promise<unknown>)
  | null = null;
let CommandAmbiguousTargetErrorCls: (new (message: string, candidates?: CommandCandidate[]) => Error) | null = null;
let nextCapture: CurrentSurfaceContext | null = null;
let nextLogicCapture: {
  pageUrl: string;
  surface: string;
  activeLayer: string;
  entries: SnapshotEntry[];
  visibleScopeInspections?: unknown[];
} | null = null;
let scopedThrow: Error | null = null;

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

  const targetResolutionUrl = pathToFileURL(
    resolve(process.cwd(), "src/linkedin/logic/scopeResolver/targetResolution.js"),
  ).href;
  const realTargetResolution = await import(targetResolutionUrl);
  mock.module(targetResolutionUrl, {
    namedExports: {
      ...realTargetResolution,
      resolveScopedTarget: async () => {
        if (scopedThrow) throw scopedThrow;
        throw new Error("resolveScopedTarget mock: scopedThrow not set");
      },
    },
  });

  const logicSurfaceUrl = pathToFileURL(resolve(process.cwd(), "src/linkedin/logic/surface/currentSurface.js")).href;
  const realLogicSurface = await import(logicSurfaceUrl);
  mock.module(logicSurfaceUrl, {
    namedExports: {
      ...realLogicSurface,
      captureCurrentSurfaceContext: async () => {
        if (nextLogicCapture === null) throw new Error("logic capture mock: nextLogicCapture not set");
        return nextLogicCapture;
      },
    },
  });

  const clickMod = await import("../../../src/tools/browser/click.js");
  makeClickTool = clickMod.makeClickTool as MakeClickTool;
  const typeMod = await import("../../../src/tools/browser/type.js");
  makeTypeTool = typeMod.makeTypeTool as MakeTypeTool;
  const scopedMod = await import("../../../src/tools/browser/scopedResolve.js");
  resolveScopedForTool = scopedMod.resolveScopedForTool as typeof resolveScopedForTool;
  const sharedMod = await import("../../../src/linkedin/logic/scopeResolver/shared.js");
  CommandAmbiguousTargetErrorCls = sharedMod.CommandAmbiguousTargetError as typeof CommandAmbiguousTargetErrorCls;
});

beforeEach(() => {
  delete process.env.FRONDOSE_SCOPED_RESOLVE;
  nextCapture = null;
  nextLogicCapture = null;
  scopedThrow = null;
});

function makeContext(
  entries: SnapshotEntry[],
  surface = "messaging-thread",
  activeLayer: "page" | "overlay" = "overlay",
  pageUrl = "https://www.linkedin.com/messaging/thread/new/",
): CurrentSurfaceContext {
  return {
    pageUrl,
    surface,
    activeLayer,
    entries,
  };
}

type VerifyResult = { matches: boolean; currentRole?: string; currentName?: string };

function makeSession(opts: {
  initialEntries: SnapshotEntry[];
  surface?: string;
  activeLayer?: "page" | "overlay";
  pageUrl?: string;
  verifyResults?: VerifyResult[];
  clickCalls: string[];
  inputCalls?: string[];
  boxCalls?: string[];
  resolvedMode?: () => "manual" | "auto";
}): LinkedinSession {
  let context = makeContext(
    opts.initialEntries,
    opts.surface ?? "messaging-thread",
    opts.activeLayer ?? "overlay",
    opts.pageUrl,
  );
  const client = {
    currentRefMap: { e0: { backendNodeId: 0, role: "button", name: "dummy" } },
    getBox: async (t: string) => {
      opts.boxCalls?.push(t);
      return { x: 0, y: 0, w: 10, h: 10 };
    },
    verifyRef: async () => opts.verifyResults?.shift() ?? { matches: true },
    clickAt: async (t: string) => {
      opts.clickCalls.push(t);
    },
    evaluate: async () => false,
    handle: {
      Input: {
        dispatchKeyEvent: async () => {
          opts.inputCalls?.push("key");
        },
        insertText: async ({ text }: { text: string }) => {
          opts.inputCalls?.push(`text:${text}`);
        },
      },
    },
  };
  return {
    inputMode: "cdp",
    resolvedMode: opts.resolvedMode ?? (() => "manual"),
    getOrInitClient: async () => ({ ok: true as const, client }),
    getClient: () => client,
    getLastContext: () => context,
    setLastContext: (next: CurrentSurfaceContext) => {
      context = next;
    },
  } as unknown as LinkedinSession;
}

// ─── T-TYPE.4 — tie-broken pick classifying outbound → fail closed ────────────────────────────────

describe("T-TYPE.4 — disambiguated pick on an outbound-classified entry refuses dispatch", () => {
  it("T-TYPE.4: given substr-ambiguous candidates where the roleFamily tie-break picks 'Send invitation' (connect_send), when click runs by label, then it fails closed with ambiguous_target and clickAt is NEVER called", () => {
    return (async () => {
      // Given: "Send invitation" (menuitem) + "Send invite now" (button) — startsWith tie stays at 2,
      // roleFamily narrows to the menuitem, which classifies connect_send.
      const clickCalls: string[] = [];
      const entries: SnapshotEntry[] = [
        { ref: "@ov1", role: "menuitem", name: "Send invitation" },
        { ref: "@ov2", role: "button", name: "Send invite now" },
      ];
      assert.ok(makeClickTool);
      const session = makeSession({ initialEntries: entries, clickCalls });

      const result = await makeClickTool(session).execute({ label: "Send inv" }, { toolCallId: "t4", messages: [] });

      assert.equal(result.ok, false);
      assert.equal(result.error?.kind, "ambiguous_target");
      assert.match(result.error?.message ?? "", /Refusing to dispatch a disambiguated outbound click/);
      assert.deepEqual(clickCalls, []);
    })();
  });
});

// ─── T-TYPE.5 — tie-broken non-outbound pick dispatches + envelope echoes the pick ───────────────

describe("T-TYPE.5 — disambiguated non-outbound pick dispatches to the picked ref with data.resolution", () => {
  it("T-TYPE.5: given ['Joyce HE · 1st…' (menuitem), 'Photo of Joyce HE' (menuitem)], when click runs by label 'Joyce HE', then clickAt fires on @ov1 and the envelope carries exact resolution {candidates:2, picked, method:'startsWith'}", () => {
    return (async () => {
      const clickCalls: string[] = [];
      const entries: SnapshotEntry[] = [
        { ref: "@ov1", role: "menuitem", name: "Joyce HE · 1st 普通职业" },
        { ref: "@ov7", role: "menuitem", name: "Photo of Joyce HE" },
      ];
      assert.ok(makeClickTool);
      const session = makeSession({ initialEntries: entries, clickCalls });

      const result = await makeClickTool(session).execute({ label: "Joyce HE" }, { toolCallId: "t5", messages: [] });

      assert.equal(result.ok, true);
      assert.deepEqual(clickCalls, ["@ov1"]);
      assert.deepEqual(result.data?.resolution, {
        candidates: 2,
        picked: "Joyce HE · 1st 普通职业",
        method: "startsWith",
      });
    })();
  });
});

// ─── T-TYPE.6 — ref-stale recapture tolerates menuitem→option churn ──────────────────────────────

describe("T-TYPE.6 — ref-stale recapture retargets across the evidenced menuitem↔option churn", () => {
  it("T-TYPE.6: given @ov1 (menuitem 'Joyce HE · 1st') verifies stale and the recapture exposes the same-normalized-name entry as role=option @ov2, when click runs by ref, then it retargets and dispatches @ov2 with NO ref_stale", () => {
    return (async () => {
      const clickCalls: string[] = [];
      const initial: SnapshotEntry[] = [{ ref: "@ov1", role: "menuitem", name: "Joyce HE · 1st" }];
      nextCapture = makeContext([{ ref: "@ov2", role: "option", name: "Joyce HE · 1st" }]);
      assert.ok(makeClickTool);
      const session = makeSession({
        initialEntries: initial,
        verifyResults: [{ matches: false, currentRole: "option", currentName: "Photo of Joyce HE" }, { matches: true }],
        clickCalls,
      });

      const result = await makeClickTool(session).execute({ ref: "@ov1" }, { toolCallId: "t6", messages: [] });

      assert.equal(result.ok, true);
      assert.equal(result.data?.target, "@ov2");
      assert.deepEqual(clickCalls, ["@ov2"]);
    })();
  });
});

// ─── T-TYPE.7 — recapture with multiple churn-family matches surrenders ──────────────────────────

describe("T-TYPE.7 — recapture ambiguity keeps the safe ref_stale surrender", () => {
  it("T-TYPE.7: given the recapture exposes TWO same-name churn-family entries, when click runs by ref, then clickAt is never called and the envelope is the existing ref_stale failure", () => {
    return (async () => {
      const clickCalls: string[] = [];
      const initial: SnapshotEntry[] = [{ ref: "@ov1", role: "menuitem", name: "Joyce HE · 1st" }];
      nextCapture = makeContext([
        { ref: "@ov2", role: "option", name: "Joyce HE · 1st" },
        { ref: "@ov3", role: "menuitem", name: "Joyce HE · 1st" },
      ]);
      assert.ok(makeClickTool);
      const session = makeSession({
        initialEntries: initial,
        verifyResults: [{ matches: false }, { matches: false }, { matches: false }],
        clickCalls,
      });

      const result = await makeClickTool(session).execute({ ref: "@ov1" }, { toolCallId: "t7", messages: [] });

      assert.equal(result.ok, false);
      assert.match(result.error?.message ?? "", /ref_stale/);
      assert.deepEqual(clickCalls, []);
    })();
  });
});

// ─── T-TYPE.9 — classification runs on the RETARGETED entry + final context ──────────────────────

describe("T-TYPE.9 — classify-after-retarget: guards enforce against the final entry + context", () => {
  it("T-TYPE.9a: given the recapture adds a CONNECT DIALOG around the retargeted 'Send' (message_send → connect_send reclassification), when resolvedMode is auto, then the auto MESSAGE-send block does NOT fire and the click dispatches — proving connectDialogActive was recomputed from the post-revalidation context", () => {
    return (async () => {
      // Pre-fix order classified on the pre-D-17 context (no dialog): 'Send' on a profile surface is
      // message_send → auto mode BLOCKS it. Post-fix the recaptured context carries the dialog
      // (Add a note + Pending-withdraw link) → connectDialogActive=true → connect_send → dispatches.
      const clickCalls: string[] = [];
      const profileUrl = "https://www.linkedin.com/in/joyce-he-791b7638a/";
      const initial: SnapshotEntry[] = [{ ref: "@e1", role: "button", name: "Send" }];
      nextCapture = makeContext(
        [
          { ref: "@e2", role: "button", name: "Send" },
          { ref: "@e3", role: "button", name: "Add a note" },
          { ref: "@e4", role: "link", name: "Pending, click to withdraw invitation sent to Joyce HE" },
        ],
        "profile",
        "page",
        profileUrl,
      );
      assert.ok(makeClickTool);
      const session = makeSession({
        initialEntries: initial,
        surface: "profile",
        activeLayer: "page",
        pageUrl: profileUrl,
        verifyResults: [{ matches: false }, { matches: true }],
        clickCalls,
        resolvedMode: () => "auto",
      });

      const result = await makeClickTool(session).execute({ ref: "@e1" }, { toolCallId: "t9a", messages: [] });

      assert.equal(result.ok, true);
      assert.deepEqual(clickCalls, ["@e2"]);
    })();
  });

  it("T-TYPE.9b: given the recapture FLIPS the surface (non-outbound → messaging-thread) with activeLayer unchanged, when retargeting to 'Send' in auto mode, then classification uses the NEW context (blocked) — and getBox/showAgentTarget receive the RETARGETED ref", () => {
    return (async () => {
      const clickCalls: string[] = [];
      const boxCalls: string[] = [];
      const initial: SnapshotEntry[] = [{ ref: "@e1", role: "button", name: "Send" }];
      nextCapture = makeContext([{ ref: "@e2", role: "button", name: "Send" }], "messaging-thread", "page");
      assert.ok(makeClickTool);
      // Initial surface is NOT a LinkedIn outbound surface — pre-fix classification would say benign.
      const session = makeSession({
        initialEntries: initial,
        surface: "other",
        activeLayer: "page",
        verifyResults: [{ matches: false }, { matches: true }],
        clickCalls,
        boxCalls,
        resolvedMode: () => "auto",
      });

      const result = await makeClickTool(session).execute({ ref: "@e1" }, { toolCallId: "t9b", messages: [] });

      assert.equal(result.ok, false);
      assert.match(result.error?.message ?? "", /Auto message-send is not authorized/);
      assert.deepEqual(clickCalls, []);
      // NIT carrier: highlight consulted on the retargeted ref only.
      assert.deepEqual(boxCalls, []);
    })();
  });

  it("T-TYPE.9c: on a successful retargeted manual click, getBox is called with the RETARGETED ref (highlight after revalidation)", () => {
    return (async () => {
      const clickCalls: string[] = [];
      const boxCalls: string[] = [];
      const initial: SnapshotEntry[] = [{ ref: "@ov1", role: "menuitem", name: "Joyce HE · 1st" }];
      nextCapture = makeContext([{ ref: "@ov2", role: "option", name: "Joyce HE · 1st" }]);
      assert.ok(makeClickTool);
      const session = makeSession({
        initialEntries: initial,
        verifyResults: [{ matches: false }, { matches: true }],
        clickCalls,
        boxCalls,
      });

      const result = await makeClickTool(session).execute({ ref: "@ov1" }, { toolCallId: "t9c", messages: [] });

      assert.equal(result.ok, true);
      assert.deepEqual(boxCalls, ["@ov2"]);
      assert.deepEqual(clickCalls, ["@ov2"]);
    })();
  });
});

// ─── T-TYPE.10 — recapture on a different activeLayer surrenders ─────────────────────────────────

describe("T-TYPE.10 — activeLayer discontinuity surrenders (no cross-layer re-identification)", () => {
  it("T-TYPE.10: given the expected entry is on the overlay layer but every recapture returns page-layer contexts, when click runs by ref, then it surrenders with ref_stale and never dispatches", () => {
    return (async () => {
      const clickCalls: string[] = [];
      const initial: SnapshotEntry[] = [{ ref: "@ov1", role: "menuitem", name: "Joyce HE · 1st" }];
      nextCapture = makeContext([{ ref: "@e9", role: "menuitem", name: "Joyce HE · 1st" }], "messaging-thread", "page");
      assert.ok(makeClickTool);
      const session = makeSession({
        initialEntries: initial,
        activeLayer: "overlay",
        verifyResults: [{ matches: false }, { matches: false }, { matches: false }],
        clickCalls,
      });

      const result = await makeClickTool(session).execute({ ref: "@ov1" }, { toolCallId: "t10", messages: [] });

      assert.equal(result.ok, false);
      assert.match(result.error?.message ?? "", /ref_stale/);
      assert.deepEqual(clickCalls, []);
    })();
  });
});

// ─── T-TYPE.11 — whitespace/case normalization in recapture matching ─────────────────────────────

describe("T-TYPE.11 — recapture name match is whitespace/case-normalized", () => {
  it("T-TYPE.11: given the expected name is 'Joyce HE · 1st' and the fresh entry is 'joyce  he\\u00A0· 1st' (case + NBSP + double space), when the ref verifies stale, then the recapture still re-identifies and retargets", () => {
    return (async () => {
      const clickCalls: string[] = [];
      const initial: SnapshotEntry[] = [{ ref: "@ov1", role: "menuitem", name: "Joyce HE · 1st" }];
      nextCapture = makeContext([{ ref: "@ov2", role: "menuitem", name: "joyce  he · 1st" }]);
      assert.ok(makeClickTool);
      const session = makeSession({
        initialEntries: initial,
        verifyResults: [{ matches: false }, { matches: true }],
        clickCalls,
      });

      const result = await makeClickTool(session).execute({ ref: "@ov1" }, { toolCallId: "t11", messages: [] });

      assert.equal(result.ok, true);
      assert.deepEqual(clickCalls, ["@ov2"]);
    })();
  });
});

// ─── T-TYPE.12 — retry path: fresh capture (not cached ctx) produces the ranked metadata ─────────

describe("T-TYPE.12 — fresh-capture retry returns the ranked resolution metadata", () => {
  it("T-TYPE.12: given the cached context has NO match for 'Joyce HE' and the fresh capture carries the two typeahead entries, when click runs by label, then the retry resolves from the FRESH capture and the envelope reports method='startsWith'", () => {
    return (async () => {
      const clickCalls: string[] = [];
      const initial: SnapshotEntry[] = [{ ref: "@e1", role: "button", name: "Unrelated" }];
      nextCapture = makeContext([
        { ref: "@ov1", role: "menuitem", name: "Joyce HE · 1st 普通职业" },
        { ref: "@ov7", role: "menuitem", name: "Photo of Joyce HE" },
      ]);
      assert.ok(makeClickTool);
      const session = makeSession({ initialEntries: initial, clickCalls });

      const result = await makeClickTool(session).execute({ label: "Joyce HE" }, { toolCallId: "t12", messages: [] });

      assert.equal(result.ok, true);
      assert.deepEqual(clickCalls, ["@ov1"]);
      assert.equal(result.data?.resolution?.method, "startsWith");
      assert.equal(result.data?.resolution?.candidates, 2);
    })();
  });
});

// ─── P-FIX-PICKER-MATCHING tool + recapture carriers ─────────────────────────────────────────────
describe("P-FIX-PICKER-MATCHING — real tool seams and recapture surrender", () => {
  // Given a compound newline AX entry on the flag-off path, when click uses a spaced label, then normalized substring dispatches once.
  it("T-PICK.5: compound-name plus newline mismatch reaches one real click dispatch", async () => {
    const clickCalls: string[] = [];
    const entries: SnapshotEntry[] = [
      { ref: "@ov1", role: "menuitem", name: "Photo of Joyce HE Joyce HE · 1st\n普通职业" },
      { ref: "@ov2", role: "menuitem", name: "Photo of Joyce Han" },
    ];
    assert.ok(makeClickTool);
    const session = makeSession({ initialEntries: entries, clickCalls });

    const result = await makeClickTool(session).execute(
      { label: "Joyce HE · 1st 普通职业" },
      { toolCallId: "pick5", messages: [] },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(clickCalls, ["@ov1"]);
  });

  // Given the exact 06 picker churn, when a normalized full label resolves the old entry, then D-17 safely retargets the fresh option.
  it("T-PICK.6: U+2022 picker photo-envelope churn retargets and dispatches once", async () => {
    const clickCalls: string[] = [];
    nextCapture = makeContext([{ ref: "@ov2", role: "option", name: "Photo of Joyce HE Joyce HE • 1st 普通职业" }]);
    assert.ok(makeClickTool);
    const session = makeSession({
      initialEntries: [{ ref: "@ov1", role: "menuitem", name: "Joyce HE • 1st\n普通职业" }],
      verifyResults: [
        {
          matches: false,
          currentRole: "option",
          currentName: "Photo of Joyce HE Joyce HE • 1st 普通职业",
        },
        { matches: true, currentRole: "option", currentName: "Photo of Joyce HE Joyce HE • 1st 普通职业" },
      ],
      clickCalls,
    });

    const result = await makeClickTool(session).execute(
      { label: "Joyce HE • 1st 普通职业" },
      { toolCallId: "pick6", messages: [] },
    );

    assert.equal(result.ok, true);
    assert.equal(result.data?.target, "@ov2");
    assert.deepEqual(clickCalls, ["@ov2"]);
  });

  // Given a stale Delete Account ref and prefixed fresh option, when recapture runs, then suffix collision cannot retarget.
  it("T-PICK.7: Delete Account suffix collision remains ref_stale", async () => {
    const clickCalls: string[] = [];
    nextCapture = makeContext([{ ref: "@ov2", role: "menuitem", name: "Permanently Delete Account" }]);
    assert.ok(makeClickTool);
    const session = makeSession({
      initialEntries: [{ ref: "@ov1", role: "menuitem", name: "Delete Account" }],
      verifyResults: [{ matches: false }, { matches: false }, { matches: false }],
      clickCalls,
    });

    const result = await makeClickTool(session).execute({ ref: "@ov1" }, { toolCallId: "pick7", messages: [] });

    assert.equal(result.ok, false);
    assert.match(result.error?.message ?? "", /ref_stale/);
    assert.deepEqual(clickCalls, []);
  });

  // Given eligible click and input targets with the scoped flag off, when labels normalize empty, then neither tool dispatches.
  it("T-PICK.9: real click and type tools fail closed with zero dispatch", async () => {
    const clickCalls: string[] = [];
    const inputCalls: string[] = [];
    const entries: SnapshotEntry[] = [
      { ref: "@e1", role: "button", name: "Start a post" },
      { ref: "@e2", role: "textbox", name: "Search people" },
    ];
    nextCapture = makeContext(entries, "search", "page", "https://www.linkedin.com/search/results/people/");
    const session = makeSession({
      initialEntries: entries,
      surface: "search",
      activeLayer: "page",
      pageUrl: "https://www.linkedin.com/search/results/people/",
      clickCalls,
      inputCalls,
    });
    assert.ok(makeClickTool && makeTypeTool);

    const clickResult = await makeClickTool(session).execute(
      { label: "   " },
      { toolCallId: "pick9-click", messages: [] },
    );
    const typeResult = await makeTypeTool(session).execute(
      { text: "must-not-dispatch", label: "\u00A0" },
      { toolCallId: "pick9-type", messages: [] },
    );

    assert.equal(clickResult.ok, false);
    assert.match(clickResult.error?.message ?? "", /no click target matches/i);
    assert.equal(typeResult.ok, false);
    assert.match(typeResult.error?.message ?? "", /no type target matches/i);
    assert.deepEqual(clickCalls, []);
    assert.deepEqual(inputCalls, []);
  });
});

// ─── T-TYPE.8 — scoped-resolver ambiguous fallback ───────────────────────────────────────────────

function logicCtx(entries: SnapshotEntry[], vsi?: unknown[]) {
  return {
    pageUrl: "https://www.linkedin.com/messaging/thread/new/",
    surface: "messaging-thread",
    activeLayer: "overlay",
    entries,
    repeatedControls: [],
    summary: {},
    ...(vsi ? { visibleScopeInspections: vsi } : {}),
  };
}

describe("T-TYPE.8 — scoped ambiguous fallback ranks ONLY the caught candidates", () => {
  it("T-TYPE.8a: a capture-wide-UNIQUE same-name entry OUTSIDE a covering visibleScopeInspection is rejected by the membership check → ORIGINAL scoped error rethrown", () => {
    return (async () => {
      // Given: scoped resolver throws ambiguous with ONE ref-less candidate 'Joyce HE'; the capture's
      // only 'Joyce HE' entry is NOT in the requested scope's controls (membership path, not non-uniqueness).
      assert.ok(resolveScopedForTool && CommandAmbiguousTargetErrorCls);
      scopedThrow = new CommandAmbiguousTargetErrorCls("ambiguous", [{ label: "Joyce HE" }]);
      nextLogicCapture = logicCtx(
        [{ ref: "@e50", role: "menuitem", name: "Joyce HE", selector: ".joyce" } as SnapshotEntry],
        [{ scope: { handle: "threadInput" }, controls: [{ ref: "@e99", label: "Other", role: "button" }] }],
      );

      await assert.rejects(
        () => resolveScopedForTool!({}, "button", "Joyce HE", "threadInput"),
        (err: unknown) => err === scopedThrow,
      );
    })();
  });

  it("T-TYPE.8b: a ref-less candidate maps to target=entry.selector with selectorOnly=true and preserved advice descriptor fields", () => {
    return (async () => {
      assert.ok(resolveScopedForTool && CommandAmbiguousTargetErrorCls);
      scopedThrow = new CommandAmbiguousTargetErrorCls("ambiguous", [
        { label: "Joyce HE" },
        { label: "Photo of Joyce HE" },
      ]);
      nextLogicCapture = logicCtx([
        { ref: "@e50", role: "menuitem", name: "Joyce HE", selector: ".joyce" } as SnapshotEntry,
        { ref: "@e51", role: "menuitem", name: "Photo of Joyce HE", selector: ".photo" } as SnapshotEntry,
      ]);

      const r = (await resolveScopedForTool!({}, "button", "Joyce HE", undefined)) as {
        target: string;
        selectorOnly: boolean;
        disambiguated?: boolean;
        method?: string;
        resolvedTarget: { selector: string; role: string; label: string };
      };

      assert.equal(r.target, ".joyce");
      assert.equal(r.selectorOnly, true);
      assert.equal(r.disambiguated, true);
      assert.equal(r.method, "startsWith");
      assert.equal(r.resolvedTarget.selector, ".joyce");
      assert.equal(r.resolvedTarget.role, "menuitem");
      assert.equal(r.resolvedTarget.label, "Joyce HE");
    })();
  });

  it("T-TYPE.8c: candidate refs are @-normalized (raw e5 resolves to @e5)", () => {
    return (async () => {
      assert.ok(resolveScopedForTool && CommandAmbiguousTargetErrorCls);
      scopedThrow = new CommandAmbiguousTargetErrorCls("ambiguous", [
        { label: "Joyce HE", ref: "e5" },
        { label: "Photo of Joyce HE", ref: "e6" },
      ]);
      nextLogicCapture = logicCtx([
        { ref: "@e5", role: "menuitem", name: "Joyce HE" },
        { ref: "@e6", role: "menuitem", name: "Photo of Joyce HE" },
      ]);

      const r = (await resolveScopedForTool!({}, "button", "Joyce HE", undefined)) as {
        target: string;
        selectorOnly: boolean;
      };

      assert.equal(r.target, "@e5");
      assert.equal(r.selectorOnly, false);
    })();
  });

  it("T-TYPE.8d: a ref-less candidate whose unique label-matched entry LACKS a selector rethrows (never a missing target)", () => {
    return (async () => {
      assert.ok(resolveScopedForTool && CommandAmbiguousTargetErrorCls);
      scopedThrow = new CommandAmbiguousTargetErrorCls("ambiguous", [{ label: "Joyce HE" }]);
      nextLogicCapture = logicCtx([{ ref: "@e50", role: "menuitem", name: "Joyce HE" }]);

      await assert.rejects(
        () => resolveScopedForTool!({}, "button", "Joyce HE", undefined),
        (err: unknown) => err === scopedThrow,
      );
    })();
  });

  it("T-TYPE.8e: a ref-less candidate with TWO same-label entries in the capture rethrows (no wrong-scope dispatch)", () => {
    return (async () => {
      assert.ok(resolveScopedForTool && CommandAmbiguousTargetErrorCls);
      scopedThrow = new CommandAmbiguousTargetErrorCls("ambiguous", [{ label: "Joyce HE" }]);
      nextLogicCapture = logicCtx([
        { ref: "@e50", role: "menuitem", name: "Joyce HE", selector: ".in" } as SnapshotEntry,
        { ref: "@e10", role: "menuitem", name: "Joyce HE", selector: ".out" } as SnapshotEntry,
      ]);

      await assert.rejects(
        () => resolveScopedForTool!({}, "button", "Joyce HE", "threadInput"),
        (err: unknown) => err === scopedThrow,
      );
    })();
  });

  it("T-TYPE.8f: a candidate whose ref matches NO entry rethrows even when its label would otherwise resolve (no label fallback for unmatched refs)", () => {
    return (async () => {
      assert.ok(resolveScopedForTool && CommandAmbiguousTargetErrorCls);
      scopedThrow = new CommandAmbiguousTargetErrorCls("ambiguous", [{ label: "Joyce HE", ref: "e404" }]);
      nextLogicCapture = logicCtx([
        { ref: "@e50", role: "menuitem", name: "Joyce HE", selector: ".joyce" } as SnapshotEntry,
      ]);

      await assert.rejects(
        () => resolveScopedForTool!({}, "button", "Joyce HE", undefined),
        (err: unknown) => err === scopedThrow,
      );
    })();
  });
});
