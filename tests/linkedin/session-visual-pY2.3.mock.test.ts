/**
 * P-Y2.3 Step 5 — T-Driver.1..4 — FILLED.
 *
 * The session visual hook (plan §6.4-B/C): OPTIONAL `setVisualDriver`/`showAgentTarget`/`clearAgentTarget`.
 * `showAgentTarget` pushes `__maiShowAgentTarget(json)` via the driver + dwells (~VISUAL_DWELL_MS=500) ONLY
 * when the driver returns true (painted) — Manual/headless/REPL take ZERO latency.
 *
 * Gate coverage: G-PY2.3.3 (push + dwell-only-when-painted + no-op-when-no-driver), G-PY2.3.9 (optional).
 *
 * Run (mock): node --import tsx --test --test-force-exit --test-timeout=30000 \
 *   tests/linkedin/session-visual-pY2.3.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { createLinkedinSession } from "../../src/linkedin/session.js";

const VISUAL_DWELL_MS = 500; // mirrors session.ts (the locked dwell)
const BOX = { x: 1, y: 2, w: 3, h: 4 };

// biome-ignore lint/suspicious/noExplicitAny: the P-Y2.3 visual methods are optional + new.
function makeSession(): any {
  return createLinkedinSession({ port: 9222, profileDir: "/tmp/p-y2.3", inputMode: "cdp" });
}
/** Parse the {box,label} embedded in a driver fn string (double-encoded — the __maiShowCard push pattern). */
function payloadFromFn(fn: string): unknown {
  const m = /__maiShowAgentTarget\((".*")\)/.exec(fn);
  assert.ok(m?.[1], `fn must embed __maiShowAgentTarget("<json>"); got ${fn.slice(0, 120)}`);
  return JSON.parse(JSON.parse(m[1]) as string);
}

describe("session.showAgentTarget — pushes __maiShowAgentTarget via the driver (G-PY2.3.3)", () => {
  it("T-Driver.1: showAgentTarget pushes a fn embedding __maiShowAgentTarget({box,label}) via the driver", async () => {
    const s = makeSession();
    assert.equal(typeof s.setVisualDriver, "function", "builder 4b must add setVisualDriver");
    const calls: string[] = [];
    s.setVisualDriver((fn: string) => {
      calls.push(fn);
      return true;
    });
    await s.showAgentTarget(BOX, "Send note");
    assert.equal(calls.length, 1, "driver called once");
    assert.ok(calls[0]?.includes("window.__maiShowAgentTarget("), "fn calls __maiShowAgentTarget");
    assert.deepEqual(payloadFromFn(calls[0] ?? ""), { box: BOX, label: "Send note" });
  });
});

describe("session.showAgentTarget — dwell ONLY when painted (G-PY2.3.3)", () => {
  it("T-Driver.2: dwell ~VISUAL_DWELL_MS when the driver returns true; resolves immediately (no dwell) when false", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      // painted=true → must NOT resolve until the dwell elapses
      const s = makeSession();
      s.setVisualDriver(() => true);
      let done = false;
      const p = s.showAgentTarget(BOX, "x").then(() => {
        done = true;
      });
      await Promise.resolve(); // flush the synchronous driver call + the setTimeout registration
      assert.equal(done, false, "must not resolve before VISUAL_DWELL_MS (it dwelled)");
      mock.timers.tick(VISUAL_DWELL_MS);
      await p;
      assert.equal(done, true, "resolves after the dwell elapses");

      // painted=false → resolves with NO timer (await would hang under mock timers if it dwelled)
      const s2 = makeSession();
      s2.setVisualDriver(() => false);
      await s2.showAgentTarget(BOX, "x"); // no tick → resolves only if there is no dwell
    } finally {
      mock.timers.reset();
    }
  });
});

describe("session.showAgentTarget/clearAgentTarget — no-op when no driver set (G-PY2.3.3, .9)", () => {
  it("T-Driver.3: with no driver set (REPL/tests/server), showAgentTarget + clearAgentTarget no-op (no throw)", async () => {
    const s = makeSession();
    await assert.doesNotReject(() => s.showAgentTarget(BOX, "x"), "showAgentTarget no-ops without a driver");
    assert.doesNotThrow(() => s.clearAgentTarget(), "clearAgentTarget no-ops without a driver");
  });
});

describe("session.clearAgentTarget — pushes __maiClearAgentTarget via the driver (G-PY2.3.3)", () => {
  it("T-Driver.4: clearAgentTarget pushes a fn containing window.__maiClearAgentTarget()", () => {
    const s = makeSession();
    const calls: string[] = [];
    s.setVisualDriver((fn: string) => {
      calls.push(fn);
      return true;
    });
    s.clearAgentTarget();
    assert.ok(
      calls.some((c) => c.includes("window.__maiClearAgentTarget()")),
      "clearAgentTarget must push __maiClearAgentTarget()",
    );
  });
});
