/**
 * P-SP-F Step 5 — T-F.Tool.1/2/3 — getSalesReport tool assertions (filled).
 *
 * Assertion bodies FILLED at Step 5.
 *
 * Gates covered:
 *   G-PSPF.10 — T-F.Tool.1, .2, .3
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/sales/getSalesReport.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: pre-builder stubs
type AnyFn = (...args: any[]) => any;

let makeGetSalesReportTool: AnyFn;
let openSalesDatabase: AnyFn;
let closeSalesDatabase: AnyFn;

// Dynamic import: getSalesReport.ts does NOT exist pre-builder → resolves to null
// biome-ignore lint/suspicious/noExplicitAny: pre-builder resolution
const toolMod = (await import("../../../src/tools/sales/getSalesReport.js").catch(() => null)) as any;
makeGetSalesReportTool = toolMod?.makeGetSalesReportTool ?? null;

// biome-ignore lint/suspicious/noExplicitAny: pre-builder resolution
const dbMod = (await import("../../../src/persistence/salesDb.js").catch(() => null)) as any;
openSalesDatabase = dbMod?.openSalesDatabase ?? null;
closeSalesDatabase = dbMod?.closeSalesDatabase ?? null;

/** Create a unique tmp path per test (avoids salesDb singleton collision). */
function makeTmpPath(): string {
  return join(tmpdir(), `sp-f-tool-test-${randomUUID()}.sqlite`);
}

/**
 * Seed a populated fixture: 2 candidates, 2 leads, timeline events covering
 * connect_sent, connected, message_sent, replied, sales_intent_detected,
 * meeting_booked, plus 1 auto_run row and 1 lead_scores row.
 *
 * Expected metric values from this fixture:
 *   meetingBooked           = 1   (meeting_booked event for l1)
 *   salesIntent.count       = 2   (l1 + l2 both have sales_intent_detected events, DISTINCT)
 *   salesIntent.contacted   = 2   (l1 + l2 both have connect_sent OR message_sent, DISTINCT)
 *   salesIntent.rate        = 100.0 (2 intent / 2 contacted × 100, rounded 1dp)
 *   connectionRate.sent     = 2   (connect_sent events for l1 + l2)
 *   connectionRate.accepted = 1   (connected event for l1 only)
 *   connectionRate.rate     = 50.0 (1/2 × 100, Math.round(500)/10)
 *   replyRate.sent          = 2   (message_sent for l1 + l2)
 *   replyRate.replied       = 1   (replied for l1 only)
 *   replyRate.positiveReplied = 2 (leads at sales_intent or meeting_booked: both l1+l2)
 *   replyRate.replyRate     = 50.0 (1/2 × 100)
 *   replyRate.positiveRate  = 200.0 (2 positives / 1 replied × 100 — ratio can exceed 100%)
 *   leadQualityBySource.length = 2 (search + feed)
 *   scoreCalibration.length  = 1  (only l1 has a lead_scores row → high band)
 *   autoRunHistory.length    = 1  (1 completed run)
 */
