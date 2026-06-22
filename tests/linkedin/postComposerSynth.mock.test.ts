/**
 * P-POST Step 2 — TDD scaffold.
 * T-Post.Synth.1–5: postComposerSynth DOM-eval + ref emission.
 *
 * Gate: G-POST.Synth
 *
 * All assertion bodies are TODO (assert.fail); all tests intentionally fail until
 * Step 4 (builder) creates src/linkedin/snapshotCapture/postComposerSynth.ts and
 * wires it into snapshotCapture.ts.
 *
 * Fake-CDP pattern mirrors messagingConversationSynth.mock.test.ts:
 *   - Runtime.evaluate dispatch based on expression content
 *   - DOM.querySelectorAll returns nodeIds for data-frondose-pc markers
 *   - DOM.describeNode returns backendNodeId
 *   - captureCurrentSurfaceContext used for wiring tests (T-Post.Synth.2/3)
 *     so they compile against the already-existing function
 *
 * T-Post.Synth.2 CRITICAL: assert that Runtime.evaluate is NEVER called with an
 * expression containing "data-frondose-pc" when composer is closed (count === 0).
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/linkedin/postComposerSynth.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import { captureCurrentSurfaceContext } from "../../src/linkedin/snapshotCapture.js";

// ─── Fake CDP handle factory for post-composer synth tests ────────────────────
//
// Mirrors the makeMessagingThreadHandle pattern from messagingConversationSynth.mock.test.ts.
// The fake handle stubs:
//   - AX tree (axNodes)
//   - Runtime.evaluate:
//       * "window.location.href"       → returns pageUrl
//       * expr containing "data-frondose-pc" + "setAttribute" → POST_COMPOSER_SYNTH_JS → composerJson
//       * expr containing "data-frondose-pc" + "removeAttribute" → cleanup (returns undefined)
//       * expr containing "data-frondose-ov" + "setAttribute" → overlay (returns "[]")
//   - DOM: getDocument, querySelectorAll, describeNode, getAttributes
//

function makePostComposerHandle(opts: {
  pageUrl: string;
  axNodes: Array<{
    nodeId: string;
    role: string;
    name: string;
    backendDOMNodeId: number;
    ignored?: boolean;
  }>;
  /** JSON string the POST_COMPOSER_SYNTH_JS eval returns. Default "[]". */
  composerJson?: string;
  /**
   * Map from data-frondose-pc index (e.g. "1", "2") to nodeIds returned
   * by DOM.querySelectorAll. Default [].
   */
  composerNodeIdsByIndex?: Record<string, number[]>;
  /** Per-index backendNodeId returned from DOM.describeNode. Default 401. */
  composerBackendNodeIdByIndex?: Record<string, number>;
  /** Whether the POST_COMPOSER_SYNTH_JS eval throws. */
  composerThrows?: boolean;
  /** Whether the cleanup removeAttribute eval throws. */
  cleanupThrows?: boolean;
  /** Accumulates every Runtime.evaluate expression for assertion. */
  evalLog?: string[];
}) {
  const {
    pageUrl,
    axNodes,
    composerJson = "[]",
    composerNodeIdsByIndex = {},
    composerBackendNodeIdByIndex = {},
    composerThrows = false,
    cleanupThrows = false,
    evalLog,
  } = opts;

  // Track call count per eval purpose
  let synthEvalCount = 0;

  return {
    _getSynthEvalCount: () => synthEvalCount,
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: axNodes.map((n) => ({
          nodeId: n.nodeId,
          role: n.ignored ? undefined : { type: "role", value: n.role },
          name: { type: "string", value: n.name },
          backendDOMNodeId: n.backendDOMNodeId,
          ignored: n.ignored ?? false,
        })),
      }),
    },
    Runtime: {
      evaluate: async (args: { expression: string }) => {
        if (evalLog) evalLog.push(args.expression);
        if (args.expression === "window.location.href") {
          return { result: { value: pageUrl } };
        }
        // POST_COMPOSER_SYNTH_JS is identified by data-frondose-pc + setAttribute
        if (args.expression.includes("data-frondose-pc") && args.expression.includes("setAttribute")) {
          synthEvalCount++;
          if (composerThrows) throw new Error("fake POST_COMPOSER_SYNTH_JS eval throw");
          return { result: { value: composerJson } };
        }
        // Cleanup eval: data-frondose-pc + removeAttribute
        if (args.expression.includes("data-frondose-pc") && args.expression.includes("removeAttribute")) {
          if (cleanupThrows) throw new Error("fake cleanup eval throw");
          return { result: { value: undefined } };
        }
        // Overlay synth eval (data-frondose-ov)
        if (args.expression.includes("data-frondose-ov") && args.expression.includes("setAttribute")) {
          return { result: { value: "[]" } };
        }
        // Other cleanup / feed synth evals — best-effort
        return { result: { value: undefined } };
      },
    },
    DOM: {
      getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (args: { nodeId: number; selector: string }) => {
        // Return composerNodeIds when querying for data-frondose-pc markers
        const match = args.selector?.match(/data-frondose-pc="(\d+)"/);
        if (match) {
          const idx = match[1] ?? "";
          return { nodeIds: composerNodeIdsByIndex[idx] ?? [] };
        }
        return { nodeIds: [] };
      },
      getAttributes: async (_args: unknown) => ({ attributes: [] }),
      describeNode: async (args: { nodeId?: number }) => {
        // Return the per-index backendNodeId if known
        const nodeId = args.nodeId;
        if (nodeId !== undefined) {
          // Find matching entry
          for (const [idx, nodeIds] of Object.entries(composerNodeIdsByIndex)) {
            if (nodeIds.includes(nodeId)) {
              const backendNodeId = composerBackendNodeIdByIndex[idx] ?? 401;
              return { node: { backendNodeId } };
            }
          }
        }
        return { node: { backendNodeId: 401 } };
      },
    },
  };
}

