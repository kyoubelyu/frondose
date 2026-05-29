/**
 * P-3 mock tests — T-M38..T-M40: LinkedIn snapshot capture.
 * P-47 G-3 — T-Profile.1, T-Profile.3: profile-surface synthesis.
 * P-59 D-G6 Layer-2 — T-G6.1..T-G6.5: retry-with-delay + [data-test-modal] selector.
 *   Step 4a scaffolds — all assertion bodies are TODO; all 5 intentionally FAIL.
 *   Assertions filled at Step 5 after builder 4b lands.
 *
 * Tests captureCurrentSurfaceContext() using a fake CdpClient built via
 * CdpClient.fromHandle(). No real Chrome required.
 *
 * Source-text assertions (T-G6.*) read snapshotCapture.ts directly — no CDP needed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CdpClient } from "../../src/cdp/client.js";
import { captureCurrentSurfaceContext } from "../../src/linkedin/snapshotCapture.js";

// ─── Source-text harness (D-G6 source-structural assertions) ─────────────────

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SNAPSHOT_CAPTURE_SRC = readFileSync(join(REPO, "src/linkedin/snapshotCapture.ts"), "utf-8");

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

// ─────────────────────────────────────────────────────────────────────────────
// P-59 D-G6 — Layer-2 round 3 — T-G6.1..T-G6.6
// Source-structural scaffolds. All assertion bodies are TODO (intentionally fail).
// Step 4a — Filled at Step 5 after builder 4b (Sketches A+B from plan §6.4).
//
// Guardian Step-3 amendments applied (CONCERN-MR C1/C2/C3/D2/A3/NIT):
//   Amendment 1 (C3): Added T-G6.6 — assert all 5 selector arms survive the edit
//     (the original 4: menuitem/option/dialog/alertdialog + the new data-test-modal).
//     T-G6.1 retains focus on the new arm; T-G6.6 provides regression defense.
//   Amendment 2 (C1/C2): T-G6.3 scoped to synthesizeOverlayEntries function body,
//     not the whole file — avoids brittleness if other callers use the same snippet.
//   Amendment 3 (D2/A3 — Step 5 note): pre-click baseline MANDATORY; any non-zero
//     overlay entries on bare profile BEFORE clicking @e33 = Step-5 FAILURE.
//   Amendment 4 (NIT — Step 5 note): live G6 modal proof keys on label TEXT (e.g.
//     "Add a note" / "Send without a note"), NOT role — [data-test-modal] matches
//     get classified 'menuitem' by the role classifier (snapshotCapture.ts:125).
//
// Gate coverage:
//   T-G6.1 → G-P59.1 (INSPECT-1 overlay capture) — new [data-test-modal] arm present
//   T-G6.2 → G-P59.1 — retry-with-delay shape (two eval call sites + 350ms gating)
//   T-G6.3 → G-P59.1 — bounded retry within fn body (exactly 2 evals — anti-while-loop)
//   T-G6.4 → G-P59.1 — early-return preservation (captureCurrentSurfaceContext branch unchanged)
//   T-G6.5 → G-P59.1 — Option β proof (no unconditional sleep before first eval)
//   T-G6.6 → G-P59.1 — selector regression defense (all 4 original arms preserved)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// P-74 — T-P74.Overlay.1/.2 — behavioral regression guards for INSPECT-1
// (already-shipped in b40013f; these lock the overlay-entry + retry paths)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a fake handle for overlay-synthesis tests. The handle stubs:
 *   - AX tree (empty by default — overlay path doesn't need AX entries)
 *   - Runtime.evaluate:
 *       • "window.location.href" → pageUrl
 *       • expression containing setAttribute('data-mai-ov' → OVERLAY_SYNTH_JS → overlayEvalResults[n]
 *       • cleanup expr containing removeAttribute → return undefined (best-effort)
 *   - DOM: getDocument, querySelectorAll (→ overlayNodeIds), describeNode (→ backendNodeId)
 */
