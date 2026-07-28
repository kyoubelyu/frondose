/**
 * P-FIX-TYPEAHEAD-TARGETING — T-TYPE.1/2/3/13 mock tests: ranked label resolution.
 *
 * Covers the pure resolver layer (resolveByLabelRanked / rankAmbiguousMatches):
 * evidence-based tie-breaks (startsWith → choice-role family), fail-closed on
 * tie-break-resistant ambiguity, and byte-identical preservation of the existing
 * match pipeline precedence ([OUTBOUND]-strip / exact>substr / non-aside / overlay).
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/linkedin/labelResolverRanked.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveByLabelRanked } from "../../src/linkedin/labelResolver.js";
import type { SnapshotEntry } from "../../src/linkedin/types.js";

const JOYCE = "Joyce HE · 1st 普通职业";

describe("T-TYPE.1 — startsWith tie-break picks the person option over the photo entry", () => {
  it("T-TYPE.1: given two option entries ['Joyce HE · 1st…', 'Photo of Joyce HE'], when label is 'Joyce HE', then the startsWith entry wins with disambiguated=true method=startsWith candidates=2", () => {
    // Given: a typeahead listing the person option AND a photo/search entry sharing the substring.
    // When: resolveByLabelRanked resolves "Joyce HE".
    // Then: the entry whose name STARTS WITH the needle is picked (observed W8 case).
    const entries: SnapshotEntry[] = [
      { ref: "@ov1", role: "menuitem", name: JOYCE },
      { ref: "@ov7", role: "menuitem", name: "Photo of Joyce HE" },
    ];

    const r = resolveByLabelRanked(entries, "Joyce HE", { kind: "click" });

    assert.equal(r.entry.ref, "@ov1");
    assert.equal(r.disambiguated, true);
    assert.equal(r.candidateCount, 2);
    assert.equal(r.method, "startsWith");
  });
});

describe("T-TYPE.2 — choice-role family tie-break after startsWith stays ambiguous", () => {
  it("T-TYPE.2: given two startsWith matches (option + link), when label is 'Joyce HE', then the choice-role (option) entry wins with method=roleFamily", () => {
    // Given: both candidates start with the needle; one is a listbox option, the other a plain link.
    // When: resolveByLabelRanked resolves.
    // Then: the choice-role-family entry wins.
    const entries: SnapshotEntry[] = [
      { ref: "@ov2", role: "menuitem", name: "Joyce HE · 1st" },
      { ref: "@e40", role: "link", name: "Joyce HE profile" },
    ];

    const r = resolveByLabelRanked(entries, "Joyce HE", { kind: "click" });

    assert.equal(r.entry.ref, "@ov2");
    assert.equal(r.disambiguated, true);
    assert.equal(r.method, "roleFamily");
  });
});

describe("T-TYPE.3 — tie-break-resistant ambiguity still throws (fail-closed, no silent pick)", () => {
  it("T-TYPE.3: given two option entries both starting with 'Joyce HE', when label is 'Joyce HE', then the SAME ambiguous error shape as resolveByLabel is thrown with the candidate preview", () => {
    // Given: genuinely indistinguishable candidates (same role, both startsWith).
    // When: resolveByLabelRanked resolves.
    // Then: no arbitrary pick — ambiguous error with candidate refs.
    const entries: SnapshotEntry[] = [
      { ref: "@ov1", role: "menuitem", name: "Joyce HE · 1st" },
      { ref: "@ov2", role: "menuitem", name: "Joyce HE · 2nd" },
    ];

    assert.throws(
      () => resolveByLabelRanked(entries, "Joyce HE", { kind: "click" }),
      (err: unknown) =>
        err instanceof Error &&
        /ambiguous click target 'Joyce HE' \(2 matches\)/.test(err.message) &&
        err.message.includes("@ov1") &&
        err.message.includes("@ov2"),
    );
  });
});

describe("T-TYPE.13 — existing pipeline precedence preserved through the ranked path", () => {
  it("T-TYPE.13a: [OUTBOUND] display-prefix strip resolves identically (single match, disambiguated=false)", () => {
    // Given: an entry whose raw name is unprefixed.
    // When: the label carries the "[OUTBOUND] " display prefix.
    // Then: the prefix is stripped and the entry resolves (P-AUTO-16 OUT-6 behavior intact).
    const entries: SnapshotEntry[] = [{ ref: "@e7", role: "button", name: "Connect" }];
    const r = resolveByLabelRanked(entries, "[OUTBOUND] Connect", { kind: "click" });
    assert.equal(r.entry.ref, "@e7");
    assert.equal(r.disambiguated, false);
    assert.equal(r.candidateCount, 1);
  });

  it("T-TYPE.13b: exact match beats substring matches (no disambiguation)", () => {
    // Given: one exact-name match plus another entry that merely contains the needle.
    // When: resolveByLabelRanked resolves.
    // Then: the exact match wins outright (candidateCount=1, disambiguated=false).
    const entries: SnapshotEntry[] = [
      { ref: "@e8", role: "button", name: "Send" },
      { ref: "@e9", role: "button", name: "Send without a note" },
    ];
    const r = resolveByLabelRanked(entries, "Send", { kind: "click" });
    assert.equal(r.entry.ref, "@e8");
    assert.equal(r.disambiguated, false);
  });

  it("T-TYPE.13c: non-aside drop precedes tie-breaks (aside duplicates ignored)", () => {
    // Given: one non-aside person option plus an aside duplicate sharing the name.
    // When: resolveByLabelRanked resolves.
    // Then: the aside entry is dropped before ranking — single non-aside match, no disambiguation.
    const entries: SnapshotEntry[] = [
      { ref: "@pa1", role: "menuitem", name: JOYCE },
      { ref: "@e101", role: "menuitem", name: JOYCE, region: "aside" },
    ];
    const r = resolveByLabelRanked(entries, "Joyce HE", { kind: "click" });
    assert.equal(r.entry.ref, "@pa1");
    assert.equal(r.disambiguated, false);
  });

  it("T-TYPE.13d: overlay-layer narrowing precedes tie-breaks (@ov entry preferred)", () => {
    // Given: same name on a page entry and an overlay entry, activeLayer=overlay.
    // When: resolveByLabelRanked resolves.
    // Then: overlay narrowing keeps only the @ov entry (no disambiguation).
    const entries: SnapshotEntry[] = [
      { ref: "@e7", role: "button", name: "Invite Jane to connect" },
      { ref: "@ov4", role: "button", name: "Invite Jane to connect" },
    ];
    const r = resolveByLabelRanked(entries, "Invite Jane to connect", { kind: "click", activeLayer: "overlay" });
    assert.equal(r.entry.ref, "@ov4");
    assert.equal(r.disambiguated, false);
  });
});
