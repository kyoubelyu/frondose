/**
 * NATIVE-PORT SLICE 4 — flag-gated tool-layer wire-in to `resolveScopedTarget`.
 *
 * Proves BOTH flag states of the click + type tools' label-resolution path:
 *   - FRONDOSE_SCOPED_RESOLVE unset ⇒ legacy `resolveByLabel(WithRetry)` path (ZERO change);
 *     `resolveScopedTarget` is NEVER called.
 *   - FRONDOSE_SCOPED_RESOLVE=on   ⇒ resolution via `resolveScopedTarget`; the resolved `.ref`
 *     feeds the same downstream target; the outbound guard STILL gates identically on an outbound
 *     surface; a `.ref`-absent (selector-only) unnameable outbound target FAILS CLOSED; and the
 *     success envelope gains the `advice` block for an outbound-classified action.
 *
 * `resolveScopedTarget` (the logic-layer resolver, which does a heavy CDP round-trip) is replaced
 * via mock.module (--experimental-test-module-mocks) so the ADAPTER + tool wiring run REAL against
 * a controlled resolver output. The `@e{N}`↔selector LIVE round-trip is NOT covered here — that is
 * the subsequent live 3-surface gate (blueprint ADVERSARIAL §5).
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --experimental-test-module-mocks \
 *     tests/tools/browser/scopedResolve-slice4.mock.test.ts
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import { CdpClient } from "../../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/types.js";

// biome-ignore lint/suspicious/noExplicitAny: mock session + dynamic-import shapes
type AnyObj = Record<string, any>;
// biome-ignore lint/suspicious/noExplicitAny: dynamic-import fn shape
type AnyFn = (...args: any[]) => any;

// Keep the suite fast — disable inter-tool pacing.
process.env.FRONDOSE_PACE_MIN_MS = "0";
process.env.FRONDOSE_PACE_MAX_MS = "0";

const abortSignal = new AbortController().signal;
const FAKE_BORDER = [10, 20, 30, 20, 30, 40, 10, 40]; // center x=20 y=30

// ─── Controlled resolver output (set per test; consumed by the mocked resolveScopedTarget) ────
let _nextResolved: AnyObj | null = null;
let _resolveCalls = 0;

let makeClickTool: AnyFn;
let makeTypeTool: AnyFn;
let resolveScopedForTool: AnyFn;
let buildScopedClickAdvice: AnyFn;
let scopedResolveEnabled: AnyFn;

before(async () => {
  const targetResUrl = pathToFileURL(
    resolve(process.cwd(), "src/linkedin/logic/scopeResolver/targetResolution.js"),
  ).href;
  const real: AnyObj = await import(targetResUrl).catch(() => ({}));
  mock.module(targetResUrl, {
    namedExports: {
      ...real,
      resolveScopedTarget: async (_input: unknown, _opts: unknown) => {
        _resolveCalls += 1;
        if (!_nextResolved) throw new Error("test bug: _nextResolved not set before flag-on resolution");
        return _nextResolved;
      },
    },
  });
  ({ makeClickTool } = await import(pathToFileURL(resolve(process.cwd(), "src/tools/browser/click.js")).href));
  ({ makeTypeTool } = await import(pathToFileURL(resolve(process.cwd(), "src/tools/browser/type.js")).href));
  ({ resolveScopedForTool, buildScopedClickAdvice, scopedResolveEnabled } = await import(
    pathToFileURL(resolve(process.cwd(), "src/tools/browser/scopedResolve.js")).href
  ));
});

function setFlag(on: boolean): void {
  if (on) process.env.FRONDOSE_SCOPED_RESOLVE = "on";
  else delete process.env.FRONDOSE_SCOPED_RESOLVE;
}

/** A minimal logic-layer CurrentSurfaceContext (rich enough for advice classification). */
function makeLogicCtx(pageUrl: string, surface: string, entries: AnyObj[], text: string[] = []): AnyObj {
  return {
    pageUrl,
    surface,
    activeLayer: "page",
    entries,
    repeatedControls: [],
    summary: { surface, activeLayer: "page", availableScopes: [], text, buttons: [], inputs: [] },
    visibleScopeInspections: [],
  };
}

/** A fake CDP handle whose AX tree exposes the given (role,name) nodes as refs @e1.. */
function makeFakeHandle(nodes: Array<{ role: string; name: string }>) {
  return {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: nodes.map((n, i) => ({
          nodeId: `ax${i}`,
          role: { type: "role", value: n.role },
          name: { type: "string", value: n.name },
          backendDOMNodeId: 100 + i,
        })),
      }),
    },
    DOM: {
      getDocument: async () => ({ root: { nodeId: 1 } }),
      querySelectorAll: async () => ({ nodeIds: [] }),
      scrollIntoViewIfNeeded: async () => {},
      getBoxModel: async () => ({ model: { border: FAKE_BORDER } }),
    },
    Input: {
      dispatchMouseEvent: async () => {},
      dispatchKeyEvent: async () => {},
      insertText: async () => {},
    },
  };
}

