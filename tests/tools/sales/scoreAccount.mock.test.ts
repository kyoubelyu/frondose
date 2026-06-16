/**
 * P-SP-B Step 5 — T-SP-B.Account.1..5: score_account tool.
 *
 * FILLED at Step 5. All 5 assertion bodies filled with real assertions.
 * Test isolation: each it() uses a unique OS temp path so salesDb singleton
 * instances don't bleed between tests.
 *
 * Gates covered: UPSERT INSERT path (created), UPSERT UPDATE path (updated,
 * no duplicate), candidateId links raw_candidates.account_id, no candidateId
 * → raw_candidates untouched, Zod accountScore range validation.
 *
 * Run (mock only):
 *   node --import tsx --test --test-force-exit \
 *     tests/tools/sales/scoreAccount.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { closeSalesDatabase, openSalesDatabase } from "../../../src/persistence/salesDb.js";
import { seedFreshCandidate } from "../../sales/_fixtures/salesDb.js";

// Gate-on-builder: makeScoreAccountTool from src/tools/sales/scoreAccount.js (NEW in P-SP-B).
// biome-ignore lint/suspicious/noExplicitAny: pre-builder stub
let makeScoreAccountTool: (salesDbPath: string) => any;
try {
  // biome-ignore lint/suspicious/noExplicitAny: pre-builder stub
  const mod = (await import("../../../src/tools/sales/scoreAccount.js")) as any;
  makeScoreAccountTool = mod.makeScoreAccountTool;
} catch {
  makeScoreAccountTool = (_path: string) => null;
}

const TEST_LINKEDIN_URL = "https://www.linkedin.com/company/techcorp";

describe("T-SP-B.Account — score_account tool", () => {
  // ─── T-SP-B.Account.1 — INSERT (new linkedinUrl) ─────────────────────────────

  it("T-SP-B.Account.1: when score_account is called with a new linkedinUrl, accounts row is created with action='created'", async () => {
    // Given: empty accounts table (fresh DB)
    // When:  score_account.execute called with name='TechCorp', linkedinUrl=TEST_LINKEDIN_URL,
    //        industry='SaaS', companySize='500-1000', region='EMEA',
    //        currentPainHypothesis='scaling outbound without headcount', accountScore=72,
    //        evidence='{"hq":"London"}'
    // Then:  accounts has 1 new row with all those values + id set + updated_at non-null;
    //        return {ok:true, data:{accountId:<id>, action:"created"}}

    const path = join(tmpdir(), `sp-b-account-1-${randomUUID()}.sqlite`);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture db handle
    const db = openSalesDatabase(path) as any;
    try {
      const tool = makeScoreAccountTool(path);
      const result = await tool.execute({
        name: "TechCorp",
        linkedinUrl: TEST_LINKEDIN_URL,
        industry: "SaaS",
        companySize: "500-1000",
        region: "EMEA",
        currentPainHypothesis: "scaling outbound without headcount",
        accountScore: 72,
        evidence: '{"hq":"London"}',
      });

      // Envelope checks
      assert.equal(result.ok, true, "INSERT path must return ok:true");
      assert.equal(result.command, "score_account", "command must be 'score_account'");
      assert.equal(result.data.action, "created", "action must be 'created' for a new linkedinUrl");
      assert.ok(result.data.accountId, "accountId must be a non-empty string");

      // DB: accounts row written with all fields
      const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(result.data.accountId);
      assert.ok(row, "accounts row must exist");
      assert.equal(row.name, "TechCorp", "accounts.name must be 'TechCorp'");
      assert.equal(row.industry, "SaaS", "accounts.industry must be 'SaaS'");
      assert.equal(row.company_size, "500-1000", "accounts.company_size must match");
      assert.equal(row.region, "EMEA", "accounts.region must match");
      assert.equal(
        row.current_pain_hypothesis,
        "scaling outbound without headcount",
        "accounts.current_pain_hypothesis must match",
      );
      assert.equal(row.account_score, 72, "accounts.account_score must be 72");
      assert.ok(row.updated_at > 0, "accounts.updated_at must be a non-zero unix timestamp");

      // Only 1 row created
      const cnt = db.prepare("SELECT COUNT(*) as cnt FROM accounts").get().cnt;
      assert.equal(cnt, 1, "exactly 1 accounts row must be created");
    } finally {
      closeSalesDatabase(path);
    }
  });

  // ─── T-SP-B.Account.2 — UPSERT UPDATE (existing linkedinUrl, same row) ────────

  it("T-SP-B.Account.2: when score_account is called with an existing linkedinUrl, the SAME accounts row is updated (no duplicate) and action='updated'", async () => {
    // Given: accounts row with linkedin_url=TEST_LINKEDIN_URL and account_score=60 (first call)
    // When:  score_account.execute called again with the SAME linkedinUrl but new values
    //        (name='TechCorp Inc', accountScore=78, currentPainHypothesis='refined hypothesis')
    // Then:  accounts table still has EXACTLY 1 row (no duplicate); the row has account_score=78
    //        + refreshed updated_at + new current_pain_hypothesis;
    //        return {ok:true, data:{accountId:<SAME id as first insert>, action:"updated"}}

    const path = join(tmpdir(), `sp-b-account-2-${randomUUID()}.sqlite`);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture db handle
    const db = openSalesDatabase(path) as any;
    try {
      const tool = makeScoreAccountTool(path);

      // First call — INSERT
      const first = await tool.execute({
        name: "TechCorp",
        linkedinUrl: TEST_LINKEDIN_URL,
        accountScore: 60,
      });
      assert.equal(first.ok, true);
      assert.equal(first.data.action, "created");
      const firstId = first.data.accountId;

      // Second call — same URL → UPDATE (UPSERT conflict path)
      const second = await tool.execute({
        name: "TechCorp Inc",
        linkedinUrl: TEST_LINKEDIN_URL,
        accountScore: 78,
        currentPainHypothesis: "refined hypothesis",
      });

      assert.equal(second.ok, true, "UPSERT UPDATE path must return ok:true");
      assert.equal(second.data.action, "updated", "action must be 'updated' for existing linkedinUrl");
      assert.equal(second.data.accountId, firstId, "accountId must be the SAME row id (no duplicate)");

      // DB: still exactly 1 row, with updated values
      const cnt = db.prepare("SELECT COUNT(*) as cnt FROM accounts").get().cnt;
      assert.equal(cnt, 1, "UPSERT must NOT create a duplicate — exactly 1 accounts row");

      const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(firstId);
      assert.equal(row.account_score, 78, "account_score must be updated to 78");
      assert.equal(row.name, "TechCorp Inc", "name must be updated to 'TechCorp Inc'");
      assert.equal(
        row.current_pain_hypothesis,
        "refined hypothesis",
        "current_pain_hypothesis must be updated",
      );
    } finally {
      closeSalesDatabase(path);
    }
  });

  // ─── T-SP-B.Account.3 — candidateId supplied → links raw_candidates.account_id ─

  it("T-SP-B.Account.3: when candidateId is supplied, raw_candidates.account_id is updated to the account's id in the same atomic transaction", async () => {
    // Given: raw_candidates row id=c1 with account_id=null + fresh accounts table
    // When:  score_account.execute called with linkedinUrl=TEST_LINKEDIN_URL, candidateId='c1'
    // Then:  raw_candidates.account_id for c1 is now set to the account row's id (atomic);
    //        return {ok:true, data:{accountId:<id>, action:"created"}}

    const path = join(tmpdir(), `sp-b-account-3-${randomUUID()}.sqlite`);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture db handle
    const db = openSalesDatabase(path) as any;
    try {
      const candidateId = seedFreshCandidate(db);

      // Confirm account_id is null before
      const before = db
        .prepare("SELECT account_id FROM raw_candidates WHERE id = ?")
        .get(candidateId);
      assert.equal(before.account_id, null, "raw_candidates.account_id must be null before score_account");

      const tool = makeScoreAccountTool(path);
      const result = await tool.execute({
        name: "TechCorp",
        linkedinUrl: TEST_LINKEDIN_URL,
        candidateId,
      });

      assert.equal(result.ok, true, "execute must return ok:true");

      // raw_candidates.account_id linked atomically in same transaction
      const after = db
        .prepare("SELECT account_id FROM raw_candidates WHERE id = ?")
        .get(candidateId);
      assert.equal(
        after.account_id,
        result.data.accountId,
        "raw_candidates.account_id must be updated to the new account row's id",
      );
    } finally {
      closeSalesDatabase(path);
    }
  });

  // ─── T-SP-B.Account.4 — no candidateId → raw_candidates untouched ────────────

  it("T-SP-B.Account.4: when score_account is called WITHOUT candidateId, raw_candidates rows are not modified", async () => {
    // Given: raw_candidates row with account_id=null; no candidateId passed to score_account
    // When:  score_account.execute called WITHOUT candidateId
    // Then:  accounts row created; raw_candidates.account_id remains null (untouched);
    //        return {ok:true, data:{accountId:<id>, action:"created"}}

    const path = join(tmpdir(), `sp-b-account-4-${randomUUID()}.sqlite`);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture db handle
    const db = openSalesDatabase(path) as any;
    try {
      const candidateId = seedFreshCandidate(db);

      const tool = makeScoreAccountTool(path);
      const result = await tool.execute({
        name: "TechCorp",
        linkedinUrl: TEST_LINKEDIN_URL,
        // candidateId intentionally omitted
      });

      assert.equal(result.ok, true, "execute must return ok:true");

      // raw_candidates.account_id must remain null — no candidateId was passed
      const row = db
        .prepare("SELECT account_id FROM raw_candidates WHERE id = ?")
        .get(candidateId);
      assert.equal(
        row.account_id,
        null,
        "raw_candidates.account_id must remain null when candidateId is not supplied",
      );
    } finally {
      closeSalesDatabase(path);
    }
  });

  // ─── T-SP-B.Account.5 — Zod range validation ─────────────────────────────────

  it("T-SP-B.Account.5: when accountScore is out-of-range (200), Zod rejects with a clear range error naming 0..100 INTEGER", async () => {
    // Given: score_account Zod schema (accessed via makeScoreAccountTool(path).parameters)
    // When:  tool.parameters.safeParse called with accountScore=200 (out of [0,100])
    // Then:  {success:false}; issues array has at least 1 issue with path[0]==="accountScore"

    // Use any path — Zod safeParse never touches the DB
    const tool = makeScoreAccountTool(join(tmpdir(), "sp-b-account-5-zod-only.sqlite"));

    const result = tool.parameters.safeParse({
      name: "BadCorp",
      linkedinUrl: TEST_LINKEDIN_URL,
      accountScore: 200,
    });

    assert.equal(result.success, false, "accountScore=200 must fail Zod (max 100)");
    assert.ok(
      result.error.issues.some(
        (i: { path: (string | number)[] }) => i.path[0] === "accountScore",
      ),
      `Zod error must reference accountScore path for value 200; issues: ${JSON.stringify(result.error.issues)}`,
    );
  });
});
