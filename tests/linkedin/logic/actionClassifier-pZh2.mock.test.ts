/**
 * Phase P-ZH-2 Step 2 — T-Classify.1..7 + T-Name.1 (scaffold).
 *
 * Source-under-test (DOES NOT EXIST YET — Step 4 creates it):
 *   src/linkedin/logic/actionClassifier.ts
 *   exports: classifyActionName(name, opts?), personNameFromActionLabel(name),
 *            LinkedInActionKind, CONNECT_OPEN_RE/CONNECT_SEND_RE/CONNECT_ADD_NOTE_RE/
 *            FOLLOW_RE/MESSAGE_OPEN_RE/MESSAGE_SEND_RE/COMPOSER_INPUT_RE/POST_PUBLISH_RE/
 *            START_POST_RE/MORE_RE/ACTION_NAME_TOKENS  (plan §5.1).
 *
 * Import approach: the module is imported DYNAMICALLY in a top-level `before()` hook and
 * swallowed via `.catch(() => null)` so a missing-module resolution error does NOT crash the
 * whole test file (node --import tsx --test loads the file, runs every `it`, and each `it`
 * reds individually via a real failing assertion — never a hard file-load crash). This mirrors
 * the established local pattern in tests/tools/browser/outboundGuard.mock.test.ts
 * ("Dynamic import deferred so the scaffold compiles pre-builder").
 *
 * Every assertion below is a REAL (non-placeholder) expected value taken from plan §6 — not a
 * bare `assert.fail`. Pre-Step-4 every one of them fails via `classifyActionName is null` (the
 * module does not resolve), which is itself the correct RED. Step 4 creates the module; Step 5
 * (this validator) re-runs, fills any remaining edge cases, and replaces the two live-capture
 * placeholders below with the real captured strings.
 *
 * Live-capture TODOs (Step 5, real 中文 LinkedIn):
 *   - ZH_COMPOSER_PLACEHOLDER_TODO — the feed composer's ZH placeholder/name text
 *     (mirrors the `__ZH_COMPOSER_PLACEHOLDER__` token embedded in the plan §5.1
 *     COMPOSER_INPUT_RE sketch — replace BOTH the classifier regex source and this constant
 *     with the same live-captured string).
 *   - Post / Start-a-post ZH forms are NOT YET CAPTURED (ROADMAP P-ZH-AGENT Step 0/1) — T-Classify.6
 *     below only asserts the EN + already-captured More (更多/… 更多) forms + the Repost negative;
 *     the ZH Post/Start-a-post assertions are added at Step 5 once captured (see docs/phase-zh2-test.md).
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit tests/linkedin/logic/actionClassifier-pZh2.mock.test.ts
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-Step-4 scaffold (module does not exist yet)
let classifyActionName: ((name: string, opts?: unknown) => string) | any = null;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-Step-4 scaffold
let personNameFromActionLabel: ((name: string) => unknown) | any = null;

const ZH_COMPOSER_PLACEHOLDER_TODO = "__ZH_COMPOSER_PLACEHOLDER__"; // plan §5.1 COMPOSER_INPUT_RE sketch token — Step 5 replaces with the live-captured ZH string

before(async () => {
  const mod = await import("../../../src/linkedin/logic/actionClassifier.js").catch(() => null);
  if (mod) {
    classifyActionName = mod.classifyActionName;
    personNameFromActionLabel = mod.personNameFromActionLabel;
  }
});

function requireClassifier(testName: string): void {
  if (!classifyActionName) {
    assert.fail(
      `${testName}: classifyActionName not exported from src/linkedin/logic/actionClassifier.ts (module does not exist yet — Step 4 creates it)`,
    );
  }
}

function requireNameExtractor(testName: string): void {
  if (!personNameFromActionLabel) {
    assert.fail(
      `${testName}: personNameFromActionLabel not exported from src/linkedin/logic/actionClassifier.ts (module does not exist yet — Step 4 creates it)`,
    );
  }
}

describe("T-Classify — classifyActionName (src/linkedin/logic/actionClassifier.ts)", () => {
  // ─── T-Classify.1 ─────────────────────────────────────────────────────────
  it("T-Classify.1: connect_open — EN 'Connect'/'Invite X to connect', ZH '邀请X加为好友'/'连接' → 'connect_open'; 'Connected'/'Connections' → NOT connect_open", () => {
    // Given: EN + name-interpolated ZH connect-opener labels, and two EN false-positive candidates.
    // When:  classifyActionName(name) runs for each.
    // Then:  every positive returns "connect_open"; "Connected"/"Connections" do NOT.
    requireClassifier("T-Classify.1");
    const positives = ["Connect", "Invite Jane Doe to connect", "邀请Jaiden Silva加为好友", "连接"];
    for (const name of positives) {
      assert.equal(classifyActionName(name), "connect_open", `classifyActionName("${name}") must return "connect_open"`);
    }
    for (const name of ["Connected", "Connections"]) {
      assert.notEqual(classifyActionName(name), "connect_open", `classifyActionName("${name}") must NOT return "connect_open"`);
    }
  });

  // ─── T-Classify.2 ─────────────────────────────────────────────────────────
  it("T-Classify.2: connect_send — EN 'Send invitation'/'Send without a note', ZH '发送邀请'/'直接发送' → 'connect_send' (ordered BEFORE connect_open)", () => {
    // Given: connect-modal commit labels that are also plausible connect_open substrings.
    // When:  classifyActionName(name) runs for each.
    // Then:  every one returns "connect_send", never "connect_open" (ordering invariant, plan §5.1).
    requireClassifier("T-Classify.2");
    const positives = ["Send invitation", "Send without a note", "发送邀请", "直接发送"];
    for (const name of positives) {
      assert.equal(classifyActionName(name), "connect_send", `classifyActionName("${name}") must return "connect_send"`);
      assert.notEqual(classifyActionName(name), "connect_open", `classifyActionName("${name}") must NEVER return "connect_open"`);
    }
  });

  // ─── T-Classify.3 ─────────────────────────────────────────────────────────
  it("T-Classify.3: follow — 'Follow'/'Follow Chris Davis'/'关注Chris Davis'/'关注张三'/bare '关注' → 'follow'; 'Following' → NOT follow (regression pin for the /关注$/ end-anchor bug)", () => {
    // Given: EN + name-interpolated ZH follow labels + the bare-ZH-verb form + one EN false positive.
    // When:  classifyActionName(name) runs for each.
    // Then:  every positive returns "follow" (start-anchored, so a trailing name still matches);
    //        "Following" does not.
    requireClassifier("T-Classify.3");
    const positives = ["Follow", "Follow Chris Davis", "关注Chris Davis", "关注张三", "关注"];
    for (const name of positives) {
      assert.equal(classifyActionName(name), "follow", `classifyActionName("${name}") must return "follow"`);
    }
    assert.notEqual(classifyActionName("Following"), "follow", 'classifyActionName("Following") must NOT return "follow"');
  });

  // ─── T-Classify.4 ─────────────────────────────────────────────────────────
  it("T-Classify.4: message_open — 'Message Jane', '给张三发消息', '写消息' → 'message_open'", () => {
    // Given: EN + name-interpolated ZH message-opener labels + the bare ZH compose-nav label.
    // When:  classifyActionName(name) runs for each.
    // Then:  every one returns "message_open".
    requireClassifier("T-Classify.4");
    for (const name of ["Message Jane", "给张三发消息", "写消息"]) {
      assert.equal(classifyActionName(name), "message_open", `classifyActionName("${name}") must return "message_open"`);
    }
  });

  // ─── T-Classify.5 ─────────────────────────────────────────────────────────
  it("T-Classify.5: composer_input — EN 'What do you want to talk about?'/'Text editor for creating content' + the ZH placeholder token → 'composer_input'", () => {
    // Given: the two EN composer-editor accessible names + the not-yet-captured ZH placeholder.
    // When:  classifyActionName(name) runs for each.
    // Then:  every one returns "composer_input".
    //   Step 5 TODO: replace ZH_COMPOSER_PLACEHOLDER_TODO with the live-captured ZH string.
    requireClassifier("T-Classify.5");
    for (const name of ["What do you want to talk about?", "Text editor for creating content", ZH_COMPOSER_PLACEHOLDER_TODO]) {
      assert.equal(classifyActionName(name), "composer_input", `classifyActionName("${name}") must return "composer_input"`);
    }
  });

  // ─── T-Classify.6 ─────────────────────────────────────────────────────────
  it("T-Classify.6: post_publish/more anchors — 'Post' → post_publish; 'More'/'更多'/'… 更多' → more; 'Repost' → NOT post_publish (anchor guard)", () => {
    // Given: the EN publish label, EN+ZH overflow-menu labels, and the classic Repost false-positive.
    // When:  classifyActionName(name) runs for each.
    // Then:  "Post" → post_publish; the More forms → more; "Repost" → NOT post_publish.
    //   ZH Post / Start-a-post forms are NOT YET CAPTURED (ROADMAP P-ZH-AGENT Step 0/1) — added at
    //   Step 5 once live-captured; not asserted here.
    requireClassifier("T-Classify.6");
    assert.equal(classifyActionName("Post"), "post_publish", 'classifyActionName("Post") must return "post_publish"');
    for (const name of ["More", "更多", "… 更多"]) {
      assert.equal(classifyActionName(name), "more", `classifyActionName("${name}") must return "more"`);
    }
    assert.notEqual(classifyActionName("Repost"), "post_publish", 'classifyActionName("Repost") must NOT return "post_publish" (^post$ anchor)');
  });

  // ─── T-Classify.7 ─────────────────────────────────────────────────────────
  it("T-Classify.7: ambiguous 发送/Send ordering — bare '发送'/'Send' with no surrounding context → 'message_send' (last-ordered)", () => {
    // Given: the bare Send-family label in both languages, called with NO scope/context signal.
    // When:  classifyActionName(name) runs for each.
    // Then:  both return "message_send" — the last-ordered branch per plan §5.4 (a connect-context
    //        consumer reclassifies an in-dialog 发送 as connect_send at the CALLER level — see
    //        T-Guard.4 — classifyActionName itself has no scope input and always falls through here).
    requireClassifier("T-Classify.7");
    for (const name of ["发送", "Send"]) {
      assert.equal(classifyActionName(name), "message_send", `classifyActionName("${name}") must return "message_send" (last-ordered)`);
    }
  });
});

describe("T-Name — personNameFromActionLabel (src/linkedin/logic/actionClassifier.ts)", () => {
  // ─── T-Name.1 ─────────────────────────────────────────────────────────────
  it("T-Name.1: extracts the interpolated person name from EN + ZH action labels; returns null for a non-action label", () => {
    // Given: EN + ZH connect/follow/message action labels, and one plain nav label.
    // When:  personNameFromActionLabel(name) runs for each.
    // Then:  each action label yields {kind, personName}; the nav label yields null.
    requireNameExtractor("T-Name.1");
    assert.deepEqual(personNameFromActionLabel("邀请Jaiden Silva加为好友"), { kind: "connect_open", personName: "Jaiden Silva" });
    assert.deepEqual(personNameFromActionLabel("关注Chris Davis"), { kind: "follow", personName: "Chris Davis" });
    assert.deepEqual(personNameFromActionLabel("给张三发消息"), { kind: "message_open", personName: "张三" });
    assert.deepEqual(personNameFromActionLabel("Invite Jane Doe to connect"), { kind: "connect_open", personName: "Jane Doe" });
    assert.deepEqual(personNameFromActionLabel("Follow Chris Davis"), { kind: "follow", personName: "Chris Davis" });
    assert.deepEqual(personNameFromActionLabel("Message Jane"), { kind: "message_open", personName: "Jane" });
    assert.equal(personNameFromActionLabel("Home"), null, 'personNameFromActionLabel("Home") must return null (not an action label)');
    assert.equal(personNameFromActionLabel("主页"), null, 'personNameFromActionLabel("主页") must return null (not an action label)');
  });
});