function makeOverlayFakeHandle(opts: {
  pageUrl: string;
  overlayEvalResults: string[]; // successive results for OVERLAY_SYNTH_JS calls
  overlayNodeIds: number[]; // returned from querySelectorAll('[data-mai-ov=…]')
  backendNodeId: number; // returned by DOM.describeNode
  axNodes?: Array<{ nodeId: string; role: string; name: string; backendDOMNodeId: number }>;
}) {
  let overlayEvalCallCount = 0;
  return {
    handle: {
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
          // OVERLAY_SYNTH_JS is identified by its data-mai-ov setAttribute marker
          if (args.expression.includes("setAttribute('data-mai-ov'")) {
            const result = opts.overlayEvalResults[overlayEvalCallCount] ?? "[]";
            overlayEvalCallCount++;
            return { result: { value: result } };
          }
          // cleanup eval (removeAttribute) or other — best-effort, return nothing
          return { result: { value: undefined } };
        },
      },
      DOM: {
        getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
        querySelectorAll: async (_args: unknown) => ({ nodeIds: opts.overlayNodeIds }),
        getAttributes: async (_args: unknown) => ({ attributes: [] }),
        describeNode: async (_args: unknown) => ({ node: { backendNodeId: opts.backendNodeId } }),
      },
    },
    getOverlayEvalCallCount: () => overlayEvalCallCount,
  };
}

describe("T-P74.Overlay.1 (INSPECT-1 RC-1): overlay menuitem → clickable @ov1 + activeLayer=overlay + mergeRefs called", () => {
  it(
    "when OVERLAY_SYNTH_JS returns [{i:1,role:'menuitem',label:'Connect'}], captureCurrentSurfaceContext produces @ov1 entry + activeLayer:overlay + client refMap contains ov1",
    async () => {
      // Given: a fake CdpClient on a non-special URL ('unknown' surface, no messaging/profile/feed synth);
      //        OVERLAY_SYNTH_JS eval returns one menuitem [{i:1,role:'menuitem',label:'Connect'}];
      //        DOM.describeNode returns {node:{backendNodeId:99}} so @ov1 is clickable.
      // When:  captureCurrentSurfaceContext(client) runs.
      // Then:  entries include {ref:'@ov1',role:'menuitem',name:'Connect'};
      //        activeLayer === 'overlay';
      //        client.currentRefMap.ov1.backendNodeId === 99 (mergeRefs was called — the clickability lynchpin).
      const { handle } = makeOverlayFakeHandle({
        pageUrl: "https://www.linkedin.com/settings/",
        overlayEvalResults: [JSON.stringify([{ i: 1, role: "menuitem", label: "Connect" }])],
        overlayNodeIds: [42],
        backendNodeId: 99,
      });
      const client = CdpClient.fromHandle(handle);
      const ctx = await captureCurrentSurfaceContext(client);

      const ov1 = ctx.entries.find((e) => e.ref === "@ov1");
      assert.ok(ov1 !== undefined, "T-P74.Overlay.1: entries must include @ov1 ref");
      assert.equal(ov1?.role, "menuitem", "T-P74.Overlay.1: @ov1 role must be 'menuitem'");
      assert.equal(ov1?.name, "Connect", "T-P74.Overlay.1: @ov1 name must be 'Connect'");
      assert.equal(ctx.activeLayer, "overlay", "T-P74.Overlay.1: activeLayer must be 'overlay' when overlay items found");
      // mergeRefs called — ov1 is in the client's refMap with the correct backendNodeId
      const refEntry = (client.currentRefMap as Record<string, { backendNodeId: number }>)["ov1"];
      assert.ok(refEntry !== undefined, "T-P74.Overlay.1: client.currentRefMap must contain 'ov1' (mergeRefs called)");
      assert.equal(refEntry?.backendNodeId, 99, "T-P74.Overlay.1: ov1.backendNodeId must be 99 (clickability lynchpin)");
    },
  );
});

