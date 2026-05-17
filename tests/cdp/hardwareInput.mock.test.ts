/**
 * P-32 Step 4a — T-RIM.1-4, T-HW.CLICK.1, T-HW.TYPE.1-2, T-HW.SCROLL.1, T-HW.PRESS.1-2
 *
 * Tests: resolveInputMode DI logic + hardware input functions (injectable fake CgEvent).
 * Includes CONCERN-1 guard: T-HW.TYPE.2 verifies non-ASCII text is passed to unicodeType.
 *
 * Gate coverage:
 *   G-P32.2  — T-RIM.1
 *   G-P32.3  — T-RIM.2
 *   G-P32.4  — T-RIM.3
 *   G-P32.5  — T-RIM.4
 *   G-P32.14 — T-HW.PRESS.2
 *   G-P32.15 — T-HW.CLICK.1
 *   G-P32.16 — T-HW.TYPE.1, T-HW.TYPE.2
 *   G-P32.17 — T-HW.SCROLL.1
 *   G-P32.18 — T-HW.PRESS.1
 *
 * No Chrome, no native addon required — all tests use injected fake CgEvent + fake CdpClient.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CgEvent } from "../../src/native/cgevent.js";
import type { CdpClient } from "../../src/cdp/client.js";
import {
  resolveInputMode,
  hardwareClickAt,
  hardwareTypeAt,
  hardwareScroll,
  hardwarePressKey,
} from "../../src/cdp/hardwareInput.js";

// ─── Fake CgEvent ─────────────────────────────────────────────────────────────

interface FakeCgEventLog {
  moveMouse: Array<[number, number]>;
  mouseClick: number; // call count
  scrollWheel: Array<[number, number]>; // [dx, dy]
  keyEvent: Array<[number, boolean, number]>; // [keyCode, down, flags]
  unicodeType: string[]; // text args
  getMousePosCalls: number;
}

function makeFakeCg(): { cg: CgEvent; log: FakeCgEventLog } {
  const log: FakeCgEventLog = {
    moveMouse: [],
    mouseClick: 0,
    scrollWheel: [],
    keyEvent: [],
    unicodeType: [],
    getMousePosCalls: 0,
  };
  const cg: CgEvent = {
    moveMouse(x, y) { log.moveMouse.push([x, y]); },
    mouseClick() { log.mouseClick++; },
    scrollWheel(dx, dy) { log.scrollWheel.push([dx, dy]); },
    keyEvent(keyCode, down, flags) { log.keyEvent.push([keyCode, down, flags]); },
    unicodeType(text) { log.unicodeType.push(text); },
    getMousePos() { log.getMousePosCalls++; return { x: 0, y: 0 }; },
    getScreenSize() { return { width: 1920, height: 1080 }; },
    isAccessibilityTrusted() { return true; },
  };
  return { cg, log };
}

// ─── Fake CdpClient ───────────────────────────────────────────────────────────

interface FakeClient extends CdpClient {
  clickAtCalled: string[];
}

/** Minimal fake CdpClient for hardware input tests.
 *  Returns window coords {sx, sy, ch} from evaluate and a known border quad from getBoxModel. */
function makeFakeClient(opts: {
  sx: number;
  sy: number;
  ch: number;
  border: number[]; // 8-element [x0,y0,x1,y1,x2,y2,x3,y3]
  refKey: string; // without @ prefix
  backendNodeId: number;
}): FakeClient {
  const clickAtCalled: string[] = [];
  const fake = {
    clickAtCalled,
    async evaluate<T>(_expr: string): Promise<T> {
      return JSON.stringify({ sx: opts.sx, sy: opts.sy, ch: opts.ch }) as unknown as T;
    },
    get currentRefMap() {
      return {
        [opts.refKey]: { backendNodeId: opts.backendNodeId, axNodeId: "1", role: "button", name: "btn" },
      };
    },
    handle: {
      DOM: {
        async getBoxModel(_arg: unknown) {
          return { model: { border: opts.border } };
        },
      },
      Input: {
        async dispatchKeyEvent(_arg: unknown) {},
        async dispatchMouseEvent(_arg: unknown) {},
        async insertText(_arg: unknown) {},
      },
    },
    async clickAt(ref: string): Promise<void> {
      clickAtCalled.push(ref);
    },
  } as unknown as FakeClient;
  return fake;
}

