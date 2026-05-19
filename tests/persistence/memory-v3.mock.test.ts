/**
 * P-39 Step 5 — T-Migration.1-4, T-FtsSync.1-3, T-Search.1-3, T-Score.1-4, T-Note.1-3
 *   + toFtsMatchQuery sub-tests.
 *
 * All assertions filled. Gates: G-P39.1, G-P39.2, G-P39.3, G-P39.4,
 *   G-P39.5, G-P39.6, G-P39.7, G-P39.12.
 *
 * Isolation: persistence functions accept explicit `db: DB` — tests use
 * `openMemoryDatabase(":memory:")` for lightweight isolation (does NOT go
 * through the _dbHandle.ts module-level cache, so no cross-test contamination).
 * T-Migration.2/.3 use real temp files (`:memory:` can't survive close/reopen).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Database as DB } from "better-sqlite3";
import Database from "better-sqlite3";
import {
  appendPersonInteraction,
  CURRENT_SCHEMA_VERSION,
  getMemoryNote,
  getPersonScore,
  openMemoryDatabase,
  searchMemory,
  setMemoryNote,
  setPersonScore,
  toFtsMatchQuery,
} from "../../src/persistence/memory.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function freshDb(): DB {
  return openMemoryDatabase(":memory:");
}

function makeTmpDb(): { tmpPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `mai-p39-v3-${process.pid}-`));
  const tmpPath = join(dir, "memory.sqlite");
  return { tmpPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Build a V2-state DB at `tmpPath`: V1+V2 tables, 3 rows, schema_version rows 1+2. */
function buildV2Db(tmpPath: string): void {
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
      created_at TEXT NOT NULL,
      source_worker_id TEXT,
      source_hostname TEXT,
      source_persona TEXT,
      ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_person_memory_profile_url
      ON person_memory_events (profile_url, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_person_memory_person_name
      ON person_memory_events (person_name, created_at DESC);
  `);
  rawDb.prepare("INSERT INTO schema_version (version) VALUES (?)").run(1);
  rawDb.prepare("INSERT INTO schema_version (version) VALUES (?)").run(2);
  // 3 rows, row-2 has the unique backfill token
  for (let i = 1; i <= 3; i++) {
    const summary = i === 2 ? "FINTECH_TEST_TOKEN enterprise pitch deck" : `row${i} generic content here`;
    rawDb
      .prepare(
        "INSERT INTO person_memory_events (id, profile_url, person_name, interaction, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        `id-v2-${i}`,
        `https://www.linkedin.com/in/person${i}/`,
        `Person ${i}`,
        "message",
        summary,
        new Date().toISOString(),
      );
  }
  rawDb.close();
}

const ALICE_INPUT = {
  personName: "Alice Wang",
  profileUrl: "https://www.linkedin.com/in/alice-wang-v3test/",
  interaction: "message" as const,
  summary: "Discussed B2B SaaS pricing with Alice; she showed fintech interest.",
};

// ─── T-Migration ──────────────────────────────────────────────────────────────

