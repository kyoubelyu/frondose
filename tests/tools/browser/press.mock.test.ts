/**
 * P-3 mock tests — T-M68..T-M69: press tool.
 *
 * Tests makePressTool() schema, state-changing vs non-state-changing keys, and
 * modifier combo dispatch.
 * NOTE: execute() calls applyPacing(). P-Y5 D-RUN-2 raises the default band to
 * 800-2500ms, so this suite disables pacing via MAI_PACE_MIN_MS=0 (resolvePaceBand
 * → disabled → no sleep; data.pacing is still {waitedMs:0,...} so presence checks hold).
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/types.js";
import { makePressTool } from "../../../src/tools/browser/press.js";

// P-Y5 D-RUN-2: keep the mock suite fast — disable inter-tool pacing for this file.
process.env.MAI_PACE_MIN_MS = "0";

const abortSignal = new AbortController().signal;

function makeFakeSession() {
  const keyEvents: Array<{ type: string; key: string; modifiers?: number }> = [];
  const fakeHandle = {
    Input: {
      dispatchKeyEvent: async (args: { type: string; key: string; modifiers?: number }) => {
        keyEvents.push(args);
      },
    },
  };
  const client = CdpClient.fromHandle(fakeHandle);
  return {
    inputMode: "cdp" as const,
    getOrInitClient: () => Promise.resolve({ ok: true as const, client }),
    getClient: () => client,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined as CurrentSurfaceContext | undefined,
    keyEvents,
  };
}

// ─── T-M68 ─────────────────────────────────────────────────────────────────────

test(
  "T-M68: press tool: Enter emits withHint (state-changing); Tab emits ok without hint",
  { timeout: 10000 },
  async () => {
    const session = makeFakeSession();
    const tool = makePressTool(session);

    // Enter — state-changing
    const r1 = await tool.execute({ key: "Enter" }, { toolCallId: "t1", messages: [], abortSignal });

    assert.equal(r1.ok, true, "Enter must succeed");
    assert.equal(r1.command, "press");
    // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
    const d1 = (r1 as any).data;
    assert.ok(typeof d1.hint === "string" && d1.hint.length > 0, "Enter must include data.hint (state-changing)");
    assert.equal(d1.key, "Enter");
    assert.equal(d1.pressed, true);

    // Tab — NOT state-changing (focus only)
    const session2 = makeFakeSession();
    const tool2 = makePressTool(session2);
    const r2 = await tool2.execute({ key: "Tab" }, { toolCallId: "t2", messages: [], abortSignal });

    assert.equal(r2.ok, true, "Tab must succeed");
    // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
    const d2 = (r2 as any).data;
    assert.equal(d2.hint, undefined, "Tab must NOT include data.hint (not state-changing)");
    assert.equal(d2.key, "Tab");
  },
);

// ─── T-M69 ─────────────────────────────────────────────────────────────────────

test(
  "T-M69: press tool: invalid key returns fail; Control+a dispatches with modifier bits",
  { timeout: 10000 },
  async () => {
    const session = makeFakeSession();
    const tool = makePressTool(session);

    // Invalid key — should fail immediately (no pacing)
    const r1 = await tool.execute({ key: "INVALID_KEY_XYZ" }, { toolCallId: "t3", messages: [], abortSignal });

    assert.equal(r1.ok, false, "invalid key must fail");
    // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
    const r1err = (r1 as any).error.message.toLowerCase();
    assert.ok(r1err.includes("invalid") || r1err.includes("key"));

    // Modifier combo: Control+a → modifiers bitmask 2 (Ctrl) + key 'a'
    const session2 = makeFakeSession();
    const tool2 = makePressTool(session2);
    const r2 = await tool2.execute({ key: "Control+a" }, { toolCallId: "t4", messages: [], abortSignal });

    assert.equal(r2.ok, true, "Control+a must succeed");

    const events = session2.keyEvents.filter((e) => e.key === "a");
    assert.ok(events.length >= 2, "must dispatch keyDown+keyUp for 'a'");
    assert.ok(
      events.some((e) => e.type === "keyDown" && e.modifiers === 2),
      "must dispatch keyDown with modifiers=2 (Ctrl)",
    );
    assert.ok(
      events.some((e) => e.type === "keyUp" && e.modifiers === 2),
      "must dispatch keyUp with modifiers=2 (Ctrl)",
    );
  },
);
