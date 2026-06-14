/**
 * P-AUTO-12 Step 3 scaffold — T-CronProgressHwm.* (G-A12.23)
 *
 * Tests the `cronProgressHighWaterMark(db)` helper from
 * `src/cli/subcommands/serve/cronProgress.ts` (NEW at Step 4).
 *
 * Gate coverage: G-A12.23
 *
 * Design: the helper is a pure DB function — seed known rows, assert the
 * returned max timestamps. Uses unique temp-file salesDbs per test case
 * (NOT `:memory:`) because `openSalesDatabase` caches by path — two calls
 * to `openSalesDatabase(":memory:")` return the SAME handle with prior rows
 * intact. Each test opens a DISTINCT temp-file path and closes it after.
 *
 * Step-3 compile note: `cronProgressHighWaterMark` does not exist until
 * Step 4. The `before()` block dynamically imports it with a fallback to
 * null so the file compiles. Tests reach the assert and FAIL (not a compile
 * error) — intentional Step-3 behavior.
 *
 * Run (mock, single file):
 *   node --import tsx --test --test-force-exit \
 *     tests/cli/subcommands/serve/cronProgress.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { before, describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: pre-builder dynamic import
type AnyFn = (...args: any[]) => any;

let cronProgressHighWaterMark: AnyFn | null = null;
let openSalesDatabase: AnyFn | null = null;
let closeSalesDatabase: AnyFn | null = null;

before(async () => {
  try {
    const progressMod = await import("../../../../src/cli/subcommands/serve/cronProgress.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: pre-builder
    cronProgressHighWaterMark = (progressMod as any)?.cronProgressHighWaterMark ?? null;
  } catch {
    // Not yet shipped at Step 3
  }
  try {
    const dbMod = await import("../../../../src/persistence/salesDb.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: pre-builder
    openSalesDatabase = (dbMod as any)?.openSalesDatabase ?? null;
    // biome-ignore lint/suspicious/noExplicitAny: pre-builder
    closeSalesDatabase = (dbMod as any)?.closeSalesDatabase ?? null;
  } catch {
    // Not yet shipped
  }
});

// ─── T-CronProgressHwm.1 ─────────────────────────────────────────────────────

describe("T-CronProgressHwm.1: cronProgressHighWaterMark returns MAX timestamps across three tables (G-A12.23)", () => {
  it("when lead_timeline has 2 rows (ts=1000,2000), message_drafts has 1 row (created_at=1500), raw_candidates empty → {timelineMax:2000, draftsMax:1500, candidatesMax:0}", () => {
    // Given: salesDb with 2 lead_timeline rows (ts=1000 and ts=2000),
    //        1 message_drafts row (created_at=1500), and empty raw_candidates
    // When:  cronProgressHighWaterMark(db) is called
    // Then:  returns {timelineMax:2000, draftsMax:1500, candidatesMax:0}
    assert.ok(cronProgressHighWaterMark !== null, "cronProgressHighWaterMark must be exported from cronProgress.ts (not yet at Step 3)");
    assert.ok(openSalesDatabase !== null, "openSalesDatabase must be importable from salesDb.ts");

    // Use a unique temp-file path per test to avoid the in-process cache sharing rows
    const dbPath = join(tmpdir(), `hwm-t1a-${randomUUID()}.sqlite`);
    // biome-ignore lint/suspicious/noExplicitAny: test DB handle
    const db: any = openSalesDatabase!(dbPath);

    try {
      // Seed a raw_candidate for the FK on lead_timeline.candidate_id (NOT NULL)
      const candidateId = randomUUID();
      db.prepare(`
        INSERT INTO raw_candidates (id, person_name, profile_url, account_id, source, observed_at, last_seen_at, status)
        VALUES (?, 'Test Person', 'https://linkedin.com/in/test', NULL, 'profile-nav', ?, ?, 'new')
      `).run(candidateId, 500, 500);

      // Seed a lead for the message_drafts FK (lead_id is nullable post-v2 migration, so NULL is fine)
      // Seed 2 lead_timeline rows — schema column is `metadata` (not `detail`)
      db.prepare(`INSERT INTO lead_timeline (id, candidate_id, lead_id, event_type, ts, metadata) VALUES (?, ?, NULL, 'scored', ?, NULL)`)
        .run(randomUUID(), candidateId, 1000);
      db.prepare(`INSERT INTO lead_timeline (id, candidate_id, lead_id, event_type, ts, metadata) VALUES (?, ?, NULL, 'promoted_to_lead', ?, NULL)`)
        .run(randomUUID(), candidateId, 2000);

      // Seed 1 message_drafts row (lead_id nullable after v2 migration)
      db.prepare(`INSERT INTO message_drafts (id, lead_id, kind, text, status, created_by, evidence, created_at) VALUES (?, NULL, 'connect_note', 'Hi', 'draft', 'llm', NULL, ?)`)
        .run(randomUUID(), 1500);

      // raw_candidates has one row with last_seen_at=500 — but this sub-case is "empty raw_candidates for
      // candidatesMax" i.e. candidatesMax should reflect the actual rows. Since we have a row with
      // last_seen_at=500 that is > 0, the spec says "empty raw_candidates → candidatesMax=0".
      // To match the spec faithfully, use a separate DB where raw_candidates is truly empty:
      const dbPath2 = join(tmpdir(), `hwm-t1b-${randomUUID()}.sqlite`);
      // biome-ignore lint/suspicious/noExplicitAny: test DB handle
      const db2: any = openSalesDatabase!(dbPath2);

      try {
        // Seed a raw_candidate for the timeline FK
        const candidateId2 = randomUUID();
        db2.prepare(`
          INSERT INTO raw_candidates (id, person_name, profile_url, account_id, source, observed_at, last_seen_at, status)
          VALUES (?, 'Test Person 2', 'https://linkedin.com/in/test2', NULL, 'profile-nav', ?, ?, 'new')
        `).run(candidateId2, 500, 500);

        db2.prepare(`INSERT INTO lead_timeline (id, candidate_id, lead_id, event_type, ts, metadata) VALUES (?, ?, NULL, 'scored', ?, NULL)`)
          .run(randomUUID(), candidateId2, 1000);
        db2.prepare(`INSERT INTO lead_timeline (id, candidate_id, lead_id, event_type, ts, metadata) VALUES (?, ?, NULL, 'promoted_to_lead', ?, NULL)`)
          .run(randomUUID(), candidateId2, 2000);
        db2.prepare(`INSERT INTO message_drafts (id, lead_id, kind, text, status, created_by, evidence, created_at) VALUES (?, NULL, 'connect_note', 'Hi', 'draft', 'llm', NULL, ?)`)
          .run(randomUUID(), 1500);

        // Remove the seeded raw_candidate so candidatesMax reads 0
        db2.prepare("DELETE FROM lead_timeline").run();
        db2.prepare("DELETE FROM raw_candidates").run();

        // Re-seed timeline without raw_candidates (FK check off — WAL + migration sets FK on after v2; disable for this insert)
        db2.pragma("foreign_keys = OFF");
        db2.prepare(`INSERT INTO lead_timeline (id, candidate_id, lead_id, event_type, ts, metadata) VALUES (?, 'fake-cid-1', NULL, 'scored', ?, NULL)`)
          .run(randomUUID(), 1000);
        db2.prepare(`INSERT INTO lead_timeline (id, candidate_id, lead_id, event_type, ts, metadata) VALUES (?, 'fake-cid-2', NULL, 'promoted_to_lead', ?, NULL)`)
          .run(randomUUID(), 2000);
        db2.pragma("foreign_keys = ON");
        db2.prepare(`INSERT INTO message_drafts (id, lead_id, kind, text, status, created_by, evidence, created_at) VALUES (?, NULL, 'connect_note', 'Hi', 'draft', 'llm', NULL, ?)`)
          .run(randomUUID(), 1500);

        const result = cronProgressHighWaterMark!(db2);
        assert.deepEqual(result, { timelineMax: 2000, draftsMax: 1500, candidatesMax: 0 },
          `cronProgressHighWaterMark must return {timelineMax:2000,draftsMax:1500,candidatesMax:0}; got: ${JSON.stringify(result)}`);
      } finally {
        closeSalesDatabase!(dbPath2);
      }
    } finally {
      closeSalesDatabase!(dbPath);
    }
  });

  it("when all three tables are empty → {timelineMax:0, draftsMax:0, candidatesMax:0} (COALESCE-to-zero baseline)", () => {
    // Given: a brand-new salesDb with no rows in any of the three tables
    // When:  cronProgressHighWaterMark(db) is called
    // Then:  returns {timelineMax:0, draftsMax:0, candidatesMax:0}
    assert.ok(cronProgressHighWaterMark !== null, "cronProgressHighWaterMark must be exported (not yet at Step 3)");
    assert.ok(openSalesDatabase !== null, "openSalesDatabase must be importable");

    const dbPath = join(tmpdir(), `hwm-t2-${randomUUID()}.sqlite`);
    // biome-ignore lint/suspicious/noExplicitAny: test DB handle
    const db: any = openSalesDatabase!(dbPath);
    try {
      const result = cronProgressHighWaterMark!(db);
      assert.deepEqual(result, { timelineMax: 0, draftsMax: 0, candidatesMax: 0 },
        `cronProgressHighWaterMark on empty DB must return all zeros; got: ${JSON.stringify(result)}`);
    } finally {
      closeSalesDatabase!(dbPath);
    }
  });

  it("when only raw_candidates has rows (last_seen_at=9000) and other tables empty → {timelineMax:0, draftsMax:0, candidatesMax:9000}", () => {
    // Given: salesDb with 1 raw_candidates row (last_seen_at=9000); timeline + drafts empty
    // When:  cronProgressHighWaterMark(db) is called
    // Then:  returns {timelineMax:0, draftsMax:0, candidatesMax:9000}
    assert.ok(cronProgressHighWaterMark !== null, "cronProgressHighWaterMark must be exported (not yet at Step 3)");
    assert.ok(openSalesDatabase !== null, "openSalesDatabase must be importable");

    const dbPath = join(tmpdir(), `hwm-t3-${randomUUID()}.sqlite`);
    // biome-ignore lint/suspicious/noExplicitAny: test DB handle
    const db: any = openSalesDatabase!(dbPath);
    try {
      db.prepare(`
        INSERT INTO raw_candidates (id, person_name, profile_url, account_id, source, observed_at, last_seen_at, status)
        VALUES (?, 'Bob', 'https://linkedin.com/in/bob', NULL, 'profile-nav', ?, ?, 'new')
      `).run(randomUUID(), 8000, 9000);

      const result = cronProgressHighWaterMark!(db);
      assert.deepEqual(result, { timelineMax: 0, draftsMax: 0, candidatesMax: 9000 },
        `cronProgressHighWaterMark must return candidatesMax=9000; got: ${JSON.stringify(result)}`);
    } finally {
      closeSalesDatabase!(dbPath);
    }
  });

  it("cronProgressHighWaterMark uses MAX(last_seen_at) NOT MAX(observed_at) for raw_candidates (upsert bump semantics)", () => {
    // Given: raw_candidates row with observed_at=1000, last_seen_at=2000 (upsert bumped last_seen_at only)
    // When:  cronProgressHighWaterMark(db) is called
    // Then:  candidatesMax=2000 (last_seen_at), NOT 1000 (observed_at)
    assert.ok(cronProgressHighWaterMark !== null, "cronProgressHighWaterMark must be exported (not yet at Step 3)");
    assert.ok(openSalesDatabase !== null, "openSalesDatabase must be importable");

    const dbPath = join(tmpdir(), `hwm-t4-${randomUUID()}.sqlite`);
    // biome-ignore lint/suspicious/noExplicitAny: test DB handle
    const db: any = openSalesDatabase!(dbPath);
    try {
      db.prepare(`
        INSERT INTO raw_candidates (id, person_name, profile_url, account_id, source, observed_at, last_seen_at, status)
        VALUES (?, 'Alice', 'https://linkedin.com/in/alice', NULL, 'profile-nav', ?, ?, 'new')
      `).run(randomUUID(), 1000, 2000);

      const result = cronProgressHighWaterMark!(db);
      assert.equal(result.candidatesMax, 2000,
        `candidatesMax must be 2000 (MAX(last_seen_at)), not 1000 (observed_at); got: ${result.candidatesMax}`);
    } finally {
      closeSalesDatabase!(dbPath);
    }
  });
});
