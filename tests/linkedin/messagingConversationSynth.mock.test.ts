/**
 * P-MSG-REPLY Step 2 — TDD scaffold.
 * T-MsgReply.1–10: messaging transcript + composer synth + wiring + addressability.
 *
 * P-MSG-REPLY Step 4/5 — assertions filled for the read/visibility-only scope.
 *
 * Groups:
 *   A (T-MsgReply.1-4)  — transcript extraction (synthesizeMessagingTranscriptEntries)
 *   B (T-MsgReply.5-7)  — composer synthesis fallback (synthesizeMessagingComposerEntries)
 *   C (T-MsgReply.8-9)  — wiring in captureCurrentSurfaceContext
 *   E (T-MsgReply.10)   — addressability end-to-end
 *
 * Import strategy: synthesizeMessagingTranscriptEntries, synthesizeMessagingComposerEntries,
 * formatMessagingMessage, and MAX_TRANSCRIPT live in the NOT-YET-EXISTING module
 *   src/linkedin/snapshotCapture/messagingConversationSynth.ts  (Step 4 creates it).
 * To keep this scaffold compileable now, Groups A/B/C unit tests that would call those
 * symbols directly are written as it.todo() stubs with full Given/When/Then intent
 * comments. The wiring tests (Group C) and addressability test (Group E) are written
 * against captureCurrentSurfaceContext (which already exists) so they compile and
 * reach the failing assertion-TODO branch.
 * This is explicitly noted in docs/phase-msg-reply-test.md § Test Contract.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import { buildInspectSummary } from "../../src/linkedin/inspectSummary.js";
import { captureCurrentSurfaceContext } from "../../src/linkedin/snapshotCapture.js";
import {
  formatMessagingMessage,
  MESSAGING_CONVERSATION_SYNTH_JS,
} from "../../src/linkedin/snapshotCapture/messagingConversationSynth.js";

// ─── Fake handle factory for messaging-thread surface ─────────────────────────
//
// Extends the existing pattern from snapshotCapture.mock.test.ts.
// The fake handle stubs:
//   - AX tree  (axNodes)
//   - Runtime.evaluate:
//       * "window.location.href"  → returns pageUrl
//       * expr containing "msg-s-event-listitem" → MESSAGING_CONVERSATION_SYNTH_JS → transcriptJson
//       * expr containing data-frondose-mc        → MESSAGING_COMPOSER_SYNTH_JS → composerJson
//       * data-frondose-ov setAttribute marker     → overlayJson (default "[]" — no overlay)
//       * cleanup removeAttribute exprs           → undefined (best-effort)
//   - DOM: getDocument, querySelectorAll, getAttributes, describeNode
//
// Step 4 will fill the real synth bodies; the fake here stubs the evaluate results
// that those synth functions will return.
//

function makeMessagingThreadHandle(opts: {
  pageUrl: string;
  axNodes: Array<{
    nodeId: string;
    role: string;
    name: string;
    backendDOMNodeId: number;
    ignored?: boolean;
  }>;
  /** JSON string the MESSAGING_CONVERSATION_SYNTH_JS eval returns. */
  transcriptJson?: string;
  /** JSON string the MESSAGING_COMPOSER_SYNTH_JS eval returns. */
  composerJson?: string;
  /** nodeIds returned from querySelectorAll for @mc marker; default []. */
  composerNodeIds?: number[];
  /** backendNodeId returned from DOM.describeNode; default 500. */
  composerBackendNodeId?: number;
  /** Whether the transcript eval throws instead of returning. */
  transcriptThrows?: boolean;
  /** Whether the composer eval throws instead of returning. */
  composerThrows?: boolean;
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
      evaluate: async (args: { expression: string }) => {
        if (args.expression === "window.location.href") {
          return { result: { value: opts.pageUrl } };
        }
        // MESSAGING_CONVERSATION_SYNTH_JS is identified by its .msg-s-event-listitem selector
        if (args.expression.includes("msg-s-event-listitem")) {
          if (opts.transcriptThrows) throw new Error("fake transcript eval throw");
          return { result: { value: opts.transcriptJson ?? "[]" } };
        }
        // MESSAGING_COMPOSER_SYNTH_JS is identified by its data-frondose-mc setAttribute marker
        if (args.expression.includes("data-frondose-mc") && args.expression.includes("setAttribute")) {
          if (opts.composerThrows) throw new Error("fake composer eval throw");
          return { result: { value: opts.composerJson ?? "[]" } };
        }
        // OVERLAY_SYNTH_JS is identified by its data-frondose-ov setAttribute marker
        if (args.expression.includes("data-frondose-ov") && args.expression.includes("setAttribute")) {
          return { result: { value: "[]" } };
        }
        // cleanup evals (removeAttribute) — best-effort, return undefined
        return { result: { value: undefined } };
      },
    },
    DOM: {
      getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (args: { nodeId: number; selector: string }) => {
        // Return composer node IDs when querying for @mc marker
        if (args.selector?.includes("data-frondose-mc")) {
          return { nodeIds: opts.composerNodeIds ?? [] };
        }
        return { nodeIds: [] };
      },
      getAttributes: async (_args: unknown) => ({ attributes: [] }),
      describeNode: async (_args: unknown) => ({
        node: { backendNodeId: opts.composerBackendNodeId ?? 500 },
      }),
    },
  };
}

