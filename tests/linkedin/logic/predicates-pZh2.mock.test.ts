/**
 * Phase P-ZH-2 Step 2 — T-Detect.1..4 (scaffold).
 *
 * Source-under-test (ALL EXIST TODAY, English-only — Step 4 ZH-extends each):
 *   src/linkedin/logic/predicates/composer.ts  — COMPOSER_EDITOR_JS() (labelPattern-driven)
 *   src/linkedin/composerReadiness.ts          — FEED_COMPOSER_EDITOR_JS (hardcoded literal)
 *   src/linkedin/logic/predicates/connectPrompt.ts — CONNECT_PROMPT_PRESENT_JS()
 *   src/linkedin/logic/predicates/feedProfile.ts   — hasProfileConnectPromptOverlay
 *   src/linkedin/logic/predicates/messaging.ts     — isThreadComposerInputEntry
 *   src/linkedin/snapshotCapture/messagingConversationSynth.ts — MESSAGING_COMPOSER_SYNTH_JS
 *
 * These predicates run inside evaluated page-context JS strings (plan §5.2/§5.6, R3): the RE
 * source is interpolated into the string via `.toString()`, so a mock test cannot execute the
 * JS in a real DOM — instead it asserts the GENERATED STRING contains the expected ZH token
 * (exactly the check the plan mandates at R3: "unit-assert the generated string contains the
 * ZH token"). `hasProfileConnectPromptOverlay` / `isThreadComposerInputEntry` are plain
 * TS predicates and are exercised directly against ZH SnapshotEntry fixtures.
 *
 * Ground-truthed this session: every assertion below is REAL (not a placeholder) and reds
 * against the CURRENT English-only source (confirmed via a live `node --import tsx -e` probe —
 * see docs/phase-zh2-test.md § Test Contract).
 *
 * Live-capture TODO (Step 5): ZH_COMPOSER_PLACEHOLDER_TODO mirrors the same placeholder used in
 * tests/linkedin/logic/actionClassifier-pZh2.mock.test.ts — replace with the live-captured
 * composer editor accessible name once captured on :9222.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit tests/linkedin/logic/predicates-pZh2.mock.test.ts
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  FEED_COMPOSER_CLEAR_JS,
  FEED_COMPOSER_EDITOR_JS,
  FEED_COMPOSER_FOCUS_JS,
} from "../../../src/linkedin/composerReadiness.js";
import { COMPOSER_EDITOR_JS } from "../../../src/linkedin/logic/predicates/composer.js";
import { CONNECT_PROMPT_PRESENT_JS } from "../../../src/linkedin/logic/predicates/connectPrompt.js";
import { hasProfileConnectPromptOverlay } from "../../../src/linkedin/logic/predicates/feedProfile.js";
import { isThreadComposerInputEntry } from "../../../src/linkedin/logic/predicates/messaging.js";
import { MESSAGING_COMPOSER_SYNTH_JS } from "../../../src/linkedin/snapshotCapture/messagingConversationSynth.js";
import type { SnapshotEntry } from "../../../src/linkedin/types.js";

const ZH_COMPOSER_PLACEHOLDER_TODO = "__ZH_COMPOSER_PLACEHOLDER__"; // Step 5: replace with the live-captured ZH composer placeholder

// ─── T-Detect.5 dynamic-import guard (actionClassifier.ts does not exist yet — Step 4 creates it) ───
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-Step-4 scaffold (module does not exist yet)
let buildAriaLabelSelector: ((tokens: readonly string[]) => string) | any = null;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-Step-4 scaffold
let buildTokenAlternationSource: ((tokens: readonly string[]) => string) | any = null;

before(async () => {
  const mod = await import("../../../src/linkedin/logic/actionClassifier.js").catch(() => null);
  if (mod) {
    buildAriaLabelSelector = mod.buildAriaLabelSelector;
    buildTokenAlternationSource = mod.buildTokenAlternationSource;
  }
});

function requireSafeBuilders(testName: string): void {
  if (!buildAriaLabelSelector || !buildTokenAlternationSource) {
    assert.fail(
      `${testName}: buildAriaLabelSelector/buildTokenAlternationSource not exported from src/linkedin/logic/actionClassifier.ts (module does not exist yet — Step 4 creates it)`,
    );
  }
}

function entry(role: string, name: string, ref = "@e1"): SnapshotEntry {
  return { ref, role, name };
}

describe("T-Detect.1 — composer input JS pattern is ZH-aware (ALL THREE composerReadiness.ts builders — Critic CONCERN-MR fix, plan §5.2a/§12.3)", () => {
  it("T-Detect.1: the generated composer-editor/focus/clear JS strings' INPUT_RE all contain the ZH placeholder token", () => {
    // Given: the composer-editor JS builder (labelPattern-driven, predicates/composer.ts) AND all
    //   THREE composerReadiness.ts hardcoded-literal builders — EDITOR (locate), FOCUS
    //   (focusFeedComposerEditorLive, type.ts:336-346), CLEAR (clearFeedComposerEditorLive,
    //   type.ts:384-420) — per plan §5.2a: if only EDITOR gains the ZH token, the ZH feed
    //   composer is located but never focused/cleared, silently half-localizing the type path.
    // When:  each is generated with its default/current pattern.
    // Then:  the generated source must contain the ZH placeholder token in ALL of them — it does
    //   NOT today (all are English-only), which is the genuine pre-Step-4 RED. FOCUS/CLEAR are the
    //   Step-3a addition (EDITOR alone was insufficient per the critic).
    const composerPredicateJs = COMPOSER_EDITOR_JS();
    assert.ok(
      composerPredicateJs.includes(ZH_COMPOSER_PLACEHOLDER_TODO),
      "predicates/composer.ts COMPOSER_EDITOR_JS() must embed the ZH composer placeholder token",
    );
    assert.ok(
      FEED_COMPOSER_EDITOR_JS.includes(ZH_COMPOSER_PLACEHOLDER_TODO),
      "composerReadiness.ts FEED_COMPOSER_EDITOR_JS must embed the ZH composer placeholder token",
    );
    assert.ok(
      FEED_COMPOSER_FOCUS_JS.includes(ZH_COMPOSER_PLACEHOLDER_TODO),
      "composerReadiness.ts FEED_COMPOSER_FOCUS_JS must embed the ZH composer placeholder token (Step-3a addition — was unasserted, letting Step 4 leave focus English-only)",
    );
    assert.ok(
      FEED_COMPOSER_CLEAR_JS.includes(ZH_COMPOSER_PLACEHOLDER_TODO),
      "composerReadiness.ts FEED_COMPOSER_CLEAR_JS must embed the ZH composer placeholder token (Step-3a addition — was unasserted, letting Step 4 leave clear English-only)",
    );
  });
});

describe("T-Detect.2 — connect-prompt CONTROL_RE is ZH-aware", () => {
  it("T-Detect.2: the generated CONNECT_PROMPT_PRESENT_JS() string's CONTROL_RE contains the ZH add-note/send-commit tokens", () => {
    // Given: the connect-prompt present-predicate JS builder.
    // When:  CONNECT_PROMPT_PRESENT_JS() is generated.
    // Then:  the generated source must contain '添加备注' and one of the ZH send-commit tokens —
    //   it does NOT today (CONTROL_RE is the English-only literal `/^(add a note|send without a
    //   note|send invitation)$/i`), which is the genuine pre-Step-4 RED.
    const js = CONNECT_PROMPT_PRESENT_JS();
    assert.ok(js.includes("添加备注"), "CONNECT_PROMPT_PRESENT_JS() must embed the ZH 'Add a note' token (添加备注)");
    assert.ok(
      js.includes("直接发送") || js.includes("发送邀请"),
      "CONNECT_PROMPT_PRESENT_JS() must embed a ZH send-commit token (直接发送 or 发送邀请)",
    );
  });
});

describe("T-Detect.3 — feedProfile connect-prompt overlay detection is ZH-aware", () => {
  it("T-Detect.3: hasProfileConnectPromptOverlay returns true given ZH connect-modal button entries ('添加备注', '直接发送')", () => {
    // Given: a profile-surface entry set with the ZH add-note + send-without-note buttons.
    // When:  hasProfileConnectPromptOverlay(pageUrl, surface, entries) runs.
    // Then:  returns true — it returns false today (English-only literals), the genuine pre-Step-4 RED.
    const zhEntries = [entry("button", "添加备注", "@e1"), entry("button", "直接发送", "@e2")];
    assert.equal(
      hasProfileConnectPromptOverlay("https://www.linkedin.com/in/jane-doe/", "profile", zhEntries),
      true,
      "hasProfileConnectPromptOverlay must detect the ZH connect-modal button pair",
    );
  });
});

describe("T-Detect.4 — thread composer input detection is ZH-aware", () => {
  it("T-Detect.4: isThreadComposerInputEntry matches '写消息'/'消息'; MESSAGING_COMPOSER_SYNTH_JS's INPUT_RE embeds the ZH tokens", () => {
    // Given: a ZH thread-composer textbox entry, and the messaging composer-synth JS builder.
    // When:  isThreadComposerInputEntry(entry) runs, and MESSAGING_COMPOSER_SYNTH_JS is inspected.
    // Then:  the ZH textbox entries match; the generated JS source embeds a ZH input token.
    //   Both are false/absent today (English-only patterns), the genuine pre-Step-4 RED.
    assert.equal(
      isThreadComposerInputEntry(entry("textbox", "写消息", "@e1")),
      true,
      'isThreadComposerInputEntry("写消息") must be true',
    );
    assert.equal(
      isThreadComposerInputEntry(entry("textbox", "消息", "@e2")),
      true,
      'isThreadComposerInputEntry("消息") must be true',
    );
    assert.ok(
      MESSAGING_COMPOSER_SYNTH_JS.includes("写消息") || MESSAGING_COMPOSER_SYNTH_JS.includes("消息"),
      "MESSAGING_COMPOSER_SYNTH_JS's INPUT_RE must embed a ZH messaging-input token (写消息 or 消息)",
    );
  });
});

// ─── T-Detect.5 — Class C safe-builder escaping (Step 3a addition, resolves Critic CONCERN-MR, plan §5.6/§12.2) ───
describe("T-Detect.5 — Class C safe-builder escaping (actionClassifier.ts buildAriaLabelSelector / buildTokenAlternationSource)", () => {
  it("T-Detect.5: buildAriaLabelSelector/buildTokenAlternationSource safely serialize/escape a token containing a quote, backslash, and regex metacharacters — no raw injection into the CSS selector or the RegExp source", () => {
    // Given: a synthetic token with a double-quote, backslash, and regex metacharacters
    //   (the plan's own §5.6/T-Detect.5 example: 'a"b\c.*d'), plus a "missing metachars" variant
    //   of the SAME token with the literal '.' and '*' characters removed.
    // When:  buildAriaLabelSelector([token]) builds the CSS attribute-selector value, and
    //   buildTokenAlternationSource([token]) builds a RegExp alternation source embedded as
    //   `new RegExp("^(?:" + source + ")", "i")` (plan §5.6 exact form).
    // Then:  the selector is generated via JSON.stringify (safe serialization, matches the plan's
    //   own worked example format), the RegExp construction never throws, the resulting RegExp
    //   matches the token LITERALLY, and — critically — it does NOT match the "missing metachars"
    //   variant (which an UNESCAPED '.'/'*' would wrongly match, since unescaped '.' is "any char"
    //   and '*' is "zero-or-more" — proving the metachars were actually escaped, not left live).
    //   Module does not exist yet (Step 4 creates it) — RED via requireSafeBuilders pre-Step-4.
    requireSafeBuilders("T-Detect.5");

    const dangerousToken = 'a"b\\c.*d'; // runtime string: a " b \ c . * d
    const missingMetacharsVariant = 'a"b\\cd'; // same string minus the literal '.' and '*' chars

    const selector = buildAriaLabelSelector([dangerousToken]);
    assert.equal(
      selector,
      `[aria-label*=${JSON.stringify(dangerousToken)} i]`,
      "buildAriaLabelSelector must serialize the token via JSON.stringify (quote + backslash escaped as a valid CSS attribute-selector quoted string), never raw concatenation",
    );

    const alternationSource = buildTokenAlternationSource([dangerousToken]);
    let re: RegExp | undefined;
    assert.doesNotThrow(() => {
      re = new RegExp(`^(?:${alternationSource})`, "i");
    }, 'new RegExp("^(?:" + buildTokenAlternationSource([token]) + ")", "i") must not throw a SyntaxError');
    assert.ok(
      re?.test(dangerousToken),
      "the escaped alternation source must still match the original dangerous token literally",
    );
    assert.ok(
      !re?.test(missingMetacharsVariant),
      "the escaped alternation source must NOT match the token with '.'/'*' removed — an unescaped '.'(any-char)/'*'(zero-or-more) would wrongly match this, proving escaping did not happen",
    );

    // Normal ZH tokens (no metachars) still round-trip into a valid selector + regex.
    const normalSelector = buildAriaLabelSelector(["更多", "邀请"]);
    assert.equal(
      normalSelector,
      `[aria-label*=${JSON.stringify("更多")} i],[aria-label*=${JSON.stringify("邀请")} i]`,
      "buildAriaLabelSelector must join multiple ZH tokens as a comma-separated attribute-selector alternation",
    );
    const normalSource = buildTokenAlternationSource(["更多", "邀请"]);
    assert.doesNotThrow(
      () => new RegExp(`^(?:${normalSource})`, "i"),
      "normal ZH tokens must produce a valid RegExp source with no escaping side-effects",
    );
  });
});
