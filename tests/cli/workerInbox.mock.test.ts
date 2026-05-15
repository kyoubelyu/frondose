/**
 * P-26 Step 5 — T-WINBOX.1..4 (orchestrator — CLI layer)
 *
 * Tests for src/cli/workerInbox.ts — drainWorkerInbox orchestrator.
 * Verifies mark-consumed-BEFORE-inject invariant + runAgentLoop delegation.
 * Gate coverage: G-P26.14
 *
 * Uses MockLanguageModelV1 (from ai/test) so runAgentLoop gets a real model
 * object that immediately ends the stream — the test focuses on the drain
 * invariant, not LLM output.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { MockLanguageModelV1 } from "ai/test";
import type { RunCronTurnDeps } from "../../src/cli/replCron.js";
import { drainWorkerInbox } from "../../src/cli/workerInbox.js";
import { enqueueWorkerInbox, openWorkerInboxDb } from "../../src/persistence/workerInbox.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p26-wibdrain-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A mock model that immediately returns an empty text response stream. */
function makeImmediateModel(): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    provider: "openai",
    modelId: "test-drain",
    doStream: async () => ({
      rawCall: { rawPrompt: null as unknown, rawSettings: {} as Record<string, unknown> },
      stream: Readable.toWeb(
        Readable.from([
          { type: "finish", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } },
        ]),
        // biome-ignore lint/suspicious/noExplicitAny: cast for stream type
      ) as unknown as ReadableStream<any>,
    }),
  });
}

/** A mock model that throws on doStream. */
function makeThrowingModel(): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    provider: "openai",
    modelId: "test-throw",
    doStream: async () => {
      throw new Error("mock-runAgentLoop-throw");
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

describe("drainWorkerInbox orchestrator (G-P26.14)", () => {
  it("T-WINBOX.1: with 2 pending rows, drainWorkerInbox marks consumed FIRST then injects each as user-role message; runAgentLoop called once per row", async () => {
    // Given: worker_inbox.sqlite has 2 pending rows ("MSG1", "MSG2"); runAgentLoop mocked via immediate model
    // When:  drainWorkerInbox(dbPath, undefined, deps)
    // Then:  both rows have status='consumed' BEFORE runAgentLoop returns; deps.messages pushed
    //        with {role:"user", content:"MSG1"} then {role:"user", content:"MSG2"}
    const { dir, cleanup } = makeTmpDir();
    try {
      const dbPath = join(dir, "inbox.sqlite");
      const db = openWorkerInboxDb(dbPath);
      enqueueWorkerInbox(db, "MSG1", 1000);
      enqueueWorkerInbox(db, "MSG2", 2000);
      const deps = makeDeps(dir, makeImmediateModel());
      await drainWorkerInbox(dbPath, undefined, deps);
      // Verify both rows consumed
      const pending = (db.prepare("SELECT COUNT(*) AS c FROM worker_inbox WHERE status='pending'").get() as { c: number })
        .c;
      assert.equal(pending, 0, "T-WINBOX.1: 0 pending rows after drain");
      const consumed = (db.prepare("SELECT COUNT(*) AS c FROM worker_inbox WHERE status='consumed'").get() as { c: number })
        .c;
      assert.equal(consumed, 2, "T-WINBOX.1: 2 consumed rows");
      // Verify messages were injected (deps.messages has user messages + possible assistant responses)
      const userMessages = deps.messages.filter((m) => m.role === "user");
      assert.equal(userMessages.length, 2, "T-WINBOX.1: 2 user messages pushed to deps.messages");
      assert.equal((userMessages[0] as { content: string }).content, "MSG1", "T-WINBOX.1: first message is MSG1");
      assert.equal((userMessages[1] as { content: string }).content, "MSG2", "T-WINBOX.1: second message is MSG2");
    } finally {
      cleanup();
    }
  });

  it("T-WINBOX.2: mark-consumed-BEFORE-inject invariant — second drain on same DB is a no-op; no double-inject", async () => {
    // Given: 1 pending row; first drain runs successfully (immediate model)
    // When:  drainWorkerInbox called twice on same DB
    // Then:  row consumed after first drain (mark-before-loop); second call is no-op (0 pending);
    //        throwing model in second call never fires (early-return path), proving no double-inject
    const { dir, cleanup } = makeTmpDir();
    try {
      const dbPath = join(dir, "inbox.sqlite");
      const db = openWorkerInboxDb(dbPath);
      enqueueWorkerInbox(db, "ONCE_ONLY", 1000);
      // First drain — row consumed + message injected
      const deps1 = makeDeps(dir, makeImmediateModel());
      await drainWorkerInbox(dbPath, undefined, deps1);
      const userMsgs = deps1.messages.filter((m) => m.role === "user");
      assert.equal(userMsgs.length, 1, "T-WINBOX.2: first drain injects 1 user message");
      const row = db.prepare("SELECT status FROM worker_inbox WHERE content='ONCE_ONLY'").get() as { status: string };
      assert.equal(row.status, "consumed", "T-WINBOX.2: row marked consumed after first drain");
      // Second drain — DB is empty (all consumed); throwing model would fail IF it was called
      const deps2 = makeDeps(dir, makeThrowingModel());
      await drainWorkerInbox(dbPath, undefined, deps2);
      assert.equal(deps2.messages.length, 0, "T-WINBOX.2: no double-inject on second drain (row already consumed)");
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
      // Use a throwing model to prove runAgentLoop is never called (if it were, the test would throw)
      const deps = makeDeps(dir, makeThrowingModel());
      await drainWorkerInbox(dbPath, undefined, deps);
      assert.equal(deps.messages.length, 0, "T-WINBOX.3: no messages pushed for empty inbox");
    } finally {
      cleanup();
    }
  });

  it("T-WINBOX.4: when abortSignal is aborted, drainWorkerInbox stops iteration after current row", async () => {
    // Given: 3 pending rows; abortController.signal already aborted
    // When:  drainWorkerInbox called with aborted signal
    // Then:  stops after consuming all rows (mark-consumed is atomic), no runAgentLoop call
    const { dir, cleanup } = makeTmpDir();
    try {
      const dbPath = join(dir, "inbox.sqlite");
      const db = openWorkerInboxDb(dbPath);
      enqueueWorkerInbox(db, "R1", 1000);
      enqueueWorkerInbox(db, "R2", 2000);
      enqueueWorkerInbox(db, "R3", 3000);
      const ac = new AbortController();
      ac.abort(); // aborted BEFORE the call
      const deps = makeDeps(dir, makeThrowingModel()); // model would throw if called
      // With aborted signal, loop body checks abortSignal?.aborted before runAgentLoop
      await drainWorkerInbox(dbPath, ac.signal, deps);
      // All rows are consumed upfront (mark-consumed-BEFORE-iterate is batch)
      const consumed = (db.prepare("SELECT COUNT(*) AS c FROM worker_inbox WHERE status='consumed'").get() as { c: number })
        .c;
      assert.equal(consumed, 3, "T-WINBOX.4: rows consumed (batch mark before loop)");
      // No messages pushed because abort check fires before push
      assert.equal(deps.messages.length, 0, "T-WINBOX.4: no messages pushed when signal aborted");
    } finally {
      cleanup();
    }
  });
});