// ─── Group A — transcript extraction ──────────────────────────────────────────

describe("T-MsgReply.1 (Group A): transcript extraction — inbound + outbound bubbles produce @mt* entries", () => {
  it(
    "given 2-bubble eval result [{isOther:true,sender:'Antony Hubert',body:'Hi Kyoube…'},{isOther:false,sender:null,body:'Glad to connect'}], when synthesizeMessagingTranscriptEntries runs, then 2 entries: @mt1 role:messagingTranscript name:'[Antony Hubert] Hi Kyoube…' and @mt2 name:'[You] Glad to connect'",
    async () => {
      // Given: a fake CdpClient on messaging-thread URL whose MESSAGING_CONVERSATION_SYNTH_JS eval
      //        returns two bubble objects — one inbound (isOther:true) and one outbound (isOther:false).
      // When:  captureCurrentSurfaceContext(client) runs (which calls synthesizeMessagingTranscriptEntries).
      // Then:  ctx.entries contains @mt1 with name "[Antony Hubert] Hi Kyoube, thanks for the connect! (2h)"
      //        and @mt2 with name "[You] Glad to connect"; both have role "messagingTranscript".
      const handle = makeMessagingThreadHandle({
        pageUrl: "https://www.linkedin.com/messaging/thread/test-urn/",
        axNodes: [{ nodeId: "ax1", role: "link", name: "Back to Messaging", backendDOMNodeId: 10 }],
        transcriptJson: JSON.stringify([
          { isOther: true, sender: "Antony Hubert", body: "Hi Kyoube, thanks for the connect!", timestamp: "2h" },
          { isOther: false, sender: null, body: "Glad to connect", timestamp: null },
        ]),
      });
      const client = CdpClient.fromHandle(handle);
      const ctx = await captureCurrentSurfaceContext(client);
      const transcriptEntries = ctx.entries.filter((e) => e.role === "messagingTranscript");

      assert.deepEqual(transcriptEntries, [
        {
          ref: "@mt1",
          role: "messagingTranscript",
          name: "[Antony Hubert] Hi Kyoube, thanks for the connect! (2h)",
        },
        { ref: "@mt2", role: "messagingTranscript", name: "[You] Glad to connect" },
      ]);
    },
  );
});

