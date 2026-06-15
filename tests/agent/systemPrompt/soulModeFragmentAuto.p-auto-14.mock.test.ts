/**
 * P-AUTO-14 Step 3 — Test Scaffold — T-A14.1..14 (G-A14.1..14)
 *
 * Covers:
 *   G-A14.1  — directive marker "★ CONVERT THE BEST (per-turn funnel budget):" present
 *   G-A14.2  — names promote_candidate_to_lead → save_message_draft as the durable chain
 *   G-A14.3  — caps conversions at ONE per roster-turn
 *   G-A14.4  — states the P-AUTO-4 qualification floor (totalScore ≥ 40 AND nextAction !== 'disqualify')
 *   G-A14.5  — draft is durable / NOT subject to inter-outbound cooldown
 *   G-A14.6  — click-time gates P-AUTO-9/10/13 restated as non-bypassed
 *   G-A14.7  — EXHAUSTIVE CAPTURE block byte-identical (D-26/D-28 regression guard)
 *   G-A14.8  — "Inspect → see N people" recap line byte-identical
 *   G-A14.9  — start_auto_run + connectsRemaining + dailyOutbound + cooldown + duplicateOf clause byte-identical
 *   G-A14.10 — P-AUTO-13 failure-branch + STOP CONDITIONS + outcome-tracking clauses byte-identical
 *   G-A14.11 — soulModeFragment('manual') byte-identical to pre-P-AUTO-14 source
 *   G-A14.12 — soulModeFragment('magical') byte-identical to pre-P-AUTO-14 source
 *   G-A14.13 — CONVERT THE BEST positioned AFTER recap AND BEFORE start_auto_run opener
 *   G-A14.14 — auto fragment still begins with "You are in AUTO mode" declaration
 *
 * Step-3 red/green split (BEFORE builder Step 4):
 *   FAIL (new-directive absent): T-A14.1..6, T-A14.13
 *   PASS (existing clauses already present): T-A14.7..12, T-A14.14
 *
 * Run individually:
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/agent/systemPrompt/soulModeFragmentAuto.p-auto-14.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Dynamic import — soul.ts exists; its content changes at Step 4.
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder compatibility
let soulModeFragment: ((mode: "manual" | "magical" | "auto") => string) | undefined;

const soulMod = await import("../../../src/agent/systemPrompt/soul.js").catch(() => null);
soulModeFragment = soulMod?.soulModeFragment;

// ─── Locked literals (byte-identical to pre-P-AUTO-14 soul.ts at Step 3) ─────────

/**
 * G-A14.7 — EXHAUSTIVE CAPTURE block (soul.ts:154, inside the `★ HARD CAPTURE DIRECTIVE` chunk).
 * This is the exact substring from the opening `★ HARD CAPTURE DIRECTIVE` through
 * `don't do that. ` (the trailing space before the next chunk starts).
 * Byte-identical pin — must survive the additive P-AUTO-14 insertion.
 */
// P-AUTO-15b MR-4 UPDATE (Step 3, 2026-06-15):
// Updated from the OLD '{fullName, profileUrl}' form to the NEW '{personName, profileUrl}' form
// per the QS-7.d soul edit in docs/phase-auto-15b-plan.md §2 + §6.4.
// The builder (Step 4) applies the corresponding change to soul.ts:154.
// The T-A14.7 assertion (fragment.includes(LOCKED_EXHAUSTIVE_CAPTURE)) is the regression
// guard that ensures the NEW form is byte-present in the post-edit auto fragment.
const LOCKED_EXHAUSTIVE_CAPTURE =
  "★ HARD CAPTURE DIRECTIVE (non-negotiable): every time you observe a LinkedIn person while browsing — feed post author, search result row, comment author, mutual-connections list, anyone visible in `inspect` output with a profile URL — you MUST call `record_raw_candidate({personName, profileUrl})` BEFORE doing anything else with that person. When you are ON the captured person's profile page AND their headline is in `inspect`, also supply `evidenceSummary` — the headline/title line as observed (e.g. \"VP Sales at Acme · EMEA\") — so the qualification gate has signal. On a roster (search results, feed, mutual-connections) the bare two-arg form is correct; the COALESCE upsert refreshes the row with a real headline later when you visit the profile. ★ Browsing without capture is treated as a failed turn. ★ EXHAUSTIVE CAPTURE (D-28): after each `inspect` that surfaces a list of people (search results, feed roster, mutual-connections), the FIRST action is to call `record_raw_candidate` for EACH visible person — capture them ALL, one tool call per person, before any `score_lead` / `qualify_profile` / `scroll` / `navigate`. If `inspect` shows 5 people, you owe 5 record_raw_candidate calls. The most common Auto-mode failure is over-eager scoring after 2 captures while 8 unseen people scroll past — don't do that. ";

