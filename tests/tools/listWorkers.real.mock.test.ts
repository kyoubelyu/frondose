/**
 * P-26 Step 5 — T-LW.1..3
 *
 * Tests for makeListWorkersTool (real impl replacing P-25 stub).
 * Gate coverage: G-P26.22
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addWorker, openWorkersDb } from "../../src/persistence/workersRegistry.js";
import { makeListWorkersTool } from "../../src/tools/server/listWorkers.js";
import { cleanupTmpDir } from "../_helpers/tmp";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p26-lw-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

describe("list_workers real impl (G-P26.22)", () => {
  it("T-LW.1: workers.sqlite has 2 active + 1 revoked; execute returns all 3; no token_hash in response", async () => {
    // Given: workers.sqlite with 2 active rows + 1 revoked; workersDb opened
    // When:  makeListWorkersTool(workersDb).execute({})
    // Then:  {workers: [{worker_id, hostname, persona, status, last_heartbeat}, ...]};
    //        length=3; no entry has a token_hash field; all status values present
    const { dir, cleanup } = makeTmpDir();
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      addWorker(workersDb, "w1", "t1", "host1", "sales");
      addWorker(workersDb, "w2", "t2");
      addWorker(workersDb, "w3", "t3", "host3");
      workersDb.prepare("UPDATE workers SET status='revoked' WHERE worker_id='w3'").run();
      const tool = makeListWorkersTool(workersDb);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = (await (tool.execute as (a: unknown, o: object) => Promise<any>)({}, {})) as {
        workers: Array<Record<string, unknown>>;
      };
      assert.ok(Array.isArray(result.workers), "T-LW.1: workers is array");
      assert.equal(result.workers.length, 3, "T-LW.1: 3 workers returned");
      for (const w of result.workers) {
        assert.ok(!("token_hash" in w), "T-LW.1: no token_hash in any entry");
        assert.ok("worker_id" in w, "T-LW.1: worker_id present");
        assert.ok("status" in w, "T-LW.1: status present");
        assert.ok("last_heartbeat" in w, "T-LW.1: last_heartbeat present");
      }
      const statuses = result.workers.map((w) => w.status as string);
      assert.ok(statuses.includes("revoked"), "T-LW.1: revoked status present");
      assert.equal(statuses.filter((s) => s === "active").length, 2, "T-LW.1: 2 active workers");
    } finally {
      cleanup();
    }
  });

  it("T-LW.2: empty workers.sqlite returns {workers:[]}", async () => {
    // Given: workers.sqlite empty (just schema tables)
    // When:  execute({})
    // Then:  {workers: []}
    const { dir, cleanup } = makeTmpDir();
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const tool = makeListWorkersTool(workersDb);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = (await (tool.execute as (a: unknown, o: object) => Promise<any>)({}, {})) as {
        workers: unknown[];
      };
      assert.deepEqual(result, { workers: [] }, "T-LW.2: empty workers array");
    } finally {
      cleanup();
    }
  });

  it("T-LW.3: makeListWorkersTool(null) execute returns {workers:[], note:'workers.sqlite not yet initialized'}", async () => {
    // Given: workersDb=null (server boot before workers DB created)
    // When:  execute({})
    // Then:  {workers: [], note: "workers.sqlite not yet initialized"}
    const tool = makeListWorkersTool(null);
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const result = await (tool.execute as (a: unknown, o: object) => Promise<any>)({}, {});
    assert.deepEqual(
      result,
      {
        workers: [],
        note: "workers.sqlite not yet initialized",
      },
      "T-LW.3: graceful null-DB response",
    );
  });
});