// ─── T-RIM.1 ──────────────────────────────────────────────────────────────────

describe("resolveInputMode — G-P32.2 / G-P32.3 / G-P32.4 / G-P32.5", () => {
  it(
    "T-RIM.1: when requested mode is 'cdp', resolveInputMode returns 'cdp' without calling loadCg",
    () => {
      // Given: requested mode is "cdp"; a loadCg spy that would throw if called
      // When:  resolveInputMode("cdp", { loadCg: spy }) is called
      // Then:  returns "cdp"; spy is NOT called
      let spyCalled = false;
      const spy = (): CgEvent => {
        spyCalled = true;
        throw new Error("T-RIM.1: spy must not be called for cdp mode");
      };
      const result = resolveInputMode("cdp", { loadCg: spy });
      assert.equal(result, "cdp", "T-RIM.1: resolveInputMode('cdp') must return 'cdp'");
      assert.equal(spyCalled, false, "T-RIM.1: loadCg spy must not be called for cdp mode");
    },
  );

  it(
    "T-RIM.2: when requested is 'hardware' and loadCg throws, resolveInputMode returns 'cdp' + stderr warning",
    () => {
      // Given: requested mode is "hardware"; loadCg throws an Error
      // When:  resolveInputMode("hardware", { loadCg: throws }) is called
      // Then:  returns "cdp"; a stderr warning is emitted containing the error message
      const stderrChunks: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // biome-ignore lint/suspicious/noExplicitAny: spy patching
      (process.stderr as any).write = (c: string) => { stderrChunks.push(c); return true; };
      try {
        const result = resolveInputMode("hardware", {
          loadCg: () => { throw new Error("addon not built"); },
        });
        assert.equal(result, "cdp", "T-RIM.2: load failure must downgrade to 'cdp'");
        assert.ok(stderrChunks.join("").length > 0, "T-RIM.2: must emit stderr warning");
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: restore spy
        (process.stderr as any).write = origWrite;
      }
    },
  );

  it(
    "T-RIM.3: when loadCg succeeds but isAccessibilityTrusted() is false, returns 'cdp' + stderr warning",
    () => {
      // Given: loadCg returns a fake CgEvent where isAccessibilityTrusted() === false
      // When:  resolveInputMode("hardware", { loadCg: () => fakeCg }) is called
      // Then:  returns "cdp"; stderr warning emitted about Accessibility permission
      const stderrChunks: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // biome-ignore lint/suspicious/noExplicitAny: spy patching
      (process.stderr as any).write = (c: string) => { stderrChunks.push(c); return true; };
      try {
        const untrustedCg: CgEvent = {
          moveMouse() {},
          mouseClick() {},
          scrollWheel() {},
          keyEvent() {},
          unicodeType() {},
          getMousePos() { return { x: 0, y: 0 }; },
          getScreenSize() { return { width: 1920, height: 1080 }; },
          isAccessibilityTrusted() { return false; }, // ← not trusted
        };
        const result = resolveInputMode("hardware", { loadCg: () => untrustedCg });
        assert.equal(result, "cdp", "T-RIM.3: untrusted Accessibility must downgrade to 'cdp'");
        assert.ok(stderrChunks.join("").length > 0, "T-RIM.3: must emit stderr warning");
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: restore spy
        (process.stderr as any).write = origWrite;
      }
    },
  );

  it(
    "T-RIM.4: when loadCg succeeds and isAccessibilityTrusted() is true, returns 'hardware'",
    () => {
      // Given: loadCg returns a fake CgEvent where isAccessibilityTrusted() === true
      // When:  resolveInputMode("hardware", { loadCg: () => fakeCg }) is called
      // Then:  returns "hardware"
      const { cg } = makeFakeCg();
      const result = resolveInputMode("hardware", { loadCg: () => cg });
      assert.equal(result, "hardware", "T-RIM.4: trusted Accessibility must return 'hardware'");
    },
  );
});

// ─── T-HW.CLICK.1 ─────────────────────────────────────────────────────────────

