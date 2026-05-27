/**
 * P-SP-F Step 5 — T-F.FunnelSummary.1/2, T-F.MeetingBooked.1, T-F.SalesIntent.1/2/3,
 *   T-F.Rates.Connect.1/2, T-F.Rates.Reply.1/2, T-F.QualityBySource.1/2,
 *   T-F.ScoreCalibration.1, T-F.AutoRunHistory.1
 *
 * Assertion bodies FILLED at Step 5.
 *
 * Gates covered:
 *   G-PSPF.1 (FunnelSummary per-stage counts)
 *   G-PSPF.2 (FunnelSummary empty-DB graceful)
 *   G-PSPF.3 (MeetingBookedCount timeline events)
 *   G-PSPF.4 (SalesIntentRate count+rate, null-rate)
 *   G-PSPF.5 (ConnectionRates sent/accepted/rate, null-rate)
 *   G-PSPF.6 (ReplyRates sent/replied/positive/rate, null-rate)
 *   G-PSPF.7 (QualityBySource breakdown + LEFT JOIN all-sources)
 *   G-PSPF.8 (ScoreCalibration banding + advanced-stage contract)
 *   G-PSPF.9 (AutoRunHistory ordered DESC + counters JSON parse)
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/persistence/salesAnalytics.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: pre-builder stubs
type AnyFn = (...args: any[]) => any;
// biome-ignore lint/suspicious/noExplicitAny: pre-builder DB type
type DB = any;

// ─── Module stubs — resolved after builder ships salesAnalytics.ts ─────────────

let openSalesDatabase: AnyFn;
let closeSalesDatabase: AnyFn;

// salesAnalytics.ts exports (Step 4a: may not exist yet)
let getFunnelSummary: AnyFn;
let getMeetingBookedCount: AnyFn;
let getSalesIntentRate: AnyFn;
let getConnectionRates: AnyFn;
let getReplyRates: AnyFn;
let getLeadQualityBySource: AnyFn;
let getScoreCalibration: AnyFn;
let getAutoRunHistory: AnyFn;

before(async () => {
  // biome-ignore lint/suspicious/noExplicitAny: pre-builder resolution
  const dbMod = (await import("../../src/persistence/salesDb.js").catch(() => null)) as any;
  openSalesDatabase = dbMod?.openSalesDatabase ?? null;
  closeSalesDatabase = dbMod?.closeSalesDatabase ?? null;

  // biome-ignore lint/suspicious/noExplicitAny: pre-builder resolution
  const aMod = (await import("../../src/persistence/salesAnalytics.js").catch(() => null)) as any;
  getFunnelSummary = aMod?.getFunnelSummary ?? null;
  getMeetingBookedCount = aMod?.getMeetingBookedCount ?? null;
  getSalesIntentRate = aMod?.getSalesIntentRate ?? null;
  getConnectionRates = aMod?.getConnectionRates ?? null;
  getReplyRates = aMod?.getReplyRates ?? null;
  getLeadQualityBySource = aMod?.getLeadQualityBySource ?? null;
  getScoreCalibration = aMod?.getScoreCalibration ?? null;
  getAutoRunHistory = aMod?.getAutoRunHistory ?? null;
});

// ─── Shared helpers ─────────────────────────────────────────────────────────────

/** Create an isolated DB at a unique tmp path per test (no cross-test bleed). */
function makeTmpPath(): string {
  return join(tmpdir(), `sp-f-analytics-test-${randomUUID()}.sqlite`);
}

/** Open a fresh DB at a tmp path. Caller is responsible for closeSalesDatabase. */
function makeDb(): { db: DB; path: string } {
  const path = makeTmpPath();
  const db = openSalesDatabase(path);
  return { db, path };
}

/** Insert a raw_candidates row; returns candidateId. */
function seedCandidate(db: DB, source = "search"): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO raw_candidates (id, person_name, profile_url, account_id, source,
      observed_at, last_seen_at, status, evidence_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, "Test Person", `https://linkedin.com/in/test-${id.slice(0, 6)}/`, null,
    source, now, now, "new", "fixture");
  return id;
}

