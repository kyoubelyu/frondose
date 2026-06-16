/**
 * P-26 Step 5 — T-SINBOX.1..4
 *
 * Persistence tests for server inbox (server_inbox + worker_pending tables).
 * Gate coverage: G-P26.7, G-P26.15
 *
 * POST-C1 fix: T-SINBOX.4 asserts 180 rows remain pending after drain on 200
 * rows (MAX_PER_DRAIN = 20). See §6.3 C-4 fix.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { drainServerInbox, enqueueServerInbox, openServerInboxDb } from "../../src/persistence/serverInbox.js";
import { cleanupTmpDir } from "../_helpers/tmp";

function makeTmpDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p26-sinbox-"));
  return { dbPath: join(dir, "inbox.sqlite"), cleanup: () => cleanupTmpDir(dir) };
}

describe("serverInbox persistence (G-P26.7, G-P26.15)", () => {
  it("T-SINBOX.1: enqueueServerInbox inserts 1 pending row", () => {
    // Given: empty server_inbox
    // When:  enqueueServerInbox(db, {worker_id:"w1", type:"x", data:{}})
    // Then:  1 row with status='pending'
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openServerInboxDb(dbPath);
      const id = enqueueServerInbox(db, "w1", "x", {});
      assert.ok(typeof id === "number" && id >= 1, "T-SINBOX.1: id is number ≥ 1");
      const row = db.prepare("SELECT status FROM server_inbox WHERE id=?").get(id) as { status: string } | undefined;
      assert.ok(row !== undefined, "T-SINBOX.1: row exists");
      assert.equal(row!.status, "pending", "T-SINBOX.1: status = pending");
      const count = (db.prepare("SELECT COUNT(*) AS c FROM server_inbox").get() as { c: number }).c;
      assert.equal(count, 1, "T-SINBOX.1: exactly 1 row");
    } finally {
      cleanup();
    }
  });

  it("T-SINBOX.2: drainServerInbox with 3 pending rows returns formatted summary; all 3 marked drained", () => {
    // Given: 3 pending server_inbox rows
    // When:  drainServerInbox(db)
    // Then:  returns string containing all 3 events; all rows now status='drained'
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openServerInboxDb(dbPath);
      enqueueServerInbox(db, "w1", "event_a", { x: 1 });
      enqueueServerInbox(db, "w2", "event_b", {});
      enqueueServerInbox(db, "w1", "event_c", { y: "z" });
      const summary = drainServerInbox(db);
      assert.ok(summary !== null, "T-SINBOX.2: non-null summary for 3 rows");
      assert.ok(summary!.includes("w1"), "T-SINBOX.2: summary contains w1");
      assert.ok(summary!.includes("event_a"), "T-SINBOX.2: summary contains event_a");
      assert.ok(summary!.includes("event_b"), "T-SINBOX.2: summary contains event_b");
      const drained = (
        db.prepare("SELECT COUNT(*) AS c FROM server_inbox WHERE status='drained'").get() as { c: number }
      ).c;
      assert.equal(drained, 3, "T-SINBOX.2: all 3 rows drained");
    } finally {
      cleanup();
    }
  });

  it("T-SINBOX.3: drainServerInbox with empty inbox returns null", () => {
    // Given: empty server_inbox
    // When:  drainServerInbox(db)
    // Then:  returns null
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openServerInboxDb(dbPath);
      const result = drainServerInbox(db);
      assert.equal(result, null, "T-SINBOX.3: null on empty inbox");
    } finally {
      cleanup();
    }
  });

  it("T-SINBOX.4: drainServerInbox on 200-row inbox drains exactly 20 rows; 180 remain pending; summary ends with '... 180 more events queued'", () => {
    // Given: 200 pending server_inbox rows
    // When:  drainServerInbox(db) called once
    // Then:  returns non-null string ending with "... 180 more events queued (will surface in next turn)";
    //        SELECT COUNT(*) WHERE status='pending' = 180 (NOT 0 — §6.3 MAX_PER_DRAIN=20);
    //        SELECT COUNT(*) WHERE status='drained' = 20
    //
    // POST-C1 fix: §5.2 T-SINBOX.4 originally said "ALL rows marked drained" —
    // that contradicted §6.3 C-4's row-count cap of 20.
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openServerInboxDb(dbPath);
      for (let i = 0; i < 200; i++) {
        enqueueServerInbox(db, "w1", `event_${i}`, {});
      }
      const summary = drainServerInbox(db);
      assert.ok(summary !== null, "T-SINBOX.4: non-null summary");
      assert.ok(
        summary!.includes("180 more events queued"),
        `T-SINBOX.4: summary must mention 180 more; got: ${summary!.slice(-100)}`,
      );
      const pending = (
        db.prepare("SELECT COUNT(*) AS c FROM server_inbox WHERE status='pending'").get() as { c: number }
      ).c;
      const drained = (
        db.prepare("SELECT COUNT(*) AS c FROM server_inbox WHERE status='drained'").get() as { c: number }
      ).c;
      assert.equal(pending, 180, "T-SINBOX.4: 180 pending rows remain (MAX_PER_DRAIN=20)");
      assert.equal(drained, 20, "T-SINBOX.4: exactly 20 rows drained");
    } finally {
      cleanup();
    }
  });
});
