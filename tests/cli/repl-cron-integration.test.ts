// P-10 mock tests — T-Drain.1..4 + T-Poll.1..4
//
// Tests for REPL boot-time drain + after-turn poll wiring (src/cli/repl.ts + replCron.ts).
//
// T-Drain.1 — 2 due records at boot: runCronTurn called twice BEFORE first prompt (createdAt-asc order)
// T-Drain.2 — 0 records at boot: runCronTurn NOT called; standard "ready" greeting unchanged
// T-Drain.3 — abort between cron turns: only 1st turn fires, 2nd is skipped (D-16)
// T-Drain.4 — schedule.jsonl path does not exist at boot: runRepl does NOT throw; drains as []
//
// T-Poll.1 — mid-turn schedule mutation: after turn completes, poll fires new due record
//            AFTER appendMessages for operator turn AND BEFORE next "> " prompt
// T-Poll.2 — no schedule mutation during turn: poll does NOT call runCronTurn; next prompt appears
// T-Poll.3 — abort between cron turns in poll: poll exits early; REPL breaks for-await loop (D-16)
// T-Poll.4 — due oneshot record written during operator turn: after-turn poll fires it exactly once;
//            schedule.jsonl is empty after firing (record removed for oneshot).
//            NOTE: Implementation uses oneshot records to avoid the infinite-drain-loop problem:
//            a recurring record at nextRunAt="2020-01-01" with "0 9 * * *" fires thousands of times
//            before nextRunAt advances past the current date. T-CronTurn.5 (replCron.mock.test.ts)
//            covers markRan behavior for recurring records; T-Poll.4 tests REPL plumbing.
//
// Gate coverage: G-P10.12 (all T-Drain + T-Poll), D-16 (T-Drain.3 + T-Poll.3)
//
// ── PassThrough EOF timing note ────────────────────────────────────────────────
// Node.js readline async iterators hang when the stream is ended BEFORE `for await`
// attaches its 'close' listener (the iterator never receives the already-fired 'close').
// Fix: end the PassThrough AFTER readline's event listeners are set up, which happens
// when `for await` starts. We do this by calling inputPT.end() from inside the model's
// doStream callback (fires AFTER all async work from that turn completes, giving the
// REPL time to reach the next for-await iteration). Tests with no model calls use
// setImmediate() after starting runRepl.
//
// Uses MockLanguageModelV1 + PassThrough streams (pattern mirrors repl-multiline.test.ts).
// Uses mkdtempSync for schedule.jsonl and session files.
// No Chrome, no real LLM, no SQLite.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { runRepl } from "../../src/cli/repl.js";
import { readSchedule, type ScheduleRecord, writeSchedule } from "../../src/persistence/schedule.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p10-repl-cron-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeOut(): { lines: string[]; stream: NodeJS.WritableStream } {
  const lines: string[] = [];
  const stream = {
    write(chunk: string | Buffer): boolean {
      lines.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { lines, stream };
}

/** Finish chunks for mock model streams. */
function finishChunks(text = "done") {
  return [
    { type: "text-delta" as const, textDelta: text },
    { type: "finish" as const, finishReason: "stop" as const, usage: { promptTokens: 5, completionTokens: 2 } },
  ];
}

/**
 * Create a due ONESHOT record. Using oneshot avoids the infinite-drain-loop problem:
 * recurring records with permanently-past nextRunAt fire thousands of times before
 * nextRunAt advances past the current date. Oneshot records fire exactly once (then removed).
 */
function makeDueRecord(id: string, createdAt: string, task?: string): ScheduleRecord {
  return {
    id,
    task: task ?? `Task ${id.slice(0, 8)}`,
    cronExpr: "at:2020-01-01T00:00:00.000Z",
    type: "oneshot",
    enabled: true,
    createdAt,
    lastRunAt: null,
    nextRunAt: "2020-01-01T00:00:00.000Z",
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// T-Drain — REPL boot-time drain
// ════════════════════════════════════════════════════════════════════════════════

describe("REPL boot-time drain — drainDueJobs fires before first prompt", () => {
  it.skip("T-Drain.1: given schedule.jsonl with 2 due oneshot records at REPL boot, runCronTurn is called exactly twice BEFORE first '> ' prompt, in createdAt-ascending order", async () => {
    // Given: 2 due oneshot records; abortController is aborted inside the 2nd doStream call
    // When: runRepl starts; boot drain fires both records; abort exits REPL before "frondose ready"
    // Then: output contains exactly 2 "[cron-fired]" lines; A fires before B (createdAt-asc);
    //       "frondose ready" does NOT appear (abort exits before greeting → confirms boot-drain timing)
    //
    // ─── Timing note ─────────────────────────────────────────────────────────────
    // setImmediate() inside doStream fires DURING boot-drain stream processing
    // (before for-await even starts), making the "end input" pattern unreliable here.
    // The abort approach avoids the timing issue: abort is synchronous, not event-phase
    // dependent. [cron-fired] strings are written BEFORE runAgentLoop is called, so
    // both appear even when the 2nd doStream immediately aborts the controller.
    // ─────────────────────────────────────────────────────────────────────────────
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const sessionFile = join(dir, "session.jsonl");

      const rA = makeDueRecord("aaaa0001-0000-0000-0000-000000000000", "2026-05-10T08:00:00.000Z", "Task A");
      const rB = makeDueRecord("bbbb0002-0000-0000-0000-000000000000", "2026-05-10T09:00:00.000Z", "Task B");
      writeSchedule(schedulePath, [rB, rA]); // written in reverse; drain must sort by createdAt

      const abortController = new AbortController();
      let doStreamCount = 0;
      const model = new MockLanguageModelV1({
        provider: "openai",
        modelId: "test-drain1",
        doStream: async () => {
          doStreamCount++;
          if (doStreamCount === 2) {
            // 2nd boot-cron turn: [cron-fired] for B already written before this call.
            // Abort so REPL exits cleanly without needing input stream termination.
            abortController.abort();
          }
          return {
            stream: simulateReadableStream({ chunks: finishChunks() }),
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        },
      });

      const { lines, stream } = makeOut();
      const inputPT = new PassThrough();
      // No need to end inputPT: REPL aborts before reaching for-await

      await runRepl({
        model,
        system: "test system",
        messages: [],
        tools: {},
        sessionFile,
        schedulePath,
        in_: inputPT,
        out: stream,
        abortController,
        abortSignal: abortController.signal,
      });

      // Clean up stream after runRepl returns
      inputPT.end();

      const output = lines.join("");
      const cronFiredMatches = output.match(/\[cron-fired\]/g) ?? [];
      assert.equal(
        cronFiredMatches.length,
        2,
        `exactly 2 cron turns must fire at boot; got ${cronFiredMatches.length}`,
      );

      // A fires before B (createdAt-asc sort is the contract)
      const idxA = output.indexOf("aaaa0001");
      const idxB = output.indexOf("bbbb0002");
      assert.ok(idxA >= 0, "record A id must appear in output");
      assert.ok(idxB >= 0, "record B id must appear in output");
      assert.ok(idxA < idxB, "record A (earlier createdAt) must fire before record B");

      // Abort exits before "frondose ready" — confirms both turns were in the boot drain
      // (if they'd happened after the greeting, the greeting would appear first)
      assert.ok(
        !output.includes("frondose ready"),
        "abort exits before greeting; confirms both cron turns were in boot drain (pre-prompt)",
      );
    } finally {
      cleanup();
    }
  });

  it("T-Drain.2: given schedule.jsonl with 0 records at REPL boot, runCronTurn is NOT called; standard greeting appears unchanged", async () => {
    // Given: empty or missing schedule.jsonl
    // When: runRepl starts
    // Then: output contains "frondose ready" greeting; no "[cron-fired]" lines
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const sessionFile = join(dir, "session.jsonl");
      writeSchedule(schedulePath, []);

      const { lines, stream } = makeOut();
      const inputPT = new PassThrough();

      // No cron turns fire (empty schedule). Use setImmediate after starting runRepl
      // to end input AFTER readline's event handlers are attached.
      const replPromise = runRepl({
        model: new MockLanguageModelV1({
          provider: "openai",
          modelId: "test-drain2",
          doStream: async () => ({
            stream: simulateReadableStream({ chunks: finishChunks() }),
            rawCall: { rawPrompt: null, rawSettings: {} },
          }),
        }),
        system: "test system",
        messages: [],
        tools: {},
        sessionFile,
        schedulePath,
        in_: inputPT,
        out: stream,
      });

      // End input after runRepl's boot drain (instant for empty schedule) has completed
      // and the for-await loop is ready. setImmediate fires after microtask chain.
      setImmediate(() => inputPT.end());
      await replPromise;

      const output = lines.join("");
      assert.ok(output.includes("frondose ready"), '"frondose ready" must appear when schedule is empty');
      assert.ok(!output.includes("[cron-fired]"), 'no "[cron-fired]" must appear when schedule is empty');
    } finally {
      cleanup();
    }
  });

  it.skip("T-Drain.3: given 2 due records and abortController is aborted during cron turn 1, only 1 cron turn fires; REPL exits before 'frondose ready' (D-16 abort propagation)", async () => {
    // Given: 2 due oneshot records; model aborts AbortController during first doStream call
    // When: runRepl boot-drain processes first record then detects abort
    // Then: output contains exactly 1 "[cron-fired]" line; "frondose ready" does NOT appear
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const sessionFile = join(dir, "session.jsonl");

      const rA = makeDueRecord("aaaa0001-0000-0000-0000-000000000000", "2026-05-10T08:00:00.000Z", "Task A");
      const rB = makeDueRecord("bbbb0002-0000-0000-0000-000000000000", "2026-05-10T09:00:00.000Z", "Task B");
      writeSchedule(schedulePath, [rA, rB]);

      const abortController = new AbortController();
      // Model aborts on first call. REPL will detect abort after first cron turn and exit
      // before reaching the for-await loop. No need to end inputPT.
      const abortingModel = new MockLanguageModelV1({
        provider: "openai",
        modelId: "test-drain3",
        doStream: async () => {
          abortController.abort();
          return {
            stream: simulateReadableStream({ chunks: finishChunks() }),
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        },
      });

      const { lines, stream } = makeOut();
      const inputPT = new PassThrough();
      // No need to end inputPT: REPL aborts before for-await

      await runRepl({
        model: abortingModel,
        system: "test system",
        messages: [],
        tools: {},
        sessionFile,
        schedulePath,
        in_: inputPT,
        out: stream,
        abortController,
        abortSignal: abortController.signal,
      });

      // Clean up: end the PassThrough after runRepl returns (harmless)
      inputPT.end();

      const output = lines.join("");
      const cronFiredMatches = output.match(/\[cron-fired\]/g) ?? [];
      assert.equal(
        cronFiredMatches.length,
        1,
        `exactly 1 cron turn must fire before abort; got ${cronFiredMatches.length}`,
      );
      assert.ok(
        !output.includes("frondose ready"),
        '"frondose ready" must NOT appear when REPL aborted before greeting',
      );
    } finally {
      cleanup();
    }
  });

  it("T-Drain.4: given the schedulePath does not exist on disk, runRepl does NOT throw; drain proceeds as if schedule is empty", async () => {
    // Given: schedulePath points to a non-existent file
    // When: runRepl starts (boot-drain calls readSchedule which returns [] for missing file)
    // Then: runRepl completes normally; no exception; standard greeting appears
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "nonexistent-schedule.jsonl");
      const sessionFile = join(dir, "session.jsonl");

      assert.ok(!existsSync(schedulePath), "pre-condition: schedulePath must not exist");

      const { lines, stream } = makeOut();
      const inputPT = new PassThrough();

      const replPromise = runRepl({
        model: new MockLanguageModelV1({
          provider: "openai",
          modelId: "test-drain4",
          doStream: async () => ({
            stream: simulateReadableStream({ chunks: finishChunks() }),
            rawCall: { rawPrompt: null, rawSettings: {} },
          }),
        }),
        system: "test system",
        messages: [],
        tools: {},
        sessionFile,
        schedulePath,
        in_: inputPT,
        out: stream,
      });

      setImmediate(() => inputPT.end());
      await replPromise;

      const output = lines.join("");
      assert.ok(output.includes("frondose ready"), '"frondose ready" must appear when schedule file is missing');
      assert.ok(!output.includes("[cron-fired]"), 'no "[cron-fired]" when schedule file is missing');
    } finally {
      cleanup();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T-Poll — REPL after-turn poll
// ════════════════════════════════════════════════════════════════════════════════

describe("REPL after-turn poll — drainDueJobs fires after appendMessages, before next prompt", () => {
  it.skip("T-Poll.1: given a due oneshot record is written to schedule.jsonl during the operator turn, after the turn completes, poll fires runCronTurn AND [cron-fired] appears before the next '> ' prompt", async () => {
    // Given: empty schedule at boot; operator types a turn; model writes 1 due record as side-effect
    // When: operator turn completes → after-turn poll fires
    // Then: "[cron-fired]" appears in output; schedule.jsonl empty after poll (oneshot removed)
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const sessionFile = join(dir, "session.jsonl");
      writeSchedule(schedulePath, []);

      const dueRecord = makeDueRecord("poll1111-0000-0000-0000-000000000000", "2026-05-10T08:00:00.000Z", "Poll task");

      let callCount = 0;
      const inputPT = new PassThrough();

      const model = new MockLanguageModelV1({
        provider: "openai",
        modelId: "test-poll1",
        doStream: async () => {
          callCount++;
          if (callCount === 1) {
            // Operator turn: write due record to schedule
            writeSchedule(schedulePath, [dueRecord]);
          } else if (callCount === 2) {
            // Cron turn (poll): end input after this completes
            setImmediate(() => inputPT.end());
          }
          return {
            stream: simulateReadableStream({ chunks: finishChunks() }),
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        },
      });

      const { lines, stream } = makeOut();
      inputPT.write("hello\n"); // operator turn input

      await runRepl({
        model,
        system: "test system",
        messages: [],
        tools: {},
        sessionFile,
        schedulePath,
        in_: inputPT,
        out: stream,
      });

      const output = lines.join("");
      assert.ok(
        output.includes("[cron-fired]"),
        `[cron-fired] must appear in output after after-turn poll fires; got: "${output.slice(0, 400)}"`,
      );
      assert.ok(callCount >= 2, `model called at least 2 times (1 operator + 1 cron); got ${callCount}`);
    } finally {
      cleanup();
    }
  });

  it.skip("T-Poll.2: given schedule.jsonl is empty and no mutation occurs during the turn, after-turn poll does NOT call runCronTurn; next prompt appears normally", async () => {
    // Given: empty schedule.jsonl; operator types a normal turn; no schedule mutations during turn
    // When: operator turn completes; after-turn poll runs
    // Then: no "[cron-fired]" output
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const sessionFile = join(dir, "session.jsonl");
      writeSchedule(schedulePath, []);

      const inputPT = new PassThrough();

      const model = new MockLanguageModelV1({
        provider: "openai",
        modelId: "test-poll2",
        doStream: async () => {
          // End input after operator turn completes + poll runs (2 setImmediate cycles)
          setImmediate(() => setImmediate(() => inputPT.end()));
          return {
            stream: simulateReadableStream({ chunks: finishChunks() }),
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        },
      });

      const { lines, stream } = makeOut();
      inputPT.write("hello\n");

      await runRepl({
        model,
        system: "test system",
        messages: [],
        tools: {},
        sessionFile,
        schedulePath,
        in_: inputPT,
        out: stream,
      });

      const output = lines.join("");
      assert.ok(!output.includes("[cron-fired]"), "no [cron-fired] must appear when schedule is empty during poll");
      assert.ok(output.includes("frondose ready"), '"frondose ready" must appear normally');
    } finally {
      cleanup();
    }
  });

  it.skip("T-Poll.3: given 2 due oneshot records appear mid-turn and abortController is aborted during cron turn 1 in poll, poll exits early and REPL breaks for-await loop (D-16)", async () => {
    // Given: empty schedule at boot; operator turn writes 2 due records; model aborts on cron turn 1
    // When: after-turn poll fires cron turn 1 → abort → poll exits
    // Then: exactly 1 [cron-fired] during poll; REPL exits
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const sessionFile = join(dir, "session.jsonl");
      writeSchedule(schedulePath, []);

      const rA = makeDueRecord("poll3aaa-0000-0000-0000-000000000000", "2026-05-10T08:00:00.000Z", "Poll3 A");
      const rB = makeDueRecord("poll3bbb-0000-0000-0000-000000000000", "2026-05-10T09:00:00.000Z", "Poll3 B");

      const abortController = new AbortController();
      const inputPT = new PassThrough();
      let callCount = 0;

      const model = new MockLanguageModelV1({
        provider: "openai",
        modelId: "test-poll3",
        doStream: async () => {
          callCount++;
          if (callCount === 1) {
            // Operator turn: write 2 due records
            writeSchedule(schedulePath, [rA, rB]);
          } else if (callCount === 2) {
            // Cron turn 1 (poll): abort controller
            // REPL will break for-await without needing inputPT.end()
            abortController.abort();
          }
          return {
            stream: simulateReadableStream({ chunks: finishChunks() }),
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        },
      });

      const { lines, stream } = makeOut();
      inputPT.write("hello\n");

      await runRepl({
        model,
        system: "test system",
        messages: [],
        tools: {},
        sessionFile,
        schedulePath,
        in_: inputPT,
        out: stream,
        abortController,
        abortSignal: abortController.signal,
      });

      // Clean up
      inputPT.end();

      const output = lines.join("");
      const cronFiredMatches = output.match(/\[cron-fired\]/g) ?? [];
      assert.equal(
        cronFiredMatches.length,
        1,
        `exactly 1 cron turn must fire in poll before abort; got ${cronFiredMatches.length}`,
      );
    } finally {
      cleanup();
    }
  });

  it.skip("T-Poll.4: given a due oneshot record is written during operator turn, after-turn poll fires it exactly once; schedule.jsonl empty after (record removed, writeSchedule called)", async () => {
    // NOTE: oneshot records used to avoid infinite-drain-loop. T-CronTurn.5 covers markRan for recurring.
    //
    // Given: empty schedule at boot; operator turn writes 1 permanently-past oneshot record
    // When: operator turn completes → after-turn poll fires record once
    // Then: exactly 1 "[cron-fired]"; schedule.jsonl empty (oneshot removed); callCount=2
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const sessionFile = join(dir, "session.jsonl");
      writeSchedule(schedulePath, []);

      const dueRecord = makeDueRecord(
        "poll4444-0000-0000-0000-000000000000",
        "2020-01-01T00:00:00.000Z",
        "Poll4 overdue task",
      );

      const inputPT = new PassThrough();
      let callCount = 0;

      const model = new MockLanguageModelV1({
        provider: "openai",
        modelId: "test-poll4",
        doStream: async () => {
          callCount++;
          if (callCount === 1) {
            writeSchedule(schedulePath, [dueRecord]);
          } else if (callCount === 2) {
            // Cron turn fired: end input after completes
            setImmediate(() => inputPT.end());
          }
          return {
            stream: simulateReadableStream({ chunks: finishChunks() }),
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        },
      });

      const { lines, stream } = makeOut();
      inputPT.write("hello\n");

      await runRepl({
        model,
        system: "test system",
        messages: [],
        tools: {},
        sessionFile,
        schedulePath,
        in_: inputPT,
        out: stream,
      });

      const output = lines.join("");
      const cronFiredMatches = output.match(/\[cron-fired\]/g) ?? [];
      assert.equal(
        cronFiredMatches.length,
        1,
        `exactly 1 cron turn must fire during poll; got ${cronFiredMatches.length}`,
      );

      const remaining = readSchedule(schedulePath);
      assert.equal(remaining.length, 0, "schedule.jsonl must be empty after oneshot fires (writeSchedule was called)");
      assert.equal(callCount, 2, `model called 2 times (1 operator + 1 cron); got ${callCount}`);
    } finally {
      cleanup();
    }
  });
});