/**
 * G-A14.8 — "Inspect → see N people" recap line (soul.ts:155).
 * Byte-identical pin — must survive the additive P-AUTO-14 insertion.
 */
const LOCKED_INSPECT_RECAP =
  "★ Inspect → see N people → record N candidates → score the best → THEN proceed. If you find yourself about to scroll/navigate/click without having called record_raw_candidate for everyone observed, STOP and call it now. ";

/**
 * G-A14.9 — start_auto_run + connectsRemaining + dailyOutbound + cooldown + duplicateOf clause (soul.ts:156).
 * Byte-identical pin — spans from "At the top of EVERY Auto turn:" through
 * "Skip is the resolution. The lead row still exists; the deferred hard-suppression phase will close the loop later. "
 * Must survive the additive P-AUTO-14 insertion (this chunk is AFTER the new directive).
 *
 * P-AUTO-16 PO-7 UPDATE (Step 5, 2026-06-15):
 * P-AUTO-16 intentionally inserted the "resume RESUMES it and DISCARDS any caps" clause
 * into the start_auto_run sentence (between the idempotency note and "The returned runId...").
 * The locked literal is re-anchored to the new verbatim production text per the D-A14.1
 * supersession precedent: when a new phase intentionally changes a prompt clause, the older
 * phase's LOCKED_* byte-lock literal is updated to match (byte-lock discipline preserved —
 * the literal is verbatim, just re-anchored to the new truth).
 */
const LOCKED_START_AUTO_RUN_CLAUSE =
  "At the top of EVERY Auto turn: call `start_auto_run` (idempotent — returns the existing runId if a run is already in flight). `start_auto_run` is idempotent — if a run is already in flight it RESUMES it and DISCARDS any caps you passed (the original run's `maxConnects` / `maxDurationMinutes` stand). To apply NEW caps, `end_auto_run` the current run first, then `start_auto_run` fresh. The returned runId is required by every `record_auto_action` and `end_auto_run` call. Resume work BEFORE discovery: call `list_due_followups` first; process pending follow-ups before searching for new leads. Before EVERY outbound click (Connect/Send/Follow): call `get_auto_run_state` to check `connectsRemaining === null || connectsRemaining > 0` AND `(Date.now() - run.startedAt) / 60000 < run.maxDurationMinutes` AND `dailyOutbound.remaining > 0` (the cross-run daily LinkedIn-safety quota — connects+messages+follow-ups across ALL runs today) AND `dailyOutbound.cooldownActive === false` (the inter-outbound cooldown). If `connectsRemaining === 0` or the duration cap is exceeded OR `dailyOutbound.remaining === 0`, do NOT proceed — call `end_auto_run({status:'completed', summary})` instead. If ONLY `dailyOutbound.cooldownActive` is true (not enough time since the last outbound), do NOT send outbound this turn — keep doing read-only discovery/capture/scoring and let the cooldown elapse (re-check `get_auto_run_state` before the next outbound); NEVER bypass the cooldown to fire outbound back-to-back. Before any outbound to a lead, check whether the lead carries a duplicateOf signal — either from the current turn's promote_candidate_to_lead result OR from the latest promoted_to_lead entry in get_lead_context's timeline (its metadata carries duplicateOf when present, so the signal is queryable in any later turn after cooldown, discovery, or context compaction). If present, the lead shares a normalized name with an existing lead (likely the same human under a second LinkedIn slug). In Auto, you SKIP outbound to a duplicateOf-flagged lead this run — treat the lead as not-actionable, do not connect/message/follow, move on to the next lead; optionally call telegram_notify({summary:'…likely-duplicate person…'}) as a non-blocking heads-up. AUTO mode NEVER asks the operator mid-run, so do NOT wait for confirmation — skip is the resolution. The lead row still exists; the deferred hard-suppression phase will close the loop later. ";

