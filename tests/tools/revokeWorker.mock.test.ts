/**
 * P-27 Step 5 — T-REV.1..3
 *
 * Tests for src/tools/server/revokeWorker.ts — makeRevokeWorkerTool.
 * Gate coverage: G-P27.13 (remove worker from registry; 401 on subsequent heartbeat)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addWorker, listWorkers, openWorkersDb } from "../../src/persistence/workersRegistry.js";
import { makeRevokeWorkerTool } from "../../src/tools/server/revokeWorker.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p27-rev-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─── T-REV.1 ─────────────────────────────────────────────────────────────────

describe("revoke_worker — happy path (G-P27.13)", () => {
  it("T-REV.1: given workers.sqlite has w1, execute({workerId:'w1'}) returns {ok:true, message:'w1 revoked...'} and row deleted", async () => {
    // Given: workersDb has worker_id='w1' (status='active')
    // When:  tool.execute({workerId:'w1'})
    // Then:  result.ok=true; result.message contains 'w1 revoked';
    //        listWorkers(workersDb) returns [] (row deleted)
    const { dir, cleanup } = makeTmpDir();
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      addWorker(workersDb, "w1", "token_for_w1");
      const tool = makeRevokeWorkerTool(workersDb);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = await (tool.execute as unknown as (a: unknown, o: object) => Promise<any>)({ workerId: "w1" }, {});
      assert.equal(result.ok, true, `expected ok=true; got: ${JSON.stringify(result)}`);
      assert.ok(
        typeof result.message === "string" && result.message.includes("w1"),
        `expected message containing 'w1'; got: ${result.message}`,
      );
      // Row must be deleted
      const workers = listWorkers(workersDb);
      assert.equal(workers.length, 0, "worker row must be deleted after revoke");
    } finally {
      cleanup();
    }
  });
});

// ─── T-REV.2 ─────────────────────────────────────────────────────────────────

describe("revoke_worker — workersDb null (G-P27.13 null guard)", () => {
  it("T-REV.2: given workersDb=null, execute returns {ok:false, error:'workers.sqlite not initialized'}", async () => {
    // Given: makeRevokeWorkerTool(null) — DB not initialized
    // When:  tool.execute({workerId:'w1'})
    // Then:  result.ok=false; result.error='workers.sqlite not initialized'
    const tool = makeRevokeWorkerTool(null);
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const result = await (tool.execute as unknown as (a: unknown, o: object) => Promise<any>)({ workerId: "w1" }, {});
    assert.equal(result.ok, false);
    assert.equal(result.error, "workers.sqlite not initialized");
  });
});

// ─── T-REV.3 ─────────────────────────────────────────────────────────────────

describe("revoke_worker — workerId not found (G-P27.13)", () => {
  it("T-REV.3: given workerId not in workers.sqlite, execute returns {ok:false, error:'worker_id not found:...'}", async () => {
    // Given: workersDb is open but has NO row for 'ghost_worker'
    // When:  tool.execute({workerId:'ghost_worker'})
    // Then:  result.ok=false; result.error contains 'worker_id not found'
    const { dir, cleanup } = makeTmpDir();
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const tool = makeRevokeWorkerTool(workersDb);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = await (tool.execute as unknown as (a: unknown, o: object) => Promise<any>)({ workerId: "ghost_worker" }, {});
      assert.equal(result.ok, false);
      assert.ok(
        typeof result.error === "string" && result.error.includes("worker_id not found"),
        `expected error containing 'worker_id not found'; got: ${result.error}`,
      );
      assert.ok(result.error.includes("ghost_worker"), "error must mention the workerId");
    } finally {
      cleanup();
    }
  });
});