// ─── Group C — postComposerSynth eval + ref emission (gate G-POST.Synth) ──────

describe("T-Post.Synth.1 (G-POST.Synth): composer-open path emits @pc1 (editor) + @pc2 (Post button)", () => {
  it(
    "given fake CDP on /feed/ whose eval returns [{i:1,role:'textbox',label:'Text editor for creating content'},{i:2,role:'button',label:'Post'}] and querySelectorAll returns [201]/[202] and describeNode returns 401/402, when synthesizePostComposerEntries(client) runs, then entries=[{ref:'@pc1',role:'textbox',name:'Text editor for creating content'},{ref:'@pc2',role:'button',name:'Post'}] AND refs={pc1:{backendNodeId:401,...},pc2:{backendNodeId:402,...}}",
    async () => {
      // Given: a fake CdpClient on /feed/ whose POST_COMPOSER_SYNTH_JS eval returns
      //        [{i:1,role:'textbox',label:'Text editor for creating content'},{i:2,role:'button',label:'Post'}];
      //        querySelectorAll('[data-frondose-pc="1"]') → [201]; '[data-frondose-pc="2"]' → [202];
      //        describeNode returns backendNodeId:401 for nodeId 201, 402 for nodeId 202.
      // When:  synthesizePostComposerEntries(client) runs.
      // Then:  entries=[{ref:'@pc1',role:'textbox',name:'Text editor for creating content'},
      //                 {ref:'@pc2',role:'button',name:'Post'}];
      //        refs.pc1.backendNodeId===401; refs.pc2.backendNodeId===402.
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import for scaffold
      const mod = await import("../../src/linkedin/snapshotCapture/postComposerSynth.js").catch(() => null) as any;
      if (!mod) {
        assert.fail("T-Post.Synth.1: postComposerSynth.ts not yet created (Step 4)");
      }

      const composerJson = JSON.stringify([
        { i: 1, role: "textbox", label: "Text editor for creating content" },
        { i: 2, role: "button", label: "Post" },
      ]);
      const handle = makePostComposerHandle({
        pageUrl: "https://www.linkedin.com/feed/",
        axNodes: [{ nodeId: "ax1", role: "button", name: "Start a post", backendDOMNodeId: 10 }],
        composerJson,
        composerNodeIdsByIndex: { "1": [201], "2": [202] },
        composerBackendNodeIdByIndex: { "1": 401, "2": 402 },
      });
      const client = CdpClient.fromHandle(handle);

      const result = await mod.synthesizePostComposerEntries(client) as { entries: { ref: string; role: string; name: string }[]; refs: Record<string, { backendNodeId: number; role: string; name: string }> };

      assert.deepEqual(result.entries, [
        { ref: "@pc1", role: "textbox", name: "Text editor for creating content" },
        { ref: "@pc2", role: "button", name: "Post" },
      ]);
      assert.equal(result.refs.pc1?.backendNodeId, 401, "T-Post.Synth.1: pc1 backendNodeId must be 401");
      assert.equal(result.refs.pc2?.backendNodeId, 402, "T-Post.Synth.1: pc2 backendNodeId must be 402");
    },
  );
});

