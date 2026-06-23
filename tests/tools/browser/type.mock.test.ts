/**
 * P-3 mock tests — T-M65..T-M67: type tool.
 *
 * Tests makeTypeTool() schema, execute dispatch (ref + label paths), and no-ref-no-label error.
 * NOTE: execute() calls applyPacing() (inter-tool dwell) in addition to the within-`type`
 * char-by-char pacing. P-Y5 D-RUN-2 raises the inter-tool default band to 800-2500ms, so this
 * suite disables inter-tool pacing via MAI_PACE_MIN_MS=0 (resolvePaceBand → disabled → no sleep).
 * The within-`type` char delay (computeCharDelay) is unaffected and still under test.
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/types.js";
import { computeCharDelay, makeTypeTool } from "../../../src/tools/browser/type.js";

// P-Y5 D-RUN-2: keep the mock suite fast — disable inter-tool pacing for this file.
process.env.FRONDOSE_PACE_MIN_MS = "0";

const abortSignal = new AbortController().signal;
const FAKE_BORDER = [0, 0, 10, 0, 10, 10, 0, 10]; // center: x=5, y=5

/**
 * Make a fake session with configurable entries for ambiguous-target tests.
 * Adds the existing callLog tracking for CDP call verification.
 */
function makeFakeSessionWithEntries(entries: Array<{ ref: string; role: string; name: string }>) {
  const callLog: string[] = [];

  const fakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: entries.map((e, i) => ({
          nodeId: `ax${i}`,
          role: { type: "role", value: e.role },
          name: { type: "string", value: e.name },
          backendDOMNodeId: 100 + i,
        })),
      }),
    },
    DOM: {
      getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (_args: unknown) => ({ nodeIds: [] }),
      scrollIntoViewIfNeeded: async (_arg: unknown) => {},
      getBoxModel: async (_args: unknown) => ({ model: { border: FAKE_BORDER } }),
    },
    Input: {
      dispatchMouseEvent: async (args: { type: string }) => {
        callLog.push(`mouse:${args.type}`);
      },
      dispatchKeyEvent: async (args: { type: string; key: string; modifiers?: number }) => {
        callLog.push(`key:${args.type}:${args.key}:mod${args.modifiers ?? 0}`);
      },
      insertText: async (args: { text: string }) => {
        callLog.push(`insertText:${args.text}`);
      },
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);

  return {
    inputMode: "cdp" as const,
    getOrInitClient: () => Promise.resolve({ ok: true as const, client }),
    getClient: () => client,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () =>
      ({
        pageUrl: "https://www.linkedin.com/feed/",
        surface: "feed",
        activeLayer: "page",
        entries,
      }) as CurrentSurfaceContext,
    callLog,
  };
}

