/**
 * P-26 Step 5 — T-WINBOX.CRUD.1..4 (persistence CRUD only)
 *
 * Tests for src/persistence/workerInbox.ts — DB CRUD helpers only.
 * No runAgentLoop calls — orchestration is tested in tests/cli/workerInbox.mock.test.ts.
 * Gate coverage: G-P26.14 (drain preconditions)
 *
 * P-28.5 §11 update (validator Step 5):
 *   markWorkerInboxMessagesConsumed removed → deleteWorkerInboxMessages (DELETE semantics).
 *   T-WINBOX.CRUD.3/.4 rewritten for DELETE-not-update contract.
 *   T-WINBOX.CRUD.2: setup uses deleteWorkerInboxMessages to drop id3 (same effective state).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  deleteWorkerInboxMessages,
  enqueueWorkerInbox,
  openWorkerInboxDb,
  peekPendingWorkerInboxMessages,
} from "../../src/persistence/workerInbox.js";

function makeTmpDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p26-winbox-"));
  return { dbPath: join(dir, "inbox.sqlite"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("workerInbox persistence CRUD (G-P26.14)", () => {
  it("T-WINBOX.CRUD.1: enqueueWorkerInbox inserts 1 pending row; returns autoincrement id", () => {
    // Given: empty worker_inbox
    // When:  enqueueWorkerInbox(db, "STOP", Date.now())
    // Then:  returns id >= 1; SELECT COUNT(*) = 1; row has status='pending'
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openWorkerInboxDb(dbPath);
      const ts = Date.now();
      const id = enqueueWorkerInbox(db, "STOP", ts);
      assert.ok(typeof id === "number" && id >= 1, "T-WINBOX.CRUD.1: id >= 1");
      const count = (db.prepare("SELECT COUNT(*) AS c FROM worker_inbox").get() as { c: number }).c;
      assert.equal(count, 1, "T-WINBOX.CRUD.1: 1 row");
      const row = db.prepare("SELECT status, content, ts FROM worker_inbox WHERE id=?").get(id) as {
        status: string;
        content: string;
        ts: number;
      };
      assert.equal(row.status, "pending", "T-WINBOX.CRUD.1: status=pending");
      assert.equal(row.content, "STOP", "T-WINBOX.CRUD.1: content stored");
      assert.equal(row.ts, ts, "T-WINBOX.CRUD.1: ts stored");
    } finally {
      cleanup();
    }
  });

  it("T-WINBOX.CRUD.2: peekPendingWorkerInboxMessages returns only pending rows ordered by ts ASC", () => {
    // Given: 2 pending rows (ts=1000, ts=2000) + 1 deleted row (ts=500)
    // When:  deleteWorkerInboxMessages([id3]) then peekPendingWorkerInboxMessages(db)
    // Then:  returns 2 items ordered by ts ASC; deleted row not included
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openWorkerInboxDb(dbPath);
      const ts1 = 1000;
      const ts2 = 2000;
      const id1 = enqueueWorkerInbox(db, "MSG1", ts1);
      const id2 = enqueueWorkerInbox(db, "MSG2", ts2);
      const id3 = enqueueWorkerInbox(db, "DELETED", 500);
      // P-28.5: delete id3 (was mark-consumed in P-26; DELETE semantics now)
      deleteWorkerInboxMessages(db, [id3]);
      const rows = peekPendingWorkerInboxMessages(db);
      assert.equal(rows.length, 2, "T-WINBOX.CRUD.2: 2 pending rows returned");
      assert.equal(rows[0]!.id, id1, "T-WINBOX.CRUD.2: first row is id1 (ts=1000)");
      assert.equal(rows[1]!.id, id2, "T-WINBOX.CRUD.2: second row is id2 (ts=2000)");
      assert.equal(rows[0]!.content, "MSG1", "T-WINBOX.CRUD.2: content correct");
    } finally {
      cleanup();
    }
  });

  it("T-WINBOX.CRUD.3: deleteWorkerInboxMessages deletes targeted rows; other rows unaffected", () => {
    // Given: 3 pending rows with ids 1, 2, 3
    // When:  deleteWorkerInboxMessages(db, [id1, id2])
    // Then:  rows for id1 + id2 are GONE (SELECT returns undefined); id3 still pending
    //        (P-28.5 D-6: replaces mark-consumed with DELETE)
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openWorkerInboxDb(dbPath);
      const id1 = enqueueWorkerInbox(db, "A", Date.now());
      const id2 = enqueueWorkerInbox(db, "B", Date.now() + 1);
      const id3 = enqueueWorkerInbox(db, "C", Date.now() + 2);
      deleteWorkerInboxMessages(db, [id1, id2]);
      const row1 = db.prepare("SELECT id FROM worker_inbox WHERE id=?").get(id1);
      const row2 = db.prepare("SELECT id FROM worker_inbox WHERE id=?").get(id2);
      const row3 = db.prepare("SELECT status FROM worker_inbox WHERE id=?").get(id3) as { status: string } | undefined;
      assert.equal(row1, undefined, "T-WINBOX.CRUD.3: id1 DELETEd");
      assert.equal(row2, undefined, "T-WINBOX.CRUD.3: id2 DELETEd");
      assert.ok(row3 !== undefined, "T-WINBOX.CRUD.3: id3 still present");
      assert.equal(row3!.status, "pending", "T-WINBOX.CRUD.3: id3 still pending");
    } finally {
      cleanup();
    }
  });

  it("T-WINBOX.CRUD.4: deleteWorkerInboxMessages with empty ids array is a no-op", () => {
    // Given: 1 pending row
    // When:  deleteWorkerInboxMessages(db, [])
    // Then:  row still present (pending); no throw
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openWorkerInboxDb(dbPath);
      const id = enqueueWorkerInbox(db, "X", Date.now());
      // Should not throw
      deleteWorkerInboxMessages(db, []);
      const row = db.prepare("SELECT status FROM worker_inbox WHERE id=?").get(id) as { status: string };
      assert.equal(row.status, "pending", "T-WINBOX.CRUD.4: row still pending after empty delete");
    } finally {
      cleanup();
    }
  });
});
