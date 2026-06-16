/**
 * P-24 Step 5 — cron prompt format + OQ-2 advisory hint assertions
 *
 * Tests the P-24 cron prompt format change:
 *   Old: "[TIME] <locale-string> — autonomous check-in\n[CRON_RUN_ID=...]\n<task>"
 *   New: "[TIME HH:MM]\n[CRON_RUN_ID=...]\n(scheduled task: \"<escaped-task>\")"
 *         (or 2 lines when task is empty)
 *
 * Also tests the OQ-2 advisory hint that appears in:
 *   - /cron schedule confirmation
 *   - mai cron list output
 *
 * Gate coverage:
 *   G-P24.11 — T-CRON.FORMAT.1, T-CRON.FORMAT.2, T-CRON.FORMAT.3, T-CRON.FORMAT.4
 *   G-P24.12 — T-CRON.HINT.1, T-CRON.HINT.2
 *
 * No Chrome, no LLM required.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CoreMessage, LanguageModel, ToolSet } from "ai";
import { handleCronSlash, type RunCronTurnDeps, runCronTurn } from "../../src/cli/replCron.js";
import type { ScheduleRecord } from "../../src/persistence/schedule.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "mai-p24-cron-"));
  return {
    dir,
    schedulePath: join(dir, "schedule.jsonl"),
    cleanup: () => cleanupTmpDir(dir),
  };
}

/** Minimal ScheduleRecord fixture for cron prompt tests. */
function makeRecord(task: string, cronExpr = "0 9 * * *"): ScheduleRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    task,
    cronExpr,
    type: "recurring",
    enabled: true,
    createdAt: "2026-05-15T00:00:00.000Z",
    lastRunAt: null,
    nextRunAt: "2026-05-15T09:00:00.000Z",
  };
}

/** Build minimal RunCronTurnDeps that captures pushed messages without running the agent loop.
 *  runCronTurn pushes the user message then calls runAgentLoop; the null model will throw
 *  inside runAgentLoop. We wrap in try/catch and inspect messages after the throw.
 *  Note: deps.messages.push() happens synchronously BEFORE the first await in runCronTurn,
 *  so messages[0] is set by the time control returns to this test (same JS tick). */
function makeCaptureDeps(messages: CoreMessage[], out: NodeJS.WritableStream): RunCronTurnDeps {
  return {
    model: null as unknown as LanguageModel,
    system: "test system prompt",
    messages,
    tools: {} as ToolSet,
    sessionFile: "/tmp/mai-p24-test-session.jsonl",
    out,
  };
}

/** Capture stdout writes to a string. */
function captureStream(): { stream: NodeJS.WritableStream; get: () => string } {
  const chunks: string[] = [];
  const stream = {
    write: (chunk: string | Buffer) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, get: () => chunks.join("") };
}

// ─── T-CRON.FORMAT.1 ─────────────────────────────────────────────────────────

describe("runCronTurn — prompt format: [TIME HH:MM] + [CRON_RUN_ID] + task line (G-P24.11)", () => {
  it("T-CRON.FORMAT.1: when record.task='morning routine' and fireDate=09:00, runCronTurn emits prompt with [TIME 09:00] on line 1", () => {
    // Given: record.task = 'morning routine', fireDate = 2026-05-15T09:00:00 local
    //        deps.messages push happens synchronously before runAgentLoop await
    // When:  runCronTurn builds prompt (null model causes immediate throw after push)
    // Then:  messages[0].content starts with '[TIME 09:00]\n[CRON_RUN_ID=...'
    //        line 3 = '(scheduled task: "morning routine")'
    const { schedulePath, cleanup } = makeTmpDir();
    try {
      const messages: CoreMessage[] = [];
      const { stream } = captureStream();
      const deps = makeCaptureDeps(messages, stream);
      const record = makeRecord("morning routine");
      // local 09:00 — without timezone spec, getHours() = 9
      const fireDate = new Date("2026-05-15T09:00:00");
      // push is synchronous; catch the runAgentLoop throw silently
      void runCronTurn(record, fireDate, schedulePath, deps).catch(() => {});
      // messages[0] is set synchronously (before first await)
      const content = messages[0]?.content as string;
      assert.ok(content, "T-CRON.FORMAT.1: messages[0] must be set synchronously before runAgentLoop");
      const lines = content.split("\n");
      assert.equal(lines[0], "[TIME 09:00]", "T-CRON.FORMAT.1: first line must be '[TIME 09:00]'");
      assert.ok(
        lines[1]?.startsWith("[CRON_RUN_ID="),
        `T-CRON.FORMAT.1: second line must start with '[CRON_RUN_ID='; got: "${lines[1]}"`,
      );
      assert.equal(lines[2], '(scheduled task: "morning routine")', "T-CRON.FORMAT.1: third line must be task line");
    } finally {
      cleanup();
    }
  });
});