function makeFakeSession() {
  const callLog: string[] = [];

  const fakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: [
          {
            nodeId: "ax1",
            role: { type: "role", value: "textbox" },
            name: { type: "string", value: "Search" },
            backendDOMNodeId: 55,
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
      dispatchMouseEvent: async (args: { type: string }) => {
        callLog.push(`mouse:${args.type}`);
      },
      dispatchKeyEvent: async (args: { type: string; key: string; modifiers?: number }) => {
        callLog.push(`key:${args.type}:${args.key}:mod${args.modifiers ?? 0}`);
      },
      insertText: async (args: { text: string }) => {
        callLog.push(`insertText:${args.text}`);
      },
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);

  return {
    inputMode: "cdp" as const,
    getOrInitClient: () => Promise.resolve({ ok: true as const, client }),
    getClient: () => client,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () =>
      ({
        pageUrl: "https://www.linkedin.com/feed/",
        surface: "feed",
        activeLayer: "page",
        entries: [{ ref: "@e1", role: "textbox", name: "Search" }],
      }) as CurrentSurfaceContext,
    callLog,
  };
}

// ─── T-M65 ─────────────────────────────────────────────────────────────────────

test("T-M65: makeTypeTool has description + schema requires text; ref and label are optional", () => {
  const session = makeFakeSession();
  const tool = makeTypeTool(session);

  assert.ok(typeof tool.description === "string");
  assert.ok(
    tool.description.toLowerCase().includes("type") || tool.description.toLowerCase().includes("text"),
    "description must mention typing or text",
  );

  // Valid: text + ref
  const withRef = tool.parameters.safeParse({ text: "hello", ref: "@e1" });
  assert.equal(withRef.success, true);

  // Valid: text + label
  const withLabel = tool.parameters.safeParse({ text: "hello", label: "Search" });
  assert.equal(withLabel.success, true);

  // Invalid: no text
  const noText = tool.parameters.safeParse({ ref: "@e1" });
  assert.equal(noText.success, false, "missing text must fail");
});

// ─── T-M66 ─────────────────────────────────────────────────────────────────────

test("T-M66: type tool execute via ref dispatches click → Ctrl+A → insertText", { timeout: 5000 }, async () => {
  const session = makeFakeSession();
  await session.getClient().snapshot(); // populate refMap with @e1 (textbox)

  const tool = makeTypeTool(session);

  const result = await tool.execute(
    { text: "hello world", ref: "@e1" },
    { toolCallId: "t1", messages: [], abortSignal },
  );

  assert.equal(result.ok, true, "result.ok must be true");
  assert.equal(result.command, "type");

  // Verify call sequence: click happened, then Ctrl+A, then per-char insertText calls
  const log = session.callLog;

  // P-47 G-2: per-char dispatch — "hello world" (11 chars) → 11 single-char insertText calls
  const singleCharInserts = log.filter((e) => e.startsWith("insertText:") && e.length === 12);
  assert.equal(singleCharInserts.length, 11, "insertText must be called 11× (one per char of 'hello world')");

  // Cmd+A: dispatchKeyEvent with key='a' and modifiers=4 (Cmd on macOS; P-59 D-RUN-3 fix)
  const cmdA = log.find((e) => e === "key:keyDown:a:mod4");
  assert.ok(cmdA !== undefined, "Cmd+A (keyDown a modifiers=4) must be dispatched before insertText");

  // Mouse click must precede first insertText
  const mouseMoveIdx = log.indexOf("mouse:mouseMoved");
  const firstInsertIdx = log.findIndex((e) => e.startsWith("insertText:") && e.length === 12);
  assert.ok(mouseMoveIdx >= 0 && mouseMoveIdx < firstInsertIdx, "mouse click must precede insertText");

  // type does NOT emit hint (not state-changing per cli-primitives.md §type)
  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const data = (result as any).data;
  assert.equal(data.hint, undefined, "type must NOT include data.hint (not state-changing)");
});

// ─── T-M67 ─────────────────────────────────────────────────────────────────────

// ─── T-Type.3 — ambiguous_target on multi-input scope without label ────────────

test("T-Type.3: ambiguous_target when >1 input matches scope and no label", { timeout: 5000 }, async () => {
  // Given: session context with 2 textbox entries [{ ref: "@e1", role: "textbox", name: "Write a message…" }, //          { ref: "@e2", role: "textbox", name: "Recipient" }] under scope "threadInput"
  // When:  type({ text: "hello", scope: "threadInput" }) called — no label provided
  // Then:  ok=false; error.kind==="ambiguous_target"; error.candidates lists both inputs with ref and name

  const session = makeFakeSessionWithEntries([
    { ref: "@e1", role: "textbox", name: "Write a message…" },
    { ref: "@e2", role: "textbox", name: "Recipient" },
  ]);
  await session.getClient().snapshot();

  const tool = makeTypeTool(session);
  const result = await tool.execute(
    { text: "hello", scope: "threadInput" },
    { toolCallId: "t3a", messages: [], abortSignal },
  );

  assert.equal(result.ok, false, "ambiguous_target must return ok=false");
  assert.equal(result.command, "type");
  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const error = (result as any).error;
  assert.equal(error.kind, "ambiguous_target", "error.kind must be 'ambiguous_target'");
  assert.ok(Array.isArray(error.candidates), "error.candidates must be an array");
  assert.equal(error.candidates.length, 2, "error.candidates must list both inputs");
  assert.equal(error.candidates[0].ref, "@e1");
  assert.equal(error.candidates[0].label, "Write a message…");
  assert.equal(error.candidates[1].ref, "@e2");
  assert.equal(error.candidates[1].label, "Recipient");
});

// ─── T-Type.4 — succeeds with label on multi-input scope ──────────────────────

test("T-Type.4: succeeds with label disambiguation on >1 input scope", { timeout: 5000 }, async () => {
  // Given: same dual-input context as T-Type.3
  // When:  type({ text: "hello", scope: "threadInput", label: "Write a message…" }) called
  // Then:  ok=true; data.target==="@e1"; Cmd+A + insertText dispatched to the correct input

  const session = makeFakeSessionWithEntries([
    { ref: "@e1", role: "textbox", name: "Write a message…" },
    { ref: "@e2", role: "textbox", name: "Recipient" },
  ]);
  await session.getClient().snapshot();

  const tool = makeTypeTool(session);
  const result = await tool.execute(
    { text: "hello", scope: "threadInput", label: "Write a message…" },
    { toolCallId: "t4a", messages: [], abortSignal },
  );

  assert.equal(result.ok, true, "type with label must succeed");
  assert.equal(result.command, "type");
  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const data = (result as any).data;
  assert.equal(data.target, "@e1", "data.target must be the resolved ref of the label-matched input");

  // Verify Cmd+A + per-char insertText dispatched (P-59 D-RUN-3: Cmd+A mod4 on macOS)
  const log = session.callLog;
  const cmdA = log.find((e) => e === "key:keyDown:a:mod4");
  assert.ok(cmdA !== undefined, "Cmd+A (mod4) must be dispatched before insertText");
  // P-47 G-2: per-char dispatch — "hello" (5 chars) → 5 single-char insertText calls
  const singleCharInserts = log.filter((e) => e.startsWith("insertText:") && e.length === 12);
  assert.equal(singleCharInserts.length, 5, "insertText must be called 5× (one per char of 'hello')");
});

// ─── T-Type.5 — succeeds on single-input scope without label ──────────────────

test("T-Type.5: no error on single-input scope without label", { timeout: 5000 }, async () => {
  // Given: session context has single textbox [{ ref: "@e1", role: "textbox", name: "Search" }] under scope "search"
  // When:  type({ text: "query", scope: "search" }) called — no label
  // Then:  ok=true; single input auto-selected (non-ambiguous)

  const session = makeFakeSessionWithEntries([{ ref: "@e1", role: "textbox", name: "Search" }]);
  await session.getClient().snapshot();

  const tool = makeTypeTool(session);
  const result = await tool.execute(
    { text: "query", scope: "search" },
    { toolCallId: "t5a", messages: [], abortSignal },
  );

  assert.equal(result.ok, true, "single-input scope without label must succeed");
  assert.equal(result.command, "type");
  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const data = (result as any).data;
  assert.equal(data.target, "@e1", "data.target must be the auto-selected input ref");

  // Verify typing dispatched to correct input
  const log = session.callLog;
  const cmdA = log.find((e) => e === "key:keyDown:a:mod4");
  assert.ok(cmdA !== undefined, "Cmd+A (mod4) must be dispatched"); // P-59 D-RUN-3: macOS select-all
  // P-47 G-2: per-char dispatch — "query" (5 chars) → 5 single-char insertText calls
  const singleCharInserts = log.filter((e) => e.startsWith("insertText:") && e.length === 12);
  assert.equal(singleCharInserts.length, 5, "insertText must be called 5× (one per char of 'query')");
});

// ─────────────────────────────────────────────────────────────────────────────
// P-47 G-2 scaffolds (Step 4a — all assertion bodies TODO; added 2026-05-20)
// ─────────────────────────────────────────────────────────────────────────────

// ─── T-Type.1 (G-P47.2): per-char dispatch — 5 printable chars ───────────────

describe("T-Type.1 (G-P47.2): per-char dispatch — 'hello' → 5 single-char insertText calls", () => {
  it(
    "insertText called 5× (one per char); full string never passed; dispatchKeyEvent only for Ctrl+A",
    { timeout: 3000 },
    async () => {
      // Given: CDP-mode session; fake handle records insertText/dispatchKeyEvent to callLog;
      //        text = "hello" (5 printable chars, no \n); ref = "@e1" (textbox in context)
      // When:  execute({ text: "hello", ref: "@e1" }) runs (Step 4b: per-char loop implemented)
      // Then:  (a) insertText called exactly 5 times, each call's text is ONE character
      //             ("h", "e", "l", "l", "o" in order)
      //         (b) insertText is NEVER called with the full string "hello"
      //         (c) dispatchKeyEvent called exactly twice: Cmd+A keyDown + Cmd+A keyUp
      //             (key:"a", modifiers:4, macOS) — and NOT for any of the 5 printable chars
      //             Plus: Backspace keyDown + keyUp (to delete the selection — P-59 D-RUN-3)
      const session = makeFakeSession();
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hello", ref: "@e1" },
        { toolCallId: "t-type1", messages: [], abortSignal },
      );
      assert.equal(result.ok, true, "T-Type.1: result.ok must be true");

      const log = session.callLog;

      // (a) insertText called exactly 5 times, each with one character in order
      const insertCalls = log.filter((e) => e.startsWith("insertText:"));
      assert.equal(insertCalls.length, 5, "T-Type.1: insertText must be called exactly 5 times (one per char)");
      const actualChars = insertCalls.map((e) => e.slice("insertText:".length));
      assert.deepEqual(actualChars, ["h", "e", "l", "l", "o"], "T-Type.1: chars must be h/e/l/l/o in order");

      // (b) insertText NEVER called with the full string
      assert.ok(
        !log.some((e) => e === "insertText:hello"),
        "T-Type.1: atomic insertText('hello') must never be called",
      );

      // (c) dispatchKeyEvent for Cmd+A (mod4) — no Enter events (no \\n in "hello")
      const enterEvents = log.filter((e) => e.includes(":Enter:"));
      assert.equal(enterEvents.length, 0, "T-Type.1: no Enter key events for text with no newlines");
      // [P-59 D-RUN-3] Cmd+A (macOS modifier 4) + Backspace to clear field before typing
      const cmdAEvents = log.filter((e) => e.includes(":a:mod4"));
      assert.equal(cmdAEvents.length, 2, "T-Type.1: exactly 2 Cmd+A events (keyDown + keyUp, macOS mod4)");
      const backspaceEvents = log.filter((e) => e.includes(":Backspace:"));
      assert.equal(backspaceEvents.length, 2, "T-Type.1: Backspace keyDown + keyUp to delete Cmd+A selection");
    },
  );
});

// ─── T-Type.2 (G-P47.2): \n → Enter keyDown/keyUp ───────────────────────────

