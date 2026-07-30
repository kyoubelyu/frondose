/**
 * P-FIX-PICKER-MATCHING — T-PICK.1–.4/.9–.14 pure resolver carriers.
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/linkedin/labelResolverPickerMatching.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolveByLabel, resolveByLabelRanked } from "../../src/linkedin/labelResolver.js";
import type { SnapshotEntry } from "../../src/linkedin/types.js";

type Kind = "click" | "type";

function resolveRefs(entries: SnapshotEntry[], label: string, kind: Kind): [string, string] {
  return [resolveByLabel(entries, label, { kind }).ref, resolveByLabelRanked(entries, label, { kind }).entry.ref];
}

describe("P-FIX-PICKER-MATCHING — whitespace-normalized resolver tiers", () => {
  // Given a newline AX name and spaced label, when both public resolvers run, then normalized exact selects the entry.
  it("T-PICK.1: newline and space variants resolve through normalized exact", () => {
    const entries: SnapshotEntry[] = [{ ref: "@ov1", role: "menuitem", name: "Joyce HE · 1st\n普通职业" }];
    assert.deepEqual(resolveRefs(entries, "Joyce HE · 1st 普通职业", "click"), ["@ov1", "@ov1"]);
    const ranked = resolveByLabelRanked(entries, "Joyce HE · 1st 普通职业", { kind: "click" });
    assert.equal(ranked.disambiguated, false);
  });

  // Given NBSP, tabs, and repeated spaces on opposite sides, when matching runs, then every form normalizes identically.
  it("T-PICK.2: NBSP, tab, and repeated-space variants normalize in both directions", () => {
    const first: SnapshotEntry[] = [{ ref: "@e1", role: "button", name: "Joyce\u00A0 HE\t·  1st" }];
    const second: SnapshotEntry[] = [{ ref: "@e2", role: "button", name: "Joyce HE · 1st" }];
    assert.deepEqual(resolveRefs(first, "Joyce HE · 1st", "click"), ["@e1", "@e1"]);
    assert.deepEqual(resolveRefs(second, "Joyce\u00A0\tHE  · 1st", "click"), ["@e2", "@e2"]);
  });

  // Given two whitespace-only variants and a third raw-distinct label, when matching runs, then both resolvers fail ambiguous.
  it("T-PICK.3: normalized ties never silently collapse to one candidate", () => {
    const entries: SnapshotEntry[] = [
      { ref: "@e1", role: "button", name: "Joyce  HE" },
      { ref: "@e2", role: "button", name: "Joyce\tHE" },
    ];
    assert.throws(() => resolveByLabel(entries, "Joyce\nHE", { kind: "click" }), /ambiguous/i);
    assert.throws(() => resolveByLabelRanked(entries, "Joyce\nHE", { kind: "click" }), /ambiguous/i);
  });

  // Given current exact, substring, region, and overlay semantics, when the new pipeline runs, then existing precedence remains pinned.
  it("T-PICK.4: exact, non-aside, and overlay precedence remain unchanged", () => {
    const exactEntries: SnapshotEntry[] = [
      { ref: "@e1", role: "button", name: "Connect" },
      { ref: "@e2", role: "button", name: "Connect with people" },
    ];
    assert.deepEqual(resolveRefs(exactEntries, "Connect", "click"), ["@e1", "@e1"]);

    const regionEntries: SnapshotEntry[] = [
      { ref: "@e3", role: "button", name: "Invite Joyce to connect" },
      { ref: "@e4", role: "button", name: "Invite Alex to connect", region: "aside" },
    ];
    assert.deepEqual(resolveRefs(regionEntries, "connect", "click"), ["@e3", "@e3"]);

    const overlayEntries: SnapshotEntry[] = [
      { ref: "@e5", role: "button", name: "Send invitation" },
      { ref: "@ov6", role: "button", name: "Send invitation" },
    ];
    assert.equal(
      resolveByLabel(overlayEntries, "Send invitation", { kind: "click", activeLayer: "overlay" }).ref,
      "@ov6",
    );
  });
});

describe("P-FIX-PICKER-MATCHING — empty needles and type callers", () => {
  // Given eligible click and input candidates, when whitespace-only labels run, then both resolvers and both kinds fail closed.
  it("T-PICK.9: empty normalized needles never become wildcard matches", () => {
    const entries: SnapshotEntry[] = [
      { ref: "@e1", role: "button", name: "Start a post" },
      { ref: "@e2", role: "textbox", name: "Search people" },
    ];
    for (const label of ["   ", "\u00A0"]) {
      for (const kind of ["click", "type"] as const) {
        assert.throws(() => resolveByLabel(entries, label, { kind }), /no (click|type) target matches/i);
        assert.throws(() => resolveByLabelRanked(entries, label, { kind }), /no (click|type) target matches/i);
      }
    }
  });

  // Given newline input names and normalized-equal duplicates, when the type resolver runs, then unique resolves and ties stay ambiguous.
  it("T-PICK.10: the unranked type path normalizes unique inputs and rejects normalized ties", () => {
    const unique: SnapshotEntry[] = [{ ref: "@e1", role: "textbox", name: "Search\npeople" }];
    assert.equal(resolveByLabel(unique, "Search people", { kind: "type" }).ref, "@e1");

    const tied: SnapshotEntry[] = [
      { ref: "@e2", role: "textbox", name: "Search\npeople" },
      { ref: "@e3", role: "searchbox", name: "Search\tpeople" },
    ];
    assert.throws(() => resolveByLabel(tied, "Search  people", { kind: "type" }), /ambiguous/i);
  });
});

describe("P-FIX-PICKER-MATCHING — normalized substring, errors, and shared pipeline", () => {
  // Given one normalized substring and a ranked startsWith competitor, when resolution runs, then the intended entries win.
  it("T-PICK.11: normalized substring and ranked startsWith cross whitespace boundaries", () => {
    const one: SnapshotEntry[] = [
      { ref: "@e1", role: "button", name: "Photo of Joyce\nHE profile" },
      { ref: "@e2", role: "button", name: "Unrelated" },
    ];
    assert.deepEqual(resolveRefs(one, "Joyce HE", "click"), ["@e1", "@e1"]);

    const ranked: SnapshotEntry[] = [
      { ref: "@ov1", role: "menuitem", name: "Joyce\nHE profile" },
      { ref: "@ov2", role: "menuitem", name: "Photo of Joyce HE" },
    ];
    const result = resolveByLabelRanked(ranked, "Joyce HE", { kind: "click" });
    assert.equal(result.entry.ref, "@ov1");
    assert.equal(result.method, "startsWith");
  });

  // Given an unnormalized missing label, when no target matches, then the operator-facing error preserves the original bytes.
  it("T-PICK.12: no-match errors retain the original label", () => {
    const label = "Missing\n  target";
    assert.throws(
      () => resolveByLabel([{ ref: "@e1", role: "button", name: "Other" }], label, { kind: "click" }),
      (error: unknown) => error instanceof Error && error.message.includes(label),
    );
  });

  // Given one raw-exact entry and one whitespace variant, when matching runs, then raw exact wins before normalized tiers.
  it("T-PICK.13: case-insensitive raw exact keeps priority over whitespace variants", () => {
    const entries: SnapshotEntry[] = [
      { ref: "@e1", role: "button", name: "Joyce HE" },
      { ref: "@e2", role: "button", name: "Joyce\nHE" },
    ];
    assert.deepEqual(resolveRefs(entries, "joyce he", "click"), ["@e1", "@e1"]);
  });

  // Given both public resolver bodies, when source structure is inspected, then each delegates its match pool to one helper.
  it("T-PICK.14: plain and ranked resolvers share matchLabelCandidates", () => {
    const source = readFileSync(new URL("../../src/linkedin/labelResolver.ts", import.meta.url), "utf8");
    const plainStart = source.indexOf("export function resolveByLabel(");
    const rankedStart = source.indexOf("export function resolveByLabelRanked(");
    const plainBody = source.slice(plainStart, source.indexOf("function ambiguousError", plainStart));
    const rankedBody = source.slice(rankedStart, source.indexOf("function makeAbortError", rankedStart));
    assert.match(plainBody, /matchLabelCandidates\(entries, label, opts\)/);
    assert.match(rankedBody, /matchLabelCandidates\(entries, label, opts\)/);
  });
});
