/**
 * P-37 Step 5 — T-B4.1..T-B4.5 (assertions filled)
 * P-AUTO-15a Step 3 — T-A15a.1..T-A15a.4 (scaffolds — all intentionally fail)
 *
 * B4: feed-post DOM synthesis via synthesizeFeedPostEntries (module-private).
 * Tests run THROUGH captureCurrentSurfaceContext (preferred DI path per plan §9.3).
 * T-B4.5 uses the exported FEED_POST_SYNTH_JS to assert heuristic shape (static).
 *
 * Gate coverage:
 *   G-P37.3 (SnapshotEntry shape, cap 5), G-P37.4 (feed-surface gate),
 *   G-P37.5 (feedPost in TEXT_ROLES → text[]), G-P37.6 (text-signal-primary, no BEM required)
 *   G-A15a.1 (T-A15a.1, T-A15a.3 — cap parameterized to 15)
 *   G-A15a.2 (T-A15a.2, T-A15a.4 — single source of truth for the cap)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import { buildInspectSummary, TEXT_ROLES } from "../../src/linkedin/inspectSummary.js";
// P-AUTO-15a: FEED_POST_CAP will be exported from feedPostSynth.ts after Step 4.
// Use a dynamic-import-tolerant typed assertion pattern (the export does not exist yet).
import { captureCurrentSurfaceContext, FEED_POST_SYNTH_JS } from "../../src/linkedin/snapshotCapture.js";
import type { CurrentSurfaceContext } from "../../src/linkedin/types.js";

// ─── Fake handle factory ──────────────────────────────────────────────────────

/**
 * Build a minimal fake CdpHandle for feed-surface tests.
 * Runtime.evaluate distinguishes:
 *   - "window.location.href" → returns pageUrl
 *   - any other expression   → returns postJson (for FEED_POST_SYNTH_JS calls)
 * Tracks all evaluate expressions in _evaluateCalls (accessible by tests via T-B4.3).
 */
function makeFakeFeedHandle(opts: {
  pageUrl: string;
  postJson: string;
  axNodes?: Array<{ nodeId: string; role: string; name: string; backendDOMNodeId: number }>;
}) {
  const evaluateCalls: string[] = [];

  const handle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: (opts.axNodes ?? []).map((n) => ({
          nodeId: n.nodeId,
          role: { type: "role", value: n.role },
          name: { type: "string", value: n.name },
          backendDOMNodeId: n.backendDOMNodeId,
        })),
      }),
    },
    Runtime: {
      evaluate: async (args: { expression: string; returnByValue?: boolean; awaitPromise?: boolean }) => {
        evaluateCalls.push(args.expression);
        if (args.expression === "window.location.href") {
          return { result: { value: opts.pageUrl } };
        }
        // FEED_POST_SYNTH_JS call (or any other evaluate expression)
        return { result: { value: opts.postJson } };
      },
    },
    DOM: {
      getDocument: async () => ({ root: { nodeId: 1 } }),
      querySelectorAll: async () => ({ nodeIds: [] as number[] }),
      getAttributes: async () => ({ attributes: [] as string[] }),
    },
    /** @internal — exposes recorded evaluate expressions for T-B4.3. */
    _evaluateCalls: evaluateCalls,
  };

  return handle;
}

// ─── T-B4.1 ──────────────────────────────────────────────────────────────────