/**
 * G-A14.10 — P-AUTO-13 failure-branch + STOP CONDITIONS + outcome-tracking clauses (soul.ts:163).
 * Byte-identical pin — spans from "After EVERY outbound attempt — INCLUDING a click that returns ok=false"
 * through "they are the metrics that prove Frondose works AND drive end_auto_run's final summary counts."
 * Must survive the additive P-AUTO-14 insertion (this chunk is also AFTER the new directive).
 *
 * P-AUTO-16 PO-8 UPDATE (Step 5, 2026-06-15):
 * P-AUTO-16 intentionally changed STOP CONDITIONS from "4 hold" to "5 hold" with (4a)/(4b) split:
 *   OLD: "(4) the user asks you to stop or cancel the run, or you don't know what to do next →
 *        status='stopped_by_agent', summary='User stop/cancel or no clear next action: <one-line>'"
 *   NEW: "(4a) the user EXPLICITLY asks you to stop ... → summary='User stop/cancel: <one-line>'
 *        (4b) you genuinely have NO next action ... → summary='No next action'"
 *   Plus PRECEDENCE clause (cooldown is NEVER a stop).
 * The locked literal is re-anchored to the new verbatim production text per the D-A14.1
 * supersession precedent (intentional change → update the lock, preserve byte-identity discipline).
 */
const LOCKED_FAILURE_BRANCH_AND_STOP_CONDITIONS =
  "After EVERY outbound attempt — INCLUDING a click that returns ok=false or is guard-rejected — two carve-outs apply: (1) the post-dispatch `ledger_write_failed` reason is a special case — the connect ACTUALLY SENT but the ledger write threw, the click layer has already latched outboundDisabled + best-effort persisted status='blocked'; do NOT call record_auto_action for it (the connect was sent — logging it now as success/skipped/failed would be a wrong row), call end_auto_run({status:'blocked', summary:'ledger write failed — sent connect is now untracked'}) instead; (2) for SUCCESSFUL connect-type sends, the click layer writes the connect_sent/success ledger row deterministically — calling record_auto_action with actionType='connect_sent' result='success' would double-count. For every OTHER outbound attempt: call `record_auto_action({runId, actionType, leadId, result})` FIRST (before any `end_auto_run`) so the ledger reflects reality. A guard-rejection (a fail carrying a `reason` token: cooldown_active / daily_quota_reached / auto_cap_reached / connect_note_required / approval_required / outbound_disabled / no_active_run / no_daily_snapshot) is a NON-attempt — use result:'skipped' (NOT 'failed') so policy blocks aren't miscounted as failed sends. A genuine send failure (ok=false with NO guard reason — e.g. ref_stale or a page error) → result:'failed'. Use record_auto_action for: any message_sent, any follow_up_sent, any FAILED or SKIPPED outcome, and any connect-type that did NOT result in a sent invite. STOP CONDITIONS — call `end_auto_run` when any of these 5 hold: (1) connect cap reached OR duration cap reached → status='completed'; (2) no more actionable leads (list_due_followups empty AND no new candidates discoverable) → status='stopped_by_agent', summary='No more actionable leads'; (3) the page is in an abnormal state you cannot recover from (CDP errors, unexpected redirects, login expired) → status='blocked', summary='Abnormal page: <one-line>'; (4a) the user EXPLICITLY asks you to stop or cancel the run → status='stopped_by_agent', summary='User stop/cancel: <one-line>' (you are stopping ON the user's behalf; the `stopped_by_user` status is reserved for the server's `/workflow/cancel` path and is not callable from this tool); (4b) you genuinely have NO next action (list_due_followups empty AND no new candidates discoverable AND no draft to advance) → status='stopped_by_agent', summary='No next action'. PRECEDENCE — outbound cooldown is NEVER a stop: if `dailyOutbound.remaining > 0` AND `dailyOutbound.cooldownActive === true`, there is still quota — keep doing read-only discovery/capture/scoring/drafting and let the cooldown elapse (this overlaps the cooldown clause above — they agree). Stop ONLY when (1)/(2)/(3)/(4a)/(4b) genuinely hold. AUTO mode NEVER asks the operator for guidance mid-run — `telegram_notify` reports outcomes but does NOT block waiting for a response. The final `end_auto_run` summary MUST include numeric counts (candidates observed, leads scored, leads qualified, outbound attempted, replies/intent if any). Outcome tracking: when you read a reply with clear meeting acceptance (agreed date/time/call, \"let's meet\", \"I'd love to connect\", \"book it\"), call `update_lead_stage({leadId, stage:'meeting_booked'})` — single call writes the stage AND appends the matching `meeting_booked` timeline event (do NOT also call `record_lead_event` for the same transition). This is the north-star outcome. When a reply shows genuine interest WITHOUT a meeting commitment, call `update_lead_stage({leadId, stage:'sales_intent'})` — which appends a `sales_intent_detected` timeline event. Record these immediately during the Auto loop; they are the metrics that prove Frondose works AND drive end_auto_run's final summary counts.";

