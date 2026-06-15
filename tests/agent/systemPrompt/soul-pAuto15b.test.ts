/**
 * P-AUTO-15b Step 3 — Test Scaffold — G-A15b.8..9c (QS-7.d + QS-5 soul edits)
 *
 * Covers (new file — soul-pAuto15b.test.ts):
 *   G-A15b.8   — HARD CAPTURE uses {personName, profileUrl} (bare two-arg form) AND old {fullName, form ABSENT
 *   G-A15b.8a  — HARD CAPTURE explains bare-vs-headline rule (reconciliation prose present)
 *   G-A15b.8b  — QS-5 habit line is present in global triggerHabits (composeSoulBand)
 *   G-A15b.9   — P-AUTO-8/9/10/13/14 auto-fragment load-bearing phrases all present
 *   G-A15b.9a  — Five unchanged AUTO-clause locked literals byte-equal (from p-auto-14 test)
 *   G-A15b.9c  — composeSoulBand(null) still parses without throwing
 *
 * G-A15b.9b is implemented as a CHANGE to the existing file
 *   soulModeFragmentAuto.p-auto-14.mock.test.ts (MR-4 update of LOCKED_EXHAUSTIVE_CAPTURE).
 *   See that file for T-A14.7 which continues to assert fragment.includes(LOCKED_EXHAUSTIVE_CAPTURE).
 *
 * Step-3 RED state (BEFORE builder Step 4):
 *   G-A15b.8:  FAILS — fragment still contains '{fullName, profileUrl}' (not yet fixed)
 *   G-A15b.8a: FAILS — reconciliation prose not yet added to soul.ts
 *   G-A15b.8b: FAILS — QS-5 habit line not yet added to triggerHabits
 *   G-A15b.9:  PASSES — load-bearing phrases already present in today's auto fragment
 *   G-A15b.9a: PASSES — five locked literals already in today's auto fragment
 *   G-A15b.9c: PASSES — composeSoulBand(null) already works
 *
 * Run (mock only):
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/systemPrompt/soul-pAuto15b.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Dynamic import — soul.ts exists; its content changes at Step 4.
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder compatibility
let soulModeFragment: ((mode: "manual" | "magical" | "auto") => string) | undefined;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import
let composeSoulBand: ((identity: unknown) => string) | undefined;

const soulMod = await import("../../../src/agent/systemPrompt/soul.js").catch(() => null);
soulModeFragment = soulMod?.soulModeFragment;
composeSoulBand = soulMod?.composeSoulBand;

// ─── Locked literals from the EXISTING P-AUTO-14 test (byte-copy for G-A15b.9a) ──────────
// These are the FIVE locked literals that G-A15b.9a asserts must remain byte-equal
// after the P-AUTO-15b edit. They come from soulModeFragmentAuto.p-auto-14.mock.test.ts.
// We copy them here (NOT re-import) to keep this file self-contained.

const LOCKED_INSPECT_RECAP =
  "★ Inspect → see N people → record N candidates → score the best → THEN proceed. If you find yourself about to scroll/navigate/click without having called record_raw_candidate for everyone observed, STOP and call it now. ";

// P-AUTO-16 PO-7 UPDATE (Step 5, 2026-06-15):
// P-AUTO-16 intentionally inserted the "resume RESUMES it and DISCARDS any caps" clause
// into the start_auto_run sentence. Re-anchored to new verbatim production text per
// the D-A14.1 supersession precedent (intentional change → update the lock).
const LOCKED_START_AUTO_RUN_CLAUSE =
  "At the top of EVERY Auto turn: call `start_auto_run` (idempotent — returns the existing runId if a run is already in flight). `start_auto_run` is idempotent — if a run is already in flight it RESUMES it and DISCARDS any caps you passed (the original run's `maxConnects` / `maxDurationMinutes` stand). To apply NEW caps, `end_auto_run` the current run first, then `start_auto_run` fresh. The returned runId is required by every `record_auto_action` and `end_auto_run` call. Resume work BEFORE discovery: call `list_due_followups` first; process pending follow-ups before searching for new leads. Before EVERY outbound click (Connect/Send/Follow): call `get_auto_run_state` to check `connectsRemaining === null || connectsRemaining > 0` AND `(Date.now() - run.startedAt) / 60000 < run.maxDurationMinutes` AND `dailyOutbound.remaining > 0` (the cross-run daily LinkedIn-safety quota — connects+messages+follow-ups across ALL runs today) AND `dailyOutbound.cooldownActive === false` (the inter-outbound cooldown). If `connectsRemaining === 0` or the duration cap is exceeded OR `dailyOutbound.remaining === 0`, do NOT proceed — call `end_auto_run({status:'completed', summary})` instead. If ONLY `dailyOutbound.cooldownActive` is true (not enough time since the last outbound), do NOT send outbound this turn — keep doing read-only discovery/capture/scoring and let the cooldown elapse (re-check `get_auto_run_state` before the next outbound); NEVER bypass the cooldown to fire outbound back-to-back. Before any outbound to a lead, check whether the lead carries a duplicateOf signal — either from the current turn's promote_candidate_to_lead result OR from the latest promoted_to_lead entry in get_lead_context's timeline (its metadata carries duplicateOf when present, so the signal is queryable in any later turn after cooldown, discovery, or context compaction). If present, the lead shares a normalized name with an existing lead (likely the same human under a second LinkedIn slug). In Auto, you SKIP outbound to a duplicateOf-flagged lead this run — treat the lead as not-actionable, do not connect/message/follow, move on to the next lead; optionally call telegram_notify({summary:'…likely-duplicate person…'}) as a non-blocking heads-up. AUTO mode NEVER asks the operator mid-run, so do NOT wait for confirmation — skip is the resolution. The lead row still exists; the deferred hard-suppression phase will close the loop later. ";

// P-AUTO-16 PO-8 UPDATE (Step 5, 2026-06-15):
// P-AUTO-16 intentionally changed STOP CONDITIONS from "4 hold" to "5 hold" with (4a)/(4b) split
// and added PRECEDENCE clause (cooldown is NEVER a stop). Re-anchored to new verbatim production
// text per the D-A14.1 supersession precedent (intentional change → update the lock).
// P-AUTO-17 ND-3 UPDATE (Step 5, 2026-06-15):
// P-AUTO-17 appended `unresolvable_ref_on_outbound_surface` to the guard-reason slash-list.
// The locked literal is re-anchored to include the 10th token.
const LOCKED_FAILURE_BRANCH_AND_STOP_CONDITIONS =
  "After EVERY outbound attempt — INCLUDING a click that returns ok=false or is guard-rejected — two carve-outs apply: (1) the post-dispatch `ledger_write_failed` reason is a special case — the connect ACTUALLY SENT but the ledger write threw, the click layer has already latched outboundDisabled + best-effort persisted status='blocked'; do NOT call record_auto_action for it (the connect was sent — logging it now as success/skipped/failed would be a wrong row), call end_auto_run({status:'blocked', summary:'ledger write failed — sent connect is now untracked'}) instead; (2) for SUCCESSFUL connect-type sends, the click layer writes the connect_sent/success ledger row deterministically — calling record_auto_action with actionType='connect_sent' result='success' would double-count. For every OTHER outbound attempt: call `record_auto_action({runId, actionType, leadId, result})` FIRST (before any `end_auto_run`) so the ledger reflects reality. A guard-rejection (a fail carrying a `reason` token: cooldown_active / daily_quota_reached / auto_cap_reached / connect_note_required / approval_required / outbound_disabled / no_active_run / no_daily_snapshot / unresolvable_ref_on_outbound_surface) is a NON-attempt — use result:'skipped' (NOT 'failed') so policy blocks aren't miscounted as failed sends. A genuine send failure (ok=false with NO guard reason — e.g. ref_stale or a page error) → result:'failed'. Use record_auto_action for: any message_sent, any follow_up_sent, any FAILED or SKIPPED outcome, and any connect-type that did NOT result in a sent invite. STOP CONDITIONS — call `end_auto_run` when any of these 5 hold: (1) connect cap reached OR duration cap reached → status='completed'; (2) no more actionable leads (list_due_followups empty AND no new candidates discoverable) → status='stopped_by_agent', summary='No more actionable leads'; (3) the page is in an abnormal state you cannot recover from (CDP errors, unexpected redirects, login expired) → status='blocked', summary='Abnormal page: <one-line>'; (4a) the user EXPLICITLY asks you to stop or cancel the run → status='stopped_by_agent', summary='User stop/cancel: <one-line>' (you are stopping ON the user's behalf; the `stopped_by_user` status is reserved for the server's `/workflow/cancel` path and is not callable from this tool); (4b) you genuinely have NO next action (list_due_followups empty AND no new candidates discoverable AND no draft to advance) → status='stopped_by_agent', summary='No next action'. PRECEDENCE — outbound cooldown is NEVER a stop: if `dailyOutbound.remaining > 0` AND `dailyOutbound.cooldownActive === true`, there is still quota — keep doing read-only discovery/capture/scoring/drafting and let the cooldown elapse (this overlaps the cooldown clause above — they agree). Stop ONLY when (1)/(2)/(3)/(4a)/(4b) genuinely hold. AUTO mode NEVER asks the operator for guidance mid-run — `telegram_notify` reports outcomes but does NOT block waiting for a response. The final `end_auto_run` summary MUST include numeric counts (candidates observed, leads scored, leads qualified, outbound attempted, replies/intent if any). Outcome tracking: when you read a reply with clear meeting acceptance (agreed date/time/call, \"let's meet\", \"I'd love to connect\", \"book it\"), call `update_lead_stage({leadId, stage:'meeting_booked'})` — single call writes the stage AND appends the matching `meeting_booked` timeline event (do NOT also call `record_lead_event` for the same transition). This is the north-star outcome. When a reply shows genuine interest WITHOUT a meeting commitment, call `update_lead_stage({leadId, stage:'sales_intent'})` — which appends a `sales_intent_detected` timeline event. Record these immediately during the Auto loop; they are the metrics that prove Frondose works AND drive end_auto_run's final summary counts.";

const LOCKED_MANUAL_FRAGMENT =
  "You are in MANUAL mode (operator-prompt-driven). Before any outbound communication step (DM, connection request with note, post, comment), call `save_message_draft` first (so the operator sees the draft at approval), then declare it in your todo plan with requiresApproval:true and mark it in_progress — the operator will approve before you proceed. Outcome tracking: when you read a reply with clear meeting acceptance (agreed date/time/call, \"let's meet\", \"I'd love to connect\", \"book it\"), call `update_lead_stage({leadId, stage:'meeting_booked'})` — this single call writes the stage AND appends the matching `meeting_booked` timeline event (do NOT also call `record_lead_event` for the same transition — it would double-count). Before drafting outbound for a lead, check whether the lead carries a duplicateOf signal — either from the current turn's promote_candidate_to_lead result OR from the latest promoted_to_lead entry in get_lead_context's timeline metadata (durable across turns). If present, surface the duplicate-likely flag to the operator (via suggest_card or a brief plain-text note) and pause for the operator's call BEFORE save_message_draft, since this lead may share a person with one already in flight. The lead row still exists; this is a soft signal, not a block. This is the north-star outcome. When a reply shows genuine interest WITHOUT a meeting commitment, call `update_lead_stage({leadId, stage:'sales_intent'})` — which appends a `sales_intent_detected` timeline event. Record these immediately; they are the metrics that prove Frondose works.";

// D-A15b.2: LOCKED_MAGICAL_FRAGMENT updated to include the QS-5 evidenceJson reminder
// that was relocated from the soul-band triggerHabits to the Magical fragment during
// P-AUTO-15b Step 4 (budget fix: soul band had ~11 chars headroom, not enough for 277 chars).
// The addition: "; for any totalScore ≥ 40, supply `evidenceJson` — the JSON-stringified
// facts you cited — required, or score_lead rejects it"
const LOCKED_MAGICAL_FRAGMENT =
  "You are in MAGICAL mode (passive judgement). The operator browses LinkedIn manually; you observe in the background and record what you see. When a profile-view observation fires, your muscle memory is: record_raw_candidate (writes the observation to the sales kernel; returns a candidateId) → search_memory (any prior context on this person?) → qualify_profile (derives the ICP qualification from the visible role/industry/region/company) → score_lead (multi-dimensional score keyed by that candidateId; pass qualify_profile's qualification through; set confidence ≤ 0.4 for thin first-view evidence; for any totalScore ≥ 40, supply `evidenceJson` — the JSON-stringified facts you cited — required, or score_lead rejects it) → suggest_card only when totalScore ≥ 40 AND painHypothesis is non-empty (surfacing the judgement to the operator). When evidence is insufficient for a score, remember(kind:'at') the footprint and stop. You NEVER initiate outbound (connect/message/comment/follow) in Magical mode — outbound belongs to Manual or Auto, not Magical.";

// ─── G-A15b.8 — HARD CAPTURE param name fix ──────────────────────────────────

describe("G-A15b.8 — soulModeFragment('auto') HARD CAPTURE param name fix (QS-7.d)", () => {
  it("G-A15b.8: auto fragment contains 'record_raw_candidate({personName, profileUrl})' (bare two-arg) AND does NOT contain '{fullName,' (old buggy form)", () => {
    // Given: soul.ts at Step 4 (param-name fix applied)
    // When:  soulModeFragment("auto") returns the auto-mode prompt fragment
    // Then:  (a) contains 'record_raw_candidate({personName, profileUrl})' — correct param name
    //        (b) does NOT contain 'record_raw_candidate({fullName,' — old buggy form purged
    assert.ok(soulModeFragment !== undefined, "G-A15b.8: soulModeFragment must be importable from soul.ts");
    const fragment = soulModeFragment!("auto");
    // (a) New form present
    // TODO: Step-5 assertion fill — currently the fragment contains '{fullName, profileUrl}'
    assert.ok(
      fragment.includes("record_raw_candidate({personName, profileUrl})"),
      `G-A15b.8 FAIL (a): 'record_raw_candidate({personName, profileUrl})' absent. Fragment (first 300): ${fragment.slice(0, 300)}`,
    );
    // (b) Old form absent
    assert.ok(
      !fragment.includes("record_raw_candidate({fullName,"),
      `G-A15b.8 FAIL (b): old '{fullName,' form still present — must be purged. Fragment contains it at pos ${fragment.indexOf("record_raw_candidate({fullName,")}`,
    );
  });

  it("G-A15b.8a: auto fragment contains the bare-vs-headline reconciliation prose (CONCERN-MR-4 part 2)", () => {
    // Given: soul.ts at Step 4 (reconciliation prose added)
    // When:  soulModeFragment("auto") read
    // Then:  contains all 4 reconciliation phrases:
    //        "ON the captured person's profile page" (profile-page conditional opener)
    //        "also supply `evidenceSummary`" (profile-page add)
    //        "On a roster (search results, feed, mutual-connections) the bare two-arg form is correct" (roster rule)
    //        "COALESCE upsert refreshes the row" (later-refresh promise)
    assert.ok(soulModeFragment !== undefined, "G-A15b.8a: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");
    // TODO: Step-5 assertion fill — currently these phrases are absent
    assert.ok(
      fragment.includes("ON the captured person's profile page"),
      `G-A15b.8a FAIL: 'ON the captured person's profile page' absent. Fragment (first 400): ${fragment.slice(0, 400)}`,
    );
    assert.ok(
      fragment.includes("also supply `evidenceSummary`"),
      `G-A15b.8a FAIL: 'also supply \`evidenceSummary\`' absent`,
    );
    assert.ok(
      fragment.includes("On a roster (search results, feed, mutual-connections) the bare two-arg form is correct"),
      `G-A15b.8a FAIL: roster-bare-form rule absent`,
    );
    assert.ok(
      fragment.includes("COALESCE upsert refreshes the row"),
      `G-A15b.8a FAIL: 'COALESCE upsert refreshes the row' absent`,
    );
  });

  it("G-A15b.8b: soulModeFragment('magical') contains the QS-5 evidenceJson reminder (D-A15b.2: relocated from soul band to Magical fragment)", () => {
    // Given: soul.ts at Step 4 (QS-5 reminder relocated to Magical fragment — budget fix:
    //        the soul band has ~11 chars headroom; the 277-char reminder cannot fit there)
    // When:  soulModeFragment("magical") returns the Magical-mode prompt fragment
    // Then:  contains "evidenceJson" (the QS-5 reminder — score_lead requires evidenceJson
    //        when totalScore>=40; placed in the Magical fragment's score_lead call description)
    //
    // D-A15b.2: the scaffold originally asserted composeSoulBand(null) — re-pointed here
    // because the builder relocated the reminder to the Magical fragment during Step 4 due
    // to the soul-band character budget constraint (SOUL.length must stay < 8000).
    // composeSoulBand(null) does NOT contain the QS-5 reminder (confirmed below).
    assert.ok(soulModeFragment !== undefined, "G-A15b.8b: soulModeFragment must be importable from soul.ts");
    const magical = soulModeFragment!("magical");
    assert.ok(
      magical.includes("evidenceJson"),
      `G-A15b.8b FAIL: 'evidenceJson' absent from Magical fragment. Fragment (first 400): ${magical.slice(0, 400)}`,
    );
    // Confirm the soul band does NOT contain the QS-5 reminder (it was relocated)
    assert.ok(composeSoulBand !== undefined, "G-A15b.8b: composeSoulBand must be importable");
    const soul = composeSoulBand!(null);
    assert.ok(
      !soul.includes("for any totalScore ≥ 40, supply `evidenceJson`"),
      "G-A15b.8b: QS-5 reminder must NOT be in the soul band (it was relocated to Magical fragment due to budget constraint)",
    );
  });
});

// ─── G-A15b.9 — Load-bearing phrases preserved ───────────────────────────────

describe("G-A15b.9 — auto-fragment P-AUTO-8/9/10/13/14 clauses preserved after P-AUTO-15b edit", () => {
  it("G-A15b.9: P-AUTO-8/9/10/13/14 auto-fragment load-bearing phrases all present byte-for-byte (no collateral damage)", () => {
    // Given: soulModeFragment("auto") after Step 4 edits
    // When:  substring-search for each load-bearing phrase
    // Then:  every phrase present (the surgical soul.ts edit must not disturb other clauses)
    assert.ok(soulModeFragment !== undefined, "G-A15b.9: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");

    const phrases = [
      "★ CONVERT THE BEST",
      "connectsRemaining === null || connectsRemaining > 0",
      "dailyOutbound.cooldownActive === false",
      "duplicateOf",
      "ledger_write_failed",
      "STOP CONDITIONS",
      "meeting_booked",
      "sales_intent",
      "start_auto_run",
      "end_auto_run",
      "list_due_followups",
      "record_auto_action",
    ];

    for (const phrase of phrases) {
      assert.ok(
        fragment.includes(phrase),
        `G-A15b.9 FAIL: load-bearing phrase '${phrase}' absent from auto fragment after edit`,
      );
    }
  });

  it("G-A15b.9a: five unchanged AUTO-clause locked literals byte-equal after P-AUTO-15b edit (CONCERN-MR-4 strengthened)", () => {
    // Given: soulModeFragment("auto") after Step 4 edits
    // When:  substring-assert against the five locked literals that MUST remain unchanged
    // Then:  every literal present byte-for-byte (the edit is surgical to :154 only)
    assert.ok(soulModeFragment !== undefined, "G-A15b.9a: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");

    assert.ok(
      fragment.includes(LOCKED_INSPECT_RECAP),
      "G-A15b.9a FAIL: LOCKED_INSPECT_RECAP is not byte-equal after P-AUTO-15b edit",
    );
    assert.ok(
      fragment.includes(LOCKED_START_AUTO_RUN_CLAUSE),
      "G-A15b.9a FAIL: LOCKED_START_AUTO_RUN_CLAUSE is not byte-equal after P-AUTO-15b edit",
    );
    assert.ok(
      fragment.includes(LOCKED_FAILURE_BRANCH_AND_STOP_CONDITIONS),
      "G-A15b.9a FAIL: LOCKED_FAILURE_BRANCH_AND_STOP_CONDITIONS is not byte-equal after P-AUTO-15b edit",
    );
    // Manual + Magical checked via strictEqual below (they are separate mode returns)
    assert.strictEqual(
      soulModeFragment!("manual"),
      LOCKED_MANUAL_FRAGMENT,
      "G-A15b.9a FAIL: soulModeFragment('manual') is NOT byte-identical to locked literal — P-AUTO-15b must not touch it",
    );
    assert.strictEqual(
      soulModeFragment!("magical"),
      LOCKED_MAGICAL_FRAGMENT,
      "G-A15b.9a FAIL: soulModeFragment('magical') is NOT byte-identical to locked literal — P-AUTO-15b must not touch it",
    );
  });

  it("G-A15b.9c: composeSoulBand(null) returns a non-empty string without throwing (new habit line must not break it)", () => {
    // Given: null identity (no ICP, no personal context)
    // When:  composeSoulBand(null) called
    // Then:  returns a non-empty string (the SOUL const path is intact)
    assert.ok(composeSoulBand !== undefined, "G-A15b.9c: composeSoulBand must be importable");
    let soul: string | undefined;
    assert.doesNotThrow(() => {
      soul = composeSoulBand!(null);
    }, "G-A15b.9c: composeSoulBand(null) must not throw");
    assert.ok(soul && soul.length > 0, "G-A15b.9c: composeSoulBand(null) must return a non-empty string");
  });
});