describe("T-Post.Synth.2 (G-POST.Synth): composer-closed → no eval / no entries / no refs", () => {
  it(
    "given fake CDP on /feed/ whose AX entries contain NO composer signals (no 'Post' button, no 'creating content' input), when captureCurrentSurfaceContext(client) runs, then ctx.entries has NO @pc* entries AND Runtime.evaluate count for 'data-frondose-pc' === 0 (hasComposerSignals short-circuited the synth)",
    async () => {
      // Given: a fake CdpClient on /feed/ with NO composer signals in AX entries
      //        (plain feed — "Start a post" button only; NO Post publish button, NO text editor).
      // When:  captureCurrentSurfaceContext(client) runs (which gates postComposerSynth
      //        on hasComposerSignals — must short-circuit to false).
      // Then:  ctx.entries contains NO @pc* refs;
      //        the count of Runtime.evaluate calls whose expression contains
      //        "data-frondose-pc" === 0 (synth eval never fired).
      const evalLog: string[] = [];
      const handle = makePostComposerHandle({
        pageUrl: "https://www.linkedin.com/feed/",
        axNodes: [
          { nodeId: "ax1", role: "button", name: "Start a post", backendDOMNodeId: 10 },
          { nodeId: "ax2", role: "button", name: "Like", backendDOMNodeId: 11 },
        ],
        // No composerJson needed — synth must NOT be called
        evalLog,
      });
      const client = CdpClient.fromHandle(handle);
      const ctx = await captureCurrentSurfaceContext(client);

      // CRITICAL safety assertion — synth eval must be 0
      const synthEvalCalls = evalLog.filter((expr) => expr.includes("data-frondose-pc") && expr.includes("setAttribute")).length;
      assert.equal(
        synthEvalCalls,
        0,
        `T-Post.Synth.2: POST_COMPOSER_SYNTH_JS eval must NEVER fire when composer is closed; got ${synthEvalCalls} calls`,
      );

      const pcEntries = ctx.entries.filter((e) => e.ref.startsWith("@pc"));
      assert.equal(pcEntries.length, 0, "T-Post.Synth.2: no @pc* entries when composer is closed");
    },
  );
});

describe("T-Post.Synth.3 (G-POST.Synth): synth eval throws → empty result, no entries, never throws", () => {
  it(
    "given fake CDP on /feed/ with composer signals present but POST_COMPOSER_SYNTH_JS eval throws, when captureCurrentSurfaceContext(client) runs, then ctx.entries has NO @pc* entries AND captureCurrentSurfaceContext did NOT throw",
    async () => {
      // Given: a fake CdpClient on /feed/ whose AX entries CONTAIN composer signals
      //        (a button named "Post" — strong signal); but the POST_COMPOSER_SYNTH_JS eval throws.
      // When:  captureCurrentSurfaceContext(client) runs (reaches the synth via hasComposerSignals,
      //        but the eval path fails).
      // Then:  no @pc* entries in ctx.entries;
      //        captureCurrentSurfaceContext did NOT throw (best-effort contract).
      const handle = makePostComposerHandle({
        pageUrl: "https://www.linkedin.com/feed/",
        axNodes: [
          // Strong composer signal: Post button present in AX tree
          { nodeId: "ax1", role: "button", name: "Post", backendDOMNodeId: 10 },
          { nodeId: "ax2", role: "textbox", name: "Text editor for creating content", backendDOMNodeId: 11 },
        ],
        composerThrows: true,
      });
      const client = CdpClient.fromHandle(handle);

      let threw = false;
      let ctx: Awaited<ReturnType<typeof captureCurrentSurfaceContext>> | undefined;
      try {
        ctx = await captureCurrentSurfaceContext(client);
      } catch {
        threw = true;
      }

      assert.equal(threw, false, "T-Post.Synth.3: captureCurrentSurfaceContext must never throw even when eval fails");
      if (!ctx) throw new Error("T-Post.Synth.3: ctx undefined — captureCurrentSurfaceContext threw");
      const pcEntries = ctx.entries.filter((e) => e.ref.startsWith("@pc"));
      assert.equal(pcEntries.length, 0, "T-Post.Synth.3: no @pc* entries when synth eval throws");
    },
  );
});