interface GuardHooks {
  canClickOutbound?: (label: string, surface: string) => boolean;
}

/** A session whose lastContext is mutable (so setLastContext during flag-on resolution sticks). */
function makeSession(
  nodes: Array<{ role: string; name: string }>,
  initialCtx: CurrentSurfaceContext | undefined,
  hooks: GuardHooks = {},
) {
  const client = CdpClient.fromHandle(makeFakeHandle(nodes));
  let lastCtx = initialCtx;
  return {
    inputMode: "cdp" as const,
    getOrInitClient: () => Promise.resolve({ ok: true as const, client }),
    getClient: () => client,
    setLastContext: (ctx: CurrentSurfaceContext) => {
      lastCtx = ctx;
    },
    getLastContext: () => lastCtx,
    ...(hooks.canClickOutbound ? { canClickOutbound: hooks.canClickOutbound } : {}),
  };
}

const PROFILE_URL = "https://www.linkedin.com/in/jane-doe/";

// ─── FLAG READER ───────────────────────────────────────────────────────────────

describe("S4.flag: scopedResolveEnabled", () => {
  // Given/When/Then: the reader is off by default and only "on" flips it.
  it("returns false when unset and true only for exactly 'on'", () => {
    assert.equal(scopedResolveEnabled({}), false, "unset ⇒ off");
    assert.equal(scopedResolveEnabled({ FRONDOSE_SCOPED_RESOLVE: "1" }), false, "'1' ⇒ off");
    assert.equal(scopedResolveEnabled({ FRONDOSE_SCOPED_RESOLVE: "true" }), false, "'true' ⇒ off");
    assert.equal(scopedResolveEnabled({ FRONDOSE_SCOPED_RESOLVE: "on" }), true, "'on' ⇒ on");
  });
});

// ─── ADAPTER (resolveScopedForTool) ──────────────────────────────────────────────

describe("S4.adapter: resolveScopedForTool", () => {
  // Given a resolved target WITH a ref: prefer the @ref; synthesize a runtime targetEntry from the
  // resolver's matched label+role; recompute the runtime surface via inferSurface(pageUrl).
  it("ref present ⇒ target=@ref, selectorOnly=false, runtime surface via inferSurface", async () => {
    _nextResolved = {
      context: makeLogicCtx(PROFILE_URL, "profile-logic-string", [
        { ref: "@e1", role: "button", name: "Send without a note" },
      ]),
      target: {
        kind: "button",
        selector: "button.artdeco",
        ref: "@e1",
        label: "Send without a note",
        role: "button",
        scope: "connectPrompt",
      },
    };
    const out = await resolveScopedForTool({} as unknown, "button", "Send without a note", "connectPrompt");
    assert.equal(out.target, "@e1", "prefers the AX ref");
    assert.equal(out.selectorOnly, false);
    assert.deepEqual(out.targetEntry, { ref: "@e1", role: "button", name: "Send without a note" });
    // runtime surface is recomputed from the URL (NOT the logic surface string) so the guard matches.
    assert.equal(out.runtimeContext.surface, "profile", "inferSurface(/in/…) ⇒ profile (runtime surface)");
    assert.equal(out.runtimeContext.entries.length, 1, "runtime ctx carries the resolver's entries");
  });

  // Given a resolved target with NO ref (synthesized visible-scope control): fall back to the selector.
  it("ref absent ⇒ target=selector, selectorOnly=true", async () => {
    _nextResolved = {
      context: makeLogicCtx(PROFILE_URL, "profile", []),
      target: { kind: "button", selector: "div.upload-trigger", label: "Add media", role: "button" },
    };
    const out = await resolveScopedForTool({} as unknown, "button", "Add media", undefined);
    assert.equal(out.target, "div.upload-trigger");
    assert.equal(out.selectorOnly, true);
  });
});

// ─── CLICK: flag routing ─────────────────────────────────────────────────────────

