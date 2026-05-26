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
process.env.MAI_PACE_MIN_MS = "0";

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
  // Given: session context with 2 textbox entries [{ ref: "@e1", role: "textbox", name: "Write a message…" },
  //          { ref: "@e2", role: "textbox", name: "Recipient" }] under scope "threadInput"
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
      //         (c) dispatch ORDER is: [Cmd+A↓, Cmd+A↑, Backspace↓, Backspace↑,]
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
    //        rand ∈ [0,1] maps to a 0.3..1.0 multiplier; floor=min(30,budget); budget=min(8000/len,150)
    // When:  called with textLength ∈ {1,54,100,266,300,500,1000,5000} and rand=0/rand=1
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
    assert.ok(computeCharDelay(3, 0) >= 30, `T-Type.3 FLOOR: len=3,rand=0 → ${computeCharDelay(3, 0)} must be ≥30`);
    assert.ok(computeCharDelay(54, 0) >= 30, `T-Type.3 FLOOR: len=54,rand=0 → ${computeCharDelay(54, 0)} must be ≥30`);

    // (c) JITTER VARIES for short/medium text (len=200: budget=40,floor=30 → rand=0→30, rand=1→40)
    const d200r0 = computeCharDelay(200, 0);
    const d200r1 = computeCharDelay(200, 1);
    assert.ok(d200r0 < d200r1, `T-Type.3 JITTER VARIES: len=200, rand=0 (${d200r0}) must be < rand=1 (${d200r1})`);

    // (d) JITTER COLLAPSES for long text (len=500: budget=16,floor=16 → same for any rand)
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
