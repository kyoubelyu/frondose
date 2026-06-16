/**
 * P-13 Step 4a — T-CronI.1..3 scaffolds
 *
 * Tests:
 *   T-CronI.1 — positional-id path: handleCronSlash removes job (non-interactive, no prompter)
 *   T-CronI.2 — runCronRemoveInteractive: select + confirm=true → returns job id
 *   T-CronI.3 — runCronRemoveInteractive: select + confirm=false → returns null, prints "Cancelled."
 *
 * Gate coverage: G-P13.5 + G-P13.7
 *
 * NOTE:
 *   T-CronI.2/3 import runCronRemoveInteractive from src/cli/subcommands/cronRemove.ts (does NOT
 *   exist at Step 4a). Tests fail at import-resolution until builder Step 4b.
 *   T-CronI.1 uses handleCronSlash from src/cli/replCron.ts (already exists).
 *   Step 5 fills assertion bodies.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { handleCronSlash } from "../../../src/cli/replCron.js";
import { runCronRemoveInteractive } from "../../../src/cli/subcommands/cronRemove.js";
import { cleanupTmpDir } from "../../_helpers/tmp";
import { captureStdout, makeMockPrompter } from "./_mockPrompter.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpSchedDir(): { schedulePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p13-cron-"));
  return {
    schedulePath: join(dir, "schedule.jsonl"),
    cleanup: () => cleanupTmpDir(dir),
  };
}

/** Write N fake schedule records to schedulePath and return the records. */
function writeFakeJobs(
  schedulePath: string,
  jobs: Array<{ id: string; type: string; task: string; nextRunAt: string }>,
): void {
  const lines = jobs.map((j) =>
    JSON.stringify({
      id: j.id,
      type: j.type,
      task: j.task,
      nextRunAt: j.nextRunAt,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
    }),
  );
  writeFileSync(schedulePath, `${lines.join("\n")}\n`, "utf-8");
}

function readScheduleLines(schedulePath: string): unknown[] {
  try {
    return readFileSync(schedulePath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// ─── T-CronI.1 ───────────────────────────────────────────────────────────────

describe("cron remove <id> — positional arg path via handleCronSlash", () => {
  it("T-CronI.1: when handleCronSlash('/cron remove abc12345') is called with a 2-job schedule, removes the matched job", async () => {
    // Given: schedule.jsonl has 2 jobs; one job.id starts with "abc12345"
    // When:  handleCronSlash("/cron remove abc12345", schedulePath, stdout) is called
    // Then:  matched job removed from schedule.jsonl; the other job remains

    const { schedulePath, cleanup } = makeTmpSchedDir();
    try {
      writeFakeJobs(schedulePath, [
        { id: "abc12345-full-job-id", type: "recurring", task: "Run daily report", nextRunAt: "2026-05-13T09:00:00Z" },
        { id: "xyz99999-other-job", type: "oneshot", task: "One-time task", nextRunAt: "2026-05-14T10:00:00Z" },
      ]);

      const out: string[] = [];
      const fakeStdout = {
        write: (s: string) => {
          out.push(s);
          return true;
        },
      } as unknown as NodeJS.WriteStream;
      await handleCronSlash("/cron remove abc12345", schedulePath, fakeStdout);
      const remaining = readScheduleLines(schedulePath);
      assert.equal(remaining.length, 1, "T-CronI.1: only 1 job should remain");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion on raw JSON
      assert.ok(!(remaining[0] as any).id.startsWith("abc12345"), "T-CronI.1: abc12345 job must be removed");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion on raw JSON
      assert.equal((remaining[0] as any).id, "xyz99999-other-job", "T-CronI.1: other job preserved");
    } finally {
      cleanup();
    }
  });
});

// ─── T-CronI.2 ───────────────────────────────────────────────────────────────

describe("runCronRemoveInteractive — select + confirm=true (happy path)", () => {
  it("T-CronI.2: when 2-job schedule AND schedulesSelect returns job-A's id AND confirm=true, returns job-A id; both prompts called", async () => {
    // Given: schedule.jsonl has 2 jobs (job-A, job-B); schedulesSelect→"job-A-id"; confirm→true
    // When:  runCronRemoveInteractive(schedulePath, mockPrompter) is awaited
    // Then:  result === "job-A-id"; schedulesSelect called with 2-job array; confirm called with (string, false)

    const { schedulePath, cleanup } = makeTmpSchedDir();
    const mp = makeMockPrompter({
      schedulesSelect: async () => "job-A-full-id",
      confirm: async () => true,
    });
    try {
      writeFakeJobs(schedulePath, [
        { id: "job-A-full-id", type: "recurring", task: "Task A description here", nextRunAt: "2026-05-13T09:00:00Z" },
        { id: "job-B-full-id", type: "oneshot", task: "Task B description here", nextRunAt: "2026-05-14T10:00:00Z" },
      ]);

      const result = await runCronRemoveInteractive(schedulePath, mp);
      assert.equal(result, "job-A-full-id", "T-CronI.2: result must be job-A id");
      assert.equal(mp.calls.schedulesSelect.length, 1, "T-CronI.2: schedulesSelect called once");
      assert.equal(mp.calls.schedulesSelect[0].length, 2, "T-CronI.2: schedulesSelect receives 2-job array");
      assert.equal(mp.calls.confirm.length, 1, "T-CronI.2: confirm called once");
      // confirm called with (message, false) — default is false for destructive ops
      assert.equal(mp.calls.confirm[0][1], false, "T-CronI.2: confirm defaultValue must be false");
    } finally {
      cleanup();
    }
  });
});

// ─── T-CronI.3 ───────────────────────────────────────────────────────────────

describe("runCronRemoveInteractive — select + confirm=false (operator declined)", () => {
  it("T-CronI.3: when schedulesSelect returns job-A id AND confirm=false, returns null, prints 'Cancelled.', schedule unchanged", async () => {
    // Given: schedule.jsonl has 2 jobs; schedulesSelect→"job-A-full-id"; confirm→false
    // When:  runCronRemoveInteractive(schedulePath, mockPrompter) is awaited
    // Then:  result===null; stdout contains "Cancelled."; schedule.jsonl unchanged (both jobs still present)

    const { schedulePath, cleanup } = makeTmpSchedDir();
    const mp = makeMockPrompter({
      schedulesSelect: async () => "job-A-full-id",
      confirm: async () => false,
    });
    try {
      writeFakeJobs(schedulePath, [
        { id: "job-A-full-id", type: "recurring", task: "Task A description here", nextRunAt: "2026-05-13T09:00:00Z" },
        { id: "job-B-full-id", type: "oneshot", task: "Task B description here", nextRunAt: "2026-05-14T10:00:00Z" },
      ]);

      let result: string | null = "sentinel";
      const stdout = await captureStdout(async () => {
        result = await runCronRemoveInteractive(schedulePath, mp);
      });
      assert.equal(result, null, "T-CronI.3: result must be null when confirm=false");
      assert.ok(stdout.includes("Cancelled"), `T-CronI.3: stdout must include "Cancelled."; got: "${stdout}"`);
      const remaining = readScheduleLines(schedulePath);
      assert.equal(remaining.length, 2, "T-CronI.3: schedule.jsonl must be unchanged (2 jobs)");
    } finally {
      cleanup();
    }
  });
});
