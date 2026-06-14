/**
 * P-AUTO-10 Step 3 scaffold — T-Dup.1..13
 *
 * Person-identity soft dedup at promote (MED M3).
 * Drives the REAL promote tool against a temp in-process sales DB.
 * All assertion bodies are TODO — tests intentionally fail at Step 3.
 * Builder (Step 4) makes scaffolds compile + reach assertion-TODO branches.
 * Validator (Step 5) fills assertion bodies + adds edge-cases.
 *
 * Run (mock — no CDP, no LLM):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/tools/sales/promoteCandidateToLead-pAuto10.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

// NOTE: normalizePersonName + getActiveLeadNames do NOT exist until builder Step 4.
// The dynamic imports inside async test bodies allow this file to compile at Step 3.
// At runtime the imports resolve once Step 4 ships the exports; until then tests
// reach the import and throw (intended red state — scaffolds intentionally fail).

// biome-ignore lint/suspicious/noExplicitAny: pre-builder stub — DB type not yet exported
type AnyDB = any;

// ─── DB + fixture helpers ─────────────────────────────────────────────────────

/**
 * Open a fresh isolated sales DB at a unique temp path.
 * Returns both the DB handle AND the path string, because:
 *   - the DB handle is used for direct SQL seeding in the test,
 *   - the path string is passed to makePromoteCandidateToLeadTool so it
 *     hits the same cached openSalesDatabase handle (keyed by path).
 */
async function openDb(): Promise<{ db: AnyDB; dbPath: string }> {
  const { openSalesDatabase } = (await import("../../../src/persistence/salesDb.js")) as {
    openSalesDatabase: (path: string) => AnyDB;
  };
  const dbPath = join(tmpdir(), `auto10-${randomUUID()}.sqlite`);
  const db = openSalesDatabase(dbPath);
  return { db, dbPath };
}

/**
 * Seed a raw_candidates row with status='scored' and a corresponding
 * lead_scores row with totalScore=80 (>= PROMOTE_FLOOR=40) so that
 * promote_candidate_to_lead reaches the dedup tail.
 * Returns candidateId.
 */
