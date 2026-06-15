/**
 * P-AUTO-17 Step 3 — T-A17.7..T-A17.9: classifyOutboundEntry unit tests (G-A17.7..9).
 *
 * Tests the NEW `classifyOutboundEntry(entry, surface)` export from outboundGuard.ts.
 * The legacy `classifyOutboundLabel` is NOT tested here (covered by outboundGuard.mock.test.ts
 * + outboundGuard-pAuto10.mock.test.ts); this file covers only the Part-2 entry-shaped
 * adapter introduced by P-AUTO-17 §6.4.C.
 *
 * All assertion bodies are assert.fail("TODO Step 5") — intentional red-state per
 * outside-in TDD. Tests compile and fail until Step 5 fills them.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/browser/outboundGuard-pAuto17.mock.test.ts
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder scaffold
type AnyFn = (...args: any[]) => any;

// classifyOutboundEntry does NOT exist until builder Step 4.
// Import deferred so the scaffold compiles pre-builder. If the module fails to
// import or classifyOutboundEntry is absent, each test fails at the first
// assert.ok(classifyOutboundEntry !== null) — intentional Step-3 red-state.
let classifyOutboundEntry: AnyFn | null = null;

before(async () => {
  const mod = await import("../../../src/tools/browser/outboundGuard.js").catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  classifyOutboundEntry = (mod as any)?.classifyOutboundEntry ?? null;
});

describe("T-A17.7..9 — classifyOutboundEntry: entry-shaped outbound classifier (P-AUTO-17 Part 2)", () => {
  // ─── T-A17.7 ─────────────────────────────────────────────────────────────
  it("T-A17.7: when entry.name='Send invitation' on a LinkedIn profile surface, classifyOutboundEntry returns 'connect_send' (G-A17.7)", async () => {
    // Given: entry = {ref:"@ov4", role:"button", name:"Send invitation"}, surface = "profile"
    // When:  classifyOutboundEntry(entry, surface) called
    // Then:  returns "connect_send"
    assert.ok(
      classifyOutboundEntry !== null,
      "T-A17.7: classifyOutboundEntry must be exported from outboundGuard.ts (not yet at Step 3)",
    );
    const entry = { ref: "@ov4", role: "button", name: "Send invitation" };
    const result = classifyOutboundEntry!(entry, "profile");
    assert.equal(result, "connect_send", `classifyOutboundEntry({name:'Send invitation'}, 'profile') must return 'connect_send'; got '${result}'`);
  });

  // ─── T-A17.8 ─────────────────────────────────────────────────────────────
  it("T-A17.8: when surface is not in LINKEDIN_OUTBOUND_SURFACES, classifyOutboundEntry returns 'benign' regardless of entry name (P-33 carve-out) (G-A17.8)", async () => {
    // Given: entry = {ref:"@e1", role:"button", name:"Send invitation"}, surface = "unknown"
    // When:  classifyOutboundEntry(entry, surface) called
    // Then:  returns "benign" (the carve-out: surface not in LINKEDIN_OUTBOUND_SURFACES)
    assert.ok(
      classifyOutboundEntry !== null,
      "T-A17.8: classifyOutboundEntry must be exported from outboundGuard.ts",
    );
    const entry = { ref: "@e1", role: "button", name: "Send invitation" };
    const resultUnknown = classifyOutboundEntry!(entry, "unknown");
    assert.equal(resultUnknown, "benign", `P-33 carve-out: classifyOutboundEntry on 'unknown' surface must return 'benign'; got '${resultUnknown}'`);
    // Also verify empty string surface (general-web raw)
    const resultEmpty = classifyOutboundEntry!(entry, "");
    assert.equal(resultEmpty, "benign", `P-33 carve-out: classifyOutboundEntry on '' surface must return 'benign'; got '${resultEmpty}'`);
  });

  // ─── T-A17.9 ─────────────────────────────────────────────────────────────
  it("T-A17.9: when entry is null, classifyOutboundEntry(null, 'profile') returns 'benign' (null-safety; D-17 verifyRef blocks stale click) (G-A17.9)", async () => {
    // Given: entry = null (the stale-ref D-17-will-block case)
    // When:  classifyOutboundEntry(null, "profile") called
    // Then:  returns "benign" (no classify on missing target; D-17 verifyRef catches the stale)
    assert.ok(
      classifyOutboundEntry !== null,
      "T-A17.9: classifyOutboundEntry must be exported from outboundGuard.ts",
    );
    const resultNull = classifyOutboundEntry!(null, "profile");
    assert.equal(resultNull, "benign", `null entry must yield 'benign' (D-17 will block); got '${resultNull}'`);
    // Also verify undefined entry
    const resultUndefined = classifyOutboundEntry!(undefined, "profile");
    assert.equal(resultUndefined, "benign", `undefined entry must also yield 'benign'; got '${resultUndefined}'`);
  });
});