describe("V3 migration — fresh DB schema (G-P39.1/.3)", () => {
  it("T-Migration.1: when openMemoryDatabase(':memory:'), schema_version top row = 3 AND sqlite_master has person_scores + general_memory + memory_fts + triggers", () => {
    // Given: no existing DB
    // When:  openMemoryDatabase(":memory:") runs
    // Then:  schema_version=3; sqlite_master contains all 6 V3 objects
    const db = freshDb();

    const vrow = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as {
      version: number;
    };
    assert.equal(vrow.version, 3, "schema_version top row must be 3");

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','shadow') AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    const triggers = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>
    ).map((r) => r.name);

    assert.ok(tables.includes("person_scores"), "person_scores must exist");
    assert.ok(tables.includes("general_memory"), "general_memory must exist");
    // memory_fts creates shadow tables; verify the virtual table entry
    const vtables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    assert.ok(vtables.includes("memory_fts"), "memory_fts virtual table must exist");

    assert.ok(triggers.includes("memory_fts_ai"), "memory_fts_ai trigger must exist");
    assert.ok(triggers.includes("memory_fts_ad"), "memory_fts_ad trigger must exist");
    assert.ok(triggers.includes("memory_fts_au"), "memory_fts_au trigger must exist");

    db.close();
  });

  it("T-Migration.2: when a V2-state DB with 3 person_memory_events rows is migrated to V3, searchMemory finds those rows via backfill", () => {
    // Given: a DB at V2 state with 3 seeded rows (row-2 summary has "FINTECH_TEST_TOKEN")
    // When:  openMemoryDatabase(tmpPath) runs V3 migration (applyV3 + backfill)
    // Then:  searchMemory("FINTECH_TEST_TOKEN", 10, db) returns ≥1 hit
    const { tmpPath, cleanup } = makeTmpDb();
    try {
      buildV2Db(tmpPath);

      const db = openMemoryDatabase(tmpPath);

      const vrow = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as {
        version: number;
      };
      assert.equal(vrow.version, 3, "V2→V3 migration must have run");

      const hits = searchMemory("FINTECH_TEST_TOKEN", 10, db);
      assert.ok(hits.length >= 1, `backfill must make seeded row searchable; got ${hits.length} hits`);
      assert.ok(
        hits[0].summary.includes("FINTECH_TEST_TOKEN") || hits[0].personName === "Person 2",
        "hit should be the seeded row",
      );
      db.close();
    } finally {
      cleanup();
    }
  });

  it("T-Migration.3: when openMemoryDatabase runs again on an already-V3 DB, no throw AND memory_fts row count unchanged (no double-backfill)", () => {
    // Given: a V3 DB (temp file) with 2 rows inserted (AI trigger → 2 fts rows)
    // When:  openMemoryDatabase(tmpPath) is called a second time (new handle, same file)
    // Then:  no throw; memory_fts count still 2
    const { tmpPath, cleanup } = makeTmpDb();
    try {
      const db1 = openMemoryDatabase(tmpPath);
      appendPersonInteraction(
        { ...ALICE_INPUT, personName: "Alice1", profileUrl: "https://www.linkedin.com/in/alice1v3/" },
        db1,
      );
      appendPersonInteraction(
        { ...ALICE_INPUT, personName: "Alice2", profileUrl: "https://www.linkedin.com/in/alice2v3/" },
        db1,
      );

      const countBefore = (db1.prepare("SELECT count(*) AS n FROM memory_fts").get() as { n: number }).n;
      db1.close();

      // Re-open — migration sees schema_version=3, skips applyV3 entirely
      const db2 = openMemoryDatabase(tmpPath);
      const countAfter = (db2.prepare("SELECT count(*) AS n FROM memory_fts").get() as { n: number }).n;
      assert.equal(countAfter, countBefore, "memory_fts row count must not change on re-open (no double-backfill)");
      db2.close();
    } finally {
      cleanup();
    }
  });

  it("T-Migration.4: CURRENT_SCHEMA_VERSION === 3", () => {
    // Given: the memory module is imported
    // When:  CURRENT_SCHEMA_VERSION is read
    // Then:  equals 3 (P-39 bumped from 2)
    assert.equal(CURRENT_SCHEMA_VERSION, 3);
  });
});

// ─── T-FtsSync ────────────────────────────────────────────────────────────────

