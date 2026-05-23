/**
 * P-3 mock tests — T-M38..T-M40: LinkedIn snapshot capture.
 *
 * Tests captureCurrentSurfaceContext() using a fake CdpClient built via
 * CdpClient.fromHandle(). No real Chrome required.
 */

import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import { captureCurrentSurfaceContext } from "../../src/linkedin/snapshotCapture.js";

/** Build a minimal fake CdpHandle for snapshot capture. */
function makeFakeHandle(opts: {
  axNodes: Array<{
    nodeId: string;
    role: string;
    name: string;
    backendDOMNodeId: number;
    ignored?: boolean;
  }>;
  pageUrl: string;
  messagingNodeIds?: number[];
  messagingAttrs?: Record<number, string[]>; // nodeId → interleaved attr array
}) {
  return {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: opts.axNodes.map((n) => ({
          nodeId: n.nodeId,
          role: n.ignored ? undefined : { type: "role", value: n.role },
          name: { type: "string", value: n.name },
          backendDOMNodeId: n.backendDOMNodeId,
          ignored: n.ignored ?? false,
        })),
      }),
    },
    Runtime: {
      evaluate: async (_args: unknown) => ({
        result: { value: opts.pageUrl },
      }),
    },
    DOM: {
      getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (_args: unknown) => ({
        nodeIds: opts.messagingNodeIds ?? [],
      }),
      getAttributes: async (args: { nodeId: number }) => {
        const attrs = opts.messagingAttrs?.[args.nodeId] ?? [];
        return { attributes: attrs };
      },
    },
  };
}

// ─── T-M38 ─────────────────────────────────────────────────────────────────────

test("T-M38: captureCurrentSurfaceContext on feed URL returns correct surface + entries", async () => {
  const fakeHandle = makeFakeHandle({
    axNodes: [
      { nodeId: "ax1", role: "button", name: "Start a post", backendDOMNodeId: 10 },
      { nodeId: "ax2", role: "link", name: "Home", backendDOMNodeId: 11 },
      { nodeId: "ax3", role: "staticText", name: "Top post content here", backendDOMNodeId: 12 },
    ],
    pageUrl: "https://www.linkedin.com/feed/",
  });

  const client = CdpClient.fromHandle(fakeHandle);
  const ctx = await captureCurrentSurfaceContext(client);

  assert.equal(ctx.surface, "feed", "surface must be 'feed' for /feed/ URL");
  assert.equal(ctx.activeLayer, "page", "activeLayer must always be 'page' in P-3");
  assert.equal(ctx.pageUrl, "https://www.linkedin.com/feed/");
  assert.equal(ctx.entries.length, 3, "must have 3 entries from AX nodes");

  // Entries must have correct refs and roles
  const refs = ctx.entries.map((e) => e.ref);
  assert.ok(refs.includes("@e1"), "must include @e1");
  assert.ok(refs.includes("@e2"), "must include @e2");
  assert.ok(refs.includes("@e3"), "must include @e3");

  const e1 = ctx.entries.find((e) => e.ref === "@e1");
  assert.equal(e1?.role, "button");
  assert.equal(e1?.name, "Start a post");
});

// ─── T-M39 ─────────────────────────────────────────────────────────────────────

test("T-M39: captureCurrentSurfaceContext on messaging URL synthesizes @mr* entries", async () => {
  const fakeHandle = makeFakeHandle({
    axNodes: [{ nodeId: "ax1", role: "button", name: "New message", backendDOMNodeId: 20 }],
    pageUrl: "https://www.linkedin.com/messaging/",
    messagingNodeIds: [101, 102],
    messagingAttrs: {
      101: ["aria-label", "Alice Smith", "class", "msg-conversation-listitem"],
      102: ["class", "msg-conversation-listitem", "aria-label", "Bob Jones"],
    },
  });

  const client = CdpClient.fromHandle(fakeHandle);
  const ctx = await captureCurrentSurfaceContext(client);

  assert.equal(ctx.surface, "messaging");

  // Should have 1 AX entry + 2 synthesized @mr entries
  assert.equal(ctx.entries.length, 3, "must have 1 AX entry + 2 @mr entries");

  const mr1 = ctx.entries.find((e) => e.ref === "@mr1");
  const mr2 = ctx.entries.find((e) => e.ref === "@mr2");

  assert.ok(mr1 !== undefined, "must have @mr1 entry");
  assert.ok(mr2 !== undefined, "must have @mr2 entry");
  assert.equal(mr1?.role, "messagingConversationOpener");
  assert.equal(mr1?.name, "Alice Smith", "@mr1 label must come from aria-label");
  assert.equal(mr2?.name, "Bob Jones", "@mr2 label must come from aria-label");
});

