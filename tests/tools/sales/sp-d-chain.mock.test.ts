/**
 * P-SP-D Step 5 — T-SP-D.Chain.1, T-SP-D.Chain.2, T-SP-D.Chain.3, T-SP-D.Chain.4
 * (assertion bodies filled; tool-layer smoke test — no LLM, no Chrome)
 *
 * Chain integration tests for the P-SP-D Manual Conversation Sales Workflow.
 * All 4 tools tested are SHIPPED (P-SP-A + P-SP-B); P-SP-D adds no new tools.
 * These tests validate the TOOL LAYER chain semantics that the P-SP-D prompt
 * habits instruct the agent to follow — no LLM, no Chrome.
 *
 * Chain under test (full happy path, T-SP-D.Chain.1):
 *   record_raw_candidate → score_lead → promote_candidate_to_lead →
 *   save_message_draft → [workflow approval gate — skipped at tool layer] →
 *   mark_message_sent → update_lead_stage("connect_sent")
 *
 * FK pre-conditions under test (T-SP-D.Chain.2 + T-SP-D.Chain.3):
 *   Chain.2: save_message_draft BEFORE promote → fail("not_found") — leadId doesn't exist yet
 *   Chain.3: promote_candidate_to_lead with status='new' (unscored) → fail("invalid_input")
 *
 * Idempotency under test (T-SP-D.Chain.4):
 *   Chain.4: mark_message_sent twice → second call fails("invalid_input", /already sent/)
 *
 * Gates covered:
 *   G-PSPD.6 (T-SP-D.Chain.1) — Full chain happy path, correct timeline events end-to-end
 *   G-PSPD.7 (T-SP-D.Chain.2 + T-SP-D.Chain.3) — FK pre-conditions enforced
 *   G-PSPD.8 (T-SP-D.Chain.4) — Double-send idempotency
 *
 * NOTE: This is a TOOL SMOKE (not real-agent verification). The tool chain is called
 * directly (no LLM, no 3-band prompt). Per CLAUDE §10, it verifies the tool layer
 * works; the real-agent L2 gate (T-SP-D.Live.1) is required for agent-level verification.
 *
 * Run (mock only, DB /tmp path per test, no Chrome, no LLM):
 *   node --import tsx --test --test-force-exit \
 *     tests/tools/sales/sp-d-chain.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { closeSalesDatabase, openSalesDatabase } from "../../../src/persistence/salesDb.js";
import { makeMarkMessageSentTool } from "../../../src/tools/sales/markMessageSent.js";
import { makePromoteCandidateToLeadTool } from "../../../src/tools/sales/promoteCandidateToLead.js";
import { makeRecordRawCandidateTool } from "../../../src/tools/sales/recordRawCandidate.js";
import { makeSaveMessageDraftTool } from "../../../src/tools/sales/saveMessageDraft.js";
import { makeScoreLeadTool } from "../../../src/tools/sales/scoreLead.js";
import { makeUpdateLeadStageTool } from "../../../src/tools/sales/updateLeadStage.js";

/** Create a unique /tmp path per test so salesDb singletons don't bleed. */
function tmpPath(): string {
  return `/tmp/sp-d-chain-${randomUUID()}.sqlite`;
}

/** Minimal Vercel tool execute options. */
const toolOpts = { messages: [] as never[], toolCallId: "test" };

/**
 * P-AUTO-15b MR-2+MR-3 (Step 3, 2026-06-15): temp-HOME isolation helper.
 * The new QS-7.a evidence gate in promoteCandidateToLead reads readIdentity()
 * from the operator's actual config.json, making tests non-deterministic if the
 * operator has a targetRole ICP configured. This helper seeds a no-ICP identity
 * so the QS-7.a gate skips (mirrors tests/tools/methodology/qualifyProfile.mock.test.ts:40-44).
 */