// biome-ignore lint/suspicious/noExplicitAny: pre-builder DB type
function seedPopulatedFixture(db: any): { c1: string; c2: string; l1: string; l2: string } {
  const now = Date.now();
  const c1 = randomUUID();
  const c2 = randomUUID();
  const l1 = randomUUID();
  const l2 = randomUUID();

  // Candidates
  for (const [id, src] of [[c1, "search"], [c2, "feed"]] as const) {
    db.prepare(`
      INSERT INTO raw_candidates (id, person_name, profile_url, account_id, source,
        observed_at, last_seen_at, status, evidence_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, "Lead Person", `https://linkedin.com/in/lead-${id.slice(0,6)}/`,
      null, src, now, now, "promoted", "fixture");
  }

  // Leads: l1 → meeting_booked (score 80), l2 → sales_intent (score 55)
  db.prepare(`
    INSERT INTO leads (id, candidate_id, account_id, person_name, profile_url,
      stage, total_score, confidence, one_line_pain_chain, next_action,
      next_action_due_at, owner_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(l1, c1, null, "Lead 1", "https://linkedin.com/in/l1/",
    "meeting_booked", 80, 0.8, "pain", null, null, "manual", now, now);
  db.prepare(`
    INSERT INTO leads (id, candidate_id, account_id, person_name, profile_url,
      stage, total_score, confidence, one_line_pain_chain, next_action,
      next_action_due_at, owner_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(l2, c2, null, "Lead 2", "https://linkedin.com/in/l2/",
    "sales_intent", 55, 0.7, "pain", null, null, "auto", now, now);

  // Timeline events (9 total)
  const events: Array<readonly [string, string, string]> = [
    [c1, l1, "connect_sent"],
    [c1, l1, "connected"],
    [c1, l1, "message_sent"],
    [c1, l1, "replied"],
    [c1, l1, "sales_intent_detected"],
    [c1, l1, "meeting_booked"],
    [c2, l2, "connect_sent"],
    [c2, l2, "message_sent"],
    [c2, l2, "sales_intent_detected"],
  ];
  for (const [cid, lid, etype] of events) {
    db.prepare(`
      INSERT INTO lead_timeline (id, candidate_id, lead_id, event_type, ts, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), cid, lid, etype, now, null);
  }

  // lead_scores row for l1 only (l2 has no score row → excluded from calibration)
  const sc = randomUUID();
  db.prepare(`
    INSERT INTO lead_scores (id, candidate_id, lead_id, total_score, icp_fit,
      pain_hypothesis, buying_trigger, authority_level, suggested_opening_line,
      confidence, next_action, evidence_json, method_used, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sc, c1, l1, 80, "Strong", "pain", "trigger", "VP", "opening",
    0.8, "next", "{}", "Pain Chain", "deepseek", now);

  // auto_runs row: started 10 min ago, completed now
  db.prepare(`
    INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes,
      max_connects, status, summary, counters)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), now - 600000, now, 15, 5, "completed",
    "Done", JSON.stringify({ connects: 2 }));

  return { c1, c2, l1, l2 };
}

// ─── T-F.Tool.1 ─────────────────────────────────────────────────────────────────

describe("T-F.Tool.1 — get_sales_report populated fixture → full envelope + nested bundles (G-PSPF.10)", () => {
  it("T-F.Tool.1: when get_sales_report is invoked on a populated fixture DB, returns ok=true envelope with 10 data keys and correct nested bundle shapes", async () => {
    // Given: a tmp salesDb path with 2 candidates, 2 leads, timeline events,
    //        1 lead_scores row, 1 auto_runs row (seedPopulatedFixture)
    // When:  makeGetSalesReportTool(path).execute({}) called (no sinceMs → all-time)
    // Then:  result.ok===true; data has 10 keys (funnelSummary, meetingBooked,
    //        salesIntent, connectionRate, replyRate, leadQualityBySource,
    //        scoreCalibration, autoRunHistory, generatedAt, sinceMs);
    //        meetingBooked===1; salesIntent.count===2; salesIntent.contacted===2;
    //        leadQualityBySource.length===2; autoRunHistory.length===1
    const path = makeTmpPath();
    const db = openSalesDatabase(path);
    try {
      seedPopulatedFixture(db);
      // Tool calls openSalesDatabase(path) which returns the cached handle — shared connection OK.
      const result = await makeGetSalesReportTool(path).execute({});

      // Envelope shape
      assert.equal(result.ok, true, "result.ok must be true");
      assert.equal(result.command, "get_sales_report", "result.command must be 'get_sales_report'");
      assert.ok(result.data, "result.data must be present");

      // 10 data keys
      const dataKeys = Object.keys(result.data).sort();
      const expectedDataKeys = [
        "autoRunHistory", "connectionRate", "funnelSummary",
        "generatedAt", "leadQualityBySource", "meetingBooked",
        "replyRate", "salesIntent", "scoreCalibration", "sinceMs",
      ].sort();
      assert.deepEqual(dataKeys, expectedDataKeys, "data must have exactly 10 keys");

      // Primary KPI: meetingBooked count
      assert.equal(result.data.meetingBooked, 1, "meetingBooked must === 1 (1 meeting_booked event)");

      // salesIntent nested bundle: count=2, contacted=2, rate=100.0
      assert.equal(result.data.salesIntent.count, 2, "salesIntent.count must === 2 (l1 + l2)");
      assert.equal(result.data.salesIntent.contacted, 2, "salesIntent.contacted must === 2 (l1 + l2)");
      assert.equal(result.data.salesIntent.rate, 100.0, "salesIntent.rate must === 100.0 (2/2 × 100)");

      // connectionRate nested bundle: sent=2, accepted=1, rate=50.0
      assert.ok("sent" in result.data.connectionRate, "connectionRate must have .sent");
      assert.ok("accepted" in result.data.connectionRate, "connectionRate must have .accepted");
      assert.ok("rate" in result.data.connectionRate, "connectionRate must have .rate");
      assert.equal(result.data.connectionRate.sent, 2, "connectionRate.sent must === 2");
      assert.equal(result.data.connectionRate.accepted, 1, "connectionRate.accepted must === 1");
      assert.equal(result.data.connectionRate.rate, 50.0, "connectionRate.rate must === 50.0 (Math.round(500)/10)");

      // replyRate nested bundle: sent=2, replied=1, positiveReplied=2, replyRate=50.0, positiveRate=200.0
      assert.ok("sent" in result.data.replyRate, "replyRate must have .sent");
      assert.ok("replied" in result.data.replyRate, "replyRate must have .replied");
      assert.ok("positiveReplied" in result.data.replyRate, "replyRate must have .positiveReplied");
      assert.ok("replyRate" in result.data.replyRate, "replyRate must have .replyRate");
      assert.ok("positiveRate" in result.data.replyRate, "replyRate must have .positiveRate");
      assert.equal(result.data.replyRate.sent, 2, "replyRate.sent must === 2");
      assert.equal(result.data.replyRate.replied, 1, "replyRate.replied must === 1");
      assert.equal(result.data.replyRate.positiveReplied, 2, "replyRate.positiveReplied must === 2 (both leads in positive stages)");
      assert.equal(result.data.replyRate.replyRate, 50.0, "replyRate.replyRate must === 50.0 (1/2 × 100)");
      assert.equal(result.data.replyRate.positiveRate, 200.0, "replyRate.positiveRate must === 200.0 (2 positives / 1 replied × 100)");

      // Quality by source: 2 groups (search + feed)
      assert.equal(result.data.leadQualityBySource.length, 2, "leadQualityBySource must have 2 source groups");

      // Score calibration: 1 band (high — only l1 has a lead_scores row, score=80)
      assert.equal(result.data.scoreCalibration.length, 1, "scoreCalibration must have 1 band (high only)");
      assert.equal(result.data.scoreCalibration[0].scoreBand, "high (70-100)", "high band must be present");
      assert.equal(result.data.scoreCalibration[0].leads, 1, "high band leads must === 1");
      assert.equal(result.data.scoreCalibration[0].advanced, 1, "high band advanced must === 1 (meeting_booked is advanced)");
      assert.equal(result.data.scoreCalibration[0].advanceRate, 1.0, "high band advanceRate must === 1.0 (fraction, not %)");

      // Auto run history: 1 completed run (duration=10min)
      assert.equal(result.data.autoRunHistory.length, 1, "autoRunHistory must have 1 entry");
      assert.equal(result.data.autoRunHistory[0].status, "completed", "auto run status must be 'completed'");
      assert.equal(result.data.autoRunHistory[0].durationMinutes, 10, "auto run duration must be 10 minutes");

      // Metadata fields
      assert.equal(typeof result.data.generatedAt, "number", "generatedAt must be a number (Unix ms)");
      assert.equal(result.data.sinceMs, null, "sinceMs must be null when not passed");
    } finally {
      closeSalesDatabase(path);
    }
  });
});

// ─── T-F.Tool.2 ─────────────────────────────────────────────────────────────────

describe("T-F.Tool.2 — get_sales_report sinceMs filter → post-cutoff metrics only (G-PSPF.10)", () => {
  it("T-F.Tool.2: when sinceMs is set 10s in the future, all pre-cutoff events are excluded and counts are 0 (G-PSPF.10)", async () => {
    // Given: a tmp salesDb path with seedPopulatedFixture (all events seeded at now);
    //        futureCutoff = Date.now() + 10000 (10 seconds in the future — all events before it)
    // When:  makeGetSalesReportTool(path).execute({sinceMs: futureCutoff}) called
    // Then:  result.ok===true; meetingBooked===0; salesIntent.count===0;
    //        salesIntent.contacted===0; salesIntent.rate===null (contacted===0);
    //        connectionRate.sent===0; connectionRate.rate===null;
    //        replyRate.replyRate===null; replyRate.positiveRate===null;
    //        leadQualityBySource.length===0; scoreCalibration.length===0;
    //        autoRunHistory.length===0; data.sinceMs === futureCutoff
    const path = makeTmpPath();
    const db = openSalesDatabase(path);
    try {
      seedPopulatedFixture(db);
      // Cut-off is well in the future → all seeded events (at now) are excluded
      const futureCutoff = Date.now() + 10000;
      const result = await makeGetSalesReportTool(path).execute({ sinceMs: futureCutoff });

      assert.equal(result.ok, true, "result.ok must be true");

      // All counts filtered to zero
      assert.equal(result.data.meetingBooked, 0, "meetingBooked must === 0 (future cutoff)");
      assert.equal(result.data.salesIntent.count, 0, "salesIntent.count must === 0");
      assert.equal(result.data.salesIntent.contacted, 0, "salesIntent.contacted must === 0");
      assert.equal(result.data.salesIntent.rate, null, "salesIntent.rate must === null (contacted=0)");

      assert.equal(result.data.connectionRate.sent, 0, "connectionRate.sent must === 0");
      assert.equal(result.data.connectionRate.accepted, 0, "connectionRate.accepted must === 0");
      assert.equal(result.data.connectionRate.rate, null, "connectionRate.rate must === null (sent=0)");

      assert.equal(result.data.replyRate.sent, 0, "replyRate.sent must === 0");
      assert.equal(result.data.replyRate.replied, 0, "replyRate.replied must === 0");
      assert.equal(result.data.replyRate.positiveReplied, 0, "replyRate.positiveReplied must === 0");
      assert.equal(result.data.replyRate.replyRate, null, "replyRate.replyRate must === null (sent=0)");
      assert.equal(result.data.replyRate.positiveRate, null, "replyRate.positiveRate must === null (replied=0)");

      // All 8 funnel stage counts must be 0 (leads.created_at < futureCutoff)
      const funnel = result.data.funnelSummary;
      for (const key of ["scored", "qualified", "connect_sent", "connected", "replied", "sales_intent", "meeting_booked", "disqualified"]) {
        // biome-ignore lint/suspicious/noExplicitAny: funnel is typed but we iterate
        assert.equal((funnel as any)[key], 0, `funnelSummary.${key} must === 0 (future sinceMs)`);
      }

      assert.equal(result.data.leadQualityBySource.length, 0, "leadQualityBySource must be empty (rc.observed_at < futureCutoff)");
      assert.equal(result.data.scoreCalibration.length, 0, "scoreCalibration must be empty (ls.created_at < futureCutoff)");
      assert.equal(result.data.autoRunHistory.length, 0, "autoRunHistory must be empty (started_at < futureCutoff)");

      // sinceMs echoed back in the envelope
      assert.equal(result.data.sinceMs, futureCutoff, "data.sinceMs must === the passed-in futureCutoff");
    } finally {
      closeSalesDatabase(path);
    }
  });
});

// ─── T-F.Tool.3 ─────────────────────────────────────────────────────────────────

describe("T-F.Tool.3 — get_sales_report empty DB → all-zero counts, rates null (G-PSPF.10)", () => {
  it("T-F.Tool.3: when get_sales_report is invoked on an empty DB (no rows), all counts are 0 and all rates are null (G-PSPF.10)", async () => {
    // Given: a tmp salesDb path opened with openSalesDatabase (schema applied), no rows seeded
    // When:  makeGetSalesReportTool(path).execute({}) called
    // Then:  result.ok===true; meetingBooked===0; salesIntent.count===0;
    //        salesIntent.contacted===0; salesIntent.rate===null;
    //        connectionRate.sent===0; connectionRate.rate===null;
    //        replyRate.replyRate===null; replyRate.positiveRate===null;
    //        leadQualityBySource.length===0; scoreCalibration.length===0;
    //        autoRunHistory.length===0;
    //        ALL 8 funnelSummary stage counts === 0
    const path = makeTmpPath();
    openSalesDatabase(path); // open so schema is created (empty)
    try {
      const result = await makeGetSalesReportTool(path).execute({});

      assert.equal(result.ok, true, "result.ok must be true even for empty DB");
      assert.equal(result.command, "get_sales_report", "result.command must be 'get_sales_report'");

      // Primary KPI
      assert.equal(result.data.meetingBooked, 0, "meetingBooked must === 0 (empty DB)");

      // salesIntent bundle: all zero, rate null
      assert.equal(result.data.salesIntent.count, 0, "salesIntent.count must === 0");
      assert.equal(result.data.salesIntent.contacted, 0, "salesIntent.contacted must === 0");
      assert.equal(result.data.salesIntent.rate, null, "salesIntent.rate must === null (contacted=0 → OQ-F6)");

      // connectionRate bundle: all zero, rate null
      assert.equal(result.data.connectionRate.sent, 0, "connectionRate.sent must === 0");
      assert.equal(result.data.connectionRate.accepted, 0, "connectionRate.accepted must === 0");
      assert.equal(result.data.connectionRate.rate, null, "connectionRate.rate must === null (sent=0 → OQ-F6)");

      // replyRate bundle: all zero, both rates null
      assert.equal(result.data.replyRate.sent, 0, "replyRate.sent must === 0");
      assert.equal(result.data.replyRate.replied, 0, "replyRate.replied must === 0");
      assert.equal(result.data.replyRate.positiveReplied, 0, "replyRate.positiveReplied must === 0");
      assert.equal(result.data.replyRate.replyRate, null, "replyRate.replyRate must === null (sent=0 → OQ-F6)");
      assert.equal(result.data.replyRate.positiveRate, null, "replyRate.positiveRate must === null (replied=0 → OQ-F6)");

      // All 8 funnelSummary stage counts === 0
      const funnel = result.data.funnelSummary;
      for (const key of ["scored", "qualified", "connect_sent", "connected", "replied", "sales_intent", "meeting_booked", "disqualified"]) {
        // biome-ignore lint/suspicious/noExplicitAny: funnel is typed but we iterate
        assert.equal((funnel as any)[key], 0, `funnelSummary.${key} must === 0 (empty DB)`);
      }

      // Empty arrays for data collections
      assert.deepEqual(result.data.leadQualityBySource, [], "leadQualityBySource must be [] (empty DB)");
      assert.deepEqual(result.data.scoreCalibration, [], "scoreCalibration must be [] (empty DB)");
      assert.deepEqual(result.data.autoRunHistory, [], "autoRunHistory must be [] (empty DB)");

      // sinceMs === null when not passed
      assert.equal(result.data.sinceMs, null, "sinceMs must be null (not passed)");
    } finally {
      closeSalesDatabase(path);
    }
  });
});
