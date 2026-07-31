/**
 * P-SPLIT-APPTS-LOC — Step 4 behavioral test (compiled leaf).
 *
 * Covers the extracted src/tauri/ui/app/agentBubble.ts leaf: buildAgentBubble(doc, conversationListEl)
 * builds the agent-message bubble DOM skeleton (avatar SVG + gray thinking block + answer-text sink)
 * and returns the 3 refs app.ts's beginAgentBubble() wrapper wires into module state.
 *
 * Testing strategy: Bucket B (direct compiled-leaf-JS import — same pattern as
 * app-characterization-slice11.mock.test.ts's workflowSteps.js/turnSync.js imports). A recording
 * DocumentLike stub (same pattern as tests/tauri/render-shared-pY2.2a.mock.test.ts's makeRecDoc)
 * drives the real leaf function and asserts the exact DOM hierarchy/attributes/returned refs — this
 * exercises the ACTUAL extracted code, not a re-implementation, closing the gap the FM-1 Codex critic
 * flagged (a swapped return-object reference could otherwise compile and pass source-structural pins
 * alone). A before() guard fails with "leaf not built" if the compiled import fails.
 *
 * Gate: P-SPLIT-APPTS-LOC FM-3 (guard-test inventory item 4 — leaf-execution coverage)
 *
 * Run (mock — no browser/LLM):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/ui/agentBubble-pSplitAppTsLoc.mock.test.ts
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const AGENT_BUBBLE_JS = join(REPO, "src/tauri/ui/app/agentBubble.js");

const SVG_NS = "http://www.w3.org/2000/svg";

// ─── Recording DocumentLike stub (same pattern as render-shared-pY2.2a.mock.test.ts's makeRecDoc) ──

interface RecEl {
  tag: string;
  ns: string | null;
  attrs: Record<string, string>;
  classes: Set<string>;
  children: RecEl[];
  textContent: string | null;
}
function makeRecEl(tag: string, ns: string | null): RecEl {
  return { tag, ns, attrs: {}, classes: new Set(), children: [], textContent: null };
}
// biome-ignore lint/suspicious/noExplicitAny: the stub is shaped to satisfy agentBubble.ts's DocumentLike/ElementLike.
function wrap(el: RecEl): any {
  return {
    tagName: el.tag,
    get textContent() {
      return el.textContent;
    },
    set textContent(v: string | null) {
      el.textContent = v;
    },
    classList: {
      add: (c: string) => void el.classes.add(c),
      remove: (c: string) => void el.classes.delete(c),
      toggle: (c: string, f?: boolean) => void ((f ?? !el.classes.has(c)) ? el.classes.add(c) : el.classes.delete(c)),
      contains: (c: string) => el.classes.has(c),
    },
    setAttribute: (k: string, v: string) => {
      el.attrs[k] = v;
    },
    getAttribute: (k: string) => el.attrs[k] ?? null,
    appendChild: (c: { __rec: RecEl }) => {
      el.children.push(c.__rec);
      return c;
    },
    __rec: el,
  };
}
function makeRecDoc() {
  const created: RecEl[] = [];
  const doc = {
    createElement: (tag: string) => {
      const el = makeRecEl(tag, null);
      created.push(el);
      return wrap(el);
    },
    createElementNS: (ns: string, tag: string) => {
      const el = makeRecEl(tag, ns);
      created.push(el);
      return wrap(el);
    },
  };
  return { doc, created };
}
function makeConversationListEl() {
  const el = makeRecEl("div", null);
  const appended: RecEl[] = [];
  return {
    ...wrap(el),
    appendChild: (c: { __rec: RecEl }) => {
      appended.push(c.__rec);
      return c;
    },
    appended,
  };
}

// ─── before() guard — fail with "leaf not built" if import fails ────────────

type AgentBubbleRefsRec = {
  textEl: { __rec: RecEl };
  progressWrap: { __rec: RecEl };
  progressTextEl: { __rec: RecEl };
};
type AgentBubbleModule = {
  buildAgentBubble: (doc: unknown, conversationListEl: unknown) => AgentBubbleRefsRec;
};
let agentBubbleMod: AgentBubbleModule;

before(async () => {
  try {
    agentBubbleMod = (await import(pathToFileURL(AGENT_BUBBLE_JS).href)) as AgentBubbleModule;
  } catch (e) {
    assert.fail(
      `agentBubble.js not built at ${AGENT_BUBBLE_JS} — run npm run build:tauri-ui first. Error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
});

describe("app/agentBubble.ts — buildAgentBubble (P-SPLIT-APPTS-LOC)", () => {
  it("T-AgentBubble.1: builds exactly one avatar SVG via createElementNS with the pinned viewBox/fill/aria-hidden attrs and a single <path> with the sparkles 'd'", () => {
    // Given: a recording DocumentLike stub. When: buildAgentBubble(doc, conversationListEl) runs.
    // Then: one <svg> created via createElementNS (SVG namespace) with the exact attrs, one <path> child.
    const { doc, created } = makeRecDoc();
    const conversationListEl = makeConversationListEl();
    agentBubbleMod.buildAgentBubble(doc, conversationListEl);
    const svgs = created.filter((e) => e.tag === "svg");
    assert.equal(svgs.length, 1, "exactly one <svg> created");
    assert.equal(svgs[0]?.ns, SVG_NS, "svg created via createElementNS (SVG namespace)");
    assert.equal(svgs[0]?.attrs.viewBox, "0 0 24 24");
    assert.equal(svgs[0]?.attrs.fill, "currentColor");
    assert.equal(svgs[0]?.attrs["aria-hidden"], "true");
    const paths = created.filter((e) => e.tag === "path");
    assert.equal(paths.length, 1, "exactly one <path> created");
    assert.equal(paths[0]?.ns, SVG_NS, "path created via createElementNS (SVG namespace)");
    assert.equal(paths[0]?.attrs.d, "M12 2.5l1.7 6 6 1.7-6 1.7-1.7 6-1.7-6-6-1.7 6-1.7z");
  });

  it("T-AgentBubble.2: the temporary progress bubble starts hidden and unlabeled beside the final answer sink", () => {
    // Given the builder, when mounted, then progress and final answer use distinct sibling sinks.
    const { doc, created } = makeRecDoc();
    const conversationListEl = makeConversationListEl();
    agentBubbleMod.buildAgentBubble(doc, conversationListEl);
    const wraps = created.filter((e) => e.classes.has("msg-agent"));
    assert.equal(wraps.length, 1, "exactly one .msg-agent wrapper created");
    const wrapEl = wraps[0];
    assert.ok(wrapEl);
    assert.equal(wrapEl.children.length, 2, "wrap has exactly 2 children: avatar, body");
    const [avatarEl, bodyEl] = wrapEl.children;
    assert.ok(avatarEl?.classes.has("avatar"), "first child is .avatar");
    assert.ok(bodyEl?.classes.has("msg-agent-body"), "second child is .msg-agent-body");
    assert.equal(bodyEl?.children.length, 2, "body has exactly 2 children: progress, text");
    const [progressEl, textEl] = bodyEl?.children ?? [];
    assert.ok(progressEl?.classes.has("assistant-progress"), "first body child is .assistant-progress");
    assert.ok(progressEl?.classes.has("hidden"), "the progress wrapper starts hidden");
    assert.equal(progressEl?.attrs.role, "status");
    assert.equal(progressEl?.attrs["aria-live"], "polite");
    assert.ok(textEl?.classes.has("msg-agent-text"), "second body child is .msg-agent-text");
    assert.equal(progressEl?.children.length, 1, "progress wrapper has exactly one text sink");
    assert.ok(progressEl?.children[0]?.classes.has("assistant-progress-text"));
    assert.equal(progressEl?.textContent, null, "no fixed thinking label is rendered");
  });

  it("T-AgentBubble.3: mounts by appending the wrap exactly once to conversationListEl (no other appends)", () => {
    // Given: a recording conversationListEl. When: buildAgentBubble runs. Then: exactly one
    // appendChild call, and the appended node IS the .msg-agent wrap (not a child of it).
    const { doc } = makeRecDoc();
    const conversationListEl = makeConversationListEl();
    agentBubbleMod.buildAgentBubble(doc, conversationListEl);
    assert.equal(conversationListEl.appended.length, 1, "exactly one node appended to conversationListEl");
    assert.ok(conversationListEl.appended[0]?.classes.has("msg-agent"), "the appended node is the .msg-agent wrap");
  });

  it("T-AgentBubble.4: returns the actual answer/progress-wrap/progress-text nodes", () => {
    // Given: a recording DocumentLike stub. When: buildAgentBubble runs. Then: the returned refs'
    // identities match the exact nodes found by class in the constructed tree — guards against a
    // wrong-but-compiling return (e.g. thinkingWrap accidentally set to the thinking-LINE node).
    const { doc, created } = makeRecDoc();
    const conversationListEl = makeConversationListEl();
    const refs = agentBubbleMod.buildAgentBubble(doc, conversationListEl);
    const textEls = created.filter((e) => e.classes.has("msg-agent-text"));
    const progressWraps = created.filter((e) => e.classes.has("assistant-progress"));
    const progressTexts = created.filter((e) => e.classes.has("assistant-progress-text"));
    assert.equal(textEls.length, 1);
    assert.equal(progressWraps.length, 1);
    assert.equal(progressTexts.length, 1);
    assert.equal(refs.textEl.__rec, textEls[0], "refs.textEl must be the actual .msg-agent-text node");
    assert.equal(refs.progressWrap.__rec, progressWraps[0]);
    assert.equal(refs.progressTextEl.__rec, progressTexts[0]);
  });
});
