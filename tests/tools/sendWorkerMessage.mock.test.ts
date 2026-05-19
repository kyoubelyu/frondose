/**
 * P-26 Step 5 — T-SWM.NULL, T-SWM.1..2 (server-side send_worker_message tool)
 *
 * Tests for makeSendWorkerMessageTool.
 * Gate coverage: G-P26.21
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openServerInboxDb } from "../../src/persistence/serverInbox.js";
import { addWorker, openWorkersDb } from "../../src/persistence/workersRegistry.js";
import { makeSendWorkerMessageTool } from "../../src/tools/server/sendWorkerMessage.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p26-swm-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("send_worker_message tool (G-P26.21)", () => {
  it("T-SWM.NULL: when workersDb=null AND serverInboxDb=null, execute returns {ok:false, error:'Server registry unavailable'}", async () => {
    // Given: makeSendWorkerMessageTool(null, null) — Step-3b C-1 null guard
    // When:  execute({workerId:"w1", content:"STOP"})
    // Then:  {ok:false, error:"Server registry unavailable"}
    const tool = makeSendWorkerMessageTool(null, null);
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const result = await (tool.execute as (a: unknown, o: object) => Promise<any>)(
      { workerId: "w1", content: "STOP" },
      {},
    );
    assert.deepEqual(result, { ok: false, error: "Server registry unavailable" }, "T-SWM.NULL: null-guard envelope");
  });

  it("T-SWM.1: when worker w1 in workers.sqlite, execute inserts into worker_pending and returns {ok:true, queuedId:n}", async () => {
    // Given: workers.sqlite has active w1; server inbox.sqlite open
    // When:  execute({workerId:"w1", content:"STOP outreach for 24h"})
    // Then:  {ok:true, queuedId: number}; 1 row in worker_pending for w1
    const { dir, cleanup } = makeTmpDir();
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      addWorker(workersDb, "w1", "token1");
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      const tool = makeSendWorkerMessageTool(workersDb, serverInboxDb);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = (await (tool.execute as (a: unknown, o: object) => Promise<any>)(
        { workerId: "w1", content: "STOP outreach for 24h" },
        {},
      )) as { ok: boolean; queuedId: number };
      assert.equal(result.ok, true, "T-SWM.1: ok=true");
      assert.ok(typeof result.queuedId === "number" && result.queuedId >= 1, "T-SWM.1: queuedId is number >= 1");
      const count = (
        serverInboxDb.prepare("SELECT COUNT(*) AS c FROM worker_pending WHERE worker_id='w1'").get() as { c: number }
      ).c;
      assert.equal(count, 1, "T-SWM.1: 1 row in worker_pending");
      const row = serverInboxDb.prepare("SELECT content FROM worker_pending WHERE worker_id='w1'").get() as {
        content: string;
      };
      assert.equal(row.content, "STOP outreach for 24h", "T-SWM.1: content stored correctly");
    } finally {
      cleanup();
    }
  });

  it("T-SWM.2: when workerId not in workers.sqlite, execute returns {ok:false, error:'unknown or revoked worker w_unknown'}", async () => {
    // Given: workers.sqlite exists but has no row for "w_unknown"
    // When:  execute({workerId:"w_unknown", content:"x"})
    // Then:  {ok:false, error: string containing "unknown"}
    const { dir, cleanup } = makeTmpDir();
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      const tool = makeSendWorkerMessageTool(workersDb, serverInboxDb);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = (await (tool.execute as (a: unknown, o: object) => Promise<any>)(
        { workerId: "w_unknown", content: "x" },
        {},
      )) as { ok: boolean; error: string };
      assert.equal(result.ok, false, "T-SWM.2: ok=false for unknown worker");
      assert.ok(result.error.includes("unknown"), `T-SWM.2: error contains 'unknown'; got: ${result.error}`);
    } finally {
      cleanup();
    }
  });
});
