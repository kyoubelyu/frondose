/**
 * P-26 Step 5 — T-WSP.1..2
 *
 * Tests for startWorkerServerPoll background loop.
 * Gate coverage: G-P26.25
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startWorkerServerPoll } from "../../src/cli/workerServerPoll.js";
import { openWorkerInboxDb, peekPendingWorkerInboxMessages } from "../../src/persistence/workerInbox.js";
import { cleanupTmpDir } from "../_helpers/tmp";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p26-wsp-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

const COORDS = { serverUrl: "http://test-server:3031", token: "tok", workerId: "w1" };

describe("startWorkerServerPoll (G-P26.25)", () => {
  it("T-WSP.1: when server returns 2 messages, both inserted into worker_inbox.sqlite with status=pending", async () => {
    // Given: startWorkerServerPoll(serverCoords, inboxDbPath, abortSignal); fetch mocked to return
    //        {messages:[{id:1,content:"STOP",ts:now},{id:2,content:"SHIFT",ts:now+1}]}
    // When:  first poll tick fires
    // Then:  2 rows in worker_inbox.sqlite with status='pending'; next re-schedule set
    const { dir, cleanup } = makeTmpDir();
    // biome-ignore lint/suspicious/noExplicitAny: global override
    const origFetch = (globalThis as any).fetch;
    try {
      const now = Date.now();
      const messages = [
        { id: 1, content: "STOP", ts: now },
        { id: 2, content: "SHIFT", ts: now + 1 },
      ];
      // biome-ignore lint/suspicious/noExplicitAny: global override
      (globalThis as any).fetch = async () => ({
        ok: true as const,
        json: async () => ({ messages }),
      });
      const inboxDbPath = join(dir, "worker_inbox.sqlite");
      const controller = new AbortController();
      // Large intervalMs so re-schedule doesn't fire during test
      startWorkerServerPoll(COORDS, inboxDbPath, controller.signal, 60_000);
      // Wait for first tick + DB write to complete
      await new Promise((r) => setTimeout(r, 200));
      controller.abort();
      const db = openWorkerInboxDb(inboxDbPath);
      const rows = peekPendingWorkerInboxMessages(db);
      assert.equal(rows.length, 2, `T-WSP.1: expected 2 pending rows; got ${rows.length}`);
      const contents = rows.map((r) => r.content).sort();
      assert.deepEqual(contents, ["SHIFT", "STOP"], "T-WSP.1: both message contents stored in worker_inbox");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (globalThis as any).fetch = origFetch;
      cleanup();
    }
  });

  it("T-WSP.2: when server returns {messages:[]}, no rows written to worker_inbox; next tick still scheduled", async () => {
    // Given: fetch mocked to return {messages:[]}
    // When:  tick fires
    // Then:  worker_inbox row count = 0; setTimeout rescheduled
    const { dir, cleanup } = makeTmpDir();
    // biome-ignore lint/suspicious/noExplicitAny: global override
    const origFetch = (globalThis as any).fetch;
    let fetchCallCount = 0;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: global override
      (globalThis as any).fetch = async () => {
        fetchCallCount++;
        return { ok: true as const, json: async () => ({ messages: [] }) };
      };
      const inboxDbPath = join(dir, "worker_inbox.sqlite");
      const controller = new AbortController();
      startWorkerServerPoll(COORDS, inboxDbPath, controller.signal, 60_000);
      await new Promise((r) => setTimeout(r, 200));
      controller.abort();
      // DB may not exist yet (no rows → no DB created); create it to verify 0 rows
      const db = openWorkerInboxDb(inboxDbPath);
      const rows = peekPendingWorkerInboxMessages(db);
      assert.equal(rows.length, 0, "T-WSP.2: no rows written when messages=[]");
      assert.equal(fetchCallCount, 1, "T-WSP.2: fetch was called exactly once (tick fired)");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (globalThis as any).fetch = origFetch;
      cleanup();
    }
  });
});
