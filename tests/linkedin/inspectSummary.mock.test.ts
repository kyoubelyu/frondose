/**
 * P-3 mock tests — T-M46..T-M49: InspectSummary building.
 * P-46 mock tests — T-Inspect.1–6, T-Contract.1: composer surface + D-3 fix + contract.
 *
 * Tests buildInspectSummary(), deduplication, slicing limits, and scope handling.
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { buildInspectSummary } from "../../src/linkedin/inspectSummary.js";
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

    // (d) text.length ≤ 40 (MAX_TEXT cap respected)
    assert.ok(summary.text.length <= 40, `T-Profile.2: text.length (${summary.text.length}) must be ≤ 40`);
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
