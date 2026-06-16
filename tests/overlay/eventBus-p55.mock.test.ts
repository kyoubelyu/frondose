/**
 * P-55 Step 5 — T-Overlay.3, T-Overlay.4, T-Overlay.5
 * (G-P55.3, G-P55.4, G-P55.5)
 *
 * Mock tests for `src/overlay/eventBus.ts` (created at builder Step 4b).
 *
 * Gate coverage:
 *   G-P55.3 — `attachEventBus` subscribes to Runtime.bindingCalled exactly once;
 *              name-filter passes `__frondosePost` and rejects other binding names;
 *              malformed JSON payload silently swallowed (T-Overlay.3)
 *   G-P55.4 — End-to-end mock: valid bindingCalled payload → `onEvent` called once
 *              with the locked OverlayEvent envelope (T-Overlay.4)
 *   G-P55.5 — `appendOverlayEventRow` writes byte-precise JSONL; additive multi-line
 *              append; field order matches locked OverlayEvent shape (T-Overlay.5)
 *
 * No Chrome, no LLM.  T-Overlay.5 uses mkdtempSync (tmp dir — no ~/.mai/ I/O).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// ─── G-P55.3: attachEventBus subscription, name-filter, malformed-JSON swallow ─

describe("attachEventBus — Runtime.bindingCalled subscribe + name filter + malformed payload (G-P55.3)", () => {
  it("T-Overlay.3: given fakeHandle whose Runtime.bindingCalled spy captures the handler and returns stub unsubscribe, when attachEventBus(fakeHandle, onEventSpy) then handler fired with (a) valid __frondosePost payload (b) other-binding name (c) malformed JSON, THEN Runtime.bindingCalled subscribed ONCE; onEventSpy called ONCE total (only valid __frondosePost); handler does NOT throw on any invocation; unsub is a function", async () => {
    // Given: fake CdpHandle whose Runtime.bindingCalled(handler) captures `handler` and
    //        returns a stub `() => {}` unsubscribe function; onEventCalls records each call
    // When:  const unsub = attachEventBus(fakeHandle, onEventSpy);
    //        then invoke captured handler with 3 payloads:
    //          (a) {name:"__frondosePost", payload:'{"type":"hello","t0":100}'}  — valid
    //          (b) {name:"other_binding", payload:'{"type":"x"}'}           — wrong name
    //          (c) {name:"__frondosePost", payload:"not-json"}                   — malformed JSON
    // Then:  Runtime.bindingCalled subscribed exactly once;
    //        onEventCalls.length === 1 (only (a) passes both guards);
    //        handler threw on none of the three invocations;
    //        unsub is typeof "function"
    // biome-ignore lint/suspicious/noExplicitAny: CdpHandle is typed as any (src/cdp/types.ts)
    let mod: any;
    try {
      mod = await import("../../src/overlay/eventBus.js");
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
        assert.fail("TODO Step 5: T-Overlay.3 — src/overlay/eventBus.ts not yet created (builder Step 4b pending)");
      }
      throw e;
    }
    const { attachEventBus } = mod;

    let capturedHandler: ((arg: { name: string; payload: string }) => void) | undefined;
    let subscribeCallCount = 0;
    const onEventCalls: unknown[] = [];

    const fakeHandle = {
      Runtime: {
        bindingCalled: (handler: (arg: { name: string; payload: string }) => void) => {
          subscribeCallCount++;
          capturedHandler = handler;
          return () => {};
        },
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: test-only fake handle
    const unsub = attachEventBus(fakeHandle as any, (evt: unknown) => {
      onEventCalls.push(evt);
    });

    // G-P55.3: subscribed exactly once
    assert.equal(subscribeCallCount, 1, "Runtime.bindingCalled subscribed exactly once");
    assert.ok(capturedHandler !== undefined, "handler was captured by fake subscribe");
    assert.equal(typeof unsub, "function", "attachEventBus returns an unsubscribe function");

    // Fire 3 payloads — none must throw
    assert.doesNotThrow(
      () => capturedHandler?.({ name: "__frondosePost", payload: '{"type":"hello","t0":100}' }),
      "(a) valid __frondosePost: handler must not throw",
    );
    assert.doesNotThrow(
      () => capturedHandler?.({ name: "other_binding", payload: '{"type":"x"}' }),
      "(b) wrong binding name: handler must not throw",
    );
    assert.doesNotThrow(
      () => capturedHandler?.({ name: "__frondosePost", payload: "not-json" }),
      "(c) malformed JSON: handler must not throw (silently swallowed)",
    );

    // Only payload (a) passes both guards (correct name + valid JSON + type is string)
    assert.equal(onEventCalls.length, 1, "onEvent called ONCE: only valid __frondosePost passes");
  });
});

// ─── G-P55.4: end-to-end mock — bindingCalled payload → locked OverlayEvent ───

describe("attachEventBus — end-to-end mock: valid payload → locked OverlayEvent envelope (G-P55.4)", () => {
  it("T-Overlay.4: given fakeHandle + Date.now() stubbed to 2000, when captured handler invoked with {name:'__frondosePost', payload:JSON.stringify({type:'hello',url:'https://x',t0:1000})}, THEN onEvent called ONCE with EXACTLY {kind:'overlay-event',ts:2000,event_type:'hello',t0:1000,latency_ms:1000}", async () => {
    // Given: fake CdpHandle whose Runtime.bindingCalled captures the handler;
    //        Date.now() stub returns 2000 during the handler invocation
    // When:  invoke captured handler with {name:"__frondosePost",
    //        payload: JSON.stringify({type:"hello", url:"https://x", t0: 1000})}
    // Then:  onEventCalls[0] deep-equals {kind:"overlay-event", ts:2000, event_type:"hello",
    //          t0:1000, latency_ms:1000}  (ts - t0 = 2000 - 1000 = 1000)
    // biome-ignore lint/suspicious/noExplicitAny: CdpHandle is typed as any
    let mod: any;
    try {
      mod = await import("../../src/overlay/eventBus.js");
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
        assert.fail("TODO Step 5: T-Overlay.4 — src/overlay/eventBus.ts not yet created (builder Step 4b pending)");
      }
      throw e;
    }
    const { attachEventBus } = mod;

    let capturedHandler: ((arg: { name: string; payload: string }) => void) | undefined;
    const onEventCalls: unknown[] = [];

    const fakeHandle = {
      Runtime: {
        bindingCalled: (handler: (arg: { name: string; payload: string }) => void) => {
          capturedHandler = handler;
          return () => {};
        },
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: test-only fake handle
    attachEventBus(fakeHandle as any, (evt: unknown) => {
      onEventCalls.push(evt);
    });

    assert.ok(capturedHandler !== undefined, "handler captured");

    // Stub Date.now to return 2000 for deterministic ts + latency_ms
    const origNow = Date.now;
    try {
      Date.now = () => 2000;
      capturedHandler?.({
        name: "__frondosePost",
        payload: JSON.stringify({ type: "hello", url: "https://x", t0: 1000 }),
      });
    } finally {
      Date.now = origNow;
    }

    assert.equal(onEventCalls.length, 1, "onEvent called exactly once");
    assert.deepEqual(
      onEventCalls[0],
      {
        kind: "overlay-event",
        ts: 2000,
        event_type: "hello",
        t0: 1000,
        latency_ms: 1000, // ts(2000) - t0(1000) = 1000
      },
      "locked OverlayEvent envelope must match exactly",
    );
  });
});

// ─── G-P55.5: appendOverlayEventRow — byte-precise JSONL + additive append ────

describe("appendOverlayEventRow — byte-precise JSONL envelope + additive multi-line append (G-P55.5)", () => {
  it("T-Overlay.5: given mkdtempSync tmp dir + fixed OverlayEvent {kind:'overlay-event',ts:1234,event_type:'hello',t0:1000,latency_ms:234}, when appendOverlayEventRow(event, auditPath) twice, THEN audit.jsonl contains EXACTLY two JSONL lines with byte-precise field order and single trailing newline each (no whitespace, insertion-order JSON fields)", async () => {
    // Given: tmp dir via mkdtempSync(join(tmpdir(),"mai-p55-overlay-"));
    //        auditPath = join(dir, "audit.jsonl");
    //        fixed OverlayEvent value:
    //          {kind:"overlay-event", ts:1234, event_type:"hello", t0:1000, latency_ms:234}
    // When:  appendOverlayEventRow(event, auditPath)  — first call
    // Then:  file content ===
    //          '{"kind":"overlay-event","ts":1234,"event_type":"hello","t0":1000,"latency_ms":234}\n'
    //        (byte-precise: field order == OverlayEvent declaration; no whitespace;
    //         single trailing newline)
    // And:   appendOverlayEventRow(event, auditPath) — second call
    //        → 2-line JSONL file (additive append, no separator beyond \n)
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import return type
    let mod: any;
    try {
      mod = await import("../../src/overlay/eventBus.js");
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
        assert.fail("TODO Step 5: T-Overlay.5 — src/overlay/eventBus.ts not yet created (builder Step 4b pending)");
      }
      throw e;
    }
    const { appendOverlayEventRow } = mod;

    const dir = mkdtempSync(join(os.tmpdir(), "mai-p55-overlay-"));
    const auditPath = join(dir, "audit.jsonl");

    try {
      const event = {
        kind: "overlay-event" as const,
        ts: 1234,
        event_type: "hello",
        t0: 1000,
        latency_ms: 234,
      };

      // First call — creates the file
      appendOverlayEventRow(event, auditPath);
      const firstContent = readFileSync(auditPath, "utf-8");
      const expectedLine = '{"kind":"overlay-event","ts":1234,"event_type":"hello","t0":1000,"latency_ms":234}\n';
      assert.equal(
        firstContent,
        expectedLine,
        "first call: byte-precise JSONL with insertion-order fields and single trailing \\n",
      );

      // Second call — appends
      appendOverlayEventRow(event, auditPath);
      const secondContent = readFileSync(auditPath, "utf-8");
      const lines = secondContent.split("\n").filter((l) => l.length > 0);
      assert.equal(lines.length, 2, "second call: 2-line JSONL file (additive append)");
      assert.equal(lines[0], lines[1], "both lines are identical (same event appended twice)");
      assert.equal(
        secondContent,
        expectedLine + expectedLine,
        "two lines with no extra separator — just two \\n-terminated records",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
