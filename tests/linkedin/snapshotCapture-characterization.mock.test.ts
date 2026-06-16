/**
 * P-72 Slice 10 — Step 3a characterization scaffolds (validator)
 *
 * Four characterization tests for the OPAQUE surfaces in snapshotCapture.ts:
 *   T-snapshotCapture.SynthLiteral.1  — FEED_POST_SYNTH_JS IIFE shape + substrings
 *   T-snapshotCapture.SynthLiteral.2  — PROFILE_SYNTH_JS IIFE shape + substrings
 *   T-snapshotCapture.Orchestrator.1  — captureCurrentSurfaceContext per-surface branching
 *   T-snapshotCapture.Orchestrator.2  — synth evaluate throws → orchestrator catches + fallback
 *
 * INTENT: These tests GREEN against the PRE-SPLIT barrel (src/linkedin/snapshotCapture.ts
 * as-is at 460 LoC). They characterize the load-bearing surface so the builder can
 * verify ZERO behavior change after the split (Step 3b).
 *
 * Gates: G-P72s10.1 (behavior preserved through split)
 *
 * Run (mock — no browser/LLM):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/linkedin/snapshotCapture-characterization.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import {
  FEED_POST_SYNTH_JS,
  PROFILE_SYNTH_JS,
  captureCurrentSurfaceContext,
} from "../../src/linkedin/snapshotCapture.js";

// ─── stub handle factory ──────────────────────────────────────────────────────

/**
 * Build a minimal fake CdpHandle for characterization tests. The handle stubs:
 *   - AX tree: empty unless axNodes provided
 *   - Runtime.evaluate:
 *       "window.location.href" → pageUrl
 *       anything else (synth expressions) → per-expression stub map or default
 *   - DOM: document, querySelectorAll (→ []), describeNode, getAttributes
 *
 * evaluateMap: maps expression substrings to return values (first match wins).
 * evaluateThrowsOn: set of expression substrings that throw instead of returning.
 */
function makeStubHandle(opts: {
  pageUrl: string;
  axNodes?: Array<{ nodeId: string; role: string; name: string; backendDOMNodeId: number }>;
  evaluateMap?: Array<{ match: string; value: string }>;
  evaluateThrowsOn?: string[];
}) {
  return {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: (opts.axNodes ?? []).map((n) => ({
          nodeId: n.nodeId,
          role: { type: "role", value: n.role },
          name: { type: "string", value: n.name },
          backendDOMNodeId: n.backendDOMNodeId,
          ignored: false,
        })),
      }),
    },
    Runtime: {
      evaluate: async (args: { expression: string }) => {
        if (args.expression === "window.location.href") {
          return { result: { value: opts.pageUrl } };
        }
        // Check throw-on list first
        for (const substr of opts.evaluateThrowsOn ?? []) {
          if (args.expression.includes(substr)) {
            throw new Error(`fake evaluate throw for "${substr}"`);
          }
        }
        // Check map
        for (const { match, value } of opts.evaluateMap ?? []) {
          if (args.expression.includes(match)) {
            return { result: { value } };
          }
        }
        // Default: return empty arrays / nulls (best-effort stubs)
        return { result: { value: "[]" } };
      },
    },
    DOM: {
      getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (_args: unknown) => ({ nodeIds: [] }),
      getAttributes: async (_args: unknown) => ({ attributes: [] }),
      describeNode: async (_args: unknown) => ({ node: { backendNodeId: undefined } }),
    },
  };
}

// ─── T-snapshotCapture.SynthLiteral.1 ────────────────────────────────────────

