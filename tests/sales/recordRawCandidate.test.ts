/**
 * P-SP-A mock tests — T-SP-A.Candidate.1..4
 * record_raw_candidate tool: insert, validation, upsert dedup, status preservation.
 *
 * Step 5: assertion bodies filled.
 * C3 fix (guardian CONCERN-3): Candidate.4 verifies upsert preserves existing status,
 * not hardcoded 'new'.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeSalesDatabase, openSalesDatabase } from "../../src/persistence/salesDb.js";
import { makeRecordRawCandidateTool } from "../../src/tools/sales/recordRawCandidate.js";
import { mkTestSalesDb } from "./_fixtures/salesDb.js";

describe("T-SP-A.Candidate — record_raw_candidate tool", () => {
  // ─── T-SP-A.Candidate.1 ──────────────────────────────────────────────────────
  it("T-SP-A.Candidate.1: inserts row + auto-appends discovered timeline event", async () => {
    // Given: empty sales DB (:memory:)
    // When:  record_raw_candidate tool execute called with valid profileUrl/personName/source
    // Then:  raw_candidates has 1 row (status='new', source='profile-nav', observedAt+lastSeenAt set);
    //        lead_timeline has 1 'discovered' row with matching candidate_id; lead_id IS NULL;
    //        tool returns {ok:true, command:'record_raw_candidate', data:{candidateId, status:'new', inserted:true}}
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");
    const tool = makeRecordRawCandidateTool(":memory:");

    const result = await (tool.execute as Function)({
      personName: "Bob Smith",
      profileUrl: "https://www.linkedin.com/in/bob-smith-123/",
      source: "profile-nav",
      evidenceSummary: "VP Engineering at TechCo",
    });

    assert.ok(result.ok, "Tool must return ok:true on success");
    assert.strictEqual(result.command, "record_raw_candidate");
    assert.ok(result.data.candidateId, "Must return a candidateId");
    assert.strictEqual(result.data.status, "new", "status must be 'new' on first insert");
    assert.strictEqual(result.data.inserted, true, "inserted must be true on first insert");

    // Verify DB state
    const rows = db
      .prepare("SELECT * FROM raw_candidates WHERE id = ?")
      .all(result.data.candidateId) as Array<{
      id: string;
      status: string;
      source: string;
      observed_at: number;
      last_seen_at: number;
    }>;
    assert.strictEqual(rows.length, 1, "Must have exactly 1 raw_candidates row");
    assert.strictEqual(rows[0]!.status, "new");
    assert.strictEqual(rows[0]!.source, "profile-nav");
    assert.ok(rows[0]!.observed_at > 0, "observed_at must be set");
    assert.ok(rows[0]!.last_seen_at > 0, "last_seen_at must be set");

    // Verify timeline
    const timeline = db
      .prepare("SELECT * FROM lead_timeline WHERE candidate_id = ?")
      .all(result.data.candidateId) as Array<{
      event_type: string;
      lead_id: string | null;
    }>;
    assert.strictEqual(timeline.length, 1, "Must have 1 timeline event");
    assert.strictEqual(timeline[0]!.event_type, "discovered", "Timeline event must be 'discovered'");
    assert.strictEqual(timeline[0]!.lead_id, null, "lead_id must be NULL for initial 'discovered' event");
  });

  // ─── T-SP-A.Candidate.2 ──────────────────────────────────────────────────────
  it("T-SP-A.Candidate.2: invalid source enum rejected at Zod layer", async () => {
    // Given: a fresh :memory: DB
    // When:  record_raw_candidate execute called with source='twitter' (not in enum)
    // Then:  tool returns {ok:false, command:'record_raw_candidate', error:{kind:'invalid_input'}};
    //        no row inserted; no timeline event
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");
    const tool = makeRecordRawCandidateTool(":memory:");

    const result = await (tool.execute as Function)({
      personName: "Bob Smith",
      profileUrl: "https://www.linkedin.com/in/bob-smith/",
      source: "twitter", // not in enum
    });

    assert.strictEqual(result.ok, false, "Tool must return ok:false for invalid source");
    assert.strictEqual(result.command, "record_raw_candidate");
    assert.strictEqual(result.error.kind, "invalid_input", "error.kind must be 'invalid_input'");

    // DB must be empty
    const candidateCount = db
      .prepare("SELECT COUNT(*) AS n FROM raw_candidates")
      .get() as { n: number };
    assert.strictEqual(candidateCount.n, 0, "No row must be inserted for invalid input");

    const timelineCount = db
      .prepare("SELECT COUNT(*) AS n FROM lead_timeline")
      .get() as { n: number };
    assert.strictEqual(timelineCount.n, 0, "No timeline event must be appended for invalid input");
  });

  // ─── T-SP-A.Candidate.3 ──────────────────────────────────────────────────────
  it("T-SP-A.Candidate.3: empty profileUrl rejected", async () => {
    // Given: a fresh :memory: DB
    // When:  record_raw_candidate execute called with profileUrl='' (empty string)
    // Then:  tool returns {ok:false, error:{kind:'invalid_input', message: includes 'url'}};
    //        no row written
    closeSalesDatabase(":memory:");
    openSalesDatabase(":memory:");
    const tool = makeRecordRawCandidateTool(":memory:");

    const result = await (tool.execute as Function)({
      personName: "Bob Smith",
      profileUrl: "", // empty string — fails Zod .url() validation
      source: "profile-nav",
    });

    assert.strictEqual(result.ok, false, "Tool must return ok:false for empty profileUrl");
    assert.strictEqual(result.error.kind, "invalid_input");
    // Zod URL error message contains 'url'
    assert.match(
      result.error.message.toLowerCase(),
      /url|invalid/,
      "Error message must indicate URL/invalid input",
    );
  });

  // ─── T-SP-A.Candidate.4 ──────────────────────────────────────────────────────
  it("T-SP-A.Candidate.4: upsert preserves EXISTING status — does NOT return 'new' for promoted candidate (C3 fix)", async () => {
    // Given: a raw_candidates row at status='promoted' (seeded via fixture)
    // When:  record_raw_candidate tool invoked again with the same profileUrl (no trailing slash variant)
    // Then:  still only 1 row in raw_candidates; tool returns status matching the actual DB status
    //        ('promoted') NOT the hardcoded 'new'; inserted=false; lastSeenAt bumped
    closeSalesDatabase(":memory:");
    const { db, candidateId } = await mkTestSalesDb();
    // Fixture seeds Alice at status='promoted'
    const row = db.prepare("SELECT profile_url, status, last_seen_at FROM raw_candidates WHERE id = ?").get(candidateId) as {
      profile_url: string;
      status: string;
      last_seen_at: number;
    };
    assert.strictEqual(row.status, "promoted", "Fixture must have status='promoted'");

    const originalLastSeen = row.last_seen_at;
    await new Promise((r) => setTimeout(r, 10)); // ensure time advances

    const tool = makeRecordRawCandidateTool(":memory:");
    // Call with the URL WITHOUT trailing slash (upsert normalization adds it)
    const result = await (tool.execute as Function)({
      personName: "Alice Example",
      profileUrl: "https://www.linkedin.com/in/alice-example", // no trailing slash
      source: "feed",
    });

    assert.ok(result.ok, "Tool must return ok:true for upsert");
    assert.strictEqual(result.data.inserted, false, "inserted must be false for upsert (existing row)");
    assert.strictEqual(
      result.data.status,
      "promoted",
      "C3 fix: status must reflect actual DB status ('promoted'), NOT hardcoded 'new'",
    );
    assert.strictEqual(result.data.candidateId, candidateId, "candidateId must match the original row");

    // Verify only 1 row exists
    const count = db.prepare("SELECT COUNT(*) AS n FROM raw_candidates").get() as { n: number };
    assert.strictEqual(count.n, 1, "Must still have only 1 raw_candidates row after upsert");

    // Verify lastSeenAt was bumped
    const updated = db.prepare("SELECT last_seen_at FROM raw_candidates WHERE id = ?").get(candidateId) as {
      last_seen_at: number;
    };
    assert.ok(updated.last_seen_at >= originalLastSeen, "lastSeenAt must be bumped on upsert");
  });
});
