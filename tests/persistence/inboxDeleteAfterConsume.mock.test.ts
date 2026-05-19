/**
 * P-28.5 Step 4a — T-DAC.1..5
 *
 * Tests for DELETE-after-consume behavior in the server and worker inbox layers.
 * Gate coverage:
 *   G-P28.5.14 (drainPendingWorkerInbox DELETEs drained rows — COUNT=0 after)
 *   G-P28.5.15 (deleteWorkerInboxMessages DELETEs worker_inbox rows — COUNT=0 after)
 *   G-P28.5.16 (at-most-once delivery preserved after DELETE — re-drain yields [])
 *   G-P28.5.21 (normal send_worker_message directive still drains + injects exactly once)
 *
 * DI surface:
 *   Server inbox: enqueueWorkerPending + drainPendingWorkerInbox (src/persistence/serverInbox.ts)
 *   Worker inbox: enqueueWorkerInbox + peekPendingWorkerInboxMessages +
 *                 deleteWorkerInboxMessages (src/persistence/workerInbox.ts) — P-28.5 rename
 *   CLI orchestrator: drainWorkerInbox (src/cli/workerInbox.ts) — uses MockLanguageModelV1
 *
 * All tests use `:memory:` DBs (server inbox) or temp-file DBs (worker inbox).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { MockLanguageModelV1 } from "ai/test";
import type { RunCronTurnDeps } from "../../src/cli/replCron.js";
import { drainWorkerInbox } from "../../src/cli/workerInbox.js";
import {
  drainPendingWorkerInbox,
  enqueueWorkerPending,
  openServerInboxDb,
  pendingWorkerInboxCount,
} from "../../src/persistence/serverInbox.js";
import {
  deleteWorkerInboxMessages,
  enqueueWorkerInbox,
  openWorkerInboxDb,
  peekPendingWorkerInboxMessages,
} from "../../src/persistence/workerInbox.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p28.5-dac-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Immediate MockLanguageModelV1 — finishes stream in one tick (no output). */
function makeImmediateModel(): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    provider: "openai",
    modelId: "test-dac",
    doStream: async () => ({
      rawCall: { rawPrompt: null as unknown, rawSettings: {} as Record<string, unknown> },
      stream: Readable.toWeb(
        Readable.from([{ type: "finish", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } }]),
        // biome-ignore lint/suspicious/noExplicitAny: cast for stream type
      ) as unknown as ReadableStream<any>,
    }),
  });
}

/** Throwing MockLanguageModelV1 — proves runAgentLoop was never called when used. */
function makeThrowingModel(): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    provider: "openai",
    modelId: "test-dac-throw",
    doStream: async () => {
      throw new Error("mock-runAgentLoop-throw-dac");
    },
  });
}

function makeDeps(dir: string, model: MockLanguageModelV1): RunCronTurnDeps {
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(sessionFile, "", "utf-8");
  return {
    model,
    system: "test",
    messages: [],
    tools: {},
    sessionFile,
    out: process.stdout,
  };
}

// ─── T-DAC.1 ──────────────────────────────────────────────────────────────────

describe("drainPendingWorkerInbox DELETEs drained rows (G-P28.5.14)", () => {
  it("T-DAC.1: given :memory: serverInboxDb with 2 pending rows for 'w1', when drainPendingWorkerInbox(db,'w1',0), returns 2 rows and SELECT COUNT(*) FROM worker_pending WHERE worker_id='w1' === 0", async () => {
    // Given: :memory: server inbox; 2 rows enqueued for worker 'w1'
    // When:  drainPendingWorkerInbox(db, 'w1', 0) — timeout=0 means return immediately with found rows
    // Then:  returns array of 2 rows; total worker_pending count for 'w1' === 0 (DELETEd)
    const db = openServerInboxDb(":memory:");
    enqueueWorkerPending(db, "w1", "msg-alpha");
    enqueueWorkerPending(db, "w1", "msg-beta");
    // timeout=100ms: loop runs once, finds rows immediately, deletes + returns before sleeping
    const rows = await drainPendingWorkerInbox(db, "w1", 100);
    assert.equal(rows.length, 2, "T-DAC.1: returned 2 rows");
    assert.ok(
      rows.some((r) => r.content === "msg-alpha"),
      "T-DAC.1: msg-alpha present",
    );
    assert.ok(
      rows.some((r) => r.content === "msg-beta"),
      "T-DAC.1: msg-beta present",
    );
    const count = (db.prepare("SELECT COUNT(*) AS c FROM worker_pending WHERE worker_id='w1'").get() as { c: number })
      .c;
    assert.equal(count, 0, "T-DAC.1: COUNT=0 after drain (rows DELETEd, not marked consumed)");
  });
});

// ─── T-DAC.2 ──────────────────────────────────────────────────────────────────

describe("drainPendingWorkerInbox: re-drain after DELETE returns [] (G-P28.5.16)", () => {
  it("T-DAC.2: given same :memory: DB after T-DAC.1 drain, when drainPendingWorkerInbox again (timeout=0), returns [] — no resurrected 'consumed' rows", async () => {
    // Given: :memory: DB with 2 rows enqueued; first drain runs + DELETEs them
    // When:  drainPendingWorkerInbox called again on same DB
    // Then:  returns [] — rows are gone, not lingering as status='consumed'
    const db = openServerInboxDb(":memory:");
    enqueueWorkerPending(db, "w1", "only-once-1");
    enqueueWorkerPending(db, "w1", "only-once-2");
    // First drain — timeout=100ms so loop runs once (rows present → immediate return)
    await drainPendingWorkerInbox(db, "w1", 100);
    // Verify rows are truly gone (not lingering as 'consumed')
    const countAfterFirst = (
      db.prepare("SELECT COUNT(*) AS c FROM worker_pending WHERE worker_id='w1'").get() as { c: number }
    ).c;
    assert.equal(countAfterFirst, 0, "T-DAC.2: rows DELETEd, not lingering as status='consumed'");
    // Second drain with timeout=0 — loop skipped entirely (deadline already past), returns []
    const rows2 = await drainPendingWorkerInbox(db, "w1", 0);
    assert.deepEqual(rows2, [], "T-DAC.2: second drain returns [] — at-most-once delivery confirmed");
  });
});

