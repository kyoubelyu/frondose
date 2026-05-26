/**
 * P-63 scaffold — T-Pattern.1..5
 * outboundGuard.ts: OUTBOUND_LABEL_RE + FOLLOW_LABEL_RE + LINKEDIN_OUTBOUND_SURFACES
 * pattern-match unit tests.
 *
 * Step 4a: assertion bodies are TODO stubs — ALL FAIL pre-builder.
 * Step 5:  builder creates src/tools/browser/outboundGuard.ts → assertion bodies filled.
 *
 * NOTE: src/tools/browser/outboundGuard.ts does NOT exist at Step 4a.
 * Dynamic imports inside `before()` defer resolution to test-run time; the file
 * scaffolds compile cleanly (tsc/tsx), and each test fails with a clear TODO message.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/browser/outboundGuard.mock.test.ts
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// Dynamic import deferred so the scaffold compiles pre-builder.
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder scaffold
let OUTBOUND_LABEL_RE: RegExp | any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder scaffold
let FOLLOW_LABEL_RE: RegExp | any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder scaffold
let LINKEDIN_OUTBOUND_SURFACES: ReadonlySet<string> | any;

describe("T-Pattern — outboundGuard.ts regex + surface constants", () => {
  before(async () => {
    // TODO (builder Step 4b): create src/tools/browser/outboundGuard.ts
    const mod = await import("../../../src/tools/browser/outboundGuard.js").catch(() => null);
    if (mod) {
      OUTBOUND_LABEL_RE = mod.OUTBOUND_LABEL_RE;
      FOLLOW_LABEL_RE = mod.FOLLOW_LABEL_RE;
      LINKEDIN_OUTBOUND_SURFACES = mod.LINKEDIN_OUTBOUND_SURFACES;
    }
  });

  // ─── T-Pattern.1 ─────────────────────────────────────────────────────────────
  it("T-Pattern.1: when English outbound labels are tested, OUTBOUND_LABEL_RE matches every one → true", () => {
    // Given: documented English outbound labels:
    //   "Connect", "Invite 杨哲 to connect", "Send without a note", "Send invite", "Send now"
    // When:  OUTBOUND_LABEL_RE.test(label) for each label
    // Then:  every test returns true
    assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
  });

  // ─── T-Pattern.2 ─────────────────────────────────────────────────────────────
  it("T-Pattern.2: when Chinese outbound labels are tested, OUTBOUND_LABEL_RE matches every one → true", () => {
    // Given: Chinese Simplified outbound labels:
    //   "邀请杨哲加入领英", "添加好友", "发送邀请", "直接发送", "连接", "立即连接"
    // When:  OUTBOUND_LABEL_RE.test(label) for each label
    // Then:  every test returns true
    assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
  });

  // ─── T-Pattern.3 ─────────────────────────────────────────────────────────────
  it("T-Pattern.3: when benign labels are tested, OUTBOUND_LABEL_RE does NOT match → false for every one", () => {
    // Given: benign labels: "Connected", "Connecting…", "Read more", "Show more",
    //   "Like", "Comment", "Message", "Save", "Unfollow", "已连接", "评论"
    // When:  OUTBOUND_LABEL_RE.test(label)
    // Then:  every test returns false (verifies \b anchoring; 连接$ prevents 已连接 match)
    assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
  });

  // ─── T-Pattern.4 ─────────────────────────────────────────────────────────────
  it("T-Pattern.4: FOLLOW_LABEL_RE matches 'Follow' and '关注' exactly but NOT 'Following' / '关注者'", () => {
    // Given: matchers ["Follow", "Follow back", "关注"] and non-matchers
    //   ["Following", "Followed", "关注者", "正在关注"]
    // When:  FOLLOW_LABEL_RE.test(label)
    // Then:  matchers → true; non-matchers → false
    //   (verifies (?!ing) negative lookahead + 关注$ anchor)
    assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
  });

  // ─── T-Pattern.5 ─────────────────────────────────────────────────────────────
  it("T-Pattern.5: LINKEDIN_OUTBOUND_SURFACES contains every LinkedIn surface and excludes 'unknown'", () => {
    // Given: the LINKEDIN_OUTBOUND_SURFACES constant
    // When:  has() is called for each expected member and for "unknown"
    // Then:  feed, profile, network, search, company, messaging, messaging-thread,
    //        notifications → all present; "unknown" → absent
    //   (covers false-positive non-LinkedIn risk gate G-P63.6)
    assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
  });
});