describe("T-Type.2 (G-P47.2): \\n in text produces Enter dispatchKeyEvent between adjacent insertText calls", () => {
  it(
    "text='a\\nb': insertText('a'), Enter keyDown, Enter keyUp, insertText('b') in order",
    { timeout: 3000 },
    async () => {
      // Given: CDP-mode session with callLog; text = "a\nb" (2 printable chars + 1 newline)
      // When:  execute({ text: "a\nb", ref: "@e1" }) runs
      // Then:  (a) insertText called for "a" then "b" (2 single-char calls, in order)
      //         (b) dispatchKeyEvent called with {type:"keyDown", key:"Enter"} then
      //             {type:"keyUp", key:"Enter"} for the \n (in addition to Cmd+A+Backspace clear)
      //         (c) dispatch ORDER is: [Cmd+A↓, Cmd+A↑, Backspace↓, Backspace↑, ]
      //             insertText("a") → Enter keyDown → Enter keyUp → insertText("b")
      const session = makeFakeSession();
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "a\nb", ref: "@e1" },
        { toolCallId: "t-type2", messages: [], abortSignal },
      );
      assert.equal(result.ok, true, "T-Type.2: result.ok must be true");

      const log = session.callLog;

      // (a) insertText called for "a" then "b" (2 calls, in order)
      const insertCalls = log.filter((e) => e.startsWith("insertText:"));
      assert.equal(insertCalls.length, 2, "T-Type.2: insertText must be called 2 times ('a' and 'b')");
      assert.equal(insertCalls[0], "insertText:a", "T-Type.2: first insertText call must be 'a'");
      assert.equal(insertCalls[1], "insertText:b", "T-Type.2: second insertText call must be 'b'");

      // (b) Enter keyDown/keyUp dispatched for \\n
      const enterDowns = log.filter((e) => e === "key:keyDown:Enter:mod0");
      const enterUps = log.filter((e) => e === "key:keyUp:Enter:mod0");
      assert.equal(enterDowns.length, 1, "T-Type.2: exactly 1 Enter keyDown for the \\n");
      assert.equal(enterUps.length, 1, "T-Type.2: exactly 1 Enter keyUp for the \\n");

      // (c) ORDER: [CmdA↓ CmdA↑ Backspace↓ Backspace↑] insertText("a") → Enter↓ → Enter↑ → insertText("b")
      // [P-59 D-RUN-3] Cmd+A (mod4) + Backspace precede insertText on macOS
      const aIdx = log.indexOf("insertText:a");
      const enterDownIdx = log.indexOf("key:keyDown:Enter:mod0");
      const enterUpIdx = log.indexOf("key:keyUp:Enter:mod0");
      const bIdx = log.indexOf("insertText:b");
      const cmdADownIdx = log.indexOf("key:keyDown:a:mod4");
      const cmdAUpIdx = log.indexOf("key:keyUp:a:mod4");
      const backspaceUpIdx = log.indexOf("key:keyUp:Backspace:mod0");
      assert.ok(cmdADownIdx < cmdAUpIdx, "T-Type.2: Cmd+A keyDown before keyUp");
      assert.ok(cmdAUpIdx < backspaceUpIdx, "T-Type.2: Cmd+A before Backspace");
      assert.ok(backspaceUpIdx < aIdx, "T-Type.2: Backspace before first insertText");
      assert.ok(aIdx < enterDownIdx, "T-Type.2: insertText('a') before Enter keyDown");
      assert.ok(enterDownIdx < enterUpIdx, "T-Type.2: Enter keyDown before Enter keyUp");
      assert.ok(enterUpIdx < bIdx, "T-Type.2: Enter keyUp before insertText('b')");
    },
  );
});

// ─── T-Type.3 (G-P47.3): computeCharDelay cap / floor / jitter ───────────────

describe("T-Type.3 (G-P47.3): computeCharDelay — ~8s cap holds; 30ms floor for short/medium; jitter collapses for long text", () => {
  it("cap ≤8000ms; floor ≥30ms (short/medium); jitter varies for len≤200; jitter collapses for len≥500", async () => {
    // Given: exported pure function computeCharDelay(textLength, rand): number
    //        rand ∈ [0, 1] maps to a 0.3..1.0 multiplier; floor=min(30, budget); budget=min(8000/len, 150)
    // When:  called with textLength ∈ {1, 54, 100, 266, 300, 500, 1000, 5000} and rand=0/rand=1
    // Then:  (a) CAP: for all lengths, textLength × computeCharDelay(textLength, 1) ≤ 8001 (fp tolerance)
    //         (b) FLOOR: computeCharDelay(3, 0) ≥ 30 AND computeCharDelay(54, 0) ≥ 30
    //             (30ms floor binds when budget ≥ 30, i.e. textLength ≲ 266)
    //         (c) JITTER VARIES (short/medium): computeCharDelay(200, 0) < computeCharDelay(200, 1)
    //         (d) JITTER COLLAPSES (long): computeCharDelay(500, 0) === computeCharDelay(500, 1)
    //             AND that value < 30 (budget-aware floor: floor=budget<30 for len≥500)

    // (a) CAP: len × computeCharDelay(len, 1) ≤ 8001 (8000ms + 1ms fp tolerance)
    for (const len of [1, 54, 100, 266, 300, 500, 1000, 5000]) {
      const delay = computeCharDelay(len, 1);
      const total = len * delay;
      assert.ok(total <= 8001, `T-Type.3 CAP: len=${len}, delay=${delay}, total=${total} must be ≤8001`);
    }

    // (b) FLOOR: 30ms minimum for short/medium text (budget ≥ 30 when len ≤ ~266)
    assert.ok(computeCharDelay(3, 0) >= 30, `T-Type.3 FLOOR: len=3, rand=0 → ${computeCharDelay(3, 0)} must be ≥30`);
    assert.ok(computeCharDelay(54, 0) >= 30, `T-Type.3 FLOOR: len=54, rand=0 → ${computeCharDelay(54, 0)} must be ≥30`);

    // (c) JITTER VARIES for short/medium text (len=200: budget=40, floor=30 → rand=0→30, rand=1→40)
    const d200r0 = computeCharDelay(200, 0);
    const d200r1 = computeCharDelay(200, 1);
    assert.ok(d200r0 < d200r1, `T-Type.3 JITTER VARIES: len=200, rand=0 (${d200r0}) must be < rand=1 (${d200r1})`);

    // (d) JITTER COLLAPSES for long text (len=500: budget=16, floor=16 → same for any rand)
    const d500r0 = computeCharDelay(500, 0);
    const d500r1 = computeCharDelay(500, 1);
    assert.equal(
      d500r0,
      d500r1,
      `T-Type.3 COLLAPSES: len=500 delay must be same for rand=0 (${d500r0}) and rand=1 (${d500r1})`,
    );
    assert.ok(d500r0 < 30, `T-Type.3 COLLAPSES: collapsed delay (${d500r0}) must be < 30ms (budget-aware floor ≈ 16)`);
  });
});

// ─── T-Type.4 (G-P47.2): hardware arm unchanged ──────────────────────────────