function setupNoIcpHome(): { restore: () => void } {
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-spd-chain-home-"));
  const origHome = process.env.HOME;
  const origHomeBase = process.env.FRONDOSE_HOME_BASE;
  process.env.HOME = tmpHome;
  process.env.FRONDOSE_HOME_BASE = tmpHome;
  mkdirSync(join(tmpHome, ".frondose", "agent"), { recursive: true });
  writeFileSync(
    join(tmpHome, ".frondose", "agent", "config.json"),
    JSON.stringify({ identity: { fullName: "Test BD", role: "BD", icp: { targetRole: [] } }, updatedAt: new Date().toISOString() }),
  );
  return {
    restore: () => {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
      if (origHomeBase !== undefined) process.env.FRONDOSE_HOME_BASE = origHomeBase;
      else delete process.env.FRONDOSE_HOME_BASE;
      rmSync(tmpHome, { recursive: true, force: true });
    },
  };
}

describe("T-SP-D.Chain — full outbound chain integration (P-SP-D §4.3)", () => {
  // ─── T-SP-D.Chain.1 ──────────────────────────────────────────────────────────

  it("T-SP-D.Chain.1: full happy-path chain end-to-end (no LLM): record_raw_candidate → score_lead → promote_candidate_to_lead → save_message_draft → mark_message_sent → update_lead_stage('connect_sent') produces timeline events [discovered, scored, promoted_to_lead, message_sent, connect_sent] and draft.status='sent' and lead.stage='connect_sent'", async () => {
    // Given: fresh sales.sqlite at a unique /tmp path; all 6 tools instantiated
    // When:  the full chain is executed sequentially (tool-layer direct calls, no LLM)
    // Then:  lead_timeline has discovered, scored, promoted_to_lead, message_sent, connect_sent (in order);
    //        message_drafts.status='sent'; leads.stage='connect_sent'

    // P-AUTO-15b MR-2+MR-3 (Step 3, 2026-06-15): isolate readIdentity() to no-ICP config so
    // QS-7.a gate skips (evidence gate only fires when ICP targetRole is configured).
    // Also supply evidenceJson on score_lead (QS-5 requires it for totalScore>=40)
    // and evidenceSummary on record_raw_candidate (so QS-7.a gate has signal if ICP were present).
    const { restore: restoreChain1Home } = setupNoIcpHome();
    const path = tmpPath();
    const db = openSalesDatabase(path);
    try {
      // ── Step 1: record_raw_candidate ─────────────────────────────────────────
      const recResult = (await makeRecordRawCandidateTool(path).execute(
        {
          personName: "Alice Example",
          profileUrl: "https://www.linkedin.com/in/alice-example/",
          source: "profile-nav",
          bypassIdentityCheck: true, // no session in chain test
          evidenceSummary: "VP Sales at Acme — scaling outbound", // P-AUTO-15b: supply evidence for QS-7.a
        },
        toolOpts,
      )) as { ok: boolean; data: { candidateId: string } };
      assert.ok(recResult.ok, `record_raw_candidate must succeed (got: ${JSON.stringify(recResult)})`);
      const { candidateId } = recResult.data;

      // ── Step 2: score_lead ───────────────────────────────────────────────────
      const scoreResult = (await makeScoreLeadTool(path).execute(
        {
          candidateId,
          // P-AUTO-5: qualification required; totalScore:75 is in qualified band [60,100]
          qualification: "qualified",
          totalScore: 75,
          confidence: 0.6,
          icpFit: "Strong",
          painHypothesis: "Scaling outbound without headcount",
          nextAction: "connect_now",
          methodUsed: "pain_chain",
          // P-AUTO-15b MR-2: add evidenceJson — QS-5 gate requires it for totalScore>=40
          evidenceJson: '{"role":"VP Sales","icpFit":"Strong","source":"chain1-fixture"}',
        },
        toolOpts,
      )) as { ok: boolean };
      assert.ok(scoreResult.ok, `score_lead must succeed (got: ${JSON.stringify(scoreResult)})`);

      // ── Step 3: promote_candidate_to_lead ────────────────────────────────────
      const promoteResult = (await makePromoteCandidateToLeadTool(path).execute({ candidateId }, toolOpts)) as {
        ok: boolean;
        data: { leadId: string };
      };
      assert.ok(promoteResult.ok, `promote_candidate_to_lead must succeed (got: ${JSON.stringify(promoteResult)})`);
      const { leadId } = promoteResult.data;

      // ── Step 4: save_message_draft ───────────────────────────────────────────
      const draftResult = (await makeSaveMessageDraftTool(path).execute(
        {
          leadId,
          kind: "connect_note",
          text: "Hi Alice, I noticed your work at Acme and would love to connect about scaling outbound.",
        },
        toolOpts,
      )) as { ok: boolean; data: { draftId: string } };
      assert.ok(draftResult.ok, `save_message_draft must succeed (got: ${JSON.stringify(draftResult)})`);
      const { draftId } = draftResult.data;

      // [Approval gate would fire here in the real agent loop — skipped at tool layer]

      // ── Step 5: mark_message_sent ────────────────────────────────────────────
      const sentResult = (await makeMarkMessageSentTool(path).execute({ draftId }, toolOpts)) as { ok: boolean };
      assert.ok(sentResult.ok, `mark_message_sent must succeed (got: ${JSON.stringify(sentResult)})`);

      // ── Step 6: update_lead_stage ────────────────────────────────────────────
      const stageResult = (await makeUpdateLeadStageTool(path).execute(
        { leadId, stage: "connect_sent" },
        toolOpts,
      )) as {
        ok: boolean;
      };
      assert.ok(stageResult.ok, `update_lead_stage must succeed (got: ${JSON.stringify(stageResult)})`);

      // ── Timeline assertions (G-PSPD.6) ──────────────────────────────────────
      // Query by candidate_id to capture all 5 events; sort by rowid (insertion order)
      const rows = db
        .prepare("SELECT event_type FROM lead_timeline WHERE candidate_id = ? ORDER BY rowid ASC")
        .all(candidateId) as { event_type: string }[];
      const eventTypes = rows.map((r) => r.event_type);
      assert.deepEqual(
        eventTypes,
        ["discovered", "scored", "promoted_to_lead", "message_sent", "connect_sent"],
        `lead_timeline must have exactly 5 events in order: discovered, scored, promoted_to_lead, message_sent, connect_sent (got: ${JSON.stringify(eventTypes)})`,
      );

      // ── Draft status assertion ───────────────────────────────────────────────
      const draftRow = db.prepare("SELECT status FROM message_drafts WHERE id = ?").get(draftId) as
        | { status: string }
        | undefined;
      assert.equal(draftRow?.status, "sent", "message_drafts.status must be 'sent' after mark_message_sent (G-PSPD.6)");

      // ── Lead stage assertion ─────────────────────────────────────────────────
      const leadRow = db.prepare("SELECT stage FROM leads WHERE id = ?").get(leadId) as { stage: string } | undefined;
      assert.equal(
        leadRow?.stage,
        "connect_sent",
        "leads.stage must be 'connect_sent' after update_lead_stage (G-PSPD.6)",
      );
    } finally {
      restoreChain1Home(); // P-AUTO-15b MR-3: restore HOME after Chain.1
      closeSalesDatabase(path);
    }
  });

  // ─── T-SP-D.Chain.2 ──────────────────────────────────────────────────────────

  it("T-SP-D.Chain.2: when save_message_draft is called with a candidateId instead of a leadId (before promote_candidate_to_lead), it returns fail('not_found') — the FK pre-condition is enforced", async () => {
    // Given: a raw_candidates row exists (not yet promoted → no leads row yet)
    //        The candidateId is a UUID that does NOT appear as a leads.id
    // When:  save_message_draft({leadId: <candidateId>, kind:"connect_note", text:"hi"}) is called
    // Then:  returns {ok:false, error:{kind:"not_found", message: /No lead with id/}}

    const path = tmpPath();
    const db = openSalesDatabase(path);
    try {
      // Seed a raw candidate (status='new' — not promoted, no leads row exists)
      const recResult = (await makeRecordRawCandidateTool(path).execute(
        {
          personName: "Bob Fixture",
          profileUrl: "https://www.linkedin.com/in/bob-fixture/",
          source: "search",
        },
        toolOpts,
      )) as { ok: boolean; data: { candidateId: string } };
      assert.ok(recResult.ok, "record_raw_candidate setup must succeed");
      const { candidateId } = recResult.data;

      // Attempt to call save_message_draft with candidateId as leadId (wrong — no lead exists)
      const draftResult = (await makeSaveMessageDraftTool(path).execute(
        {
          leadId: candidateId, // intentionally wrong: using candidateId as leadId
          kind: "connect_note",
          text: "This should fail — no lead row exists yet.",
        },
        toolOpts,
      )) as { ok: boolean; error?: { kind: string; message: string } };

      // Must fail with not_found — candidateId is not a leadId
      assert.equal(
        draftResult.ok,
        false,
        "save_message_draft must fail when leadId does not exist in leads table (G-PSPD.7)",
      );
      assert.equal(draftResult.error?.kind, "not_found", "error.kind must be 'not_found' (G-PSPD.7 FK pre-condition)");
      assert.match(
        draftResult.error?.message ?? "",
        /No lead with id/,
        "error.message must match /No lead with id/ (per saveMessageDraft.ts:32, G-PSPD.7)",
      );

      // DB sanity: no draft rows created
      const draftCount = (db.prepare("SELECT COUNT(*) AS n FROM message_drafts").get() as { n: number }).n;
      assert.equal(draftCount, 0, "no message_drafts rows must be created when save_message_draft fails (G-PSPD.7)");
    } finally {
      closeSalesDatabase(path);
    }
  });

  // ─── T-SP-D.Chain.3 ──────────────────────────────────────────────────────────

  it("T-SP-D.Chain.3: when promote_candidate_to_lead is called on a candidate with status='new' (not yet scored), it returns fail('invalid_input') with /must be 'scored'/ message", async () => {
    // Given: a raw_candidates row with status='new' (freshly inserted, not scored)
    // When:  promote_candidate_to_lead({candidateId}) is called
    // Then:  returns {ok:false, error:{kind:"invalid_input", message: /must be 'scored'/}}

    const path = tmpPath();
    openSalesDatabase(path);
    try {
      // Seed a raw candidate with status='new' (default after record_raw_candidate)
      const recResult = (await makeRecordRawCandidateTool(path).execute(
        {
          personName: "Carol Fixture",
          profileUrl: "https://www.linkedin.com/in/carol-fixture/",
          source: "feed",
        },
        toolOpts,
      )) as { ok: boolean; data: { candidateId: string } };
      assert.ok(recResult.ok, "record_raw_candidate setup must succeed");
      const { candidateId } = recResult.data;
      // Note: status is 'new' after record_raw_candidate (score_lead NOT called)

      // Attempt to promote without scoring first (violates the chain order)
      const promoteResult = (await makePromoteCandidateToLeadTool(path).execute({ candidateId }, toolOpts)) as {
        ok: boolean;
        error?: { kind: string; message: string };
      };

      // Must fail with invalid_input — candidate must be scored first
      assert.equal(
        promoteResult.ok,
        false,
        "promote_candidate_to_lead must fail for unscored candidate (G-PSPD.7 score-before-promote)",
      );
      assert.equal(
        promoteResult.error?.kind,
        "invalid_input",
        "error.kind must be 'invalid_input' (G-PSPD.7 score-before-promote)",
      );
      assert.match(
        promoteResult.error?.message ?? "",
        /must be 'scored'/,
        "error.message must match /must be 'scored'/ (per promoteCandidateToLead.ts:44, G-PSPD.7)",
      );
    } finally {
      closeSalesDatabase(path);
    }
  });

  // ─── T-SP-D.Chain.4 ──────────────────────────────────────────────────────────

  it("T-SP-D.Chain.4: when mark_message_sent is called on an already-sent draft, it returns fail('invalid_input') with /already sent/ message — double-send protection", async () => {
    // Given: a complete fixture with a message_drafts row already in status='sent'
    //        (first call to mark_message_sent succeeded)
    // When:  mark_message_sent({draftId}) is called a second time with the same draftId
    // Then:  returns {ok:false, error:{kind:"invalid_input", message: /already sent/}}

    // P-AUTO-15b MR-2+MR-3 (Step 3, 2026-06-15): isolate readIdentity() to no-ICP config
    // so QS-7.a gate skips. Add evidenceJson (QS-5) and evidenceSummary (QS-7.a) to fixture.
    const { restore: restoreChain4Home } = setupNoIcpHome();
    const path = tmpPath();
    openSalesDatabase(path);
    try {
      // Build the fixture: record → score → promote → save_draft → mark_sent (first call)
      const recResult = (await makeRecordRawCandidateTool(path).execute(
        {
          personName: "Dave Fixture",
          profileUrl: "https://www.linkedin.com/in/dave-fixture/",
          source: "search",
          bypassIdentityCheck: true,
          evidenceSummary: "VP Sales at TestCo — chain4 fixture", // P-AUTO-15b: supply evidence
        },
        toolOpts,
      )) as { ok: boolean; data: { candidateId: string } };
      assert.ok(recResult.ok, "record_raw_candidate setup must succeed");
      const { candidateId } = recResult.data;

      await makeScoreLeadTool(path).execute(
        // P-AUTO-5: qualification required; totalScore:70 is in qualified band [60,100]
        // P-AUTO-15b MR-2: add evidenceJson — QS-5 gate requires it for totalScore>=40
        { candidateId, qualification: "qualified", totalScore: 70, confidence: 0.6, nextAction: "connect_now", evidenceJson: '{"role":"VP Sales","source":"chain4-fixture"}' },
        toolOpts,
      );

      const promoteResult = (await makePromoteCandidateToLeadTool(path).execute({ candidateId }, toolOpts)) as {
        ok: boolean;
        data: { leadId: string };
      };
      assert.ok(promoteResult.ok, "promote_candidate_to_lead setup must succeed");
      const { leadId } = promoteResult.data;

      const draftResult = (await makeSaveMessageDraftTool(path).execute(
        { leadId, kind: "connect_note", text: "Hi Dave, connecting!" },
        toolOpts,
      )) as { ok: boolean; data: { draftId: string } };
      assert.ok(draftResult.ok, "save_message_draft setup must succeed");
      const { draftId } = draftResult.data;

      // First mark_message_sent — must succeed
      const firstSent = (await makeMarkMessageSentTool(path).execute({ draftId }, toolOpts)) as { ok: boolean };
      assert.ok(firstSent.ok, "first mark_message_sent must succeed");

      // Second mark_message_sent — must fail (double-send guard)
      const secondSent = (await makeMarkMessageSentTool(path).execute({ draftId }, toolOpts)) as {
        ok: boolean;
        error?: { kind: string; message: string };
      };
      assert.equal(
        secondSent.ok,
        false,
        "second mark_message_sent on already-sent draft must fail (G-PSPD.8 double-send protection)",
      );
      assert.equal(
        secondSent.error?.kind,
        "invalid_input",
        "error.kind must be 'invalid_input' (G-PSPD.8 double-send protection)",
      );
      assert.match(
        secondSent.error?.message ?? "",
        /already sent/,
        "error.message must match /already sent/ (per markMessageSent.ts:25, G-PSPD.8)",
      );
    } finally {
      restoreChain4Home(); // P-AUTO-15b MR-3: restore HOME after Chain.4
      closeSalesDatabase(path);
    }
  });
});