describe("T-MsgReply.2 (Group A): transcript extraction — eval throws/malformed returns empty, never throws", () => {
  it(
    "given MESSAGING_CONVERSATION_SYNTH_JS eval throws, when synthesizeMessagingTranscriptEntries runs, then [] returned and captureCurrentSurfaceContext does not throw",
    async () => {
      // Given: a fake CdpClient on messaging-thread URL whose transcript eval throws a runtime error.
      // When:  captureCurrentSurfaceContext(client) runs.
      // Then:  no @mt* entries in ctx.entries; captureCurrentSurfaceContext did NOT throw;
      //        parity with synthesizeFeedPostEntries best-effort pattern (snapshotCapture.ts:278-284).
      const handle = makeMessagingThreadHandle({
        pageUrl: "https://www.linkedin.com/messaging/thread/test-urn/",
        axNodes: [{ nodeId: "ax1", role: "link", name: "Home", backendDOMNodeId: 10 }],
        transcriptThrows: true,
      });
      const client = CdpClient.fromHandle(handle);
      let threw = false;
      let ctx: Awaited<ReturnType<typeof captureCurrentSurfaceContext>> | undefined;
      try {
        ctx = await captureCurrentSurfaceContext(client);
      } catch {
        threw = true;
      }
      // This assertion will pass (no-throw) even before Step 4 IF the current code
      // silently swallows the error. But since the new messaging-thread branch doesn't
      // exist yet, ctx.entries will have no @mt* entries either way.
      // The TODO assertion below forces a FAIL until Step 4 wires the synth.
      assert.equal(threw, false, "T-MsgReply.2: captureCurrentSurfaceContext must never throw even when transcript eval fails");
      if (!ctx) throw new Error("T-MsgReply.2: ctx undefined — captureCurrentSurfaceContext threw");
      assert.equal(ctx.surface, "messaging-thread", "T-MsgReply.2: thread URL must still infer messaging-thread");
      assert.equal(
        ctx.entries.some((e) => e.ref.startsWith("@mt") || e.role === "messagingTranscript"),
        false,
        "T-MsgReply.2: thrown transcript eval must produce no @mt* entries",
      );
    },
  );

  it(
    "given MESSAGING_CONVERSATION_SYNTH_JS eval returns malformed JSON, when captureCurrentSurfaceContext runs, then [] returned and captureCurrentSurfaceContext does not throw",
    async () => {
      // Given: a fake CdpClient on messaging-thread URL whose transcript eval returns malformed JSON.
      // When:  captureCurrentSurfaceContext(client) runs.
      // Then:  no @mt* entries appear and captureCurrentSurfaceContext does not throw.
      const handle = makeMessagingThreadHandle({
        pageUrl: "https://www.linkedin.com/messaging/thread/test-urn/",
        axNodes: [{ nodeId: "ax1", role: "link", name: "Home", backendDOMNodeId: 10 }],
        transcriptJson: "{not-json",
      });
      const client = CdpClient.fromHandle(handle);
      const ctx = await captureCurrentSurfaceContext(client);

      assert.equal(ctx.surface, "messaging-thread");
      assert.equal(
        ctx.entries.some((e) => e.ref.startsWith("@mt") || e.role === "messagingTranscript"),
        false,
        "T-MsgReply.2 malformed JSON: no transcript entries must be emitted",
      );
    },
  );
});

describe("T-MsgReply.3 (Group A): transcript extraction — null sender produces [Unknown] prefix", () => {
  it(
    "given inbound bubble with sender=null (image alt absent), when formatted, then name === '[Unknown] <body>'",
    async () => {
      // Given: MESSAGING_CONVERSATION_SYNTH_JS returns [{isOther:true, sender:null, body:"Hello there", timestamp:null}].
      // When:  captureCurrentSurfaceContext runs and the transcript synth processes the bubble.
      // Then:  the single @mt1 entry has name "[Unknown] Hello there";
      //        mirrors formatPersonalMessagingMessage line 71 `msg.sender ?? "Unknown"`.
      assert.equal(
        formatMessagingMessage({ isOther: true, sender: null, body: "Hello there", timestamp: null }),
        "[Unknown] Hello there",
      );
    },
  );
});

describe("T-MsgReply.4 (Group A): transcript extraction — empty-body bubbles are dropped", () => {
  it(
    "given a bubble with empty body='', when transcript extraction runs, then the empty bubble is NOT in the result entries",
    async () => {
      // Given: MESSAGING_CONVERSATION_SYNTH_JS returns [{isOther:true, sender:"Alice", body:"", timestamp:null}].
      // When:  captureCurrentSurfaceContext runs.
      // Then:  no @mt* entries in ctx.entries (empty body dropped);
      //        parity with mai-linkedin messagingConversation.ts:42 `if (body) { payload.push(...) }`.
      const handle = makeMessagingThreadHandle({
        pageUrl: "https://www.linkedin.com/messaging/thread/test-urn/",
        axNodes: [{ nodeId: "ax1", role: "link", name: "Back to Messaging", backendDOMNodeId: 10 }],
        transcriptJson: JSON.stringify([
          { isOther: true, sender: "Alice", body: "", timestamp: null },
          { isOther: false, sender: null, body: "Visible reply", timestamp: null },
        ]),
      });
      const client = CdpClient.fromHandle(handle);
      const ctx = await captureCurrentSurfaceContext(client);
      const transcriptEntries = ctx.entries.filter((e) => e.role === "messagingTranscript");

      assert.deepEqual(transcriptEntries, [
        { ref: "@mt1", role: "messagingTranscript", name: "[You] Visible reply" },
      ]);
    },
  );
});

