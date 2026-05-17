/**
 * P-29 Step 5 — T-Q.LASTACTION.1-2, T-Q.LEADS.1-2
 *
 * Tests for new P-29 persistence queries:
 *   - getLastLeadActionByWorker  (src/persistence/workersRegistry.ts)
 *   - listRecentMemoryEvents     (src/persistence/memory.ts)
 *
 * Gate coverage: G-P29.11, G-P29.13
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listRecentMemoryEvents, openMemoryDatabase } from "../../src/persistence/memory.js";
import { addWorker, getLastLeadActionByWorker, insertLeadAction, openWorkersDb } from "../../src/persistence/workersRegistry.js";

// ─── T-Q.LASTACTION ───────────────────────────────────────────────────────────

describe("getLastLeadActionByWorker — most-recent lead_actions row (G-P29.11)", () => {
  it("T-Q.LASTACTION.1: given 3 lead_actions rows for w1 with ts 100/300/200, when getLastLeadActionByWorker(db,'w1'), then {action_type, ts:300}", () => {
    // Given: :memory: workersDb; 3 lead_actions rows for w1 with ts values 100, 300, 200 (G-P29.11)
    // When: getLastLeadActionByWorker(db, "w1")
    // Then: returns {action_type, ts:300} — the row with the highest ts (ORDER BY ts DESC LIMIT 1)
    const db = openWorkersDb(":memory:");
    try {
      addWorker(db, "w1", "tok1");
      insertLeadAction(db, "https://linkedin.com/in/alice/", "connect", "w1", 100);
      insertLeadAction(db, "https://linkedin.com/in/alice/", "message", "w1", 300);
      insertLeadAction(db, "https://linkedin.com/in/alice/", "like", "w1", 200);
      const result = getLastLeadActionByWorker(db, "w1");
      assert.ok(result !== null, "T-Q.LASTACTION.1: result must not be null (w1 has 3 rows)");
      assert.equal(result.ts, 300, "T-Q.LASTACTION.1: must return the row with highest ts (300)");
      assert.equal(result.action_type, "message", "T-Q.LASTACTION.1: action_type must be 'message' (ts=300 row)");
    } finally {
      db.close();
    }
  });

  it("T-Q.LASTACTION.2: given no lead_actions rows for w2, when getLastLeadActionByWorker(db,'w2'), then null", () => {
    // Given: :memory: workersDb; worker 'w2' exists but has no lead_actions rows (G-P29.11)
    // When: getLastLeadActionByWorker(db, "w2")
    // Then: returns null
    const db = openWorkersDb(":memory:");
    try {
      addWorker(db, "w2", "tok2");
      const result = getLastLeadActionByWorker(db, "w2");
      assert.equal(result, null, "T-Q.LASTACTION.2: getLastLeadActionByWorker with no rows must return null");
    } finally {
      db.close();
    }
  });
});

// ─── T-Q.LEADS ────────────────────────────────────────────────────────────────

describe("listRecentMemoryEvents — paginated DESC ordering (G-P29.13)", () => {
  it("T-Q.LEADS.1: given 5 events with distinct created_at, when listRecentMemoryEvents(db,2,0) then listRecentMemoryEvents(db,2,2), then newest-2 then next-2 ordered created_at DESC", () => {
    // Given: :memory: memoryDb with 5 person_memory_events; distinct ISO-string created_at (G-P29.13)
    //        events i=0..4 inserted with base + i*60s → t0 < t1 < t2 < t3 < t4
    // When: listRecentMemoryEvents(db, 2, 0) — first page (offset 0)
    //       listRecentMemoryEvents(db, 2, 2) — second page (offset 2)
    // Then: page0 returns 2 rows with highest created_at (t4, t3 — newest first);
    //       page1 returns next 2 (t2, t1); no overlap;
    //       ORDER BY created_at DESC (plain lexical — C-1: no datetime() wrapper)
    const db = openMemoryDatabase(":memory:");
    try {
      // Insert with explicit created_at so ORDER BY created_at DESC is deterministic.
      // appendPersonInteraction uses new Date() so all inserts in a fast loop share the same
      // millisecond. Use raw SQL with distinct ISO timestamps instead.
      const base = new Date("2025-06-01T00:00:00.000Z");
      for (let i = 0; i < 5; i++) {
        const createdAt = new Date(base.getTime() + i * 60_000).toISOString();
        db.prepare(
          `INSERT INTO person_memory_events
           (id, profile_url, person_name, interaction, summary, notes, avoid, next_action,
            created_at, source_worker_id, source_hostname, source_persona, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `id-${i}`,
          `https://linkedin.com/in/person${i}/`,
          `Person ${i}`,
          "connect",
          `Summary ${i}`,
          null,
          null,
          null,
          createdAt,
          null,
          null,
          null,
          base.getTime() + i * 60_000,
        );
      }
      const page0 = listRecentMemoryEvents(db, 2, 0);
      const page1 = listRecentMemoryEvents(db, 2, 2);
      assert.equal(page0.length, 2, "T-Q.LEADS.1: page0 must return 2 events");
      assert.equal(page1.length, 2, "T-Q.LEADS.1: page1 must return 2 events");
      // Newest first — page0[0].created_at must be >= page0[1].created_at
      assert.ok(
        page0[0].created_at >= page0[1].created_at,
        `T-Q.LEADS.1: page0 must be ordered newest-first; got ${page0[0].created_at} vs ${page0[1].created_at}`,
      );
      assert.ok(
        page1[0].created_at >= page1[1].created_at,
        `T-Q.LEADS.1: page1 must be ordered newest-first; got ${page1[0].created_at} vs ${page1[1].created_at}`,
      );
      // Page 0 must be newer than page 1 (OFFSET ensures this)
      assert.ok(
        page0[0].created_at > page1[0].created_at,
        "T-Q.LEADS.1: newest event in page0 must be newer than newest in page1",
      );
      // No id overlap between pages
      const ids0 = page0.map((e) => e.id);
      const ids1 = page1.map((e) => e.id);
      const overlap = ids0.filter((id) => ids1.includes(id));
      assert.equal(overlap.length, 0, "T-Q.LEADS.1: no id overlap between page0 and page1");
    } finally {
      db.close();
    }
  });

  it("T-Q.LEADS.2: given empty memoryDb, when listRecentMemoryEvents(db,10,0), then []", () => {
    // Given: :memory: memoryDb with no events (G-P29.13)
    // When: listRecentMemoryEvents(db, 10, 0)
    // Then: returns []
    const db = openMemoryDatabase(":memory:");
    try {
      const result = listRecentMemoryEvents(db, 10, 0);
      assert.equal(result.length, 0, "T-Q.LEADS.2: empty db must return empty array");
    } finally {
      db.close();
    }
  });
});