describe("S4.click.route", () => {
  // Given the flag UNSET: a label click resolves via the legacy retry path; resolveScopedTarget
  // is NEVER invoked (byte-for-byte legacy behavior preserved).
  it("flag UNSET ⇒ legacy resolveByLabelWithRetry path, resolveScopedTarget NOT called", async () => {
    setFlag(false);
    const before = _resolveCalls;
    const initial: CurrentSurfaceContext = {
      pageUrl: "https://www.linkedin.com/feed/",
      surface: "feed",
      activeLayer: "page",
      entries: [{ ref: "@e1", role: "button", name: "Start a post" }],
    };
    const session = makeSession([{ role: "button", name: "Start a post" }], initial);
    await session.getClient().snapshot();
    const tool = makeClickTool(session);
    const res = await tool.execute({ label: "Start a post" }, { toolCallId: "u1", messages: [], abortSignal });
    assert.equal(res.ok, true, "legacy label path still succeeds");
    assert.equal(_resolveCalls, before, "resolveScopedTarget must NOT be called when the flag is off");
  });

  // Given the flag ON: a benign (non-outbound) label click resolves via resolveScopedTarget and
  // dispatches; resolveScopedTarget IS invoked exactly once.
  it("flag ON ⇒ resolves via resolveScopedTarget and dispatches on a benign surface", async () => {
    setFlag(true);
    _nextResolved = {
      context: makeLogicCtx("https://www.linkedin.com/feed/", "feed", [{ ref: "@e1", role: "button", name: "Home" }]),
      target: { kind: "button", selector: "@e1", ref: "@e1", label: "Home", role: "button" },
    };
    const session = makeSession([{ role: "button", name: "Home" }], undefined);
    await session.getClient().snapshot();
    const tool = makeClickTool(session);
    const before = _resolveCalls;
    const res = (await tool.execute({ label: "Home" }, { toolCallId: "o1", messages: [], abortSignal })) as AnyObj;
    assert.equal(res.ok, true, "flag-on benign click dispatches");
    assert.equal(res.data.target, "@e1", "downstream target is the resolved @ref");
    assert.equal(_resolveCalls, before + 1, "resolveScopedTarget called exactly once");
    setFlag(false);
  });
});

// ─── CLICK: outbound guard still fires (flag ON) ─────────────────────────────────

describe("S4.click.guard", () => {
  // Given the flag ON and an outbound "Send without a note" on a profile surface, with the session
  // denying outbound: the approval guard blocks BEFORE dispatch — identical gating to the legacy path.
  it("flag ON ⇒ outbound approval guard STILL blocks (connect_send on profile)", async () => {
    setFlag(true);
    _nextResolved = {
      context: makeLogicCtx(PROFILE_URL, "connectPrompt", [
        { ref: "@e1", role: "button", name: "Send without a note" },
      ]),
      target: {
        kind: "button",
        selector: "@e1",
        ref: "@e1",
        label: "Send without a note",
        role: "button",
        scope: "connectPrompt",
      },
    };
    const session = makeSession([{ role: "button", name: "Send without a note" }], undefined, {
      canClickOutbound: () => false, // operator has NOT approved
    });
    await session.getClient().snapshot();
    const tool = makeClickTool(session);
    const res = (await tool.execute(
      { label: "Send without a note" },
      { toolCallId: "g1", messages: [], abortSignal },
    )) as AnyObj;
    assert.equal(res.ok, false, "outbound must be blocked when unapproved");
    assert.equal(res.reason, "approval_required", "same guard discriminator as the legacy path");
    setFlag(false);
  });

  // Given the flag ON and a selector-only (ref absent) target with NO accessible name on an outbound
  // surface: it MUST fail closed rather than dispatch an unguardable outbound click.
  it("flag ON ⇒ selector-only unnameable outbound target FAILS CLOSED", async () => {
    setFlag(true);
    _nextResolved = {
      context: makeLogicCtx(PROFILE_URL, "profile", []),
      target: { kind: "button", selector: "div.mystery-send", label: "", role: "button" },
    };
    const session = makeSession([{ role: "button", name: "x" }], undefined);
    await session.getClient().snapshot();
    const tool = makeClickTool(session);
    const res = (await tool.execute({ label: "whatever" }, { toolCallId: "fc1", messages: [], abortSignal })) as AnyObj;
    assert.equal(res.ok, false, "unnameable selector-only outbound target must not dispatch");
    assert.equal(res.reason, "unresolvable_ref_on_outbound_surface", "fail-closed discriminator");
    setFlag(false);
  });
});

// ─── CLICK: advice on outbound success (flag ON) ─────────────────────────────────