describe("T-MsgReply.4b (Group A): transcript DOM template pins LinkedIn bubble selectors and direction mapping", () => {
  it("source structure uses .msg-s-event-listitem, --other, __body, img[alt], timestamp selector, and formats other/self as Sender/You", () => {
    // Given: the shipped MESSAGING_CONVERSATION_SYNTH_JS template and formatter.
    // When:  the source is inspected structurally.
    // Then:  the LinkedIn DOM selectors and inbound/outbound mapping remain pinned.
    assert.match(MESSAGING_CONVERSATION_SYNTH_JS, /querySelectorAll\('\.msg-s-event-listitem'\)/);
    assert.match(MESSAGING_CONVERSATION_SYNTH_JS, /classList\.contains\('msg-s-event-listitem--other'\)/);
    assert.match(MESSAGING_CONVERSATION_SYNTH_JS, /querySelector\('img\[alt\]'\)/);
    assert.match(MESSAGING_CONVERSATION_SYNTH_JS, /querySelector\('\.msg-s-event-listitem__body'\)/);
    assert.match(MESSAGING_CONVERSATION_SYNTH_JS, /querySelector\('time\.msg-s-message-group__timestamp'\)/);
    assert.equal(
      formatMessagingMessage({ isOther: true, sender: "Alice", body: "Inbound", timestamp: "1h" }),
      "[Alice] Inbound (1h)",
    );
    assert.equal(formatMessagingMessage({ isOther: false, sender: "Alice", body: "Outbound", timestamp: null }), "[You] Outbound");
  });
});

// ─── Group B — composer synthesis fallback ────────────────────────────────────

describe("T-MsgReply.5 (Group B): composer synthesis — AX-tree-present textbox captured in inputs[]", () => {
  it(
    "given raw AX tree includes textbox name 'Write a message…' on messaging-thread URL, when captureCurrentSurfaceContext runs, then inputs[] in the inspect summary contains an entry matching /write a message/i",
    async () => {
      // Given: a fake CdpClient on messaging-thread URL whose AX tree contains
      //        {role:'textbox', name:'Write a message…'} (composer is visible in AX).
      //        MESSAGING_COMPOSER_SYNTH_JS eval returns "[]" (no synth needed — AX present).
      // When:  captureCurrentSurfaceContext(client) runs, then buildInspectSummary(ctx, 'threadInput').
      // Then:  summary.inputs[] contains at least one entry whose label matches /write a message/i;
      //        the AX-present happy path is preserved after the synth wiring.
      const handle = makeMessagingThreadHandle({
        pageUrl: "https://www.linkedin.com/messaging/thread/test-urn/",
        axNodes: [
          { nodeId: "ax1", role: "textbox", name: "Write a message…", backendDOMNodeId: 30 },
          { nodeId: "ax2", role: "button", name: "Send", backendDOMNodeId: 31 },
        ],
        transcriptJson: "[]",
        composerJson: "[]",
      });
      const client = CdpClient.fromHandle(handle);
      const ctx = await captureCurrentSurfaceContext(client);
      const summary = buildInspectSummary(ctx, "threadInput");

      assert.ok(
        summary.inputs.some((input) => /write a message/i.test(input.label)),
        `T-MsgReply.5: inputs must include Write a message composer; inputs=${JSON.stringify(summary.inputs)}`,
      );
      assert.ok(
        summary.buttons.some((button) => button.label === "Send"),
        `T-MsgReply.5: scoped threadInput must keep raw Send visible; buttons=${JSON.stringify(summary.buttons)}`,
      );
    },
  );
});

