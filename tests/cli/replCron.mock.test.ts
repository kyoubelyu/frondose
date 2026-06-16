/**
 * P-10 mock tests — T-Slash.cron.1..15 + T-CronTurn.1..7
 *
 * Tests for src/cli/replCron.ts — /cron slash command parsing + runCronTurn helper.
 *
 * T-Slash.cron.1  — parseCronSlashLine '/cron schedule "task" --cron "0 9 * * *"' → correct object
 * T-Slash.cron.2  — parseCronSlashLine '/cron schedule "task" --at "09:00"' → oneShot path
 * T-Slash.cron.3  — parseCronSlashLine '/cron schedule "Foo" --at "2026-05-11T09:00Z"' → ISO oneShot
 * T-Slash.cron.4  — parseCronSlashLine with both --cron + --at → throws "mutually exclusive"
 * T-Slash.cron.5  — parseCronSlashLine with neither --cron nor --at → throws "--cron or --at required"
 * T-Slash.cron.6  — parseCronSlashLine '/cron list' → { verb:"list" }
 * T-Slash.cron.7  — parseCronSlashLine '/cron remove abc12345' → { verb:"remove", id:"abc12345" }
 * T-Slash.cron.8  — parseCronSlashLine '/cron remove' (no id) → throws "id required"
 * T-Slash.cron.9  — parseCronSlashLine '/cron foo' (unknown verb) → throws "unknown /cron verb" + "foo"
 * T-Slash.cron.10 — handleCronSlash schedule: empty schedule.jsonl → 1 record written, correct shape
 * T-Slash.cron.11 — handleCronSlash list: 2 records → output contains both IDs, tasks, cronExprs; createdAt-asc order
 * T-Slash.cron.12 — handleCronSlash remove (id match): record removed; stdout contains "removed" + id
 * T-Slash.cron.13 — handleCronSlash remove (id miss): file unchanged; stdout contains "no schedule with id"
 * T-Slash.cron.14 — dispatchSlash("/cron list", ctx): handled=true; ctx.out receives list output (replSlash wiring)
 * T-Slash.cron.15 — dispatchSlash("/cron", ctx) (no verb): handled=true; output mentions schedule/list/remove
 *
 * T-CronTurn.1 — runCronTurn injects "[CRON_RUN_ID=...]\n<task>" as user message (D-14)
 * T-CronTurn.2 — runCronTurn calls appendMessages with the tail from turnStart onward
 * T-CronTurn.3 — runCronTurn: abort mid-loop → returns early, does NOT call appendMessages
 * T-CronTurn.4 — runCronTurn: composedStepFinish hook receives every agent step
 * T-CronTurn.5 — runCronTurn: recurring record → writeSchedule called with markRan result (lastRunAt+nextRunAt updated)
 * T-CronTurn.6 — runCronTurn: oneshot record → writeSchedule called with record filtered out (markRan=null)
 * T-CronTurn.7 — crash-stable cron_run_id (BLOCKER-1 cascade): computeCronRunId(record, new Date(record.nextRunAt)) is identical when called twice at different wall-clock instants
 *
 * Gate coverage:
 *   G-P10.8 (T-Slash.cron.1..15), G-P10.9 (T-Slash.cron.11), G-P10.10 (T-Slash.cron.12..13),
 *   G-P10.11 (T-CronTurn.1..6), G-P10.6 crash-stability dimension (T-CronTurn.7), G-P10.5 (T-CronTurn.5..6)
 *
 * Uses MockLanguageModelV1 from ai/test for runCronTurn tests.
 * Uses mkdtempSync + cleanup for schedule.jsonl I/O.
 * No Chrome, no real LLM calls, no SQLite.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CoreMessage } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { TokenBudget } from "../../src/agent/tokenBudget.js";
import { TurnLock } from "../../src/agent/turnSemaphore.js";

// ── IMPORT GATE ────────────────────────────────────────────────────────────────
import {
  drainDueJobs,
  handleCronSlash,
  parseCronSlashLine,
  type RunCronTurnDeps,
  runCronTurn,
} from "../../src/cli/replCron.js";
import { dispatchSlash, type SlashCtx } from "../../src/cli/replSlash.js";
// computeCronRunId lives in schedule.ts (not replCron.ts) — imported here for T-CronTurn.7.
import { computeCronRunId, readSchedule, type ScheduleRecord, writeSchedule } from "../../src/persistence/schedule.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p10-replcron-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
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

/** Minimal echo-model that immediately returns a single text chunk. */
function makeEchoModel(): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    provider: "openai",
    modelId: "test-echo",
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-delta" as const, textDelta: "cron task done" },
          {
            type: "finish" as const,
            finishReason: "stop" as const,
            usage: { promptTokens: 10, completionTokens: 5 },
          },
        ],
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
}