describe("S4.click.advice", () => {
  // Given the flag ON and an APPROVED outbound "Send without a note": the success envelope carries
  // the outward-action advice block (additive) while target/pacing/hint stay intact.
  it("flag ON ⇒ advice attached to an outbound-classified success envelope", async () => {
    setFlag(true);
    const logicCtx = makeLogicCtx(
      PROFILE_URL,
      "connectPrompt",
      [{ ref: "@e1", role: "button", name: "Send without a note" }],
      ["Jane Doe"],
    );
    _nextResolved = {
      context: logicCtx,
      target: {
        kind: "button",
        selector: "@e1",
        ref: "@e1",
        label: "Send without a note",
        role: "button",
        scope: "connectPrompt",
      },
    };
    const session = makeSession([{ role: "button", name: "Send without a note" }], undefined, {
      canClickOutbound: () => true, // approved ⇒ dispatches
    });
    await session.getClient().snapshot();
    const tool = makeClickTool(session);
    const res = (await tool.execute(
      { label: "Send without a note" },
      { toolCallId: "a1", messages: [], abortSignal },
    )) as AnyObj;
    assert.equal(res.ok, true, "approved outbound click dispatches");
    assert.ok(Array.isArray(res.data.advice) && res.data.advice.length > 0, "advice block present");
    assert.equal(typeof res.data.hint, "string", "existing hint field preserved");
    assert.equal(res.data.target, "@e1", "existing target field preserved");
    // Cross-check: the same advice the tool attached is what the classifier produces.
    const expected = buildScopedClickAdvice(logicCtx, _nextResolved.target);
    assert.deepEqual(res.data.advice, expected);
    setFlag(false);
  });

  // Given the flag ON and a benign target: NO advice key is added (envelope unchanged when empty).
  it("flag ON ⇒ benign target adds NO advice key", async () => {
    setFlag(true);
    _nextResolved = {
      context: makeLogicCtx("https://www.linkedin.com/feed/", "feed", [{ ref: "@e1", role: "button", name: "Home" }]),
      target: { kind: "button", selector: "@e1", ref: "@e1", label: "Home", role: "button" },
    };
    const session = makeSession([{ role: "button", name: "Home" }], undefined);
    await session.getClient().snapshot();
    const tool = makeClickTool(session);
    const res = (await tool.execute({ label: "Home" }, { toolCallId: "b1", messages: [], abortSignal })) as AnyObj;
    assert.equal(res.ok, true);
    assert.equal("advice" in res.data, false, "no advice key for a benign action");
    setFlag(false);
  });
});

// ─── TYPE: flag routing + advice ─────────────────────────────────────────────────

describe("S4.type.route", () => {
  // Given the flag UNSET: label type resolves via the legacy resolveByLabel; resolveScopedTarget
  // is not called.
  it("flag UNSET ⇒ legacy resolveByLabel path, resolveScopedTarget NOT called", async () => {
    setFlag(false);
    const initial: CurrentSurfaceContext = {
      pageUrl: "https://www.linkedin.com/search/results/people/",
      surface: "search",
      activeLayer: "page",
      entries: [{ ref: "@e1", role: "textbox", name: "Search" }],
    };
    const session = makeSession([{ role: "textbox", name: "Search" }], initial);
    await session.getClient().snapshot();
    const tool = makeTypeTool(session);
    const before = _resolveCalls;
    const res = (await tool.execute(
      { text: "hello", label: "Search" },
      { toolCallId: "t0", messages: [], abortSignal },
    )) as AnyObj;
    assert.equal(res.ok, true, "legacy type label path succeeds");
    assert.equal(_resolveCalls, before, "resolveScopedTarget NOT called when flag off");
  });

  // Given the flag ON and a threadInput message input: type resolves via resolveScopedTarget and the
  // success envelope carries the message-draft advice block.
  it("flag ON ⇒ resolves via resolveScopedTarget and attaches advice for a message input", async () => {
    setFlag(true);
    const initial: CurrentSurfaceContext = {
      pageUrl: "https://www.linkedin.com/messaging/thread/abc/",
      surface: "messaging-thread",
      activeLayer: "page",
      entries: [{ ref: "@e1", role: "textbox", name: "Write a message…" }],
    };
    _nextResolved = {
      context: makeLogicCtx("https://www.linkedin.com/messaging/thread/abc/", "messaging-thread", [
        { ref: "@e1", role: "textbox", name: "Write a message…" },
      ]),
      target: {
        kind: "input",
        selector: "@e1",
        ref: "@e1",
        label: "Write a message…",
        role: "textbox",
        scope: "threadInput",
      },
    };
    const session = makeSession([{ role: "textbox", name: "Write a message…" }], initial);
    await session.getClient().snapshot();
    const tool = makeTypeTool(session);
    const before = _resolveCalls;
    const res = (await tool.execute(
      { text: "hi there", label: "Write a message…" },
      { toolCallId: "t1", messages: [], abortSignal },
    )) as AnyObj;
    assert.equal(res.ok, true, "flag-on type dispatches");
    assert.equal(res.data.target, "@e1", "downstream target is the resolved @ref");
    assert.equal(_resolveCalls, before + 1, "resolveScopedTarget called exactly once");
    assert.ok(Array.isArray(res.data.advice) && res.data.advice.length > 0, "message-input advice attached");
    setFlag(false);
  });
});