describe("B4: synthesizeFeedPostEntries — entry shape + cap", () => {
  it("T-B4.1: given evaluate returns 4 scripted posts, captureCurrentSurfaceContext on feed URL returns 4 feedPost entries with correct shape", async () => {
    // Given: fake evaluate returns 4 posts with author/headline/profileUrl (3rd has profileUrl:null); page URL is feed
    // When:  captureCurrentSurfaceContext(client) is called
    // Then:  4 SnapshotEntry with role "feedPost", refs "@fp1"..@fp4"; names include "Post by <author> (<url>): <headline>" or "Post by <author>: <headline>"

    const posts = [
      { author: "Alice Chen", headline: "Hiring SREs in Berlin", profileUrl: "/in/alice" },
      { author: "Bob Kim", headline: "Great Q1 results", profileUrl: "/in/bob" },
      { author: "Carol Li", headline: "New product launch", profileUrl: null },
      { author: "Dave Ng", headline: "Remote work insights", profileUrl: "/in/dave" },
    ];

    const fakeHandle = makeFakeFeedHandle({
      pageUrl: "https://www.linkedin.com/feed/",
      postJson: JSON.stringify(posts),
    });

    const client = CdpClient.fromHandle(fakeHandle);
    const ctx = await captureCurrentSurfaceContext(client);

    const feedEntries = ctx.entries.filter((e) => e.role === "feedPost");
    assert.equal(feedEntries.length, 4, "must have 4 feedPost entries from 4 scripted posts");

    // refs @fp1..@fp4
    for (let i = 1; i <= 4; i++) {
      assert.ok(
        feedEntries.some((e) => e.ref === `@fp${i}`),
        `must have @fp${i} ref`,
      );
    }

    // profileUrl present → "Post by Alice Chen (/in/alice): Hiring SREs in Berlin"
    const fp1 = feedEntries.find((e) => e.ref === "@fp1");
    assert.ok(fp1?.name.includes("Alice Chen"), "@fp1 name must include author Alice Chen");
    assert.ok(fp1?.name.includes("/in/alice"), "@fp1 name must include profileUrl");
    assert.ok(fp1?.name.includes("Hiring SREs in Berlin"), "@fp1 name must include headline");

    // profileUrl null → "Post by Carol Li: New product launch"
    const fp3 = feedEntries.find((e) => e.ref === "@fp3");
    assert.ok(fp3?.name.includes("Carol Li"), "@fp3 name must include author Carol Li");
    assert.ok(!fp3?.name.includes("null"), "@fp3 name must NOT include literal null");
    assert.ok(fp3?.name.includes("New product launch"), "@fp3 name must include headline");
  });

  it("T-B4.2: given evaluate returns 8 scripted posts, result is capped at FEED_POST_CAP (15) feedPost entries (P-AUTO-15a updates cap 5→15)", async () => {
    // Given: fake evaluate returns 8 posts (fewer than the new FEED_POST_CAP=15 cap)
    // When:  captureCurrentSurfaceContext(client) is called on feed URL
    // Then:  exactly 8 SnapshotEntry with role "feedPost" (all 8 returned — 8 < FEED_POST_CAP=15)
    // NOTE (P-AUTO-15a): cap was 5; after Step 4 it is FEED_POST_CAP=15. This
    //   test was previously "exactly 5" with 8 posts; it now asserts all 8 returned
    //   (since 8 < 15). The cap behavior is tested by T-A15a.3 (20-post input → 15 returned).

    const posts = Array.from({ length: 8 }, (_, i) => ({
      author: `Author${i + 1}`,
      headline: `Headline number ${i + 1}`,
      profileUrl: `/in/author${i + 1}`,
    }));

    const fakeHandle = makeFakeFeedHandle({
      pageUrl: "https://www.linkedin.com/feed/",
      postJson: JSON.stringify(posts),
    });

    const client = CdpClient.fromHandle(fakeHandle);
    const ctx = await captureCurrentSurfaceContext(client);

    const feedEntries = ctx.entries.filter((e) => e.role === "feedPost");
    // P-AUTO-15a: all 8 entries returned (FEED_POST_CAP=15, so 8 < cap)
    assert.equal(feedEntries.length, 8, "feedPost entries: all 8 returned when 8 < FEED_POST_CAP=15");

    // Refs must be @fp1..@fp8
    for (let i = 1; i <= 8; i++) {
      assert.ok(
        feedEntries.some((e) => e.ref === `@fp${i}`),
        `must have @fp${i}`,
      );
    }
  });
});

// ─── T-B4.3 ──────────────────────────────────────────────────────────────────

describe("B4: synthesizeFeedPostEntries — feed-surface gate (G-P37.4)", () => {
  it("T-B4.3: captureCurrentSurfaceContext invokes FEED_POST_SYNTH_JS evaluate for feed URL; does NOT for profile URL", async () => {
    // Given: two fake clients — one returning a feed URL, one returning a profile URL
    // When:  captureCurrentSurfaceContext called on each
    // Then:  feed client: Runtime.evaluate called with FEED_POST_SYNTH_JS; profile client: FEED_POST_SYNTH_JS NOT called

    // Feed-URL client
    const feedHandle = makeFakeFeedHandle({
      pageUrl: "https://www.linkedin.com/feed/",
      postJson: "[]",
    });
    const feedClient = CdpClient.fromHandle(feedHandle);
    await captureCurrentSurfaceContext(feedClient);

    // Profile-URL client
    const profileHandle = makeFakeFeedHandle({
      pageUrl: "https://www.linkedin.com/in/alice-chen/",
      postJson: "[]",
    });
    const profileClient = CdpClient.fromHandle(profileHandle);
    await captureCurrentSurfaceContext(profileClient);

    assert.ok(
      feedHandle._evaluateCalls.includes(FEED_POST_SYNTH_JS),
      "feed client must have evaluated FEED_POST_SYNTH_JS (synthesizeFeedPostEntries invoked for feed surface)",
    );
    assert.ok(
      !profileHandle._evaluateCalls.includes(FEED_POST_SYNTH_JS),
      "profile client must NOT have evaluated FEED_POST_SYNTH_JS (feed synthesis is feed-surface-only)",
    );
  });
});

// ─── T-B4.4 ──────────────────────────────────────────────────────────────────

