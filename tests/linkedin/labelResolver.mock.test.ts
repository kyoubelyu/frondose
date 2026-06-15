/**
 * P-3 mock tests — T-M50..T-M53: Label-based element resolution.
 * P-AUTO-17 Step 3 scaffolds — T-A17.1..T-A17.6: exact-match preference + dialog-scope narrowing.
 *
 * Tests resolveByLabel() for click (CLICKABLE_ROLES) and type (INPUT_ROLES).
 * No Chrome or LLM required.
 *
 * T-A17 scaffolds: all assertion bodies are assert.fail("TODO Step 5") — intentional red-state
 * per outside-in TDD. Tests compile and fail. Assertions are filled at Step 5.
 */

import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { resolveByLabel } from "../../src/linkedin/labelResolver.js";
import type { SnapshotEntry } from "../../src/linkedin/types.js";

const SAMPLE_ENTRIES: SnapshotEntry[] = [
  { ref: "@e1", role: "button", name: "Start a post" },
  { ref: "@e2", role: "link", name: "Home" },
  { ref: "@e3", role: "textbox", name: "Search field" },
  { ref: "@e4", role: "button", name: "Like this post" },
  { ref: "@e5", role: "menuitem", name: "Share" },
];

// ─── T-M50 ─────────────────────────────────────────────────────────────────────

test("T-M50: resolveByLabel finds a unique button by exact label (case-insensitive)", () => {
  const entry = resolveByLabel(SAMPLE_ENTRIES, "Start a post", { kind: "click" });
  assert.equal(entry.ref, "@e1", "must return @e1 for 'Start a post'");
  assert.equal(entry.name, "Start a post");
});

// ─── T-M51 ─────────────────────────────────────────────────────────────────────

test("T-M51: resolveByLabel matches by partial, case-insensitive substring", () => {
  // 'start a post' is substring of 'Start a post' (case-insensitive)
  const entry1 = resolveByLabel(SAMPLE_ENTRIES, "start", { kind: "click" });
  assert.equal(entry1.ref, "@e1");

  // 'home' matches 'Home'
  const entry2 = resolveByLabel(SAMPLE_ENTRIES, "home", { kind: "click" });
  assert.equal(entry2.ref, "@e2");

  // 'search' matches 'Search field' (type — INPUT_ROLES)
  const entry3 = resolveByLabel(SAMPLE_ENTRIES, "search", { kind: "type" });
  assert.equal(entry3.ref, "@e3");
});

// ─── T-M52 ─────────────────────────────────────────────────────────────────────

test("T-M52: resolveByLabel throws on no match with descriptive error", () => {
  assert.throws(
    () => resolveByLabel(SAMPLE_ENTRIES, "nonexistent label xyz", { kind: "click" }),
    (err: unknown) => {
      if (!(err instanceof Error)) return false;
      return (
        err.message.includes("nonexistent label xyz") &&
        (err.message.includes("no click target") || err.message.includes("no match") || err.message.includes("matches"))
      );
    },
    "no-match must throw an error mentioning the label",
  );

  // type role restriction — textbox/searchbox/combobox/textarea only; 'button' entries don't qualify
  assert.throws(
    () => resolveByLabel(SAMPLE_ENTRIES, "Start a post", { kind: "type" }),
    /no type target|no match|matches/i,
    "button element must not be found when kind='type'",
  );
});

// ─── T-M53 ─────────────────────────────────────────────────────────────────────