describe("FTS5 sync triggers keep memory_fts in sync with person_memory_events (G-P39.4)", () => {
  it("T-FtsSync.1: after appendPersonInteraction inserts a row, searchMemory finds it (AI trigger fires)", () => {
    // Given: a V3 DB with memory_fts empty
    // When:  appendPersonInteraction inserts a row with "TRIGGER_INSERT_TEST" in summary
    // Then:  searchMemory("TRIGGER_INSERT_TEST", 10, db) returns that row (AI trigger)
    const db = freshDb();

    assert.equal(searchMemory("TRIGGER_INSERT_TEST", 10, db).length, 0, "precondition: empty FTS");

    appendPersonInteraction(
      {
        personName: "Bob Trigger",
        profileUrl: "https://www.linkedin.com/in/bob-trigger/",
        interaction: "message",
        summary: "TRIGGER_INSERT_TEST content for the AI trigger test",
      },
      db,
    );

    const hits = searchMemory("TRIGGER_INSERT_TEST", 10, db);
    assert.equal(hits.length, 1, "AI trigger must add new row to memory_fts");
    assert.equal(hits[0].personName, "Bob Trigger");
    db.close();
  });

  it("T-FtsSync.2: after DELETE on person_memory_events, searchMemory no longer returns the row (AD trigger)", () => {
    // Given: a V3 DB with one row searchable by "TRIGGER_DELETE_TOKEN"
    // When:  the row is deleted from person_memory_events
    // Then:  searchMemory("TRIGGER_DELETE_TOKEN", 10, db) returns [] (AD trigger)
    const db = freshDb();

    appendPersonInteraction(
      {
        personName: "Carol Delete",
        profileUrl: "https://www.linkedin.com/in/carol-del/",
        interaction: "connect",
        summary: "TRIGGER_DELETE_TOKEN unique phrase to delete",
      },
      db,
    );
    assert.equal(searchMemory("TRIGGER_DELETE_TOKEN", 10, db).length, 1, "precondition: row must be searchable");

    db.prepare("DELETE FROM person_memory_events WHERE person_name = ?").run("Carol Delete");

    assert.equal(searchMemory("TRIGGER_DELETE_TOKEN", 10, db).length, 0, "AD trigger must remove row from FTS");
    db.close();
  });

  it("T-FtsSync.3: after UPDATE changes a row's summary from 'alpha' to 'omega', searchMemory('omega') matches and searchMemory('alpha') does not (AU trigger)", () => {
    // Given: a V3 DB with one row whose summary contains "alphaXYZ" (not "omegaXYZ")
    // When:  the row's summary is updated to contain "omegaXYZ" via SQL UPDATE
    // Then:  searchMemory("omegaXYZ") matches; searchMemory("alphaXYZ") returns []
    const db = freshDb();

    appendPersonInteraction(
      {
        personName: "Dave Update",
        profileUrl: "https://www.linkedin.com/in/dave-upd/",
        interaction: "post",
        summary: "alphaXYZ content originally here",
      },
      db,
    );
    assert.equal(searchMemory("alphaXYZ", 10, db).length, 1, "precondition: alphaXYZ searchable");
    assert.equal(searchMemory("omegaXYZ", 10, db).length, 0, "precondition: omegaXYZ not yet present");

    db.prepare("UPDATE person_memory_events SET summary = ? WHERE person_name = ?").run(
      "omegaXYZ content after update",
      "Dave Update",
    );

    assert.equal(searchMemory("omegaXYZ", 10, db).length, 1, "AU trigger must index new summary");
    assert.equal(searchMemory("alphaXYZ", 10, db).length, 0, "AU trigger must de-index old summary");
    db.close();
  });
});

// ─── T-Search ─────────────────────────────────────────────────────────────────