describe("B4: feedPost in TEXT_ROLES → lands in inspect text[] (G-P37.5)", () => {
  it("T-B4.4: TEXT_ROLES.has('feedPost') is true; buildInspectSummary with a feedPost entry puts it in text[]", () => {
    // Given: TEXT_ROLES set (imported); a CurrentSurfaceContext with one feedPost entry
    // When:  TEXT_ROLES.has("feedPost") checked; buildInspectSummary(ctx) called
    // Then:  TEXT_ROLES.has("feedPost") === true; the feedPost entry name appears in summary.text[]

    assert.ok(TEXT_ROLES.has("feedPost"), "TEXT_ROLES must contain 'feedPost' after P-37 B4");

    const ctx: CurrentSurfaceContext = {
      pageUrl: "https://www.linkedin.com/feed/",
      surface: "feed",
      activeLayer: "page",
      entries: [{ ref: "@fp1", role: "feedPost", name: "Post by Alice Chen (/in/alice): Hiring SREs" }],
    };

    const summary = buildInspectSummary(ctx);

    assert.ok(summary.text.length > 0, "summary.text must be non-empty (feedPost entry must land in text[])");
    assert.ok(
      summary.text.some((t) => t.includes("Post by Alice Chen")),
      "feedPost entry name must appear in summary.text[] (feedPost is in TEXT_ROLES)",
    );
  });
});

// ─── T-B4.5 ──────────────────────────────────────────────────────────────────

