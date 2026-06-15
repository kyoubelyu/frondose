/**
 * P-AUTO-16 Step 5 — Validation — G-A16.3, G-A16.3b, G-A16.4, G-A16.11
 *
 * PSA-4a: computeCharDelay CUMULATIVE-CLAMP model (round 2)
 *   - Restores OLD budget = min(8000/len, 150) as per-char base
 *   - Adds prevChar parameter + word-boundary multiplier (space→2.0, .!?→2.5, else→1.0)
 *   - cdp LOOP owns the cumulative clamp via elapsed accumulator (NOT the formula)
 *   - Normal no-boundary text retains OLD ~8s pacing (G-A16.3 asserts ≥7900ms)
 *   - Pathological all-boundary text is HARD-clamped at total=8000ms (G-A16.3b)
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/auto/phase-auto-16-psa4a-typing.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Dynamic import — computeCharDelay is exported from type.ts; its signature changed at Step 4
// (gained a prevChar: string | undefined third parameter).
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder compatibility
let computeCharDelay: ((...args: unknown[]) => number) | undefined;

const typeMod = await import("../../src/tools/browser/type.js").catch(() => null);
computeCharDelay = typeMod?.computeCharDelay as ((...args: unknown[]) => number) | undefined;

// ---------------------------------------------------------------------------
// Loop-accumulator harness (mirrors the cdp-loop arithmetic from §6.4 Sketch 2).
// This harness exercises G-A16.3 and G-A16.3b:
//   raw = computeCharDelay(text.length, rand, prevChar)
//   remaining = Math.max(0, 8000 - elapsed)
//   d = Math.min(raw, remaining)
//   elapsed += d
// The harness uses deterministic rand values to isolate the math.
// ---------------------------------------------------------------------------

interface LoopResult {
  elapsed: number;
  zeroDelayCount: number;
  iterations: number;
}

/**
 * Simulate the cdp-loop accumulator for a text string with a fixed rand stub.
 * Mirrors §6.4 Sketch 2 exactly; does NOT call the actual CDP (no sleep).
 *
 * @param text - The text to simulate typing (only length + char values matter)
 * @param randStub - Fixed value substituted for Math.random() in every call
 * @returns { elapsed, zeroDelayCount, iterations }
 */
function simulateCdpLoop(text: string, randStub: number): LoopResult {
  if (!computeCharDelay) throw new Error("computeCharDelay not importable — builder Step 4 required");

  let elapsed = 0;
  let zeroDelayCount = 0;
  let prevChar: string | undefined = undefined;
  const iterations = text.length;

  for (const ch of text) {
    // §6.4 Sketch 2 arithmetic:
    const raw = computeCharDelay(text.length, randStub, prevChar);
    const remaining = Math.max(0, 8000 - elapsed);
    const d = Math.min(raw, remaining);
    elapsed += d;
    if (d === 0) zeroDelayCount++;
    prevChar = ch;
  }

  return { elapsed, zeroDelayCount, iterations };
}

// ---------------------------------------------------------------------------
// describe: PSA-4a — computeCharDelay CUMULATIVE-CLAMP model
// ---------------------------------------------------------------------------

