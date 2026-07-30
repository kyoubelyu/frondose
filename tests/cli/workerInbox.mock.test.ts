/**
 * P-26 Step 5 — T-WINBOX.1..4 (orchestrator — CLI layer)
 *
 * Tests for src/cli/workerInbox.ts — drainWorkerInbox orchestrator.
 * Verifies delete-batch-BEFORE-inject invariant + current Pi-loop delegation.
 * Gate coverage: G-P26.14
 *
 * Uses the fail-closed controlled Pi helper; configured providers and ambient
 * network are unreachable.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { RunCronTurnDeps } from "../../src/cli/replCron.js";
import { drainWorkerInbox } from "../../src/cli/workerInbox.js";
import { loadMessages } from "../../src/persistence/session.js";
import { enqueueWorkerInbox, openWorkerInboxDb } from "../../src/persistence/workerInbox.js";
import { cleanupTmpDir } from "../_helpers/tmp";
import { appendAssistant, createPiLoopMock } from "./_helpers/piLoopMock.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p26-wibdrain-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

const piLoop = createPiLoopMock();
before(() => piLoop.install());
beforeEach(() => piLoop.reset());
after(() => piLoop.restore());

function makeDeps(dir: string): RunCronTurnDeps {
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(sessionFile, "", "utf-8");
  return {
    model: {} as RunCronTurnDeps["model"],
    system: "test",
    messages: [],
    tools: {},
    sessionFile,
    out: process.stdout,
  };
}

describe("drainWorkerInbox orchestrator (G-P26.14)", () => {
  it("T-WINBOX.1: with 2 pending rows, drainWorkerInbox deletes the full batch FIRST then injects each row through one Pi call", async () => {
    // Given: worker_inbox.sqlite has MSG1 then MSG2 and two controlled Pi scripts
    // When:  drainWorkerInbox(dbPath, undefined, deps)
    // Then: the DB is empty before Pi call 1; exact user/assistant pairs reach memory and session in order
    const { dir, cleanup } = makeTmpDir();
    try {
      const dbPath = join(dir, "inbox.sqlite");
      const db = openWorkerInboxDb(dbPath);
      enqueueWorkerInbox(db, "MSG1", 1000);
      enqueueWorkerInbox(db, "MSG2", 2000);
      const deps = makeDeps(dir);
      piLoop.queue(
        async (opts) => {
          const rowCount = (db.prepare("SELECT COUNT(*) AS c FROM worker_inbox").get() as { c: number }).c;
          assert.equal(rowCount, 0, "entire inbox batch must be deleted before the first loop call");
          assert.equal(opts.messages.at(-1)?.content, "MSG1");
          appendAssistant(opts, "ACK1");
        },
        async (opts) => {
          assert.equal(opts.messages.at(-1)?.content, "MSG2");
          appendAssistant(opts, "ACK2");
        },
      );
      await drainWorkerInbox(dbPath, undefined, deps);
      piLoop.assertDrained(2);
      // Verify the pending snapshot was deleted before loop execution.
      const pending = (
        db.prepare("SELECT COUNT(*) AS c FROM worker_inbox WHERE status='pending'").get() as { c: number }
      ).c;
      assert.equal(pending, 0, "T-WINBOX.1: 0 pending rows after delete-before-loop drain");
      // P-28.5 D-6: the full batch is deleted before the first Pi call.
      const allRows = (db.prepare("SELECT COUNT(*) AS c FROM worker_inbox").get() as { c: number }).c;
      assert.equal(allRows, 0, "T-WINBOX.1: all rows deleted by the batch snapshot (D-6)");
      // Verify messages were injected (deps.messages has user messages + possible assistant responses)
      const userMessages = deps.messages.filter((m) => m.role === "user");
      assert.equal(userMessages.length, 2, "T-WINBOX.1: 2 user messages pushed to deps.messages");
      assert.equal((userMessages[0] as { content: string }).content, "MSG1", "T-WINBOX.1: first message is MSG1");
      assert.equal((userMessages[1] as { content: string }).content, "MSG2", "T-WINBOX.1: second message is MSG2");
      assert.deepEqual(
        deps.messages.filter((message) => message.role === "assistant").map((message) => message.content),
        ["ACK1", "ACK2"],
      );
      assert.deepEqual(loadMessages(deps.sessionFile), [
        { role: "user", content: "MSG1" },
        { role: "assistant", content: "ACK1" },
        { role: "user", content: "MSG2" },
        { role: "assistant", content: "ACK2" },
      ]);
    } finally {
      cleanup();
    }
  });

  it("T-WINBOX.2: delete-before-inject invariant — a second drain on the same DB makes no additional Pi call or session append", async () => {
    // Given: one pending row and one controlled successful Pi script
    // When:  drainWorkerInbox called twice on same DB
    // Then: the first drain deletes/injects/persists once; the second changes neither calls, messages, nor session
    const { dir, cleanup } = makeTmpDir();
    try {
      const dbPath = join(dir, "inbox.sqlite");
      const db = openWorkerInboxDb(dbPath);
      enqueueWorkerInbox(db, "ONCE_ONLY", 1000);
      // First drain — row deleted before one controlled Pi injection.
      const deps1 = makeDeps(dir);
      piLoop.queue(async (opts) => appendAssistant(opts, "done"));
      await drainWorkerInbox(dbPath, undefined, deps1);
      piLoop.assertDrained(1);
      const userMsgs = deps1.messages.filter((m) => m.role === "user");
      assert.equal(userMsgs.length, 1, "T-WINBOX.2: first drain injects 1 user message");
      // P-28.5 D-6: row was deleted before the controlled Pi call.
      const c = (db.prepare("SELECT COUNT(*) AS c FROM worker_inbox WHERE content='ONCE_ONLY'").get() as { c: number })
        .c;
      assert.equal(c, 0, "T-WINBOX.2: row DELETEd after first drain (D-6)");
      // Second drain — DB is empty; the controlled Pi call count must not grow.
      const persistedAfterFirst = loadMessages(deps1.sessionFile);
      const messageCountAfterFirst = deps1.messages.length;
      await drainWorkerInbox(dbPath, undefined, deps1);
      piLoop.assertDrained(1);
      assert.equal(deps1.messages.length, messageCountAfterFirst, "second drain must not mutate messages");
      assert.deepEqual(
        loadMessages(deps1.sessionFile),
        persistedAfterFirst,
        "second drain must not append session rows",
      );
    } finally {
      cleanup();
    }
  });

  it("T-WINBOX.3: with empty worker_inbox, drainWorkerInbox is a no-op; runAgentLoop never called", async () => {
    // Given: empty worker_inbox.sqlite
    // When:  drainWorkerInbox called
    // Then:  returns immediately; deps.messages unchanged; no throw
    const { dir, cleanup } = makeTmpDir();
    try {
      const dbPath = join(dir, "inbox.sqlite");
      openWorkerInboxDb(dbPath); // initialize schema
      const deps = makeDeps(dir);
      await drainWorkerInbox(dbPath, undefined, deps);
      piLoop.assertDrained(0);
      assert.equal(deps.messages.length, 0, "T-WINBOX.3: no messages pushed for empty inbox");
      assert.deepEqual(loadMessages(deps.sessionFile), [], "T-WINBOX.3: empty inbox must not append session rows");
    } finally {
      cleanup();
    }
  });

  it("T-WINBOX.4: when abortSignal is already aborted, drainWorkerInbox deletes the batch but executes zero rows", async () => {
    // Given: 3 pending rows; abortController.signal already aborted
    // When:  drainWorkerInbox called with aborted signal
    // Then: the full batch is deleted before iteration; zero messages, Pi calls, and session rows
    const { dir, cleanup } = makeTmpDir();
    try {
      const dbPath = join(dir, "inbox.sqlite");
      const db = openWorkerInboxDb(dbPath);
      enqueueWorkerInbox(db, "R1", 1000);
      enqueueWorkerInbox(db, "R2", 2000);
      enqueueWorkerInbox(db, "R3", 3000);
      const ac = new AbortController();
      ac.abort(); // aborted BEFORE the call
      const deps = makeDeps(dir);
      // With aborted signal, loop body checks abortSignal?.aborted before runAgentLoop
      await drainWorkerInbox(dbPath, ac.signal, deps);
      piLoop.assertDrained(0);
      // P-28.5 D-6: all rows DELETEd upfront (delete-BEFORE-iterate is batch)
      const allRows = (db.prepare("SELECT COUNT(*) AS c FROM worker_inbox").get() as { c: number }).c;
      assert.equal(allRows, 0, "T-WINBOX.4: rows DELETEd (delete-before-iterate, D-6)");
      // No messages pushed because abort check fires before push
      assert.equal(deps.messages.length, 0, "T-WINBOX.4: no messages pushed when signal aborted");
      assert.deepEqual(loadMessages(deps.sessionFile), [], "T-WINBOX.4: pre-abort must not append session rows");
    } finally {
      cleanup();
    }
  });
});
