/**
 * P-57b Step 5 — T-Rate.1, T-Rate.2 (G-P57b.1) — FILLED
 *
 * Mock tests for P-57b NEW file `src/cli/subcommands/passiveRateLimit.ts`.
 *   T-Rate.1 — `PassiveRateLimiter.tryConsume()` short-window enforcement
 *   T-Rate.2 — `PassiveRateLimiter.tryConsume()` long-window 5/60s + AND logic
 *
 * Gate coverage:
 *   G-P57b.1 — Token-bucket rate-limit enforces 1/N short + 5/60 long
 *
 * Implementation notes (vs plan §5.1):
 *   - PassiveRateLimiterOpts shape: {shortS, longN, longS} (seconds + count) — NOT the
 *     planned {shortWindowMs, longWindowMaxTokens, longWindowMs}.
 *   - Refills use `setInterval(shortS*1000)` (adds 1 token per shortS seconds) and
 *     `setInterval(longS*1000)` (adds 1 token per longS seconds; capped at longN) —
 *     NOT "longWindowMs / longWindowMaxTokens per token" from the plan.
 *   - Tests use small fractional seconds (0.05–0.2) so the setInterval refills fire
 *     within the test's real-time wait window without needing fake timers.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/cli/subcommands/passiveRateLimit-p57b.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PassiveRateLimiter } from "../../../src/cli/subcommands/passiveRateLimit.js";

// ─── T-Rate.1 — short-window enforcement ─────────────────────────────────────

describe("PassiveRateLimiter — short-window enforcement (G-P57b.1)", () => {
  it("T-Rate.1: given new PassiveRateLimiter({shortS:0.1, longN:5, longS:60}), WHEN tryConsume #1 then immediate #2, THEN #1=true (short=0); #2=false (short bucket exhausted); after real-time wait 150ms the setInterval(100ms) refills short token, #3=true", async () => {
    // Given: limiter with shortS=0.1s (100ms refill cadence) so we can observe the refill
    //        within a sub-second test wait window.
    // When:  #1 + immediate #2 + wait 150ms + #3
    // Then:  #1 → true; #2 → false; #3 → true (short bucket refilled at 100ms boundary)

    const limiter = new PassiveRateLimiter({ shortS: 0.1, longN: 5, longS: 60 });
    const baseline = limiter.snapshot();
    assert.equal(baseline.shortWindowTokens, 1, "initial short bucket starts at 1");
    assert.equal(baseline.longWindowTokens, 5, "initial long bucket starts at longN=5");

    // #1 — first consume succeeds
    assert.equal(limiter.tryConsume(), true, "(#1) first tryConsume should succeed");
    const afterOne = limiter.snapshot();
    assert.equal(afterOne.shortWindowTokens, 0, "(#1) short bucket should be 0 after consume");
    assert.equal(afterOne.longWindowTokens, 4, "(#1) long bucket should decrement to 4");

    // #2 — immediate retry fails (short bucket empty)
    assert.equal(limiter.tryConsume(), false, "(#2) immediate retry should fail (short bucket empty)");
    const afterTwo = limiter.snapshot();
    assert.equal(afterTwo.shortWindowTokens, 0, "(#2) short bucket stays 0");
    assert.equal(afterTwo.longWindowTokens, 4, "(#2) long bucket NOT decremented on fail (AND-logic preserves both)");

    // Wait for short-window setInterval(100ms) refill to fire (1 cycle = 100ms; budget 150ms)
    await new Promise((r) => setTimeout(r, 150));

    // #3 — after refill, succeeds again
    assert.equal(limiter.tryConsume(), true, "(#3) after short refill, tryConsume should succeed");
    const afterThree = limiter.snapshot();
    assert.equal(afterThree.shortWindowTokens, 0, "(#3) short consumed again → 0");
    assert.equal(afterThree.longWindowTokens, 3, "(#3) long bucket decremented to 3");
  });
});

// ─── T-Rate.2 — long-window AND-logic enforcement ───────────────────────────

describe("PassiveRateLimiter — long-window 3/Ns + AND logic (G-P57b.1)", () => {
  it("T-Rate.2: given new PassiveRateLimiter({shortS:0.05, longN:3, longS:0.3}), WHEN consume 3 times spaced 60ms each (short always refills) so long exhausts; 4th tryConsume; after 350ms wait (long setInterval refills 1 token); 5th tryConsume, THEN #1/#2/#3 = true; #4 = false (long bucket exhausted; short alone insufficient — AND logic); #5 = true (long refilled)", async () => {
    // Given: shortS=0.05s (50ms cadence), longN=3, longS=0.3s (300ms cadence — long refills 1 token every 300ms; caps at 3).
    // When:
    //   #1 at t=0    → short=0, long=2
    //   wait 60ms (short refill at 50ms cycle)
    //   #2 at t~60   → short=0, long=1
    //   wait 60ms (short refill again)
    //   #3 at t~120  → short=0, long=0
    //   wait 60ms (short refill; long timer cycle at 300ms not yet reached)
    //   #4 at t~180  → false (long=0; AND-logic gate; even though short=1)
    //   wait 350ms more total (now t~530; long timer fires at 300/600/... → 1 token refilled by t=600)
    //   #5 at t~530  → true (long=1 by then)
    // Then:  exhaust pattern matches AND-logic per plan §5.1 CONCERN-MR-1 inline comment.

    const limiter = new PassiveRateLimiter({ shortS: 0.05, longN: 3, longS: 0.3 });
    assert.equal(limiter.snapshot().longWindowTokens, 3, "initial long bucket = longN = 3");

    // #1
    assert.equal(limiter.tryConsume(), true, "(#1) first consume succeeds");
    await new Promise((r) => setTimeout(r, 70)); // short refill (50ms cadence)
    // #2
    assert.equal(limiter.tryConsume(), true, "(#2) second consume succeeds after short refill");
    await new Promise((r) => setTimeout(r, 70));
    // #3
    assert.equal(limiter.tryConsume(), true, "(#3) third consume succeeds (long bucket draining)");
    await new Promise((r) => setTimeout(r, 70));
    const beforeFour = limiter.snapshot();
    assert.equal(beforeFour.longWindowTokens, 0, "before #4: long bucket exhausted");
    assert.ok(beforeFour.shortWindowTokens > 0, "before #4: short bucket has token (AND-logic isolates long failure)");

    // #4 — AND-logic gate fails: long bucket empty even though short has token
    assert.equal(limiter.tryConsume(), false, "(#4) AND-logic: long bucket empty → fail despite short token");
    const afterFour = limiter.snapshot();
    assert.equal(afterFour.shortWindowTokens, beforeFour.shortWindowTokens, "(#4) short NOT decremented on fail");
    assert.equal(afterFour.longWindowTokens, 0, "(#4) long stays 0");

    // Wait for long setInterval(300ms) to refill 1 token
    await new Promise((r) => setTimeout(r, 400));
    const afterWait = limiter.snapshot();
    assert.ok(
      afterWait.longWindowTokens >= 1,
      `after 400ms wait, long bucket should have ≥1 token from setInterval refill; got ${afterWait.longWindowTokens}`,
    );

    // #5 — succeeds again
    assert.equal(limiter.tryConsume(), true, "(#5) after long refill, consume succeeds");
  });
});