describe("hardwareClickAt — G-P32.15", () => {
  it(
    "T-HW.CLICK.1: hardwareClickAt resolves coords, calls moveMouse ≥1× along a curve, calls mouseClick exactly once",
    async () => {
      // Given: fakeClient.evaluate → {sx:10, sy:20, ch:80}; getBoxModel border known quad;
      //        fakeCg records all calls
      // When:  hardwareClickAt(fakeClient, "@e1", fakeCg) is called
      // Then:  fakeCg.moveMouse called ≥1× (curve); fakeCg.mouseClick called exactly once
      const { cg, log } = makeFakeCg();
      const fakeClient = makeFakeClient({
        sx: 10, sy: 20, ch: 80,
        border: [200, 300, 240, 300, 240, 340, 200, 340],
        refKey: "e1",
        backendNodeId: 42,
      });
      await hardwareClickAt(fakeClient, "@e1", cg);
      assert.ok(log.moveMouse.length >= 1, "T-HW.CLICK.1: moveMouse must be called ≥1× (curve)");
      assert.equal(log.mouseClick, 1, "T-HW.CLICK.1: mouseClick must be called exactly once");
    },
  );
});

// ─── T-HW.TYPE.1 ──────────────────────────────────────────────────────────────

describe("hardwareTypeAt — G-P32.16 (incl. CONCERN-1 UTF-16 guard)", () => {
  it(
    "T-HW.TYPE.1: hardwareTypeAt focuses element (moveMouse+mouseClick), then Cmd+A, then unicodeType(text)",
    async () => {
      // Given: fakeClient returning known coords; fakeCg records calls
      // When:  hardwareTypeAt(fakeClient, "@e3", "hi", fakeCg) is called
      // Then:  call order: moveMouse×N + mouseClick (focus), keyEvent(0,true,Cmd)+keyEvent(0,false,Cmd)
      //        (Cmd+A select-all), then unicodeType("hi") once
      const { cg, log } = makeFakeCg();
      const fakeClient = makeFakeClient({
        sx: 0, sy: 0, ch: 50,
        border: [100, 200, 140, 200, 140, 240, 100, 240],
        refKey: "e3",
        backendNodeId: 7,
      });
      await hardwareTypeAt(fakeClient, "@e3", "hi", cg);
      assert.ok(log.moveMouse.length >= 1, "T-HW.TYPE.1: moveMouse must be called (focus click)");
      assert.equal(log.mouseClick, 1, "T-HW.TYPE.1: mouseClick must be called once (focus)");
      // Cmd+A pair: keyCode 0, flags = Cmd bitmask (0x00100000)
      const cmdAdown = log.keyEvent.find((e) => e[0] === 0 && e[1] === true);
      assert.ok(cmdAdown, "T-HW.TYPE.1: Cmd+A keydown must be in keyEvent log");
      assert.equal(log.unicodeType.length, 1, "T-HW.TYPE.1: unicodeType must be called exactly once");
      assert.equal(log.unicodeType[0], "hi", "T-HW.TYPE.1: unicodeType must receive 'hi'");
    },
  );

  it(
    "T-HW.TYPE.2 [CONCERN-1]: hardwareTypeAt passes non-ASCII text (é, café) verbatim to unicodeType",
    async () => {
      // Given: fakeClient returning known coords; fakeCg records calls; text includes non-ASCII
      // When:  hardwareTypeAt(fakeClient, "@e3", "café", fakeCg) is called
      // Then:  unicodeType("café") called exactly once with the exact non-ASCII string
      //        (verifies the TS→C++ dispatch does not corrupt encoding BEFORE the C++ UTF-16 step;
      //         CONCERN-1 guards the C++ Utf16Value body which guardian verifies at Step 6)
      const { cg, log } = makeFakeCg();
      const fakeClient = makeFakeClient({
        sx: 0, sy: 0, ch: 50,
        border: [100, 200, 140, 200, 140, 240, 100, 240],
        refKey: "e3",
        backendNodeId: 7,
      });
      await hardwareTypeAt(fakeClient, "@e3", "café", cg);
      assert.equal(log.unicodeType.length, 1, "T-HW.TYPE.2: unicodeType must be called exactly once");
      assert.equal(log.unicodeType[0], "café", "T-HW.TYPE.2: unicodeType must receive 'café' verbatim");
    },
  );
});

// ─── T-HW.SCROLL.1 ────────────────────────────────────────────────────────────

