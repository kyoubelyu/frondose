/**
 * P-AUTO-L3FIX-2 — T2 mock tests: generic non-aside disambiguation for "More".
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/linkedin/labelResolver-moreDisambig-pAutoL3fix2.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveByLabel } from "../../src/linkedin/labelResolver.js";
import type { SnapshotEntry } from "../../src/linkedin/types.js";

describe("T2 — resolveByLabel generic non-aside disambiguation for More", () => {
  it("T2.a: one non-aside More plus two aside More buttons resolves the non-aside target", () => {
    // Given: one profile-action "More" with no region and two sidebar "More" controls marked region:'aside'.
    // When: resolveByLabel is called for a click target named "More".
    // Then: the confirmed-aside matches are dropped and the sole non-aside entry is returned.
    const entries: SnapshotEntry[] = [
      { ref: "@paMore", role: "button", name: "More" },
      { ref: "@e101", role: "button", name: "More", region: "aside" },
      { ref: "@e102", role: "button", name: "More", region: "aside" },
    ];

    const result = resolveByLabel(entries, "More", { kind: "click" });

    assert.equal(result.ref, "@paMore");
  });

  it("T2.b: two non-aside More buttons still throw ambiguous_target instead of blind-picking", () => {
    // Given: two non-aside "More" controls remain after the aside filter has nothing to drop.
    // When: resolveByLabel is called for "More".
    // Then: the resolver preserves the ambiguity guard and throws an ambiguous target error.
    const entries: SnapshotEntry[] = [
      { ref: "@paMore", role: "button", name: "More" },
      { ref: "@navMore", role: "button", name: "More" },
      { ref: "@e101", role: "button", name: "More", region: "aside" },
    ];

    assert.throws(
      () => resolveByLabel(entries, "More", { kind: "click" }),
      (err: unknown) => err instanceof Error && /ambiguous/i.test(err.message) && err.message.includes("@paMore") && err.message.includes("@navMore"),
    );
  });

  it("T2.c: connect-open overlay disambiguation still narrows to the overlay ref", () => {
    // Given: connect-open candidates include one non-aside page match, one aside match, and one overlay match.
    // When: activeLayer is overlay and resolveByLabel is called for "Connect".
    // Then: non-aside filtering still drops aside first and overlay narrowing returns the @ov entry.
    const entries: SnapshotEntry[] = [
      { ref: "@e7", role: "button", name: "Invite Jane to connect" },
      { ref: "@e147", role: "button", name: "Invite Fernando to connect", region: "aside" },
      { ref: "@ov4", role: "button", name: "Invite Jane to connect" },
    ];

    const result = resolveByLabel(entries, "Connect", { kind: "click", activeLayer: "overlay" });

    assert.equal(result.ref, "@ov4");
  });
});