describe("T-MsgReply.6 (Group B): composer synthesis fallback — AX omits composer, synth fills @mc* entry", () => {
  it(
    "given AX omits composer textbox but MESSAGING_COMPOSER_SYNTH_JS returns {i:1,role:'textbox',label:'Write a message…'}, when captureCurrentSurfaceContext runs, then inputs[] has @mc1 entry + client refMap contains mc1",
    async () => {
      // Given: a fake CdpClient on messaging-thread URL where:
      //   - AX tree has NO textbox entry (composer AX drop — per reference-linkedin-ax-tree-lag.md).
      //   - MESSAGING_COMPOSER_SYNTH_JS eval returns JSON([{i:1, role:'textbox', label:'Write a message…'}]).
      //   - DOM.querySelectorAll('[data-frondose-mc="1"]') returns nodeId [201].
      //   - DOM.describeNode returns backendNodeId 500.
      // When:  captureCurrentSurfaceContext(client) runs, then buildInspectSummary(ctx, 'threadInput').
      // Then:  summary.inputs[0].ref starts with '@mc' AND label matches /write a message/i;
      //        (client.currentRefMap as Record<string,{backendNodeId:number}>)['mc1'].backendNodeId === 500
      //        (proves mergeRefs was called — typeAt("@mc1") would resolve).
      const handle = makeMessagingThreadHandle({
        pageUrl: "https://www.linkedin.com/messaging/thread/test-urn/",
        axNodes: [
          // No composer textbox — simulates AX tree drop
          { nodeId: "ax1", role: "link", name: "Back to Messaging", backendDOMNodeId: 10 },
          { nodeId: "ax2", role: "button", name: "More options", backendDOMNodeId: 11 },
        ],
        transcriptJson: "[]",
        composerJson: JSON.stringify([{ i: 1, role: "textbox", label: "Write a message…" }]),
        composerNodeIds: [201],
        composerBackendNodeId: 500,
      });
      const client = CdpClient.fromHandle(handle);
      const ctx = await captureCurrentSurfaceContext(client);
      const summary = buildInspectSummary(ctx, "threadInput");
      const refMap = client.currentRefMap;

      assert.deepEqual(summary.inputs, [{ ref: "@mc1", label: "Write a message…" }]);
      assert.equal(refMap.mc1?.backendNodeId, 500, "T-MsgReply.6: mc1 must be merged into the client RefMap");
      assert.equal(refMap.mc1?.role, "textbox");
      assert.equal(refMap.mc1?.name, "Write a message…");
    },
  );
});

describe("T-MsgReply.7 (Group B): composer synthesis double-failure — synth eval throws → empty, never throws", () => {
  it(
    "given neither AX nor MESSAGING_COMPOSER_SYNTH_JS returns a composer (synth throws), when captureCurrentSurfaceContext runs, then inputs[] is empty for composer and captureCurrentSurfaceContext does not throw",
    async () => {
      // Given: a fake CdpClient on messaging-thread URL where:
      //   - AX tree has NO composer textbox.
      //   - MESSAGING_COMPOSER_SYNTH_JS eval throws.
      // When:  captureCurrentSurfaceContext(client) runs, then buildInspectSummary(ctx, 'threadInput').
      // Then:  no @mc* entries; summary.inputs is empty; captureCurrentSurfaceContext did NOT throw;
      //        synthesizeMessagingComposerEntries returned {entries:[], refs:{}} — best-effort contract.
      const handle = makeMessagingThreadHandle({
        pageUrl: "https://www.linkedin.com/messaging/thread/test-urn/",
        axNodes: [
          { nodeId: "ax1", role: "link", name: "Back to Messaging", backendDOMNodeId: 10 },
        ],
        composerThrows: true,
        transcriptJson: "[]",
      });
      const client = CdpClient.fromHandle(handle);
      let threw = false;
      let ctx: Awaited<ReturnType<typeof captureCurrentSurfaceContext>> | undefined;
      try {
        ctx = await captureCurrentSurfaceContext(client);
      } catch {
        threw = true;
      }
      assert.equal(threw, false, "T-MsgReply.7: captureCurrentSurfaceContext must not throw even when composer synth throws");
      if (!ctx) throw new Error("T-MsgReply.7: ctx undefined");
      const summary = buildInspectSummary(ctx, "threadInput");
      assert.equal(
        ctx.entries.some((entry) => entry.ref.startsWith("@mc")),
        false,
        "T-MsgReply.7: composer synth throw must produce no @mc entries",
      );
      assert.deepEqual(summary.inputs, [], "T-MsgReply.7: threadInput has no composer input when AX and synth both fail");
    },
  );
});