describe("T-snapshotCapture.SynthLiteral.1 — FEED_POST_SYNTH_JS IIFE shape + substring invariants", () => {
  it(
    "T-snapshotCapture.SynthLiteral.1: when FEED_POST_SYNTH_JS is imported from the barrel, it is a non-empty IIFE string with required heuristic substrings and zero TS interpolations",
    () => {
      // Given: FEED_POST_SYNTH_JS imported from src/linkedin/snapshotCapture.js (the barrel path)
      // When:  typeof + length + opener/closer + heuristic substrings + ${} absence checked
      // Then:  all invariants hold (string, non-trivial length, IIFE shape, SIGNALS present, no interpolation)

      // 1. type
      assert.strictEqual(typeof FEED_POST_SYNTH_JS, "string", "FEED_POST_SYNTH_JS must be a string");

      // 2. non-trivial length (the JS body is ~1.5KB)
      assert.ok(
        FEED_POST_SYNTH_JS.length > 800,
        `FEED_POST_SYNTH_JS.length (${FEED_POST_SYNTH_JS.length}) must be > 800`,
      );

      // 3. IIFE opener
      assert.ok(
        FEED_POST_SYNTH_JS.startsWith("(() =>"),
        "FEED_POST_SYNTH_JS must start with '(() =>' — the IIFE opener",
      );

      // 4. IIFE closer
      assert.ok(
        FEED_POST_SYNTH_JS.endsWith("})()"),
        "FEED_POST_SYNTH_JS must end with '})()' — the IIFE invocation closer",
      );

      // 5. heuristic substrings — the SIGNALS array entries (text-signal-primary heuristic)
      for (const signal of ["comment", "repost", "reaction"]) {
        assert.ok(
          FEED_POST_SYNTH_JS.includes(`"${signal}"`),
          `FEED_POST_SYNTH_JS must include SIGNALS entry "${signal}"`,
        );
      }

      // 6. anchor regex substring — the feed post container anchor
      assert.ok(
        FEED_POST_SYNTH_JS.includes("Open control menu for post by"),
        "FEED_POST_SYNTH_JS must include the 'Open control menu for post by' anchor regex",
      );

      // 7. JSON.stringify(out) return — the serialized output form
      assert.ok(
        FEED_POST_SYNTH_JS.includes("JSON.stringify(out)"),
        "FEED_POST_SYNTH_JS must include 'JSON.stringify(out)' — the return value expression",
      );

      // 8. Edge case: zero TS template-literal interpolations (no ${...} inside the runtime JS string)
      //    Per plan §2.2: ALL 14 ${} sites in snapshotCapture.ts are in the orchestrator/helper TS code,
      //    NONE inside the synth template literals.
      assert.strictEqual(
        (FEED_POST_SYNTH_JS.match(/\$\{/g) ?? []).length,
        0,
        "FEED_POST_SYNTH_JS must contain zero '${' substrings — no TS interpolation leaked into the runtime JS",
      );
    },
  );
});

// ─── T-snapshotCapture.SynthLiteral.2 ────────────────────────────────────────

describe("T-snapshotCapture.SynthLiteral.2 — PROFILE_SYNTH_JS IIFE shape + substring invariants", () => {
  it(
    "T-snapshotCapture.SynthLiteral.2: when PROFILE_SYNTH_JS is imported from the barrel, it is a non-empty IIFE string with required heuristic substrings and zero TS interpolations",
    () => {
      // Given: PROFILE_SYNTH_JS imported from src/linkedin/snapshotCapture.js (the barrel path)
      // When:  typeof + length + opener/closer + heuristic substrings + ${} absence checked
      // Then:  all invariants hold

      // 1. type
      assert.strictEqual(typeof PROFILE_SYNTH_JS, "string", "PROFILE_SYNTH_JS must be a string");

      // 2. non-trivial length (the JS body is ~2KB)
      assert.ok(
        PROFILE_SYNTH_JS.length > 1000,
        `PROFILE_SYNTH_JS.length (${PROFILE_SYNTH_JS.length}) must be > 1000`,
      );

      // 3. IIFE opener
      assert.ok(
        PROFILE_SYNTH_JS.startsWith("(() =>"),
        "PROFILE_SYNTH_JS must start with '(() =>' — the IIFE opener",
      );

      // 4. IIFE closer
      assert.ok(
        PROFILE_SYNTH_JS.endsWith("})()"),
        "PROFILE_SYNTH_JS must end with '})()' — the IIFE invocation closer",
      );

      // 5. heuristic substrings — h1-anchor profile extraction
      assert.ok(
        PROFILE_SYNTH_JS.includes("Profile photo"),
        "PROFILE_SYNTH_JS must include 'Profile photo' — CHROME_PREFIXES filter",
      );
      assert.ok(
        PROFILE_SYNTH_JS.includes("Edit profile"),
        "PROFILE_SYNTH_JS must include 'Edit profile' — CHROME_PREFIXES filter",
      );
      assert.ok(
        PROFILE_SYNTH_JS.includes("Connect"),
        "PROFILE_SYNTH_JS must include 'Connect' — CHROME_PREFIXES filter",
      );

      // 6. NAV_SELECTOR — used to exclude nav/banner headings from the h1 search
      assert.ok(
        PROFILE_SYNTH_JS.includes("role='banner'"),
        "PROFILE_SYNTH_JS must include \"role='banner'\" — NAV_SELECTOR for nav exclusion",
      );

      // 7. DOM walk identifier
      assert.ok(
        PROFILE_SYNTH_JS.includes("compareDocumentPosition"),
        "PROFILE_SYNTH_JS must include 'compareDocumentPosition' — DOM position walk",
      );

      // 8. connections field regex
      assert.ok(
        PROFILE_SYNTH_JS.includes("connection"),
        "PROFILE_SYNTH_JS must include 'connection' — connections-line regex",
      );

      // 9. title parser
      assert.ok(
        PROFILE_SYNTH_JS.includes("document.title.match"),
        "PROFILE_SYNTH_JS must include 'document.title.match' — the title name parser",
      );

      // 10. Edge case: zero TS template-literal interpolations
      assert.strictEqual(
        (PROFILE_SYNTH_JS.match(/\$\{/g) ?? []).length,
        0,
        "PROFILE_SYNTH_JS must contain zero '${' substrings — no TS interpolation leaked into the runtime JS",
      );
    },
  );
});

// ─── T-snapshotCapture.Orchestrator.1 ────────────────────────────────────────

describe("T-snapshotCapture.Orchestrator.1 — captureCurrentSurfaceContext per-surface branching", () => {
  it(
    "T-snapshotCapture.Orchestrator.1: when called with a stub CdpClient on feed URL, returns CurrentSurfaceContext with correct shape; re-run with unknown URL returns surface='unknown'",
    async () => {
      // Given: stub CdpClient with empty AX tree and feed URL
      // When:  captureCurrentSurfaceContext(client)
      // Then:  result.surface==="feed", result.activeLayer==="page", result.entries is an array,
      //        result.pageUrl is the feed URL;  re-run with unknown URL → surface==="unknown"

      // Feed surface case
      const feedHandle = makeStubHandle({ pageUrl: "https://www.linkedin.com/feed/" });
      const feedClient = CdpClient.fromHandle(feedHandle);
      const feedCtx = await captureCurrentSurfaceContext(feedClient);

      assert.ok(typeof feedCtx === "object" && feedCtx !== null, "result must be an object");
      assert.strictEqual(
        feedCtx.pageUrl,
        "https://www.linkedin.com/feed/",
        "result.pageUrl must match the feed URL",
      );
      assert.strictEqual(feedCtx.surface, "feed", "result.surface must be 'feed' for /feed/ URL");
      assert.strictEqual(
        feedCtx.activeLayer,
        "page",
        "result.activeLayer must be 'page' (no overlay items with empty DOM stub)",
      );
      assert.ok(Array.isArray(feedCtx.entries), "result.entries must be an array");

      // Unknown surface case (edge case)
      const unknownHandle = makeStubHandle({ pageUrl: "https://example.com/" });
      const unknownClient = CdpClient.fromHandle(unknownHandle);
      const unknownCtx = await captureCurrentSurfaceContext(unknownClient);

      assert.strictEqual(unknownCtx.surface, "unknown", "result.surface must be 'unknown' for non-LinkedIn URL");
      assert.strictEqual(
        unknownCtx.activeLayer,
        "page",
        "result.activeLayer must be 'page' for unknown surface with empty stub",
      );
    },
  );
});

// ─── T-snapshotCapture.Orchestrator.2 ────────────────────────────────────────

describe("T-snapshotCapture.Orchestrator.2 — synth evaluate throws → orchestrator catches + fallback", () => {
  it(
    "T-snapshotCapture.Orchestrator.2: when FEED_POST_SYNTH_JS evaluate throws, orchestrator does not throw; result.entries has no feedPost entries; same for PROFILE and OVERLAY throw cases",
    async () => {
      // Given: stub CdpClient where Runtime.evaluate throws for any non-href expression;
      //        feed URL → infers feed surface
      // When:  captureCurrentSurfaceContext(client)
      // Then:  no throw; result.surface==="feed"; result.entries has no feedPost entries

      // Feed surface — FEED_POST_SYNTH_JS evaluate throws
      // Match by the characteristic substring used in the feed synth: "SIGNALS"
      const feedThrowHandle = makeStubHandle({
        pageUrl: "https://www.linkedin.com/feed/",
        evaluateThrowsOn: ["Open control menu for post by", "setAttribute('data-frondose-ov'"],
      });
      const feedThrowClient = CdpClient.fromHandle(feedThrowHandle);

      let feedCtx: Awaited<ReturnType<typeof captureCurrentSurfaceContext>> | undefined;
      let feedThrew = false;
      try {
        feedCtx = await captureCurrentSurfaceContext(feedThrowClient);
      } catch {
        feedThrew = true;
      }
      assert.strictEqual(feedThrew, false, "captureCurrentSurfaceContext must not throw when FEED_POST_SYNTH_JS throws");
      assert.ok(feedCtx !== undefined, "captureCurrentSurfaceContext must return a result");
      assert.strictEqual(feedCtx!.surface, "feed", "result.surface must still be 'feed'");
      assert.strictEqual(
        feedCtx!.entries.filter((e) => e.role === "feedPost").length,
        0,
        "result.entries must have no feedPost entries when synthesizeFeedPostEntries catches",
      );

      // Profile surface — PROFILE_SYNTH_JS evaluate throws (edge case 1)
      const profileThrowHandle = makeStubHandle({
        pageUrl: "https://www.linkedin.com/in/test-user/",
        evaluateThrowsOn: ["document.title.match", "setAttribute('data-frondose-ov'"],
      });
      const profileThrowClient = CdpClient.fromHandle(profileThrowHandle);

      let profileCtx: Awaited<ReturnType<typeof captureCurrentSurfaceContext>> | undefined;
      let profileThrew = false;
      try {
        profileCtx = await captureCurrentSurfaceContext(profileThrowClient);
      } catch {
        profileThrew = true;
      }
      assert.strictEqual(
        profileThrew,
        false,
        "captureCurrentSurfaceContext must not throw when PROFILE_SYNTH_JS throws",
      );
      assert.ok(profileCtx !== undefined, "captureCurrentSurfaceContext must return a result");
      assert.strictEqual(
        profileCtx!.entries.filter((e) => e.role === "profileCard").length,
        0,
        "result.entries must have no profileCard entries when synthesizeProfileEntries catches",
      );

      // Feed surface — overlay throws too (edge case 2)
      const overlayThrowHandle = makeStubHandle({
        pageUrl: "https://www.linkedin.com/feed/",
        evaluateThrowsOn: ["setAttribute('data-frondose-ov'"],
      });
      const overlayThrowClient = CdpClient.fromHandle(overlayThrowHandle);

      let overlayCtx: Awaited<ReturnType<typeof captureCurrentSurfaceContext>> | undefined;
      let overlayThrew = false;
      try {
        overlayCtx = await captureCurrentSurfaceContext(overlayThrowClient);
      } catch {
        overlayThrew = true;
      }
      assert.strictEqual(
        overlayThrew,
        false,
        "captureCurrentSurfaceContext must not throw when OVERLAY_SYNTH_JS throws",
      );
      assert.ok(overlayCtx !== undefined, "captureCurrentSurfaceContext must return a result");
      assert.strictEqual(
        overlayCtx!.activeLayer,
        "page",
        "result.activeLayer must be 'page' when overlay catch returns [] (no items)",
      );
    },
  );
});