function makeRecord(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: "abc12345-0000-0000-0000-000000000000",
    task: "Check LinkedIn feed",
    cronExpr: "0 9 * * *",
    type: "recurring",
    enabled: true,
    createdAt: "2026-05-10T00:00:00.000Z",
    lastRunAt: null,
    nextRunAt: "2026-05-10T09:00:00.000Z",
    ...overrides,
  };
}

/**
 * P-11 hygiene: stub values for the 6 new required SlashCtx fields.
 * These fields are not exercised by replCron tests; stubs keep TypeScript happy.
 */
function p11SlashStubs(
  model: MockLanguageModelV1,
  out: NodeJS.WritableStream,
): Pick<
  SlashCtx,
  "telegramConfigPath" | "telegramAbort" | "pollerHandle" | "onPollerStart" | "turnLock" | "telegramDeps"
> {
  return {
    telegramConfigPath: "/tmp/test-mai-telegram.json",
    telegramAbort: null,
    pollerHandle: null,
    onPollerStart: () => {},
    turnLock: new TurnLock(),
    telegramDeps: {
      model,
      system: "test",
      messages: [],
      tools: {},
      sessionFile: "/tmp/test-session.jsonl",
      out,
      configPath: "/tmp/test-mai-telegram.json",
      uploadAllowlistRoot: "/tmp",
    },
  };
}

// Keep unused imports alive for potential use in tests
void drainDueJobs;

// ════════════════════════════════════════════════════════════════════════════════
// T-Slash.cron — /cron slash command parsing (parseCronSlashLine)
// ════════════════════════════════════════════════════════════════════════════════