// ─── Group C — wiring (captureCurrentSurfaceContext orchestrator) ──────────────

describe("T-MsgReply.8 (Group C): wiring — messaging-thread URL dispatches to transcript synth; entries lead the list", () => {
  it(
    "given pageUrl https://www.linkedin.com/messaging/thread/<urn>/, when captureCurrentSurfaceContext runs, then ctx.surface='messaging-thread' AND entries contain messagingTranscript role AND transcript entries lead (index 0)",
    async () => {
      // Given: a fake CdpClient on a messaging-thread URL with one AX nav entry
      //        and a transcript eval returning two bubbles.
      // When:  captureCurrentSurfaceContext(client) runs.
      // Then:  ctx.surface === "messaging-thread";
      //        at least one entry has role "messagingTranscript";
      //        the first entry in ctx.entries has role "messagingTranscript"
      //        (unshift semantics: transcript leads ahead of nav clutter).
      const handle = makeMessagingThreadHandle({
        pageUrl: "https://www.linkedin.com/messaging/thread/test-urn/",
        axNodes: [
          { nodeId: "ax1", role: "link", name: "Back to Messaging", backendDOMNodeId: 10 },
        ],
        transcriptJson: JSON.stringify([
          { isOther: true, sender: "Antony Hubert", body: "Hi Kyoube!", timestamp: "2h" },
          { isOther: false, sender: null, body: "Glad to connect", timestamp: null },
        ]),
      });
      const client = CdpClient.fromHandle(handle);
      const ctx = await captureCurrentSurfaceContext(client);
      assert.equal(ctx.surface, "messaging-thread", "T-MsgReply.8: surface must be 'messaging-thread'");
      assert.equal(ctx.entries[0]?.role, "messagingTranscript", "T-MsgReply.8: transcript entries must lead ctx.entries");
      assert.deepEqual(ctx.entries.slice(0, 2), [
        { ref: "@mt1", role: "messagingTranscript", name: "[Antony Hubert] Hi Kyoube! (2h)" },
        { ref: "@mt2", role: "messagingTranscript", name: "[You] Glad to connect" },
      ]);
    },
  );
});

describe("T-MsgReply.9 (Group C): wiring — messaging inbox URL keeps opener behavior, no messagingTranscript", () => {
  it(
    "given pageUrl https://www.linkedin.com/messaging/ (inbox), when captureCurrentSurfaceContext runs, then ctx.surface='messaging' AND no messagingTranscript entries AND @mr* opener entries present",
    async () => {
      // Given: a fake CdpClient on the inbox URL (NOT a thread URL).
      //        AX tree has one nav button; querySelectorAll for opener class returns 2 nodeIds.
      // When:  captureCurrentSurfaceContext(client) runs.
      // Then:  ctx.surface === "messaging" (not "messaging-thread");
      //        no entry with role "messagingTranscript";
      //        @mr1 and @mr2 opener entries present (synthesizeMessagingConversationOpeners still runs).
      const evalExpressions: string[] = [];
      const handle = {
        Accessibility: {
          enable: async () => {},
          getFullAXTree: async () => ({
            nodes: [
              {
                nodeId: "ax1",
                role: { type: "role", value: "button" },
                name: { type: "string", value: "New message" },
                backendDOMNodeId: 20,
                ignored: false,
              },
            ],
          }),
        },
        Runtime: {
          evaluate: async (args: { expression: string }) => {
            evalExpressions.push(args.expression);
            if (args.expression === "window.location.href") {
              return { result: { value: "https://www.linkedin.com/messaging/" } };
            }
            if (args.expression.includes("data-frondose-ov") && args.expression.includes("setAttribute")) {
              return { result: { value: "[]" } };
            }
            return { result: { value: undefined } };
          },
        },
        DOM: {
          getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
          querySelectorAll: async (_args: unknown) => ({ nodeIds: [101, 102] }),
          getAttributes: async (args: { nodeId: number }) => {
            const attrMap: Record<number, string[]> = {
              101: ["aria-label", "Alice Smith", "class", "msg-conversation-listitem"],
              102: ["aria-label", "Bob Jones", "class", "msg-conversation-listitem"],
            };
            return { attributes: attrMap[args.nodeId] ?? [] };
          },
          describeNode: async (_args: unknown) => ({ node: { backendNodeId: 999 } }),
        },
      };
      const client = CdpClient.fromHandle(handle);
      const ctx = await captureCurrentSurfaceContext(client);
      assert.equal(ctx.surface, "messaging", "T-MsgReply.9: surface must be 'messaging' for inbox URL");
      const transcriptEntries = ctx.entries.filter((e) => e.role === "messagingTranscript");
      assert.equal(transcriptEntries.length, 0, "T-MsgReply.9: no messagingTranscript entries on inbox surface");
      const openerEntries = ctx.entries.filter((e) => e.ref.startsWith("@mr"));
      // Opener entries are the pre-existing behavior (T-M39 pin)
      // This assertion passes pre-Step-4 since opener synth already works for messaging surface
      assert.ok(openerEntries.length >= 1, "T-MsgReply.9: @mr* opener entries must be present on inbox surface (regression guard)");
      assert.equal(
        evalExpressions.some((expr) => expr.includes("msg-s-event-listitem")),
        false,
        "T-MsgReply.9: inbox surface must not run the active-thread transcript synth",
      );
    },
  );
});