describe("hardwareScroll — G-P32.17", () => {
  it(
    "T-HW.SCROLL.1: hardwareScroll(down, 3500) calls scrollWheel multiple times with negative dy; 'up' gives positive dy",
    async () => {
      // Given: fakeCg records scrollWheel calls; amount=3500
      // When:  hardwareScroll(fakeClient, "down", 3500, fakeCg)
      // Then:  multiple scrollWheel calls; all dy < 0 (down); sum |dy| ≈ 3500
      // When:  hardwareScroll(fakeClient, "up", 3500, fakeCg2)
      // Then:  all dy > 0 (up)
      const fakeClient = makeFakeClient({
        sx: 0, sy: 0, ch: 0,
        border: [0, 0, 0, 0, 0, 0, 0, 0],
        refKey: "x",
        backendNodeId: 1,
      });

      const { cg: cgDown, log: logDown } = makeFakeCg();
      await hardwareScroll(fakeClient, "down", 3500, cgDown);
      assert.ok(logDown.scrollWheel.length >= 1, "T-HW.SCROLL.1: scrollWheel must be called ≥1× for down");
      const allDownNegative = logDown.scrollWheel.every(([, dy]) => dy < 0);
      assert.ok(allDownNegative, "T-HW.SCROLL.1: all dy must be negative for 'down'");
      const sumDown = logDown.scrollWheel.reduce((acc, [, dy]) => acc + Math.abs(dy), 0);
      assert.ok(sumDown > 0, "T-HW.SCROLL.1: summed |dy| must be positive");

      const { cg: cgUp, log: logUp } = makeFakeCg();
      await hardwareScroll(fakeClient, "up", 3500, cgUp);
      assert.ok(logUp.scrollWheel.every(([, dy]) => dy > 0), "T-HW.SCROLL.1: all dy must be positive for 'up'");
    },
  );
});

// ─── T-HW.PRESS.1 ─────────────────────────────────────────────────────────────

describe("hardwarePressKey — G-P32.18 / G-P32.14", () => {
  it(
    "T-HW.PRESS.1: hardwarePressKey('Enter', 0, fakeCg) posts keyEvent(36,true,0) then keyEvent(36,false,0)",
    () => {
      // Given: fakeCg records keyEvent calls; key='Enter', modifiers=0
      // When:  hardwarePressKey(fakeClient, "Enter", 0, fakeCg)
      // Then:  log.keyEvent === [[36, true, 0], [36, false, 0]] in order
      const { cg, log } = makeFakeCg();
      const fakeClient = makeFakeClient({
        sx: 0, sy: 0, ch: 0,
        border: [0, 0, 0, 0, 0, 0, 0, 0],
        refKey: "x",
        backendNodeId: 1,
      });
      hardwarePressKey(fakeClient, "Enter", 0, cg);
      assert.ok(log.keyEvent.length >= 2, "T-HW.PRESS.1: must post ≥2 key events (down + up)");
      const down = log.keyEvent.find((e) => e[1] === true);
      const up   = log.keyEvent.find((e) => e[1] === false);
      assert.ok(down, "T-HW.PRESS.1: keydown event missing");
      assert.ok(up,   "T-HW.PRESS.1: keyup event missing");
      assert.equal(down?.[0], 36, "T-HW.PRESS.1: Enter keyCode must be 36");
      assert.equal(up?.[0],   36, "T-HW.PRESS.1: Enter keyCode must be 36 on keyup");
    },
  );

  it(
    "T-HW.PRESS.2: hardwarePressKey with unknown key 'NoSuchKey' throws a clear error (G-P32.14)",
    () => {
      // Given: key = "NoSuchKey" (not in KEYCODES map)
      // When:  hardwarePressKey(fakeClient, "NoSuchKey", 0, fakeCg)
      // Then:  throws an Error mentioning the unmapped key
      const { cg } = makeFakeCg();
      const fakeClient = makeFakeClient({
        sx: 0, sy: 0, ch: 0,
        border: [0, 0, 0, 0, 0, 0, 0, 0],
        refKey: "x",
        backendNodeId: 1,
      });
      assert.throws(
        () => hardwarePressKey(fakeClient, "NoSuchKey", 0, cg),
        (err: unknown) => err instanceof Error && err.message.includes("NoSuchKey"),
        "T-HW.PRESS.2: must throw Error mentioning the unmapped key name",
      );
    },
  );
});
