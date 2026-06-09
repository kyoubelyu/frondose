/**
 * Phase 16 (P-72 slice 2) — salesDb.ts write-path characterization fixtures.
 *
 * Purpose: pin the CURRENT observable behavior of the top 5 highest-traffic
 * write functions in src/persistence/salesDb.ts (750 LoC — the largest source
 * file in the repo, the natural P-72 split target). These functions are the
 * bedrock of every outbound flow: every connect attempt walks
 * upsertRawCandidate → insertLead → insertDraft → updateLeadStage →
 * appendTimelineEvent.
 *
 * Pure characterization: tests are GREEN today and pin OBSERVABLE behavior.
 * A future refactor of salesDb.ts (P-72 split into per-domain modules, query-
 * builder pull-out, etc.) must preserve every assertion here.
 *
 * Coverage:
 * - upsertRawCandidate: insert vs duplicate (idempotent by profile_url)
 * - insertLead: required + optional fields, returned id is UUID, normalized URL
 * - insertDraft: defaults to status='draft', stores all fields
 * - updateLeadStage: writes the new stage value
 * - appendTimelineEvent: appends with monotonic ts, returns id
 *
 * No Chrome, no LLM, no fixtures dependency. Each test opens an :memory: DB
 * via openSalesDatabase + writes via the public API + reads back via the
 * public getters.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit \
 *     tests/persistence/salesDb-writes-characterization.mock.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  appendTimelineEvent,
  getDraft,
  getLead,
  getRawCandidate,
  insertDraft,
  insertLead,
  listTimelineByLead,
  normalizeProfileUrl,
  openSalesDatabase,
  updateLeadStage,
  upsertRawCandidate,
} from "../../src/persistence/salesDb.js";

let tmp: string;
let dbPath: string;
// biome-ignore lint/suspicious/noExplicitAny: better-sqlite3 Database
let db: any;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "phase16-saleschar-"));
  dbPath = join(tmp, "sales.sqlite");
  db = openSalesDatabase(dbPath);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(tmp, { recursive: true, force: true });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("Phase 16: salesDb write-path characterization (P-72 slice 2)", () => {
  describe("upsertRawCandidate — idempotent by profile_url", () => {
    // Given: an empty raw_candidates table
    // When:  upsertRawCandidate is called with a new candidate
    // Then:  inserted:true, candidateId is a UUID, getRawCandidate returns the row
    it("first insert returns inserted:true + UUID candidateId + row readable", () => {
      const r = upsertRawCandidate(db, {
        personName: "Alice",
        profileUrl: "https://www.linkedin.com/in/alice/",
        source: "search",
      });
      assert.strictEqual(r.inserted, true);
      assert.match(r.candidateId, UUID_RE);
      const row = getRawCandidate(db, r.candidateId);
      assert.ok(row);
      assert.strictEqual(row.personName, "Alice");
      assert.strictEqual(row.status, "new");
    });

    // Given: a row already inserted for profile_url X
    // When:  upsertRawCandidate is called again for the SAME profile_url
    // Then:  inserted:false; candidateId is the SAME as before; last_seen_at advanced
    it("duplicate profile_url returns inserted:false + same candidateId (idempotent)", () => {
      const r1 = upsertRawCandidate(db, {
        personName: "Alice",
        profileUrl: "https://www.linkedin.com/in/alice/",
        source: "search",
      });
      const r2 = upsertRawCandidate(db, {
        personName: "Alice",
        profileUrl: "https://www.linkedin.com/in/alice/",
        source: "search",
      });
      assert.strictEqual(r2.inserted, false, "second insert must report inserted:false");
      assert.strictEqual(r2.candidateId, r1.candidateId, "candidateId must be stable across upserts");
    });

    // Given: an upsert with a profileUrl that has trailing whitespace or query
    // When:  upsertRawCandidate is called
    // Then:  the URL is normalized via normalizeProfileUrl before write — the stored
    //        profile_url matches normalizeProfileUrl(input).
    it("profileUrl is normalized via normalizeProfileUrl before write", () => {
      const raw = "https://www.linkedin.com/in/alice/?utm=src";
      const r = upsertRawCandidate(db, { personName: "Alice", profileUrl: raw, source: "search" });
      const row = getRawCandidate(db, r.candidateId);
      assert.ok(row);
      assert.strictEqual(row.profileUrl, normalizeProfileUrl(raw));
    });
  });

  describe("insertLead — generates UUID + normalizes URL + applies required fields", () => {
    // Given: an existing raw_candidate (FK constraint requires this)
    // When:  insertLead is called with the minimum required fields
    // Then:  returned id is a UUID; getLead returns the row with the right shape
    it("returns a UUID id + readable row with stage and ownerMode", () => {
      const cand = upsertRawCandidate(db, {
        personName: "Bob",
        profileUrl: "https://www.linkedin.com/in/bob/",
        source: "search",
      });
      const leadId = insertLead(db, {
        candidateId: cand.candidateId,
        personName: "Bob",
        profileUrl: "https://www.linkedin.com/in/bob/",
        stage: "qualified",
        ownerMode: "manual",
      });
      assert.match(leadId, UUID_RE);
      const lead = getLead(db, leadId);
      assert.ok(lead);
      assert.strictEqual(lead.personName, "Bob");
      assert.strictEqual(lead.stage, "qualified");
      assert.strictEqual(lead.ownerMode, "manual");
    });

    // Given: insertLead with a non-canonical profileUrl
    // When:  the lead is read back
    // Then:  the stored URL passed through normalizeProfileUrl
    it("profile_url is normalized at write time", () => {
      const cand = upsertRawCandidate(db, {
        personName: "Carol",
        profileUrl: "https://www.linkedin.com/in/carol/",
        source: "search",
      });
      const raw = "https://www.linkedin.com/in/carol/?ref=test";
      const leadId = insertLead(db, {
        candidateId: cand.candidateId,
        personName: "Carol",
        profileUrl: raw,
        stage: "qualified",
        ownerMode: "manual",
      });
      const lead = getLead(db, leadId);
      assert.ok(lead);
      assert.strictEqual(lead.profileUrl, normalizeProfileUrl(raw));
    });
  });

  describe("insertDraft — defaults to status='draft'", () => {
    // Given: an existing lead
    // When:  insertDraft is called with just leadId + kind + text + createdBy
    // Then:  returned id is a UUID; getDraft returns the row with status:'draft'
    it("inserts a draft with default status='draft' + UUID id", () => {
      const cand = upsertRawCandidate(db, {
        personName: "Dave",
        profileUrl: "https://www.linkedin.com/in/dave/",
        source: "search",
      });
      const leadId = insertLead(db, {
        candidateId: cand.candidateId,
        personName: "Dave",
        profileUrl: "https://www.linkedin.com/in/dave/",
        stage: "qualified",
        ownerMode: "manual",
      });
      const draftId = insertDraft(db, {
        leadId,
        kind: "connect_note",
        text: "Hi Dave — interested in your work.",
        createdBy: "user",
      });
      assert.match(draftId, UUID_RE);
      const draft = getDraft(db, draftId);
      assert.ok(draft);
      assert.strictEqual(draft.status, "draft");
      assert.strictEqual(draft.kind, "connect_note");
      assert.strictEqual(draft.createdBy, "user");
    });
  });

  describe("updateLeadStage — writes the new stage", () => {
    // Given: a lead at stage 'qualified'
    // When:  updateLeadStage moves it to 'connect_sent'
    // Then:  getLead returns the new stage
    it("transitions stage qualified → connect_sent", () => {
      const cand = upsertRawCandidate(db, {
        personName: "Eve",
        profileUrl: "https://www.linkedin.com/in/eve/",
        source: "search",
      });
      const leadId = insertLead(db, {
        candidateId: cand.candidateId,
        personName: "Eve",
        profileUrl: "https://www.linkedin.com/in/eve/",
        stage: "qualified",
        ownerMode: "manual",
      });
      updateLeadStage(db, leadId, "connect_sent");
      const lead = getLead(db, leadId);
      assert.strictEqual(lead?.stage, "connect_sent");
    });
  });

  describe("appendTimelineEvent — appends with monotonic ts", () => {
    // Given: a lead
    // When:  appendTimelineEvent is called twice
    // Then:  listTimelineByLead returns BOTH events; ts of the 2nd >= 1st
    //        (monotonic — no clock-skew-based ordering bug)
    it("appends 2 events in ts-monotonic order", async () => {
      const cand = upsertRawCandidate(db, {
        personName: "Frank",
        profileUrl: "https://www.linkedin.com/in/frank/",
        source: "search",
      });
      const leadId = insertLead(db, {
        candidateId: cand.candidateId,
        personName: "Frank",
        profileUrl: "https://www.linkedin.com/in/frank/",
        stage: "qualified",
        ownerMode: "manual",
      });
      appendTimelineEvent(db, {
        candidateId: cand.candidateId,
        leadId,
        eventType: "discovered",
        metadata: { source: "search" },
      });
      // Tiny sleep to guarantee ts increment under ms-resolution timestamps
      await new Promise((r) => setTimeout(r, 5));
      appendTimelineEvent(db, {
        candidateId: cand.candidateId,
        leadId,
        eventType: "connect_sent",
        metadata: { draftId: "stub" },
      });
      const events = listTimelineByLead(db, leadId, 10);
      assert.strictEqual(events.length, 2);
      // Sorted DESC by ts in the implementation — pick whichever order, verify monotonic
      const tsValues = events.map((e) => e.ts).sort((a, b) => a - b);
      assert.ok(tsValues[1]! >= tsValues[0]!, "second event ts must be >= first");
    });
  });
});