// ─── T-DAC.3 ──────────────────────────────────────────────────────────────────

describe("deleteWorkerInboxMessages DELETEs worker_inbox rows (G-P28.5.15)", () => {
  it("T-DAC.3: given :memory: workerInboxDb with 2 enqueued rows, when peekPending → deleteWorkerInboxMessages(ids), peekPendingWorkerInboxMessages returns [] and SELECT COUNT(*) === 0", async () => {
    // Given: :memory: worker inbox; 2 rows enqueued via enqueueWorkerInbox
    //        IDs collected via peekPendingWorkerInboxMessages
    // When:  deleteWorkerInboxMessages(db, ids)
    // Then:  peekPendingWorkerInboxMessages(db) === []
    //        SELECT COUNT(*) FROM worker_inbox === 0 (rows DELETEd, not flagged)
    const db = openWorkerInboxDb(":memory:");
    enqueueWorkerInbox(db, "row-one");
    enqueueWorkerInbox(db, "row-two");
    const pending = peekPendingWorkerInboxMessages(db);
    const ids = pending.map((r) => r.id);
    deleteWorkerInboxMessages(db, ids);
    const afterPending = peekPendingWorkerInboxMessages(db);
    assert.deepEqual(afterPending, [], "T-DAC.3: peekPending returns [] after deleteWorkerInboxMessages");
    const totalCount = (db.prepare("SELECT COUNT(*) AS c FROM worker_inbox").get() as { c: number }).c;
    assert.equal(totalCount, 0, "T-DAC.3: COUNT(*) FROM worker_inbox === 0 — rows DELETEd, not flagged");
  });
});

// ─── T-DAC.4 ──────────────────────────────────────────────────────────────────

describe("pendingWorkerInboxCount returns 0 after DELETE-after-consume drain (G-P28.5.14)", () => {
  it("T-DAC.4: given :memory: serverInboxDb with 3 rows, after drainPendingWorkerInbox, pendingWorkerInboxCount === 0", async () => {
    // Given: :memory: server inbox; 3 rows for 'w1'
    // When:  drainPendingWorkerInbox(db, 'w1', 0)
    // Then:  pendingWorkerInboxCount(db, 'w1') === 0 (helper still works post-DELETE)
    const db = openServerInboxDb(":memory:");
    enqueueWorkerPending(db, "w1", "c1");
    enqueueWorkerPending(db, "w1", "c2");
    enqueueWorkerPending(db, "w1", "c3");
    await drainPendingWorkerInbox(db, "w1", 100);
    const count = pendingWorkerInboxCount(db, "w1");
    assert.equal(count, 0, "T-DAC.4: pendingWorkerInboxCount===0 after drain (helper works post-DELETE)");
  });
});

// ─── T-DAC.5 ──────────────────────────────────────────────────────────────────

describe("drainWorkerInbox: 2-row inbox injected once; re-drain injects nothing (G-P28.5.16 + G-P28.5.21)", () => {
  it("T-DAC.5: given 2-row worker_inbox, when drainWorkerInbox runs (immediate model), each row injected once; second drainWorkerInbox (throwing model) injects nothing; SELECT COUNT(*) FROM worker_inbox === 0 after first drain", async () => {
    // Given: worker_inbox.sqlite with 2 pending rows; immediate model for first drain
    //        throwing model for second drain (proves second drain is a no-op)
    // When:  first drainWorkerInbox → 2 user messages pushed; rows DELETEd
    //        second drainWorkerInbox → 0 new messages; no throw
    // Then:  first drain: deps.messages has 2 user-role messages; COUNT(*) === 0
    //        second drain: deps2.messages.length === 0 (no double-inject)
    const { dir, cleanup } = makeTmpDir();
    try {
      const dbPath = join(dir, "inbox.sqlite");
      const db = openWorkerInboxDb(dbPath);
      enqueueWorkerInbox(db, "DIRECTIVE-1", 1000);
      enqueueWorkerInbox(db, "DIRECTIVE-2", 2000);
      const deps1 = makeDeps(dir, makeImmediateModel());
      await drainWorkerInbox(dbPath, undefined, deps1);
      // After first drain: worker_inbox DELETEd
      const afterCount = (db.prepare("SELECT COUNT(*) AS c FROM worker_inbox").get() as { c: number }).c;
      assert.equal(afterCount, 0, "T-DAC.5: worker_inbox rows DELETEd after first drain");
      // Both directives were injected as user-role messages
      const userMsgs = deps1.messages.filter((m) => m.role === "user");
      assert.ok(userMsgs.length >= 2, "T-DAC.5: both directives injected as user messages");
      // Second drain with throwing model — inbox is empty → early return, model never called
      const dir2 = join(dir, "s2");
      mkdirSync(dir2, { recursive: true });
      const deps2 = makeDeps(dir2, makeThrowingModel());
      await drainWorkerInbox(dbPath, undefined, deps2); // must NOT throw
      assert.equal(deps2.messages.length, 0, "T-DAC.5: second drain injects nothing — no double-inject");
    } finally {
      cleanup();
    }
  });
});
