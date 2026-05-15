/**
 * P-26 Step 5 — T-WINBOX.CRUD.1..4 (persistence CRUD only)
 *
 * Tests for src/persistence/workerInbox.ts — DB CRUD helpers only.
 * No runAgentLoop calls — orchestration is tested in tests/cli/workerInbox.mock.test.ts.
 * Gate coverage: G-P26.14 (drain preconditions)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  enqueueWorkerInbox,
  markWorkerInboxMessagesConsumed,
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
    // Given: 2 pending + 1 consumed rows; pending ts values differ
    // When:  peekPendingWorkerInboxMessages(db)
    // Then:  returns 2 items; first has smaller ts; consumed row not included
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openWorkerInboxDb(dbPath);
      const ts1 = 1000;
      const ts2 = 2000;
      const id1 = enqueueWorkerInbox(db, "MSG1", ts1);
      const id2 = enqueueWorkerInbox(db, "MSG2", ts2);
      const id3 = enqueueWorkerInbox(db, "CONSUMED", 500);
      // Mark id3 consumed
      markWorkerInboxMessagesConsumed(db, [id3]);
      const rows = peekPendingWorkerInboxMessages(db);
      assert.equal(rows.length, 2, "T-WINBOX.CRUD.2: 2 pending rows returned");
      assert.equal(rows[0]!.id, id1, "T-WINBOX.CRUD.2: first row is id1 (ts=1000)");
      assert.equal(rows[1]!.id, id2, "T-WINBOX.CRUD.2: second row is id2 (ts=2000)");
      assert.equal(rows[0]!.content, "MSG1", "T-WINBOX.CRUD.2: content correct");
    } finally {
      cleanup();
    }
  });

  it("T-WINBOX.CRUD.3: markWorkerInboxMessagesConsumed updates rows to status='consumed'; other rows unaffected", () => {
    // Given: 3 pending rows with ids 1, 2, 3
    // When:  markWorkerInboxMessagesConsumed(db, [id1, id2])
    // Then:  row 1 + 2 have status='consumed'; row 3 still 'pending'
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openWorkerInboxDb(dbPath);
      const id1 = enqueueWorkerInbox(db, "A", Date.now());
      const id2 = enqueueWorkerInbox(db, "B", Date.now() + 1);
      const id3 = enqueueWorkerInbox(db, "C", Date.now() + 2);
      markWorkerInboxMessagesConsumed(db, [id1, id2]);
      const row1 = db.prepare("SELECT status FROM worker_inbox WHERE id=?").get(id1) as { status: string };
      const row2 = db.prepare("SELECT status FROM worker_inbox WHERE id=?").get(id2) as { status: string };
      const row3 = db.prepare("SELECT status FROM worker_inbox WHERE id=?").get(id3) as { status: string };
      assert.equal(row1.status, "consumed", "T-WINBOX.CRUD.3: id1 consumed");
      assert.equal(row2.status, "consumed", "T-WINBOX.CRUD.3: id2 consumed");
      assert.equal(row3.status, "pending", "T-WINBOX.CRUD.3: id3 still pending");
    } finally {
      cleanup();
    }
  });

  it("T-WINBOX.CRUD.4: markWorkerInboxMessagesConsumed with empty ids array is a no-op", () => {
    // Given: 1 pending row
    // When:  markWorkerInboxMessagesConsumed(db, [])
    // Then:  row still pending; no throw
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openWorkerInboxDb(dbPath);
      const id = enqueueWorkerInbox(db, "X", Date.now());
      // Should not throw
      markWorkerInboxMessagesConsumed(db, []);
      const row = db.prepare("SELECT status FROM worker_inbox WHERE id=?").get(id) as { status: string };
      assert.equal(row.status, "pending", "T-WINBOX.CRUD.4: row still pending after empty mark");
    } finally {
      cleanup();
    }
  });
});
