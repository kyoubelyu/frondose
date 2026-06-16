/**
 * P-25 Step 5 — T-MEM.V2.1..5
 *
 * Memory schema V2 migration tests.
 * Gate coverage: G-P25.4, G-P25.5
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import {
  appendPersonInteraction,
  CURRENT_SCHEMA_VERSION,
  closeMemoryDatabase,
  getPersonMemory,
  openMemoryDatabase,
  rememberInputSchema,
} from "../../src/persistence/memory.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p25-memv2-"));
  return { dir, dbPath: join(dir, "memory.sqlite"), cleanup: () => cleanupTmpDir(dir) };
}

/** Create a minimal V1 database at path (no V2 columns, version=1 row). */
function createV1Database(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL)`);
  db.exec(`
    CREATE TABLE person_memory_events (
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
    CREATE INDEX idx_person_memory_profile_url ON person_memory_events (profile_url, created_at DESC);
    CREATE INDEX idx_person_memory_person_name ON person_memory_events (person_name, created_at DESC);
  `);
  db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(1);
  db.close();
}

// ─── T-MEM.V2 ─────────────────────────────────────────────────────────────────

describe("Memory V2 migration (G-P25.4, G-P25.5)", () => {
  it("T-MEM.V2.1: when openMemoryDatabase(':memory:') on fresh DB, schema_version has version=2 and person_memory_events has 4 attribution columns", () => {
    // Given: fresh :memory: DB
    // When:  openMemoryDatabase(":memory:") runs all migrations
    // Then:  schema_version has row with version=2; 4 attribution columns present
    const db = openMemoryDatabase(":memory:");
    try {
      const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as
        | { version: number }
        | undefined;
      assert.ok(row, "schema_version table must have rows");
      assert.equal(row.version, CURRENT_SCHEMA_VERSION, `latest version must be ${CURRENT_SCHEMA_VERSION}`);
      assert.equal(CURRENT_SCHEMA_VERSION, 3, "CURRENT_SCHEMA_VERSION must be 3 (P-39 V3 migration)");

      const cols = db.prepare("PRAGMA table_info(person_memory_events)").all() as Array<{ name: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      assert.ok(colNames.has("source_worker_id"), "V2 column source_worker_id must exist");
      assert.ok(colNames.has("source_hostname"), "V2 column source_hostname must exist");
      assert.ok(colNames.has("source_persona"), "V2 column source_persona must exist");
      assert.ok(colNames.has("ts"), "V2 column ts must exist");
    } finally {
      closeMemoryDatabase(db);
    }
  });

  it("T-MEM.V2.2: when V1 DB file is opened, existing rows preserved + V2 columns added; schema_version has both version=1 and version=2 rows", () => {
    // Given: pre-existing tmp DB file at V1 (created by createV1Database)
    // When:  openMemoryDatabase(dbPath) runs runMemoryMigrations on that DB
    // Then:  PRAGMA table_info shows 4 new V2 columns;
    //        schema_version table has both version=1 AND version=2 rows
    const { dbPath, cleanup } = makeTmpDir();
    try {
      // Create V1 database first
      createV1Database(dbPath);

      // Open with migration
      const db = openMemoryDatabase(dbPath);
      try {
        // Check both version rows exist
        const versions = db.prepare("SELECT version FROM schema_version ORDER BY version ASC").all() as Array<{
          version: number;
        }>;
        assert.ok(
          versions.some((v) => v.version === 1),
          "version=1 row must still be present after migration",
        );
        assert.ok(
          versions.some((v) => v.version === 2),
          "version=2 row must be added by V2 migration",
        );

        // Check V2 columns added
        const cols = db.prepare("PRAGMA table_info(person_memory_events)").all() as Array<{ name: string }>;
        const colNames = new Set(cols.map((c) => c.name));
        assert.ok(colNames.has("source_worker_id"), "V2 column source_worker_id added to existing table");
        assert.ok(colNames.has("source_hostname"), "V2 column source_hostname added");
        assert.ok(colNames.has("source_persona"), "V2 column source_persona added");
        assert.ok(colNames.has("ts"), "V2 column ts added");
      } finally {
        closeMemoryDatabase(db);
      }
    } finally {
      cleanup();
    }
  });

  it("T-MEM.V2.3: when V1 DB with 3 person events is opened, all 3 rows readable via getPersonMemory; attribution fields are null/undefined", () => {
    // Given: tmp DB with 3 person_memory_events rows inserted at V1 schema
    // When:  openMemoryDatabase(tmpPath) runs V2 migration
    // Then:  getPersonMemory returns 3 rows for person; source_worker_id / ts all null in raw SQL
    const { dbPath, cleanup } = makeTmpDir();
    try {
      createV1Database(dbPath);

      // Insert 3 V1 rows
      const v1db = new Database(dbPath);
      const stmt = v1db.prepare(`
        INSERT INTO person_memory_events (id, profile_url, person_name, interaction, summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        "id1",
        "https://linkedin.com/in/alice/",
        "Alice",
        "initial_contact",
        "summary1",
        new Date().toISOString(),
      );
      stmt.run("id2", "https://linkedin.com/in/alice/", "Alice", "follow_up", "summary2", new Date().toISOString());
      stmt.run("id3", "https://linkedin.com/in/alice/", "Alice", "meeting", "summary3", new Date().toISOString());
      v1db.close();

      // Migrate + query
      const db = openMemoryDatabase(dbPath);
      try {
        const projection = getPersonMemory({ personName: "Alice" }, db);
        assert.ok(projection, "getPersonMemory must return projection");
        assert.equal(projection.history.length, 3, "all 3 V1 rows must survive migration");

        // Raw SQL check: V2 attribution columns must be NULL for pre-migration rows
        const raw = db
          .prepare("SELECT source_worker_id, ts FROM person_memory_events WHERE person_name = 'Alice' LIMIT 1")
          .get() as { source_worker_id: string | null; ts: number | null } | undefined;
        assert.ok(raw, "raw row must exist");
        assert.equal(raw.source_worker_id, null, "source_worker_id must be NULL for V1 rows");
        assert.equal(raw.ts, null, "ts must be NULL for V1 rows");
      } finally {
        closeMemoryDatabase(db);
      }
    } finally {
      cleanup();
    }
  });

  it("T-MEM.V2.4: when appendPersonInteraction called with attribution fields, inserted row has those values readable via raw SQL", () => {
    // Given: fresh V2 :memory: DB
    // When:  appendPersonInteraction({...input, sourceWorkerId:"w1", sourceHostname:"host1", sourcePersona:"p1", ts:12345}, db)
    // Then:  SELECT source_worker_id FROM person_memory_events WHERE id = <id> returns "w1"
    const db = openMemoryDatabase(":memory:");
    try {
      const input = rememberInputSchema.parse({
        personName: "Bob",
        profileUrl: "https://linkedin.com/in/bob",
        interaction: "like", // valid enum: 'like' | 'comment' | 'repost' | 'message' | 'connect' | 'post' | 'at'
        summary: "test summary",
        sourceWorkerId: "w1",
        sourceHostname: "host1",
        sourcePersona: "p1",
        ts: 12345,
      });
      const event = appendPersonInteraction(input, db);

      const row = db
        .prepare("SELECT source_worker_id, source_hostname, source_persona, ts FROM person_memory_events WHERE id = ?")
        .get(event.id) as {
        source_worker_id: string | null;
        source_hostname: string | null;
        source_persona: string | null;
        ts: number | null;
      };
      assert.ok(row, "inserted row must be findable");
      assert.equal(row.source_worker_id, "w1", "source_worker_id must be 'w1'");
      assert.equal(row.source_hostname, "host1", "source_hostname must be 'host1'");
      assert.equal(row.source_persona, "p1", "source_persona must be 'p1'");
      assert.equal(row.ts, 12345, "ts must be 12345");
    } finally {
      closeMemoryDatabase(db);
    }
  });

  it("T-MEM.V2.5: rememberInputSchema parses with and without attribution fields (backward-compat)", () => {
    // Given: minimal valid input (no attribution fields)
    // When:  rememberInputSchema.parse({...minimal}) — Then: parses without error
    // Given: same input with sourceWorkerId:"w1" added
    // When:  rememberInputSchema.parse({...minimal, sourceWorkerId:"w1"}) — Then: also parses
    const minimal = {
      personName: "Bob",
      profileUrl: "https://linkedin.com/in/bob",
      interaction: "like", // valid enum: 'like' | 'comment' | 'repost' | 'message' | 'connect' | 'post' | 'at'
      summary: "test summary",
    };
    // Backward compat: no attribution fields
    assert.doesNotThrow(() => rememberInputSchema.parse(minimal), "minimal input (no attribution) must parse");
    // Forward compat: with attribution fields
    assert.doesNotThrow(
      () => rememberInputSchema.parse({ ...minimal, sourceWorkerId: "w1", sourceHostname: "h1", ts: 100 }),
      "input with attribution fields must parse",
    );
    // Partial attribution is also OK
    assert.doesNotThrow(
      () => rememberInputSchema.parse({ ...minimal, sourceWorkerId: "w1" }),
      "input with partial attribution must parse",
    );
  });
});
