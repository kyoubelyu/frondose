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
      "Send invitation", // [P-75 D-11 round 4] LinkedIn's actual Stage-2 modal label — Hootan 2026-05-25 + Dmitry 2026-06-08
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
    assert.ok(OUTBOUND_LABEL_RE instanceof RegExp, "OUTBOUND_LABEL_RE must be a RegExp");

    const chineseOutboundLabels = ["邀请杨哲加入领英", "添加好友", "发送邀请", "直接发送", "连接", "立即连接"];
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
    assert.ok(OUTBOUND_LABEL_RE instanceof RegExp, "OUTBOUND_LABEL_RE must be a RegExp");

    const benignLabels = [
      "Connected", // Connect + \b suffix → Connected must NOT match
      "Connecting…", // Connecting must NOT match
      "Read more",
      "Show more",
      "Like",
      "Comment",
      "Message", // plan §2: NOT outbound; sends always require a guarded Send-variant click
      "Save",
      "Unfollow",
      "已连接", // 连接$ means this must NOT match (已 prefix breaks $ anchor)
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
    assert.ok(FOLLOW_LABEL_RE instanceof RegExp, "FOLLOW_LABEL_RE must be a RegExp");

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
        nonMatcherFalsePositives.push(
          `"${label}" should NOT match FOLLOW_LABEL_RE but DOES (false positive; missing (?!ing) or $ anchor)`,
        );
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

// ─────────────────────────────────────────────────────────────────────────────
// T-RequiresApproval — requiresApproval() now returns true for Send on messaging surfaces
// (P-MSG-SEND Change A)
// ─────────────────────────────────────────────────────────────────────────────

describe("T-RequiresApproval — requiresApproval() P-MSG-SEND: Send on messaging surfaces requires approval", () => {
  // Dynamic import deferred so the scaffold compiles pre-builder (same as T-Pattern above).
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder scaffold
  let requiresApproval: ((...args: any[]) => any) | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder scaffold
  let classifyOutboundLabel: ((...args: any[]) => any) | null = null;

  before(async () => {
    const mod = await import("../../../src/tools/browser/outboundGuard.js").catch(() => null);
    if (mod) {
      // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
      requiresApproval = (mod as any).requiresApproval ?? null;
      // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
      classifyOutboundLabel = (mod as any).classifyOutboundLabel ?? null;
    }
  });

  // ─── T-RequiresApproval.1 ─────────────────────────────────────────────────
  it("T-RequiresApproval.1: requiresApproval('Send', 'messaging-thread') returns true (P-MSG-SEND: message_send on messaging surfaces now gated)", () => {
    // Given: requiresApproval exported from outboundGuard.ts
    // When:  requiresApproval("Send", "messaging-thread") called
    // Then:  returns true (P-MSG-SEND Change A adds MESSAGE_SEND_RE + MESSAGING_SURFACES check)
    if (!requiresApproval) {
      assert.fail("T-RequiresApproval.1: requiresApproval not exported from outboundGuard.ts");
    }
    assert.equal(
      requiresApproval("Send", "messaging-thread"),
      true,
      'T-RequiresApproval.1: requiresApproval("Send", "messaging-thread") must return true after P-MSG-SEND Change A',
    );
  });

  // ─── T-RequiresApproval.2 ─────────────────────────────────────────────────
  it("T-RequiresApproval.2: requiresApproval('Send', 'messaging') returns true (both messaging surfaces gated)", () => {
    // Given: requiresApproval exported from outboundGuard.ts
    // When:  requiresApproval("Send", "messaging") called (conversation-list surface)
    // Then:  returns true
    if (!requiresApproval) {
      assert.fail("T-RequiresApproval.2: requiresApproval not exported from outboundGuard.ts");
    }
    assert.equal(
      requiresApproval("Send", "messaging"),
      true,
      'T-RequiresApproval.2: requiresApproval("Send", "messaging") must return true after P-MSG-SEND Change A',
    );
  });

  // ─── T-RequiresApproval.3 ─────────────────────────────────────────────────
  it("T-RequiresApproval.3: requiresApproval('Send', 'profile') returns true (P-ZH-2 F1 — bare send-family on ANY LinkedIn outbound surface is gated, safety-positive)", () => {
    // Given: requiresApproval exported; surface=profile (a LinkedIn outbound surface)
    // When:  requiresApproval("Send", "profile") called
    // Then:  returns true — P-ZH-2 F1 broadened the message_send gate from
    //        MESSAGING_SURFACES to LINKEDIN_OUTBOUND_SURFACES (outboundGuard.ts:36-42),
    //        because a bare Send/发送-family label on a profile can be a connect-modal
    //        commit, which must never bypass approval. Superseded pre-P-ZH-2 expectation
    //        (false) is intentionally flipped safety-positive.
    if (!requiresApproval) {
      assert.fail("T-RequiresApproval.3: requiresApproval not exported from outboundGuard.ts");
    }
    assert.equal(
      requiresApproval("Send", "profile"),
      true,
      'T-RequiresApproval.3: requiresApproval("Send", "profile") must return true (P-ZH-2 F1 — any outbound surface)',
    );
  });

  // ─── T-RequiresApproval.4 ─────────────────────────────────────────────────
  it("T-RequiresApproval.4: requiresApproval('Send invitation', 'messaging-thread') returns true (already gated as outbound label — no regression)", () => {
    // Given: requiresApproval exported; label=Send invitation on messaging-thread
    // When:  requiresApproval("Send invitation", "messaging-thread") called
    // Then:  returns true — OUTBOUND_LABEL_RE still fires first (isOutboundLabel path)
    //        Regression guard: pre-existing outbound labels are still gated on all surfaces.
    if (!requiresApproval) {
      assert.fail("T-RequiresApproval.4: requiresApproval not exported from outboundGuard.ts");
    }
    assert.equal(
      requiresApproval("Send invitation", "messaging-thread"),
      true,
      'T-RequiresApproval.4: requiresApproval("Send invitation", "messaging-thread") must return true (outbound label always gated)',
    );
  });

  // ─── T-RequiresApproval.5 ─────────────────────────────────────────────────
  it("T-RequiresApproval.5: localized Chinese Send-family labels on messaging-thread classify as message_send and require approval (pre-existing, unchanged)", () => {
    // Given: Chinese localized Send labels that can appear on messaging surfaces
    // When:  classifyOutboundLabel(label) and requiresApproval(label, "messaging-thread") are called
    // Then:  each label is classified as message_send and gated by operator approval
    if (!requiresApproval) {
      assert.fail("T-RequiresApproval.5: requiresApproval not exported from outboundGuard.ts");
    }
    if (!classifyOutboundLabel) {
      assert.fail("T-RequiresApproval.5: classifyOutboundLabel not exported from outboundGuard.ts");
    }

    const labels = ["发送", "发送消息", "發送訊息"];
    for (const label of labels) {
      assert.equal(
        classifyOutboundLabel(label),
        "message_send",
        `T-RequiresApproval.5: ${label} must classify as message_send`,
      );
      assert.equal(
        requiresApproval(label, "messaging-thread"),
        true,
        `T-RequiresApproval.5: ${label} on messaging-thread must require approval`,
      );
    }
  });
});

// =============================================================================
// P-POST Step 2 — T-Post.Class.1–4 + T-Post.Approval.1–4
// Gates: G-POST.Class + G-POST.Approval
// =============================================================================

describe("T-Post.Class — outboundGuard: post OutboundClass classification (G-POST.Class)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import for scaffold
  let classifyOutboundLabelPost: ((...args: any[]) => any) | null = null;

  before(async () => {
    const mod = await import("../../../src/tools/browser/outboundGuard.js").catch(() => null);
    if (mod) {
      // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
      classifyOutboundLabelPost = (mod as any).classifyOutboundLabel ?? null;
    }
  });

  // ─── T-Post.Class.1 ───────────────────────────────────────────────────────
  it("T-Post.Class.1: classifyOutboundLabel('Post') returns 'post' (anchored ^post$ regex)", () => {
    // Given: label "Post" (the share-composer publish button accessible name).
    // When:  classifyOutboundLabel("Post") runs.
    // Then:  returns "post" (new OutboundClass added by P-POST).
    if (!classifyOutboundLabelPost) {
      assert.fail("T-Post.Class.1: classifyOutboundLabel not exported from outboundGuard.ts");
    }
    // Pre-Step-4: classifyOutboundLabel("Post") currently returns "benign" (no "post" class yet).
    // This assertion FAILS until Step 4 adds the POST_PUBLISH_RE branch.
    assert.equal(
      classifyOutboundLabelPost("Post"),
      "post",
      'T-Post.Class.1: classifyOutboundLabel("Post") must return "post" after P-POST adds POST_PUBLISH_RE branch',
    );
  });

  // ─── T-Post.Class.2 — SAFETY-CRITICAL: Repost MUST NOT classify as post ──
  it("T-Post.Class.2: classifyOutboundLabel('Repost') returns 'benign' — anchor guard (safety-critical)", () => {
    // Given: label "Repost" (the most likely false-positive on LinkedIn feed).
    // When:  classifyOutboundLabel("Repost") runs.
    // Then:  returns "benign" — the leading 'R' defeats the ^post$ anchor.
    //        Safety-critical: if "Repost" were mistakenly classified as "post",
    //        every Repost click on feed would be approval-gated (breakage) or blocked in Auto.
    if (!classifyOutboundLabelPost) {
      assert.fail("T-Post.Class.2: classifyOutboundLabel not exported from outboundGuard.ts");
    }
    // Pre-Step-4: already returns "benign" (no "post" class exists yet).
    // This assertion PASSES pre-Step-4 but is CRITICAL to keep passing post-Step-4.
    // The test is included here to make the safety anchor explicit and prevent regression.
    assert.equal(
      classifyOutboundLabelPost("Repost"),
      "benign",
      'T-Post.Class.2: classifyOutboundLabel("Repost") must return "benign" — ^post$ anchor must NOT match "Repost"',
    );
  });

  // ─── T-Post.Class.3 ───────────────────────────────────────────────────────
  it("T-Post.Class.3: post is case-insensitive but anchored — 'post', 'POST', 'Post ' → 'post'; 'Reposted', 'Post message', 'Repost with thoughts' → 'benign'", () => {
    // Given: labels ["post", "POST", "Post "] (trimmed variants that should match)
    //        AND labels ["Reposted", "Post message", "Repost with thoughts"] (plausible false positives).
    // When:  classifyOutboundLabel(label) runs (existing .trim() in the classify function).
    // Then:  "post"/"POST"/"Post " → "post";
    //        "Reposted"/"Post message"/"Repost with thoughts" → "benign".
    if (!classifyOutboundLabelPost) {
      assert.fail("T-Post.Class.3: classifyOutboundLabel not exported from outboundGuard.ts");
    }
    // Case-insensitive matches (all return "post" after trim + regex)
    for (const label of ["post", "POST", "Post "]) {
      // Pre-Step-4: returns "benign". Will return "post" after Step 4.
      assert.equal(
        classifyOutboundLabelPost(label),
        "post",
        `T-Post.Class.3: classifyOutboundLabel("${label}") must return "post" (case-insensitive ^post$ after trim)`,
      );
    }
    // False-positive guard (should already pass + continue passing post-Step-4)
    for (const label of ["Reposted", "Post message", "Repost with thoughts"]) {
      assert.equal(
        classifyOutboundLabelPost(label),
        "benign",
        `T-Post.Class.3: classifyOutboundLabel("${label}") must return "benign" (not matched by ^post$)`,
      );
    }
  });

  // ─── T-Post.Class.4 ───────────────────────────────────────────────────────
  it("T-Post.Class.4: existing label classifications unchanged — regression guard", () => {
    // Given: the legacy fixture of labels from the existing outboundGuard tests.
    // When:  classifyOutboundLabel(label) runs for each.
    // Then:  every pre-existing classification is unchanged.
    //        Regression guard: P-POST must not break the existing classifyOutboundLabel behavior.
    if (!classifyOutboundLabelPost) {
      assert.fail("T-Post.Class.4: classifyOutboundLabel not exported from outboundGuard.ts");
    }
    const regressionFixture: Array<[string, string]> = [
      ["Send invitation", "connect_send"],
      ["Send invite", "connect_send"],
      ["Send without a note", "connect_send"],
      ["Send now", "connect_send"],
      ["发送邀请", "connect_send"],
      ["Connect", "connect_open"],
      ["Invite Jane to connect", "connect_open"],
      ["Send", "message_send"],
      ["发送", "message_send"],
      ["Follow", "benign"],
      ["Like", "benign"],
      ["Comment", "benign"],
    ];
    for (const [label, expected] of regressionFixture) {
      assert.equal(
        classifyOutboundLabelPost(label),
        expected,
        `T-Post.Class.4 regression: classifyOutboundLabel("${label}") must return "${expected}" (unchanged from pre-P-POST)`,
      );
    }
  });
});