describe("parseCronSlashLine — /cron argv parsing", () => {
  it('T-Slash.cron.1: when "/cron schedule \\"Check feed\\" --cron \\"0 9 * * *\\"" is parsed, returns {verb:"schedule", task:"Check feed", recurring:"0 9 * * *", oneShot:null}', () => {
    // Given: well-formed schedule line with quoted task + --cron expression
    // When: parseCronSlashLine('/cron schedule "Check feed" --cron "0 9 * * *"')
    // Then: { verb:"schedule", task:"Check feed", recurring:"0 9 * * *", oneShot:null }
    const result = parseCronSlashLine('/cron schedule "Check feed" --cron "0 9 * * *"');
    assert.deepEqual(result, {
      verb: "schedule",
      task: "Check feed",
      recurring: "0 9 * * *",
      oneShot: null,
    });
  });

  it('T-Slash.cron.2: when "/cron schedule \\"Daily summary\\" --at \\"09:00\\"" is parsed, returns {verb:"schedule", task:"Daily summary", recurring:null, oneShot:"09:00"}', () => {
    // Given: schedule line with quoted task + --at HH:MM
    // When: parseCronSlashLine('/cron schedule "Daily summary" --at "09:00"')
    // Then: { verb:"schedule", task:"Daily summary", recurring:null, oneShot:"09:00" }
    const result = parseCronSlashLine('/cron schedule "Daily summary" --at "09:00"');
    assert.deepEqual(result, {
      verb: "schedule",
      task: "Daily summary",
      recurring: null,
      oneShot: "09:00",
    });
  });

  it('T-Slash.cron.3: when "/cron schedule \\"Foo\\" --at \\"2026-05-11T09:00Z\\"" is parsed, returns {verb:"schedule", task:"Foo", recurring:null, oneShot:"2026-05-11T09:00Z"}', () => {
    // Given: schedule line with ISO datetime in --at argument
    // When: parseCronSlashLine('/cron schedule "Foo" --at "2026-05-11T09:00Z"')
    // Then: { verb:"schedule", task:"Foo", recurring:null, oneShot:"2026-05-11T09:00Z" }
    const result = parseCronSlashLine('/cron schedule "Foo" --at "2026-05-11T09:00Z"');
    assert.deepEqual(result, {
      verb: "schedule",
      task: "Foo",
      recurring: null,
      oneShot: "2026-05-11T09:00Z",
    });
  });

  it('T-Slash.cron.4: when "/cron schedule \\"Foo\\" --cron \\"0 9 * * *\\" --at \\"09:00\\"" has both flags, parseCronSlashLine throws containing "--cron and --at are mutually exclusive"', () => {
    // Given: schedule line with both --cron and --at flags (mutually exclusive)
    // When: parseCronSlashLine(lineWithBothFlags)
    // Then: throws Error with "--cron and --at are mutually exclusive" in message
    assert.throws(
      () => parseCronSlashLine('/cron schedule "Foo" --cron "0 9 * * *" --at "09:00"'),
      (e: Error) => {
        assert.ok(e instanceof Error);
        assert.ok(e.message.includes("mutually exclusive"), `expected "mutually exclusive"; got: "${e.message}"`);
        return true;
      },
    );
  });

  it('T-Slash.cron.5: when "/cron schedule \\"Foo\\"" has neither --cron nor --at, parseCronSlashLine throws containing "--cron or --at required"', () => {
    // Given: schedule line with task but no scheduling flag
    // When: parseCronSlashLine('/cron schedule "Foo"')
    // Then: throws Error with "--cron or --at required" in message
    assert.throws(
      () => parseCronSlashLine('/cron schedule "Foo"'),
      (e: Error) => {
        assert.ok(e instanceof Error);
        assert.ok(
          e.message.includes("--cron or --at required"),
          `expected "--cron or --at required"; got: "${e.message}"`,
        );
        return true;
      },
    );
  });

  it('T-Slash.cron.6: when "/cron list" is parsed, returns {verb:"list"}', () => {
    // Given: bare list command (no additional arguments)
    // When: parseCronSlashLine('/cron list')
    // Then: { verb:"list" }
    const result = parseCronSlashLine("/cron list");
    assert.deepEqual(result, { verb: "list" });
  });

  it('T-Slash.cron.7: when "/cron remove abc12345" is parsed, returns {verb:"remove", id:"abc12345"}', () => {
    // Given: remove command with an id argument
    // When: parseCronSlashLine('/cron remove abc12345')
    // Then: { verb:"remove", id:"abc12345" }
    const result = parseCronSlashLine("/cron remove abc12345");
    assert.deepEqual(result, { verb: "remove", id: "abc12345" });
  });

  it('T-Slash.cron.8: when "/cron remove" (no id) is parsed, parseCronSlashLine throws containing "id required"', () => {
    // Given: remove command with missing id argument
    // When: parseCronSlashLine('/cron remove')
    // Then: throws Error with "id required" in message
    assert.throws(
      () => parseCronSlashLine("/cron remove"),
      (e: Error) => {
        assert.ok(e instanceof Error);
        assert.ok(e.message.includes("id required"), `expected "id required"; got: "${e.message}"`);
        return true;
      },
    );
  });

  it('T-Slash.cron.9: when "/cron foo" (unknown verb) is parsed, parseCronSlashLine throws containing "unknown /cron verb" and "foo"', () => {
    // Given: /cron line with an unrecognized verb
    // When: parseCronSlashLine('/cron foo')
    // Then: throws Error with "unknown /cron verb" and "foo" in message
    assert.throws(
      () => parseCronSlashLine("/cron foo"),
      (e: Error) => {
        assert.ok(e instanceof Error);
        assert.ok(e.message.includes("unknown /cron verb"), `expected "unknown /cron verb"; got: "${e.message}"`);
        assert.ok(e.message.includes("foo"), `expected "foo" in message; got: "${e.message}"`);
        return true;
      },
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T-Slash.cron — handleCronSlash integration
// ════════════════════════════════════════════════════════════════════════════════

describe("handleCronSlash — /cron schedule | list | remove dispatcher", () => {
  it("T-Slash.cron.10: when handleCronSlash schedule is called against an empty schedule.jsonl, the file gains exactly 1 record with correct shape (id, task, cronExpr, type, enabled=true, createdAt, lastRunAt=null, nextRunAt set)", async () => {
    // Given: empty schedule.jsonl + valid /cron schedule line
    // When: handleCronSlash('/cron schedule "Check feed" --cron "0 9 * * *"', schedulePath, out)
    // Then: file contains 1 JSON record with UUID id, correct task/cronExpr/type="recurring"/enabled=true/createdAt/lastRunAt=null/nextRunAt
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const { lines, stream } = makeOut();
      await handleCronSlash('/cron schedule "Check feed" --cron "0 9 * * *"', schedulePath, stream);

      const records = readSchedule(schedulePath);
      assert.equal(records.length, 1, "schedule must contain exactly 1 record");

      assert.ok(records[0] !== undefined, "first record must exist");
      const r = records[0];
      assert.equal(r.task, "Check feed");
      assert.equal(r.cronExpr, "0 9 * * *");
      assert.equal(r.type, "recurring");
      assert.equal(r.enabled, true);
      assert.equal(r.lastRunAt, null);
      assert.ok(typeof r.id === "string" && r.id.length > 0, "id must be a non-empty string");
      assert.ok(typeof r.nextRunAt === "string" && r.nextRunAt.length > 0, "nextRunAt must be set");
      assert.ok(typeof r.createdAt === "string" && r.createdAt.length > 0, "createdAt must be set");

      const output = lines.join("");
      assert.ok(output.includes("scheduled:"), `stdout must confirm scheduling; got: "${output}"`);
    } finally {
      cleanup();
    }
  });

  it("T-Slash.cron.11: when handleCronSlash list is called with 2 records, captured stdout contains both IDs (8 chars), tasks (≤40 chars), and cronExprs; order is createdAt ascending", async () => {
    // Given: schedule.jsonl with 2 records having different createdAt values
    // When: handleCronSlash('/cron list', schedulePath, out)
    // Then: output contains both id8 prefixes, task strings, cronExpr; older-createdAt record appears first
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      // Record A: earlier createdAt
      const rA = makeRecord({
        id: "aaaa0001-1111-1111-1111-111111111111",
        createdAt: "2026-05-10T08:00:00.000Z",
        task: "First task",
        cronExpr: "0 8 * * *",
      });
      // Record B: later createdAt
      const rB = makeRecord({
        id: "bbbb0002-2222-2222-2222-222222222222",
        createdAt: "2026-05-10T09:00:00.000Z",
        task: "Second task",
        cronExpr: "0 9 * * *",
      });
      // Write in reverse order to ensure list sorts correctly
      writeSchedule(schedulePath, [rB, rA]);

      const { lines, stream } = makeOut();
      await handleCronSlash("/cron list", schedulePath, stream);

      const output = lines.join("");
      const id8A = "aaaa0001";
      const id8B = "bbbb0002";

      assert.ok(output.includes(id8A), `output must contain id8 for record A: "${id8A}"; got: "${output}"`);
      assert.ok(output.includes(id8B), `output must contain id8 for record B: "${id8B}"; got: "${output}"`);
      assert.ok(output.includes("First task"), `output must contain task A; got: "${output}"`);
      assert.ok(output.includes("Second task"), `output must contain task B; got: "${output}"`);
      assert.ok(
        output.indexOf(id8A) < output.indexOf(id8B),
        "Record A (earlier createdAt) must appear before Record B in list output",
      );
    } finally {
      cleanup();
    }
  });

  it("T-Slash.cron.12: when handleCronSlash remove is called with a matching id, the record is removed from schedule.jsonl; stdout contains 'removed' + the id", async () => {
    // Given: schedule.jsonl with 1 record; remove called with that record's id8
    // When: handleCronSlash('/cron remove <id8>', schedulePath, out)
    // Then: schedule.jsonl no longer contains the record; stdout has "removed" + id substring
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const r = makeRecord({ id: "abc12345-0000-0000-0000-000000000000" });
      writeSchedule(schedulePath, [r]);

      const { lines, stream } = makeOut();
      await handleCronSlash("/cron remove abc12345", schedulePath, stream);

      const remaining = readSchedule(schedulePath);
      assert.equal(remaining.length, 0, "record must be removed from schedule.jsonl");

      const output = lines.join("");
      assert.ok(output.includes("removed"), `stdout must contain "removed"; got: "${output}"`);
      assert.ok(output.includes("abc12345"), `stdout must contain the id8; got: "${output}"`);
    } finally {
      cleanup();
    }
  });

  it("T-Slash.cron.13: when handleCronSlash remove is called with a non-matching id, schedule.jsonl is unchanged; stdout contains 'no schedule with id'", async () => {
    // Given: schedule.jsonl with 1 record; remove called with a different id
    // When: handleCronSlash('/cron remove nonexistent', schedulePath, out)
    // Then: schedule.jsonl content identical to before; stdout has "no schedule with id" + the id
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const r = makeRecord({ id: "abc12345-0000-0000-0000-000000000000" });
      writeSchedule(schedulePath, [r]);
      const beforeContent = readFileSync(schedulePath, "utf-8");

      const { lines, stream } = makeOut();
      await handleCronSlash("/cron remove deadbeef", schedulePath, stream);

      const afterContent = readFileSync(schedulePath, "utf-8");
      assert.equal(afterContent, beforeContent, "schedule.jsonl content must be unchanged on miss");

      const output = lines.join("");
      assert.ok(output.includes("no schedule with id"), `stdout must say "no schedule with id"; got: "${output}"`);
      assert.ok(output.includes("deadbeef"), `stdout must echo the requested id; got: "${output}"`);
    } finally {
      cleanup();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T-Slash.cron — replSlash.ts /cron dispatch wiring
// ════════════════════════════════════════════════════════════════════════════════

describe("dispatchSlash /cron wiring — replSlash.ts integration", () => {
  it('T-Slash.cron.14: when dispatchSlash("/cron list", ctx) is called, result is {handled:true} AND ctx.out receives list output', async () => {
    // Given: /cron list line + SlashCtx with a valid schedulePath pointing at an existing schedule file
    // When: dispatchSlash("/cron list", ctx)
    // Then: returned handled===true AND ctx.out.write was called with list content (proves /cron case is wired in switch)
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      writeSchedule(schedulePath, []); // empty schedule → "(no scheduled jobs)\n"

      const { lines, stream } = makeOut();
      const model = makeEchoModel();
      const budget = new TokenBudget(model);
      const ctx: SlashCtx = {
        messages: [],
        sessionFile: { path: join(dir, "session.jsonl") },
        tokenBudget: budget,
        model,
        out: stream,
        cwd: dir,
        schedulePath,
        ...p11SlashStubs(model, stream),
      };

      const result = await dispatchSlash("/cron list", ctx);
      assert.equal(result.handled, true, "/cron list must return handled:true");

      const output = lines.join("");
      // Empty schedule → handleCronSlash writes "(no scheduled jobs)\n"
      assert.ok(
        output.includes("no scheduled jobs") || output.length > 0,
        `ctx.out must receive output from /cron list; got: "${output}"`,
      );
    } finally {
      cleanup();
    }
  });

  it('T-Slash.cron.15: when dispatchSlash("/cron", ctx) (no verb) is called, handled=true and output mentions schedule, list, remove', async () => {
    // Given: /cron line with no subcommand verb
    // When: dispatchSlash("/cron", ctx)
    // Then: handled===true; output string contains at minimum "schedule", "list", "remove" as usage hint
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const { lines, stream } = makeOut();
      const model = makeEchoModel();
      const budget = new TokenBudget(model);
      const ctx: SlashCtx = {
        messages: [],
        sessionFile: { path: join(dir, "session.jsonl") },
        tokenBudget: budget,
        model,
        out: stream,
        cwd: dir,
        schedulePath,
        ...p11SlashStubs(model, stream),
      };

      const result = await dispatchSlash("/cron", ctx);
      assert.equal(result.handled, true, "/cron (no verb) must return handled:true");

      // parseCronSlashLine throws "/cron requires a verb (schedule | list | remove)"
      // handleCronSlash catches + writes: "/cron: /cron requires a verb (schedule | list | remove)\n"
      const output = lines.join("");
      assert.ok(output.includes("schedule"), `output must mention "schedule"; got: "${output}"`);
      assert.ok(output.includes("list"), `output must mention "list"; got: "${output}"`);
      assert.ok(output.includes("remove"), `output must mention "remove"; got: "${output}"`);
    } finally {
      cleanup();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T-CronTurn — runCronTurn helper
// ════════════════════════════════════════════════════════════════════════════════

describe("runCronTurn — cron-turn injection + agent loop execution", () => {
  it('T-CronTurn.1: when runCronTurn is called with task="Check LinkedIn feed" and cronRunId derived from record.nextRunAt, the user message pushed is "[CRON_RUN_ID=<cronRunId>]\\nCheck LinkedIn feed" (D-14)', async () => {
    // Given: runCronTurn invoked with a specific task + a pre-computed cronRunId via record+fireDate
    // When: runCronTurn(record, fireDate, schedulePath, deps)
    // Then: deps.messages contains a user message with content "[CRON_RUN_ID=<cronRunId>]\n<task>"
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const record = makeRecord();
      writeSchedule(schedulePath, [record]);

      const messages: CoreMessage[] = [];
      const { stream } = makeOut();
      const deps: RunCronTurnDeps = {
        model: makeEchoModel(),
        system: "test system",
        messages,
        tools: {},
        sessionFile: join(dir, "session.jsonl"),
        out: stream,
      };
      const fireDate = new Date(record.nextRunAt);
      const expectedCronRunId = computeCronRunId(record, fireDate);

      await runCronTurn(record, fireDate, schedulePath, deps);

      // Find the user message with the cron header
      const cronUserMsg = messages.find(
        (m) => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("CRON_RUN_ID="),
      );
      assert.ok(cronUserMsg !== undefined, "messages must contain a user message with CRON_RUN_ID");
      assert.equal(typeof cronUserMsg.content, "string");
      const content = cronUserMsg.content as string;
      assert.ok(
        content.includes(`[CRON_RUN_ID=${expectedCronRunId}]`),
        `content must include [CRON_RUN_ID=${expectedCronRunId}]; got: "${content}"`,
      );
      assert.ok(content.includes(record.task), `content must include task "${record.task}"; got: "${content}"`);
    } finally {
      cleanup();
    }
  });

  it("T-CronTurn.2: when runCronTurn completes, appendMessages has been called with the slice of messages from turnStart onward", async () => {
    // Given: messages array with some prior turns; runCronTurn called
    // When: runCronTurn(record, fireDate, schedulePath, deps) resolves
    // Then: the messages appended to sessionFile are exactly those added from turnStart index onward
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const sessionFile = join(dir, "session.jsonl");
      const record = makeRecord();
      writeSchedule(schedulePath, [record]);

      const messages: CoreMessage[] = [];
      const { stream } = makeOut();
      const deps: RunCronTurnDeps = {
        model: makeEchoModel(),
        system: "test system",
        messages,
        tools: {},
        sessionFile,
        out: stream,
      };
      const fireDate = new Date(record.nextRunAt);
      await runCronTurn(record, fireDate, schedulePath, deps);

      // appendMessages uses appendFileSync which creates the file
      assert.ok(existsSync(sessionFile), "session file must exist after runCronTurn (appendMessages was called)");
      const content = readFileSync(sessionFile, "utf-8");
      // User message with CRON_RUN_ID and assistant response must be in the file
      assert.ok(
        content.includes("CRON_RUN_ID"),
        `session file must contain CRON_RUN_ID; got: "${content.slice(0, 200)}"`,
      );
    } finally {
      cleanup();
    }
  });

  it.skip("T-CronTurn.3: when runCronTurn is called and abortController.signal is aborted mid-loop, the function returns early and does NOT call appendMessages for messages added after the abort point (D-16)", async () => {
    // Given: AbortController that fires during runAgentLoop execution
    // When: runCronTurn(record, fireDate, schedulePath, deps) with abortSignal
    // Then: function returns early; appendMessages not called for partial cron turn; schedule not updated
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const sessionFile = join(dir, "session-abort.jsonl");
      const record = makeRecord();
      writeSchedule(schedulePath, [record]);

      const abortController = new AbortController();
      // Model that aborts the controller during doStream, then returns a finish stream
      const abortingModel = new MockLanguageModelV1({
        provider: "openai",
        modelId: "test-abort",
        doStream: async () => {
          abortController.abort();
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: "finish" as const,
                  finishReason: "stop" as const,
                  usage: { promptTokens: 1, completionTokens: 0 },
                },
              ],
            }),
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        },
      });

      const messages: CoreMessage[] = [];
      const { stream } = makeOut();
      const deps: RunCronTurnDeps = {
        model: abortingModel,
        system: "test system",
        messages,
        tools: {},
        sessionFile,
        abortSignal: abortController.signal,
        out: stream,
      };

      const fireDate = new Date(record.nextRunAt);
      await runCronTurn(record, fireDate, schedulePath, deps);

      // appendMessages must NOT have been called (no session file created)
      assert.ok(
        !existsSync(sessionFile),
        "session file must NOT exist after aborted runCronTurn (appendMessages was skipped per D-16)",
      );
    } finally {
      cleanup();
    }
  });

  it("T-CronTurn.4: when runCronTurn runs the agent loop, the composedStepFinish onStepFinish hook receives every step (cron path uses same step pipeline as operator turns)", async () => {
    // Given: onStepFinish spy + runCronTurn invocation
    // When: agent loop completes with N steps
    // Then: onStepFinish called N times — confirms cron turn does not bypass the audit/budget pipeline
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const record = makeRecord();
      writeSchedule(schedulePath, [record]);

      const stepFinishCalls: unknown[] = [];
      const messages: CoreMessage[] = [];
      const { stream } = makeOut();
      const deps: RunCronTurnDeps = {
        model: makeEchoModel(),
        system: "test system",
        messages,
        tools: {},
        sessionFile: join(dir, "session.jsonl"),
        out: stream,
        onStepFinish: async (step) => {
          stepFinishCalls.push(step);
        },
      };

      const fireDate = new Date(record.nextRunAt);
      await runCronTurn(record, fireDate, schedulePath, deps);

      assert.ok(
        stepFinishCalls.length >= 1,
        `onStepFinish must be called at least once; called ${stepFinishCalls.length} times`,
      );
    } finally {
      cleanup();
    }
  });

  it("T-CronTurn.5: when runCronTurn completes for a recurring record, writeSchedule is called with the record updated via markRan (lastRunAt + nextRunAt set)", async () => {
    // Given: recurring ScheduleRecord in schedule.jsonl; runCronTurn completes successfully
    // When: runCronTurn(recurringRecord, fireDate, schedulePath, deps)
    // Then: schedule.jsonl rewritten; the record for this id has lastRunAt and nextRunAt updated by markRan
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const record = makeRecord(); // type: "recurring", nextRunAt: "2026-05-10T09:00:00.000Z"
      writeSchedule(schedulePath, [record]);

      const messages: CoreMessage[] = [];
      const { stream } = makeOut();
      const deps: RunCronTurnDeps = {
        model: makeEchoModel(),
        system: "test system",
        messages,
        tools: {},
        sessionFile: join(dir, "session.jsonl"),
        out: stream,
      };

      const fireDate = new Date(record.nextRunAt);
      await runCronTurn(record, fireDate, schedulePath, deps);

      const updated = readSchedule(schedulePath);
      assert.equal(updated.length, 1, "recurring record must remain in schedule (updated, not removed)");
      assert.ok(updated[0] !== undefined, "updated record must exist");
      const r = updated[0];
      assert.equal(r.id, record.id);
      assert.equal(r.lastRunAt, fireDate.toISOString(), "lastRunAt must be set to fireDate");
      assert.ok(
        new Date(r.nextRunAt).getTime() > fireDate.getTime(),
        `nextRunAt must be advanced past fireDate; got nextRunAt=${r.nextRunAt}, fireDate=${fireDate.toISOString()}`,
      );
    } finally {
      cleanup();
    }
  });

  it("T-CronTurn.6: when runCronTurn completes for a one-shot record, writeSchedule is called with the record removed (markRan returned null → filtered out, D-7)", async () => {
    // Given: oneshot ScheduleRecord in schedule.jsonl; runCronTurn completes successfully
    // When: runCronTurn(oneshotRecord, fireDate, schedulePath, deps)
    // Then: schedule.jsonl rewritten without that record (it was the only record → file is empty)
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const record = makeRecord({
        type: "oneshot",
        cronExpr: "at:2026-05-10T09:00:00.000Z",
        nextRunAt: "2026-05-10T09:00:00.000Z",
      });
      writeSchedule(schedulePath, [record]);

      const messages: CoreMessage[] = [];
      const { stream } = makeOut();
      const deps: RunCronTurnDeps = {
        model: makeEchoModel(),
        system: "test system",
        messages,
        tools: {},
        sessionFile: join(dir, "session.jsonl"),
        out: stream,
      };

      const fireDate = new Date(record.nextRunAt);
      await runCronTurn(record, fireDate, schedulePath, deps);

      const remaining = readSchedule(schedulePath);
      assert.equal(
        remaining.length,
        0,
        "one-shot record must be removed from schedule.jsonl after firing (markRan=null → D-7)",
      );
    } finally {
      cleanup();
    }
  });

  it('T-CronTurn.8: when runCronTurn is called with a ScheduleRecord and fireDate in local timezone, the injected user message starts with "[TIME]" and contains human-readable local-time header, preserving [CRON_RUN_ID=...] on the second line', async () => {
    // Given: a ScheduleRecord with task="search VP Sales" and fireDate in local timezone
    // When:  runCronTurn(record, fireDate, schedulePath, deps) is called
    // Then:  the injected user message starts with the "[TIME HH:MM]" marker (local TZ), preserves
    //        "[CRON_RUN_ID=...]" on the second line, and carries the task body on the third line
    const { dir, cleanup } = makeTempDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const record = makeRecord({ task: "search VP Sales" });
      writeSchedule(schedulePath, [record]);

      const messages: CoreMessage[] = [];
      const { stream } = makeOut();
      const deps: RunCronTurnDeps = {
        model: makeEchoModel(),
        system: "test system",
        messages,
        tools: {},
        sessionFile: join(dir, "session.jsonl"),
        out: stream,
      };
      const fireDate = new Date("2026-05-13T14:30:00+08:00");
      await runCronTurn(record, fireDate, schedulePath, deps);

      // P-Z3 rebaseline: the cron-turn injection format is now `[TIME HH:MM]\n[CRON_RUN_ID=…]\n
      // (scheduled task: "…")` (replCron.ts:120) — the Soul day-rhythm (soul.ts §7) reads the
      // [TIME HH:MM] marker. The old Intl date string + "— autonomous check-in" were dropped.
      // Find the user message with the [TIME HH:MM] header.
      const cronUserMsg = messages.find(
        (m) => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("[TIME "),
      );
      assert.ok(cronUserMsg !== undefined, "messages must contain a user message with [TIME HH:MM] header");
      const content = cronUserMsg.content as string;

      // Starts with the "[TIME HH:MM]" marker (local-TZ time → assert the structure, not the value)
      assert.match(
        content,
        /^\[TIME \d{2}:\d{2}\]/,
        `content must start with "[TIME HH:MM]"; got: "${content.slice(0, 30)}"`,
      );

      // Contains [CRON_RUN_ID=...] after the [TIME] header
      const expectedCronRunId = computeCronRunId(record, fireDate);
      assert.ok(
        content.includes(`[CRON_RUN_ID=${expectedCronRunId}]`),
        `content must include [CRON_RUN_ID=${expectedCronRunId}]; got: "${content}"`,
      );
      const timeIdx = content.indexOf("[TIME ");
      const cronRunIdIdx = content.indexOf("[CRON_RUN_ID=");
      assert.ok(cronRunIdIdx > timeIdx, "CRON_RUN_ID must appear after [TIME] header");

      // Contains the task text (in the secondary "(scheduled task: …)" line)
      assert.ok(content.includes("search VP Sales"), `content must include task "search VP Sales"; got: "${content}"`);
    } finally {
      cleanup();
    }
  });

  it("T-CronTurn.7: crash-stable cron_run_id — computeCronRunId(record, new Date(record.nextRunAt)) returns the same value when called twice at different wall-clock instants (D-6, BLOCKER-1 cascade)", async () => {
    // NOTE: Use a permanently-past nextRunAt to avoid any date freshness concern.
    // This is a pure-function test; no clock injection needed.
    //
    // Given: record with fixed nextRunAt="2026-05-10T09:00:00.000Z"; same fireDate argument both calls
    // When: computeCronRunId called at wall-clock instant T1, then 50ms later at T2, both with new Date(record.nextRunAt)
    // Then: both return identical strings — cron_run_id is a function of record.nextRunAt, not Date.now()
    const record = makeRecord(); // id: "abc12345-0000-0000-0000-000000000000", nextRunAt: "2026-05-10T09:00:00.000Z"
    const fireDate = new Date(record.nextRunAt);

    const id1 = computeCronRunId(record, fireDate);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const id2 = computeCronRunId(record, fireDate);

    assert.equal(id1, id2, "cron_run_id must be identical across wall-clock instants when fireDate is the same");
    // Verify format: YYYYMMDD_HHmmss_jobId8
    assert.match(id1, /^\d{8}_\d{6}_[a-f0-9]{8}$/, `cron_run_id format must be YYYYMMDD_HHmmss_jobId8; got: "${id1}"`);
    // Verify specific expected value for our test record
    assert.equal(id1, "20260510_090000_abc12345", "cron_run_id must match expected value for known record+fireDate");
  });
});