describe("T-Post.Synth.4 (G-POST.Synth): cleanup attrs removed after synth (best-effort, never throws)", () => {
  it(
    "given fake CDP on /feed/ whose eval succeeds, when synthesizePostComposerEntries returns, then a removeAttribute eval containing 'data-frondose-pc' was issued exactly once AND cleanup-throw variant still returns entries without throwing",
    async () => {
      // Given: a fake CdpClient on /feed/ whose POST_COMPOSER_SYNTH_JS eval succeeds
      //        returning one item; cleanup eval is tracked.
      // When:  synthesizePostComposerEntries(client) runs.
      // Then:  exactly one cleanup eval (removeAttribute + data-frondose-pc) was issued;
      //        the result contains the expected entries (cleanup does not corrupt them).
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import for scaffold
      const mod = await import("../../src/linkedin/snapshotCapture/postComposerSynth.js").catch(() => null) as any;
      if (!mod) {
        assert.fail("T-Post.Synth.4: postComposerSynth.ts not yet created (Step 4)");
      }

      const evalLog: string[] = [];
      const composerJson = JSON.stringify([
        { i: 1, role: "button", label: "Post" },
      ]);
      const handle = makePostComposerHandle({
        pageUrl: "https://www.linkedin.com/feed/",
        axNodes: [],
        composerJson,
        composerNodeIdsByIndex: { "1": [201] },
        composerBackendNodeIdByIndex: { "1": 401 },
        evalLog,
      });
      const client = CdpClient.fromHandle(handle);

      await mod.synthesizePostComposerEntries(client);

      const cleanupCalls = evalLog.filter(
        (expr) => expr.includes("data-frondose-pc") && expr.includes("removeAttribute"),
      ).length;
      assert.equal(cleanupCalls, 1, "T-Post.Synth.4: exactly one cleanup removeAttribute eval must be issued");

      // Variant: cleanup eval throws — must still return entries without throwing
      const evalLogCleanupThrow: string[] = [];
      const handleCleanupThrow = makePostComposerHandle({
        pageUrl: "https://www.linkedin.com/feed/",
        axNodes: [],
        composerJson,
        composerNodeIdsByIndex: { "1": [201] },
        composerBackendNodeIdByIndex: { "1": 401 },
        cleanupThrows: true,
        evalLog: evalLogCleanupThrow,
      });
      const clientCleanupThrow = CdpClient.fromHandle(handleCleanupThrow);
      let threwOnCleanup = false;
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import result
      let resultCleanupThrow: any;
      try {
        resultCleanupThrow = await mod.synthesizePostComposerEntries(clientCleanupThrow);
      } catch {
        threwOnCleanup = true;
      }
      assert.equal(threwOnCleanup, false, "T-Post.Synth.4: cleanup throw must be swallowed — synthesizePostComposerEntries must not throw");
      assert.equal(
        resultCleanupThrow?.entries?.length ?? -1,
        1,
        "T-Post.Synth.4: cleanup-throw variant still returns the 1 entry",
      );
    },
  );
});

describe("T-Post.Synth.5 (G-POST.Synth): malformed JSON eval result → empty, never throws", () => {
  it(
    "given fake CDP on /feed/ whose POST_COMPOSER_SYNTH_JS eval returns the literal string 'not json', when synthesizePostComposerEntries(client) runs, then it returns {entries:[],refs:{}} and no throw escapes",
    async () => {
      // Given: a fake CdpClient on /feed/ whose POST_COMPOSER_SYNTH_JS eval returns
      //        the string "not json" (malformed — cannot be parsed).
      // When:  synthesizePostComposerEntries(client) runs.
      // Then:  returns {entries:[], refs:{}}; no throw escapes.
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import for scaffold
      const mod = await import("../../src/linkedin/snapshotCapture/postComposerSynth.js").catch(() => null) as any;
      if (!mod) {
        assert.fail("T-Post.Synth.5: postComposerSynth.ts not yet created (Step 4)");
      }

      const handle = makePostComposerHandle({
        pageUrl: "https://www.linkedin.com/feed/",
        axNodes: [],
        composerJson: "not json",
      });
      const client = CdpClient.fromHandle(handle);

      let threw = false;
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import result
      let result: any;
      try {
        result = await mod.synthesizePostComposerEntries(client);
      } catch {
        threw = true;
      }

      assert.equal(threw, false, "T-Post.Synth.5: synthesizePostComposerEntries must not throw on malformed JSON");
      assert.deepEqual(result?.entries, [], "T-Post.Synth.5: entries must be [] on malformed JSON");
      assert.deepEqual(result?.refs, {}, "T-Post.Synth.5: refs must be {} on malformed JSON");
    },
  );
});