/**
 * G-A14.11 — Manual fragment (soul.ts:169), locked byte-identical before Step 4.
 */
const LOCKED_MANUAL_FRAGMENT =
  "You are in MANUAL mode (operator-prompt-driven). Before any outbound communication step (DM, connection request with note, post, comment), call `save_message_draft` first (so the operator sees the draft at approval), then declare it in your todo plan with requiresApproval:true and mark it in_progress — the operator will approve before you proceed. Outcome tracking: when you read a reply with clear meeting acceptance (agreed date/time/call, \"let's meet\", \"I'd love to connect\", \"book it\"), call `update_lead_stage({leadId, stage:'meeting_booked'})` — this single call writes the stage AND appends the matching `meeting_booked` timeline event (do NOT also call `record_lead_event` for the same transition — it would double-count). Before drafting outbound for a lead, check whether the lead carries a duplicateOf signal — either from the current turn's promote_candidate_to_lead result OR from the latest promoted_to_lead entry in get_lead_context's timeline metadata (durable across turns). If present, surface the duplicate-likely flag to the operator (via suggest_card or a brief plain-text note) and pause for the operator's call BEFORE save_message_draft, since this lead may share a person with one already in flight. The lead row still exists; this is a soft signal, not a block. This is the north-star outcome. When a reply shows genuine interest WITHOUT a meeting commitment, call `update_lead_stage({leadId, stage:'sales_intent'})` — which appends a `sales_intent_detected` timeline event. Record these immediately; they are the metrics that prove Frondose works.";

/**
 * G-A14.12 — Magical fragment (soul.ts:167), locked byte-identical post-P-AUTO-15b.
 *
 * P-AUTO-15b MR-4 UPDATE (D-A15b.2 / G-A15b.9b, 2026-06-15):
 * The Magical fragment was intentionally changed by P-AUTO-15b to add the QS-5
 * evidenceJson reminder: "; for any totalScore ≥ 40, supply `evidenceJson` —
 * the JSON-stringified facts you cited — required, or score_lead rejects it"
 *
 * Justification: the soul band lacked headroom (~11 chars) for the 277-char reminder.
 * The Magical fragment is the correct home — it's the exact context where the agent
 * will call score_lead and need the evidenceJson reminder.
 *
 * The pre-P-AUTO-14 "byte-identical" invariant for magical is updated here to reflect
 * the new production literal. T-A14.12 now pins the POST-P-AUTO-15b magical fragment.
 */
const LOCKED_MAGICAL_FRAGMENT =
  "You are in MAGICAL mode (passive judgement). The operator browses LinkedIn manually; you observe in the background and record what you see. When a profile-view observation fires, your muscle memory is: record_raw_candidate (writes the observation to the sales kernel; returns a candidateId) → search_memory (any prior context on this person?) → qualify_profile (derives the ICP qualification from the visible role/industry/region/company) → score_lead (multi-dimensional score keyed by that candidateId; pass qualify_profile's qualification through; set confidence ≤ 0.4 for thin first-view evidence; for any totalScore ≥ 40, supply `evidenceJson` — the JSON-stringified facts you cited — required, or score_lead rejects it) → suggest_card only when totalScore ≥ 40 AND painHypothesis is non-empty (surfacing the judgement to the operator). When evidence is insufficient for a score, remember(kind:'at') the footprint and stop. You NEVER initiate outbound (connect/message/comment/follow) in Magical mode — outbound belongs to Manual or Auto, not Magical.";

