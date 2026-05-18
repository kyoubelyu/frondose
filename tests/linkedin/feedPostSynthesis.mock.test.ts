/**
 * P-37 Step 5 — T-B4.1..T-B4.5 (assertions filled)
 *
 * B4: feed-post DOM synthesis via synthesizeFeedPostEntries (module-private).
 * Tests run THROUGH captureCurrentSurfaceContext (preferred DI path per plan §9.3).
 * T-B4.5 uses the exported FEED_POST_SYNTH_JS to assert heuristic shape (static).
 *
 * Gate coverage:
 *   G-P37.3 (SnapshotEntry shape, cap 5), G-P37.4 (feed-surface gate),
 *   G-P37.5 (feedPost in TEXT_ROLES → text[]), G-P37.6 (text-signal-primary, no BEM required)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import { buildInspectSummary, TEXT_ROLES } from "../../src/linkedin/inspectSummary.js";
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
  it(
    "T-B4.1: given evaluate returns 4 scripted posts, captureCurrentSurfaceContext on feed URL returns 4 feedPost entries with correct shape",
    async () => {
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
        assert.ok(feedEntries.some((e) => e.ref === `@fp${i}`), `must have @fp${i} ref`);
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
    },
  );

  it(
    "T-B4.2: given evaluate returns 8 scripted posts, result is capped at 5 feedPost entries",
    async () => {
      // Given: fake evaluate returns 8 posts (more than the 5-post cap)
      // When:  captureCurrentSurfaceContext(client) is called on feed URL
      // Then:  exactly 5 SnapshotEntry with role "feedPost" (cap enforced in synthesizeFeedPostEntries)

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
      assert.equal(feedEntries.length, 5, "feedPost entries must be capped at 5 even when evaluate returns 8");

      // Refs must be @fp1..@fp5 (not @fp6..)
      for (let i = 1; i <= 5; i++) {
        assert.ok(feedEntries.some((e) => e.ref === `@fp${i}`), `must have @fp${i}`);
      }
      assert.ok(!feedEntries.some((e) => e.ref === "@fp6"), "must NOT have @fp6 (cap is 5)");
    },
  );
});

// ─── T-B4.3 ──────────────────────────────────────────────────────────────────

describe("B4: synthesizeFeedPostEntries — feed-surface gate (G-P37.4)", () => {
  it(
    "T-B4.3: captureCurrentSurfaceContext invokes FEED_POST_SYNTH_JS evaluate for feed URL; does NOT for profile URL",
    async () => {
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
    },
  );
});

// ─── T-B4.4 ──────────────────────────────────────────────────────────────────

describe("B4: feedPost in TEXT_ROLES → lands in inspect text[] (G-P37.5)", () => {
  it(
    "T-B4.4: TEXT_ROLES.has('feedPost') is true; buildInspectSummary with a feedPost entry puts it in text[]",
    () => {
      // Given: TEXT_ROLES set (imported); a CurrentSurfaceContext with one feedPost entry
      // When:  TEXT_ROLES.has("feedPost") checked; buildInspectSummary(ctx) called
      // Then:  TEXT_ROLES.has("feedPost") === true; the feedPost entry name appears in summary.text[]

      assert.ok(TEXT_ROLES.has("feedPost"), "TEXT_ROLES must contain 'feedPost' after P-37 B4");

      const ctx: CurrentSurfaceContext = {
        pageUrl: "https://www.linkedin.com/feed/",
        surface: "feed",
        activeLayer: "page",
        entries: [
          { ref: "@fp1", role: "feedPost", name: "Post by Alice Chen (/in/alice): Hiring SREs" },
        ],
      };

      const summary = buildInspectSummary(ctx);

      assert.ok(summary.text.length > 0, "summary.text must be non-empty (feedPost entry must land in text[])");
      assert.ok(
        summary.text.some((t) => t.includes("Post by Alice Chen")),
        "feedPost entry name must appear in summary.text[] (feedPost is in TEXT_ROLES)",
      );
    },
  );
});

// ─── T-B4.5 ──────────────────────────────────────────────────────────────────

describe("B4: FEED_POST_SYNTH_JS heuristic shape — text-signal-primary, no BEM required (G-P37.6)", () => {
  it(
    "T-B4.5: FEED_POST_SYNTH_JS contains post-action signal check ('comment'/'repost'/'reaction') and does NOT require 'feed-shared-update-v2'",
    () => {
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
    },
  );
});