// ─── Group E — addressability end-to-end ──────────────────────────────────────

describe("T-MsgReply.10 (Group E): addressability — @mc1 in inputs[] + mc1 in client refMap after threadInput scope", () => {
  it(
    "given messaging-thread ctx with composer @mc1 (synth fallback) + Send @e1 (raw AX), when buildInspectSummary(ctx, 'threadInput') runs, then inputs[0].ref==='@mc1' AND buttons[0].ref==='@e1' AND mc1 registered in client refMap",
    async () => {
      // Given: a fake CdpClient on messaging-thread URL where:
      //   - AX tree has {role:'button', name:'Send', backendDOMNodeId:207} (first AX ref is @e1).
      //   - AX tree has NO composer textbox (AX drop).
      //   - MESSAGING_COMPOSER_SYNTH_JS eval returns [{i:1, role:'textbox', label:'Write a message…'}].
      //   - querySelectorAll('[data-frondose-mc="1"]') returns [201]; describeNode returns backendNodeId:500.
      // When:  captureCurrentSurfaceContext(client) runs (wires @mc1 into entries + refMap),
      //        then buildInspectSummary(ctx, "threadInput").
      // Then:  summary.inputs[0].ref === "@mc1" (synth fallback ref);
      //        summary.buttons[0].ref === "@e1" (raw AX Send button);
      //        (client.currentRefMap as Record<string,{backendNodeId:number}>)["mc1"].backendNodeId === 500
      //        (typeAt("@mc1") would resolve — the 2026-06-21 live gap closes).
      const handle = makeMessagingThreadHandle({
        pageUrl: "https://www.linkedin.com/messaging/thread/test-urn/",
        axNodes: [
          // AX has the Send button but NOT the composer textbox
          { nodeId: "ax1", role: "button", name: "Send", backendDOMNodeId: 207 },
          { nodeId: "ax2", role: "link", name: "Back to Messaging", backendDOMNodeId: 10 },
        ],
        transcriptJson: "[]",
        composerJson: JSON.stringify([{ i: 1, role: "textbox", label: "Write a message…" }]),
        composerNodeIds: [201],
        composerBackendNodeId: 500,
      });
      const client = CdpClient.fromHandle(handle);
      const ctx = await captureCurrentSurfaceContext(client);
      const summary = buildInspectSummary(ctx, "threadInput");
      const refMap = client.currentRefMap;

      assert.deepEqual(summary.inputs, [{ ref: "@mc1", label: "Write a message…" }]);
      assert.deepEqual(summary.buttons, [{ ref: "@e1", label: "Send" }]);
      assert.equal(refMap.mc1?.backendNodeId, 500, "T-MsgReply.10: mc1 must be registered in client.currentRefMap");
      assert.equal(refMap.e1?.backendNodeId, 207, "T-MsgReply.10: raw AX Send remains sequential @e1 despite backend id 207");
    },
  );
});