test("T-M53: resolveByLabel throws on ambiguous match with candidates preview", () => {
  const entries: SnapshotEntry[] = [
    { ref: "@e1", role: "button", name: "Like post A" },
    { ref: "@e2", role: "button", name: "Like post B" },
    { ref: "@e3", role: "link", name: "Like profile" },
  ];

  // 'like' matches all 3 — ambiguous
  assert.throws(
    () => resolveByLabel(entries, "like", { kind: "click" }),
    (err: unknown) => {
      if (!(err instanceof Error)) return false;
      return err.message.toLowerCase().includes("ambiguous") && err.message.includes("like");
    },
    "ambiguous label must throw an error mentioning 'ambiguous'",
  );

  // The error must include the count and candidate hints
  try {
    resolveByLabel(entries, "like", { kind: "click" });
    assert.fail("must have thrown");
  } catch (err) {
    if (err instanceof Error) {
      assert.ok(
        err.message.includes("3") || err.message.includes("matches"),
        "error must mention match count or candidates",
      );
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// P-AUTO-17 Step 3 — T-A17.1..T-A17.6 scaffolds
// All assertion bodies are TODO (assert.fail("TODO Step 5")) — intentional red-state.
// The tests compile and fail until Step 5 fills them.
// ═══════════════════════════════════════════════════════════════════════════════

describe("T-A17 — resolveByLabel: exact-match preference + dialog-scope narrowing (P-AUTO-17 Part 1)", () => {
  // ─── T-A17.1 ─────────────────────────────────────────────────────────────
  it("T-A17.1: when entries contain both exact and substring matches, resolveByLabel returns the exact match (G-A17.1)", () => {
    // Given: entries = [{ref:"@e1", role:"button", name:"Connect"},
    //                   {ref:"@e2", role:"button", name:"Connect with friends"},
    //                   {ref:"@e3", role:"button", name:"Reconnect"}]
    // When:  resolveByLabel(entries, "Connect", {kind:"click"}) is called
    // Then:  returns the entry with ref==="@e1" (exact match wins), NOT ambiguous_target
    const entries: SnapshotEntry[] = [
      { ref: "@e1", role: "button", name: "Connect" },
      { ref: "@e2", role: "button", name: "Connect with friends" },
      { ref: "@e3", role: "button", name: "Reconnect" },
    ];
    const result = resolveByLabel(entries, "Connect", { kind: "click" });
    assert.equal(result.ref, "@e1", "exact match must win over substring matches; got ref=" + result.ref);
    assert.equal(result.name, "Connect");
  });

  // ─── T-A17.2 ─────────────────────────────────────────────────────────────
  it("T-A17.2: when no exact match exists, substring fallback fires (T-M51 regression gate) (G-A17.2)", () => {
    // Given: SAMPLE_ENTRIES fixture (no entry literally named "search"; @e3 is "Search field")
    // When:  resolveByLabel(SAMPLE_ENTRIES, "search", {kind:"type"}) called
    // Then:  returns @e3 (substring fallback fires when no exact exists) — byte-identical to T-M51
    const result = resolveByLabel(SAMPLE_ENTRIES, "search", { kind: "type" });
    assert.equal(result.ref, "@e3", "substring fallback must resolve 'search' → '@e3' (Search field)");
    assert.equal(result.name, "Search field");
  });

  // ─── T-A17.3 ─────────────────────────────────────────────────────────────
  it("T-A17.3: when activeLayer='overlay' and @ov entry matches, returns the overlay-scoped entry (G-A17.3)", () => {
    // Given: entries = [{ref:"@e7", role:"button", name:"Send invitation"} /* page-level */,
    //                   {ref:"@ov4", role:"button", name:"Send invitation"} /* modal inner-button */]
    // When:  resolveByLabel(entries, "Send invitation", {kind:"click", activeLayer:"overlay"}) called
    // Then:  returns @ov4 (overlay-scoped winner) — NOT ambiguous_target
    const entries: SnapshotEntry[] = [
      { ref: "@e7", role: "button", name: "Send invitation" },
      { ref: "@ov4", role: "button", name: "Send invitation" },
    ];
    const result = resolveByLabel(entries, "Send invitation", { kind: "click", activeLayer: "overlay" });
    assert.equal(result.ref, "@ov4", "overlay-scoped entry must win when activeLayer='overlay'; got " + result.ref);
    assert.equal(result.name, "Send invitation");
  });

  // ─── T-A17.4 ─────────────────────────────────────────────────────────────
  it("T-A17.4: when activeLayer='overlay' but no @ov entries, falls back to page-level pool gracefully (G-A17.4)", () => {
    // Given: entries = [{ref:"@e7", role:"button", name:"Send invitation"}]
    //        (no @ov entries despite activeLayer="overlay" — dialog closed mid-snapshot)
    // When:  resolveByLabel(entries, "Send invitation", {kind:"click", activeLayer:"overlay"}) called
    // Then:  returns @e7 (overlay narrow empty → fall back to page pool; no spurious no-match throw)
    const entries: SnapshotEntry[] = [
      { ref: "@e7", role: "button", name: "Send invitation" },
    ];
    const result = resolveByLabel(entries, "Send invitation", { kind: "click", activeLayer: "overlay" });
    assert.equal(result.ref, "@e7", "when no @ov entries exist, must fall back to page pool and return @e7");
    assert.equal(result.name, "Send invitation");
  });

  // ─── T-A17.5 ─────────────────────────────────────────────────────────────
  it("T-A17.5: when activeLayer='page', behavior is byte-identical to omitting activeLayer (G-A17.5)", () => {
    // Given: entries with one unique button
    // When:  resolveByLabel(entries, label, {kind:"click", activeLayer:"page"})
    //        vs resolveByLabel(entries, label, {kind:"click"}) with identical other args
    // Then:  both return the same entry (overlay narrowing only fires when activeLayer is exactly "overlay")
    const entries: SnapshotEntry[] = [
      { ref: "@e1", role: "button", name: "Start a post" },
    ];
    const withPage = resolveByLabel(entries, "Start a post", { kind: "click", activeLayer: "page" });
    const withoutLayer = resolveByLabel(entries, "Start a post", { kind: "click" });
    assert.equal(withPage.ref, withoutLayer.ref, "activeLayer='page' must return same ref as omitting the field");
    assert.equal(withPage.ref, "@e1");
  });

  // ─── T-A17.6 ─────────────────────────────────────────────────────────────
  it("T-A17.6: [OUTBOUND] prefix-strip routes through exact-match preference (OUT-6 forward-compat) (G-A17.6)", () => {
    // Given: entries = [{ref:"@e1", role:"button", name:"Connect"},
    //                   {ref:"@e2", role:"button", name:"Connect with people"}]
    // When:  resolveByLabel(entries, "[OUTBOUND] Connect", {kind:"click"}) called
    // Then:  returns @e1 (prefix-strip → "Connect" → exact match wins — same as G-A17.1 path)
    const entries: SnapshotEntry[] = [
      { ref: "@e1", role: "button", name: "Connect" },
      { ref: "@e2", role: "button", name: "Connect with people" },
    ];
    const result = resolveByLabel(entries, "[OUTBOUND] Connect", { kind: "click" });
    assert.equal(result.ref, "@e1", "prefix-strip + exact-match must resolve '[OUTBOUND] Connect' → '@e1'");
    assert.equal(result.name, "Connect");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P-AUTO-18 Step 5 — T-A18.1..T-A18.5 (assertion bodies filled)
// `as any` casts removed — SnapshotEntry.region?: "aside" is now in the type
// after Codex Step 4 landed the widening.
// ═══════════════════════════════════════════════════════════════════════════════

describe("T-A18 — connect-family region preference (P-AUTO-18)", () => {
  // ─── T-A18.1 ───────────────────────────────────────────────────────────────
  it(
    "T-A18.1: when subject @pa1 has no region and sidebar @e* entries have region:'aside', resolveByLabel('Connect') returns @pa1 only (G-A18.1)",
    () => {
      // Given: entries = [{ref:"@pa1", role:"link", name:"Invite Jane Subject to connect" /* no region */},
      //                   {ref:"@e147", role:"button", name:"Invite Fernando Sienkiewicz Luz to connect", region:"aside"},
      //                   {ref:"@e149", role:"button", name:"Invite Matt Kavanagh to connect", region:"aside"},
      //                   {ref:"@e151", role:"button", name:"Invite Viktor Idhammar to connect", region:"aside"}]
      // When:  resolveByLabel(entries, "Connect", {kind:"click"}) called
      // Then:  returns @pa1 (sole non-aside substring match); no ambiguous_target throw
      const entries: SnapshotEntry[] = [
        { ref: "@pa1", role: "link", name: "Invite Jane Subject to connect" },
        { ref: "@e147", role: "button", name: "Invite Fernando Sienkiewicz Luz to connect", region: "aside" },
        { ref: "@e149", role: "button", name: "Invite Matt Kavanagh to connect", region: "aside" },
        { ref: "@e151", role: "button", name: "Invite Viktor Idhammar to connect", region: "aside" },
      ];
      const result = resolveByLabel(entries, "Connect", { kind: "click" });
      assert.equal(result.ref, "@pa1", "connect-family region preference must drop aside entries; only @pa1 (no region) remains");
      assert.equal(result.name, "Invite Jane Subject to connect");
    },
  );

  // ─── T-A18.2 ───────────────────────────────────────────────────────────────
  it(
    "T-A18.2: when ALL candidates have region:'aside' (sidebar-only — 0 non-aside), resolveByLabel still throws ambiguous_target (fallback keeps aside set visible) (G-A18.2)",
    () => {
      // Given: entries = [{ref:"@e147", role:"button", name:"Invite A to connect", region:"aside"},
      //                   {ref:"@e149", role:"button", name:"Invite B to connect", region:"aside"}]
      //        (1st-degree profile — no primary connect button in main region)
      // When:  resolveByLabel(entries, "Connect", {kind:"click"}) called
      // Then:  throws ambiguous_target with both @e147 and @e149 in the error message
      //        (region preference DOES NOT engage when 0 non-aside candidates exist)
      const entries: SnapshotEntry[] = [
        { ref: "@e147", role: "button", name: "Invite A to connect", region: "aside" },
        { ref: "@e149", role: "button", name: "Invite B to connect", region: "aside" },
      ];
      assert.throws(
        () => resolveByLabel(entries, "Connect", { kind: "click" }),
        (err: unknown) => {
          if (!(err instanceof Error)) return false;
          // Must be ambiguous (not no-match) — both aside entries kept in the candidate set
          const msg = err.message.toLowerCase();
          return (
            msg.includes("ambiguous") &&
            err.message.includes("@e147") &&
            err.message.includes("@e149")
          );
        },
        "when 0 non-aside candidates exist, region preference must NOT engage — both aside entries stay → ambiguous_target",
      );
    },
  );

  // ─── T-A18.3 ───────────────────────────────────────────────────────────────
  it(
    "T-A18.3: when label is 'Message' (non-connect), region preference is no-op and resolveByLabel throws ambiguous_target for both main+aside candidates (G-A18.3)",
    () => {
      // Given: entries = [{ref:"@pa2", role:"button", name:"Message Jane" /* no region */},
      //                   {ref:"@e88", role:"button", name:"Message in aside", region:"aside"}]
      // When:  resolveByLabel(entries, "Message", {kind:"click"}) called
      // Then:  throws ambiguous_target with BOTH @pa2 and @e88 (CONNECT_OPEN_RE does not match
      //        "Message" → region clause is never activated)
      const entries: SnapshotEntry[] = [
        { ref: "@pa2", role: "button", name: "Message Jane" },
        { ref: "@e88", role: "button", name: "Message in aside", region: "aside" },
      ];
      assert.throws(
        () => resolveByLabel(entries, "Message", { kind: "click" }),
        (err: unknown) => {
          if (!(err instanceof Error)) return false;
          // Must be ambiguous with BOTH candidates present (region clause did NOT fire)
          const msg = err.message.toLowerCase();
          return (
            msg.includes("ambiguous") &&
            err.message.includes("@pa2") &&
            err.message.includes("@e88")
          );
        },
        "non-connect label 'Message' must not activate region preference — both @pa2 (main) and @e88 (aside) stay → ambiguous_target",
      );
    },
  );

  // ─── T-A18.4 ───────────────────────────────────────────────────────────────
  it(
    "T-A18.4: when an exact 'Connect' match exists alongside aside 'Invite … to connect' entries, exact-match wins before region preference fires (G-A18.4 — T-A17.1 regression gate)",
    () => {
      // Given: entries = [{ref:"@e1", role:"button", name:"Connect" /* exact match, no region */},
      //                   {ref:"@e147", role:"button", name:"Invite Fernando to connect", region:"aside"},
      //                   {ref:"@e149", role:"button", name:"Invite Matt to connect", region:"aside"}]
      // When:  resolveByLabel(entries, "Connect", {kind:"click"}) called
      // Then:  returns @e1 (exact match set has length 1 → exact wins; region preference never activates)
      const entries: SnapshotEntry[] = [
        { ref: "@e1", role: "button", name: "Connect" },
        { ref: "@e147", role: "button", name: "Invite Fernando to connect", region: "aside" },
        { ref: "@e149", role: "button", name: "Invite Matt to connect", region: "aside" },
      ];
      const result = resolveByLabel(entries, "Connect", { kind: "click" });
      assert.equal(result.ref, "@e1", "exact match @e1 must win before region preference fires — exact set has length 1");
      assert.equal(result.name, "Connect");
    },
  );

  // ─── T-A18.5 ───────────────────────────────────────────────────────────────
  it(
    "T-A18.5: when region preference drops aside and overlay narrowing reduces to @ov4, the order is: substring → region-drops-aside → overlay-wins (G-A18.5 — T-A17.3 regression gate)",
    () => {
      // Given: entries = [{ref:"@e7",   role:"button", name:"Invite Jane to connect"      /* main region, no region field */},
      //                   {ref:"@e147", role:"button", name:"Invite Fernando to connect", region:"aside" /* sidebar */},
      //                   {ref:"@ov4",  role:"button", name:"Invite Jane to connect"      /* modal inner-button, @ov prefix */}]
      // When:  resolveByLabel(entries, "Connect", {kind:"click", activeLayer:"overlay"}) called
      //        ("Connect" satisfies CONNECT_OPEN_RE — triggers the region preference clause)
      // Then:  returns @ov4
      //        Order: substring matches all 3 ("connect" appears in every name)
      //        → CONNECT_OPEN_RE.test("Connect")=true → region preference drops @e147 (aside)
      //        → 2 left (@e7, @ov4) → overlay narrowing keeps only @ov → returns @ov4
      const entries: SnapshotEntry[] = [
        { ref: "@e7", role: "button", name: "Invite Jane to connect" },
        { ref: "@e147", role: "button", name: "Invite Fernando to connect", region: "aside" },
        { ref: "@ov4", role: "button", name: "Invite Jane to connect" },
      ];
      const result = resolveByLabel(entries, "Connect", { kind: "click", activeLayer: "overlay" });
      assert.equal(result.ref, "@ov4", "order must be: substr(all3) → region-drops-@e147 → overlay-keeps-@ov4; got " + result.ref);
      assert.equal(result.name, "Invite Jane to connect");
    },
  );
});