describe("T-Type.4 (G-P47.2): hardware arm — hardwareTypeAt invoked; CDP insertText NOT called", () => {
  it(
    "when inputMode==='hardware', hardwareTypeAt is called once; insertText spy sees no calls",
    { timeout: 3000 },
    async () => {
      // Given: session with inputMode="hardware"; fake CDP callLog session
      // When:  execute({ text: "hello", ref: "@e1" }) runs
      // Then:  (a) Input.insertText is NEVER called (CDP per-char loop does not run)
      //         (b) Ctrl+A (CDP dispatchKeyEvent) is NEVER called (hardware arm bypasses CDP keyboard)
      //         (c) result.ok===false in test env (hardwareTypeAt throws: no native CGEvent addon)
      //             This PROVES the hardware branch was taken — CDP arm would return ok===true.
      //
      // NOTE: hardwareTypeAt's default parameter `cg = loadCgEvent()` throws immediately in test env
      // (no native CGEvent addon built). The throw propagates to execute's try-catch → failFromError.
      // The observable check is that CDP insertText was NEVER called — the hardware arm never
      // falls through to the CDP else-branch, regardless of whether the native call succeeds.
      const fakeSession = makeFakeSession();
      // Override inputMode to "hardware"
      const hardwareSession = { ...fakeSession, inputMode: "hardware" as const };
      await fakeSession.getClient().snapshot();
      const tool = makeTypeTool(hardwareSession);
      const result = await tool.execute(
        { text: "hello", ref: "@e1" },
        { toolCallId: "t-type4-hw", messages: [], abortSignal },
      );

      const log = fakeSession.callLog;

      // (a) CDP insertText NEVER called (hardware arm skips the CDP else-branch entirely)
      const insertCalls = log.filter((e) => e.startsWith("insertText:"));
      assert.equal(insertCalls.length, 0, "T-Type.4 hardware: CDP insertText must NOT be called");

      // (b) CDP Ctrl+A NEVER called (in hardware branch, CDP keyboard path is skipped)
      const ctrlAEvents = log.filter((e) => e.includes(":a:mod2"));
      assert.equal(ctrlAEvents.length, 0, "T-Type.4 hardware: CDP Ctrl+A must NOT be dispatched");

      // (c) result.ok===false confirms hardware branch ran (hardwareTypeAt throws in test env)
      assert.equal(
        result.ok,
        false,
        "T-Type.4 hardware: ok===false (hardwareTypeAt throws: no CGEvent native addon in test)",
      );
    },
  );
});

// ─── T-Type.5 (G-P47.2 / B-1): empty text clears the field ──────────────────

