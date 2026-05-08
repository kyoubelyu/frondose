/**
 * P-3 mock tests — T-M50..T-M53: Label-based element resolution.
 *
 * Tests resolveByLabel() for click (CLICKABLE_ROLES) and type (INPUT_ROLES).
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
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