describe("searchMemory — FTS5 relevance ordering + MemorySearchHit shape (G-P39.5/.12)", () => {
  it("T-Search.1: given several rows, searchMemory('B2B sales', 10, db) returns hits sorted by bm25Rank ascending; each hit has snippet, score, bm25Rank, personName, profileUrl", () => {
    // Given: a V3 DB with 3 rows mentioning "B2B sales" to varying degrees
    // When:  searchMemory("B2B sales", 10, db)
    // Then:  hits[n].bm25Rank <= hits[n+1].bm25Rank (ascending); required fields present
    const db = freshDb();

    // High relevance (mentions B2B sales 3 times)
    appendPersonInteraction(
      {
        personName: "Eve High",
        profileUrl: "https://www.linkedin.com/in/eve-high/",
        interaction: "message",
        summary: "B2B sales B2B sales B2B sales enterprise pitch",
      },
      db,
    );
    // Lower relevance (mentions once)
    appendPersonInteraction(
      {
        personName: "Frank Low",
        profileUrl: "https://www.linkedin.com/in/frank-low/",
        interaction: "connect",
        summary: "B2B sales context here otherwise unrelated content",
      },
      db,
    );

    const hits = searchMemory("B2B sales", 10, db);
    assert.ok(hits.length >= 2, `must return ≥2 hits; got ${hits.length}`);

    // Each hit must have the required fields
    for (const hit of hits) {
      assert.ok(typeof hit.snippet === "string", "snippet must be a string");
      assert.ok(typeof hit.bm25Rank === "number", "bm25Rank must be a number");
      assert.ok(typeof hit.personName === "string", "personName must be a string");
      assert.ok(typeof hit.profileUrl === "string", "profileUrl must be a string");
      // score is null if person not rated
      assert.ok(hit.score === null || typeof hit.score === "number", "score must be null or number");
    }

    // bm25 returns negative values; ASC = most-relevant (most negative) first
    for (let i = 0; i < hits.length - 1; i++) {
      assert.ok(
        hits[i].bm25Rank <= hits[i + 1].bm25Rank,
        `hits must be sorted by bm25Rank ASC; hits[${i}].bm25Rank=${hits[i].bm25Rank} > hits[${i + 1}].bm25Rank=${hits[i + 1].bm25Rank}`,
      );
    }
    db.close();
  });

  it("T-Search.2: searchMemory('a:b* (c)', 10, db) does not throw — toFtsMatchQuery sanitized the operators", () => {
    // Given: a V3 DB (empty or with rows)
    // When:  searchMemory("a:b* (c)", 10, db) is called
    // Then:  no throw; returns an array (may be empty)
    const db = freshDb();
    let result: unknown;
    assert.doesNotThrow(() => {
      result = searchMemory("a:b* (c)", 10, db);
    });
    assert.ok(Array.isArray(result), "result must be an array");
    db.close();
  });

  it("T-Search.3: searchMemory('\"\" :: **', 10, db) returns [] — no usable tokens after sanitization", () => {
    // Given: a V3 DB (may have any rows)
    // When:  searchMemory('"" :: **', 10, db)
    //        toFtsMatchQuery strips quotes, filters punctuation → match="" → early exit
    // Then:  returns []
    const db = freshDb();
    // Insert a row to prove it's not "empty DB returns []" but "sanitized to empty → []"
    appendPersonInteraction({ ...ALICE_INPUT }, db);

    const result = searchMemory('"" :: **', 10, db);
    assert.deepEqual(result, [], "punctuation-only input must return [] via early exit");
    db.close();
  });
});

// ─── T-Score ──────────────────────────────────────────────────────────────────

describe("setPersonScore / getPersonScore — person_scores upsert (G-P39.7)", () => {
  const URL_A = "https://www.linkedin.com/in/alice-score/";

  it("T-Score.1: setPersonScore then getPersonScore returns the stored score", () => {
    // Given: a V3 DB; URL_A
    // When:  setPersonScore(URL_A, 8, db); getPersonScore(URL_A, db)
    // Then:  returns 8
    const db = freshDb();
    setPersonScore(URL_A, 8, db);
    assert.equal(getPersonScore(URL_A, db), 8);
    db.close();
  });

  it("T-Score.2: a second setPersonScore call overwrites the first (upsert semantics)", () => {
    // Given: setPersonScore(URL_A, 8, db) has been called
    // When:  setPersonScore(URL_A, 3, db)
    // Then:  getPersonScore(URL_A) === 3 (not 8)
    const db = freshDb();
    setPersonScore(URL_A, 8, db);
    setPersonScore(URL_A, 3, db);
    assert.equal(getPersonScore(URL_A, db), 3);
    db.close();
  });

  it("T-Score.3: getPersonScore for a never-scored URL returns null", () => {
    // Given: a V3 DB; no score ever set
    // When:  getPersonScore("…/never-scored/", db)
    // Then:  null
    const db = freshDb();
    assert.equal(getPersonScore("https://www.linkedin.com/in/never-scored/", db), null);
    db.close();
  });

  it("T-Score.4: setPersonScore with trailing-slash URL and getPersonScore with non-slash variant find same row (normalizeProfileUrl applied on both sides)", () => {
    // Given: setPersonScore("…/alice" [no slash], 7, db)
    // When:  getPersonScore("…/alice/" [with slash], db)
    // Then:  7 (normalizeProfileUrl adds trailing slash on both paths)
    const db = freshDb();
    setPersonScore("https://www.linkedin.com/in/alice-norm", 7, db); // no trailing slash
    const score = getPersonScore("https://www.linkedin.com/in/alice-norm/", db); // with trailing slash
    assert.equal(score, 7, "normalizeProfileUrl must normalize both sides to the same key");
    db.close();
  });
});

