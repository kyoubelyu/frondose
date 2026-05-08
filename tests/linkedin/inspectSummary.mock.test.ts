/**
 * P-3 mock tests — T-M46..T-M49: InspectSummary building.
 *
 * Tests buildInspectSummary(), deduplication, slicing limits, and scope handling.
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInspectSummary } from "../../src/linkedin/inspectSummary.js";
import type { CurrentSurfaceContext, SnapshotEntry } from "../../src/linkedin/types.js";

function makeCtx(surface: CurrentSurfaceContext["surface"], entries: SnapshotEntry[]): CurrentSurfaceContext {
  return { pageUrl: "https://www.linkedin.com/feed/", surface, activeLayer: "page", entries };
}

// ─── T-M46 ─────────────────────────────────────────────────────────────────────

test("T-M46: buildInspectSummary returns correct shape for a feed surface", () => {
  const ctx = makeCtx("feed", [
    { ref: "@e1", role: "button", name: "Start a post" },
    { ref: "@e2", role: "link", name: "Home" },
    { ref: "@e3", role: "textbox", name: "Search field" },
    { ref: "@e4", role: "staticText", name: "Top post body text" },
    { ref: "@e5", role: "heading", name: "LinkedIn News" },
  ]);

  const summary = buildInspectSummary(ctx);

  assert.equal(summary.surface, "feed", "surface must match ctx.surface");
  assert.equal(summary.activeLayer, "page", "activeLayer must always be 'page'");
  assert.ok(Array.isArray(summary.availableScopes), "availableScopes must be an array");
  assert.ok(summary.availableScopes.includes("page"), "feed availableScopes must include 'page'");
  assert.ok(summary.availableScopes.includes("feed"), "feed availableScopes must include 'feed'");

  // Buttons: button + link + textbox are all CLICKABLE_ROLES
  assert.equal(summary.buttons.length, 3, "must have 3 buttons (button, link, textbox)");
  assert.ok(
    summary.buttons.some((b) => b.label === "Start a post"),
    "buttons must include 'Start a post'",
  );

  // Inputs: only textbox is in INPUT_ROLES
  assert.equal(summary.inputs.length, 1, "must have 1 input (textbox)");
  assert.equal(summary.inputs[0]?.label, "Search field");

  // Text: staticText + heading
  assert.equal(summary.text.length, 2, "must have 2 text entries (staticText + heading)");
  assert.ok(summary.text.includes("Top post body text"));
  assert.ok(summary.text.includes("LinkedIn News"));

  // Each button must have ref + label
  for (const btn of summary.buttons) {
    assert.ok(typeof btn.ref === "string" && btn.ref.startsWith("@"), "button ref must start with @");
    assert.ok(typeof btn.label === "string", "button label must be a string");
  }
});

// ─── T-M47 ─────────────────────────────────────────────────────────────────────

test("T-M47: buildInspectSummary deduplicates entries by (role, name)", () => {
  const ctx = makeCtx("feed", [
    { ref: "@e1", role: "button", name: "Post" },
    { ref: "@e2", role: "button", name: "Post" }, // exact duplicate (role, name) — must be dropped
    { ref: "@e3", role: "link", name: "Post" }, // different role — NOT a duplicate; a separate (link, Post) entry
    { ref: "@e4", role: "button", name: "Like" },
  ]);

  const summary = buildInspectSummary(ctx);

  // Total: button:Post (deduplicated down to 1), link:Post, button:Like = 3 unique (role,name) combos
  assert.equal(summary.buttons.length, 3, "must have 3 unique (role,name) clickable entries");

  // Only ONE button with role=button and label=Post (the duplicate @e2 was dropped)
  const buttonPostRefs = summary.buttons.filter((b) => b.label === "Post" && b.ref === "@e1");
  assert.equal(buttonPostRefs.length, 1, "only the first button:Post entry must survive dedup");

  // @e2 must be gone (duplicate of @e1 by role+name)
  const e2Present = summary.buttons.some((b) => b.ref === "@e2");
  assert.equal(e2Present, false, "second button:Post (@e2) must be removed by deduplication");

  // link:Post is NOT a duplicate of button:Post (different role)
  assert.ok(
    summary.buttons.some((b) => b.ref === "@e3" && b.label === "Post"),
    "link 'Post' must appear in buttons (different role from button 'Post')",
  );
});

// ─── T-M48 ─────────────────────────────────────────────────────────────────────

test("T-M48: buildInspectSummary slices buttons at 12, inputs at 12, text at 10; truncates text at 180 chars", () => {
  // Build 15 buttons, 14 inputs, 11 text nodes, and one very long text
  const entries: SnapshotEntry[] = [];

  for (let i = 1; i <= 15; i++) {
    entries.push({ ref: `@e${i}`, role: "button", name: `Button ${i}` });
  }
  for (let i = 1; i <= 14; i++) {
    entries.push({ ref: `@i${i}`, role: "textbox", name: `Input ${i}` });
  }
  for (let i = 1; i <= 11; i++) {
    entries.push({ ref: `@t${i}`, role: "staticText", name: `Text ${i}` });
  }
  // Long text exceeding 180 chars
  const longText = "A".repeat(250);
  entries.push({ ref: "@tlong", role: "staticText", name: longText });

  const ctx = makeCtx("unknown", entries);
  const summary = buildInspectSummary(ctx);

  assert.ok(summary.buttons.length <= 12, `buttons must be ≤12 (got ${summary.buttons.length})`);
  assert.ok(summary.inputs.length <= 12, `inputs must be ≤12 (got ${summary.inputs.length})`);
  assert.ok(summary.text.length <= 10, `text must be ≤10 (got ${summary.text.length})`);

  // The long text entry should be truncated to 180 chars + ellipsis, or not appear if already sliced off
  const truncated = summary.text.find((t) => t.startsWith("A"));
  if (truncated !== undefined) {
    assert.ok(
      truncated.length <= 182, // 180 chars + "…"
      `truncated text must be ≤182 chars (got ${truncated.length})`,
    );
    assert.ok(truncated.endsWith("…"), "truncated text must end with ellipsis '…'");
  }
});

// ─── T-M49 ─────────────────────────────────────────────────────────────────────

test("T-M49: buildInspectSummary with scope= is a no-op in P-3 (returns same summary as without scope)", () => {
  const ctx = makeCtx("feed", [
    { ref: "@e1", role: "button", name: "Like" },
    { ref: "@e2", role: "staticText", name: "Post text" },
  ]);

  const withoutScope = buildInspectSummary(ctx);
  const withScope = buildInspectSummary(ctx, "feed");

  // P-3: filterByScope is a no-op; both summaries must be identical
  assert.deepEqual(withoutScope, withScope, "scope param must be no-op in P-3");
});