describe("T-Post.Approval — outboundGuard: requiresApproval post+feed surface gating (G-POST.Approval)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import for scaffold
  let requiresApprovalPost: ((...args: any[]) => any) | null = null;

  before(async () => {
    const mod = await import("../../../src/tools/browser/outboundGuard.js").catch(() => null);
    if (mod) {
      // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
      requiresApprovalPost = (mod as any).requiresApproval ?? null;
    }
  });

  // ─── T-Post.Approval.1 ────────────────────────────────────────────────────
  it("T-Post.Approval.1: requiresApproval('Post', 'feed') returns true (closes the previously UNGATED Post button)", () => {
    // Given: label="Post", surface="feed".
    // When:  requiresApproval("Post", "feed") runs.
    // Then:  returns true — the new P-POST branch gates Post on the feed surface.
    //        Safety: the Post publish button is now gated; unapproved clicks return approval_required.
    if (!requiresApprovalPost) {
      assert.fail("T-Post.Approval.1: requiresApproval not exported from outboundGuard.ts");
    }
    // Pre-Step-4: returns false (no "post" class, no feed branch). Will return true after Step 4.
    assert.equal(
      requiresApprovalPost("Post", "feed"),
      true,
      'T-Post.Approval.1: requiresApproval("Post","feed") must return true after P-POST adds the feed gate',
    );
  });

  // ─── T-Post.Approval.2 ────────────────────────────────────────────────────
  it("T-Post.Approval.2: Post on non-feed surfaces returns false — surface-locked gate", () => {
    // Given: label="Post", surface ∈ {"profile","messaging","messaging-thread","company","network","notifications","search","unknown",""}.
    // When:  requiresApproval("Post", surface) runs.
    // Then:  returns false for all non-feed surfaces.
    //        Guards against spurious approval gates on random LinkedIn UI that renders a "Post" button.
    if (!requiresApprovalPost) {
      assert.fail("T-Post.Approval.2: requiresApproval not exported from outboundGuard.ts");
    }
    const nonFeedSurfaces = [
      "profile",
      "messaging",
      "messaging-thread",
      "company",
      "network",
      "notifications",
      "search",
      "unknown",
      "",
    ];
    // Pre-Step-4: already returns false on non-feed surfaces (no "post" class exists yet).
    // Critical regression guard post-Step-4: must remain false on non-feed surfaces.
    for (const surface of nonFeedSurfaces) {
      assert.equal(
        requiresApprovalPost("Post", surface),
        false,
        `T-Post.Approval.2: requiresApproval("Post","${surface}") must return false (gate is feed-surface-locked)`,
      );
    }
  });

  // ─── T-Post.Approval.3 — SAFETY-CRITICAL: Repost on feed → false ─────────
  it("T-Post.Approval.3: requiresApproval('Repost', 'feed') returns false — anchor guard defense-in-depth (safety-critical)", () => {
    // Given: label="Repost", surface="feed".
    // When:  requiresApproval("Repost", "feed") runs.
    // Then:  returns false — classifyOutboundLabel("Repost") === "benign" (not "post"),
    //        so the feed branch is NOT triggered.
    //        Safety-critical: if this returned true, every Repost click on feed would be gated.
    if (!requiresApprovalPost) {
      assert.fail("T-Post.Approval.3: requiresApproval not exported from outboundGuard.ts");
    }
    // Passes pre-Step-4 AND must continue to pass post-Step-4.
    assert.equal(
      requiresApprovalPost("Repost", "feed"),
      false,
      'T-Post.Approval.3: requiresApproval("Repost","feed") must return false — ^post$ anchor prevents "Repost" match',
    );
  });

  // ─── T-Post.Approval.4 ────────────────────────────────────────────────────
  it("T-Post.Approval.4: existing approval semantics unchanged — regression guard (P-ZH-2 F1 intentional flip noted)", () => {
    // Given: the legacy fixture of (label, surface) pairs from pre-P-POST tests.
    // When:  requiresApproval(label, surface) runs.
    // Then:  every pre-existing verdict is unchanged, EXCEPT the bare Send/profile case,
    //        which P-ZH-2 F1 intentionally flips to true (safety-positive — see
    //        T-RequiresApproval.3 above; requiresApproval broadened the message_send
    //        gate from MESSAGING_SURFACES to LINKEDIN_OUTBOUND_SURFACES).
    if (!requiresApprovalPost) {
      assert.fail("T-Post.Approval.4: requiresApproval not exported from outboundGuard.ts");
    }
    const regressionFixture: Array<[string, string, boolean]> = [
      ["Send invitation", "profile", true], // outbound label → always true
      ["Follow", "profile", true], // Follow on profile → true
      ["Follow", "feed", false], // Follow on feed → false (profile-only)
      ["Send", "messaging-thread", true], // message_send on messaging surface → true
      ["Like", "feed", false], // benign → false
      ["Comment", "feed", false], // benign → false
      ["Send", "profile", true], // P-ZH-2 F1: bare send-family on ANY outbound surface → true (was false)
    ];
    for (const [label, surface, expected] of regressionFixture) {
      assert.equal(
        requiresApprovalPost(label, surface),
        expected,
        `T-Post.Approval.4 regression: requiresApproval("${label}","${surface}") must return ${expected} (unchanged)`,
      );
    }
  });
});