describe("T-P74.Overlay.2 (INSPECT-1 RC-1 + D-G6): 0-item first eval triggers 350ms retry → dialog entry in output", () => {
  it(
    "when first OVERLAY_SYNTH_JS eval returns '[]' and second returns a dialog item, the retry fires and the dialog entry appears",
    async () => {
      // Given: a fake where OVERLAY_SYNTH_JS returns "[]" on call 1 and
      //        JSON([{i:1,role:'dialog',label:'Invite to connect'}]) on call 2 (mid-transition overlay);
      //        DOM.describeNode returns backendNodeId:77.
      // When:  captureCurrentSurfaceContext(client) runs (the 350ms retry fires after the empty first eval).
      // Then:  entries include {ref:'@ov1',role:'dialog',name:'Invite to connect'};
      //        exactly 2 OVERLAY_SYNTH_JS evals occurred (bounded single retry).
      const { handle, getOverlayEvalCallCount } = makeOverlayFakeHandle({
        pageUrl: "https://www.linkedin.com/settings/",
        overlayEvalResults: [
          "[]",
          JSON.stringify([{ i: 1, role: "dialog", label: "Invite to connect" }]),
        ],
        overlayNodeIds: [55],
        backendNodeId: 77,
      });
      const client = CdpClient.fromHandle(handle);
      const ctx = await captureCurrentSurfaceContext(client);

      assert.equal(getOverlayEvalCallCount(), 2, "T-P74.Overlay.2: exactly 2 OVERLAY_SYNTH_JS evals must occur (bounded retry)");

      const ov1 = ctx.entries.find((e) => e.ref === "@ov1");
      assert.ok(ov1 !== undefined, "T-P74.Overlay.2: entries must include @ov1 after retry");
      assert.equal(ov1?.role, "dialog", "T-P74.Overlay.2: @ov1 role must be 'dialog'");
      assert.equal(ov1?.name, "Invite to connect", "T-P74.Overlay.2: @ov1 name must be 'Invite to connect'");
      assert.equal(ctx.activeLayer, "overlay", "T-P74.Overlay.2: activeLayer must be 'overlay'");
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────

describe("T-G6 — D-G6 fix: OVERLAY_SYNTH_JS + synthesizeOverlayEntries retry-with-delay (P-59 D-G6, source-structural)", () => {
  it("T-G6.1: when snapshotCapture.ts OVERLAY_SYNTH_JS constant is read, querySelectorAll selector list includes '[data-test-modal]' (covers H3 — unroled artdeco modals such as the LinkedIn 'Invite to connect' dialog)", () => {
    // Given: SNAPSHOT_CAPTURE_SRC = src/linkedin/snapshotCapture.ts source text
    // When:  OVERLAY_SYNTH_JS constant body is inspected for the querySelectorAll selector list
    // Then:  selector string contains '[data-test-modal]' so artdeco-modals without an ARIA role attribute are captured
    assert.ok(
      SNAPSHOT_CAPTURE_SRC.includes("[data-test-modal]"),
      "T-G6.1: OVERLAY_SYNTH_JS must include '[data-test-modal]' selector arm (Sketch A — covers H3 unroled artdeco modals)",
    );
  });

  it("T-G6.2: when synthesizeOverlayEntries body is read, TWO client.evaluate<string>(OVERLAY_SYNTH_JS) call sites are present AND a setTimeout(…, 350) (or 350ms Promise sleep) is between them AND the retry is gated on items.length === 0 (retry-with-delay shape — Option β)", () => {
    // Given: SNAPSHOT_CAPTURE_SRC = snapshotCapture.ts source text
    // When:  the synthesizeOverlayEntries function body is examined for evaluate call sites + retry shape
    // Then:  either 2 evalOverlay() calls (closure pattern) OR 2 direct client.evaluate calls;
    //        a 350ms settle is between them; the second fires ONLY when items.length === 0
    //
    // Note: Sketch B uses an evalOverlay closure (1 evaluate definition, called twice via evalOverlay()).
    //       Both patterns satisfy the retry-with-delay behavioral contract.
    const fnStart = SNAPSHOT_CAPTURE_SRC.indexOf("async function synthesizeOverlayEntries");
    const fnEnd = SNAPSHOT_CAPTURE_SRC.indexOf("\nasync function ", fnStart + 1);
    const fnBody = fnEnd > fnStart ? SNAPSHOT_CAPTURE_SRC.slice(fnStart, fnEnd) : SNAPSHOT_CAPTURE_SRC.slice(fnStart);

    // 2a: two invocations of the evaluate path (either via closure or direct)
    const closureCallCount = (fnBody.match(/await evalOverlay\(\)/g) ?? []).length;
    const directEvalCount = (fnBody.match(/client\.evaluate<string>\(OVERLAY_SYNTH_JS\)/g) ?? []).length;
    assert.ok(
      closureCallCount >= 2 || directEvalCount >= 2,
      `T-G6.2a: fn body must have ≥2 evalOverlay() calls (${closureCallCount}) OR ≥2 direct evaluate calls (${directEvalCount}) — retry-with-delay shape`,
    );

    // 2b: 350ms settle present
    assert.ok(
      fnBody.includes("setTimeout") && fnBody.includes("350"),
      "T-G6.2b: fn body must contain 'setTimeout' + '350' — the 350ms settle between first and retry eval",
    );

    // 2c: retry gated on items.length === 0 (conditional, not unconditional)
    assert.ok(
      fnBody.includes("items.length === 0"),
      "T-G6.2c: fn body must contain 'items.length === 0' — gates the retry, not unconditional",
    );
  });

  it("T-G6.3: when synthesizeOverlayEntries FUNCTION BODY is sliced from SNAPSHOT_CAPTURE_SRC, the count of 'client.evaluate<string>(OVERLAY_SYNTH_JS)' occurrences in that slice is EXACTLY 2 (bounded retry, not a while-loop — Amendment 2: scoped to fn body, not whole file)", () => {
    // Given: SNAPSHOT_CAPTURE_SRC = snapshotCapture.ts source text
    // When:  synthesizeOverlayEntries function body is sliced (from 'async function synthesizeOverlayEntries'
    //        to the next top-level function boundary), then counted for bounded-retry evidence
    // Then:  either: evalOverlay() invocation count === 2 in the fn slice (closure pattern)
    //        OR:     client.evaluate<string>(OVERLAY_SYNTH_JS) occurrence count === 2 in the fn slice (direct pattern)
    //        — proves a single bounded re-eval, not a polling while-loop.
    //        Scoped to fn body avoids false positives from future callers elsewhere in the file (Amendment 2).
    const fnStart = SNAPSHOT_CAPTURE_SRC.indexOf("async function synthesizeOverlayEntries");
    const fnEnd = SNAPSHOT_CAPTURE_SRC.indexOf("\nasync function ", fnStart + 1);
    const fnBody = fnEnd > fnStart ? SNAPSHOT_CAPTURE_SRC.slice(fnStart, fnEnd) : SNAPSHOT_CAPTURE_SRC.slice(fnStart);

    const closureCallCount = (fnBody.match(/evalOverlay\(\)/g) ?? []).length;
    const directEvalCount = (fnBody.match(/client\.evaluate<string>\(OVERLAY_SYNTH_JS\)/g) ?? []).length;

    assert.ok(
      closureCallCount === 2 || directEvalCount === 2,
      `T-G6.3: synthesizeOverlayEntries fn body must have exactly 2 evalOverlay() calls (got ${closureCallCount}) ` +
        `OR exactly 2 direct client.evaluate calls (got ${directEvalCount}) — bounded retry, not a while-loop`,
    );
  });

  it("T-G6.4: when synthesizeOverlayEntries body is read, a 'return { entries: [], refs: {} }' early-return guarded on 'items.length === 0' is present AFTER the retry block (preserves the captureCurrentSurfaceContext activeLayer:page branch for legitimately-empty overlays)", () => {
    // Given: SNAPSHOT_CAPTURE_SRC = snapshotCapture.ts source text
    // When:  synthesizeOverlayEntries body is examined for the post-retry early-return guard
    // Then:  the LAST occurrence of 'items.length === 0' (after the retry block) is followed by
    //        'return { entries: [], refs: {} }' — so legitimately-empty overlays short-circuit the for-loop
    const lastLengthCheckIdx = SNAPSHOT_CAPTURE_SRC.lastIndexOf("items.length === 0");
    assert.ok(
      lastLengthCheckIdx !== -1,
      "T-G6.4a: 'items.length === 0' must appear at least once (post-retry early-return guard)",
    );
    const afterLastCheck = SNAPSHOT_CAPTURE_SRC.slice(lastLengthCheckIdx, lastLengthCheckIdx + 120);
    assert.ok(
      afterLastCheck.includes("return { entries: [], refs: {} }"),
      "T-G6.4b: the last 'items.length === 0' guard must be followed by 'return { entries: [], refs: {} }' within ~120 chars — early-return preserved",
    );
  });

  it("T-G6.5: when synthesizeOverlayEntries body is read, NO setTimeout / Promise sleep appears BEFORE the first client.evaluate<string>(OVERLAY_SYNTH_JS) call (proves Option β — retry-only — NOT Option α — unconditional pre-eval settle)", () => {
    // Given: SNAPSHOT_CAPTURE_SRC = snapshotCapture.ts source text
    // When:  the text between the start of synthesizeOverlayEntries and the first evaluate call is sliced
    // Then:  'setTimeout' does NOT appear in that prefix span — zero latency on the common path confirmed
    const fnStart = SNAPSHOT_CAPTURE_SRC.indexOf("async function synthesizeOverlayEntries");
    const firstEvalIdx = SNAPSHOT_CAPTURE_SRC.indexOf("client.evaluate<string>(OVERLAY_SYNTH_JS)", fnStart);
    assert.ok(
      firstEvalIdx !== -1,
      "T-G6.5 precondition: client.evaluate<string>(OVERLAY_SYNTH_JS) must exist after synthesizeOverlayEntries start",
    );
    const prefixBeforeFirstEval = SNAPSHOT_CAPTURE_SRC.slice(fnStart, firstEvalIdx);
    assert.ok(
      !prefixBeforeFirstEval.includes("setTimeout"),
      "T-G6.5: no 'setTimeout' must appear before the first client.evaluate call in synthesizeOverlayEntries — confirms Option β (retry-only, not unconditional pre-eval settle)",
    );
  });

  it("T-G6.6: OVERLAY_SYNTH_JS querySelectorAll selector still contains ALL 4 original arms after the [data-test-modal] addition — regression defense (Amendment 1 / CONCERN-MR C3)", () => {
    // Given: SNAPSHOT_CAPTURE_SRC = snapshotCapture.ts source text
    // When:  OVERLAY_SYNTH_JS constant body is searched for the 4 pre-existing selector arms
    // Then:  ALL of '[role="menuitem"]', '[role="option"]', '[role="dialog"]', '[role="alertdialog"]'
    //        are present — Sketch A added [data-test-modal] without dropping any existing arm
    for (const arm of ['[role="menuitem"]', '[role="option"]', '[role="dialog"]', '[role="alertdialog"]']) {
      assert.ok(
        SNAPSHOT_CAPTURE_SRC.includes(arm),
        `T-G6.6: OVERLAY_SYNTH_JS must still contain selector arm '${arm}' — regression defense; no arm dropped by Sketch A`,
      );
    }
  });

  it("T-G6.7: OVERLAY_SYNTH_JS still contains '[data-test-modal]' — Issue B regression guard (scout-verified selector must not be dropped by future refactors)", () => {
    // Given: SNAPSHOT_CAPTURE_SRC = snapshotCapture.ts source text (post round-3 builder Step 4b);
    //        scout's live DOM investigation confirmed [data-test-modal] is the correct attribute
    //        on the artdeco connect dialog (docs/phase-59-d-g6-selector-research.md §3-§4);
    //        round-4 plan §R4-2 confirms NO source change to snapshotCapture.ts in round 4
    // When:  SNAPSHOT_CAPTURE_SRC is inspected for '[data-test-modal]' (per §R4-4: "Issue B
    //        'selector still contains [data-test-modal]' is a regression invariant of T-G6.1")
    // Then:  '[data-test-modal]' is present — regression guard so future selector refactors
    //        cannot silently drop the scout-verified attribute (ALREADY PASSES — intentional)
    assert.ok(
      SNAPSHOT_CAPTURE_SRC.includes("[data-test-modal]"),
      "T-G6.7: OVERLAY_SYNTH_JS must contain '[data-test-modal]' — Issue B regression guard; scout-verified correct selector for the artdeco connect dialog (phase-59-d-g6-selector-research.md §3-§4)",
    );
  });
});