function seedScoredCandidate(
  db: AnyDB,
  opts: { personName?: string; profileUrl?: string; accountId?: string | null },
): string {
  const candidateId = randomUUID();
  const scoreId = randomUUID();
  const now = Date.now();
  const profileUrl =
    opts.profileUrl ??
    `https://www.linkedin.com/in/auto10-${candidateId.slice(0, 8)}/`;

  db.prepare(`
    INSERT INTO raw_candidates
      (id, person_name, profile_url, account_id, source, observed_at, last_seen_at, status, evidence_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId,
    opts.personName ?? "Test Person",
    profileUrl,
    opts.accountId ?? null,
    "profile-nav",
    now,
    now,
    "scored",
    "VP Sales at TestCo",
  );

  db.prepare(`
    INSERT INTO lead_scores
      (id, candidate_id, lead_id, total_score, icp_fit, pain_hypothesis,
       buying_trigger, authority_level, suggested_opening_line, confidence,
       next_action, evidence_json, method_used, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scoreId,
    candidateId,
    null,
    80, // >= PROMOTE_FLOOR (40)
    "Strong",
    "Sales pain hypothesis",
    "Hiring surge",
    "VP",
    null,
    0.85,
    "Connect and intro",
    JSON.stringify({ source: "profile-inspect" }),
    "Pain Chain",
    "deepseek",
    now,
  );

  return candidateId;
}

/**
 * Seed an existing leads row directly (representing a person already in pipeline)
 * WITHOUT going through the promote tool. Also seeds the required raw_candidates
 * FK row. Returns leadId.
 */
function seedExistingLead(
  db: AnyDB,
  opts: {
    personName: string;
    stage?: string;
    accountId?: string | null;
  },
): string {
  const leadId = randomUUID();
  const candidateId = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO raw_candidates
      (id, person_name, profile_url, account_id, source, observed_at, last_seen_at, status, evidence_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId,
    opts.personName,
    `https://www.linkedin.com/in/existing-${leadId.slice(0, 8)}/`,
    opts.accountId ?? null,
    "profile-nav",
    now,
    now,
    "promoted",
    "existing fixture",
  );

  db.prepare(`
    INSERT INTO leads
      (id, candidate_id, account_id, person_name, profile_url, stage,
       total_score, confidence, one_line_pain_chain, next_action,
       next_action_due_at, owner_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    leadId,
    candidateId,
    opts.accountId ?? null,
    opts.personName,
    `https://www.linkedin.com/in/existing-${leadId.slice(0, 8)}/`,
    opts.stage ?? "qualified",
    80,
    0.85,
    "Pain chain",
    null,
    null,
    "manual",
    now,
    now,
  );

  return leadId;
}

// ─── describe block ───────────────────────────────────────────────────────────

describe("T-Dup — promote_candidate_to_lead soft dedup at promote (P-AUTO-10)", () => {

  // ─── T-Dup.1 ─────────────────────────────────────────────────────────────────
  it("T-Dup.1: when slug-variant same-name lead exists, promote fires duplicateOf AND lead is still created", async () => {
    // Given: existing lead {id: leadA, person_name: "Dmitry Balanovsky", stage: "qualified"};
    //        scored candidate {person_name: "Dmitry Balanovsky", profile_url: different slug};
    //        bypassPersonaCheck:true + score >= 40 so promote reaches the tail.
    // When:  promote_candidate_to_lead({candidateId, ownerMode:"manual", bypassPersonaCheck:true})
    // Then:  envelope ok with data.duplicateOf=[leadA], data.requiresOperatorConfirm=true,
    //        data.weakMatch=false; data.alreadyPromoted=false; NEW lead row EXISTS; leadA unchanged.
    const { db, dbPath } = await openDb();
    const leadA = seedExistingLead(db, { personName: "Dmitry Balanovsky" });
    const candB = seedScoredCandidate(db, {
      personName: "Dmitry Balanovsky",
      profileUrl: "https://www.linkedin.com/in/dmitry-balanovsky-bbb6b97a/",
    });

    const { makePromoteCandidateToLeadTool } = (await import(
      "../../../src/tools/sales/promoteCandidateToLead.js"
    )) as { makePromoteCandidateToLeadTool: (path: string) => { execute: unknown } };

    const tool = makePromoteCandidateToLeadTool(dbPath);
    const result = await (tool.execute as Function)({
      candidateId: candB,
      ownerMode: "manual",
      bypassPersonaCheck: true,
    });

    // TODO (Step 5): fill all assertions
    assert.ok(result.ok, "TODO: promote must succeed (ok:true)");
    assert.strictEqual(result.data.alreadyPromoted, false, "TODO: alreadyPromoted must be false");
    assert.ok(Array.isArray(result.data.duplicateOf), "TODO: duplicateOf must be an array");
    assert.ok(result.data.duplicateOf.includes(leadA), "TODO: duplicateOf must include leadA");
    assert.strictEqual(result.data.requiresOperatorConfirm, true, "TODO: requiresOperatorConfirm must be true");
    assert.strictEqual(result.data.weakMatch, false, "TODO: weakMatch must be false (2-token name)");
    // New lead row must exist
    const newLead = db.prepare("SELECT id FROM leads WHERE id = ?").get(result.data.leadId);
    assert.ok(newLead, "TODO: new lead row must exist in DB");
    // leadA must be unchanged
    const leadARow = db.prepare("SELECT id FROM leads WHERE id = ?").get(leadA);
    assert.ok(leadARow, "TODO: leadA must remain in DB");
  });

  // ─── T-Dup.2 ─────────────────────────────────────────────────────────────────
  it("T-Dup.2: when 2 existing 'Marcus Jiang' leads exist, duplicateOf carries both ids (order-independent)", async () => {
    // Given: two existing leads {id: marcusA, person_name: "Marcus Jiang"} +
    //        {id: marcusB, person_name: "Marcus Jiang"} (both non-disqualified);
    //        a scored candidate {person_name: "Marcus Jiang"}.
    // When:  promote candidate (bypassPersonaCheck:true, score>=40)
    // Then:  data.duplicateOf has length 2, contains both marcusA + marcusB (sorted compare);
    //        data.requiresOperatorConfirm=true; new lead IS created.
    const { db, dbPath } = await openDb();
    const marcusA = seedExistingLead(db, { personName: "Marcus Jiang" });
    const marcusB = seedExistingLead(db, { personName: "Marcus Jiang" });
    const candC = seedScoredCandidate(db, { personName: "Marcus Jiang" });

    const { makePromoteCandidateToLeadTool } = (await import(
      "../../../src/tools/sales/promoteCandidateToLead.js"
    )) as { makePromoteCandidateToLeadTool: (path: string) => { execute: unknown } };

    const tool = makePromoteCandidateToLeadTool(dbPath);
    const result = await (tool.execute as Function)({
      candidateId: candC,
      ownerMode: "manual",
      bypassPersonaCheck: true,
    });

    // TODO (Step 5): fill assertions
    assert.ok(result.ok, "TODO: must succeed");
    assert.ok(Array.isArray(result.data.duplicateOf), "TODO: duplicateOf must be an array");
    assert.strictEqual(result.data.duplicateOf.length, 2, "TODO: must contain both existing lead ids");
    const sorted = [...result.data.duplicateOf].sort();
    const expected = [marcusA, marcusB].sort();
    assert.deepStrictEqual(sorted, expected, "TODO: duplicateOf must include marcusA and marcusB");
    assert.strictEqual(result.data.requiresOperatorConfirm, true, "TODO: requiresOperatorConfirm must be true");
    const newLead = db.prepare("SELECT id FROM leads WHERE id = ?").get(result.data.leadId);
    assert.ok(newLead, "TODO: new lead row must be created");
  });

  // ─── T-Dup.3 ─────────────────────────────────────────────────────────────────
  it("T-Dup.3a: credential tail 'Dmitry Balanovsky, PhD' normalizes to match existing 'Dmitry Balanovsky' lead", async () => {
    // Given: existing lead {person_name: "Dmitry Balanovsky"};
    //        candidate {person_name: "Dmitry Balanovsky, PhD"}.
    // When:  promote (bypassPersonaCheck:true)
    // Then:  duplicateOf non-empty (strip chain removes ", PhD" on the candidate side).
    const { db, dbPath } = await openDb();
    const leadA = seedExistingLead(db, { personName: "Dmitry Balanovsky" });
    const cand = seedScoredCandidate(db, { personName: "Dmitry Balanovsky, PhD" });

    const { makePromoteCandidateToLeadTool } = (await import(
      "../../../src/tools/sales/promoteCandidateToLead.js"
    )) as { makePromoteCandidateToLeadTool: (path: string) => { execute: unknown } };

    const tool = makePromoteCandidateToLeadTool(dbPath);
    const result = await (tool.execute as Function)({
      candidateId: cand,
      ownerMode: "manual",
      bypassPersonaCheck: true,
    });

    // TODO (Step 5): fill assertions
    assert.ok(result.ok, "TODO: must succeed");
    assert.ok(
      Array.isArray(result.data.duplicateOf) && result.data.duplicateOf.includes(leadA),
      "TODO: PhD tail must normalize to same token set — duplicateOf must fire",
    );
    const newLead = db.prepare("SELECT id FROM leads WHERE id = ?").get(result.data.leadId);
    assert.ok(newLead, "TODO: lead must still be created");
  });

  it("T-Dup.3b: emoji tail 'Dmitry Balanovsky 🎯' normalizes to match existing 'Dmitry Balanovsky' lead", async () => {
    // Given: existing lead {person_name: "Dmitry Balanovsky"};
    //        candidate {person_name: "Dmitry Balanovsky 🎯"}.
    // When:  promote (bypassPersonaCheck:true)
    // Then:  duplicateOf non-empty (emoji stripped by glyph-strip step).
    const { db, dbPath } = await openDb();
    const leadA = seedExistingLead(db, { personName: "Dmitry Balanovsky" });
    const cand = seedScoredCandidate(db, { personName: "Dmitry Balanovsky 🎯" });

    const { makePromoteCandidateToLeadTool } = (await import(
      "../../../src/tools/sales/promoteCandidateToLead.js"
    )) as { makePromoteCandidateToLeadTool: (path: string) => { execute: unknown } };

    const tool = makePromoteCandidateToLeadTool(dbPath);
    const result = await (tool.execute as Function)({
      candidateId: cand,
      ownerMode: "manual",
      bypassPersonaCheck: true,
    });

    // TODO (Step 5): fill assertions
    assert.ok(result.ok, "TODO: must succeed");
    assert.ok(
      Array.isArray(result.data.duplicateOf) && result.data.duplicateOf.includes(leadA),
      "TODO: emoji tail must be stripped — duplicateOf must fire",
    );
  });

  it("T-Dup.3c: degree token 'Dmitry Balanovsky 1st' normalizes to match existing 'Dmitry Balanovsky' lead", async () => {
    // Given: existing lead {person_name: "Dmitry Balanovsky"};
    //        candidate {person_name: "Dmitry Balanovsky 1st"}.
    // When:  promote (bypassPersonaCheck:true)
    // Then:  duplicateOf non-empty (end-anchored degree token stripped).
    const { db, dbPath } = await openDb();
    const leadA = seedExistingLead(db, { personName: "Dmitry Balanovsky" });
    const cand = seedScoredCandidate(db, { personName: "Dmitry Balanovsky 1st" });

    const { makePromoteCandidateToLeadTool } = (await import(
      "../../../src/tools/sales/promoteCandidateToLead.js"
    )) as { makePromoteCandidateToLeadTool: (path: string) => { execute: unknown } };

    const tool = makePromoteCandidateToLeadTool(dbPath);
    const result = await (tool.execute as Function)({
      candidateId: cand,
      ownerMode: "manual",
      bypassPersonaCheck: true,
    });

    // TODO (Step 5): fill assertions
    assert.ok(result.ok, "TODO: must succeed");
    assert.ok(
      Array.isArray(result.data.duplicateOf) && result.data.duplicateOf.includes(leadA),
      "TODO: 1st degree token must be stripped — duplicateOf must fire",
    );
  });

  // ─── T-Dup.4 ─────────────────────────────────────────────────────────────────
  it("T-Dup.4: middle-name superset 'Marcus Wei Jiang' does NOT fire against 'Marcus Jiang' (set-equality pins)", async () => {
    // Given: existing lead {person_name: "Marcus Jiang"} (2 tokens);
    //        candidate {person_name: "Marcus Wei Jiang"} (3 tokens).
    // When:  promote (bypassPersonaCheck:true)
    // Then:  envelope = bare {leadId, candidateId, alreadyPromoted:false} — NO duplicateOf key.
    //        tokenSetEqual rejects on size mismatch (2 != 3).
    const { db, dbPath } = await openDb();
    seedExistingLead(db, { personName: "Marcus Jiang" });
    const cand = seedScoredCandidate(db, { personName: "Marcus Wei Jiang" });

    const { makePromoteCandidateToLeadTool } = (await import(
      "../../../src/tools/sales/promoteCandidateToLead.js"
    )) as { makePromoteCandidateToLeadTool: (path: string) => { execute: unknown } };

    const tool = makePromoteCandidateToLeadTool(dbPath);
    const result = await (tool.execute as Function)({
      candidateId: cand,
      ownerMode: "manual",
      bypassPersonaCheck: true,
    });

    // TODO (Step 5): fill assertions
    assert.ok(result.ok, "TODO: must succeed");
    assert.strictEqual(result.data.alreadyPromoted, false, "TODO: alreadyPromoted must be false");
    assert.strictEqual(result.data.duplicateOf, undefined, "TODO: duplicateOf must be ABSENT on size-mismatch");
    assert.strictEqual(result.data.requiresOperatorConfirm, undefined, "TODO: requiresOperatorConfirm must be ABSENT");
    assert.strictEqual(result.data.weakMatch, undefined, "TODO: weakMatch must be ABSENT");
  });

  // ─── T-Dup.5 ─────────────────────────────────────────────────────────────────
  it("T-Dup.5: common 2-token collision 'Wei Chen' DOES fire AND lead is still created (accepted FP, never blocks)", async () => {
    // Given: existing lead {person_name: "Wei Chen"} (original);
    //        a GENUINELY different "Wei Chen" candidate.
    // When:  promote (bypassPersonaCheck:true)
    // Then:  duplicateOf non-empty (common-name collision is the accepted soft cost) AND
    //        new lead IS created (data.alreadyPromoted=false). Both conditions must hold.
    const { db, dbPath } = await openDb();
    const existingId = seedExistingLead(db, { personName: "Wei Chen" });
    const cand = seedScoredCandidate(db, { personName: "Wei Chen" });

    const { makePromoteCandidateToLeadTool } = (await import(
      "../../../src/tools/sales/promoteCandidateToLead.js"
    )) as { makePromoteCandidateToLeadTool: (path: string) => { execute: unknown } };

    const tool = makePromoteCandidateToLeadTool(dbPath);
    const result = await (tool.execute as Function)({
      candidateId: cand,
      ownerMode: "manual",
      bypassPersonaCheck: true,
    });

    // TODO (Step 5): fill assertions
    assert.ok(result.ok, "TODO: must succeed");
    assert.ok(
      Array.isArray(result.data.duplicateOf) && result.data.duplicateOf.length > 0,
      "TODO: common-name collision must fire (soft signal, not block)",
    );
    assert.ok(result.data.duplicateOf.includes(existingId), "TODO: duplicateOf must include existingId");
    assert.strictEqual(result.data.alreadyPromoted, false, "TODO: alreadyPromoted must be false (NOT blocked)");
    const newLead = db.prepare("SELECT id FROM leads WHERE id = ?").get(result.data.leadId);
    assert.ok(newLead, "TODO: new lead must exist (create-and-flag, never suppress)");
  });

  // ─── T-Dup.6 ─────────────────────────────────────────────────────────────────
  it("T-Dup.6: mononym 'Cher' emits duplicateOf with weakMatch:true (single-token = low-confidence flag)", async () => {
    // Given: existing lead {person_name: "Cher"} (1 token);
    //        candidate {person_name: "Cher"}.
    // When:  promote (bypassPersonaCheck:true)
    // Then:  duplicateOf non-empty AND weakMatch===true (candSet.size < 2 → low confidence).
    //        Signal is still EMITTED (never dropped) — consistent with the never-suppress mandate.
    const { db, dbPath } = await openDb();
    seedExistingLead(db, { personName: "Cher" });
    const cand = seedScoredCandidate(db, { personName: "Cher" });

    const { makePromoteCandidateToLeadTool } = (await import(
      "../../../src/tools/sales/promoteCandidateToLead.js"
    )) as { makePromoteCandidateToLeadTool: (path: string) => { execute: unknown } };

    const tool = makePromoteCandidateToLeadTool(dbPath);
    const result = await (tool.execute as Function)({
      candidateId: cand,
      ownerMode: "manual",
      bypassPersonaCheck: true,
    });

    // TODO (Step 5): fill assertions
    assert.ok(result.ok, "TODO: must succeed");
    assert.ok(
      Array.isArray(result.data.duplicateOf) && result.data.duplicateOf.length > 0,
      "TODO: mononym collision must emit duplicateOf",
    );
    assert.strictEqual(result.data.weakMatch, true, "TODO: single-token name must set weakMatch:true");
    assert.strictEqual(result.data.requiresOperatorConfirm, true, "TODO: requiresOperatorConfirm must be true");
  });

  // ─── T-Dup.7 ─────────────────────────────────────────────────────────────────
  it("T-Dup.7: all-emoji candidate name '🎯🎯🎯' normalizes to empty → no signal (graceful skip)", async () => {
    // Given: existing lead {person_name: "Marcus Jiang"};
    //        existing lead {person_name: "🎯🎯🎯"} (normalizes to empty);
    //        candidate {person_name: "🎯🎯🎯"} (also normalizes to empty).
    // When:  promote (bypassPersonaCheck:true)
    // Then:  envelope = bare {leadId, candidateId, alreadyPromoted:false} — duplicateOf ABSENT.
    //        Empty sets do not collide — tokenSetEqual returns false when size===0.
    const { db, dbPath } = await openDb();
    seedExistingLead(db, { personName: "Marcus Jiang" });
    seedExistingLead(db, { personName: "🎯🎯🎯" });
    const cand = seedScoredCandidate(db, { personName: "🎯🎯🎯" });

    const { makePromoteCandidateToLeadTool } = (await import(
      "../../../src/tools/sales/promoteCandidateToLead.js"
    )) as { makePromoteCandidateToLeadTool: (path: string) => { execute: unknown } };

    const tool = makePromoteCandidateToLeadTool(dbPath);
    const result = await (tool.execute as Function)({
      candidateId: cand,
      ownerMode: "manual",
      bypassPersonaCheck: true,
    });

    // TODO (Step 5): fill assertions
    assert.ok(result.ok, "TODO: must succeed");
    assert.strictEqual(result.data.duplicateOf, undefined, "TODO: duplicateOf must be ABSENT when empty-set skip fires");
    assert.strictEqual(result.data.requiresOperatorConfirm, undefined, "TODO: requiresOperatorConfirm must be ABSENT");
    const newLead = db.prepare("SELECT id FROM leads WHERE id = ?").get(result.data.leadId);
    assert.ok(newLead, "TODO: new lead must still be created");
  });

  // ─── T-Dup.8 ─────────────────────────────────────────────────────────────────
  it("T-Dup.8: Auto ownerMode — flag-not-block, same signal as manual (no getCurrentAutoRun consultation for THIS gate)", async () => {
    // Given: an active auto_run row (getCurrentAutoRun(db) != null);
    //        existing same-name lead; scored same-name candidate.
    // When:  promote_candidate_to_lead({candidateId, ownerMode:"auto", bypassPersonaCheck:true})
    // Then:  lead IS created AND duplicateOf non-empty AND requiresOperatorConfirm===true.
    //        Mode-independence: the dedup branch does not consult getCurrentAutoRun.
    const { db, dbPath } = await openDb();
    // Seed active auto_run so getCurrentAutoRun(db) returns non-null
    const now = Date.now();
    db.prepare(`
      INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), now, null, 480, 20, "running", null, null);

    const leadA = seedExistingLead(db, { personName: "Marcus Jiang" });
    const cand = seedScoredCandidate(db, { personName: "Marcus Jiang" });

    const { makePromoteCandidateToLeadTool } = (await import(
      "../../../src/tools/sales/promoteCandidateToLead.js"
    )) as { makePromoteCandidateToLeadTool: (path: string) => { execute: unknown } };

    const tool = makePromoteCandidateToLeadTool(dbPath);
    const result = await (tool.execute as Function)({
      candidateId: cand,
      ownerMode: "auto",
      bypassPersonaCheck: true,
    });

    // TODO (Step 5): fill assertions
    assert.ok(result.ok, "TODO: Auto promote must succeed (flag-not-block)");
    assert.ok(
      Array.isArray(result.data.duplicateOf) && result.data.duplicateOf.includes(leadA),
      "TODO: Auto path must produce same duplicateOf signal as Manual",
    );
    assert.strictEqual(result.data.requiresOperatorConfirm, true, "TODO: requiresOperatorConfirm must be true in Auto");
    const newLead = db.prepare("SELECT id FROM leads WHERE id = ?").get(result.data.leadId);
    assert.ok(newLead, "TODO: lead must be created in Auto mode (flag-not-block)");
  });

  // ─── T-Dup.9 ─────────────────────────────────────────────────────────────────
  it("T-Dup.9: no-duplicate promote — envelope has EXACTLY {leadId, candidateId, alreadyPromoted} (3 keys, consumer guard)", async () => {
    // Given: NO same-name lead exists in DB; scored candidate with unique name.
    // When:  promote (bypassPersonaCheck:true)
    // Then:  envelope data has EXACTLY 3 keys — leadId, candidateId, alreadyPromoted.
    //        No duplicateOf / requiresOperatorConfirm / weakMatch.
    //        Guards every existing consumer of promote envelope from breakage.
    const { db, dbPath } = await openDb();
    const cand = seedScoredCandidate(db, { personName: "Unique Person Nobody Else" });

    const { makePromoteCandidateToLeadTool } = (await import(
      "../../../src/tools/sales/promoteCandidateToLead.js"
    )) as { makePromoteCandidateToLeadTool: (path: string) => { execute: unknown } };

    const tool = makePromoteCandidateToLeadTool(dbPath);
    const result = await (tool.execute as Function)({
      candidateId: cand,
      ownerMode: "manual",
      bypassPersonaCheck: true,
    });

    // TODO (Step 5): fill assertions
    assert.ok(result.ok, "TODO: must succeed");
    assert.strictEqual(result.data.alreadyPromoted, false, "TODO: alreadyPromoted must be false");
    const keys = Object.keys(result.data).sort();
    assert.deepStrictEqual(keys, ["alreadyPromoted", "candidateId", "leadId"], "TODO: no-dup envelope must have EXACTLY 3 keys");
  });

  // ─── T-Dup.10 ────────────────────────────────────────────────────────────────
  it("T-Dup.10: idempotent re-promote returns alreadyPromoted:true with EXACTLY 3 keys (short-circuit untouched)", async () => {
    // Given: a candidate already promoted to leadX in a prior call.
    // When:  promote the SAME candidate again.
    // Then:  short-circuit fires (lines 103-106); data = {leadId:leadX, candidateId, alreadyPromoted:true}
    //        EXACTLY 3 keys — NO duplicateOf (new code is PAST the short-circuit and never runs).
    const { db, dbPath } = await openDb();
    // Seed a candidate already in 'promoted' state with an existing leads row.
    // seedExistingLead creates the raw_candidates row with status='promoted'.
    const existingLeadId = seedExistingLead(db, { personName: "Already Promoted Person" });
    // Retrieve the candidate_id that seedExistingLead created for this lead.
    const leadRow = db.prepare("SELECT candidate_id FROM leads WHERE id = ?").get(existingLeadId) as
      | { candidate_id: string }
      | undefined;
    assert.ok(leadRow, "setup: lead must exist");
    const alreadyPromotedCandId = leadRow.candidate_id;

    const { makePromoteCandidateToLeadTool } = (await import(
      "../../../src/tools/sales/promoteCandidateToLead.js"
    )) as { makePromoteCandidateToLeadTool: (path: string) => { execute: unknown } };

    const tool = makePromoteCandidateToLeadTool(dbPath);
    const result = await (tool.execute as Function)({
      candidateId: alreadyPromotedCandId,
      ownerMode: "manual",
    });

    // TODO (Step 5): fill assertions
    assert.ok(result.ok, "TODO: idempotent promote must succeed");
    assert.strictEqual(result.data.alreadyPromoted, true, "TODO: alreadyPromoted must be true");
    assert.strictEqual(result.data.leadId, existingLeadId, "TODO: leadId must match the existing lead");
    const keys = Object.keys(result.data).sort();
    assert.deepStrictEqual(keys, ["alreadyPromoted", "candidateId", "leadId"], "TODO: short-circuit envelope must have EXACTLY 3 keys");
  });

  // ─── T-Dup.11 ────────────────────────────────────────────────────────────────
  it("T-Dup.11: disqualified leads are excluded from dedup pool (stage='disqualified' skipped)", async () => {
    // Given: existing lead {person_name: "Jane Doe", stage: "disqualified"};
    //        fresh same-name scored candidate.
    // When:  promote (bypassPersonaCheck:true)
    // Then:  envelope = bare {leadId, candidateId, alreadyPromoted:false} — NO duplicateOf.
    //        getActiveLeadNames excludes stage='disqualified' so previously-rejected
    //        persons don't block fresh re-engagement.
    const { db, dbPath } = await openDb();
    seedExistingLead(db, { personName: "Jane Doe", stage: "disqualified" });
    const cand = seedScoredCandidate(db, { personName: "Jane Doe" });

    const { makePromoteCandidateToLeadTool } = (await import(
      "../../../src/tools/sales/promoteCandidateToLead.js"
    )) as { makePromoteCandidateToLeadTool: (path: string) => { execute: unknown } };

    const tool = makePromoteCandidateToLeadTool(dbPath);
    const result = await (tool.execute as Function)({
      candidateId: cand,
      ownerMode: "manual",
      bypassPersonaCheck: true,
    });

    // TODO (Step 5): fill assertions
    assert.ok(result.ok, "TODO: must succeed");
    assert.strictEqual(result.data.duplicateOf, undefined, "TODO: disqualified lead must be excluded from dedup pool");
    assert.strictEqual(result.data.alreadyPromoted, false, "TODO: alreadyPromoted must be false");
    const newLead = db.prepare("SELECT id FROM leads WHERE id = ?").get(result.data.leadId);
    assert.ok(newLead, "TODO: new lead must be created");
  });

  // ─── T-Dup.12 ────────────────────────────────────────────────────────────────
  it("T-Dup.12: cross-account global scan — account_id NULL lead matches account_id-bearing candidate", async () => {
    // Given: existing lead {person_name: "Marcus Jiang", account_id: NULL};
    //        candidate {person_name: "Marcus Jiang", account_id: "562f-acct-id"}.
    // When:  promote (bypassPersonaCheck:true)
    // Then:  duplicateOf non-empty (no WHERE account_id filter in getActiveLeadNames).
    //        Pins that cross-account dedup works — live data has Marcus rows at account_id=NULL
    //        while a fresh Marcus candidate carries a real account_id.
    const { db, dbPath } = await openDb();
    // D-A10.1 fix: seed the accounts row BEFORE inserting the account_id-bearing candidate.
    // raw_candidates.account_id REFERENCES accounts(id) — FK fires at INSERT with FK=ON.
    // The test POINT survives: the lead has account_id=NULL (no accounts FK concern) while
    // the candidate has a REAL seeded account_id; getActiveLeadNames has no account_id filter
    // so the NULL-account lead still appears in the dedup pool.
    db.prepare(`
      INSERT INTO accounts (id, name, updated_at)
      VALUES (?, ?, ?)
    `).run("562f-acct-id", "562f Test Account", Date.now());
    const leadNull = seedExistingLead(db, { personName: "Marcus Jiang", accountId: null });
    const cand = seedScoredCandidate(db, { personName: "Marcus Jiang", accountId: "562f-acct-id" });

    const { makePromoteCandidateToLeadTool } = (await import(
      "../../../src/tools/sales/promoteCandidateToLead.js"
    )) as { makePromoteCandidateToLeadTool: (path: string) => { execute: unknown } };

    const tool = makePromoteCandidateToLeadTool(dbPath);
    const result = await (tool.execute as Function)({
      candidateId: cand,
      ownerMode: "manual",
      bypassPersonaCheck: true,
    });

    // TODO (Step 5): fill assertions
    assert.ok(result.ok, "TODO: must succeed");
    assert.ok(
      Array.isArray(result.data.duplicateOf) && result.data.duplicateOf.includes(leadNull),
      "TODO: cross-account dedup must fire — account_id=NULL lead must be in pool",
    );
  });

  // ─── T-Dup.13 ────────────────────────────────────────────────────────────────
  it("T-Dup.13: duplicate signal is DURABLE in promoted_to_lead timeline metadata (both branches)", async () => {
    // Given: existing lead {id: leadA, person_name: "Dmitry Balanovsky"};
    //        scored candidate {person_name: "Dmitry Balanovsky"} (same name).
    // When:  promote {candB, ownerMode:"manual", bypassPersonaCheck:true}, then
    //        read back via direct DB query (listTimelineByLead pattern) AND
    //        get_lead_context tool ({leadId: newLeadId}).
    // Then (Branch A — with dup):
    //   - exactly one promoted_to_lead event for new lead;
    //   - its metadata (JSON parsed) is superset of {ownerMode:"manual"} AND contains
    //     duplicateOf:[leadA], requiresOperatorConfirm:true, weakMatch:false;
    //   - get_lead_context timeline entry for that event carries the same metadata shape.
    // Then (Branch B — no dup):
    //   - new lead's promoted_to_lead event metadata is EXACTLY {ownerMode:"manual"}
    //     (no duplicateOf / requiresOperatorConfirm / weakMatch — consumer guard).

    // --- Branch A: with dup ---
    const { db: dbA, dbPath: dbPathA } = await openDb();
    const leadA = seedExistingLead(dbA, { personName: "Dmitry Balanovsky" });
    const candB = seedScoredCandidate(dbA, { personName: "Dmitry Balanovsky" });

    const { makePromoteCandidateToLeadTool } = (await import(
      "../../../src/tools/sales/promoteCandidateToLead.js"
    )) as { makePromoteCandidateToLeadTool: (path: string) => { execute: unknown } };

    const toolA = makePromoteCandidateToLeadTool(dbPathA);
    const resultA = await (toolA.execute as Function)({
      candidateId: candB,
      ownerMode: "manual",
      bypassPersonaCheck: true,
    });

    // TODO (Step 5): fill all assertions below
    assert.ok(resultA.ok, "TODO: Branch A promote must succeed");

    const newLeadId = resultA.data.leadId;

    // Read back via direct DB query (mirrors listTimelineByLead from timeline.ts:48-55)
    const timelineRowsA = dbA
      .prepare(`
        SELECT event_type, metadata
        FROM lead_timeline
        WHERE lead_id = ? AND event_type = 'promoted_to_lead'
        ORDER BY ts DESC
      `)
      .all(newLeadId) as { event_type: string; metadata: string | null }[];

    assert.strictEqual(timelineRowsA.length, 1, "TODO: exactly one promoted_to_lead event for new lead");
    const metaA = JSON.parse(timelineRowsA[0]!.metadata ?? "{}") as Record<string, unknown>;
    assert.strictEqual(metaA.ownerMode, "manual", "TODO: metadata must contain ownerMode:'manual'");
    assert.ok(
      Array.isArray(metaA.duplicateOf) && (metaA.duplicateOf as string[]).includes(leadA),
      "TODO: metadata must contain duplicateOf:[leadA]",
    );
    assert.strictEqual(metaA.requiresOperatorConfirm, true, "TODO: metadata must contain requiresOperatorConfirm:true");
    assert.strictEqual(metaA.weakMatch, false, "TODO: metadata must contain weakMatch:false");

    // Read back via get_lead_context tool
    const { makeGetLeadContextTool } = (await import(
      "../../../src/tools/sales/getLeadContext.js"
    )) as { makeGetLeadContextTool: (path: string) => { execute: unknown } };

    const ctxTool = makeGetLeadContextTool(dbPathA);
    const ctxResult = await (ctxTool.execute as Function)({ leadId: newLeadId });
    assert.ok(ctxResult.ok, "TODO: get_lead_context must succeed");
    const ctxTimeline = ctxResult.data.timeline as { eventType: string; metadata: string | null }[];
    const promotedEvent = ctxTimeline.find((e) => e.eventType === "promoted_to_lead");
    assert.ok(promotedEvent, "TODO: promoted_to_lead must appear in get_lead_context timeline");
    const ctxMeta = JSON.parse(promotedEvent!.metadata ?? "{}") as Record<string, unknown>;
    assert.ok(
      Array.isArray(ctxMeta.duplicateOf) && (ctxMeta.duplicateOf as string[]).includes(leadA),
      "TODO: get_lead_context timeline metadata must carry duplicateOf",
    );

    // --- Branch B: no dup — metadata is EXACTLY {ownerMode:"manual"} ---
    const { db: dbB, dbPath: dbPathB } = await openDb();
    const candNodup = seedScoredCandidate(dbB, { personName: "Unique Nodup Person" });
    const toolB = makePromoteCandidateToLeadTool(dbPathB);
    const resultB = await (toolB.execute as Function)({
      candidateId: candNodup,
      ownerMode: "manual",
      bypassPersonaCheck: true,
    });
    assert.ok(resultB.ok, "TODO: Branch B promote must succeed");
    const nodupLeadId = resultB.data.leadId;
    const nodupRows = dbB
      .prepare(`
        SELECT metadata
        FROM lead_timeline
        WHERE lead_id = ? AND event_type = 'promoted_to_lead'
      `)
      .all(nodupLeadId) as { metadata: string | null }[];
    assert.strictEqual(nodupRows.length, 1, "TODO: exactly one promoted_to_lead for no-dup branch");
    const metaB = JSON.parse(nodupRows[0]!.metadata ?? "{}") as Record<string, unknown>;
    assert.deepStrictEqual(
      Object.keys(metaB).sort(),
      ["ownerMode"],
      "TODO: no-dup metadata must be EXACTLY {ownerMode} — consumer guard",
    );
    assert.strictEqual(metaB.ownerMode, "manual", "TODO: ownerMode must be 'manual' in no-dup metadata");
  });

});