// ─── T-M40 ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// P-47 G-3 helpers and scaffolds (Step 4a — all assertion bodies TODO; added 2026-05-20)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fake handle for profile surface tests. Distinguishes:
 * - `window.location.href` evaluate → returns pageUrl (used by getCurrentUrl)
 * - Any other evaluate expression (PROFILE_SYNTH_JS) → returns profileJson
 *
 * This powers T-Profile.1 and T-Profile.3 without a live Chrome.
 */
function makeFakeProfileHandle(opts: {
  axNodes: Array<{
    nodeId: string;
    role: string;
    name: string;
    backendDOMNodeId: number;
  }>;
  pageUrl: string;
  /** JSON string returned by the PROFILE_SYNTH_JS evaluate call. Use "null" for no-h1 path. */
  profileJson: string;
  /** If true, the PROFILE_SYNTH_JS evaluate call throws instead of returning. */
  evaluateThrows?: boolean;
}) {
  return {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: opts.axNodes.map((n) => ({
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
        // getCurrentUrl uses "window.location.href"; synthesizeProfileEntries uses PROFILE_SYNTH_JS
        if (args.expression === "window.location.href") {
          return { result: { value: opts.pageUrl } };
        }
        // PROFILE_SYNTH_JS evaluate call
        if (opts.evaluateThrows) throw new Error("fake evaluate throw");
        return { result: { value: opts.profileJson } };
      },
    },
    DOM: {
      getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (_args: unknown) => ({ nodeIds: [] }),
      getAttributes: async (_args: unknown) => ({ attributes: [] }),
    },
  };
}

/** Stub 5 nav AX entries for profile tests (the entries that appear AFTER the profileCard entries). */
const PROFILE_NAV_AX_NODES = [
  { nodeId: "ax1", role: "link", name: "Home", backendDOMNodeId: 10 },
  { nodeId: "ax2", role: "link", name: "My Network", backendDOMNodeId: 11 },
  { nodeId: "ax3", role: "link", name: "Jobs", backendDOMNodeId: 12 },
  { nodeId: "ax4", role: "staticText", name: "LinkedIn", backendDOMNodeId: 13 },
  { nodeId: "ax5", role: "staticText", name: "Search", backendDOMNodeId: 14 },
];

/** Serialized ProfileCardRaw for T-Profile.1 (shape matches §6.3 interface). */
const PROFILE_JSON_JANE_DOE = JSON.stringify({
  name: "Jane Doe",
  headline: "VP Sales at Acme",
  company: "Acme",
  location: "London, UK",
  connections: "500+ connections",
});

// ─── T-Profile.1 (G-P47.4): profileCard entries prepended ────────────────────

describe("T-Profile.1 (G-P47.4): synthesizeProfileEntries prepends @pp1/@pp2 profileCard entries at index 0", () => {
  it("entries[0]=@pp1 with 'Jane Doe' and 'VP Sales'; entries[1]=@pp2 with Acme/London/500+; nav entries follow at ≥2", async () => {
    // Given: captureCurrentSurfaceContext with profile URL → inferSurface = "profile";
    //        stub client.evaluate(PROFILE_SYNTH_JS) returns PROFILE_JSON_JANE_DOE;
    //        5 nav AX nodes in refMap (entries that existed before prepend)
    // When:  captureCurrentSurfaceContext(client) runs
    //        (Step 4b adds the profile branch: entries.unshift(...synthesizeProfileEntries))
    // Then:  (a) ctx.entries[0].role === "profileCard" AND ref === "@pp1"
    //             AND name includes "Jane Doe" and "VP Sales at Acme"
    //         (b) ctx.entries[1].role === "profileCard" AND ref === "@pp2"
    //             AND name includes "Acme" and "London, UK" and "500+ connections"
    //         (c) Original nav entries follow at indices ≥ 2 (were prepended, not appended)
    //         (d) ctx.surface === "profile"
    const handle = makeFakeProfileHandle({
      axNodes: PROFILE_NAV_AX_NODES,
      pageUrl: "https://www.linkedin.com/in/jane-doe/",
      profileJson: PROFILE_JSON_JANE_DOE,
    });
    const client = CdpClient.fromHandle(handle);
    const ctx = await captureCurrentSurfaceContext(client);

    // (d) ctx.surface === "profile"
    assert.equal(ctx.surface, "profile", "T-Profile.1: ctx.surface must be 'profile'");

    // (a) entries[0]: @pp1 profileCard identity line (prepended via unshift)
    assert.equal(ctx.entries[0]?.role, "profileCard", "T-Profile.1: entries[0].role must be 'profileCard'");
    assert.equal(ctx.entries[0]?.ref, "@pp1", "T-Profile.1: entries[0].ref must be '@pp1'");
    assert.ok(ctx.entries[0]?.name.includes("Jane Doe"), "T-Profile.1: @pp1 name must include 'Jane Doe'");
    assert.ok(
      ctx.entries[0]?.name.includes("VP Sales at Acme"),
      "T-Profile.1: @pp1 name must include 'VP Sales at Acme'",
    );

    // (b) entries[1]: @pp2 profileCard details line
    assert.equal(ctx.entries[1]?.role, "profileCard", "T-Profile.1: entries[1].role must be 'profileCard'");
    assert.equal(ctx.entries[1]?.ref, "@pp2", "T-Profile.1: entries[1].ref must be '@pp2'");
    assert.ok(ctx.entries[1]?.name.includes("Acme"), "T-Profile.1: @pp2 name must include 'Acme'");
    assert.ok(ctx.entries[1]?.name.includes("London, UK"), "T-Profile.1: @pp2 name must include 'London, UK'");
    assert.ok(ctx.entries[1]?.name.includes("500+"), "T-Profile.1: @pp2 name must include '500+'");

    // (c) nav entries follow at indices ≥ 2 (prepend: not appended)
    assert.ok(ctx.entries.length >= 7, "T-Profile.1: total entries = 2 profileCard + 5 nav AX nodes");
    assert.ok(
      ctx.entries[2]?.role !== "profileCard",
      "T-Profile.1: entry at index 2 must be a nav entry (not profileCard)",
    );
  });
});

// ─── T-Profile.3 (G-P47.4): extraction failure is silent best-effort ─────────

describe("T-Profile.3 (G-P47.4): extraction failure yields no profileCard entries and does not throw", () => {
  it("(a) null JSON: no @pp entries; (b) malformed JSON: no @pp entries; (c) evaluate throws: no @pp entries", async () => {
    // Given: three sub-cases — all profile URL, 5 nav AX nodes:
    //   (a) evaluate returns "null"  (PROFILE_SYNTH_JS no-h1 path: `if (!h1) return JSON.stringify(null)`)
    //   (b) evaluate returns "{broken json"  (malformed JSON → JSON.parse throws → catch returns [])
    //   (c) evaluate itself throws  (CDP error → catch returns [])
    // When:  captureCurrentSurfaceContext(client) runs for each sub-case
    // Then:  all three cases: no entry with role==="profileCard" in ctx.entries;
    //        ctx.entries contains only the 5 nav entries from the AX snapshot;
    //        captureCurrentSurfaceContext does NOT throw.
    const casesConfig = [
      { desc: "null JSON (no-h1 path)", profileJson: "null", evaluateThrows: false },
      { desc: "malformed JSON", profileJson: "{broken", evaluateThrows: false },
      { desc: "evaluate throws", profileJson: "", evaluateThrows: true },
    ] as const;

    for (const tc of casesConfig) {
      const handle = makeFakeProfileHandle({
        axNodes: PROFILE_NAV_AX_NODES,
        pageUrl: "https://www.linkedin.com/in/jane-doe/",
        profileJson: tc.profileJson,
        evaluateThrows: tc.evaluateThrows,
      });
      const client = CdpClient.fromHandle(handle);

      // captureCurrentSurfaceContext must not throw
      let ctx: Awaited<ReturnType<typeof captureCurrentSurfaceContext>> | undefined;
      let threw = false;
      try {
        ctx = await captureCurrentSurfaceContext(client);
      } catch {
        threw = true;
      }
      assert.equal(threw, false, `T-Profile.3 [${tc.desc}]: captureCurrentSurfaceContext must not throw`);
      if (!ctx) continue;

      // No profileCard entries in result
      const profileCards = ctx.entries.filter((e) => e.role === "profileCard");
      assert.equal(profileCards.length, 0, `T-Profile.3 [${tc.desc}]: no profileCard entries when extraction fails`);

      // Only the 5 nav AX entries remain (no synthesis added)
      assert.equal(ctx.entries.length, 5, `T-Profile.3 [${tc.desc}]: exactly 5 nav entries (AX only)`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

test("T-M40: captureCurrentSurfaceContext on non-LinkedIn URL returns 'unknown' surface without messaging synthesis", async () => {
  const fakeHandle = makeFakeHandle({
    axNodes: [{ nodeId: "ax1", role: "heading", name: "Welcome", backendDOMNodeId: 30 }],
    pageUrl: "https://google.com/",
    // messagingNodeIds not provided — should not be queried
  });

  const client = CdpClient.fromHandle(fakeHandle);
  const ctx = await captureCurrentSurfaceContext(client);

  assert.equal(ctx.surface, "unknown", "non-LinkedIn URL must surface 'unknown'");
  assert.equal(ctx.entries.length, 1, "must have exactly 1 AX entry; no @mr synthesis for non-messaging surface");

  // No @mr refs
  const mrRefs = ctx.entries.filter((e) => e.ref.startsWith("@mr"));
  assert.equal(mrRefs.length, 0, "must have no @mr refs for non-messaging surface");
});
