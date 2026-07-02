/**
 * Phase P-ZH-2 Step 2 — T-Classify.1..7 + T-Name.1 (scaffold).
 * Phase P-ZH-2 Step 3a — T-Classify.3 extended with a '关注者' negative (Critic CONCERN fix,
 * plan §5.1a/§12.4: the `关注(?!者)` negative-lookahead must exclude the follower-count label).
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
 * Live-capture DONE (Step 5, real 中文 LinkedIn account, :9222, 2026-07-02):
 *   - ZH_COMPOSER_PLACEHOLDER_TODO — replaced with the live-captured feed-composer editor
 *     accessible name '内容创建文本编辑器' (role=textbox; captured via getFullAXTree on the real
 *     feed composer — NOT the visible CSS placeholder '您想讨论什么话题？', which is not part of
 *     the AX name since the element carries an explicit aria-label). Still RED pre-Step-5a: the
 *     classifier + all three composerReadiness.ts builders still hold the literal placeholder
 *     token, not this real string — see docs/phase-zh2-test.md § Results.
 *   - Post / Start-a-post ZH forms — CAPTURED. Post button = '发布' (role=button; already matched
 *     by the shipped POST_PUBLISH_RE — GREEN). Start-a-post feed-composer TRIGGER = '发动态'
 *     (role=link) — this is DIFFERENT from the plan §5.1 guess '发起帖子' and is NOT matched by
 *     the shipped START_POST_RE (`/^(?:start a post$|发起帖子$|写文章$)/i`) — genuinely RED, see
 *     T-Classify.6 below.
 *   - Connect-modal (via 更多→邀请X加为好友, Add-a-note dialog) real captured strings differ from
 *     the plan's §5.1 guess (添加备注/直接发送): the actual dialog uses '添加消息' (add-note
 *     trigger) and '发送时不添加备注' (send-WITHOUT-note commit) — see T-Classify.8 (new,
 *     SAFETY-CRITICAL — '发送时不添加备注' is UNCLASSIFIED by any current pattern, so it is not
 *     even caught by the F1 floor) and docs/phase-zh2-test.md § Results.
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

const ZH_COMPOSER_PLACEHOLDER_TODO = "内容创建文本编辑器"; // Step 5 LIVE-CAPTURED (real feed-composer editor AX name, :9222) — replaces the plan §5.1 sketch token

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
  it("T-Classify.3: follow — 'Follow'/'Follow Chris Davis'/'关注Chris Davis'/'关注张三'/bare '关注' → 'follow'; 'Following' → NOT follow (regression pin for the /关注$/ end-anchor bug); '关注者' → NOT follow (Critic CONCERN negative-lookahead, §5.1a)", () => {
    // Given: EN + name-interpolated ZH follow labels + the bare-ZH-verb form + two false positives
    //   (the EN "Following" state label and the ZH follower-count nav label "关注者").
    // When:  classifyActionName(name) runs for each.
    // Then:  every positive returns "follow" (start-anchored, so a trailing name still matches);
    //        "Following" does not; "关注者" does not (the `关注(?!者)` negative lookahead excludes
    //        the follower-count label while still matching every name-interpolated form).
    requireClassifier("T-Classify.3");
    const positives = ["Follow", "Follow Chris Davis", "关注Chris Davis", "关注张三", "关注"];
    for (const name of positives) {
      assert.equal(classifyActionName(name), "follow", `classifyActionName("${name}") must return "follow"`);
    }
    assert.notEqual(classifyActionName("Following"), "follow", 'classifyActionName("Following") must NOT return "follow"');
    assert.notEqual(
      classifyActionName("关注者"),
      "follow",
      'classifyActionName("关注者") must NOT return "follow" (follower-count nav label, excluded by the 关注(?!者) negative lookahead)',
    );
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
  it("T-Classify.6: post_publish/more anchors — 'Post'/'发布' → post_publish; 'More'/'更多'/'… 更多' → more; 'Repost' → NOT post_publish (anchor guard)", () => {
    // Given: the EN + LIVE-CAPTURED ZH publish label, EN+ZH overflow-menu labels, and the classic
    //   Repost false-positive.
    // When:  classifyActionName(name) runs for each.
    // Then:  "Post"/"发布" → post_publish; the More forms → more; "Repost" → NOT post_publish.
    //   '发布' is the real Post-button accessible name captured on :9222 (Step 5) — already matched
    //   by the shipped POST_PUBLISH_RE (`发布$`), so this assertion is GREEN, locking in the real
    //   value in place of the plan's placeholder guess.
    requireClassifier("T-Classify.6");
    for (const name of ["Post", "发布"]) {
      assert.equal(classifyActionName(name), "post_publish", `classifyActionName("${name}") must return "post_publish"`);
    }
    for (const name of ["More", "更多", "… 更多"]) {
      assert.equal(classifyActionName(name), "more", `classifyActionName("${name}") must return "more"`);
    }
    assert.notEqual(classifyActionName("Repost"), "post_publish", 'classifyActionName("Repost") must NOT return "post_publish" (^post$ anchor)');
  });

  // ─── T-Classify.8 (Step 5 live-capture, NEW — resolves a real gap the plan did not anticipate) ─
  it("T-Classify.8: LIVE-CAPTURED start-post trigger '发动态' → start_post; LIVE-CAPTURED connect-modal '添加消息' → connect_add_note, '发送时不添加备注' → connect_send (SAFETY-CRITICAL — currently UNCLASSIFIED)", () => {
    // Given: three real strings captured on the agent's :9222 Chinese LinkedIn session this
    //   session (2026-07-02), each DIFFERENT from what the plan §5.1 guessed:
    //     - feed composer 'Start a post' trigger (role=link): '发动态' (plan guessed '发起帖子').
    //     - connect-modal add-a-note trigger (role=button, inside the 'Add a note?' dialog,
    //       reached via 更多→邀请X加为好友 on a Follow-primary profile): '添加消息'
    //       (plan guessed '添加备注').
    //     - connect-modal send-WITHOUT-note commit (role=button, same dialog): '发送时不添加备注'
    //       (plan guessed '直接发送'/bare '发送' — the REAL string is neither).
    // When:  classifyActionName(name) runs for each.
    // Then:  '发动态' → "start_post" (RED today — START_POST_RE has no '发动态' alternative, only
    //   the wrong guesses '发起帖子'/'写文章', the latter of which is actually LinkedIn's "Write an
    //   article" feature, a DIFFERENT control — flagged for Step-5a, do not conflate the two);
    //   '添加消息' → "connect_add_note" (RED today); '发送时不添加备注' → "connect_send"
    //   (SAFETY-CRITICAL, RED today — this string matches NO current pattern at all, so
    //   classifyActionName returns "none"/benign for it, meaning the REAL live connect-send-
    //   without-note commit on this UI variant is invisible to the classifier entirely — worse
    //   than the bare-发送 case the critic's BLOCKER was about, because it isn't even caught by
    //   MESSAGE_SEND_RE's fallback. Step-5a must add '发送时不添加备注$' to CONNECT_SEND_RE and
    //   '添加消息$' to CONNECT_ADD_NOTE_RE).
    requireClassifier("T-Classify.8");
    assert.equal(classifyActionName("发动态"), "start_post", 'classifyActionName("发动态") must return "start_post" (real captured Start-a-post trigger)');
    assert.equal(
      classifyActionName("添加消息"),
      "connect_add_note",
      'classifyActionName("添加消息") must return "connect_add_note" (real captured connect-modal add-note trigger)',
    );
    assert.equal(
      classifyActionName("发送时不添加备注"),
      "connect_send",
      'classifyActionName("发送时不添加备注") must return "connect_send" (SAFETY-CRITICAL — real captured connect-modal send-without-note commit, currently unclassified/benign)',
    );
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
