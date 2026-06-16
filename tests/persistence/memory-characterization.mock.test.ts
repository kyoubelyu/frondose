/**
 * P-72 slice 8 — characterization tests for src/persistence/memory.ts
 *
 * Six tests that pin the load-bearing behavior of the pre-split memory module:
 * open/schema lifecycle, appendPersonInteraction semantics (append-not-upsert),
 * URL normalization, and FTS5 search. These tests GREEN today against the
 * pre-split file and MUST STAY GREEN post-split via the barrel (G-P72s8.1).
 *
 * All tests use :memory: SQLite paths for full test isolation.
 * No Chrome or LLM required. No network access.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Database as DB } from "better-sqlite3";
import Database from "better-sqlite3";
import {
  appendPersonInteraction,
  CURRENT_SCHEMA_VERSION,
  closeMemoryDatabase,
  getPersonMemory,
  normalizeProfileUrl,
  openMemoryDatabase,
  searchMemory,
  setPersonScore,
} from "../../src/persistence/memory.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── T-Memory.Open.1 ─────────────────────────────────────────────────────────

describe("T-Memory.Open — schema lifecycle on a fresh :memory: DB", () => {
  it("T-Memory.Open.1: when openMemoryDatabase(':memory:') is called, creates full V3 schema with all tables, triggers, and schema_version MAX===3", () => {
    // Given: no pre-existing DB
    // When:  openMemoryDatabase(":memory:") is called
    // Then:  all V3 tables + FTS triggers exist; schema_version MAX(version) === 3; CURRENT_SCHEMA_VERSION === 3
    const db = openMemoryDatabase(":memory:");

    // Required tables
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
      name: string;
    }>;
    const tableNames = tables.map((t) => t.name);
    assert.ok(tableNames.includes("person_memory_events"), "person_memory_events must exist");
    assert.ok(tableNames.includes("schema_version"), "schema_version must exist");
    assert.ok(tableNames.includes("person_scores"), "person_scores must exist (V3)");
    assert.ok(tableNames.includes("general_memory"), "general_memory must exist (V3)");

    // FTS5 virtual table — appears in sqlite_master as type='table' with name 'memory_fts'
    const fts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'").get() as
      | { name: string }
      | undefined;
    assert.ok(fts !== undefined, "memory_fts virtual table must exist (V3)");

    // schema_version MAX must be 3
    const vRow = db.prepare("SELECT MAX(version) AS maxVer FROM schema_version").get() as { maxVer: number };
    assert.equal(vRow.maxVer, 3, "schema_version MAX(version) must be 3");

    // Exported constant must be 3
    assert.equal(CURRENT_SCHEMA_VERSION, 3, "CURRENT_SCHEMA_VERSION exported from barrel must be 3");

    // FTS5 triggers must exist (AI / AD / AU)
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all() as Array<{
      name: string;
    }>;
    const triggerNames = triggers.map((t) => t.name);
    assert.ok(triggerNames.includes("memory_fts_ai"), "memory_fts_ai trigger must exist");
    assert.ok(triggerNames.includes("memory_fts_ad"), "memory_fts_ad trigger must exist");
    assert.ok(triggerNames.includes("memory_fts_au"), "memory_fts_au trigger must exist");

    closeMemoryDatabase(db);
  });

  // ─── T-Memory.Open.2 ───────────────────────────────────────────────────────

  it("T-Memory.Open.2: when a V2-state file DB is opened via openMemoryDatabase, it migrates to V3 and backfills FTS", () => {
    // Given: a file DB seeded with V1+V2 DDL + 2 existing rows (no V3 yet)
    // When:  openMemoryDatabase(path) is called against the V2-state file
    // Then:  MAX(version) === 3; FTS5 tables exist; memory_fts has 2 rows (backfill ran)
    const dir = mkdtempSync(join(tmpdir(), `mai-p72s8-open2-${process.pid}-`));
    after(() => cleanupTmpDir(dir));
    const tmpPath = join(dir, "memory.sqlite");

    // Build V2 state manually (V1 + V2 DDL + version rows 1+2 + 2 data rows)
    const rawDb = new Database(tmpPath);
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS person_memory_events (
        id TEXT PRIMARY KEY,
        profile_url TEXT NOT NULL,
        person_name TEXT NOT NULL,
        interaction TEXT NOT NULL,
        summary TEXT NOT NULL,
        notes TEXT,
        avoid TEXT,
        next_action TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_person_memory_profile_url ON person_memory_events (profile_url, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_person_memory_person_name ON person_memory_events (person_name, created_at DESC);
      ALTER TABLE person_memory_events ADD COLUMN source_worker_id TEXT;
      ALTER TABLE person_memory_events ADD COLUMN source_hostname TEXT;
      ALTER TABLE person_memory_events ADD COLUMN source_persona TEXT;
      ALTER TABLE person_memory_events ADD COLUMN ts INTEGER;
      INSERT INTO schema_version (version) VALUES (1);
      INSERT INTO schema_version (version) VALUES (2);
    `);
    // Insert 2 data rows before migration (FTS backfill assertion)
    rawDb
      .prepare(
        `INSERT INTO person_memory_events (id, profile_url, person_name, interaction, summary, created_at)
         VALUES ('id-1', 'https://www.linkedin.com/in/alpha/', 'Alpha User', 'connect', 'Met at conference', ?)`,
      )
      .run(new Date().toISOString());
    rawDb
      .prepare(
        `INSERT INTO person_memory_events (id, profile_url, person_name, interaction, summary, created_at)
         VALUES ('id-2', 'https://www.linkedin.com/in/beta/', 'Beta User', 'message', 'Follow-up about proposal', ?)`,
      )
      .run(new Date().toISOString());
    rawDb.close();

    // Now open via the public API — triggers V3 migration + backfill
    const db = openMemoryDatabase(tmpPath);

    const vRow = db.prepare("SELECT MAX(version) AS maxVer FROM schema_version").get() as { maxVer: number };
    assert.equal(vRow.maxVer, 3, "MAX(version) must be 3 after migration");

    // V3 tables must exist
    const person_scores = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='person_scores'")
      .get() as { name: string } | undefined;
    assert.ok(person_scores !== undefined, "person_scores must exist after V3 migration");
    const general_memory = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='general_memory'")
      .get() as { name: string } | undefined;
    assert.ok(general_memory !== undefined, "general_memory must exist after V3 migration");

    // FTS backfill: the 2 pre-migration rows must appear in memory_fts
    // For FTS5 external-content tables, count the content table for row count
    const contentCount = db.prepare("SELECT COUNT(*) AS c FROM person_memory_events").get() as { c: number };
    assert.equal(contentCount.c, 2, "person_memory_events must have 2 rows (pre-migration data preserved)");

    // Verify FTS search works on the backfilled data
    const hits = searchMemory("conference", 10, db);
    assert.ok(hits.length >= 1, "FTS backfill: 'conference' must match at least 1 row");
    assert.equal(hits[0].personName, "Alpha User", "FTS backfill: first hit should be Alpha User");

    closeMemoryDatabase(db);
  });
});

// ─── T-Memory.Append ─────────────────────────────────────────────────────────

describe("T-Memory.Append — appendPersonInteraction semantics", () => {
  it("T-Memory.Append.1: when appendPersonInteraction is called with a new profile_url, returns MemoryEvent with normalized URL + row exists in DB", () => {
    // Given: fresh :memory: V3 DB
    // When:  appendPersonInteraction called with a URL without trailing slash
    // Then:  returned MemoryEvent has normalized profile_url; row in DB has normalized URL; attribution NULL semantics
    const db = openMemoryDatabase(":memory:");

    const event = appendPersonInteraction(
      {
        personName: "Alice",
        profileUrl: "https://www.linkedin.com/in/alice",
        interaction: "message",
        summary: "First contact about CRM tool",
      },
      db,
    );

    // Returned event fields
    assert.ok(typeof event.id === "string" && event.id.length > 0, "event.id must be a UUID-shaped string");
    assert.equal(event.personName, "Alice");
    // URL must be normalized (trailing slash added)
    assert.equal(event.profileUrl, "https://www.linkedin.com/in/alice/", "profileUrl must be normalized");
    assert.equal(event.interaction, "message");
    assert.equal(event.summary, "First contact about CRM tool");
    assert.equal(event.notes, undefined, "notes must be undefined when not supplied");
    assert.equal(event.avoid, undefined, "avoid must be undefined when not supplied");
    assert.equal(event.nextAction, undefined, "nextAction must be undefined when not supplied");
    assert.ok(typeof event.createdAt === "string" && event.createdAt.length > 0, "createdAt must be ISO-8601");

    // DB row must exist with normalized URL
    const row = db.prepare("SELECT * FROM person_memory_events WHERE id = ?").get(event.id) as
      | Record<string, unknown>
      | undefined;
    assert.ok(row !== undefined, "row must exist in person_memory_events");
    assert.equal(row.profile_url, "https://www.linkedin.com/in/alice/", "DB profile_url must be normalized");

    // Attribution columns: NULL when not supplied
    assert.equal(row.source_worker_id, null, "source_worker_id must be NULL when not supplied");
    assert.equal(row.source_hostname, null, "source_hostname must be NULL when not supplied");
    assert.equal(row.source_persona, null, "source_persona must be NULL when not supplied");
    assert.equal(row.ts, null, "ts must be NULL when not supplied");

    // Edge case: attribution columns populated when supplied
    const eventWithAttrib = appendPersonInteraction(
      {
        personName: "Alice",
        profileUrl: "https://www.linkedin.com/in/alice/",
        interaction: "connect",
        summary: "Server sync attribution test",
        sourceWorkerId: "worker-1",
        sourceHostname: "host-a",
        sourcePersona: "persona-x",
        ts: 1234567890,
      },
      db,
    );
    const rowWithAttrib = db.prepare("SELECT * FROM person_memory_events WHERE id = ?").get(eventWithAttrib.id) as
      | Record<string, unknown>
      | undefined;
    assert.ok(rowWithAttrib !== undefined);
    assert.equal(rowWithAttrib.source_worker_id, "worker-1");
    assert.equal(rowWithAttrib.source_hostname, "host-a");
    assert.equal(rowWithAttrib.source_persona, "persona-x");
    assert.equal(rowWithAttrib.ts, 1234567890);

    closeMemoryDatabase(db);
  });

  it("T-Memory.Append.2: when appendPersonInteraction is called twice with the same profile_url, produces TWO distinct events (event-log, NOT upsert)", async () => {
    // Given: fresh :memory: DB; first appendPersonInteraction already ran for alice
    // When:  a second appendPersonInteraction runs for the same profile_url with a different summary
    // Then:  COUNT(*) === 2; both have distinct UUIDs; getPersonMemory returns history.length===2 with latestInteraction===second summary
    const db = openMemoryDatabase(":memory:");

    const event1 = appendPersonInteraction(
      {
        personName: "Alice",
        profileUrl: "https://www.linkedin.com/in/alice/",
        interaction: "connect",
        summary: "First event: connected",
      },
      db,
    );

    // Small delay so the second event has a strictly newer createdAt (ISO-8601 lexical ordering)
    await new Promise<void>((r) => setTimeout(r, 5));

    const event2 = appendPersonInteraction(
      {
        personName: "Alice",
        profileUrl: "https://www.linkedin.com/in/alice/",
        interaction: "message",
        summary: "Second event: follow-up message",
      },
      db,
    );

    // UUIDs must be distinct
    assert.notEqual(event1.id, event2.id, "both events must have distinct IDs");

    // COUNT(*) must be 2 — not an upsert
    const countRow = db
      .prepare("SELECT COUNT(*) AS c FROM person_memory_events WHERE profile_url = ?")
      .get("https://www.linkedin.com/in/alice/") as { c: number };
    assert.equal(countRow.c, 2, "COUNT(*) must be 2 — event-log semantics, not upsert");

    // getPersonMemory must see history.length === 2 and latestInteraction === second event
    const projection = getPersonMemory({ profileUrl: "https://www.linkedin.com/in/alice/" }, db);
    assert.ok(projection !== undefined, "projection must exist");
    assert.equal(projection.history.length, 2, "history must have 2 events");
    assert.equal(
      projection.latestInteraction.summary,
      "Second event: follow-up message",
      "latestInteraction must be the second (most recent) event",
    );

    closeMemoryDatabase(db);
  });
});

// ─── T-Memory.NormalizeUrl.1 ─────────────────────────────────────────────────

describe("T-Memory.NormalizeUrl — normalizeProfileUrl pure function", () => {
  it("T-Memory.NormalizeUrl.1: normalizeProfileUrl is deterministic + idempotent + pure across 5 URL variants", () => {
    // Given: 5 representative URL variants
    // When:  each is passed to normalizeProfileUrl
    // Then:  each output ends in exactly one '/'; idempotency holds; pure (no side effects)
    const cases: Array<[string, string]> = [
      ["https://www.linkedin.com/in/alice", "https://www.linkedin.com/in/alice/"],
      ["https://www.linkedin.com/in/alice/", "https://www.linkedin.com/in/alice/"],
      ["https://www.linkedin.com/in/alice///", "https://www.linkedin.com/in/alice/"],
      ["https://www.linkedin.com/in/with-dash/", "https://www.linkedin.com/in/with-dash/"],
      ["https://www.linkedin.com/in/utf8-名/", "https://www.linkedin.com/in/utf8-名/"],
    ];

    for (const [input, expected] of cases) {
      const result = normalizeProfileUrl(input);
      assert.equal(result, expected, `normalizeProfileUrl("${input}") must equal "${expected}"`);

      // Idempotency: applying twice gives same result
      const resultTwice = normalizeProfileUrl(result);
      assert.equal(resultTwice, result, `normalizeProfileUrl must be idempotent for input "${input}"`);

      // Ends in exactly one '/'
      assert.ok(result.endsWith("/"), `result must end with '/'`);
      assert.ok(!result.endsWith("//"), `result must NOT end with '//'`);
    }

    // Pure: calling 10 times with the same input produces same output
    const url = "https://www.linkedin.com/in/alice";
    const results = Array.from({ length: 10 }, () => normalizeProfileUrl(url));
    assert.ok(
      results.every((r) => r === results[0]),
      "normalizeProfileUrl must be pure: 10 calls produce the same result",
    );
  });
});

// ─── T-Memory.Search.1 ───────────────────────────────────────────────────────

describe("T-Memory.Search — searchMemory FTS5 behavior", () => {
  it("T-Memory.Search.1: searchMemory on 3-event seed returns 2 CRM hits with snippet + bm25 ordering; empty/punctuation queries return []", async () => {
    // Given: :memory: DB with 3 interactions (Alice+CRM, Bob+Salesforce, Carol+CRM)
    // When:  searchMemory("CRM", 10, db) is called
    // Then:  2 hits (Alice + Carol); each has snippet bracketed [CRM]; hits ordered ASC by bm25Rank; edge: score populated via LEFT JOIN
    const db = openMemoryDatabase(":memory:");

    appendPersonInteraction(
      {
        personName: "Alice",
        profileUrl: "https://www.linkedin.com/in/alice/",
        interaction: "message",
        summary: "Discussed CRM platform integration",
      },
      db,
    );

    await new Promise<void>((r) => setTimeout(r, 5));

    appendPersonInteraction(
      {
        personName: "Bob",
        profileUrl: "https://www.linkedin.com/in/bob/",
        interaction: "connect",
        summary: "Connected at Salesforce conference",
      },
      db,
    );

    await new Promise<void>((r) => setTimeout(r, 5));

    appendPersonInteraction(
      {
        personName: "Carol",
        profileUrl: "https://www.linkedin.com/in/carol/",
        interaction: "like",
        summary: "Liked CRM article about pipelines",
      },
      db,
    );

    const hits = searchMemory("CRM", 10, db);

    // Must return exactly 2 hits (Alice + Carol match "CRM"; Bob does not)
    assert.equal(hits.length, 2, "searchMemory('CRM') must return 2 hits");

    // Each hit must have all required fields
    for (const hit of hits) {
      assert.ok(typeof hit.id === "string" && hit.id.length > 0, "hit.id must be non-empty");
      assert.ok(typeof hit.personName === "string", "hit.personName must be string");
      assert.ok(typeof hit.profileUrl === "string", "hit.profileUrl must be string");
      assert.ok(typeof hit.interaction === "string", "hit.interaction must be string");
      assert.ok(typeof hit.summary === "string", "hit.summary must be string");
      assert.ok(typeof hit.snippet === "string", "hit.snippet must be string");
      assert.ok(typeof hit.bm25Rank === "number", "hit.bm25Rank must be number");
      assert.ok(typeof hit.createdAt === "string", "hit.createdAt must be string");
    }

    // Snippet must contain [CRM] brackets (FTS5 snippet with '[' ']' markers)
    for (const hit of hits) {
      assert.ok(hit.snippet.includes("[CRM]"), `snippet must include '[CRM]', got: "${hit.snippet}"`);
    }

    // bm25Rank ASC ordering (best rank = most negative bm25 comes first)
    assert.ok(hits[0].bm25Rank <= hits[1].bm25Rank, "hits must be ordered ASC by bm25Rank (best first)");

    // Edge case 1: empty query returns []
    const emptyHits = searchMemory("", 10, db);
    assert.equal(emptyHits.length, 0, "searchMemory('') must return []");

    // Edge case 2: punctuation-only query returns [] (toFtsMatchQuery sanitization)
    const punctHits = searchMemory(":: ** ()", 10, db);
    assert.equal(punctHits.length, 0, "searchMemory(':: ** ()') must return [] after sanitization");

    // Edge case 3: setPersonScore populates score field via LEFT JOIN
    setPersonScore("https://www.linkedin.com/in/alice/", 7, db);
    const scoredHits = searchMemory("CRM", 10, db);
    const aliceHit = scoredHits.find((h) => h.personName === "Alice");
    const carolHit = scoredHits.find((h) => h.personName === "Carol");
    assert.ok(aliceHit !== undefined, "Alice hit must be present after setPersonScore");
    assert.equal(aliceHit.score, 7, "Alice's score must be 7 from LEFT JOIN with person_scores");
    assert.ok(carolHit !== undefined, "Carol hit must be present");
    assert.equal(carolHit.score, null, "Carol's score must be null (no score set)");

    closeMemoryDatabase(db);
  });
});