// ─── T-CRON.FORMAT.2 ─────────────────────────────────────────────────────────

describe("runCronTurn — empty task omits (scheduled task: ...) line (G-P24.11)", () => {
  it("T-CRON.FORMAT.2: when record.task is empty string, prompt contains only 2 lines: [TIME HH:MM] and [CRON_RUN_ID=...]", () => {
    // Given: record.task = '' (empty); fireDate = any
    // When:  runCronTurn builds prompt
    // Then:  prompt === '[TIME HH:MM]\n[CRON_RUN_ID=...]' (exactly 2 lines; no task line)
    const { schedulePath, cleanup } = makeTmpDir();
    try {
      const messages: CoreMessage[] = [];
      const { stream } = captureStream();
      const deps = makeCaptureDeps(messages, stream);
      const record = makeRecord("");
      const fireDate = new Date("2026-05-15T09:00:00");
      void runCronTurn(record, fireDate, schedulePath, deps).catch(() => {});
      const content = messages[0]?.content as string;
      assert.ok(content, "T-CRON.FORMAT.2: messages[0] must be set");
      const lines = content.split("\n");
      assert.equal(
        lines.length,
        2,
        `T-CRON.FORMAT.2: empty task must produce exactly 2 lines; got ${lines.length}: ${JSON.stringify(lines)}`,
      );
      assert.equal(lines[0], "[TIME 09:00]", "T-CRON.FORMAT.2: first line must be '[TIME 09:00]'");
      assert.ok(
        lines[1]?.startsWith("[CRON_RUN_ID="),
        `T-CRON.FORMAT.2: second line must start with '[CRON_RUN_ID='; got: "${lines[1]}"`,
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-CRON.FORMAT.3 ─────────────────────────────────────────────────────────

describe("runCronTurn — [TIME HH:MM] uses local hours and minutes (G-P24.11)", () => {
  it("T-CRON.FORMAT.3: when fireDate is 14:30, prompt first line is [TIME 14:30]", () => {
    // Given: fireDate local = 14:30 (2026-05-15T14:30:00)
    // When:  runCronTurn builds prompt
    // Then:  messages[0].content starts with '[TIME 14:30]\n'
    const { schedulePath, cleanup } = makeTmpDir();
    try {
      const messages: CoreMessage[] = [];
      const { stream } = captureStream();
      const deps = makeCaptureDeps(messages, stream);
      const record = makeRecord("afternoon check");
      const fireDate = new Date("2026-05-15T14:30:00");
      void runCronTurn(record, fireDate, schedulePath, deps).catch(() => {});
      const content = messages[0]?.content as string;
      assert.ok(content, "T-CRON.FORMAT.3: messages[0] must be set");
      const lines = content.split("\n");
      assert.equal(lines[0], "[TIME 14:30]", "T-CRON.FORMAT.3: first line must be '[TIME 14:30]' for 14:30 fireDate");
    } finally {
      cleanup();
    }
  });
});

// ─── T-CRON.FORMAT.4 ─────────────────────────────────────────────────────────

describe("runCronTurn — task escape: backslash→\\\\, \\r→drop, \\n→space, '\"'→\\\" (G-P24.11 C-3)", () => {
  it("T-CRON.FORMAT.4: when record.task has embedded newline + backslash + CR + double-quote, prompt is exactly 3 lines; escape order is correct", () => {
    // Given: record.task = 'line1\nline2"quoted"\\path\rwith CR'
    //        C-3 escape chain: backslash→\\\\ first, then \\r→drop, \\n→space, "→\\"
    // When:  runCronTurn builds prompt
    // Then:  prompt has exactly 3 lines (embedded LF → space, so no extra newlines)
    //        task line = '(scheduled task: "line1 line2\\"quoted\\"\\\\pathwith CR")'
    const { schedulePath, cleanup } = makeTmpDir();
    try {
      const messages: CoreMessage[] = [];
      const { stream } = captureStream();
      const deps = makeCaptureDeps(messages, stream);
      // task string in memory: line1 + LF + line2"quoted"\path + CR + with CR
      const record = makeRecord('line1\nline2"quoted"\\path\rwith CR');
      const fireDate = new Date("2026-05-15T09:00:00");
      void runCronTurn(record, fireDate, schedulePath, deps).catch(() => {});
      const content = messages[0]?.content as string;
      assert.ok(content, "T-CRON.FORMAT.4: messages[0] must be set");
      const lines = content.split("\n");
      assert.equal(
        lines.length,
        3,
        `T-CRON.FORMAT.4: must be exactly 3 lines (embedded LF→space prevents extra lines); got ${lines.length}`,
      );
      assert.equal(lines[0], "[TIME 09:00]", "T-CRON.FORMAT.4: first line must be [TIME 09:00]");
      assert.ok(lines[1]?.startsWith("[CRON_RUN_ID="), "T-CRON.FORMAT.4: second line must be CRON_RUN_ID");
      // escape chain: \ → \\, CR dropped, LF → space, " → \"
      // expected task in memory: line1 line2\"quoted\"\\pathwith CR
      // in JS single-quoted string: '(scheduled task: "line1 line2\\"quoted\\"\\\\pathwith CR")'
      assert.equal(
        lines[2],
        '(scheduled task: "line1 line2\\"quoted\\"\\\\pathwith CR")',
        'T-CRON.FORMAT.4: task line must have correct C-3 escape (backslash→\\\\, LF→space, CR dropped, "→\\")',
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-CRON.HINT.1 ───────────────────────────────────────────────────────────

describe("handleCronSlash schedule — OQ-2 advisory hint in confirmation output (G-P24.12)", () => {
  it('T-CRON.HINT.1: when operator runs \'/cron schedule "test" --cron "0 9 * * *"\', confirmation output contains exactly the OQ-2 hint line', async () => {
    // Given: schedule.jsonl is empty; valid /cron schedule command
    // When:  handleCronSlash('/cron schedule "test" --cron "0 9 * * *"', schedulePath, out)
    // Then:  out contains OQ-2 hint text
    const { schedulePath, cleanup } = makeTmpDir();
    try {
      const { stream, get } = captureStream();
      await handleCronSlash('/cron schedule "test" --cron "0 9 * * *"', schedulePath, stream);
      const output = get();
      const OQ2_HINT_TEXT =
        "Note: task text is informational. Soul-band day-rhythm drives the agent's primary behavior at scheduled times.";
      assert.ok(output.includes(OQ2_HINT_TEXT), `T-CRON.HINT.1: output must contain OQ-2 hint; got: "${output}"`);
    } finally {
      cleanup();
    }
  });
});

// ─── T-CRON.HINT.2 ───────────────────────────────────────────────────────────

describe("handleCronSlash list — OQ-2 advisory hint appears exactly once (G-P24.12)", () => {
  it("T-CRON.HINT.2: when mai cron list has 1 record, output contains hint exactly once (NOT per-row)", async () => {
    // Given: schedule.jsonl has exactly 1 record (after one /cron schedule call)
    // When:  handleCronSlash('/cron list', schedulePath, out)
    // Then:  out contains OQ-2 hint exactly once (count of occurrences === 1)
    const { schedulePath, cleanup } = makeTmpDir();
    try {
      // Pre-schedule one job
      const { stream: schedStream } = captureStream();
      await handleCronSlash('/cron schedule "test job" --cron "0 9 * * *"', schedulePath, schedStream);

      const { stream: listStream, get } = captureStream();
      await handleCronSlash("/cron list", schedulePath, listStream);
      const output = get();
      const OQ2_HINT_TEXT =
        "Note: task text is informational. Soul-band day-rhythm drives the agent's primary behavior at scheduled times.";
      // Count occurrences
      const occurrences = (output.match(new RegExp(OQ2_HINT_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? [])
        .length;
      assert.equal(
        occurrences,
        1,
        `T-CRON.HINT.2: OQ-2 hint must appear exactly once in list output; found ${occurrences} times. Output: "${output}"`,
      );
    } finally {
      cleanup();
    }
  });
});