// ─── T-Note ───────────────────────────────────────────────────────────────────

describe("setMemoryNote / getMemoryNote — general_memory key/value store (G-P39.6)", () => {
  it("T-Note.1: setMemoryNote then getMemoryNote returns { key, value, updatedAt }", () => {
    // Given: a V3 DB
    // When:  setMemoryNote("test_key", "test_value", db); getMemoryNote("test_key", db)
    // Then:  returns { key: "test_key", value: "test_value", updatedAt: <iso> }
    const db = freshDb();
    setMemoryNote("test_key", "test_value", db);
    const note = getMemoryNote("test_key", db);
    assert.ok(note !== null, "note must not be null");
    assert.equal(note.key, "test_key");
    assert.equal(note.value, "test_value");
    assert.ok(typeof note.updatedAt === "string" && note.updatedAt.length > 0, "updatedAt must be a non-empty string");
    // Verify it's ISO 8601 (at least parseable as a date)
    assert.ok(!Number.isNaN(Date.parse(note.updatedAt)), "updatedAt must be a valid ISO date string");
    db.close();
  });

  it("T-Note.2: a second setMemoryNote call overwrites the first (upsert semantics)", () => {
    // Given: setMemoryNote("k", "v1", db) has been called
    // When:  setMemoryNote("k", "v2", db)
    // Then:  getMemoryNote("k").value === "v2"
    const db = freshDb();
    setMemoryNote("k", "v1", db);
    setMemoryNote("k", "v2", db);
    const note = getMemoryNote("k", db);
    assert.equal(note?.value, "v2", "second upsert must overwrite first");
    db.close();
  });

  it("T-Note.3: getMemoryNote for a missing key returns null", () => {
    // Given: a V3 DB; no note for key
    // When:  getMemoryNote("missing_key_xyz", db)
    // Then:  null
    const db = freshDb();
    assert.equal(getMemoryNote("missing_key_xyz", db), null);
    db.close();
  });
});

// ─── T-toFtsMatchQuery ────────────────────────────────────────────────────────

describe("toFtsMatchQuery — FTS5 operator sanitization (G-P39.12)", () => {
  it("toFtsMatchQuery: standard words are double-quoted and space-joined", () => {
    // Given: "hello world"
    // When:  toFtsMatchQuery("hello world")
    // Then:  '"hello" "world"'
    assert.equal(toFtsMatchQuery("hello world"), '"hello" "world"');
  });

  it("toFtsMatchQuery: FTS5 operators inside tokens are neutralized via quoting", () => {
    // Given: "a:b* (c)"
    // When:  toFtsMatchQuery("a:b* (c)")
    // Then:  result is non-empty; tokens are wrapped in double-quotes (no bare FTS5 operators)
    const result = toFtsMatchQuery("a:b* (c)");
    assert.ok(result.length > 0, "must produce non-empty result for tokens with word chars");
    // Both "a:b*" and "(c)" have \w chars → stay; quotes neutralize operators
    assert.ok(result.includes('"'), "result must use double-quote wrapping");
    // Must not contain bare FTS5 query operators outside of quoted terms
    // (each token is wrapped in "..." so colon/star/paren are inside quotes)
  });

  it("toFtsMatchQuery: purely-punctuation tokens produce empty string (NIT-2 fix)", () => {
    // Given: '"" :: **'
    // When:  toFtsMatchQuery('"" :: **')
    //        — after unquoting: "", "::", "**" → all fail /\w/ filter
    // Then:  "" (empty — no usable tokens)
    assert.equal(toFtsMatchQuery('"" :: **'), "", "punctuation-only input must produce empty string");
  });
});