/** Insert a leads row linked to a candidate; returns leadId. */
function seedLead(db: DB, candidateId: string, stage: string): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO leads (id, candidate_id, account_id, person_name, profile_url,
      stage, total_score, confidence, one_line_pain_chain, next_action,
      next_action_due_at, owner_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, candidateId, null, "Test Lead", `https://linkedin.com/in/lead-${id.slice(0, 6)}/`,
    stage, 60, 0.7, "test pain", null, null, "manual", now, now);
  // Update candidate status to promoted
  db.prepare("UPDATE raw_candidates SET status='promoted' WHERE id=?").run(candidateId);
  return id;
}

/** Insert a lead_scores row for a lead; returns scoreId. */
function seedScore(db: DB, candidateId: string, leadId: string, score: number): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO lead_scores (id, candidate_id, lead_id, total_score, icp_fit,
      pain_hypothesis, buying_trigger, authority_level, suggested_opening_line,
      confidence, next_action, evidence_json, method_used, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, candidateId, leadId, score, "Strong", "test pain", "trigger",
    "VP", "opening line", 0.8, "next", "{}", "Pain Chain", "deepseek", now);
  return id;
}

/** Insert a lead_timeline row for a lead+candidate. */
function seedTimelineEvent(db: DB, candidateId: string, leadId: string | null, eventType: string, tsOffset = 0): void {
  db.prepare(`
    INSERT INTO lead_timeline (id, candidate_id, lead_id, event_type, ts, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), candidateId, leadId, eventType, Date.now() + tsOffset, null);
}

/** Insert an auto_runs row; returns runId. */
function seedAutoRun(db: DB, status: string, startedOffset = 0, endedOffset: number | null = null, countersJson: string | null = null): string {
  const id = randomUUID();
  const now = Date.now();
  const startedAt = now + startedOffset;
  const endedAt = endedOffset !== null ? now + endedOffset : null;
  db.prepare(`
    INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, startedAt, endedAt, 15, 5, status,
    status !== "running" ? "Run complete" : null,
    countersJson);
  return id;
}

// ─── T-F.FunnelSummary.1 ────────────────────────────────────────────────────────

describe("T-F.FunnelSummary — getFunnelSummary per-stage counts (G-PSPF.1)", () => {
  it("T-F.FunnelSummary.1: when 5 leads exist at known stages, getFunnelSummary returns correct per-stage counts (G-PSPF.1)", () => {
    // Given: in-memory DB with 5 leads: 2 × 'qualified', 1 × 'connect_sent',
    //        1 × 'connected', 1 × 'meeting_booked'
    // When:  getFunnelSummary(db) called
    // Then:  returned object has qualified=2, connect_sent=1, connected=1,
    //        meeting_booked=1, and all other stage counts === 0
    const { db, path } = makeDb();
    try {
      const c1 = seedCandidate(db); seedLead(db, c1, "qualified");
      const c2 = seedCandidate(db); seedLead(db, c2, "qualified");
      const c3 = seedCandidate(db); seedLead(db, c3, "connect_sent");
      const c4 = seedCandidate(db); seedLead(db, c4, "connected");
      const c5 = seedCandidate(db); seedLead(db, c5, "meeting_booked");

      const result = getFunnelSummary(db);

      assert.equal(result.qualified, 2, "qualified count should be 2");
      assert.equal(result.connect_sent, 1, "connect_sent count should be 1");
      assert.equal(result.connected, 1, "connected count should be 1");
      assert.equal(result.meeting_booked, 1, "meeting_booked count should be 1");
      assert.equal(result.scored, 0, "scored count should be 0 (none seeded)");
      assert.equal(result.replied, 0, "replied count should be 0");
      assert.equal(result.sales_intent, 0, "sales_intent count should be 0");
      assert.equal(result.disqualified, 0, "disqualified count should be 0");
      // All 8 keys must be present
      assert.ok("scored" in result, "result must have 'scored' key");
      assert.ok("qualified" in result, "result must have 'qualified' key");
      assert.ok("connect_sent" in result, "result must have 'connect_sent' key");
      assert.ok("connected" in result, "result must have 'connected' key");
      assert.ok("replied" in result, "result must have 'replied' key");
      assert.ok("sales_intent" in result, "result must have 'sales_intent' key");
      assert.ok("meeting_booked" in result, "result must have 'meeting_booked' key");
      assert.ok("disqualified" in result, "result must have 'disqualified' key");
    } finally {
      closeSalesDatabase(path);
    }
  });
});