describe("T-A16.PSA4a — computeCharDelay word-boundary multiplier + cumulative clamp (P-AUTO-16 PSA-4a)", () => {
  // ─── G-A16.3 ───────────────────────────────────────────────────────────────
  it(
    "T-A16.PSA4a.3: NORMAL no-boundary text (len=200, all 'x', jitter=1.0) retains OLD ~8s pacing — elapsed_final ∈ [7900, 8000]",
    () => {
      // Given: text = "x".repeat(200) — all mid-word chars; every char has prevChar !== ' ' && prevChar ∉ {.,!,?}
      //        prevChar === undefined for char[0] → wbMul=1.0; prevChar === 'x' for chars[1..199] → wbMul=1.0
      //        rand stubbed to 1.0 (upper-bound jitter → jitter multiplier = 0.3 + 1.0 * 0.7 = 1.0)
      //        budget = min(8000/200, 150) = 40ms; floor = min(30, 40) = 30ms
      //        per-char raw = max(30, floor(40 * 1.0 * 1.0)) = 40ms
      //        uncapped sum = 200 * 40 = 8000ms → exactly at the cap boundary (clamp inactive or at limit)
      // When:  simulateCdpLoop("x".repeat(200), 1.0) runs
      // Then:  elapsed_final ∈ [7900, 8000]
      //        (Anti-detection assertion: round-1 ÷2.5 model would produce ~3200ms — FAILS this test)
      //        (Round-2 RESTORES the OLD ~8s human-realistic pacing for no-boundary text)

      if (!computeCharDelay) throw new Error("computeCharDelay not importable — builder Step 4 required");

      const result = simulateCdpLoop("x".repeat(200), 1.0);
      assert.ok(
        result.elapsed >= 7900 && result.elapsed <= 8000,
        `G-A16.3: elapsed_final must be in [7900, 8000]ms for no-boundary text (len=200, jitter=1.0). ` +
          `Got ${result.elapsed}ms. ` +
          `If ~3200ms: the REJECTED round-1 ÷2.5 base was used (anti-detection regression). ` +
          `Round-2 must restore OLD budget = min(8000/len, 150).`,
      );
      assert.equal(result.iterations, 200, "iterations must equal text.length (200)");
    },
  );

  // ─── G-A16.3b ──────────────────────────────────────────────────────────────
  it(
    "T-A16.PSA4a.3b: PATHOLOGICAL all-boundary text (len=300, all '.', jitter=1.0) is HARD-clamped at elapsed_final === 8000 by the LOOP",
    () => {
      // Given: text = ".".repeat(300) — all sentence-end chars
      //        chars[0]: prevChar=undefined → wbMul=1.0; chars[1..299]: prevChar='.' → wbMul=2.5
      //        rand stubbed to 1.0 (worst jitter)
      //        budget = min(8000/300, 150) ≈ 26.67ms; floor = min(30, 26.67) ≈ 26.67ms
      //        per-char raw (prevChar='.'): max(26.67, floor(26.67 * 1.0 * 2.5)) = max(26.67, 66) = 66ms
      //        uncapped sum ≈ 26.67 + 299 * 66 ≈ 19,760ms (vastly exceeds 8000ms)
      //        the LOOP clamp owns the bound: once elapsed hits 8000, remaining chars get d=0
      // When:  simulateCdpLoop(".".repeat(300), 1.0) runs
      // Then:  (a) elapsed_final === 8000 (exactly — LOOP clamp enforces this)
      //        (b) at least 150 of the 300 chars had d === 0 (clamp truncated the tail)
      //        (c) iterations === 300 (the loop completed all chars — no early abort)

      if (!computeCharDelay) throw new Error("computeCharDelay not importable — builder Step 4 required");

      const result = simulateCdpLoop(".".repeat(300), 1.0);

      assert.equal(
        result.elapsed,
        8000,
        `G-A16.3b(a): elapsed_final must be exactly 8000ms for pathological all-boundary text (len=300, jitter=1.0). ` +
          `Got ${result.elapsed}ms. The LOOP clamp must own the 8000ms bound (not the formula).`,
      );
      assert.ok(
        result.zeroDelayCount >= 150,
        `G-A16.3b(b): at least 150 of 300 chars must have d===0 (clamp truncated the tail). ` +
          `Got zeroDelayCount=${result.zeroDelayCount}. ` +
          `The uncapped sum ≈19760ms means ~178 chars should be zero-delay after the clamp fires.`,
      );
      assert.equal(
        result.iterations,
        300,
        `G-A16.3b(c): all 300 iterations must complete (loop must NOT abort typing — only sleeping is clamped). ` +
          `Got ${result.iterations}.`,
      );
    },
  );

  // ─── G-A16.4 ───────────────────────────────────────────────────────────────
  it(
    "T-A16.PSA4a.4: post-space char gets longer delay than mid-word char (same jitter=0.5)",
    () => {
      // Given: text "abc def" (7 chars); rand = 0.5 (deterministic)
      //        budget = min(8000/7, 150) ≈ 150ms (budget for 7-char text hits max)
      //        Actually min(8000/7, 150) = min(1142.857, 150) = 150ms
      //        floor = min(30, 150) = 30ms
      //        computeCharDelay(7, 0.5, "a") — prevChar='a' mid-word → wbMul=1.0
      //          = max(30, floor(150 * (0.3 + 0.5 * 0.7) * 1.0)) = max(30, floor(150 * 0.65)) = max(30, 97) = 97ms
      //        computeCharDelay(7, 0.5, " ") — prevChar=' ' post-space → wbMul=2.0
      //          = max(30, floor(150 * 0.65 * 2.0)) = max(30, floor(195)) = max(30, 195) = 195ms
      //        ratio: 195 / 97 ≈ 2.01 → well above 1.8
      // When:  both called with the same textLength and rand
      // Then:  post-space return >= 1.8 * mid-word return

      if (!computeCharDelay) throw new Error("computeCharDelay not importable — builder Step 4 required");

      const dMidWord = computeCharDelay(7, 0.5, "a");
      const dPostSpace = computeCharDelay(7, 0.5, " ");

      assert.ok(
        typeof dMidWord === "number" && dMidWord > 0,
        `G-A16.4: computeCharDelay(7, 0.5, "a") must return a positive number; got ${dMidWord}`,
      );
      assert.ok(
        typeof dPostSpace === "number" && dPostSpace > 0,
        `G-A16.4: computeCharDelay(7, 0.5, " ") must return a positive number; got ${dPostSpace}`,
      );
      assert.ok(
        dPostSpace >= 1.8 * dMidWord,
        `G-A16.4: post-space delay (${dPostSpace}) must be >= 1.8 * mid-word delay (${dMidWord}). ` +
          `Design multiplier is 2.0 (wbMul); 1.8 threshold allows floor-clamp headroom. ` +
          `Ratio: ${(dPostSpace / dMidWord).toFixed(2)}x.`,
      );
    },
  );

  // ─── G-A16.11 ──────────────────────────────────────────────────────────────
  it(
    "T-A16.PSA4a.11: first char (prevChar=undefined) treated as mid-word (same result as prevChar='a')",
    () => {
      // Given: computeCharDelay(50, 0.5, undefined) — first-char call (prevChar undefined → wbMul=1.0)
      //        computeCharDelay(50, 0.5, "a")       — mid-word char (prevChar='a' → wbMul=1.0)
      //        Both must yield wbMul=1.0 (undefined falls into the "otherwise" branch)
      // When:  both called
      // Then:  both return the same value (deterministic with same rand=0.5)

      if (!computeCharDelay) throw new Error("computeCharDelay not importable — builder Step 4 required");

      const dUndefined = computeCharDelay(50, 0.5, undefined);
      const dMidWord = computeCharDelay(50, 0.5, "a");

      assert.equal(
        dUndefined,
        dMidWord,
        `G-A16.11: computeCharDelay(50, 0.5, undefined) must equal computeCharDelay(50, 0.5, "a"). ` +
          `Both should yield wbMul=1.0. Got: undefined-path=${dUndefined}, midword-path=${dMidWord}.`,
      );
    },
  );
});