// ─── Unique ordering anchors ──────────────────────────────────────────────────
// G-A14.13 uses THREE unique anchors for indexOf ordering:
//   (1) AFTER: "★ Inspect → see N people" — unique recap opener (not confused with any other ★ line)
//   (2) NEW:   "★ CONVERT THE BEST (per-turn funnel budget):" — the new directive marker
//   (3) BEFORE: "At the top of EVERY Auto turn:" — unique start_auto_run opener
// These avoid the P-AUTO-13 lesson: bare "FIRST" matched the wrong clause.

const ANCHOR_AFTER_RECAP = "★ Inspect → see N people";
const ANCHOR_CONVERT_THE_BEST = "★ CONVERT THE BEST (per-turn funnel budget):";
const ANCHOR_START_AUTO_RUN = "At the top of EVERY Auto turn:";

// ─── Test Suite ────────────────────────────────────────────────────────────────

describe("T-A14 — soulModeFragment('auto') per-turn funnel budget directive (P-AUTO-14)", () => {

  // ─── T-A14.1 ─────────────────────────────────────────────────────────────────
  it("T-A14.1: auto fragment contains '★ CONVERT THE BEST (per-turn funnel budget):' marker (G-A14.1)", () => {
    // Given: AUTO mode requested
    // When:  soulModeFragment("auto") returns the auto-mode prompt fragment
    // Then:  it contains "★ CONVERT THE BEST (per-turn funnel budget):" as the stable directive marker
    assert.ok(soulModeFragment !== undefined, "T-A14.1: soulModeFragment must be importable from soul.ts");
    const fragment = soulModeFragment!("auto");
    assert.ok(
      fragment.includes("★ CONVERT THE BEST (per-turn funnel budget):"),
      `T-A14.1 FAIL: directive marker absent. Fragment start (200): ${fragment.slice(0, 200)}`,
    );
  });

  // ─── T-A14.2 ─────────────────────────────────────────────────────────────────
  it("T-A14.2: auto fragment names 'promote_candidate_to_lead' → 'save_message_draft' as the durable chain (G-A14.2)", () => {
    // Given: AUTO mode
    // When:  the directive names the back-of-funnel two-step chain
    // Then:  promote_candidate_to_lead appears before save_message_draft, separated by → (in that order)
    assert.ok(soulModeFragment !== undefined, "T-A14.2: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");
    assert.ok(
      fragment.includes("promote_candidate_to_lead"),
      `T-A14.2 FAIL: 'promote_candidate_to_lead' absent`,
    );
    assert.ok(
      fragment.includes("save_message_draft"),
      `T-A14.2 FAIL: 'save_message_draft' absent`,
    );
    // The plan requires "promote_candidate_to_lead` → `save_message_draft" as a phrase in the directive
    assert.ok(
      fragment.includes("promote_candidate_to_lead` → `save_message_draft"),
      `T-A14.2 FAIL: 'promote_candidate_to_lead\` → \`save_message_draft' chain phrase absent. ` +
        `Fragment (first 600): ${fragment.slice(0, 600)}`,
    );
    // Additionally: promote must appear before draft (indexOf ordering)
    const promoteIdx = fragment.indexOf("promote_candidate_to_lead");
    const draftIdx = fragment.indexOf("save_message_draft");
    assert.ok(
      promoteIdx < draftIdx,
      `T-A14.2 FAIL: promote_candidate_to_lead (pos ${promoteIdx}) must appear before save_message_draft (pos ${draftIdx})`,
    );
  });

  // ─── T-A14.3 ─────────────────────────────────────────────────────────────────
  it("T-A14.3: auto fragment states 'ONE conversion per roster-turn' cap (G-A14.3)", () => {
    // Given: AUTO mode
    // When:  the cap clause is searched for in the fragment
    // Then:  "ONE conversion per roster-turn" is present (anti-capture-starvation cap sentence)
    assert.ok(soulModeFragment !== undefined, "T-A14.3: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");
    assert.ok(
      fragment.includes("ONE conversion per roster-turn"),
      `T-A14.3 FAIL: 'ONE conversion per roster-turn' absent. Fragment (first 600): ${fragment.slice(0, 600)}`,
    );
  });

  // ─── T-A14.4 ─────────────────────────────────────────────────────────────────
  it("T-A14.4: auto fragment names the P-AUTO-4 qualification floor (totalScore ≥ 40 AND nextAction !== 'disqualify') (G-A14.4)", () => {
    // Given: AUTO mode
    // When:  the qualification-floor citation is searched for
    // Then:  both "totalScore ≥ 40" AND "nextAction !== 'disqualify'" are present in the directive
    assert.ok(soulModeFragment !== undefined, "T-A14.4: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");
    assert.ok(
      fragment.includes("totalScore ≥ 40"),
      `T-A14.4 FAIL: 'totalScore ≥ 40' absent`,
    );
    assert.ok(
      fragment.includes("nextAction !== 'disqualify'"),
      `T-A14.4 FAIL: "nextAction !== 'disqualify'" absent`,
    );
  });

  // ─── T-A14.5 ─────────────────────────────────────────────────────────────────
  it("T-A14.5: auto fragment states draft is DURABLE and NOT subject to inter-outbound cooldown (G-A14.5)", () => {
    // Given: AUTO mode
    // When:  the cooldown-durability clause is searched for
    // Then:  both the primary sentence AND the negative restatement are present
    assert.ok(soulModeFragment !== undefined, "T-A14.5: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");
    assert.ok(
      fragment.includes("DRAFT creation is DURABLE funnel progress and is NOT subject to the inter-outbound cooldown"),
      `T-A14.5 FAIL: durable-draft primary sentence absent`,
    );
    assert.ok(
      fragment.includes("cooldown only blocks the outbound CLICK, not the persisted lead+draft rows"),
      `T-A14.5 FAIL: cooldown negative-restatement sentence absent`,
    );
  });

  // ─── T-A14.6 ─────────────────────────────────────────────────────────────────
  it("T-A14.6: auto fragment restates that the click still passes P-AUTO-9, P-AUTO-10, P-AUTO-13 gates (G-A14.6)", () => {
    // Given: AUTO mode
    // When:  the click-time non-bypass guarantee is searched for
    // Then:  all three gate references are present: P-AUTO-9 cap/cooldown gate, P-AUTO-10 duplicateOf gate, P-AUTO-13 failure-branch
    assert.ok(soulModeFragment !== undefined, "T-A14.6: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");
    assert.ok(
      fragment.includes("P-AUTO-9 cap/cooldown gate"),
      `T-A14.6 FAIL: 'P-AUTO-9 cap/cooldown gate' absent`,
    );
    assert.ok(
      fragment.includes("P-AUTO-10 duplicateOf gate"),
      `T-A14.6 FAIL: 'P-AUTO-10 duplicateOf gate' absent`,
    );
    assert.ok(
      fragment.includes("P-AUTO-13 failure-branch"),
      `T-A14.6 FAIL: 'P-AUTO-13 failure-branch' absent`,
    );
  });

  // ─── T-A14.7 ─────────────────────────────────────────────────────────────────
  it("T-A14.7: EXHAUSTIVE CAPTURE block is byte-identical to pre-P-AUTO-14 source (D-26/D-28 regression guard) (G-A14.7)", () => {
    // Given: AUTO mode, before and after the additive P-AUTO-14 insertion
    // When:  the locked EXHAUSTIVE CAPTURE substring is searched in the fragment
    // Then:  it is present byte-for-byte (the insertion must not modify this chunk)
    assert.ok(soulModeFragment !== undefined, "T-A14.7: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");
    assert.ok(
      fragment.includes(LOCKED_EXHAUSTIVE_CAPTURE),
      `T-A14.7 FAIL: EXHAUSTIVE CAPTURE block is NOT byte-identical to the pre-P-AUTO-14 source. ` +
        `Fragment (first 800): ${fragment.slice(0, 800)}`,
    );
  });

  // ─── T-A14.8 ─────────────────────────────────────────────────────────────────
  it("T-A14.8: 'Inspect → see N people' recap line is byte-identical to pre-P-AUTO-14 source (G-A14.8)", () => {
    // Given: AUTO mode, before and after the additive P-AUTO-14 insertion
    // When:  the locked recap substring is searched in the fragment
    // Then:  it is present byte-for-byte (this is the line immediately before the new directive)
    assert.ok(soulModeFragment !== undefined, "T-A14.8: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");
    assert.ok(
      fragment.includes(LOCKED_INSPECT_RECAP),
      `T-A14.8 FAIL: Inspect → see N people recap line is NOT byte-identical. ` +
        `Fragment (first 800): ${fragment.slice(0, 800)}`,
    );
  });

  // ─── T-A14.9 ─────────────────────────────────────────────────────────────────
  it("T-A14.9: start_auto_run + connectsRemaining + dailyOutbound + cooldown + duplicateOf clause is byte-identical (G-A14.9)", () => {
    // Given: AUTO mode, after the additive P-AUTO-14 insertion (this clause is AFTER the new directive)
    // When:  the locked P-AUTO-8/9 chunk is searched in the fragment
    // Then:  it is present byte-for-byte (additive insertion must not modify chunks after it)
    assert.ok(soulModeFragment !== undefined, "T-A14.9: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");
    assert.ok(
      fragment.includes(LOCKED_START_AUTO_RUN_CLAUSE),
      `T-A14.9 FAIL: start_auto_run/connectsRemaining/cooldown/duplicateOf clause is NOT byte-identical. ` +
        `Fragment length: ${fragment.length}. Anchor search: ${fragment.includes("At the top of EVERY Auto turn:")}`,
    );
  });

  // ─── T-A14.10 ────────────────────────────────────────────────────────────────
  it("T-A14.10: P-AUTO-13 failure-branch + STOP CONDITIONS + outcome-tracking clauses are byte-identical (G-A14.10)", () => {
    // Given: AUTO mode, after the additive P-AUTO-14 insertion (this clause is AFTER the new directive)
    // When:  the locked P-AUTO-13/STOP/outcome chunk is searched in the fragment
    // Then:  it is present byte-for-byte
    assert.ok(soulModeFragment !== undefined, "T-A14.10: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");
    assert.ok(
      fragment.includes(LOCKED_FAILURE_BRANCH_AND_STOP_CONDITIONS),
      `T-A14.10 FAIL: P-AUTO-13 failure-branch + STOP CONDITIONS + outcome-tracking clauses are NOT byte-identical. ` +
        `Fragment length: ${fragment.length}. Has 'STOP CONDITIONS': ${fragment.includes("STOP CONDITIONS")}`,
    );
  });

  // ─── T-A14.11 ────────────────────────────────────────────────────────────────
  it("T-A14.11: soulModeFragment('manual') is byte-identical to pre-P-AUTO-14 source (G-A14.11)", () => {
    // Given: MANUAL mode requested; the P-AUTO-14 change is AUTO-only
    // When:  soulModeFragment("manual") is called
    // Then:  the returned string is byte-for-byte the pre-P-AUTO-14 locked literal
    assert.ok(soulModeFragment !== undefined, "T-A14.11: soulModeFragment must be importable");
    const fragment = soulModeFragment!("manual");
    assert.strictEqual(
      fragment,
      LOCKED_MANUAL_FRAGMENT,
      `T-A14.11 FAIL: soulModeFragment('manual') is NOT byte-identical to pre-P-AUTO-14 source. ` +
        `Actual length: ${fragment.length}, expected length: ${LOCKED_MANUAL_FRAGMENT.length}`,
    );
  });

  // ─── T-A14.12 ────────────────────────────────────────────────────────────────
  it("T-A14.12: soulModeFragment('magical') is byte-identical to post-P-AUTO-15b locked literal (G-A14.12, D-A15b.2/G-A15b.9b update)", () => {
    // Given: MAGICAL mode requested
    // When:  soulModeFragment("magical") is called
    // Then:  the returned string is byte-for-byte the locked literal
    //        (updated from pre-P-AUTO-14 → post-P-AUTO-15b by D-A15b.2 / G-A15b.9b:
    //        P-AUTO-15b intentionally adds the QS-5 evidenceJson reminder to the Magical
    //        fragment; this guard now pins the NEW production form to catch future regressions)
    assert.ok(soulModeFragment !== undefined, "T-A14.12: soulModeFragment must be importable");
    const fragment = soulModeFragment!("magical");
    assert.strictEqual(
      fragment,
      LOCKED_MAGICAL_FRAGMENT,
      `T-A14.12 FAIL: soulModeFragment('magical') is NOT byte-identical to post-P-AUTO-15b locked literal. ` +
        `Actual length: ${fragment.length}, expected length: ${LOCKED_MAGICAL_FRAGMENT.length}`,
    );
  });

  // ─── T-A14.13 ────────────────────────────────────────────────────────────────
  it("T-A14.13: CONVERT THE BEST is positioned AFTER the recap AND BEFORE the start_auto_run opener (G-A14.13)", () => {
    // Given: AUTO mode after builder Step 4 inserts the new directive chunk
    // When:  indexOf positions of three UNIQUE anchors are compared
    // Then:  recapIdx < convertIdx < startAutoRunIdx (strict ordering)
    //
    // Anchors chosen to be unique and not over-match (P-AUTO-13 lesson: bare "FIRST" hit the wrong clause):
    //   ANCHOR_AFTER_RECAP    = "★ Inspect → see N people"    (unique recap opener, not any other ★ line)
    //   ANCHOR_CONVERT_THE_BEST = "★ CONVERT THE BEST (per-turn funnel budget):"  (new directive marker)
    //   ANCHOR_START_AUTO_RUN = "At the top of EVERY Auto turn:"   (unique start_auto_run opener)
    assert.ok(soulModeFragment !== undefined, "T-A14.13: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");

    const recapIdx = fragment.indexOf(ANCHOR_AFTER_RECAP);
    const convertIdx = fragment.indexOf(ANCHOR_CONVERT_THE_BEST);
    const startAutoRunIdx = fragment.indexOf(ANCHOR_START_AUTO_RUN);

    assert.ok(recapIdx !== -1, `T-A14.13 FAIL: ANCHOR_AFTER_RECAP '${ANCHOR_AFTER_RECAP}' not found in fragment`);
    assert.ok(convertIdx !== -1, `T-A14.13 FAIL: ANCHOR_CONVERT_THE_BEST '${ANCHOR_CONVERT_THE_BEST}' not found in fragment`);
    assert.ok(startAutoRunIdx !== -1, `T-A14.13 FAIL: ANCHOR_START_AUTO_RUN '${ANCHOR_START_AUTO_RUN}' not found in fragment`);

    assert.ok(
      recapIdx < convertIdx,
      `T-A14.13 FAIL: CONVERT THE BEST (pos ${convertIdx}) must appear AFTER recap (pos ${recapIdx})`,
    );
    assert.ok(
      convertIdx < startAutoRunIdx,
      `T-A14.13 FAIL: CONVERT THE BEST (pos ${convertIdx}) must appear BEFORE start_auto_run opener (pos ${startAutoRunIdx})`,
    );
  });

  // ─── T-A14.14 ────────────────────────────────────────────────────────────────
  it("T-A14.14: auto fragment still begins with 'You are in AUTO mode (cron-driven or operator hand-off).' declaration (G-A14.14)", () => {
    // Given: the cron consumer prepends soulModeFragment("auto") to every cron prompt
    // When:  soulModeFragment("auto") is called before and after the additive insertion
    // Then:  the fragment still starts with the AUTO-mode declaration (cron prompt structure intact)
    assert.ok(soulModeFragment !== undefined, "T-A14.14: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");
    assert.ok(
      fragment.startsWith("You are in AUTO mode (cron-driven or operator hand-off)."),
      `T-A14.14 FAIL: auto fragment does not start with the AUTO-mode declaration. ` +
        `Actual start (80 chars): ${fragment.slice(0, 80)}`,
    );
  });

});