// ─── T-F.FunnelSummary.2 ────────────────────────────────────────────────────────

describe("T-F.FunnelSummary.2 — getFunnelSummary empty-DB graceful (G-PSPF.2)", () => {
  it("T-F.FunnelSummary.2: when leads table is empty, getFunnelSummary returns all 8 stage keys with count 0 (G-PSPF.2)", () => {
    // Given: freshly opened in-memory DB with no rows in any table
    // When:  getFunnelSummary(db) called
    // Then:  returned object has exactly the 8 stage keys (scored, qualified, connect_sent,
    //        connected, replied, sales_intent, meeting_booked, disqualified) each === 0
    const { db, path } = makeDb();
    try {
      const result = getFunnelSummary(db);

      for (const stage of ["scored", "qualified", "connect_sent", "connected", "replied", "sales_intent", "meeting_booked", "disqualified"]) {
        assert.ok(stage in result, `result must have '${stage}' key`);
        assert.equal(result[stage], 0, `${stage} must be 0 on empty DB`);
      }
      // All 8 keys should be present (no SQL error, no missing keys)
      assert.equal(Object.keys(result).length, 8, "result must have exactly 8 keys");
    } finally {
      closeSalesDatabase(path);
    }
  });
});

// ─── T-F.MeetingBooked.1 ────────────────────────────────────────────────────────

describe("T-F.MeetingBooked.1 — getMeetingBookedCount from lead_timeline (G-PSPF.3)", () => {
  it("T-F.MeetingBooked.1: when 2 meeting_booked timeline events exist, getMeetingBookedCount returns 2 (G-PSPF.3)", () => {
    // Given: in-memory DB with 2 candidates, 2 leads, 2 lead_timeline rows of
    //        event_type='meeting_booked' + 1 row of event_type='connected' (non-target)
    // When:  getMeetingBookedCount(db) called
    // Then:  result === 2 (counts timeline events, not lead stage)
    const { db, path } = makeDb();
    try {
      const c1 = seedCandidate(db);
      const l1 = seedLead(db, c1, "meeting_booked");
      const c2 = seedCandidate(db);
      const l2 = seedLead(db, c2, "meeting_booked");

      seedTimelineEvent(db, c1, l1, "meeting_booked");
      seedTimelineEvent(db, c2, l2, "meeting_booked");
      // This 'connected' event should NOT be counted
      seedTimelineEvent(db, c1, l1, "connected");

      const result = getMeetingBookedCount(db);
      assert.equal(result, 2, "getMeetingBookedCount should return 2 (only meeting_booked events)");
    } finally {
      closeSalesDatabase(path);
    }
  });
});

// ─── T-F.SalesIntent.1/2/3 ──────────────────────────────────────────────────────

