/**
 * P-26 Step 5 — T-WORKERS.ADD.1, T-WORKERS.ROTATE.1, T-WORKERS.REMOVE.1,
 *               T-WORKERS.LIST.1, T-WORKERS.AUTH.1..3
 *
 * Persistence tests for workers.sqlite CRUD via workersRegistry.ts.
 * Gate coverage: G-P26.9, G-P26.10, G-P26.11, G-P26.12, G-P26.13
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  addWorker,
  getWorkerByTokenHashConstantTime,
  insertLeadAction,
  listWorkers,
  openWorkersDb,
  removeWorker,
  rotateWorkerToken,
} from "../../src/persistence/workersRegistry.js";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function makeTmpDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p26-workers-"));
  return { dbPath: join(dir, "workers.sqlite"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("workersRegistry CRUD (G-P26.9, G-P26.10, G-P26.11, G-P26.12, G-P26.13)", () => {
  it("T-WORKERS.ADD.1: when empty db, addWorker stores sha256(token) and sets added_at", () => {
    // Given: empty workers.sqlite
    // When:  addWorker({worker_id:"w1", token:"t1"})
    // Then:  row exists with token_hash = sha256("t1"); added_at set
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openWorkersDb(dbPath);
      const before = Date.now();
      addWorker(db, "w1", "t1", "host1", "sales");
      const rows = db.prepare("SELECT * FROM workers WHERE worker_id='w1'").all() as Array<{
        worker_id: string;
        token_hash: string;
        added_at: number;
        status: string;
        hostname: string;
        persona: string;
      }>;
      assert.equal(rows.length, 1, "T-WORKERS.ADD.1: exactly 1 row");
      const row = rows[0]!;
      assert.equal(row.token_hash, sha256("t1"), "T-WORKERS.ADD.1: token_hash = sha256(t1)");
      assert.ok(row.added_at >= before, "T-WORKERS.ADD.1: added_at >= before");
      assert.equal(row.status, "active", "T-WORKERS.ADD.1: status defaults to active");
      assert.equal(row.hostname, "host1", "T-WORKERS.ADD.1: hostname stored");
    } finally {
      cleanup();
    }
  });

  it("T-WORKERS.ROTATE.1: when existing worker w1, rotateWorkerToken replaces hash and returns true", () => {
    // Given: row with token_hash = sha256("t1")
    // When:  rotateWorkerToken("w1", "t2")
    // Then:  token_hash = sha256("t2"); returns true; no extra row
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openWorkersDb(dbPath);
      addWorker(db, "w1", "t1");
      const ok = rotateWorkerToken(db, "w1", "t2");
      assert.equal(ok, true, "T-WORKERS.ROTATE.1: rotateWorkerToken returns true");
      const row = db.prepare("SELECT token_hash FROM workers WHERE worker_id='w1'").get() as {
        token_hash: string;
      };
      assert.equal(row.token_hash, sha256("t2"), "T-WORKERS.ROTATE.1: token_hash now sha256(t2)");
      const count = (db.prepare("SELECT COUNT(*) AS c FROM workers").get() as { c: number }).c;
      assert.equal(count, 1, "T-WORKERS.ROTATE.1: still 1 row only");
    } finally {
      cleanup();
    }
  });

  it("T-WORKERS.REMOVE.1: when worker w1 exists with 2 lead_actions, removeWorker deletes the workers row; lead_actions untouched", () => {
    // Given: workers row + 2 lead_actions rows for w1
    // When:  removeWorker("w1")
    // Then:  workers row deleted; lead_actions rows preserved (history)
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openWorkersDb(dbPath);
      addWorker(db, "w1", "t1");
      insertLeadAction(db, "https://www.linkedin.com/in/alice/", "connect", "w1", Date.now());
      insertLeadAction(db, "https://www.linkedin.com/in/bob/", "message", "w1", Date.now());
      const ok = removeWorker(db, "w1");
      assert.equal(ok, true, "T-WORKERS.REMOVE.1: removeWorker returns true");
      const wCount = (db.prepare("SELECT COUNT(*) AS c FROM workers WHERE worker_id='w1'").get() as { c: number }).c;
      assert.equal(wCount, 0, "T-WORKERS.REMOVE.1: workers row deleted");
      const laCount = (db.prepare("SELECT COUNT(*) AS c FROM lead_actions WHERE worker_id='w1'").get() as { c: number })
        .c;
      assert.equal(laCount, 2, "T-WORKERS.REMOVE.1: lead_actions rows preserved");
    } finally {
      cleanup();
    }
  });

  it("T-WORKERS.LIST.1: listWorkers returns all 3 rows with no token_hash field", () => {
    // Given: 3 workers with mixed status (2 active, 1 revoked)
    // When:  listWorkers()
    // Then:  returns array of 3 entries with worker_id/hostname/persona/status/last_heartbeat; NO token_hash
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openWorkersDb(dbPath);
      addWorker(db, "w1", "t1", "h1");
      addWorker(db, "w2", "t2");
      addWorker(db, "w3", "t3");
      db.prepare("UPDATE workers SET status='revoked' WHERE worker_id='w3'").run();
      const rows = listWorkers(db);
      assert.equal(rows.length, 3, "T-WORKERS.LIST.1: 3 rows returned");
      for (const r of rows) {
        assert.ok(!("token_hash" in r), "T-WORKERS.LIST.1: no token_hash in any row");
        assert.ok("worker_id" in r, "T-WORKERS.LIST.1: worker_id present");
        assert.ok("status" in r, "T-WORKERS.LIST.1: status present");
        assert.ok("last_heartbeat" in r, "T-WORKERS.LIST.1: last_heartbeat present");
      }
      const statuses = rows.map((r) => r.status);
      assert.ok(statuses.includes("revoked"), "T-WORKERS.LIST.1: revoked worker in results");
      assert.equal(statuses.filter((s) => s === "active").length, 2, "T-WORKERS.LIST.1: 2 active");
    } finally {
      cleanup();
    }
  });

  it("T-WORKERS.AUTH.1: verifyWorkerToken('good') returns active worker row", () => {
    // Given: row token_hash = sha256("good"); status = 'active'
    // When:  query with token "good"
    // Then:  returns {worker_id:"w1", status:"active"}
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openWorkersDb(dbPath);
      addWorker(db, "w1", "good");
      const tokenHash = sha256("good");
      const result = getWorkerByTokenHashConstantTime(db, tokenHash);
      assert.ok(result !== null, "T-WORKERS.AUTH.1: result not null");
      assert.equal(result!.worker_id, "w1", "T-WORKERS.AUTH.1: worker_id = w1");
      assert.equal(result!.status, "active", "T-WORKERS.AUTH.1: status = active");
    } finally {
      cleanup();
    }
  });

  it("T-WORKERS.AUTH.2: verifyWorkerToken('bad') returns null for wrong token", () => {
    // Given: row with token_hash = sha256("good")
    // When:  query with token "bad"
    // Then:  returns null
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openWorkersDb(dbPath);
      addWorker(db, "w1", "good");
      const badHash = sha256("bad");
      const result = getWorkerByTokenHashConstantTime(db, badHash);
      assert.equal(result, null, "T-WORKERS.AUTH.2: null returned for bad token");
    } finally {
      cleanup();
    }
  });

  it("T-WORKERS.AUTH.3: revoked worker returns null even with correct token", () => {
    // Given: row status = 'revoked'; token_hash = sha256("good")
    // When:  query with correct token
    // Then:  returns null (revoked workers cannot auth)
    const { dbPath, cleanup } = makeTmpDb();
    try {
      const db = openWorkersDb(dbPath);
      addWorker(db, "w1", "good");
      db.prepare("UPDATE workers SET status='revoked' WHERE worker_id='w1'").run();
      // getWorkerByTokenHashConstantTime only checks active rows
      const tokenHash = sha256("good");
      const result = getWorkerByTokenHashConstantTime(db, tokenHash);
      assert.equal(result, null, "T-WORKERS.AUTH.3: null for revoked worker");
    } finally {
      cleanup();
    }
  });
});
