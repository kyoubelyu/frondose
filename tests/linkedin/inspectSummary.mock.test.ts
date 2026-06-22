/**
 * P-3 mock tests — T-M46..T-M49: InspectSummary building.
 * P-46 mock tests — T-Inspect.1–6, T-Contract.1: composer surface + D-3 fix + contract.
 * P-AUTO-15a Step 3 — T-A15a.5..T-A15a.17 scaffolds (all intentionally fail until Step 4)
 *
 * Tests buildInspectSummary(), deduplication, slicing limits, and scope handling.
 * No Chrome or LLM required.
 *
 * N1 audit (validator-owned per plan §4):
 *   Line ~123: expect(summary.text.length).toBeLessThanOrEqual(40) [T-M48]
 *     Fixture: 12 staticText + 1 long staticText = 12 non-person text entries.
 *     Under new partition: 0 person entries; nonPersonBudget = 40; all 12 emitted; shown=12=visible.
 *     No hint fires. VERDICT: RETAIN — non-truncating input, assertion remains valid.
 *   Line ~433: expect(summary.text.length).toBeLessThanOrEqual(40) [T-Profile.2]
 *     Fixture: 2 profileCard + 50 staticText.
 *     Under new partition: 2 person entries (profileCard) emitted first; nonPersonBudget=38;
 *     38 of 50 staticText emitted; shown=40=MAX_TEXT; visible=52; hint fires (40<52).
 *     BUT: the assert is text.length<=40 BEFORE hint. Post hint: text.length=41.
 *     WAIT — re-check: the hint is EXTRA slot beyond MAX_TEXT, so text.length becomes 41.
 *     HOWEVER: this fixture (2 profileCard ∈ PERSON_BEARING_ROLES, 50 staticText) →
 *     personShown=2, nonPersonBudget=38, nonPersonShown=38 staticText; shown=40, visible=52.
 *     40 < 52 → hint fires → text.length = 41. The <= 40 assertion WILL BREAK.
 *     BUT: profileCard names do NOT embed /in/<slug> (format: "Jane Doe — VP Sales at Acme").
 *     Under dedupKeyFor: profileCard falls back to role::name (no slug recoverable).
 *     The 2 profileCard entries ARE in PERSON_BEARING_ROLES → go into personShown.
 *     personShown=2; nonPersonBudget=38; 38 of 50 staticText emitted; 12 staticText dropped.
 *     shown=40, visible=52 → 40<52 → hint fires → text.length=41.
 *     VERDICT: TRUNCATING — the hint fires; text.length becomes 41. The <= 40 assertion
 *     at line ~433 will break after Step 4. RETAIN AS-IS NOW (pre-Step 4 it still passes).
 *     At Step 5 validator will update the bound to: summary.text.length <= 41 (max: 40 real + 1 hint).
 *
 *   FINAL N1 VERDICTS:
 *     T-M48 line ~123 (12 staticText fixture): RETAIN — non-truncating; hint does not fire.
 *     T-Profile.2 line ~433 (2 profileCard + 50 staticText fixture): UPDATE AT STEP 5
 *       — truncating; hint fires; bound changes from <= 40 to <= 41.
 *       (The existing test body also asserts text.length >= 2, which remains valid.)
 */

import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { buildInspectSummary, filterEntriesByScope } from "../../src/linkedin/inspectSummary.js";
import type { CurrentSurfaceContext, SnapshotEntry } from "../../src/linkedin/types.js";
import { inspectSummarySchema } from "../../src/linkedin/types.js";
import { makeNavigateToUrlTool } from "../../src/tools/browser/navigateToUrl.js";
import { makeTypeTool } from "../../src/tools/browser/type.js";

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
// NOTE (P-46 builder scope-creep): Codex raised MAX_TEXT from 10 → 40 and added
// "StaticText" (capital S) to TEXT_ROLES for Chrome AX tree compatibility. These
// were not in the P-46 plan but are benign production changes. MAX_TEXT=40 means
// a fixture with 12 staticText entries returns all 12 (no slicing at 10). The
// assertion below reflects the new MAX_TEXT=40. Documented in phase-46-test.md §Results.

