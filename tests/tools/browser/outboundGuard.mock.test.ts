/**
 * P-63 Step 5 — T-Pattern.1..5 (filled)
 * outboundGuard.ts: OUTBOUND_LABEL_RE + FOLLOW_LABEL_RE + LINKEDIN_OUTBOUND_SURFACES
 * pattern-match unit tests.
 *
 * Assertions filled per plan §5.1 + §6.1 (locked code sketches).
 * Expected failures at Step 5 due to builder deviations (D-P63-A):
 *   - OUTBOUND_LABEL_RE: missing ^ anchor, \b bounds, Send* patterns, 立即连接; adds Message (false positive)
 *   - FOLLOW_LABEL_RE: missing ^ anchor, negative lookahead (?!ing), $ anchor
 *   - LINKEDIN_OUTBOUND_SURFACES: not exported by builder
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
    const mod = await import("../../../src/tools/browser/outboundGuard.js").catch(() => null);
    if (mod) {
      OUTBOUND_LABEL_RE = mod.OUTBOUND_LABEL_RE;
      FOLLOW_LABEL_RE = mod.FOLLOW_LABEL_RE;
      LINKEDIN_OUTBOUND_SURFACES = mod.LINKEDIN_OUTBOUND_SURFACES;
    }
  });

  // ─── T-Pattern.1 ─────────────────────────────────────────────────────────────
  it("T-Pattern.1: when English outbound labels are tested, OUTBOUND_LABEL_RE matches every one → true", () => {
    // Given: documented English outbound labels from plan §5.1:
    //   "Connect", "Invite 杨哲 to connect", "Send without a note", "Send invite", "Send now"
    // When:  OUTBOUND_LABEL_RE.test(label) for each label
    // Then:  every test returns true
    //   Covers G-P63.1 (all outbound labels matched)
    assert.ok(
      OUTBOUND_LABEL_RE instanceof RegExp,
      "OUTBOUND_LABEL_RE must be a RegExp (check export from outboundGuard.ts)",
    );

    const englishOutboundLabels = [
      "Connect",
      "Invite 杨哲 to connect",
      "Send without a note",
      "Send invite",
      "Send now",
    ];
    const failures: string[] = [];
    for (const label of englishOutboundLabels) {
      if (!OUTBOUND_LABEL_RE.test(label)) {
        failures.push(`"${label}" should match but does NOT (plan §5.1 OUTBOUND_LABEL_RE)`);
      }
    }
    assert.deepStrictEqual(failures, [], `OUTBOUND_LABEL_RE missed labels:\n${failures.join("\n")}`);
  });

  // ─── T-Pattern.2 ─────────────────────────────────────────────────────────────
  it("T-Pattern.2: when Chinese outbound labels are tested, OUTBOUND_LABEL_RE matches every one → true", () => {
    // Given: Chinese Simplified outbound labels from plan §3.OQ-3:
    //   "邀请杨哲加入领英", "添加好友", "发送邀请", "直接发送", "连接", "立即连接"
    // When:  OUTBOUND_LABEL_RE.test(label) for each label
    // Then:  every test returns true
    //   Covers G-P63.1 (OQ-3 multi-language)
    assert.ok(
      OUTBOUND_LABEL_RE instanceof RegExp,
      "OUTBOUND_LABEL_RE must be a RegExp",
    );

    const chineseOutboundLabels = [
      "邀请杨哲加入领英",
      "添加好友",
      "发送邀请",
      "直接发送",
      "连接",
      "立即连接",
    ];
    const failures: string[] = [];
    for (const label of chineseOutboundLabels) {
      if (!OUTBOUND_LABEL_RE.test(label)) {
        failures.push(`"${label}" should match but does NOT (plan §5.1 Chinese patterns)`);
      }
    }
    assert.deepStrictEqual(failures, [], `OUTBOUND_LABEL_RE missed Chinese labels:\n${failures.join("\n")}`);
  });

  // ─── T-Pattern.3 ─────────────────────────────────────────────────────────────
  it("T-Pattern.3: when benign labels are tested, OUTBOUND_LABEL_RE does NOT match → false for every one", () => {
    // Given: benign labels that must NOT match OUTBOUND_LABEL_RE:
    //   "Connected", "Connecting…" — Connect\b would match; Connected/Connecting must NOT
    //   "Read more", "Show more", "Like", "Comment" — completely benign
    //   "Message" — plan says NOT outbound; only outbound via Send-variants
    //   "Save", "Unfollow" — contain no outbound pattern
    //   "已连接" — 连接$ anchor prevents suffix match
    //   "评论" — benign Chinese
    // When:  OUTBOUND_LABEL_RE.test(label) for each label
    // Then:  every test returns false
    //   Covers G-P63.2 (false-positive guard; verifies \b anchoring + 连接$ anchor)
    assert.ok(
      OUTBOUND_LABEL_RE instanceof RegExp,
      "OUTBOUND_LABEL_RE must be a RegExp",
    );

    const benignLabels = [
      "Connected",    // Connect + \b suffix → Connected must NOT match
      "Connecting…",  // Connecting must NOT match
      "Read more",
      "Show more",
      "Like",
      "Comment",
      "Message",      // plan §2: NOT outbound; sends always require a guarded Send-variant click
      "Save",
      "Unfollow",
      "已连接",        // 连接$ means this must NOT match (已 prefix breaks $ anchor)
      "评论",
    ];
    const falsePositives: string[] = [];
    for (const label of benignLabels) {
      if (OUTBOUND_LABEL_RE.test(label)) {
        falsePositives.push(`"${label}" should NOT match but DOES (false positive)`);
      }
    }
    assert.deepStrictEqual(
      falsePositives,
      [],
      `OUTBOUND_LABEL_RE produced false positives:\n${falsePositives.join("\n")}`,
    );
  });

  // ─── T-Pattern.4 ─────────────────────────────────────────────────────────────
  it("T-Pattern.4: FOLLOW_LABEL_RE matches 'Follow' and '关注' exactly but NOT 'Following' / '关注者'", () => {
    // Given: matchers ["Follow", "Follow back", "关注"] and non-matchers
    //   ["Following", "Followed", "关注者", "正在关注"]
    // When:  FOLLOW_LABEL_RE.test(label)
    // Then:  matchers → true; non-matchers → false
    //   Covers G-P63.3 (FOLLOW_LABEL_RE precision; verifies (?!ing) negative lookahead + 关注$ anchor)
    assert.ok(
      FOLLOW_LABEL_RE instanceof RegExp,
      "FOLLOW_LABEL_RE must be a RegExp",
    );

    const matchers = ["Follow", "Follow back", "关注"];
    const nonMatchers = ["Following", "Followed", "关注者", "正在关注"];

    const matcherFailures: string[] = [];
    for (const label of matchers) {
      if (!FOLLOW_LABEL_RE.test(label)) {
        matcherFailures.push(`"${label}" should match FOLLOW_LABEL_RE but does NOT`);
      }
    }
    assert.deepStrictEqual(matcherFailures, [], `FOLLOW_LABEL_RE missed:\n${matcherFailures.join("\n")}`);

    const nonMatcherFalsePositives: string[] = [];
    for (const label of nonMatchers) {
      if (FOLLOW_LABEL_RE.test(label)) {
        nonMatcherFalsePositives.push(`"${label}" should NOT match FOLLOW_LABEL_RE but DOES (false positive; missing (?!ing) or $ anchor)`);
      }
    }
    assert.deepStrictEqual(
      nonMatcherFalsePositives,
      [],
      `FOLLOW_LABEL_RE false positives:\n${nonMatcherFalsePositives.join("\n")}`,
    );
  });

  // ─── T-Pattern.5 ─────────────────────────────────────────────────────────────
  it("T-Pattern.5: LINKEDIN_OUTBOUND_SURFACES contains every LinkedIn surface and excludes 'unknown'", () => {
    // Given: the LINKEDIN_OUTBOUND_SURFACES constant from plan §5.1
    // When:  has() is called for each expected member and for "unknown"
    // Then:  feed, profile, network, search, company, messaging, messaging-thread,
    //        notifications → all present; "unknown" → absent
    //   Covers G-P63.6 (guard ONLY fires on LinkedIn surfaces; P-33 general-web unaffected)
    assert.ok(
      LINKEDIN_OUTBOUND_SURFACES instanceof Set,
      "LINKEDIN_OUTBOUND_SURFACES must be a Set (check it is exported from outboundGuard.ts)",
    );

    const expectedSurfaces = [
      "feed",
      "profile",
      "network",
      "search",
      "company",
      "messaging",
      "messaging-thread",
      "notifications",
    ];
    const missingSurfaces: string[] = [];
    for (const surface of expectedSurfaces) {
      if (!LINKEDIN_OUTBOUND_SURFACES.has(surface)) {
        missingSurfaces.push(`"${surface}" missing from LINKEDIN_OUTBOUND_SURFACES`);
      }
    }
    assert.deepStrictEqual(missingSurfaces, [], `Missing surfaces:\n${missingSurfaces.join("\n")}`);

    assert.ok(
      !LINKEDIN_OUTBOUND_SURFACES.has("unknown"),
      `"unknown" must NOT be in LINKEDIN_OUTBOUND_SURFACES (P-33 general-web carve-out)`,
    );
  });
});