describe("B4: FEED_POST_SYNTH_JS heuristic shape — text-signal-primary, no BEM required (G-P37.6)", () => {
  it("T-B4.5: FEED_POST_SYNTH_JS contains post-action signal check ('comment'/'repost'/'reaction') and does NOT require 'feed-shared-update-v2'", () => {
    // Given: FEED_POST_SYNTH_JS exported from snapshotCapture.ts (real JS heuristic string after builder Step 4b)
    // When:  static string assertions evaluated
    // Then:  script is non-empty, contains SIGNALS array with "comment"/"repost"/"reaction",
    //        does NOT hard-require "feed-shared-update-v2" for container detection (text-signal-primary)

    assert.ok(FEED_POST_SYNTH_JS.length > 100, "FEED_POST_SYNTH_JS must be a non-trivial JS script (length > 100)");

    // G-P37.6: text-signal-primary — the signal array must contain all 3 post-action signals
    assert.ok(FEED_POST_SYNTH_JS.includes("comment"), "script must contain 'comment' post-action signal");
    assert.ok(FEED_POST_SYNTH_JS.includes("repost"), "script must contain 'repost' post-action signal");
    assert.ok(FEED_POST_SYNTH_JS.includes("reaction"), "script must contain 'reaction' post-action signal");

    // G-P37.6: BEM-rename degradation — script must NOT use feed-shared-update-v2 as a query selector.
    // A comment mentioning it (e.g. "// No reliance on the feed-shared-update-v2 class.") is acceptable
    // documentation; what matters is that the class does not appear as a CSS selector (.feed-shared-update-v2)
    // or as a string argument to querySelector/querySelectorAll.
    assert.ok(
      !FEED_POST_SYNTH_JS.includes(".feed-shared-update-v2") &&
        !FEED_POST_SYNTH_JS.includes('"feed-shared-update-v2"') &&
        !FEED_POST_SYNTH_JS.includes("'feed-shared-update-v2'"),
      "script must NOT use 'feed-shared-update-v2' as a CSS selector or querySelector argument (BEM churn tolerance — comments referencing it are allowed)",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P-AUTO-15a Step 3 — T-A15a.1..T-A15a.4 (scaffolds — all assertion bodies TODO;
// all intentionally fail until builder Step 4 ships FEED_POST_CAP=15)
// Gate coverage: G-A15a.1 (T-A15a.1, T-A15a.3), G-A15a.2 (T-A15a.2, T-A15a.4)
// ─────────────────────────────────────────────────────────────────────────────

// ─── T-A15a.1 (G-A15a.1): FEED_POST_CAP exported = 15 ───────────────────────

describe("T-A15a.1 (G-A15a.1): FEED_POST_CAP is exported from feedPostSynth and equals 15", () => {
  it("when FEED_POST_CAP is imported from snapshotCapture (re-export), its value is exactly 15 (number)", async () => {
    // Given: the module is imported (after builder Step 4 adds export const FEED_POST_CAP = 15)
    // When:  FEED_POST_CAP is read from the re-export in snapshotCapture.ts
    // Then:  value is exactly 15 (number, not string)
    const mod = await import("../../src/linkedin/snapshotCapture.js");
    // biome-ignore lint/suspicious/noExplicitAny: accessing new export pre-build
    const cap = (mod as unknown as Record<string, unknown>)["FEED_POST_CAP"];
    assert.equal(cap, 15, "FEED_POST_CAP must be exactly 15");
    assert.equal(typeof cap, "number", "FEED_POST_CAP must be a number");
  });
});

// ─── T-A15a.2 (G-A15a.2): FEED_POST_SYNTH_JS contains interpolated cap, not hardcoded 5 ─

describe("T-A15a.2 (G-A15a.2): FEED_POST_SYNTH_JS contains .slice(0, FEED_POST_CAP) interpolated, not stale .slice(0, 5)", () => {
  it("FEED_POST_SYNTH_JS contains '.slice(0, 15)' AND does NOT contain stale '.slice(0, 5)'", async () => {
    // Given: FEED_POST_SYNTH_JS exported from snapshotCapture (re-export from feedPostSynth)
    // When:  static string assertions run
    // Then:  script contains '.slice(0, 15)' (interpolated FEED_POST_CAP=15) AND
    //        does NOT match /\.slice\(0,\s*5\)/ (no stray hardcoded 5)
    const mod = await import("../../src/linkedin/snapshotCapture.js");
    // biome-ignore lint/suspicious/noExplicitAny: accessing export via index
    const synthJs = (mod as unknown as Record<string, unknown>)["FEED_POST_SYNTH_JS"] as string;
    assert.ok(
      typeof synthJs === "string" && synthJs.includes(".slice(0, 15)"),
      `FEED_POST_SYNTH_JS must contain '.slice(0, 15)' (interpolated cap); got: ${String(synthJs).slice(0, 200)}`,
    );
    assert.ok(
      !synthJs.match(/\.slice\(0,\s*5\)/),
      "FEED_POST_SYNTH_JS must NOT contain stale '.slice(0, 5)' — single source of truth violated",
    );
  });
});

// ─── T-A15a.3 (G-A15a.1): synthesizeFeedPostEntries returns up to FEED_POST_CAP=15 ─

describe("T-A15a.3 (G-A15a.1): synthesizeFeedPostEntries caps at FEED_POST_CAP=15, not 5", () => {
  it("given fake CDP returns 20 posts, captureCurrentSurfaceContext on feed URL returns exactly 15 feedPost entries", async () => {
    // Given: fake CDP client whose evaluate(FEED_POST_SYNTH_JS) returns JSON of 20 scripted posts
    // When:  captureCurrentSurfaceContext(client) is called on a feed URL
    // Then:  exactly 15 entries with role 'feedPost' (refs @fp1..@fp15); @fp16+ absent
    const posts = Array.from({ length: 20 }, (_, i) => ({
      author: `Author${i + 1}`,
      headline: `Headline ${i + 1}`,
      profileUrl: `/in/author${i + 1}`,
    }));
    const fakeHandle = makeFakeFeedHandle({
      pageUrl: "https://www.linkedin.com/feed/",
      postJson: JSON.stringify(posts),
    });
    const client = CdpClient.fromHandle(fakeHandle);
    const ctx = await captureCurrentSurfaceContext(client);
    const feedEntries = ctx.entries.filter((e) => e.role === "feedPost");
    assert.equal(feedEntries.length, 15, "feedPost entries must be capped at FEED_POST_CAP=15");
    for (let i = 1; i <= 15; i++) assert.ok(feedEntries.some((e) => e.ref === `@fp${i}`), `must have @fp${i}`);
    assert.ok(!feedEntries.some((e) => e.ref === "@fp16"), "must NOT have @fp16 — cap is 15 not 16+");
  });
});

// ─── T-A15a.4 (G-A15a.2): FEED_POST_SYNTH_JS has exactly one .slice() governing anchors ─

describe("T-A15a.4 (G-A15a.2): FEED_POST_SYNTH_JS contains exactly one anchors .slice() call with value == FEED_POST_CAP", () => {
  it("regex matches exactly one anchors-array .slice(0, N) and N equals 15", async () => {
    // Given: FEED_POST_SYNTH_JS string (after builder Step 4 interpolation)
    // When:  regex /anchors[^;]*\.slice\(0,\s*(\d+)\)/ matched
    // Then:  exactly one match; captured number is 15 (== FEED_POST_CAP)
    const mod = await import("../../src/linkedin/snapshotCapture.js");
    // biome-ignore lint/suspicious/noExplicitAny: accessing export via index
    const synthJs = (mod as unknown as Record<string, unknown>)["FEED_POST_SYNTH_JS"] as string;
    const matches = [...synthJs.matchAll(/anchors[^;]*\.slice\(0,\s*(\d+)\)/g)];
    assert.equal(matches.length, 1, "FEED_POST_SYNTH_JS must have exactly one anchors .slice() call");
    assert.equal(Number(matches[0]?.[1]), 15, "the slice cap must equal FEED_POST_CAP=15");
  });
});
