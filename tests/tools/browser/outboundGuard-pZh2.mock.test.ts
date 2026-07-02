/**
 * Phase P-ZH-2 Step 2 — T-Guard.1..6 (SAFETY-CRITICAL, scaffold).
 * Phase P-ZH-2 Step 3a — T-Guard.7 added (the BLOCKER-fix safety scaffold, plan §5.4/§12.1),
 * T-Guard.5 extended with a '关注者' negative (the CONCERN-fix, plan §5.1a/§12.4).
 *
 * Source-under-test (ALREADY EXISTS — unlike actionClassifier.ts, outboundGuard.ts already
 * carries substantial ZH pattern support from prior phases, e.g. P-63/P-MSG-SEND/P-POST):
 *   src/tools/browser/outboundGuard.ts — requiresApproval, classifyOutboundLabel,
 *     classifyOutboundEntry, LINKEDIN_OUTBOUND_SURFACES
 *   src/linkedin/inspectSummary.ts — buildInspectSummary (isOutboundActionEntry is internal/
 *     unexported — exercised indirectly through the `[OUTBOUND]` label prefix it produces).
 *
 * ★ GROUND-TRUTHED FINDING (validator, this session — flag to critic, do NOT silently resolve):
 * running the CURRENT source against every T-Guard.1/.3/.4/.5 value shows they are ALREADY GREEN
 * pre-Step-4 (OUTBOUND_LABEL_RE/CONNECT_OPEN_RE/CONNECT_SEND_RE/MESSAGE_SEND_RE already contain
 * ZH alternatives). Only T-Guard.2 (the `/关注$/` end-anchor follow bug — ROADMAP's explicitly
 * confirmed live safety bug), the FOLLOW half of T-Guard.6, and the new T-Guard.7 (the bare-发送
 * safety-floor BLOCKER) are genuinely RED today. This deviates from strict outside-in-TDD "all
 * scaffolds fail" — T-Guard.1/.3/.4/.5 are kept as REGRESSION-GUARDS (the Step-4 refactor routes
 * these patterns through the new central actionClassifier.ts and must not regress already-correct
 * ZH behavior), while T-Guard.2, the follow half of T-Guard.6, and T-Guard.7 are the genuine
 * pre-Step-4 gaps. Ground-truth commands run this session (see docs/phase-zh2-test.md § Test
 * Contract for the exact output).
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit tests/tools/browser/outboundGuard-pZh2.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInspectSummary } from "../../../src/linkedin/inspectSummary.js";
import {
  classifyOutboundEntry,
  classifyOutboundLabel,
  LINKEDIN_OUTBOUND_SURFACES,
  requiresApproval,
} from "../../../src/tools/browser/outboundGuard.js";

describe("T-Guard — outbound safety on ZH labels (outboundGuard.ts)", () => {
  // ─── T-Guard.1 — ALREADY GREEN (regression-guard) ────────────────────────
  it("T-Guard.1: requiresApproval fires on ZH connect labels ('邀请X加为好友', '发送邀请') on the profile surface", () => {
    // Given: a ZH connect-open label and a ZH connect-send label.
    // When:  requiresApproval(label, "profile") runs for each.
    // Then:  both return true.
    //   NOTE: already true against the CURRENT source (OUTBOUND_LABEL_RE already contains 邀请/
    //   发送邀请) — kept as a regression-guard for the Step-4 actionClassifier migration.
    assert.equal(requiresApproval("邀请Jaiden Silva加为好友", "profile"), true, "ZH connect-open label must require approval");
    assert.equal(requiresApproval("发送邀请", "profile"), true, "ZH connect-send label must require approval");
  });

  // ─── T-Guard.2 — GENUINELY RED (the regression pin) ──────────────────────
  it("T-Guard.2: requiresApproval fires on a ZH name-interpolated follow label ('关注Chris Davis') on the profile surface — regression pin for the /关注$/ end-anchor bug", () => {
    // Given: a name-interpolated ZH follow label (关注 + name, no trailing anchor match today).
    // When:  requiresApproval("关注Chris Davis", "profile") runs.
    // Then:  returns true. The PRE-FIX FOLLOW_LABEL_RE (`/关注$/`, end-anchored) returns false for
    //   this exact input because the trailing name defeats the `$` anchor — an UNGUARDED-FOLLOW
    //   hole on 中文 today (ROADMAP P-ZH-AGENT Step 1 finding). Fix = start-anchor `/^关注/`.
    assert.equal(
      requiresApproval("关注Chris Davis", "profile"),
      true,
      "ZH name-interpolated follow label must require approval (regression pin for the end-anchor bug)",
    );
  });

  // ─── T-Guard.3 — ALREADY GREEN (regression-guard) ────────────────────────
  it("T-Guard.3: requiresApproval fires on a bare ZH message-send label ('发送') on the messaging-thread surface", () => {
    // Given: the bare ZH Send-family label on a messaging surface.
    // When:  requiresApproval("发送", "messaging-thread") runs.
    // Then:  returns true.
    //   NOTE: already true against the CURRENT source — kept as a regression-guard.
    assert.equal(requiresApproval("发送", "messaging-thread"), true, "bare ZH Send on messaging-thread must require approval");
  });

  // ─── T-Guard.4 — ALREADY GREEN for the two direct classifications ───────
  it("T-Guard.4: classifyOutboundLabel assigns the correct ledger class to ZH connect labels ('发送邀请'→connect_send, '邀请X加为好友'→connect_open)", () => {
    // Given: the ZH connect-send commit label and the ZH connect-open label.
    // When:  classifyOutboundLabel(label) runs for each.
    // Then:  '发送邀请' → "connect_send"; '邀请X加为好友' → "connect_open".
    //   NOTE: already true against the CURRENT source — kept as a regression-guard.
    //   ★ AMBIGUITY FLAGGED TO CRITIC (not resolved here): plan §5.4 additionally requires that a
    //   BARE '发送' classifies as "message_send" on a messaging surface but as "connect_send" when
    //   a connect-dialog/scope is present — this is a CALLER-SIDE (scope-aware) reclassification
    //   that classifyOutboundLabel's current (label-only) signature cannot express, and no existing
    //   consumer (connectPrompt.ts / feedProfile.ts) implements it today. Left unasserted here
    //   pending Step-4/critic clarification of which function owns the scope-aware branch.
    assert.equal(classifyOutboundLabel("发送邀请"), "connect_send", 'classifyOutboundLabel("发送邀请") must return "connect_send"');
    assert.equal(classifyOutboundLabel("邀请X加为好友"), "connect_open", 'classifyOutboundLabel("邀请X加为好友") must return "connect_open"');
  });

  // ─── T-Guard.5 — ALREADY GREEN (regression-guard) ────────────────────────
  it("T-Guard.5: benign ZH nav labels ('主页', '搜索') do NOT require approval and classify as benign; '关注者' (follower-count, NOT a follow control) does not require approval either — Critic CONCERN negative", () => {
    // Given: two benign ZH nav labels (Home, Search), plus the follower-count label '关注者'.
    // When:  requiresApproval(label, "profile") and classifyOutboundLabel(label) run for each.
    // Then:  requiresApproval → false; classifyOutboundLabel → "benign".
    //   NOTE: already true against the CURRENT source — kept as a false-positive guard.
    //   '关注者' is already false today (FOLLOW_LABEL_RE's end-anchor `关注$` fails to match the
    //   trailing 者) and must REMAIN false after the FOLLOW_RE `关注(?!者)` negative-lookahead fix
    //   (§5.1a) — a regression guard, not a genuine pre-Step-4 red.
    for (const label of ["主页", "搜索", "关注者"]) {
      assert.equal(requiresApproval(label, "profile"), false, `requiresApproval("${label}", "profile") must be false`);
      assert.equal(classifyOutboundLabel(label), "benign", `classifyOutboundLabel("${label}") must be "benign"`);
    }
  });

  // ─── T-Guard.6 — connect half GREEN, follow half RED (the genuine gap) ───
  it("T-Guard.6: buildInspectSummary promotes a ZH connect entry to [OUTBOUND] (already true) AND a ZH follow entry to [OUTBOUND] (RED today — same end-anchor bug as T-Guard.2)", () => {
    // Given: a profile-surface context with one ZH connect-open entry and one ZH follow entry.
    // When:  buildInspectSummary(ctx) runs.
    // Then:  BOTH entries' rendered button label must carry the "[OUTBOUND] " prefix so the agent
    //   cannot miss either as an outbound control (isOutboundActionEntry, inspectSummary.ts:119,
    //   is internal/unexported — exercised here via its observable effect on the button list).
    //   The connect entry already gets the prefix (OUTBOUND_LABEL_RE already ZH-aware); the follow
    //   entry does NOT (FOLLOW_LABEL_RE end-anchor bug) — this is the genuine RED half.
    const ctx = {
      surface: "profile" as const,
      activeLayer: "page" as const,
      entries: [
        { ref: "@e1", role: "button", name: "邀请Jaiden Silva加为好友" },
        { ref: "@e2", role: "button", name: "关注Chris Davis" },
      ],
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal CurrentSurfaceContext fixture, fields beyond entries/surface unused by buildInspectSummary
    const summary = buildInspectSummary(ctx as any);
    const connectBtn = summary.buttons.find((b) => b.ref === "@e1");
    const followBtn = summary.buttons.find((b) => b.ref === "@e2");
    assert.equal(connectBtn?.label, "[OUTBOUND] 邀请Jaiden Silva加为好友", "ZH connect entry must be promoted with the [OUTBOUND] prefix");
    assert.equal(followBtn?.label, "[OUTBOUND] 关注Chris Davis", "ZH follow entry must be promoted with the [OUTBOUND] prefix (RED until the end-anchor bug is fixed)");
  });

  // ─── T-Guard.7 — bare 发送 safety floor + context-aware ledger ───────────
  // (SAFETY-CRITICAL, resolves Critic BLOCKER — Step 3a addition, plan §5.4 F1+F2 / §12.1)
  it("T-Guard.7 F1: requiresApproval('发送', surface) === true on EVERY LINKEDIN_OUTBOUND_SURFACES surface — the safety floor, independent of connect-dialog context", () => {
    // Given: the bare ZH Send-family label, no connect-dialog context, checked against every
    //   surface in the exported LINKEDIN_OUTBOUND_SURFACES set (feed/profile/network/search/
    //   company/messaging/messaging-thread/notifications).
    // When:  requiresApproval("发送", surface) runs for each.
    // Then:  every one returns true. PROVEN pre-fix gap (docs/phase-zh2-critics.md BLOCKER,
    //   ground-truthed probe `requiresApproval("发送","profile")===false`): today only the two
    //   MESSAGING_SURFACES ("messaging"/"messaging-thread") return true; every other surface
    //   (profile/feed/network/search/company/notifications) returns false — a bare-发送 connect
    //   commit on a profile is UNGUARDED. F1 fix = broaden the message_send approval gate from
    //   `MESSAGING_SURFACES.has(surface)` to `LINKEDIN_OUTBOUND_SURFACES.has(surface)`
    //   (outboundGuard.ts:36-42). SAFETY INVARIANT (plan §5.4, verbatim): after F1, NO bare
    //   send-family label on any LinkedIn outbound surface can reach a real CDP send without
    //   operator approval — independent of connect-vs-message classification or any dialog-
    //   context detection (F2, below, is a ledger/cap correctness refinement layered on top).
    for (const surface of LINKEDIN_OUTBOUND_SURFACES) {
      assert.equal(
        requiresApproval("发送", surface),
        true,
        `requiresApproval("发送", "${surface}") must be true (F1 safety floor) — RED today for every non-messaging surface`,
      );
    }
  });

  it("T-Guard.7 F2: classifyOutboundEntry(entry, surface, opts) promotes a bare 发送 to 'connect_send' ONLY when opts.connectDialogActive===true on a non-messaging outbound surface; stays 'message_send' otherwise", () => {
    // Given: a bare-发送 button entry, checked with the planned 3rd `opts?: { connectDialogActive
    //   ?: boolean }` argument (plan §5.4 F2 — classifyOutboundEntry is 2-arg on the CURRENT
    //   source; the 3rd arg is ignored by JS at runtime today and this file is transpile-only
    //   under tsx, so the extra argument does not break compilation — see docs/phase-zh2-test.md
    //   § Import/compile approach).
    // When:  classifyOutboundEntry(sendEntry, surface, opts) runs for: (a) "profile" with
    //   connectDialogActive:true, (b) "profile" with connectDialogActive:false, (c) "profile"
    //   with opts omitted, (d) "messaging-thread" with connectDialogActive:true.
    // Then:  (a) → "connect_send" (RED today — the current 2-arg function always falls through
    //   to classifyOutboundLabel("发送")==="message_send", ignoring context); (b)/(c)/(d) →
    //   "message_send" (regression guards — a bare 发送 with no active connect dialog, or on a
    //   messaging surface, must NEVER be misclassified as connect_send).
    const sendEntry = { name: "发送", role: "button" };

    assert.equal(
      // biome-ignore lint/suspicious/noExplicitAny: opts is a Step-4-planned 3rd param, not yet on classifyOutboundEntry's current 2-arg signature (plan §5.4 F2)
      (classifyOutboundEntry as any)(sendEntry, "profile", { connectDialogActive: true }),
      "connect_send",
      "a bare 发送 entry with an active connect dialog on 'profile' must classify as connect_send (F2) — RED pre-Step-4",
    );
    assert.equal(
      // biome-ignore lint/suspicious/noExplicitAny: same as above
      (classifyOutboundEntry as any)(sendEntry, "profile", { connectDialogActive: false }),
      "message_send",
      "a bare 发送 entry with NO active connect dialog on 'profile' must stay message_send (regression guard)",
    );
    assert.equal(
      classifyOutboundEntry(sendEntry, "profile"),
      "message_send",
      "a bare 发送 entry with opts omitted on 'profile' must stay message_send (regression guard, current 2-arg call form)",
    );
    assert.equal(
      // biome-ignore lint/suspicious/noExplicitAny: same as above
      (classifyOutboundEntry as any)(sendEntry, "messaging-thread", { connectDialogActive: true }),
      "message_send",
      "a bare 发送 entry on 'messaging-thread' must stay message_send regardless of connectDialogActive (regression guard)",
    );
  });
});