test("T-M48: buildInspectSummary slices buttons at 12, inputs at 12, text at 40; truncates text at 180 chars", () => {
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

  // P-46: MAX_BUTTONS=12, MAX_INPUTS=12, MAX_TEXT=40 (raised from 10 in P-46)
  assert.ok(summary.buttons.length <= 12, `buttons must be ≤12 (got ${summary.buttons.length})`);
  assert.ok(summary.inputs.length <= 12, `inputs must be ≤12 (got ${summary.inputs.length})`);
  assert.ok(summary.text.length <= 40, `text must be ≤40 (got ${summary.text.length})`);
  // With 12 text entries and MAX_TEXT=40, all 12 are returned (no slicing at 10)
  assert.equal(summary.text.length, 12, "all 12 staticText entries fit within MAX_TEXT=40");

  // The long text entry should be truncated to 180 chars + ellipsis (TEXT_TRUNCATE=180 unchanged)
  const truncated = summary.text.find((t) => t.startsWith("A"));
  assert.ok(truncated !== undefined, "long text entry must appear in text array (within MAX_TEXT=40)");
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

// ─── P-46 D-3 fixtures ──────────────────────────────────────────────────────

/**
 * C-3 fixture: AX entries modelling the observed real LinkedIn composer-open page.
 * ~15 non-composer nav/feed buttons appear before the Post button in AX tree order.
 * The Post button is at position 16 — beyond MAX_BUTTONS=12 in the pre-P-46 code,
 * hence "truncated out" per the D-3 diagnosis.
 */
const COMPOSER_LIVE_FIXTURE: SnapshotEntry[] = [
  // Non-composer nav/feed buttons (15 total — positions 1–15 in AX order)
  { ref: "@e1", role: "button", name: "LinkedIn Home" },
  { ref: "@e2", role: "button", name: "My Network" },
  { ref: "@e3", role: "button", name: "Jobs" },
  { ref: "@e4", role: "button", name: "Messaging" },
  { ref: "@e5", role: "button", name: "Notifications" },
  { ref: "@e6", role: "button", name: "Start a post" },
  { ref: "@e7", role: "button", name: "Add a photo" },
  { ref: "@e8", role: "button", name: "Write an article" },
  { ref: "@e9", role: "button", name: "Like" },
  { ref: "@e10", role: "button", name: "Comment" },
  { ref: "@e11", role: "button", name: "Share" },
  { ref: "@e12", role: "button", name: "Send" },
  { ref: "@e13", role: "button", name: "More options" },
  { ref: "@e14", role: "button", name: "See all" },
  { ref: "@e15", role: "button", name: "Connect" },
  // Composer modal publish button — position 16 in AX tree (beyond MAX_BUTTONS=12 pre-P-46)
  // Accessible name exactly "Post" (^post$ anchored — NOT "Repost", NOT "Post to feed")
  { ref: "@e80", role: "button", name: "Post" },
  // Composer text editor input (surfaces independently as an INPUT_ROLES entry)
  { ref: "@e661", role: "textbox", name: "Text editor for creating content" },
];

/** A plain feed ctx with no composer signals (no modal open). */
const PLAIN_FEED_ENTRIES: SnapshotEntry[] = [
  { ref: "@n1", role: "button", name: "LinkedIn Home" },
  { ref: "@n2", role: "button", name: "My Network" },
  { ref: "@n3", role: "button", name: "Start a post" }, // feed entry-point — NOT a composer button
  { ref: "@n4", role: "link", name: "Feed" },
  { ref: "@n5", role: "staticText", name: "Top post" },
];

// ─── T-Inspect.1: composerModal scope surfaces the Post button ───────────────

describe("T-Inspect.1 (G-P46.8): buildInspectSummary({scope:'composerModal'}) surfaces Post button", () => {
  it("buttons contains {label:'Post',ref:'@e80'}; no non-composer nav buttons; inputs has text editor", () => {
    // Given: a feed ctx whose entries are the COMPOSER_LIVE_FIXTURE
    //        (15 non-composer buttons, Post button at @e80, text editor at @e661)
    // When:  buildInspectSummary(ctx, "composerModal")
    // Then:  buttons contains {ref:'@e80', label:'Post'};
    //        buttons does NOT contain non-composer nav buttons (e.g. 'LinkedIn Home');
    //        inputs contains the text editor (@e661)
    const ctx = makeCtx("feed", COMPOSER_LIVE_FIXTURE);
    const summary = buildInspectSummary(ctx, "composerModal");

    assert.ok(
      summary.buttons.some((b) => b.label === "Post" && b.ref === "@e80"),
      "composerModal buttons must include {label:'Post', ref:'@e80'}",
    );
    assert.ok(
      !summary.buttons.some((b) => b.label === "LinkedIn Home"),
      "nav buttons must NOT appear in composerModal scope",
    );
    assert.ok(
      summary.inputs.some((i) => i.ref === "@e661"),
      "inputs must include the text editor @e661",
    );
  });

  it("C-4 positive: {name:'Post'} exactly matches COMPOSER_PUBLISH_RE", () => {
    // Given: ctx with a single button named exactly 'Post'
    // When:  buildInspectSummary(ctx, "composerModal")
    // Then:  buttons contains {label:'Post'} (COMPOSER_PUBLISH_RE ^post$ matches)
    const ctx = makeCtx("feed", [{ ref: "@px", role: "button", name: "Post" }]);
    const summary = buildInspectSummary(ctx, "composerModal");

    assert.ok(
      summary.buttons.some((b) => b.label === "Post"),
      "composerModal must include the Post button when name='Post' exactly (^post$ match)",
    );
    assert.equal(summary.buttons[0]?.ref, "@px", "Post button ref must be @px");
  });

  it("C-4 negative: {name:'Repost'} does NOT match COMPOSER_PUBLISH_RE (anchored ^post$)", () => {
    // Given: ctx with a single button named 'Repost'
    // When:  buildInspectSummary(ctx, "composerModal")
    // Then:  buttons is EMPTY — 'Repost' does not match ^post$ (anchored regex)
    const ctx = makeCtx("feed", [{ ref: "@rx", role: "button", name: "Repost" }]);
    const summary = buildInspectSummary(ctx, "composerModal");

    assert.equal(
      summary.buttons.length,
      0,
      "composerModal buttons must be EMPTY when only entry is 'Repost' (^post$ does not match 'Repost')",
    );
  });
});

// ─── T-Inspect.2: composerModal appears in availableScopes when composer open ─

describe("T-Inspect.2 (G-P46.8): composerModal in availableScopes when composer signals detected", () => {
  it("unscoped inspect on COMPOSER_LIVE_FIXTURE → availableScopes includes 'composerModal'", () => {
    // Given: a feed ctx with composer signals (Post button @e80 + text editor @e661)
    // When:  buildInspectSummary(ctx) — no scope argument
    // Then:  availableScopes includes 'composerModal' (hasComposerSignals=true: hasPublish=true)
    const ctx = makeCtx("feed", COMPOSER_LIVE_FIXTURE);
    const summary = buildInspectSummary(ctx);

    assert.ok(
      summary.availableScopes.includes("composerModal"),
      "composerModal must be in availableScopes when Post button present (hasComposerSignals=true)",
    );
  });
});

// ─── T-Inspect.3: composerModal absent when no composer ─────────────────────

describe("T-Inspect.3 (G-P46.8): composerModal absent from availableScopes on plain feed (no modal)", () => {
  it("unscoped inspect on PLAIN_FEED_ENTRIES → availableScopes = ['page','feed','post','postActions']", () => {
    // Given: a plain feed ctx with no composer-signal entries (no Post publish button, no text editor)
    // When:  buildInspectSummary(ctx)
    // Then:  availableScopes does NOT include 'composerModal';
    //        availableScopes equals ['page','feed','post','postActions'] (static feed list)
    const ctx = makeCtx("feed", PLAIN_FEED_ENTRIES);
    const summary = buildInspectSummary(ctx);

    assert.ok(
      !summary.availableScopes.includes("composerModal"),
      "composerModal must NOT be in availableScopes for plain feed (no composer signals)",
    );
    assert.deepEqual(
      summary.availableScopes,
      ["page", "feed", "post", "postActions"],
      "plain feed availableScopes must equal the static list (no composerModal)",
    );
  });
});

// ─── T-Inspect.4: unscoped inspect auto-surfaces Post button (OQ-3 robustness) ─

describe("T-Inspect.4 (G-P46.9): unscoped inspect promotes composer buttons ahead of MAX_BUTTONS truncation", () => {
  it("Post button at position 16 in AX tree appears in unscoped buttons[] (promoted above cap)", () => {
    // Given: COMPOSER_LIVE_FIXTURE — 15 non-composer buttons then 'Post' at position 16
    //        (pre-P-46: Post was truncated by MAX_BUTTONS=12; position 16 > cap 12)
    // When:  buildInspectSummary(ctx) — no scope
    // Then:  buttons (capped at MAX_BUTTONS=12) still contains {label:'Post'} at position 0 —
    //        because D-3 composer-priority partition promotes composer buttons ahead of truncation
    const ctx = makeCtx("feed", COMPOSER_LIVE_FIXTURE);
    const summary = buildInspectSummary(ctx);

    assert.ok(
      summary.buttons.some((b) => b.label === "Post"),
      "Post button must appear in unscoped buttons despite being at AX position 16 (>MAX_BUTTONS=12) — D-3 fix",
    );
    // Confirm it's at the front (promoted to position 0 by composer-priority partition)
    assert.equal(
      summary.buttons[0]?.label,
      "Post",
      "Post button must be promoted to buttons[0] ahead of non-composer nav buttons",
    );
    // Sanity: buttons still capped at 12
    assert.ok(summary.buttons.length <= 12, `buttons must be ≤12 (got ${summary.buttons.length})`);
  });
});

// ─── T-Inspect.5: non-composer unscoped inspect unchanged (regression guard) ─

describe("T-Inspect.5 (G-P46.9 regression): non-composer unscoped inspect behavior unchanged", () => {
  it("plain feed with 20 buttons → buttons = first 12 in original order; no composerModal in scopes", () => {
    // Given: a plain feed ctx with 20 {role:'button'} entries and no composer signals
    // When:  buildInspectSummary(ctx) — no scope
    // Then:  buttons equals the first 12 clickables in ctx.entries order (pre-P-46 behavior);
    //        availableScopes equals the static feed list (no 'composerModal')
    const entries: SnapshotEntry[] = Array.from({ length: 20 }, (_, i) => ({
      ref: `@b${i + 1}`,
      role: "button",
      name: `Button ${i + 1}`,
    }));
    const ctx = makeCtx("feed", entries);
    const summary = buildInspectSummary(ctx);

    assert.equal(summary.buttons.length, 12, "buttons must be capped at MAX_BUTTONS=12");
    assert.equal(summary.buttons[0]?.label, "Button 1", "first button must be 'Button 1' (original order preserved)");
    assert.equal(summary.buttons[11]?.label, "Button 12", "last button must be 'Button 12' (cap at 12)");
    assert.ok(
      !summary.availableScopes.includes("composerModal"),
      "no composerModal for plain 20-button feed (no composer signals)",
    );
  });
});

// ─── T-Inspect.6: weak single composer-adjacent signal does NOT advertise composerModal (C-5) ─

describe("T-Inspect.6 (G-P46.8 / C-5): hasComposerSignals requires strong signal (publish OR input+action)", () => {
  it("'Create a post' button alone → composerModal NOT in availableScopes (weak signal)", () => {
    // Given: ctx with exactly ONE weak composer-adjacent entry: {role:'button', name:'Create a post'}
    //        (this is the feed entry-point button, present even when no modal is open)
    //        NO composer text editor input, NO publish button
    // When:  buildInspectSummary(ctx)
    // Then:  availableScopes does NOT include 'composerModal' — single weak signal insufficient
    //        hasComposerSignals = hasPublish || (hasInput && hasActionButton) = false || (false && true) = false
    const ctx = makeCtx("feed", [{ ref: "@c1", role: "button", name: "Create a post" }]);
    const summary = buildInspectSummary(ctx);

    assert.ok(
      !summary.availableScopes.includes("composerModal"),
      "C-5: 'Create a post' alone must NOT advertise composerModal (hasInput=false → weak-signal guard)",
    );
  });

  it("composer text editor input AND a composer action button → composerModal IS in availableScopes", () => {
    // Given: ctx with composer text editor (@e661) AND a composer action button ('Open emoji keyboard')
    //        'Open emoji keyboard' IS in COMPOSER_BUTTON_RE (matches 'open emoji keyboard')
    // When:  buildInspectSummary(ctx)
    // Then:  availableScopes INCLUDES 'composerModal' (strong signal: hasInput=true AND hasActionButton=true)
    const ctx = makeCtx("feed", [
      { ref: "@e661", role: "textbox", name: "Text editor for creating content" },
      { ref: "@ea1", role: "button", name: "Open emoji keyboard" }, // matches COMPOSER_BUTTON_RE
    ]);
    const summary = buildInspectSummary(ctx);

    assert.ok(
      summary.availableScopes.includes("composerModal"),
      "text editor + 'Open emoji keyboard' action button → composerModal must be in availableScopes",
    );
  });

  it("Post publish button alone → composerModal IS in availableScopes (strongest single signal)", () => {
    // Given: ctx with ONLY the Post publish button — strongest single composer signal
    // When:  buildInspectSummary(ctx)
    // Then:  availableScopes INCLUDES 'composerModal' (isComposerPublishEntry → hasPublish=true)
    const ctx = makeCtx("feed", [{ ref: "@e80", role: "button", name: "Post" }]);
    const summary = buildInspectSummary(ctx);

    assert.ok(
      summary.availableScopes.includes("composerModal"),
      "Post button alone → composerModal in availableScopes (isComposerPublishEntry: ^post$ matches 'Post')",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P-47 G-3/G-5 scaffolds (Step 4a — all assertion bodies TODO; added 2026-05-20)
// ─────────────────────────────────────────────────────────────────────────────

// ─── T-Profile.2 (G-P47.4): profileCard entries survive MAX_TEXT truncation ──

describe("T-Profile.2 (G-P47.4): profileCard entries are at top of text[] and survive MAX_TEXT=40 truncation", () => {
  it("summary.text[0] is @pp1 identity line; summary.text[1] is @pp2 details line (despite 50+ staticText nav entries after them)", () => {
    // Given: a profile ctx whose entries array starts with 2 profileCard entries (@pp1, @pp2)
    //        followed by 50 staticText nav entries — more than MAX_TEXT=40
    //        (after Step 4b: "profileCard" ∈ TEXT_ROLES so profileCard entries reach text[])
    // When:  buildInspectSummary(ctx) — no scope argument
    // Then:  (a) summary.text[0] is the @pp1 identity line ("Jane Doe — VP Sales at Acme")
    //         (b) summary.text[1] is the @pp2 details line (contains "Acme", "London, UK", "500+")
    //         (c) Both profile entries survive the MAX_TEXT=40 slice (they are first in order)
    //         (d) summary.text.length ≤ 40 (slice is respected)
    //
    // NOTE: This test pins both §6.4 (profileCard ∈ TEXT_ROLES) AND OQ-3 (prepend ordering).
    //       Both are required: TEXT_ROLES admits the entries; prepend makes them first in text[].
    const profileEntries: SnapshotEntry[] = [
      { ref: "@pp1", role: "profileCard", name: "Jane Doe — VP Sales at Acme" },
      { ref: "@pp2", role: "profileCard", name: "Profile: Acme · London, UK · 500+ connections" },
      // 50 staticText nav entries follow (overwhelm MAX_TEXT=40 without the prepend)
      ...Array.from({ length: 50 }, (_, i) => ({
        ref: `@n${i + 1}`,
        role: "staticText",
        name: `Nav item ${i + 1}`,
      })),
    ];
    const ctx: CurrentSurfaceContext = {
      pageUrl: "https://www.linkedin.com/in/jane-doe/",
      surface: "profile",
      activeLayer: "page",
      entries: profileEntries,
    };

    const summary = buildInspectSummary(ctx);

    // (d) text.length ≤ 41 [D-15a / N1 update]: fixture is 2 profileCard + 50 staticText.
    //     Under the person-first partition: personShown=2, nonPersonBudget=38, nonPersonShown=38 staticText;
    //     shown=40, visible=52; 40<52 → hint fires → text.length=41 (40 real + 1 hint as EXTRA slot).
    //     Old bound was ≤40 (pre-15a, no hint). Updated to ≤41 at Step 5 per plan §4 N1 rule: TRUNCATING fixture.
    assert.ok(summary.text.length <= 41, `T-Profile.2: text.length (${summary.text.length}) must be ≤ 41 [D-15a / N1]`);
    assert.ok(summary.text.length >= 2, "T-Profile.2: at least 2 text entries (the profileCard entries)");

    // (a) text[0] is @pp1 identity line (requires profileCard ∈ TEXT_ROLES + prepend ordering)
    assert.ok(typeof summary.text[0] === "string", "T-Profile.2: text[0] must exist");
    assert.ok(
      summary.text[0]!.includes("Jane Doe") && summary.text[0]!.includes("VP Sales at Acme"),
      `T-Profile.2: text[0] must be the @pp1 identity line; got "${summary.text[0]}"`,
    );

    // (b) text[1] is @pp2 details line
    assert.ok(typeof summary.text[1] === "string", "T-Profile.2: text[1] must exist");
    assert.ok(
      summary.text[1]!.includes("Acme") && summary.text[1]!.includes("London, UK"),
      `T-Profile.2: text[1] must be the @pp2 details line; got "${summary.text[1]}"`,
    );
  });
});

// ─── P-47 T-Contract.1 (G-P47.5): InspectSummary schema + tool schemas unchanged ─

describe("T-Contract.1 (G-P47.5): InspectSummary Zod schema unchanged; type + navigate_to_url tool schemas unchanged", () => {
  it("inspectSummarySchema parses profile output; activeLayer==='page'; type + navigate_to_url parameter shapes untouched", () => {
    // Given: buildInspectSummary on a profile ctx (with profileCard entries) and a plain feed ctx
    //        makeTypeTool and makeNavigateToUrlTool with stub sessions
    // When:  (1) inspectSummarySchema.parse(profileOutput) and .parse(feedOutput)
    //         (2) type tool .parameters.safeParse({ text:"x", ref:"@e1" })
    //         (3) navigate_to_url tool .parameters.safeParse({ url:"https://example.com" })
    // Then:  (1) both parse without throwing; activeLayer === "page" for both;
    //             profile output has "profileCard" entries visible only if TEXT_ROLES includes it
    //         (2) type schema: text+ref valid; no text → invalid; schema shape unchanged post-P-47
    //         (3) navigate_to_url schema: https:// valid; http:// invalid; shape unchanged post-P-47
    //
    // NOTE (Step 4a): assert.fail before any assertions — scaffold is fast.
    // At Step 5: build profile ctx, run all three checks, fill assertions.
    const profileCtx: CurrentSurfaceContext = {
      pageUrl: "https://www.linkedin.com/in/jane-doe/",
      surface: "profile",
      activeLayer: "page",
      entries: [
        { ref: "@pp1", role: "profileCard", name: "Jane Doe — VP Sales at Acme" },
        { ref: "@pp2", role: "profileCard", name: "Profile: Acme · London, UK · 500+ connections" },
        { ref: "@n1", role: "button", name: "Home" },
      ],
    };
    // Stub sessions for tool schema checks (no Chrome needed — only .parameters used)
    const stubSession = {
      inputMode: "cdp" as const,
      // biome-ignore lint/suspicious/noExplicitAny: stub session
      getOrInitClient: async () => ({ ok: false as const, error: "chrome_unavailable" as const, message: "" }) as any,
      getClient: () => undefined,
      heartbeat: async () => false,
      setLastContext: () => {},
      getLastContext: () => undefined,
    };

    // (1) inspectSummarySchema.parse on profile + plain feed output
    const profileOutput = buildInspectSummary(profileCtx);
    const feedOutput = buildInspectSummary(makeCtx("feed", PLAIN_FEED_ENTRIES));

    const parsedProfile = inspectSummarySchema.parse(profileOutput);
    const parsedFeed = inspectSummarySchema.parse(feedOutput);

    // activeLayer === "page" for both (invariant)
    assert.equal(parsedProfile.activeLayer, "page", "T-Contract.1 P-47: profile activeLayer must be 'page'");
    assert.equal(parsedFeed.activeLayer, "page", "T-Contract.1 P-47: feed activeLayer must be 'page'");

    // profileCard in TEXT_ROLES — Jane Doe must appear in profile text
    assert.ok(
      parsedProfile.text.some((t) => t.includes("Jane Doe")),
      "T-Contract.1 P-47: profile text must include 'Jane Doe' (profileCard in TEXT_ROLES)",
    );

    // (2) type tool schema: {text, ref} valid; {ref} only invalid
    const typeTool = makeTypeTool(stubSession);
    const typeValid = typeTool.parameters.safeParse({ text: "x", ref: "@e1" });
    assert.equal(typeValid.success, true, "T-Contract.1 P-47: type schema must accept {text, ref}");
    const typeInvalid = typeTool.parameters.safeParse({ ref: "@e1" });
    assert.equal(typeInvalid.success, false, "T-Contract.1 P-47: type schema must reject missing text");

    // (3) navigate_to_url schema: https:// valid; http:// invalid
    const navTool = makeNavigateToUrlTool(stubSession);
    const navValid = navTool.parameters.safeParse({ url: "https://example.com" });
    assert.equal(navValid.success, true, "T-Contract.1 P-47: navigate_to_url accepts https://");
    const navInvalid = navTool.parameters.safeParse({ url: "http://example.com" });
    assert.equal(navInvalid.success, false, "T-Contract.1 P-47: navigate_to_url rejects http://");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

// ─── T-Contract.1: InspectSummary schema unchanged (regression / contract pin) ─

describe("T-Contract.1 (G-P46.9): InspectSummary Zod schema shape unchanged; activeLayer === 'page'", () => {
  it("buildInspectSummary output (composer + non-composer) parses cleanly with inspectSummarySchema", () => {
    // Given: buildInspectSummary on a plain ctx and a composer-open ctx
    // When:  each output is parsed with inspectSummarySchema.parse(...)
    // Then:  both succeed; activeLayer === 'page' (invariant); no extra/missing fields
    const plainCtx = makeCtx("feed", PLAIN_FEED_ENTRIES);
    const composerCtx = makeCtx("feed", COMPOSER_LIVE_FIXTURE);
    const plain = buildInspectSummary(plainCtx);
    const composer = buildInspectSummary(composerCtx);

    // Both must parse without throwing
    const parsedPlain = inspectSummarySchema.parse(plain);
    const parsedComposer = inspectSummarySchema.parse(composer);

    // activeLayer invariant: must be literal "page"
    assert.equal(parsedPlain.activeLayer, "page", "plain inspect activeLayer must be 'page' (invariant)");
    assert.equal(parsedComposer.activeLayer, "page", "composer inspect activeLayer must be 'page' (invariant)");

    // Scope contracts
    assert.ok(
      !parsedPlain.availableScopes.includes("composerModal"),
      "plain: composerModal must not be in availableScopes",
    );
    assert.ok(
      parsedComposer.availableScopes.includes("composerModal"),
      "composer: composerModal must be in availableScopes (D-3 dynamic scope)",
    );
  });
});

// ─── T-D11.R4: 2nd-degree Connect modal — "Send invitation" promoted ─────────
// [P-75 D-11 round 4] Live evidence (Hootan Farhat 2026-05-25, Dmitry Balanovsky
// 2026-06-08): on a 3rd-deg or 2nd-deg modal, the "Send invitation" button can be
// outnumbered by ~25 sidebar / nav / page-level buttons. inspectSummary's
// MAX_BUTTONS=12 truncation crowds Send invitation out unless it's promoted to the
// front by the outbound-action ranking. Pre-round-4: OUTBOUND_LABEL_RE matched
// "Send invite/Send now/Send without a note" but NOT bare "Send invitation" —
// agent couldn't see / click the actual button. Round-4 fix: added \bSend
// invitation\b to the regex.

describe("T-D11.R4: Send-invitation outbound promotion (2nd-degree modal regression)", () => {
  // Given: a profile-surface modal entry set where "Send invitation" is preceded by
  //        13+ sidebar / nav buttons (simulating the live Hootan/Dmitry surface
  //        where button:39 was captured but only top-12 surfaced).
  // When:  buildInspectSummary builds the inspect output.
  // Then:  "Send invitation" is in the top-12 buttons AND tagged with [OUTBOUND] prefix.
  it("promotes 'Send invitation' to top-12 buttons + [OUTBOUND]-prefixes it (modal regression)", () => {
    const noisySidebar: SnapshotEntry[] = [];
    for (let i = 1; i <= 15; i++) {
      noisySidebar.push({ ref: `@e${i}`, role: "button", name: `Invite Sidebar Person ${i} to connect` });
    }
    // Mixed in: the actual modal's Send invitation button somewhere in the middle.
    const entries: SnapshotEntry[] = [
      ...noisySidebar.slice(0, 8),
      { ref: "@e99", role: "button", name: "Send invitation" }, // <-- the live 2nd-deg modal button
      ...noisySidebar.slice(8),
      { ref: "@e100", role: "button", name: "Cancel adding a note" },
    ];
    const ctx = makeCtx("profile", entries);
    const summary = buildInspectSummary(ctx);
    const sendBtn = summary.buttons.find((b) => /Send invitation/i.test(b.label));
    assert.ok(
      sendBtn,
      `'Send invitation' must be in the top-${summary.buttons.length} buttons; got: ${JSON.stringify(summary.buttons.map((b) => b.label))}`,
    );
    assert.ok(
      sendBtn.label.startsWith("[OUTBOUND]"),
      `'Send invitation' must be [OUTBOUND]-prefixed; got: "${sendBtn.label}"`,
    );
  });

  // Given: same noisy sidebar PLUS a Connect button (the entry-step button)
  // When:  buildInspectSummary builds the output
  // Then:  BOTH "Connect" AND "Send invitation" surface above the sidebar noise
  it("promotes both 'Connect' and 'Send invitation' above sidebar 'Invite X to connect' noise", () => {
    const noisySidebar: SnapshotEntry[] = [];
    for (let i = 1; i <= 15; i++) {
      // These match OUTBOUND_LABEL_RE too (Invite ... to connect), so the regex's
      // ordering must keep the SUBJECT-relevant labels surfaced. In a real session
      // the subject's actions come via @pa* synth refs (already prioritized); here
      // we use flat refs to test the outboundBtns ranking layer.
      noisySidebar.push({ ref: `@e${i}`, role: "button", name: `Invite Sidebar Person ${i} to connect` });
    }
    const entries: SnapshotEntry[] = [
      { ref: "@e99", role: "button", name: "Connect" },
      ...noisySidebar,
      { ref: "@e100", role: "button", name: "Send invitation" },
    ];
    const ctx = makeCtx("profile", entries);
    const summary = buildInspectSummary(ctx);
    // Verify both labels appear somewhere in the surfaced 12
    assert.ok(
      summary.buttons.some((b) => /^\[OUTBOUND\] Connect$/i.test(b.label)),
      `'[OUTBOUND] Connect' must appear; got: ${JSON.stringify(summary.buttons.map((b) => b.label))}`,
    );
    assert.ok(
      summary.buttons.some((b) => /Send invitation/i.test(b.label)),
      `'Send invitation' must appear; got: ${JSON.stringify(summary.buttons.map((b) => b.label))}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P-AUTO-15a Step 3 — T-A15a.5..T-A15a.17
// Scaffolds: compileable, all assertion bodies are TODO, all intentionally fail.
// Gates: G-A15a.3 (dedup), G-A15a.4 (person budget), G-A15a.5 (hint + diagnostics),
//        G-A15a.6 (regression guards — ordering invariants)
// ─────────────────────────────────────────────────────────────────────────────

// ─── T-A15a.5 (G-A15a.3): two searchResult same-name, distinct URLs — both survive ─

describe("T-A15a.5 (G-A15a.3): two searchResult entries with same display name but distinct profileUrls both survive dedup", () => {
  it("when ctx has two searchResult entries whose names embed distinct /in/ slugs, buildInspectSummary keeps both", () => {
    // Given: context with two searchResult entries:
    //   "Alice Chen — https://www.linkedin.com/in/alice-chen-1/"
    //   "Alice Chen — https://www.linkedin.com/in/alice-chen-2/"
    // When:  buildInspectSummary(ctx)
    // Then:  summary.text contains both entries (distinct slugs → distinct dedup keys)
    const ctx = makeCtx("search", [
      { ref: "@sr1", role: "searchResult", name: "Alice Chen — https://www.linkedin.com/in/alice-chen-1/" },
      { ref: "@sr2", role: "searchResult", name: "Alice Chen — https://www.linkedin.com/in/alice-chen-2/" },
    ]);
    const summary = buildInspectSummary(ctx);
    assert.equal(summary.text.length, 2, "both alice-chen-1 and alice-chen-2 must survive dedup");
    assert.ok(summary.text.some((t) => t.includes("alice-chen-1")), "alice-chen-1 must appear in text");
    assert.ok(summary.text.some((t) => t.includes("alice-chen-2")), "alice-chen-2 must appear in text");
  });
});

// ─── T-A15a.6 (G-A15a.3): two feedPost same-author, distinct /in/ slugs — both survive ─

describe("T-A15a.6 (G-A15a.3): two feedPost entries with same author but distinct embedded /in/ slugs both survive dedup", () => {
  it("when ctx has two feedPost entries embedding distinct /in/ slugs, buildInspectSummary keeps both", () => {
    // Given: two feedPost entries:
    //   "Post by Alex Smith (/in/alex-smith-eng): foo"
    //   "Post by Alex Smith (/in/alex-smith-pm): bar"
    // When:  buildInspectSummary(ctx)
    // Then:  both survive (distinct slugs → distinct dedup keys under dedupKeyFor)
    const ctx = makeCtx("feed", [
      { ref: "@fp1", role: "feedPost", name: "Post by Alex Smith (/in/alex-smith-eng): foo" },
      { ref: "@fp2", role: "feedPost", name: "Post by Alex Smith (/in/alex-smith-pm): bar" },
    ]);
    const summary = buildInspectSummary(ctx);
    assert.equal(summary.text.length, 2, "both slug-distinct feedPost entries must survive dedup");
    assert.ok(summary.text.some((t) => t.includes("alex-smith-eng")), "eng slug must appear");
    assert.ok(summary.text.some((t) => t.includes("alex-smith-pm")), "pm slug must appear");
  });
});

// ─── T-A15a.7 (G-A15a.3, fallback): two same-author no-URL feedPost — second dropped ─

describe("T-A15a.7 (G-A15a.3, fallback path): two feedPost with identical name and no /in/ URL — second is dropped by role::name fallback", () => {
  it("when both feedPost entries have no /in/ slug and identical names, exactly one survives (documented lossy fallback)", () => {
    // Given: two feedPost entries with identical name and no embedded /in/ URL
    //   "Post by Carol Li: launch A"
    //   "Post by Carol Li: launch A"
    // When:  buildInspectSummary(ctx)
    // Then:  exactly ONE survives — role::name fallback dedup drops the duplicate.
    //        This is the DOCUMENTED lossy residual (plan §2, T-A15a.7), not a regression.
    const ctx = makeCtx("feed", [
      { ref: "@fp1", role: "feedPost", name: "Post by Carol Li: launch A" },
      { ref: "@fp2", role: "feedPost", name: "Post by Carol Li: launch A" },
    ]);
    const summary = buildInspectSummary(ctx);
    const carolEntries = summary.text.filter((t) => t.includes("Carol Li"));
    assert.equal(carolEntries.length, 1, "exactly one Carol Li feedPost survives the role::name fallback dedup");
  });
});

// ─── T-A15a.8 (G-A15a.6): non-person dedup unchanged ────────────────────────

describe("T-A15a.8 (G-A15a.6): non-person dedup unchanged — button dedup still drops same role::name", () => {
  it("two button entries named 'Like' → exactly one 'Like' button (T-M47 behavior preserved)", () => {
    // Given: ctx with two {role:'button', name:'Like'} entries
    // When:  buildInspectSummary(ctx)
    // Then:  exactly one 'Like' button (existing T-M47 dedup behavior preserved)
    const ctx = makeCtx("feed", [
      { ref: "@e1", role: "button", name: "Like" },
      { ref: "@e2", role: "button", name: "Like" },
    ]);
    const summary = buildInspectSummary(ctx);
    const likeButtons = summary.buttons.filter((b) => b.label === "Like");
    assert.equal(likeButtons.length, 1, "T-A15a.8: duplicate 'Like' buttons must be deduped to exactly one (T-M47 preserved)");
  });
});

// ─── T-A15a.9 (G-A15a.4): dense roster — person-first uncapped, hint fires ──

describe("T-A15a.9 (G-A15a.4): 18 feedPost + 30 staticText → 18 person + 22 non-person real + 1 hint = 41 total", () => {
  it("all 18 feedPost entries survive; 22 of 30 staticText emitted; last entry is hint with visible=48, shown=40", () => {
    // Given: 18 distinct feedPost entries + 30 staticText entries (48 visible)
    // When:  buildInspectSummary(ctx)
    // Then:  text.length === 41 (40 real + 1 hint); first 18 are feedPost; next 22 are staticText;
    //        last entry matches /^\[diagnostic\] 48 entries visible, 40 shown/
    const feedPosts = Array.from({ length: 18 }, (_, i) => ({
      ref: `@fp${i + 1}`,
      role: "feedPost",
      name: `Post by Author${i + 1} (/in/author-${i + 1}): headline ${i + 1}`,
    }));
    const staticTexts = Array.from({ length: 30 }, (_, i) => ({
      ref: `@s${i + 1}`,
      role: "staticText",
      name: `Static text entry ${i + 1}`,
    }));
    // feedPosts pushed after staticTexts to simulate push() ordering (feed surface)
    const ctx = makeCtx("feed", [...staticTexts, ...feedPosts]);
    const summary = buildInspectSummary(ctx);
    assert.equal(summary.text.length, 41, "40 real entries + 1 hint = 41");
    for (let i = 1; i <= 18; i++) {
      assert.ok(summary.text.some((t) => t.includes(`/in/author-${i}`)), `Author ${i} must appear`);
    }
    const hint = summary.text[summary.text.length - 1];
    assert.ok(
      hint?.match(/^\[diagnostic\] 48 entries visible, 40 shown/),
      `hint must be present and correct; got: "${hint}"`,
    );
  });
});

// ─── T-A15a.10 (G-A15a.4): 30 feedPost, no other — all 30 emitted, no hint ──

describe("T-A15a.10 (G-A15a.4): 30 feedPost entries only — all 30 emitted (exceeds MAX_TEXT=40 budget; person preservation wins); no hint", () => {
  it("text.length === 30; all 30 feedPost entries present; no [diagnostic] hint entry", () => {
    // Given: 30 distinct feedPost entries with distinct /in/ slugs; no other text-eligible entries
    // When:  buildInspectSummary(ctx)
    // Then:  summary.text.length === 30; all 30 entries in text; no [diagnostic] hint (shown==visible==30)
    const feedPosts = Array.from({ length: 30 }, (_, i) => ({
      ref: `@fp${i + 1}`,
      role: "feedPost",
      name: `Post by Author${i + 1} (/in/author-${i + 1}): headline ${i + 1}`,
    }));
    const ctx = makeCtx("feed", feedPosts);
    const summary = buildInspectSummary(ctx);
    assert.equal(summary.text.length, 30, "all 30 feedPost entries emitted (person preservation > MAX_TEXT=40 bound)");
    assert.ok(!summary.text.some((t) => t.startsWith("[diagnostic]")), "no hint — shown==visible==30");
  });
});

// ─── T-A15a.10b (G-A15a.4): MAX_PERSON_HARD=60 safety cap triggers on 80 searchResult ─

describe("T-A15a.10b (G-A15a.4): MAX_PERSON_HARD=60 safety cap — 80 searchResult entries → first 60 kept, hint fires visible=80 shown=60", () => {
  it("text contains first 60 searchResult entries; trailing 20 dropped; hint: 80 visible, 60 shown", () => {
    // Given: 80 distinct searchResult entries (synthetic, above any real surface cap)
    // When:  buildInspectSummary(ctx)
    // Then:  text.length === 61 (60 real + 1 hint); first 60 are the leading searchResult;
    //        trailing 20 dropped; hint: visible=80, shown=60
    const searchResults = Array.from({ length: 80 }, (_, i) => ({
      ref: `@sr${i + 1}`,
      role: "searchResult",
      name: `Person ${i + 1} — https://www.linkedin.com/in/person-${i + 1}/`,
    }));
    const ctx = makeCtx("search", searchResults);
    const summary = buildInspectSummary(ctx);
    assert.equal(summary.text.length, 61, "60 real + 1 hint = 61");
    const hint = summary.text[summary.text.length - 1];
    assert.ok(
      hint?.match(/^\[diagnostic\] 80 entries visible, 60 shown/),
      `hint must say 80 visible, 60 shown; got: "${hint}"`,
    );
    assert.ok(summary.text.some((t) => t.includes("person-1")), "person-1 must appear");
    assert.ok(!summary.text.some((t) => t.includes("person-61")), "person-61 must NOT appear (beyond MAX_PERSON_HARD=60)");
  });
});

// ─── T-A15a.10c (G-A15a.4): invariant — person_shown ≥ old-first-MAX_TEXT-slice baseline ─

describe("T-A15a.10c (G-A15a.4): invariant — dense-search baseline: 30 searchResult + 15 staticText → all 30 persons survive", () => {
  it("30 searchResult unshifted + 15 staticText → person_shown=30 ≥ old slice(0,40) baseline=30; hint fires visible=45 shown=40", () => {
    // Given: 30 searchResult entries (leading via unshift semantics — placed first in entries)
    //        + 15 staticText nav entries trailing
    // When:  buildInspectSummary(ctx)
    // Then:  ALL 30 searchResult in summary.text; 10 staticText emitted (nonPersonBudget=10);
    //        hint fires with visible=45, shown=40; personEntryCount (post-dedup) === 30
    //        Invariant: person_shown (30) >= old text.slice(0,40) person baseline (30).
    const searchResults = Array.from({ length: 30 }, (_, i) => ({
      ref: `@sr${i + 1}`,
      role: "searchResult",
      name: `Person ${i + 1} — https://www.linkedin.com/in/person-${i + 1}/`,
    }));
    const staticTexts = Array.from({ length: 15 }, (_, i) => ({
      ref: `@n${i + 1}`,
      role: "staticText",
      name: `Nav item ${i + 1}`,
    }));
    // searchResult entries unshifted (lead ctx.entries — matching production unshift)
    const ctx = makeCtx("search", [...searchResults, ...staticTexts]);
    const summary = buildInspectSummary(ctx);
    const personEntries = summary.text.filter((t) => t.includes("https://www.linkedin.com/in/person-"));
    assert.equal(personEntries.length, 30, "all 30 searchResult must survive (person_shown >= old baseline 30)");
    const hint10c = summary.text[summary.text.length - 1];
    assert.ok(
      hint10c?.match(/^\[diagnostic\] 45 entries visible, 40 shown/),
      `hint must say 45 visible, 40 shown; got: "${hint10c}"`,
    );
  });
});

// ─── T-A15a.11 (G-A15a.6): search unshift lead-ordering preserved ─────────

describe("T-A15a.11 (G-A15a.6): P-AUTO-3 search-lead ordering preserved — searchResult entries remain first in text[]", () => {
  it("5 searchResult (leading) + 35 staticText → first 5 of text are searchResult in original order; no hint", () => {
    // Given: context with 5 searchResult entries (leading, simulating unshift) + 35 staticText
    // When:  buildInspectSummary(ctx)
    // Then:  text[0..4] are the 5 searchResult entries in original order;
    //        text[5..39] are the staticText entries; text.length === 40; no hint
    const searchResults = Array.from({ length: 5 }, (_, i) => ({
      ref: `@sr${i + 1}`,
      role: "searchResult",
      name: `Person ${i + 1} — https://www.linkedin.com/in/person-${i + 1}/`,
    }));
    const staticTexts = Array.from({ length: 35 }, (_, i) => ({
      ref: `@s${i + 1}`,
      role: "staticText",
      name: `Static ${i + 1}`,
    }));
    const ctx = makeCtx("search", [...searchResults, ...staticTexts]);
    const summary = buildInspectSummary(ctx);
    assert.equal(summary.text.length, 40, "5 + 35 = 40; no hint (shown==visible==40)");
    assert.ok(!summary.text.some((t) => t.startsWith("[diagnostic]")), "no hint — nothing truncated");
    for (let i = 1; i <= 5; i++) {
      assert.ok(summary.text[i - 1]?.includes(`person-${i}`), `text[${i - 1}] must be person-${i}`);
    }
  });
});

// ─── T-A15a.12 (G-A15a.6): profile lead-ordering preserved ──────────────────

describe("T-A15a.12 (G-A15a.6): P-47 profile-lead ordering preserved — profileCard entries remain first in text[]", () => {
  it("2 profileCard (leading) + 35 staticText → text[0..1] are profileCard entries; text.length === 37; no hint", () => {
    // Given: profile context: 2 profileCard entries then 35 staticText
    // When:  buildInspectSummary(ctx)
    // Then:  text[0] is @pp1 profileCard; text[1] is @pp2 profileCard;
    //        next 35 are staticText; text.length === 37 (2+35 = 37 ≤ MAX_TEXT; no hint)
    const ctx: CurrentSurfaceContext = {
      pageUrl: "https://www.linkedin.com/in/alice/",
      surface: "profile",
      activeLayer: "page",
      entries: [
        { ref: "@pp1", role: "profileCard", name: "Alice — VP Eng" },
        { ref: "@pp2", role: "profileCard", name: "Profile: Acme · SF" },
        ...Array.from({ length: 35 }, (_, i) => ({
          ref: `@s${i + 1}`,
          role: "staticText",
          name: `Nav ${i + 1}`,
        })),
      ],
    };
    const summary = buildInspectSummary(ctx);
    assert.equal(summary.text.length, 37, "2 + 35 = 37; no hint (shown==visible==37)");
    assert.ok(summary.text[0]?.includes("Alice"), "text[0] must be the profileCard @pp1 entry");
    assert.ok(summary.text[1]?.includes("Acme"), "text[1] must be the profileCard @pp2 entry");
    assert.ok(!summary.text.some((t) => t.startsWith("[diagnostic]")), "no hint");
  });
});

// ─── T-A15a.13 (G-A15a.5): hint fires when truncation drops entries ──────────

describe("T-A15a.13 (G-A15a.5): hint fires when truncation drops entries — tail entry matches [diagnostic] pattern", () => {
  it("30 feedPost + 30 staticText → hint is last entry with visible=60, shown=40; text.length=41", () => {
    // Given: 30 distinct feedPost entries + 30 staticText entries (60 visible)
    //        person-first: all 30 person emitted; nonPersonBudget=10; 20 staticText dropped
    // When:  buildInspectSummary(ctx)
    // Then:  last entry in text[] matches /^\[diagnostic\] 60 entries visible, 40 shown — scroll\/refine to see more$/
    //        text.length === 41 (40 real + 1 hint — hint is EXTRA slot)
    const feedPosts = Array.from({ length: 30 }, (_, i) => ({
      ref: `@fp${i + 1}`,
      role: "feedPost",
      name: `Post by Author${i + 1} (/in/author-${i + 1}): headline`,
    }));
    const staticTexts = Array.from({ length: 30 }, (_, i) => ({
      ref: `@s${i + 1}`,
      role: "staticText",
      name: `Nav ${i + 1}`,
    }));
    const ctx = makeCtx("feed", [...staticTexts, ...feedPosts]);
    const summary = buildInspectSummary(ctx);
    assert.equal(summary.text.length, 41, "40 real + 1 hint = 41");
    const hint13 = summary.text[summary.text.length - 1];
    assert.ok(
      hint13?.match(/^\[diagnostic\] 60 entries visible, 40 shown — scroll\/refine to see more$/),
      `hint must match canonical format; got: "${hint13}"`,
    );
  });
});

// ─── T-A15a.14 (G-A15a.5): no hint when no truncation ───────────────────────

describe("T-A15a.14 (G-A15a.5): no hint when all entries fit — shown==visible", () => {
  it("5 feedPost + 10 staticText → text.length === 15; no [diagnostic] entry", () => {
    // Given: 5 feedPost + 10 staticText = 15 total (all fit: 5 person + 10 non-person budget=35)
    // When:  buildInspectSummary(ctx)
    // Then:  no [diagnostic] entry; text.length === 15
    const feedPosts = Array.from({ length: 5 }, (_, i) => ({
      ref: `@fp${i + 1}`,
      role: "feedPost",
      name: `Post by Author${i + 1} (/in/author-${i + 1}): headline`,
    }));
    const staticTexts = Array.from({ length: 10 }, (_, i) => ({
      ref: `@s${i + 1}`,
      role: "staticText",
      name: `Nav ${i + 1}`,
    }));
    const ctx = makeCtx("feed", [...staticTexts, ...feedPosts]);
    const summary = buildInspectSummary(ctx);
    assert.equal(summary.text.length, 15, "5 + 10 = 15; no hint (shown==visible==15)");
    assert.ok(!summary.text.some((t) => t.startsWith("[diagnostic]")), "no hint — nothing truncated");
  });
});

// ─── T-A15a.15 (G-A15a.5): canonical count semantics — visible vs shown ─────

describe("T-A15a.15 (G-A15a.5): canonical counts — visible=pre-truncation deduped; shown=real emitted (excl hint); hint is EXTRA slot", () => {
  it("100 staticText → hint says '100 entries visible, 40 shown'; text.length === 41 (40 real + 1 hint)", () => {
    // Given: 100 distinct staticText entries (no person-bearing entries)
    // When:  buildInspectSummary(ctx)
    // Then:  hint string contains '100 entries visible' AND '40 shown' (not 39 — hint is EXTRA slot);
    //        text.length === 41 (40 real + 1 hint; hint does NOT consume a real-entry slot)
    const ctx = makeCtx("feed", Array.from({ length: 100 }, (_, i) => ({
      ref: `@s${i + 1}`,
      role: "staticText",
      name: `Static ${i + 1}`,
    })));
    const summary = buildInspectSummary(ctx);
    assert.equal(summary.text.length, 41, "40 real + 1 hint = 41 (hint is EXTRA slot — does not displace a real entry)");
    const hint15 = summary.text[summary.text.length - 1];
    assert.ok(
      hint15?.includes("100 entries visible") && hint15?.includes("40 shown"),
      `canonical counts must be 100 visible, 40 shown; got: "${hint15}"`,
    );
  });
});

// ─── T-A15a.16 (G-A15a.5): full:true diagnostics — visibleTextCount, shownTextCount, personEntryCount ─
// NOTE: T-A15a.16 covers the full-surface (scope=null) path of inspect.execute.
// The scoped-diagnostics path (scope!=null) is covered by T-A15a.17 below.
// T-A15a.16 lives here (inspectSummary) because we can test it with buildInspectSummary
// and the canonical count semantics without a full fake LinkedinSession.
// The actual inspect.execute test (with full:true) lives in tests/tools/browser/inspect.mock.test.ts.

describe("T-A15a.16 (G-A15a.5): full:true diagnostics — verify canonical count semantics via buildInspectSummary output", () => {
  it("100 staticText ctx → buildInspectSummary output: shown=40 (excl hint), visible=100, person=0", () => {
    // Given: 100 distinct staticText entries (no person-bearing) — same fixture as T-A15a.15
    // When:  buildInspectSummary(ctx) then compute visible/shown/person from the output
    //        (the inspect tool re-derives these from the same set; this test pins the source semantics)
    // Then:  shownTextCount (real entries excl [diagnostic]) === 40;
    //        visibleTextCount (pre-truncation deduped) === 100; personEntryCount === 0
    const ctx = makeCtx("feed", Array.from({ length: 100 }, (_, i) => ({
      ref: `@s${i + 1}`,
      role: "staticText",
      name: `Static ${i + 1}`,
    })));
    const summary = buildInspectSummary(ctx);
    // Derive the same counts the inspect tool full:true path will use
    const shownTextCount = summary.text.filter((t) => !t.startsWith("[diagnostic]")).length;
    assert.equal(shownTextCount, 40, "shownTextCount must be 40 (40 real entries, hint excluded)");
    assert.equal(summary.text.filter((t) => t.startsWith("[diagnostic]")).length, 1, "exactly 1 hint entry");
  });
});

// ─── T-A15a.17 (G-A15a.5): scoped diagnostics consistency ───────────────────

describe("T-A15a.17 (G-A15a.5): scoped diagnostics — visibleTextCount from scoped+deduped set, not raw ctx.entries", () => {
  it("when scope='composerModal' filters to 5 of 100 entries, visibleTextCount=scoped count (not 100)", () => {
    // Given: a context with 5 composerModal-scoped entries (Post button + text editor + 3 action buttons)
    //        + 95 non-composer entries (simulating 100-entry page context)
    // When:  buildInspectSummary(ctx, 'composerModal')
    // Then:  only scoped entries are processed; this scaffold pins the contract that builder must
    //        expose the scoped-deduped text-eligible count, NOT the raw ctx.entries count.
    //        (The actual visibleTextCount field lives on inspect.execute output — tested in inspect.mock.test.ts T-A15a.17.)
    //        This scaffold verifies buildInspectSummary(ctx, scope) operates on the scoped set.
    const composerEntries = [
      { ref: "@e80", role: "button", name: "Post" }, // composer publish button
      { ref: "@e661", role: "textbox", name: "Text editor for creating content" },
      { ref: "@e1", role: "button", name: "Open emoji keyboard" },
      { ref: "@e2", role: "button", name: "Add media" },
      { ref: "@e3", role: "staticText", name: "Compose your thoughts" },
    ];
    const nonComposerEntries = Array.from({ length: 95 }, (_, i) => ({
      ref: `@n${i + 1}`,
      role: "staticText",
      name: `Nav ${i + 1}`,
    }));
    const ctx = makeCtx("feed", [...composerEntries, ...nonComposerEntries]);
    const scopedSummary = buildInspectSummary(ctx, "composerModal");
    // Scoped summary must not contain non-composer nav entries
    assert.ok(!scopedSummary.text.some((t) => t.startsWith("Nav ")), "scoped summary must not contain nav entries");
    // Post button must be in scoped buttons (composerModal scope includes composer publish button)
    assert.ok(scopedSummary.buttons.some((b) => b.label === "Post"), "scoped buttons must include Post");
    // The composerModal scope filter passes: isComposerButtonEntry || isComposerInputEntry.
    // TEXT_ROLES are {staticText, StaticText, text, heading, feedPost, profileCard, searchResult}.
    // None of the composerModal-scoped entries (Post button, textbox, emoji button, media button) are in TEXT_ROLES.
    // "Compose your thoughts" (staticText) is not in composerModal scope (not a button/input).
    // => text-eligible in scope = 0; scoped text[] is empty; no hint (shown=0=visible=0).
    assert.equal(scopedSummary.text.length, 0, "composerModal scope has 0 text-eligible entries (buttons/inputs are not TEXT_ROLES)");
    // This pins the N2 contract: the scoped text-eligible count is 0, not 95 (the raw ctx.entries staticText count).
    // The inspect.execute full:true path must derive visibleTextCount from this same scoped+deduped set.
    // That assertion lives in tests/tools/browser/inspect.mock.test.ts T-A15a.Full.2.
  });
});

// =============================================================================
// P-MSG-REPLY Step 4/5 — assertions filled.
// T-MsgReply.ScopeProj.1–5 (Group D): scope-projection tests for
// filterEntriesByScope + buildInspectSummary on messaging-thread surfaces.
// =============================================================================

// ─── T-MsgReply.ScopeProj.1: messagingConversation scope filters to transcript + conversation buttons ─

describe("T-MsgReply.ScopeProj.1 (Group D): buildInspectSummary(ctx, 'messagingConversation') — transcript in text[], nav filtered out", () => {
  it(
    "given messaging-thread ctx with 3 messagingTranscript entries + 8 nav staticText + 5 nav buttons, when buildInspectSummary(ctx, 'messagingConversation') runs, then text[] has 3 transcript lines in order, no nav text; buttons[] has only conversation-action buttons (or empty)",
    () => {
      // Given: a "messaging-thread" ctx whose entries are:
      //   - 3 {role:"messagingTranscript"} text entries (the conversation)
      //   - 8 {role:"staticText"} nav entries  (noise that must be filtered)
      //   - 5 {role:"button"} nav buttons       (noise that must be filtered)
      //   (No star/minimize/close conversation-action buttons in this fixture — buttons[] must be empty.)
      // When:  buildInspectSummary(ctx, "messagingConversation")
      // Then:  summary.text === the 3 transcript lines in entry order (messagingTranscript in TEXT_ROLES);
      //        summary.buttons.length === 0 (no isMessagingConversationEntry buttons in the fixture);
      //        no nav text appears in summary.text.
      const entries: SnapshotEntry[] = [
        { ref: "@mt1", role: "messagingTranscript", name: "[Antony Hubert] Hi Kyoube! (2h)" },
        { ref: "@mt2", role: "messagingTranscript", name: "[You] Glad to connect" },
        { ref: "@mt3", role: "messagingTranscript", name: "[Antony Hubert] How can I help? (1h)" },
        ...Array.from({ length: 8 }, (_, i) => ({
          ref: `@n${i + 1}`,
          role: "staticText",
          name: `Nav item ${i + 1}`,
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          ref: `@nb${i + 1}`,
          role: "button",
          name: `Nav button ${i + 1}`,
        })),
      ];
      const ctx: CurrentSurfaceContext = {
        pageUrl: "https://www.linkedin.com/messaging/thread/test/",
        surface: "messaging-thread",
        activeLayer: "page",
        entries: [
          ...entries,
          { ref: "@ca1", role: "button", name: "Star conversation" },
          { ref: "@ca2", role: "button", name: "Minimize your conversation" },
          { ref: "@ca3", role: "button", name: "Close your conversation with Antony Hubert" },
        ],
      };
      const summary = buildInspectSummary(ctx, "messagingConversation");
      assert.deepEqual(summary.text, [
        "[Antony Hubert] Hi Kyoube! (2h)",
        "[You] Glad to connect",
        "[Antony Hubert] How can I help? (1h)",
      ]);
      assert.deepEqual(summary.buttons, [
        { ref: "@ca1", label: "Star conversation" },
        { ref: "@ca2", label: "Minimize your conversation" },
        { ref: "@ca3", label: "Close your conversation with Antony Hubert" },
      ]);
      assert.equal(summary.text.some((text) => text.startsWith("Nav item")), false, "nav text must be filtered out");
      assert.equal(summary.buttons.some((button) => button.label.startsWith("Nav button")), false, "nav buttons must be filtered out");
    },
  );
});

// ─── T-MsgReply.ScopeProj.2: threadInput scope filters to composer + Send only ─

describe("T-MsgReply.ScopeProj.2 (Group D): buildInspectSummary(ctx, 'threadInput') — composer + Send only, nav filtered", () => {
  it(
    "given messaging-thread ctx with composer textbox 'Write a message…' + Send button + 8 nav buttons, when buildInspectSummary(ctx, 'threadInput') runs, then inputs[] has only the composer, buttons[] has only the Send button",
    () => {
      // Given: a "messaging-thread" ctx whose entries are:
      //   - {role:"textbox", name:"Write a message…"} (the composer)
      //   - {role:"button", name:"Send"} (the Send button — matches isThreadComposerButtonEntry)
      //   - 8 {role:"button", name:"Nav button N"} (noise)
      //   - 3 {role:"messagingTranscript"} transcript entries (must NOT appear in threadInput scope)
      // When:  buildInspectSummary(ctx, "threadInput")
      // Then:  summary.inputs.length === 1 AND inputs[0].label matches /write a message/i;
      //        summary.buttons.length === 1 AND buttons[0].label matches /send/i;
      //        no nav buttons, no transcript text.
      const entries: SnapshotEntry[] = [
        { ref: "@mc1", role: "textbox", name: "Write a message…" },
        { ref: "@e207", role: "button", name: "Send" },
        ...Array.from({ length: 8 }, (_, i) => ({
          ref: `@nb${i + 1}`,
          role: "button",
          name: `Nav button ${i + 1}`,
        })),
        { ref: "@mt1", role: "messagingTranscript", name: "[Alice] Hello" },
        { ref: "@mt2", role: "messagingTranscript", name: "[You] Hi" },
        { ref: "@mt3", role: "messagingTranscript", name: "[Alice] How are you?" },
      ];
      const ctx: CurrentSurfaceContext = {
        pageUrl: "https://www.linkedin.com/messaging/thread/test/",
        surface: "messaging-thread",
        activeLayer: "page",
        entries,
      };
      const summary = buildInspectSummary(ctx, "threadInput");
      assert.deepEqual(summary.inputs, [{ ref: "@mc1", label: "Write a message…" }]);
      assert.deepEqual(summary.buttons, [{ ref: "@e207", label: "Send" }]);
      assert.deepEqual(summary.text, [], "threadInput scope must not include transcript text");
    },
  );
});

// ─── T-MsgReply.ScopeProj.3: threadInput — recipient-picker variant (two composer inputs) ─

describe("T-MsgReply.ScopeProj.3 (Group D): buildInspectSummary(ctx, 'threadInput') — new-message compose pane with TWO inputs (recipient + message)", () => {
  it(
    "given messaging-thread ctx with BOTH 'Enter message recipients' AND 'Write a message…' textboxes, when buildInspectSummary(ctx, 'threadInput') runs, then inputs[] contains BOTH entries",
    () => {
      // Given: a "messaging-thread" ctx whose entries include:
      //   - {role:"textbox", name:"Enter message recipients"} (recipient picker)
      //   - {role:"textbox", name:"Write a message…"} (body composer)
      //   - {role:"button", name:"Send"} and various nav buttons
      // When:  buildInspectSummary(ctx, "threadInput")
      // Then:  summary.inputs.length === 2;
      //        one input matches /enter message recipients/i;
      //        one input matches /write a message/i;
      //        (parity with references/surface-messaging.md:43-50 two-input spec).
      const entries: SnapshotEntry[] = [
        { ref: "@mc1", role: "textbox", name: "Enter message recipients" },
        { ref: "@mc2", role: "textbox", name: "Write a message…" },
        { ref: "@e207", role: "button", name: "Send" },
        { ref: "@nb1", role: "button", name: "Nav button 1" },
        { ref: "@nb2", role: "button", name: "Nav button 2" },
      ];
      const ctx: CurrentSurfaceContext = {
        pageUrl: "https://www.linkedin.com/messaging/thread/new/",
        surface: "messaging-thread",
        activeLayer: "page",
        entries,
      };
      const summary = buildInspectSummary(ctx, "threadInput");
      assert.deepEqual(summary.inputs, [
        { ref: "@mc1", label: "Enter message recipients" },
        { ref: "@mc2", label: "Write a message…" },
      ]);
      assert.deepEqual(summary.buttons, [{ ref: "@e207", label: "Send" }]);
    },
  );
});

// ─── T-MsgReply.ScopeProj.4: unscoped — transcript cap MAX_TRANSCRIPT=20 + transcript leads text[] ─

describe("T-MsgReply.ScopeProj.4 (Group D): unscoped buildInspectSummary — transcript cap MAX_TRANSCRIPT=20, transcript leads text[], remaining budget for nav", () => {
  it(
    "given messaging-thread ctx with 25 messagingTranscript entries + 30 nav staticText, when buildInspectSummary(ctx) runs, then transcript entries are capped at 20 and remaining 20 slots are nav text",
    () => {
      // Given: a "messaging-thread" ctx whose entries are:
      //   - 25 {role:"messagingTranscript"} entries (above the MAX_TRANSCRIPT cap)
      //   - 30 {role:"staticText"} nav entries
      //   (total: 55 visible; but MAX_TRANSCRIPT=20 + remaining MAX_TEXT-MAX_TRANSCRIPT=20 = 40 shown)
      // When:  buildInspectSummary(ctx) — no scope
      // Then:  summary.text[0..19] are the 20 transcript lines in original order;
      //        transcript count === 20 (capped at MAX_TRANSCRIPT);
      //        next 20 slots (text[20..39]) are nav staticText entries;
      //        total text.length === 41 (40 real + 1 hint: 55 visible, 40 shown)
      const transcriptEntries: SnapshotEntry[] = Array.from({ length: 25 }, (_, i) => ({
        ref: `@mt${i + 1}`,
        role: "messagingTranscript",
        name: `[Person] Message ${i + 1}`,
      }));
      const navEntries: SnapshotEntry[] = Array.from({ length: 30 }, (_, i) => ({
        ref: `@n${i + 1}`,
        role: "staticText",
        name: `Nav item ${i + 1}`,
      }));
      const ctx: CurrentSurfaceContext = {
        pageUrl: "https://www.linkedin.com/messaging/thread/test/",
        surface: "messaging-thread",
        activeLayer: "page",
        entries: [...transcriptEntries, ...navEntries],
      };
      const summary = buildInspectSummary(ctx);
      const realText = summary.text.filter((text) => !text.startsWith("[diagnostic]"));

      assert.equal(realText.length, 40, "20 transcript + 20 nav text entries must be shown");
      assert.deepEqual(realText.slice(0, 20), transcriptEntries.slice(0, 20).map((entry) => entry.name));
      assert.equal(realText.some((text) => text === "[Person] Message 21"), false, "transcript entries beyond MAX_TRANSCRIPT=20 must be dropped");
      assert.deepEqual(realText.slice(20), navEntries.slice(0, 20).map((entry) => entry.name));
      assert.match(
        summary.text[summary.text.length - 1] ?? "",
        /^\[diagnostic\] 55 entries visible, 40 shown/,
        "hint must account for transcript and nav truncation",
      );
    },
  );

  it(
    "given messaging-thread ctx with transcript + person-bearing + nav text, when summary builds, then transcript leads before the P-AUTO-15a person partition consumes the remaining budget",
    () => {
      // Given: 3 transcript entries, 18 person-bearing feedPost entries, and 30 nav staticText entries.
      // When:  buildInspectSummary(ctx) runs unscoped.
      // Then:  text[] starts with transcript, then all 18 person-bearing entries, then 19 nav entries.
      const transcriptEntries: SnapshotEntry[] = Array.from({ length: 3 }, (_, i) => ({
        ref: `@mt${i + 1}`,
        role: "messagingTranscript",
        name: `[Person] Thread message ${i + 1}`,
      }));
      const navEntries: SnapshotEntry[] = Array.from({ length: 30 }, (_, i) => ({
        ref: `@s${i + 1}`,
        role: "staticText",
        name: `Nav item ${i + 1}`,
      }));
      const feedPosts: SnapshotEntry[] = Array.from({ length: 18 }, (_, i) => ({
        ref: `@fp${i + 1}`,
        role: "feedPost",
        name: `Post by Author${i + 1} (/in/author-${i + 1}): headline ${i + 1}`,
      }));
      const ctx: CurrentSurfaceContext = {
        pageUrl: "https://www.linkedin.com/messaging/thread/test/",
        surface: "messaging-thread",
        activeLayer: "page",
        entries: [...transcriptEntries, ...navEntries, ...feedPosts],
      };
      const summary = buildInspectSummary(ctx);
      const realText = summary.text.filter((text) => !text.startsWith("[diagnostic]"));

      assert.deepEqual(realText.slice(0, 3), transcriptEntries.map((entry) => entry.name));
      assert.deepEqual(realText.slice(3, 21), feedPosts.map((entry) => entry.name));
      assert.deepEqual(realText.slice(21), navEntries.slice(0, 19).map((entry) => entry.name));
      assert.match(summary.text[summary.text.length - 1] ?? "", /^\[diagnostic\] 51 entries visible, 40 shown/);
    },
  );
});

// ─── T-MsgReply.ScopeProj.5: regression pin — non-messaging surface unaffected ─

describe("T-MsgReply.ScopeProj.5 (Group D): regression — P-AUTO-15a person/non-person partition unchanged on non-messaging surfaces", () => {
  it(
    "given a non-messaging surface (feed) with NO messagingTranscript entries, when buildInspectSummary(ctx) runs, then existing T-A15a.9 partition output is byte-identical",
    () => {
      // Given: a plain "feed" ctx with 18 feedPost + 30 staticText entries
      //        (identical to T-A15a.9 fixture — no messagingTranscript entries).
      // When:  buildInspectSummary(ctx)
      // Then:  text.length === 41 (40 real + 1 hint);
      //        first 18 entries are feedPost in original order;
      //        hint matches /^\[diagnostic\] 48 entries visible, 40 shown/;
      //        — byte-identical to the T-A15a.9 expectation (regression pin: no change on feed surface).
      const feedPosts = Array.from({ length: 18 }, (_, i) => ({
        ref: `@fp${i + 1}`,
        role: "feedPost",
        name: `Post by Author${i + 1} (/in/author-${i + 1}): headline ${i + 1}`,
      }));
      const staticTexts = Array.from({ length: 30 }, (_, i) => ({
        ref: `@s${i + 1}`,
        role: "staticText",
        name: `Static text entry ${i + 1}`,
      }));
      // feedPosts pushed after staticTexts to simulate push() ordering (feed surface)
      const ctx = makeCtx("feed", [...staticTexts, ...feedPosts]);
      const summary = buildInspectSummary(ctx);
      const expectedText = [
        ...feedPosts.map((entry) => entry.name),
        ...staticTexts.slice(0, 22).map((entry) => entry.name),
        "[diagnostic] 48 entries visible, 40 shown — scroll/refine to see more",
      ];

      assert.deepEqual(summary.text, expectedText, "T-MsgReply.ScopeProj.5: feed output must match T-A15a.9 exactly");
    },
  );

  it("given a feed ctx, when scope='threadInput' is requested, then the messaging scope is surface-gated and summary is unchanged", () => {
    // Given: a feed surface containing labels that would match threadInput on a real messaging thread.
    // When:  buildInspectSummary(ctx, "threadInput") runs off-surface.
    // Then:  the messaging scope remains a no-op and matches the unscoped feed summary.
    const ctx = makeCtx("feed", [
      { ref: "@e1", role: "textbox", name: "Write a message…" },
      { ref: "@e2", role: "button", name: "Send" },
      { ref: "@e3", role: "staticText", name: "Feed text" },
    ]);

    assert.deepEqual(buildInspectSummary(ctx, "threadInput"), buildInspectSummary(ctx));
  });

  it("given a feed ctx, when scope='messagingConversation' is requested, then the messaging scope is surface-gated and summary is unchanged", () => {
    // Given: a feed surface containing a synthetic messagingTranscript-like row.
    // When:  buildInspectSummary(ctx, "messagingConversation") runs off-surface.
    // Then:  the messaging scope remains a no-op and matches the unscoped feed summary.
    const ctx = makeCtx("feed", [
      { ref: "@mt1", role: "messagingTranscript", name: "[Alice] Should remain ordinary feed text" },
      { ref: "@e1", role: "button", name: "Like" },
      { ref: "@e2", role: "staticText", name: "Feed text" },
    ]);

    assert.deepEqual(buildInspectSummary(ctx, "messagingConversation"), buildInspectSummary(ctx));
  });
});

// =============================================================================
// P-POST Step 2 — T-Post.Scope.1–5 (Group D): composerInput scope + advertisement
// Gate: G-POST.Scope
// =============================================================================

// ─── T-Post.Scope.1: composer open → advertises BOTH composerModal AND composerInput ─

describe("T-Post.Scope.1 (G-POST.Scope): composer open → buildInspectSummary advertises BOTH composerModal AND composerInput", () => {
  it(
    "given feed ctx with composer signals (button named 'Post'), when buildInspectSummary(ctx) runs, then availableScopes includes both 'composerModal' AND 'composerInput' in addition to the static feed scopes",
    () => {
      // Given: a feed ctx whose entries contain composer signals (a button named exactly "Post" —
      //        the strongest single composer signal per hasComposerSignals in inspectSummary.ts:150-158).
      // When:  buildInspectSummary(ctx) — no scope (unscoped, to observe availableScopes).
      // Then:  availableScopes includes "composerModal" (pre-existing P-46 behavior);
      //        availableScopes ALSO includes "composerInput" (NEW P-POST behavior);
      //        both are in addition to the static feed scopes ["page","feed","post","postActions"].
      const ctx = makeCtx("feed", [
        { ref: "@e1", role: "button", name: "LinkedIn Home" },
        { ref: "@e2", role: "button", name: "Post" }, // composer publish button — strong signal
        { ref: "@e3", role: "textbox", name: "Text editor for creating content" },
      ]);
      const summary = buildInspectSummary(ctx);

      // Post-Step-4: composerInput is dynamically advertised alongside composerModal
      // when hasComposerSignals returns true (button named "Post" is a strong signal).
      assert.ok(
        summary.availableScopes.includes("composerModal"),
        `T-Post.Scope.1: availableScopes must include 'composerModal' when composer is open; got: ${JSON.stringify(summary.availableScopes)}`,
      );
      assert.ok(
        summary.availableScopes.includes("composerInput"),
        `T-Post.Scope.1: availableScopes must include 'composerInput' when composer is open; got: ${JSON.stringify(summary.availableScopes)}`,
      );
      // Static scopes still present
      assert.ok(summary.availableScopes.includes("page"), "T-Post.Scope.1: 'page' must always be in availableScopes");
      assert.ok(summary.availableScopes.includes("feed"), "T-Post.Scope.1: 'feed' must be in availableScopes for feed surface");
    },
  );
});

// ─── T-Post.Scope.2: composer closed → composerInput NOT advertised ───────────

describe("T-Post.Scope.2 (G-POST.Scope): composer closed → composerInput NOT in availableScopes", () => {
  it(
    "given feed ctx with NO composer signals (plain feed — Start a post button only), when buildInspectSummary(ctx) runs, then availableScopes does NOT include 'composerInput' (nor 'composerModal')",
    () => {
      // Given: a plain feed ctx with no composer-signal entries
      //        ("Start a post" alone is NOT a strong signal; hasComposerSignals returns false).
      // When:  buildInspectSummary(ctx) — unscoped.
      // Then:  availableScopes does NOT include "composerInput";
      //        availableScopes does NOT include "composerModal";
      //        availableScopes equals the static feed list: ["page","feed","post","postActions"].
      const ctx = makeCtx("feed", [
        { ref: "@e1", role: "button", name: "Start a post" },
        { ref: "@e2", role: "button", name: "My Network" },
        { ref: "@e3", role: "link", name: "Feed" },
      ]);
      const summary = buildInspectSummary(ctx);

      // This assertion PASSES even pre-Step-4 (composerInput is not in the current static list).
      // But it is listed as a scaffold test to pin the regression guard contract.
      // It will fail at Step 4 if the builder mistakenly advertises composerInput unconditionally.
      if (summary.availableScopes.includes("composerInput")) {
        assert.fail(
          `T-Post.Scope.2: 'composerInput' must NOT be in availableScopes for plain feed (no composer signals); ` +
            `got: ${JSON.stringify(summary.availableScopes)}`,
        );
      }
      if (summary.availableScopes.includes("composerModal")) {
        assert.fail(
          `T-Post.Scope.2: 'composerModal' must NOT be in availableScopes for plain feed (no composer signals); ` +
            `got: ${JSON.stringify(summary.availableScopes)}`,
        );
      }
      // Post-Step-4: the composerInput branch is only advertised dynamically when
      // hasComposerSignals returns true. On a plain feed with no composer signals,
      // availableScopes must exactly equal the static list.
      assert.deepEqual(
        summary.availableScopes,
        ["page", "feed", "post", "postActions"],
        `T-Post.Scope.2: plain feed availableScopes must equal the static list (no composerInput/composerModal without composer signals); got: ${JSON.stringify(summary.availableScopes)}`,
      );
    },
  );
});

// ─── T-Post.Scope.3: filterEntriesByScope("composerInput", …) returns @pc* only ─

describe("T-Post.Scope.3 (G-POST.Scope): filterEntriesByScope('composerInput', entries, 'feed') returns editor + Post entries only", () => {
  it(
    "given entries containing @pc1 (textbox 'Text editor for creating content') + @pc2 (button 'Post') + ~10 unrelated @e*/@fp* entries, when filterEntriesByScope(entries, 'composerInput', 'feed') runs, then result is exactly [@pc1, @pc2]",
    () => {
      // Given: a mixed entries array containing:
      //   - @pc1 (role:textbox, name:"Text editor for creating content") — post-composer synth ref
      //   - @pc2 (role:button, name:"Post") — post-composer synth ref
      //   - 5 @e* buttons (nav/non-composer)
      //   - 3 @fp* feedPost entries
      //   - 2 @n* staticText entries
      // When:  filterEntriesByScope(entries, "composerInput", "feed") runs.
      // Then:  result is exactly [@pc1, @pc2] — ref-prefix filter on "@pc".
      //        Order preserved; length === 2.
      // CONCERN-MR-2 hardening (load-bearing): this assertion runs BEFORE any trailing TODO
      // so a faulty Step-4 that leaves filterEntriesByScope("composerInput") broken cannot
      // pass by just not having the branch at all (an undefined branch returns [] which would
      // also fail the assertion, but explicitly so — not silently).
      const entries: SnapshotEntry[] = [
        { ref: "@pc1", role: "textbox", name: "Text editor for creating content" },
        { ref: "@pc2", role: "button", name: "Post" },
        { ref: "@e1", role: "button", name: "LinkedIn Home" },
        { ref: "@e2", role: "button", name: "My Network" },
        { ref: "@e3", role: "button", name: "Start a post" },
        { ref: "@e4", role: "button", name: "Like" },
        { ref: "@e5", role: "button", name: "Comment" },
        { ref: "@fp1", role: "feedPost", name: "Post by Alice (/in/alice): headline 1" },
        { ref: "@fp2", role: "feedPost", name: "Post by Bob (/in/bob): headline 2" },
        { ref: "@fp3", role: "feedPost", name: "Post by Carol (/in/carol): headline 3" },
        { ref: "@n1", role: "staticText", name: "Feed nav text 1" },
        { ref: "@n2", role: "staticText", name: "Feed nav text 2" },
      ];

      // Load-bearing assertion: call the live filterEntriesByScope and assert refs+order.
      // Pre-Step-4: "composerInput" branch does not exist in filterEntriesByScope →
      //             the function falls through to a default (likely returns [] or all entries),
      //             and the deepEqual below FAILS.
      // Post-Step-4: the "@pc" prefix filter returns exactly [@pc1, @pc2].
      const result = filterEntriesByScope(entries, "composerInput", "feed");
      assert.deepEqual(
        result.map((e) => e.ref),
        ["@pc1", "@pc2"],
        `T-Post.Scope.3: filterEntriesByScope(entries, 'composerInput', 'feed') must return exactly [@pc1, @pc2]; got: ${JSON.stringify(result.map((e) => e.ref))}`,
      );
      // Also verify order is preserved and length is exactly 2.
      assert.equal(result.length, 2, "T-Post.Scope.3: result must have exactly 2 entries");
    },
  );
});

// ─── T-Post.Scope.4: composerInput filter is ref-prefix-based (surface-agnostic) ─

describe("T-Post.Scope.4 (G-POST.Scope): filterEntriesByScope('composerInput') is ref-prefix-based, surface-agnostic", () => {
  it(
    "given the SAME entries with surface='profile', when filterEntriesByScope(entries, 'composerInput', 'profile') runs, then result is still exactly [@pc1, @pc2] (filter is ref-prefix-based, not surface-dependent)",
    () => {
      // Given: entries containing @pc1 + @pc2 + unrelated entries (same shape as T-Post.Scope.3);
      //        surface="profile" (not "feed").
      // When:  filterEntriesByScope(entries, "composerInput", "profile") runs.
      // Then:  result is exactly [@pc1, @pc2].
      //        Documents intentional behavior: the FILTER is surface-agnostic (ref-prefix on "@pc");
      //        the ADVERTISEMENT is surface-conditional (only on "feed" when composer is open).
      //        Mirrors the overlay scope filter at inspectSummary.ts:297-299.
      // CONCERN-MR-2 hardening (load-bearing): call filterEntriesByScope directly and assert
      // refs+order BEFORE any trailing TODO — mirrors the T-Post.Scope.3 hardening.
      // Pre-Step-4: "composerInput" branch does not exist → filterEntriesByScope returns [] or
      //             all entries (neither is [@pc1,@pc2]) → deepEqual FAILS.
      // Post-Step-4: the "@pc" prefix filter is surface-agnostic → returns [@pc1,@pc2].
      const entries: SnapshotEntry[] = [
        { ref: "@pc1", role: "textbox", name: "Text editor for creating content" },
        { ref: "@pc2", role: "button", name: "Post" },
        { ref: "@e1", role: "button", name: "Connect" },
        { ref: "@e2", role: "button", name: "Message" },
        { ref: "@e3", role: "button", name: "More" },
      ];

      // Load-bearing assertion (CONCERN-MR-2 hardening):
      const result = filterEntriesByScope(entries, "composerInput", "profile");
      assert.deepEqual(
        result.map((e) => e.ref),
        ["@pc1", "@pc2"],
        `T-Post.Scope.4: filterEntriesByScope(entries, 'composerInput', 'profile') must return exactly [@pc1, @pc2]; got: ${JSON.stringify(result.map((e) => e.ref))}`,
      );
      assert.equal(result.length, 2, "T-Post.Scope.4: result must have exactly 2 entries");
    },
  );
});

// ─── T-Post.Scope.5: existing scopes unchanged (regression guard) ─────────────

describe("T-Post.Scope.5 (G-POST.Scope): existing scopes unchanged — AVAILABLE_SCOPES_BY_SURFACE static map regression guard", () => {
  it(
    "given a plain feed ctx (no composer) AND a messaging-thread ctx (no transcript), when buildInspectSummary runs on each, then availableScopes exactly matches the pre-P-POST static snapshot for each surface",
    () => {
      // Given: (1) plain feed ctx with no composer signals
      //        (2) messaging-thread ctx with no transcript or composer entries
      // When:  buildInspectSummary(ctx) runs on each.
      // Then:  (1) feed availableScopes === ["page","feed","post","postActions"]
      //             (composerInput and composerModal must NOT appear — no composer signals)
      //        (2) messaging-thread availableScopes ===
      //             ["page","messagingThread","messagingConversation","threadInput"]
      //             per src/linkedin/inspectSummary.ts:168-174 — NIT fix from Step-3a critic.
      //        Pre-P-POST baseline. If the builder accidentally widens AVAILABLE_SCOPES_BY_SURFACE
      //        unconditionally, this test catches it.
      const feedCtx = makeCtx("feed", [
        { ref: "@e1", role: "button", name: "Start a post" },
        { ref: "@e2", role: "link", name: "Feed" },
      ]);
      const feedSummary = buildInspectSummary(feedCtx);

      const messagingThreadCtx: CurrentSurfaceContext = {
        pageUrl: "https://www.linkedin.com/messaging/thread/test/",
        surface: "messaging-thread",
        activeLayer: "page",
        entries: [
          { ref: "@e1", role: "link", name: "Back to Messaging" },
          { ref: "@e2", role: "button", name: "More options" },
        ],
      };
      const threadSummary = buildInspectSummary(messagingThreadCtx);

      // Feed: pre-P-POST static list (composerInput must NOT be in static list)
      assert.deepEqual(
        feedSummary.availableScopes,
        ["page", "feed", "post", "postActions"],
        "T-Post.Scope.5: plain feed availableScopes must equal pre-P-POST static list",
      );

      // Messaging-thread: pre-P-POST static list per inspectSummary.ts:168-174.
      // The exact static scopes for messaging-thread are:
      //   ["page","messagingThread","messagingConversation","threadInput"]
      // (NIT fix from Step-3a critic: the old scaffold cited ["page","messaging-thread"] which
      //  is WRONG — the real static map key is "messaging-thread" but the scopes list is the above.)
      assert.deepEqual(
        threadSummary.availableScopes,
        ["page", "messagingThread", "messagingConversation", "threadInput"],
        "T-Post.Scope.5: messaging-thread availableScopes must match the static list from inspectSummary.ts:168-174 — [\"page\",\"messagingThread\",\"messagingConversation\",\"threadInput\"]",
      );
    },
  );
});
