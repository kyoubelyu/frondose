/**
 * P-AUTO-16 Step 5 — Validation — G-A16.5, G-A16.12, G-A16.16
 *
 * OUT-6: resolveByLabel prefix-strip for [OUTBOUND] display labels
 *   - inspectSummary.ts adds "[OUTBOUND] " prefix to outbound action entries for display
 *   - resolveByLabel should strip that prefix before the includes() match
 *   - A bare label (no prefix) remains unaffected
 *   - An empty-after-strip label (was literally "[OUTBOUND] ") falls back to original label
 *     → no-match throw citing the original label (not a wrong-target match via "".includes(""))
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/auto/phase-auto-16-out6-label.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveByLabel } from "../../src/linkedin/labelResolver.js";
import type { SnapshotEntry } from "../../src/linkedin/types.js";

// ---------------------------------------------------------------------------
// Shared fixture: one button entry with raw name "Connect" (no [OUTBOUND] prefix
// in the stored name — that prefix is added only in the inspect DISPLAY path).
// ---------------------------------------------------------------------------

const ENTRIES_WITH_CONNECT: SnapshotEntry[] = [
  { ref: "@e3", role: "button", name: "Connect" },
];

const CLICK_OPTS = { kind: "click" as const };

// ---------------------------------------------------------------------------
// describe: OUT-6 resolveByLabel [OUTBOUND] prefix-strip
// ---------------------------------------------------------------------------

describe("T-A16.OUT6 — resolveByLabel [OUTBOUND] prefix-strip (P-AUTO-16 OUT-6)", () => {
  // ─── G-A16.5 ───────────────────────────────────────────────────────────────
  it(
    "T-A16.OUT6.5: resolveByLabel('[OUTBOUND] Connect') resolves the same entry as resolveByLabel('Connect')",
    () => {
      // Given: entries = [{ ref: '@e3', role: 'button', name: 'Connect' }]
      //        opts = { kind: 'click' }
      // When:  resolveByLabel(entries, '[OUTBOUND] Connect', opts) called
      //        resolveByLabel(entries, 'Connect', opts) called
      // Then:  both return the SAME entry object (@e3)
      //        Neither throws
      //        The prefix-strip makes "[OUTBOUND] Connect" → usable = "Connect" → needle = "connect"
      //        → case-insensitive includes match → returns @e3 (same as the bare 'Connect' path)

      const prefixed = resolveByLabel(ENTRIES_WITH_CONNECT, "[OUTBOUND] Connect", CLICK_OPTS);
      const bare = resolveByLabel(ENTRIES_WITH_CONNECT, "Connect", CLICK_OPTS);

      assert.equal(
        prefixed.ref,
        "@e3",
        `G-A16.5: resolveByLabel('[OUTBOUND] Connect') must resolve to '@e3'; got '${prefixed.ref}'`,
      );
      assert.equal(
        bare.ref,
        "@e3",
        `G-A16.5: resolveByLabel('Connect') must resolve to '@e3'; got '${bare.ref}'`,
      );
      assert.equal(
        prefixed.ref,
        bare.ref,
        "G-A16.5: prefixed and bare labels must resolve to the same entry",
      );
    },
  );

  // ─── G-A16.12 ──────────────────────────────────────────────────────────────
  it(
    "T-A16.OUT6.12: resolveByLabel('Connect') (no prefix) is byte-identical in behavior — strip regex is a no-op on plain labels",
    () => {
      // Given: entries = [{ ref: '@e3', role: 'button', name: 'Connect' }]
      //        opts = { kind: 'click' }
      // When:  resolveByLabel(entries, 'Connect', opts) called
      // Then:  returns the entry with ref '@e3'
      //        The OUTBOUND_DISPLAY_PREFIX_RE.replace on "Connect" is a no-op (no match → unchanged)
      //        The strip does NOT affect existing callers who never pass a prefixed label

      const result = resolveByLabel(ENTRIES_WITH_CONNECT, "Connect", CLICK_OPTS);

      assert.equal(
        result.ref,
        "@e3",
        `G-A16.12: resolveByLabel('Connect') must return '@e3'; got '${result.ref}'. ` +
          "The OUT-6 strip must be a no-op on labels without the [OUTBOUND] prefix.",
      );
      assert.equal(result.name, "Connect", "G-A16.12: resolved entry must have name 'Connect'");
    },
  );

  // ─── G-A16.16 ──────────────────────────────────────────────────────────────
  it(
    "T-A16.OUT6.16: resolveByLabel('[OUTBOUND] ') (empty after strip) THROWS no-match error citing the ORIGINAL label",
    () => {
      // Given: entries = [{ ref: '@e3', role: 'button', name: 'Connect' }]
      //        label = '[OUTBOUND] ' (only the display-prefix, trailing space, NO payload after it)
      //        opts = { kind: 'click' }
      // When:  resolveByLabel(entries, '[OUTBOUND] ', opts) called
      // Then:  THROWS an Error
      //        Error message matches /no click target matches '\[OUTBOUND\] '/
      //        (the ORIGINAL label is cited in the error, NOT the stripped empty string)
      //        Does NOT return any entry
      //        (Without the empty-strip guard, "".includes("") === true for every entry,
      //         causing a wrong-target match or ambiguity error rather than a clean no-match)

      assert.throws(
        () => resolveByLabel(ENTRIES_WITH_CONNECT, "[OUTBOUND] ", CLICK_OPTS),
        (err: Error) => {
          assert.ok(
            err instanceof Error,
            `G-A16.16: must throw an Error; got ${typeof err}`,
          );
          // The error message must cite the ORIGINAL label '[OUTBOUND] ' (not the empty stripped version)
          const pattern = /no click target matches '\[OUTBOUND\] '/;
          assert.ok(
            pattern.test(err.message),
            `G-A16.16: error message must match /no click target matches '\\[OUTBOUND\\] '/. ` +
              `Got: "${err.message}". ` +
              "Without the empty-strip guard this would produce an ambiguity error or wrong-target match.",
          );
          return true;
        },
        "G-A16.16: resolveByLabel('[OUTBOUND] ') must throw a no-match error citing the original label",
      );
    },
  );
});
