/**
 * P-SP-B Step 4a scaffolds — T-SP-B.Account.1..5: score_account tool.
 *
 * All assertion bodies are TODO stubs that intentionally fail pre-builder (Step 4a).
 * Pre-builder failures:
 *   (a) Dynamic import of makeScoreAccountTool from src/tools/sales/scoreAccount.js
 *       fails (file does not exist until P-SP-A + P-SP-B code is committed).
 *   (b) Even if the import resolves, the assertions below immediately fail via
 *       assert.ok(false, "T-SP-B.Account.N TODO …").
 *
 * Gates covered: UPSERT INSERT path, UPSERT UPDATE path (same row, no duplicate),
 * candidateId links raw_candidates.account_id, no candidateId → raw_candidates untouched,
 * Zod accountScore range validation — all §4 T-SP-B.Account.* behaviors.
 *
 * Key contract: score_account uses atomic SQLite UPSERT
 * (INSERT ... ON CONFLICT(linkedin_url) DO UPDATE ... RETURNING id) — the returned
 * id discriminates created vs updated; URL normalization (normalizeCompanyUrl) collapses
 * trailing-slash / query / fragment / case variants.
 *
 * Run (mock only, after P-SP-A + P-SP-B code ships):
 *   node --import tsx --test --test-force-exit \
 *     tests/tools/sales/scoreAccount.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkTestSalesDb, seedFreshCandidate } from "../../sales/_fixtures/salesDb.js";

// Gate-on-builder: makeScoreAccountTool from src/tools/sales/scoreAccount.js (NEW in P-SP-B).
// biome-ignore lint/suspicious/noExplicitAny: pre-builder stub
let makeScoreAccountTool: (salesDbPath: string) => any;
try {
  // biome-ignore lint/suspicious/noExplicitAny: pre-builder stub
  const mod = (await import("../../../src/tools/sales/scoreAccount.js")) as any;
  makeScoreAccountTool = mod.makeScoreAccountTool;
} catch {
  // src/tools/sales/scoreAccount.ts not built yet (pre-builder Step 4b). Expected.
  makeScoreAccountTool = (_path: string) => null;
}

const TEST_LINKEDIN_URL = "https://www.linkedin.com/company/techcorp";

describe("T-SP-B.Account — score_account tool", () => {
  // ─── T-SP-B.Account.1 — INSERT (new linkedinUrl) ─────────────────────────────

  it("T-SP-B.Account.1: when score_account is called with a new linkedinUrl, accounts row is created with action='created'", async () => {
    // Given: empty accounts table (fresh :memory: DB)
    // When:  score_account execute called with name='TechCorp', linkedinUrl=TEST_LINKEDIN_URL,
    //        industry='SaaS', companySize='500-1000', region='EMEA',
    //        currentPainHypothesis='scaling outbound without headcount', accountScore=72,
    //        evidence='{"hq":"London"}'
    // Then:  accounts has 1 new row with all those values + id set + updated_at non-null;
    //        return {ok:true, data:{accountId:<id>, action:"created"}}
    void (await mkTestSalesDb()); // pre-run fixture to surface import errors early
    assert.ok(
      false,
      "T-SP-B.Account.1 TODO: fill at Step 5 — FAILS pre-builder: scoreAccount.ts not shipped yet",
    );
  });

  // ─── T-SP-B.Account.2 — UPSERT UPDATE (existing linkedinUrl, same row) ────────

  it("T-SP-B.Account.2: when score_account is called with an existing linkedinUrl, the SAME accounts row is updated (no duplicate) and action='updated'", async () => {
    // Given: accounts row with linkedin_url=TEST_LINKEDIN_URL and account_score=60 (seeded)
    // When:  score_account execute called again with the SAME linkedinUrl but new values
    //        (name='TechCorp Inc', accountScore=78, currentPainHypothesis='refined hypothesis')
    // Then:  accounts table still has EXACTLY 1 row (no duplicate); the row has account_score=78
    //        + refreshed updated_at + new current_pain_hypothesis;
    //        return {ok:true, data:{accountId:<SAME id as first insert>, action:"updated"}}
    assert.ok(
      false,
      "T-SP-B.Account.2 TODO: fill at Step 5 — FAILS pre-builder: scoreAccount.ts not shipped yet",
    );
  });

  // ─── T-SP-B.Account.3 — candidateId supplied → links raw_candidates.account_id ─

  it("T-SP-B.Account.3: when candidateId is supplied, raw_candidates.account_id is updated to the account's id in the same atomic transaction", async () => {
    // Given: raw_candidates row id=c1 with account_id=null + accounts row for the SAME linkedinUrl
    // When:  score_account execute called with linkedinUrl=<same>, candidateId='c1'
    // Then:  raw_candidates.account_id for c1 is now set to the account row's id;
    //        accounts UPSERT ran in the same db.transaction() (atomic);
    //        return {ok:true, data:{accountId:<id>, action:"updated"}} (or "created" if new)
    assert.ok(
      false,
      "T-SP-B.Account.3 TODO: fill at Step 5 — FAILS pre-builder: scoreAccount.ts not shipped yet",
    );
  });

  // ─── T-SP-B.Account.4 — no candidateId → raw_candidates untouched ────────────

  it("T-SP-B.Account.4: when score_account is called WITHOUT candidateId, raw_candidates rows are not modified", async () => {
    // Given: raw_candidates row with account_id=null; no candidateId passed to score_account
    // When:  score_account execute called without candidateId
    // Then:  accounts row created/updated; raw_candidates.account_id remains null (untouched);
    //        return {ok:true, data:{accountId:<id>, action:"created"|"updated"}}
    assert.ok(
      false,
      "T-SP-B.Account.4 TODO: fill at Step 5 — FAILS pre-builder: scoreAccount.ts not shipped yet",
    );
  });

  // ─── T-SP-B.Account.5 — Zod range validation ─────────────────────────────────

  it("T-SP-B.Account.5: when accountScore is out-of-range (200), Zod rejects with a clear range error naming 0..100 INTEGER", async () => {
    // Given: score_account Zod schema (scoreAccountParams)
    // When:  tool execute called with accountScore=200 (out of [0,100])
    // Then:  Zod parseAsync / parse throws with message naming the 0..100 INTEGER constraint;
    //        no accounts row written
    assert.ok(
      false,
      "T-SP-B.Account.5 TODO: fill at Step 5 — FAILS pre-builder: scoreAccount.ts not shipped yet",
    );
  });
});

// Suppress TS 'unused import' for pre-builder stubs
void makeScoreAccountTool;
void seedFreshCandidate;