describe("T-Type.5 (G-P47.2 / B-1 regression): empty text='' uses Cmd+A+Backspace clear, no insertText", () => {
  it("Cmd+A fires; Backspace fires; NO insertText; no per-char loop; result.ok===true", { timeout: 3000 }, async () => {
    // Given: CDP-mode session; fake handle records insertText/dispatchKeyEvent; text = ""
    // When:  execute({ text: "", ref: "@e1" }) runs
    //        [P-59 D-RUN-3] Cmd+A (mod4) + Backspace clears field; for empty text the
    //        per-char loop (text.length===0) does NOT run so NO insertText is called
    // Then:  (a) dispatchKeyEvent Cmd+A pair fires: key:"a", modifiers:4 keyDown + keyUp
    //             (macOS select-all — selects existing content)
    //         (b) dispatchKeyEvent Backspace fires: keyDown + keyUp
    //             (deletes the Cmd+A selection — this is what CLEARS the field)
    //         (c) NO insertText calls at all (per-char loop body does NOT run for len=0)
    //         (d) NO Enter dispatchKeyEvent (no \n in empty string)
    //         (e) result.ok === true (clear is not an error)
    const session = makeFakeSession();
    await session.getClient().snapshot();
    const tool = makeTypeTool(session);
    const result = await tool.execute(
      { text: "", ref: "@e1" },
      { toolCallId: "t-type5-b1", messages: [], abortSignal },
    );

    // (e) result.ok === true
    assert.equal(result.ok, true, "T-Type.5 B-1: result.ok must be true (clear is valid)");

    const log = session.callLog;

    // (a) Cmd+A pair fires (macOS select-all, modifiers:4)
    const cmdADown = log.filter((e) => e === "key:keyDown:a:mod4");
    const cmdAUp = log.filter((e) => e === "key:keyUp:a:mod4");
    assert.equal(cmdADown.length, 1, "T-Type.5 B-1: Cmd+A keyDown must fire (macOS mod4)");
    assert.equal(cmdAUp.length, 1, "T-Type.5 B-1: Cmd+A keyUp must fire");

    // (b) Backspace fires (deletes Cmd+A selection)
    const bsDown = log.filter((e) => e === "key:keyDown:Backspace:mod0");
    const bsUp = log.filter((e) => e === "key:keyUp:Backspace:mod0");
    assert.equal(bsDown.length, 1, "T-Type.5 B-1: Backspace keyDown must fire");
    assert.equal(bsUp.length, 1, "T-Type.5 B-1: Backspace keyUp must fire");

    // (c) NO insertText calls (per-char loop does not run for empty text)
    const insertCalls = log.filter((e) => e.startsWith("insertText:"));
    assert.equal(insertCalls.length, 0, "T-Type.5 B-1: insertText must NOT be called for empty text");

    // (d) NO Enter key events (no \\n in empty string)
    const enterEvents = log.filter((e) => e.includes(":Enter:"));
    assert.equal(enterEvents.length, 0, "T-Type.5 B-1: no Enter key events for empty text");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

// ─── T-P74.Clear.1 — React-safe-clear SUCCESS branch (D-RUN-3 regression guard) ──

describe("T-P74.Clear.1 (D-RUN-3): React-safe-clear succeeds → Cmd+A+Backspace NOT dispatched", () => {
  it(
    "when evaluate(REACT_SAFE_CLEAR_ACTIVE_INPUT_JS) returns true, type skips the Cmd+A+Backspace fallback and still inserts per-char",
    { timeout: 5000 },
    async () => {
      // Given: a CDP-mode session whose Runtime.evaluate returns true for the REACT_SAFE_CLEAR JS
      //        (simulating a native input that accepted the native value-setter + InputEvent clear);
      //        callLog records dispatchKeyEvent + insertText; text = "hi"; ref = "@e1".
      // When:  the type tool executes.
      // Then:  NO Cmd+A (key:keyDown:a:mod4) and NO Backspace events in callLog (React-safe early-return);
      //        per-char insertText fires ("h", "i"); result.ok === true.
      const callLog: string[] = [];
      const evaluateCallLog: string[] = [];
      const FAKE_BORDER = [0, 0, 10, 0, 10, 10, 0, 10];

      const fakeHandle = {
        Accessibility: {
          enable: async () => {},
          getFullAXTree: async () => ({
            nodes: [
              {
                nodeId: "ax1",
                role: { type: "role", value: "textbox" },
                name: { type: "string", value: "Message" },
                backendDOMNodeId: 55,
              },
            ],
          }),
        },
        Runtime: {
          evaluate: async (args: { expression: string }) => {
            evaluateCallLog.push(args.expression.slice(0, 50));
            // React-safe clear JS contains 'deleteContentBackward' — return true
            if (args.expression.includes("deleteContentBackward")) {
              return { result: { value: true } };
            }
            return { result: { value: null } };
          },
        },
        DOM: {
          getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
          querySelectorAll: async (_args: unknown) => ({ nodeIds: [] }),
          scrollIntoViewIfNeeded: async (_arg: unknown) => {},
          getBoxModel: async (_args: unknown) => ({ model: { border: FAKE_BORDER } }),
        },
        Input: {
          dispatchMouseEvent: async (args: { type: string }) => {
            callLog.push(`mouse:${args.type}`);
          },
          dispatchKeyEvent: async (args: { type: string; key: string; modifiers?: number }) => {
            callLog.push(`key:${args.type}:${args.key}:mod${args.modifiers ?? 0}`);
          },
          insertText: async (args: { text: string }) => {
            callLog.push(`insertText:${args.text}`);
          },
        },
      };

      const { CdpClient } = await import("../../../src/cdp/client.js");
      const client = CdpClient.fromHandle(fakeHandle);
      const session = {
        inputMode: "cdp" as const,
        getOrInitClient: () => Promise.resolve({ ok: true as const, client }),
        getClient: () => client,
        setLastContext: (_ctx: unknown) => {},
        getLastContext: () =>
          ({
            pageUrl: "https://www.linkedin.com/feed/",
            surface: "feed",
            activeLayer: "page",
            entries: [{ ref: "@e1", role: "textbox", name: "Message" }],
          }) as never,
      };

      await session.getClient().snapshot(); // populate refMap with @e1
      const { makeTypeTool } = await import("../../../src/tools/browser/type.js");
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hi", ref: "@e1" },
        { toolCallId: "t-p74-clear1", messages: [], abortSignal },
      );

      assert.equal(result.ok, true, "T-P74.Clear.1: result.ok must be true");

      // React-safe SUCCESS: NO Cmd+A (mod4) and NO Backspace dispatched
      const cmdAEvents = callLog.filter((e) => e.includes(":a:mod4"));
      assert.equal(
        cmdAEvents.length,
        0,
        `T-P74.Clear.1: Cmd+A (mod4) must NOT be dispatched when React-safe clear succeeds; got: ${cmdAEvents.join(", ")}`,
      );
      const backspaceEvents = callLog.filter((e) => e.includes(":Backspace:"));
      assert.equal(
        backspaceEvents.length,
        0,
        `T-P74.Clear.1: Backspace must NOT be dispatched when React-safe clear succeeds; got: ${backspaceEvents.join(", ")}`,
      );

      // Per-char insertText still fires ("h", "i")
      const insertCalls = callLog.filter((e) => e.startsWith("insertText:"));
      assert.equal(
        insertCalls.length,
        2,
        `T-P74.Clear.1: insertText must fire 2× for 'hi'; got: ${insertCalls.join(", ")}`,
      );
      assert.equal(insertCalls[0], "insertText:h", "T-P74.Clear.1: first char must be 'h'");
      assert.equal(insertCalls[1], "insertText:i", "T-P74.Clear.1: second char must be 'i'");
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────

test("T-M67: type tool execute without ref or label returns fail envelope", { timeout: 3000 }, async () => {
  const session = makeFakeSession();
  const tool = makeTypeTool(session);

  // The type tool source throws when neither ref nor label is provided.
  const result = await tool.execute(
    // biome-ignore lint/suspicious/noExplicitAny: intentional bad input for test
    { text: "hello" } as any,
    { toolCallId: "t2", messages: [], abortSignal },
  );

  assert.equal(result.ok, false, "type without ref or label must fail");
  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const error = (result as any).error;
  assert.ok(
    error.kind === "invalid_input" || error.kind === "runtime_error",
    "error kind must be invalid_input or runtime_error",
  );
});

// ─── T-D11.R3: Connect-modal text-fidelity guard ───────────────────────────────
// [P-75 D-11 round 3] Brand-safety regression: type into a Connect-invite modal MUST
// match the most-recent saved connect_note draft for the lead currently on screen.
// Replaces R2's modal-block guard (which forced the now-removed linkedin_connect
// primitive). Closes the Linfeng-rewrite hazard: agent paraphrased the operator-vetted
// "Hi Linfeng — your blend of a PhD..." into "Hi Linfeng — PhD from HKUST + ...
// impressive combo" on the way to send. Now: typed text must equal draft text exactly.

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { insertDraft, insertLead, upsertRawCandidate } from "../../../src/persistence/salesDb.js";
import { getSalesDb } from "../../../src/tools/sales/_dbHandle.js";
import { cleanupTmpDir } from "../../_helpers/tmp";

/** Build a fake session whose lastContext.pageUrl is a real /in/<slug>/ profile. */
function makeFakeSessionOnProfile(slug: string, entries: Array<{ ref: string; role: string; name: string }>) {
  const base = makeFakeSessionWithEntries(entries);
  return {
    ...base,
    getLastContext: () =>
      ({
        pageUrl: `https://www.linkedin.com/in/${slug}/`,
        surface: "profile",
        activeLayer: "page",
        entries,
      }) as CurrentSurfaceContext,
  };
}

function makeFakeSessionOnSurface(
  surface: CurrentSurfaceContext["surface"],
  pageUrl: string,
  entries: Array<{ ref: string; role: string; name: string }>,
) {
  const base = makeFakeSessionWithEntries(entries);
  return {
    ...base,
    getLastContext: () =>
      ({
        pageUrl,
        surface,
        activeLayer: "page",
        entries,
      }) as CurrentSurfaceContext,
  };
}

/** Seed a temp sales.sqlite under MAI_HOME_BASE/<tmp>/.mai/agent/ with one candidate→lead→draft chain. */
function seedSalesDb(slug: string, draftText: string): string {
  const home = mkdtempSync(pathJoin(tmpdir(), "d11r3-"));
  process.env.FRONDOSE_HOME_BASE = home;
  const dbPath = pathJoin(home, ".frondose", "agent", "sales.sqlite");
  // getSalesDb takes care of mkdir + schema init on first open.
  const db = getSalesDb(dbPath);
  const profileUrl = `https://www.linkedin.com/in/${slug}/`;
  const { candidateId } = upsertRawCandidate(db, {
    personName: "Test Lead",
    profileUrl,
    source: "search",
  });
  const leadId = insertLead(db, {
    candidateId,
    personName: "Test Lead",
    profileUrl,
    stage: "qualified",
    ownerMode: "manual",
  });
  insertDraft(db, { leadId, kind: "connect_note", text: draftText, createdBy: "user" });
  return home;
}

describe("T-D11.R3 (D-11 round 3): Connect-modal text-fidelity guard", () => {
  // 3rd-degree modal layout: direct note-entry view with textarea + Send invitation visible.
  // Observed live for Linfeng (2026-06-07) + standard for 3rd-deg targets.
  const modalEntries = [
    { ref: "@e1", role: "heading", name: "Add a note to your invitation" },
    { ref: "@e2", role: "textbox", name: "Message" },
    { ref: "@e3", role: "button", name: "Cancel adding a note" },
    { ref: "@e4", role: "button", name: "Send invitation" },
  ];

  // 2nd-degree modal layout: confirmation question with the same labels but a "?" in the heading.
  // Observed live for Dmitry Balanovsky (2026-06-08) + Hootan Farhat (2026-05-25).
  // Same affordance set (textbox + Send invitation) — the heading question mark is the only
  // surface-level difference, so the type-fidelity guard MUST treat them identically.
  // [P-D11-R4 2026-06-08] Snapshot-capture WAS observed to NOT surface the 2nd-deg dialog's
  // inner buttons in some cases (separate snapshotCapture bug — tracked in audit-followup).
  // This test verifies that WHEN the entries ARE captured correctly, the fidelity guard works.
  const modalEntries2nd = [
    { ref: "@e1", role: "heading", name: "Add a note to your invitation?" },
    { ref: "@e2", role: "textbox", name: "Message" },
    { ref: "@e3", role: "button", name: "Cancel adding a note" },
    { ref: "@e4", role: "button", name: "Send invitation" },
  ];

  const messageComposerEntries = [
    { ref: "@e1", role: "textbox", name: "Write a message…" },
    { ref: "@e2", role: "button", name: "Send" },
  ];

  it("T-MsgType.1: messaging-thread composer matching Connect-modal affordances is allowed", async () => {
    // Given: messaging-thread lastContext has "Write a message…" + "Send", and no connect_note draft.
    // When:  type({ ref, text }) runs against the composer textbox.
    // Then:  the Connect-invite guard does not refuse; typing proceeds to CDP insertText.
    const home = mkdtempSync(pathJoin(tmpdir(), "msgtype-thread-"));
    process.env.FRONDOSE_HOME_BASE = home;
    try {
      const session = makeFakeSessionOnSurface(
        "messaging-thread",
        "https://www.linkedin.com/messaging/thread/urn:li:fsd_profile:test-thread/",
        messageComposerEntries,
      );
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "Thanks for the note.", ref: "@e1" },
        { toolCallId: "t-msgtype-thread", messages: [], abortSignal },
      );

      assert.equal(result.ok, true, "messaging-thread composer type must not be blocked by the Connect guard");
      assert.ok(
        session.callLog.some((c) => c.startsWith("insertText:")),
        "type must proceed to CDP insertText on a message composer",
      );
    } finally {
      delete process.env.FRONDOSE_HOME_BASE;
      if (existsSync(home)) cleanupTmpDir(home);
    }
  });

  it("T-MsgType.2: profile custom-invite affordances still refuse without a saved connect_note draft", async () => {
    // Given: profile/preload-custom-invite lastContext has the same note-affordance + Send shape, and no draft.
    // When:  type({ ref, text }) runs against the note textbox.
    // Then:  the Connect-invite guard still refuses before any CDP insertText.
    const home = mkdtempSync(pathJoin(tmpdir(), "msgtype-profile-"));
    process.env.FRONDOSE_HOME_BASE = home;
    try {
      const session = makeFakeSessionOnSurface(
        "profile",
        "https://www.linkedin.com/preload/custom-invite/?vanityName=msgtype-no-draft",
        messageComposerEntries,
      );
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "Anything", ref: "@e1" },
        { toolCallId: "t-msgtype-profile", messages: [], abortSignal },
      );

      assert.equal(result.ok, false, "profile custom-invite type without draft must be blocked");
      // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
      const err = (result as any).error;
      assert.equal(err.kind, "invalid_input");
      assert.match(err.message, /Refusing to type into a Connect-invite modal: no saved connect_note draft/);
      assert.equal(session.callLog.filter((c) => c.startsWith("insertText:")).length, 0, "no insertText fired");
    } finally {
      delete process.env.FRONDOSE_HOME_BASE;
      if (existsSync(home)) cleanupTmpDir(home);
    }
  });

  // Given: Connect modal is open AND a draft exists for this lead AND typed text MATCHES the draft
  // When:  agent calls type with the exact draft text
  // Then:  guard passes — type proceeds, insertText fires per-char
  it("PASSES when typed text exactly matches saved connect_note draft for the lead", async () => {
    const slug = "test-lead-match";
    const approved = "Hi Test — the exact operator-approved note. No paraphrasing here.";
    const home = seedSalesDb(slug, approved);
    try {
      const session = makeFakeSessionOnProfile(slug, modalEntries);
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: approved, ref: "@e2" },
        { toolCallId: "tg-match", messages: [], abortSignal },
      );
      assert.equal(result.ok, true, "exact match must pass");
      assert.ok(
        session.callLog.some((c) => c.startsWith("insertText:")),
        "insertText fired",
      );
    } finally {
      delete process.env.FRONDOSE_HOME_BASE;
      if (existsSync(home)) cleanupTmpDir(home);
    }
  });

  // Given: Connect modal + a draft exists + typed text is REWRITTEN (the Linfeng hazard)
  // When:  agent calls type with paraphrased text
  // Then:  guard rejects — error message names "rewritten", lists expected vs got, no CDP dispatch
  it("REJECTS when typed text is paraphrased / rewritten vs the saved draft", async () => {
    const slug = "test-lead-rewrite";
    const approved = "Hi Linfeng — your blend of a PhD with hardware engineering is genuinely intriguing.";
    const home = seedSalesDb(slug, approved);
    try {
      const session = makeFakeSessionOnProfile(slug, modalEntries);
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "Hi Linfeng — PhD + hardware engineering, impressive combo.", ref: "@e2" },
        { toolCallId: "tg-rewrite", messages: [], abortSignal },
      );
      assert.equal(result.ok, false, "rewritten text MUST be rejected");
      // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
      const err = (result as any).error;
      assert.equal(err.kind, "invalid_input");
      assert.ok(/rewritten|Expected|saved draft/i.test(err.message), "error mentions fidelity violation");
      assert.equal(session.callLog.filter((c) => c.startsWith("insertText:")).length, 0, "no insertText fired");
    } finally {
      delete process.env.FRONDOSE_HOME_BASE;
      if (existsSync(home)) cleanupTmpDir(home);
    }
  });

  // Given: Connect modal + NO saved draft for this lead (agent skipped save_message_draft)
  // When:  agent calls type with any text
  // Then:  guard rejects with "no saved connect_note draft found" — defensive default
  it("REJECTS when no saved draft exists for the lead (no approval trail)", async () => {
    // No seedSalesDb — DB lookup returns null
    const home = mkdtempSync(pathJoin(tmpdir(), "d11r3-nodraft-"));
    process.env.FRONDOSE_HOME_BASE = home;
    try {
      const session = makeFakeSessionOnProfile("no-draft-lead", modalEntries);
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "anything", ref: "@e2" },
        { toolCallId: "tg-nodraft", messages: [], abortSignal },
      );
      assert.equal(result.ok, false);
      // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
      const err = (result as any).error;
      assert.ok(/no saved.*draft|save_message_draft/i.test(err.message), "error directs to save_message_draft first");
    } finally {
      delete process.env.FRONDOSE_HOME_BASE;
      if (existsSync(home)) cleanupTmpDir(home);
    }
  });

  // Given: Connect modal IS open AND page is on the custom-invite preload URL
  //        (linkedin.com/preload/custom-invite/?vanityName=<slug>) — agent's modal-open shortcut.
  //        Draft exists for the lead matching vanityName + typed text matches the draft.
  // When:  agent calls type with the exact draft text
  // Then:  guard finds the lead via vanityName slug → exact match → PASSES.
  //        Regression test for the Hung-I Lin 2026-06-08 false-reject: agent navigates via
  //        /preload/custom-invite/?vanityName=<slug>, original guard only handled /in/<slug>/.
  it("PASSES when on /preload/custom-invite/?vanityName=<slug> + text matches saved draft", async () => {
    const slug = "test-lead-vanityname";
    const approved = "Hi Test — exact approved note for the vanityName URL path.";
    const home = seedSalesDb(slug, approved);
    try {
      const baseSession = makeFakeSessionWithEntries(modalEntries);
      const session = {
        ...baseSession,
        getLastContext: () =>
          ({
            pageUrl: `https://www.linkedin.com/preload/custom-invite/?vanityName=${slug}`,
            surface: "profile",
            activeLayer: "page",
            entries: modalEntries,
          }) as CurrentSurfaceContext,
      };
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: approved, ref: "@e2" },
        { toolCallId: "tg-vn", messages: [], abortSignal },
      );
      assert.equal(result.ok, true, "vanityName preload URL must resolve the lead and pass on exact match");
    } finally {
      delete process.env.FRONDOSE_HOME_BASE;
      if (existsSync(home)) cleanupTmpDir(home);
    }
  });

  // Given: NOT a Connect modal (normal feed search-box context)
  // When:  agent calls type with arbitrary text
  // Then:  guard doesn't fire — no DB lookup, no rejection (zero overhead on hot path)
  it("does NOT fire on normal feed / search-box context (no false positives)", async () => {
    const session = makeFakeSessionWithEntries([
      { ref: "@e1", role: "textbox", name: "Search" },
      { ref: "@e2", role: "button", name: "Send message" }, // not a Send-invite label — modal check fails fast
    ]);
    await session.getClient().snapshot();
    const tool = makeTypeTool(session);
    const result = await tool.execute(
      { text: "founders new york", ref: "@e1" },
      { toolCallId: "tg-noop", messages: [], abortSignal },
    );
    assert.equal(result.ok, true, "feed search-box type must succeed");
    assert.ok(
      session.callLog.some((c) => c.startsWith("insertText:")),
      "insertText fired",
    );
  });

  // [P-D11-R4 — 2nd-degree modal variant coverage]
  // Given: 2nd-degree modal entries (heading with "?" — "Add a note to your invitation?") AND
  //        a draft exists for this lead AND typed text MATCHES the draft.
  // When:  agent calls type with the exact draft text on a 2nd-deg target's profile.
  // Then:  guard PASSES — the question-mark heading variant is detected as a Connect modal
  //        same as 3rd-deg (heading text isn't part of the predicate), fidelity check passes.
  it("PASSES on 2nd-degree modal variant when typed text matches saved draft", async () => {
    const slug = "test-lead-2nd-deg";
    const approved = "Hi 2nd-deg target — exact approved note for the confirmation variant.";
    const home = seedSalesDb(slug, approved);
    try {
      const session = makeFakeSessionOnProfile(slug, modalEntries2nd);
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: approved, ref: "@e2" },
        { toolCallId: "tg-2nd-match", messages: [], abortSignal },
      );
      assert.equal(result.ok, true, "2nd-deg exact match must pass — modal-detection vocabulary is variant-agnostic");
      assert.ok(
        session.callLog.some((c) => c.startsWith("insertText:")),
        "insertText fired",
      );
    } finally {
      delete process.env.FRONDOSE_HOME_BASE;
      if (existsSync(home)) cleanupTmpDir(home);
    }
  });

  // Given: 2nd-degree modal + a draft exists + typed text is REWRITTEN
  // When:  agent calls type with paraphrased text on a 2nd-deg target
  // Then:  guard rejects — same Linfeng-class brand-safety check fires regardless of variant
  it("REJECTS rewritten text on 2nd-degree modal variant (same brand-safety contract)", async () => {
    const slug = "test-lead-2nd-deg-rewrite";
    const approved = "Hi target — your work on photonics caught my attention. Would love to connect.";
    const home = seedSalesDb(slug, approved);
    try {
      const session = makeFakeSessionOnProfile(slug, modalEntries2nd);
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "Hi target — photonics is interesting; let's connect.", ref: "@e2" },
        { toolCallId: "tg-2nd-rewrite", messages: [], abortSignal },
      );
      assert.equal(result.ok, false, "2nd-deg rewritten text MUST be rejected");
      // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
      const err = (result as any).error;
      assert.equal(err.kind, "invalid_input");
      assert.equal(session.callLog.filter((c) => c.startsWith("insertText:")).length, 0);
    } finally {
      delete process.env.FRONDOSE_HOME_BASE;
      if (existsSync(home)) cleanupTmpDir(home);
    }
  });

  // ── P-POST-PUBLISHFIX gate tests ──────────────────────────────────────────────
  //
  // Coverage notes for T-PFix.2 / T-PFix.3:
  //   The existing tests "REJECTS when no saved draft exists for the lead (no approval trail)"
  //   (line ~897) and "PASSES when typed text exactly matches saved connect_note draft for the
  //   lead" (line ~845) plus "PASSES on 2nd-degree modal variant …" (line ~981) ARE the
  //   coverage of record for T-PFix.2 and T-PFix.3 (profile-surface preserved behavior).
  //   No duplicate copies are added here per CLAUDE.md §1 Simplicity First + plan §6 note.
  //   Those tests must continue to pass after the gate substitution in Step 4 — if they
  //   regress, the fix over-narrowed the guard. (profileSlugFromUrl is non-null on /in/<slug>/
  //   URLs so the new gate fires identically on profile surfaces — preserving those tests.)
  //
  // Coverage note for T-PFix.5 (messaging-thread subsumed):
  //   The existing "T-MsgType.1: messaging-thread composer matching Connect-modal affordances
  //   is allowed" test (line ~782) IS the regression record. Under the new gate,
  //   profileSlugFromUrl("https://www.linkedin.com/messaging/thread/…") returns null, so the
  //   guard does not fire — identical outcome to the old surface !== "messaging-thread" carve-out.
  //   That test must continue to pass (subsumed, not broken) and is the coverage of record for
  //   T-PFix.5. No new copy is added; the new T-PFix.5 it() below is an EXPLICIT additional
  //   confirmation using the messaging-thread surface with full modal-shaped entries (the
  //   strongest possible inConnectModal-tripping set), to make the subsumption claim visible.

  // T-PFix.1 [G-PFix.1 — THE FIX, load-bearing]:
  // feed surface + post-composer entries that trip inConnectModal → guard does NOT fire → type proceeds.
  //
  // This is the core regression guard for P-POST-PUBLISHFIX.
  // FAILS pre-Step-4 (OLD gate: surface !== "messaging-thread" fires on "feed" → refusal).
  // PASSES post-Step-4 (NEW gate: profileSlugFromUrl("…/feed/") === null → guard skipped).
  //
  // Text fixture is intentionally short ("Hi") — the load-bearing assertion is that the guard
  // does NOT fire (guard check is URL-based and fires before any typing), not that a long
  // post is typed. A 50+ char fixture at computeCharDelay budget (~143ms/char) takes >8s,
  // exceeding the test timeout; a 2-char fixture exercises the SAME guard path in <300ms.
  it(
    "T-PFix.1: feed surface + inConnectModal-tripping entries → guard does NOT fire → type proceeds (THE FIX)",
    { timeout: 5000 },
    async () => {
      // Given: pageUrl="https://www.linkedin.com/feed/", surface="feed"; entries include
      //        a "Send" button (trips SEND_BTN_RE) and a "Message" textbox (trips NOTE_FIELD_RE)
      //        — the exact false-positive composition documented in intake §2 defect 1.
      //        No draft seeded (any DB lookup on the feed URL returns null regardless —
      //        but with the fix the guard must not even reach the DB lookup).
      //        FRONDOSE_HOME_BASE is set to a fresh empty tmpdir so any accidental DB lookup
      //        would return null and cause a refusal — making the test correctly red pre-fix.
      // When:  type({ ref: "@e1", text: "Hi" }) — short text keeps wall-time <300ms so the
      //        5s test timeout is never at risk; the guard fires (or not) before any character
      //        is dispatched, so text length is irrelevant to the load-bearing assertion.
      // Then:  result.ok === true; session.callLog contains insertText: calls (per-char path ran);
      //        the "Refusing to type into a Connect-invite modal" message does NOT appear.
      const feedComposerEntries = [
        // "Message" textbox → matches NOTE_FIELD_RE (/message/i) → note affordance present
        { ref: "@e1", role: "textbox", name: "Message" },
        // bare "Send" button → matches SEND_BTN_RE (/^send\s*$/i) → send button present
        // Together with the textbox above, inConnectModal() returns true.
        { ref: "@e2", role: "button", name: "Send" },
      ];
      const home = mkdtempSync(pathJoin(tmpdir(), "pfix1-feed-"));
      process.env.FRONDOSE_HOME_BASE = home;
      try {
        const session = makeFakeSessionOnSurface("feed", "https://www.linkedin.com/feed/", feedComposerEntries);
        await session.getClient().snapshot();
        const tool = makeTypeTool(session);
        const result = await tool.execute(
          {
            ref: "@e1",
            text: "Hi",
          },
          { toolCallId: "t-pfix1-feed", messages: [], abortSignal },
        );

        // Post-fix assertion (FAILS pre-Step-4 because the OLD gate fires on feed):
        assert.equal(
          result.ok,
          true,
          "T-PFix.1: feed type must NOT be blocked by the Connect-invite guard — " +
            "profileSlugFromUrl('/feed/') === null so the new gate must not fire",
        );
        assert.ok(
          session.callLog.some((c) => c.startsWith("insertText:")),
          "T-PFix.1: insertText must fire (per-char path ran)",
        );
        assert.ok(
          !(result as any).error?.message?.includes("Refusing to type into a Connect-invite modal"),
          "T-PFix.1: the Connect-invite guard refusal message must NOT appear",
        );
      } finally {
        delete process.env.FRONDOSE_HOME_BASE;
        if (existsSync(home)) cleanupTmpDir(home);
      }
    },
  );

  // T-PFix.4v1 [G-PFix.4 — custom-invite preserved, no-regression guard]:
  // /preload/custom-invite/?vanityName=<slug> + connect-modal entries + NO draft →
  // guard STILL fires (profileSlugFromUrl is non-null on this URL) → refusal preserved.
  //
  // This confirms the new gate does NOT accidentally exclude the custom-invite surface.
  // Should PASS both pre- and post-Step-4 (the old gate also fires here; new gate matches).
  it(
    "T-PFix.4v1: /preload/custom-invite/?vanityName=<slug> + connect-modal entries + no draft → guard still refuses (custom-invite preserved)",
    { timeout: 5000 },
    async () => {
      // Given: pageUrl="https://www.linkedin.com/preload/custom-invite/?vanityName=pfix4-slug",
      //        surface="profile"; entries are the canonical 3rd-deg connect-modal shape.
      //        No draft seeded → latestDraftTextForCurrentLead returns null.
      // When:  type({ ref: "@e2", text: "any text" }) called.
      // Then:  result.ok === false; error.kind === "invalid_input";
      //        error.message matches /Refusing to type into a Connect-invite modal: no saved connect_note draft/
      //        (guard fires because profileSlugFromUrl("…/preload/custom-invite/?vanityName=pfix4-slug")
      //         returns "pfix4-slug" — non-null — so the new gate IS true on custom-invite).
      const home = mkdtempSync(pathJoin(tmpdir(), "pfix4-ci-"));
      process.env.FRONDOSE_HOME_BASE = home;
      try {
        const session = makeFakeSessionOnSurface(
          "profile",
          "https://www.linkedin.com/preload/custom-invite/?vanityName=pfix4-slug",
          modalEntries,
        );
        const tool = makeTypeTool(session);
        const result = await tool.execute(
          { ref: "@e2", text: "Any text — no draft exists so this must be refused." },
          { toolCallId: "t-pfix4v1-ci", messages: [], abortSignal },
        );

        assert.equal(
          result.ok,
          false,
          "T-PFix.4v1: custom-invite type without a draft must still be blocked — " +
            "profileSlugFromUrl is non-null on /preload/custom-invite/ so the guard fires",
        );
        // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
        const err = (result as any).error;
        assert.equal(err.kind, "invalid_input", "T-PFix.4v1: error.kind must be invalid_input");
        assert.match(
          err.message,
          /Refusing to type into a Connect-invite modal: no saved connect_note draft/,
          "T-PFix.4v1: error.message must name the no-draft refusal",
        );
        assert.equal(
          session.callLog.filter((c) => c.startsWith("insertText:")).length,
          0,
          "T-PFix.4v1: no insertText must fire on a refused type",
        );
      } finally {
        delete process.env.FRONDOSE_HOME_BASE;
        if (existsSync(home)) cleanupTmpDir(home);
      }
    },
  );

  // T-PFix.5 [G-PFix.5 — messaging-thread subsumption, explicit confirmation]:
  // messaging-thread surface + FULL connect-modal entries (the strongest inConnectModal-tripping
  // set) → guard does NOT fire under the new gate (subsumed).
  //
  // Should PASS both pre- and post-Step-4.
  // The existing T-MsgType.1 is the coverage of record; this test uses modalEntries (the full
  // 3rd-deg modal shape) rather than messageComposerEntries to make the subsumption
  // claim explicit: even with a canonical Connect-modal AX tree, the URL gate short-circuits.
  it(
    "T-PFix.5: messaging-thread + full Connect-modal entries → guard does NOT fire (subsumed by URL gate)",
    { timeout: 5000 },
    async () => {
      // Given: pageUrl="https://www.linkedin.com/messaging/thread/urn:li:fsd_profile:test-id/",
      //        surface="messaging-thread"; entries are the canonical 3rd-deg connect-modal shape
      //        (heading "Add a note to your invitation" + "Message" textbox + "Send invitation" button)
      //        — inConnectModal() returns true on these entries.
      //        No draft seeded. Under the NEW gate: profileSlugFromUrl(messagingThreadUrl) === null
      //        → the guard block is skipped entirely → type proceeds.
      //        Under the OLD gate: surface !== "messaging-thread" === false → also skipped.
      //        Both gates produce the same outcome here; this test is a no-regression guard.
      // When:  type({ ref: "@e2", text: "Thanks for the note." }) called.
      // Then:  result.ok === true; insertText fires.
      const home = mkdtempSync(pathJoin(tmpdir(), "pfix5-msg-"));
      process.env.FRONDOSE_HOME_BASE = home;
      try {
        const session = makeFakeSessionOnSurface(
          "messaging-thread",
          "https://www.linkedin.com/messaging/thread/urn:li:fsd_profile:test-id/",
          modalEntries,
        );
        await session.getClient().snapshot();
        const tool = makeTypeTool(session);
        const result = await tool.execute(
          { ref: "@e2", text: "Thanks for the note." },
          { toolCallId: "t-pfix5-msg", messages: [], abortSignal },
        );

        assert.equal(
          result.ok,
          true,
          "T-PFix.5: messaging-thread type must not be blocked even with full Connect-modal entries — " +
            "profileSlugFromUrl(messagingThreadUrl) === null subsumes the old surface carve-out",
        );
        assert.ok(
          session.callLog.some((c) => c.startsWith("insertText:")),
          "T-PFix.5: insertText must fire (type proceeded)",
        );
      } finally {
        delete process.env.FRONDOSE_HOME_BASE;
        if (existsSync(home)) cleanupTmpDir(home);
      }
    },
  );
});