describe("T-F.SalesIntent — getSalesIntentRate count+contacted+rate (G-PSPF.4)", () => {
  it("T-F.SalesIntent.1: 3 sales_intent_detected events / 2 distinct leads + 4 contacted → getSalesIntentRate returns {count:2, contacted:4, rate:50.0} (G-PSPF.4)", () => {
    // Given: in-memory DB with 4 leads; 2 of those leads have 'sales_intent_detected'
    //        events (one lead has 2 events → DISTINCT count = 2); all 4 contacted
    //        via 'connect_sent' or 'message_sent' events
    // When:  getSalesIntentRate(db) called
    // Then:  returned bundle has count=2, contacted=4, rate=50.0
    const { db, path } = makeDb();
    try {
      // 4 leads, all contacted
      const leads: Array<{ candidateId: string; leadId: string }> = [];
      for (let i = 0; i < 4; i++) {
        const cId = seedCandidate(db);
        const lId = seedLead(db, cId, "connected");
        leads.push({ candidateId: cId, leadId: lId });
        // All 4 contacted via connect_sent
        seedTimelineEvent(db, cId, lId, "connect_sent");
      }
      // 2 of those leads have sales_intent_detected events
      // Lead 0: 2 events (DISTINCT count = 1 for this lead)
      seedTimelineEvent(db, leads[0].candidateId, leads[0].leadId, "sales_intent_detected");
      seedTimelineEvent(db, leads[0].candidateId, leads[0].leadId, "sales_intent_detected");
      // Lead 1: 1 event
      seedTimelineEvent(db, leads[1].candidateId, leads[1].leadId, "sales_intent_detected");

      const result = getSalesIntentRate(db);
      assert.equal(result.count, 2, "count should be 2 (DISTINCT leads with sales_intent_detected)");
      assert.equal(result.contacted, 4, "contacted should be 4 (DISTINCT leads with connect_sent/message_sent)");
      // rate = Math.round((2 * 1000) / 4) / 10 = Math.round(500) / 10 = 50.0
      assert.equal(result.rate, 50.0, "rate should be 50.0 percent");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("T-F.SalesIntent.2: 0 sales_intent events + 5 contacted leads → getSalesIntentRate returns {count:0, contacted:5, rate:0.0} (G-PSPF.4)", () => {
    // Given: in-memory DB with 5 leads each having a 'connect_sent' event but zero
    //        'sales_intent_detected' events
    // When:  getSalesIntentRate(db) called
    // Then:  returned bundle has count=0, contacted=5, rate=0.0
    const { db, path } = makeDb();
    try {
      for (let i = 0; i < 5; i++) {
        const cId = seedCandidate(db);
        const lId = seedLead(db, cId, "connected");
        seedTimelineEvent(db, cId, lId, "connect_sent");
      }

      const result = getSalesIntentRate(db);
      assert.equal(result.count, 0, "count should be 0 (no sales_intent_detected events)");
      assert.equal(result.contacted, 5, "contacted should be 5");
      // rate = Math.round((0 * 1000) / 5) / 10 = 0.0 (NOT null — denominator > 0)
      assert.equal(result.rate, 0.0, "rate should be 0.0 (not null) when contacted > 0");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("T-F.SalesIntent.3: 0 contacted leads → getSalesIntentRate returns {count:0, contacted:0, rate:null} (G-PSPF.4)", () => {
    // Given: fresh empty in-memory DB (no leads, no timeline events)
    // When:  getSalesIntentRate(db) called
    // Then:  returned bundle has count=0, contacted=0, rate=null
    const { db, path } = makeDb();
    try {
      const result = getSalesIntentRate(db);
      assert.equal(result.count, 0, "count should be 0 (empty DB)");
      assert.equal(result.contacted, 0, "contacted should be 0 (empty DB)");
      assert.strictEqual(result.rate, null, "rate should be null (divide-by-zero per OQ-F6)");
    } finally {
      closeSalesDatabase(path);
    }
  });
});

// ─── T-F.Rates.Connect.1/2 ──────────────────────────────────────────────────────

describe("T-F.Rates.Connect — getConnectionRates sent/accepted/rate (G-PSPF.5)", () => {
  it("T-F.Rates.Connect.1: 5 connect_sent + 3 connected events → getConnectionRates returns {sent:5, accepted:3, rate:60.0} (G-PSPF.5)", () => {
    // Given: in-memory DB with 5 lead_timeline rows event_type='connect_sent'
    //        and 3 rows event_type='connected'
    // When:  getConnectionRates(db) called
    // Then:  returned bundle has sent=5, accepted=3, rate=60.0
    const { db, path } = makeDb();
    try {
      // Need leads to attach timeline events to
      const leads: Array<{ candidateId: string; leadId: string }> = [];
      for (let i = 0; i < 5; i++) {
        const cId = seedCandidate(db);
        const lId = seedLead(db, cId, "connected");
        leads.push({ candidateId: cId, leadId: lId });
        seedTimelineEvent(db, cId, lId, "connect_sent");
      }
      // Only 3 of them have 'connected' events
      for (let i = 0; i < 3; i++) {
        seedTimelineEvent(db, leads[i].candidateId, leads[i].leadId, "connected");
      }

      const result = getConnectionRates(db);
      assert.equal(result.sent, 5, "sent should be 5");
      assert.equal(result.accepted, 3, "accepted should be 3");
      // rate = Math.round((3 * 1000) / 5) / 10 = Math.round(600) / 10 = 60.0
      assert.equal(result.rate, 60.0, "rate should be 60.0 percent");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("T-F.Rates.Connect.2: 0 connect_sent events → getConnectionRates returns {sent:0, accepted:0, rate:null} (G-PSPF.5)", () => {
    // Given: fresh empty in-memory DB (no timeline events)
    // When:  getConnectionRates(db) called
    // Then:  returned bundle has sent=0, accepted=0, rate=null (null per OQ-F6)
    const { db, path } = makeDb();
    try {
      const result = getConnectionRates(db);
      assert.equal(result.sent, 0, "sent should be 0 (empty DB)");
      assert.equal(result.accepted, 0, "accepted should be 0 (empty DB)");
      assert.strictEqual(result.rate, null, "rate should be null (divide-by-zero per OQ-F6)");
    } finally {
      closeSalesDatabase(path);
    }
  });
});

// ─── T-F.Rates.Reply.1/2 ────────────────────────────────────────────────────────

describe("T-F.Rates.Reply — getReplyRates sent/replied/positiveReplied/rates (G-PSPF.6)", () => {
  it("T-F.Rates.Reply.1: 3 message_sent + 2 replied events + 1 lead at sales_intent stage → getReplyRates {sent:3, replied:2, positiveReplied:1, replyRate:66.7, positiveRate:50.0} (G-PSPF.6)", () => {
    // Given: in-memory DB with 3 'message_sent' events, 2 'replied' events,
    //        and 1 lead at stage='sales_intent' (positiveReplied counts leads.stage
    //        IN ('sales_intent','meeting_booked'))
    // When:  getReplyRates(db) called
    // Then:  returned bundle has sent=3, replied=2, positiveReplied=1,
    //        replyRate=66.7, positiveRate=50.0
    const { db, path } = makeDb();
    try {
      // 3 leads, each with a message_sent event
      const leads: Array<{ candidateId: string; leadId: string }> = [];
      for (let i = 0; i < 3; i++) {
        const cId = seedCandidate(db);
        const stage = i === 0 ? "sales_intent" : "connected";
        const lId = seedLead(db, cId, stage);
        leads.push({ candidateId: cId, leadId: lId });
        seedTimelineEvent(db, cId, lId, "message_sent");
      }
      // 2 of the 3 have 'replied' events
      seedTimelineEvent(db, leads[0].candidateId, leads[0].leadId, "replied");
      seedTimelineEvent(db, leads[1].candidateId, leads[1].leadId, "replied");
      // leads[0] is at 'sales_intent' stage → positiveReplied = 1

      const result = getReplyRates(db);
      assert.equal(result.sent, 3, "sent should be 3");
      assert.equal(result.replied, 2, "replied should be 2");
      assert.equal(result.positiveReplied, 1, "positiveReplied should be 1 (sales_intent stage count)");
      // replyRate = Math.round((2*1000)/3)/10 = Math.round(666.7)/10 = 66.7
      assert.equal(result.replyRate, 66.7, "replyRate should be 66.7");
      // positiveRate = Math.round((1*1000)/2)/10 = 50.0
      assert.equal(result.positiveRate, 50.0, "positiveRate should be 50.0");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("T-F.Rates.Reply.2: 0 message_sent events → getReplyRates returns sent=0, replied=0, positiveReplied=0, replyRate=null, positiveRate=null (G-PSPF.6)", () => {
    // Given: fresh empty in-memory DB
    // When:  getReplyRates(db) called
    // Then:  all counts 0, both rates null (OQ-F6 graceful empty)
    const { db, path } = makeDb();
    try {
      const result = getReplyRates(db);
      assert.equal(result.sent, 0, "sent should be 0");
      assert.equal(result.replied, 0, "replied should be 0");
      assert.equal(result.positiveReplied, 0, "positiveReplied should be 0");
      assert.strictEqual(result.replyRate, null, "replyRate should be null (divide-by-zero)");
      assert.strictEqual(result.positiveRate, null, "positiveRate should be null (divide-by-zero)");
    } finally {
      closeSalesDatabase(path);
    }
  });
});

// ─── T-F.QualityBySource.1/2 ────────────────────────────────────────────────────

describe("T-F.QualityBySource — getLeadQualityBySource breakdown + LEFT JOIN (G-PSPF.7)", () => {
  it("T-F.QualityBySource.1: 3 candidates across 2 sources with known lead/engagement counts → correct breakdown per source (G-PSPF.7)", () => {
    // Given: in-memory DB with 3 candidates:
    //   - 2 from source='search' (1 promoted to lead at stage='connected', 1 not promoted)
    //   - 1 from source='feed' (promoted to lead at stage='meeting_booked')
    // When:  getLeadQualityBySource(db) called
    // Then:  result has 2 rows; 'search' has totalCandidates=2, totalLeads=1,
    //        engaged=1, meetingsBooked=0; 'feed' has totalCandidates=1,
    //        totalLeads=1, engaged=1, meetingsBooked=1
    const { db, path } = makeDb();
    try {
      // 2 search candidates (1 promoted to lead at connected, 1 stays as new)
      const cSearch1 = seedCandidate(db, "search");
      seedLead(db, cSearch1, "connected");  // promoted + engaged

      const cSearch2 = seedCandidate(db, "search");
      // NOT promoted to lead (stays as new candidate)

      // 1 feed candidate promoted to meeting_booked
      const cFeed = seedCandidate(db, "feed");
      seedLead(db, cFeed, "meeting_booked");  // promoted + engaged + meeting

      const result = getLeadQualityBySource(db);

      // Should have 2 source groups
      assert.equal(result.length, 2, "should have 2 source groups (search + feed)");

      const searchRow = result.find((r: any) => r.source === "search");
      const feedRow = result.find((r: any) => r.source === "feed");

      assert.ok(searchRow, "should have a 'search' group");
      assert.ok(feedRow, "should have a 'feed' group");

      assert.equal(searchRow.totalCandidates, 2, "search: totalCandidates should be 2");
      assert.equal(searchRow.totalLeads, 1, "search: totalLeads should be 1 (1 promoted)");
      assert.equal(searchRow.engaged, 1, "search: engaged should be 1 (connected)");
      assert.equal(searchRow.meetingsBooked, 0, "search: meetingsBooked should be 0");

      assert.equal(feedRow.totalCandidates, 1, "feed: totalCandidates should be 1");
      assert.equal(feedRow.totalLeads, 1, "feed: totalLeads should be 1");
      assert.equal(feedRow.engaged, 1, "feed: engaged should be 1 (meeting_booked is engaged)");
      assert.equal(feedRow.meetingsBooked, 1, "feed: meetingsBooked should be 1");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("T-F.QualityBySource.2: candidates from all 7 source enum values → result includes all 7 groups (LEFT JOIN preserves zero-lead sources) (G-PSPF.7)", () => {
    // Given: in-memory DB with exactly 7 candidates, one per source type:
    //        'search','profile-nav','click','feed','company','memory','auto'
    //        (none are promoted to leads)
    // When:  getLeadQualityBySource(db) called
    // Then:  result has 7 rows covering all 7 source enum values; each row has
    //        totalCandidates=1, totalLeads=0, engaged=0, meetingsBooked=0
    const { db, path } = makeDb();
    try {
      const sources = ["search", "profile-nav", "click", "feed", "company", "memory", "auto"];
      for (const src of sources) {
        seedCandidate(db, src);  // no leads
      }

      const result = getLeadQualityBySource(db);

      assert.equal(result.length, 7, "should have 7 source groups (one per source type)");

      for (const src of sources) {
        const row = result.find((r: any) => r.source === src);
        assert.ok(row, `should have a '${src}' group`);
        assert.equal(row.totalCandidates, 1, `${src}: totalCandidates should be 1`);
        assert.equal(row.totalLeads, 0, `${src}: totalLeads should be 0 (not promoted)`);
        assert.equal(row.engaged, 0, `${src}: engaged should be 0`);
        assert.equal(row.meetingsBooked, 0, `${src}: meetingsBooked should be 0`);
      }
    } finally {
      closeSalesDatabase(path);
    }
  });
});

// ─── T-F.ScoreCalibration.1 ─────────────────────────────────────────────────────

describe("T-F.ScoreCalibration.1 — getScoreCalibration banding + advanced-stage contract (G-PSPF.8)", () => {
  it("T-F.ScoreCalibration.1: 3 high-band leads (scores 75,82,90) / 2 advanced + 3 low-band (15,22,30) / 0 advanced → 2 bands; connect_sent + disqualified NOT counted as advanced (G-PSPF.8)", () => {
    // Given: in-memory DB with 6 leads, each with a lead_scores row:
    //   High band (70-100): scores 75, 82, 90; stages: 'connected', 'replied',
    //     'connect_sent' (connect_sent NOT advanced per plan §5.6.3 Sketch A)
    //   Low band (0-39): scores 15, 22, 30; stages: 'disqualified',
    //     'qualified', 'scored' (none are advanced)
    // When:  getScoreCalibration(db) called
    // Then:  result has 2 rows (high band + low band; no mid-band candidates);
    //        high-band row: leads=3, advanced=2, advanceRate=0.667;
    //        low-band row: leads=3, advanced=0, advanceRate=0.0
    const { db, path } = makeDb();
    try {
      // HIGH band (70-100): 3 leads at scores 75, 82, 90
      // stages: connected (advanced), replied (advanced), connect_sent (NOT advanced)
      const highData = [
        { score: 75, stage: "connected" },   // advanced ✓
        { score: 82, stage: "replied" },     // advanced ✓
        { score: 90, stage: "connect_sent" }, // NOT advanced (at threshold, not past it)
      ];
      for (const { score, stage } of highData) {
        const cId = seedCandidate(db);
        const lId = seedLead(db, cId, stage);
        seedScore(db, cId, lId, score);
      }

      // LOW band (0-39): 3 leads at scores 15, 22, 30
      // stages: disqualified (NOT advanced — terminal negative), qualified (pre-connect), scored (pre-connect)
      const lowData = [
        { score: 15, stage: "disqualified" }, // NOT advanced (terminal negative)
        { score: 22, stage: "qualified" },    // NOT advanced (pre-connect)
        { score: 30, stage: "scored" },       // NOT advanced (pre-connect)
      ];
      for (const { score, stage } of lowData) {
        const cId = seedCandidate(db);
        const lId = seedLead(db, cId, stage);
        seedScore(db, cId, lId, score);
      }

      const result = getScoreCalibration(db);

      assert.equal(result.length, 2, "should have 2 score bands (high + low; no mid-band)");

      const highBand = result.find((r: any) => r.scoreBand === "high (70-100)");
      const lowBand = result.find((r: any) => r.scoreBand === "low (0-39)");

      assert.ok(highBand, "should have a high (70-100) band");
      assert.ok(lowBand, "should have a low (0-39) band");

      assert.equal(highBand.leads, 3, "high band: leads should be 3");
      assert.equal(highBand.advanced, 2, "high band: advanced should be 2 (connected + replied)");
      // advanceRate = Math.round((2*1000)/3)/1000 = Math.round(666.7)/1000 = 0.667
      assert.equal(highBand.advanceRate, 0.667, "high band: advanceRate should be 0.667");

      assert.equal(lowBand.leads, 3, "low band: leads should be 3");
      assert.equal(lowBand.advanced, 0, "low band: advanced should be 0");
      // advanceRate = Math.round((0*1000)/3)/1000 = 0.0 → but check: 0/3 = 0; Math.round(0)/1000 = 0
      assert.equal(lowBand.advanceRate, 0, "low band: advanceRate should be 0");

      // Explicit exclusion verification:
      // connect_sent is NOT advanced (the high-band lead at connect_sent should NOT be counted)
      // disqualified is NOT advanced (the low-band lead at disqualified should NOT be counted)
      // qualified/scored are NOT advanced (pre-connect)
      // Verified by: highBand.advanced=2 (not 3) and lowBand.advanced=0 (not 1)
    } finally {
      closeSalesDatabase(path);
    }
  });
});

// ─── T-F.AutoRunHistory.1 ───────────────────────────────────────────────────────

describe("T-F.AutoRunHistory.1 — getAutoRunHistory ordered DESC + counters JSON parse (G-PSPF.9)", () => {
  it("T-F.AutoRunHistory.1: 3 auto_runs (1 running + 2 terminal with counters JSON) → returned ordered DESC by startedAt; counters parsed to Record<string,number> (G-PSPF.9)", () => {
    // Given: in-memory DB with 3 auto_runs:
    //   run-1 (oldest): status='completed', counters='{"connects":2,"messages":1}'
    //   run-2 (middle): status='stopped_by_agent', counters='{"connects":0}'
    //   run-3 (newest): status='running', counters=null
    // When:  getAutoRunHistory(db, 10) called
    // Then:  result has 3 rows ordered newest-first;
    //        row[0].status === 'running', row[0].counters === null;
    //        row[1].status === 'stopped', row[1].counters.connects === 0;
    //        row[2].status === 'completed', row[2].counters.connects === 2
    const { db, path } = makeDb();
    try {
      const now = Date.now();
      // Oldest: completed with counters
      db.prepare(`
        INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), now - 120000, now - 60000, 15, 5, "completed", "Run complete",
        JSON.stringify({ connects: 2, messages: 1 }));

      // Middle: stopped_by_agent with counters (valid enum per salesDb.ts CHECK constraint)
      db.prepare(`
        INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), now - 60000, now - 30000, 15, 5, "stopped_by_agent", "Stopped by agent",
        JSON.stringify({ connects: 0 }));

      // Newest: running, no counters
      db.prepare(`
        INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), now - 10000, null, 15, 5, "running", null, null);

      const result = getAutoRunHistory(db, 10);

      assert.equal(result.length, 3, "should have 3 auto_run rows");

      // Ordered by started_at DESC (newest first)
      assert.equal(result[0].status, "running", "row[0] (newest) should be 'running'");
      assert.strictEqual(result[0].counters, null, "row[0] (running) counters should be null");
      assert.strictEqual(result[0].durationMinutes, null, "row[0] (running) durationMinutes should be null");

      assert.equal(result[1].status, "stopped_by_agent", "row[1] (middle) should be 'stopped_by_agent'");
      assert.ok(result[1].counters !== null, "row[1] counters should be parsed (not null)");
      assert.equal(result[1].counters.connects, 0, "row[1].counters.connects should be 0");
      assert.ok(result[1].durationMinutes !== null, "row[1] (stopped) durationMinutes should be non-null");

      assert.equal(result[2].status, "completed", "row[2] (oldest) should be 'completed'");
      assert.ok(result[2].counters !== null, "row[2] counters should be parsed");
      assert.equal(result[2].counters.connects, 2, "row[2].counters.connects should be 2");
      assert.equal(result[2].counters.messages, 1, "row[2].counters.messages should be 1");
      assert.ok(result[2].durationMinutes !== null, "row[2] (completed) durationMinutes should be non-null");
    } finally {
      closeSalesDatabase(path);
    }
  });
});
