/**
 * P-31 Step 4a — T-ST.* scaffolds (schedule_task tool behaviors)
 *
 * Gate coverage:
 *   G-P31.1  — T-ST.1 (valid cron_expr: writes record + returns ok envelope)
 *   G-P31.2  — T-ST.2 (range rejected), T-ST.3 (wrong field count rejected)
 *   G-P31.3  — T-ST.4 (appends to existing schedule.jsonl)
 *   G-P31.1 + D-7 — T-ST.5 (schema = {task, cron_expr}; description names grammar)
 *
 * NOTE (Step 4a): T-ST.1–4 all fail at execute() — the stub throws.
 *   T-ST.5 will PASS at Step 4a (stub's description already matches D-7 spec).
 *   Builder replaces the stub at Step 4b; validator fills assert bodies at Step 5.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ScheduleRecord } from "../../src/persistence/schedule.js";
import { readSchedule, writeSchedule } from "../../src/persistence/schedule.js";
import { makeScheduleTaskTool } from "../../src/tools/cron/scheduleTask.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p31-st-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Invoke tool.execute with the standard Vercel tool execution options shape. */
async function exec(tool: ReturnType<typeof makeScheduleTaskTool>, args: { task: string; cron_expr: string }) {
  return tool.execute(args, { toolCallId: "test-st", messages: [] });
}

// ─── T-ST.1 ───────────────────────────────────────────────────────────────────

describe("schedule_task — valid cron_expr writes record (G-P31.1)", () => {
  it("T-ST.1: when execute({task:'daily outreach', cron_expr:'0 9 * * *'}), returns {ok:true,id,nextRunAt} and writes ScheduleRecord to schedule.jsonl", async () => {
    // Given:  empty tmp schedulePath; makeScheduleTaskTool(schedulePath)
    // When:   execute({task:"daily outreach", cron_expr:"0 9 * * *"})
    // Then:   {ok:true, id, nextRunAt}; readSchedule(path) has 1 record:
    //         type:"recurring", enabled:true, cronExpr:"0 9 * * *", nextRunAt valid ISO

    const { dir, cleanup } = makeTmpDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const tool = makeScheduleTaskTool(schedulePath);

      const result = await exec(tool, { task: "daily outreach", cron_expr: "0 9 * * *" });

      // ok===true envelope
      assert.equal(result.ok, true, `result.ok must be true for valid cron_expr; got: ${JSON.stringify(result)}`);
      // TypeScript narrowing: double-cast after runtime assertion (as unknown required — union type)
      const okResult = result as unknown as { ok: true; id: string; nextRunAt: string };
      // id is a UUID (36-char hex-and-dash)
      assert.match(okResult.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "id must be a UUID");
      // nextRunAt is a valid ISO 8601 date
      assert.ok(
        !Number.isNaN(Date.parse(okResult.nextRunAt)),
        `nextRunAt must be valid ISO; got ${okResult.nextRunAt}`,
      );
      // nextRunAt must be in the future
      assert.ok(Date.parse(okResult.nextRunAt) > Date.now(), "nextRunAt must be a future time");

      // schedule.jsonl has exactly 1 record
      const records = readSchedule(schedulePath);
      assert.equal(records.length, 1, "schedule.jsonl must have exactly 1 record");
      const rec = records[0];
      assert.ok(rec !== undefined);
      assert.equal(rec.task, "daily outreach", "record.task must match tool input");
      assert.equal(rec.cronExpr, "0 9 * * *", "record.cronExpr must match tool input");
      assert.equal(rec.type, "recurring", "record.type must be 'recurring'");
      assert.equal(rec.enabled, true, "record.enabled must be true");
      assert.equal(rec.id, okResult.id, "record.id must match result.id");
      assert.equal(rec.nextRunAt, okResult.nextRunAt, "record.nextRunAt must match result.nextRunAt");
      assert.strictEqual(rec.lastRunAt, null, "record.lastRunAt must be null (never run)");
    } finally {
      cleanup();
    }
  });
});

// ─── T-ST.2 ───────────────────────────────────────────────────────────────────

describe("schedule_task — range cron_expr rejected (G-P31.2)", () => {
  it("T-ST.2: when execute({task:'x', cron_expr:'0 9 * * 1-5'}) (range — unsupported by parseCronExpr), returns {ok:false,error} and schedule.jsonl is NOT modified", async () => {
    // Given:  empty tmp schedulePath
    // When:   execute({task:"x", cron_expr:"0 9 * * 1-5"})
    // Then:   {ok:false, error} mentioning unsupported token; readSchedule still []

    const { dir, cleanup } = makeTmpDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const tool = makeScheduleTaskTool(schedulePath);

      const result = await exec(tool, { task: "x", cron_expr: "0 9 * * 1-5" });

      // ok===false envelope
      assert.equal(result.ok, false, `result.ok must be false for range cron_expr; got: ${JSON.stringify(result)}`);
      const errResult = result as { ok: false; error: string };
      // parseCronExpr throws: 'cron field dayOfWeek: unsupported token "1-5" (supported: *, */N, integer)'
      assert.ok(
        errResult.error.includes("unsupported token") || errResult.error.includes("1-5"),
        `error must mention unsupported token for range expr; got: "${errResult.error}"`,
      );
      // schedule.jsonl must remain empty (no partial writes on error)
      assert.equal(readSchedule(schedulePath).length, 0, "schedule.jsonl must be empty after error");
    } finally {
      cleanup();
    }
  });
});

// ─── T-ST.3 ───────────────────────────────────────────────────────────────────

describe("schedule_task — wrong field count rejected (G-P31.2)", () => {
  it("T-ST.3: when execute({task:'x', cron_expr:'0 9 * *'}) (4 fields, not 5), returns {ok:false,error} about field count", async () => {
    // Given:  empty tmp schedulePath
    // When:   execute({task:"x", cron_expr:"0 9 * *"}) — only 4 cron fields
    // Then:   {ok:false, error} about wrong field count; schedule.jsonl unchanged

    const { dir, cleanup } = makeTmpDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const tool = makeScheduleTaskTool(schedulePath);

      const result = await exec(tool, { task: "x", cron_expr: "0 9 * *" });

      // ok===false envelope
      assert.equal(result.ok, false, `result.ok must be false for 4-field cron_expr; got: ${JSON.stringify(result)}`);
      const errResult = result as { ok: false; error: string };
      // parseCronExpr throws: 'cron expression must have 5 fields (got 4): "0 9 * *"'
      assert.ok(
        errResult.error.includes("5 fields") || errResult.error.includes("field"),
        `error must mention field count requirement; got: "${errResult.error}"`,
      );
      // schedule.jsonl must remain empty
      assert.equal(readSchedule(schedulePath).length, 0, "schedule.jsonl must be empty after field-count error");
    } finally {
      cleanup();
    }
  });
});

// ─── T-ST.4 ───────────────────────────────────────────────────────────────────

describe("schedule_task — appends to existing schedule.jsonl (G-P31.3)", () => {
  it("T-ST.4: given schedulePath with 2 existing records, when valid execute, results in 3 records with the 2 originals byte-intact", async () => {
    // Given:  tmp schedulePath pre-populated with 2 ScheduleRecord entries
    // When:   execute({task:"new job", cron_expr:"*/15 * * * *"})
    // Then:   readSchedule returns 3 records; first 2 equal the originals

    const { dir, cleanup } = makeTmpDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const existing: ScheduleRecord[] = [
        {
          id: "aaa",
          task: "first",
          cronExpr: "0 8 * * *",
          type: "recurring",
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastRunAt: null,
          nextRunAt: "2026-01-02T08:00:00.000Z",
        },
        {
          id: "bbb",
          task: "second",
          cronExpr: "*/30 * * * *",
          type: "recurring",
          enabled: true,
          createdAt: "2026-01-01T01:00:00.000Z",
          lastRunAt: null,
          nextRunAt: "2026-01-01T01:30:00.000Z",
        },
      ];
      writeSchedule(schedulePath, existing);

      const tool = makeScheduleTaskTool(schedulePath);
      const result = await exec(tool, { task: "new job", cron_expr: "*/15 * * * *" });

      // ok===true (valid cron_expr)
      assert.equal(result.ok, true, `append must succeed; got: ${JSON.stringify(result)}`);

      // 3 records total
      const records = readSchedule(schedulePath);
      assert.equal(records.length, 3, "must have 3 records after appending (2 original + 1 new)");

      // First two originals byte-intact
      assert.deepEqual(records[0], existing[0], "first original record must be unchanged");
      assert.deepEqual(records[1], existing[1], "second original record must be unchanged");

      // Third record is the new one
      const newRec = records[2];
      assert.ok(newRec !== undefined, "third record must exist");
      assert.equal(newRec.task, "new job", "new record.task must match tool input");
      assert.equal(newRec.cronExpr, "*/15 * * * *", "new record.cronExpr must match tool input");
      assert.equal(newRec.type, "recurring", "new record.type must be 'recurring'");
      assert.equal(newRec.enabled, true, "new record.enabled must be true");
    } finally {
      cleanup();
    }
  });
});

// ─── T-ST.5 ───────────────────────────────────────────────────────────────────

describe("schedule_task — parameter schema + description (G-P31.1 + D-7)", () => {
  it("T-ST.5: parameters schema is exactly {task, cron_expr} (both required strings); description names */*/N/integer grammar and does NOT show a range example", () => {
    // Given:  makeScheduleTaskTool(anyPath) returns a Vercel Tool
    // When:   inspect tool.parameters._def.shape() and tool.description
    // Then:   exactly 2 fields — task + cron_expr; description contains `*`, `*/N`,
    //         "integer", does NOT contain example "1-5" or "1,3" (unsupported tokens)

    const tool = makeScheduleTaskTool("/dev/null");

    // Schema: exactly {task, cron_expr}
    // biome-ignore lint/suspicious/noExplicitAny: Zod internals
    const shape = (tool.parameters as any)._def.shape();
    const fields = Object.keys(shape).sort();
    assert.deepEqual(fields, ["cron_expr", "task"], "parameters must have exactly {task, cron_expr}");

    // Description: names the grammar
    const desc = tool.description ?? "";
    assert.ok(desc.includes("`*`") || desc.includes("*"), "description must mention `*` (any) field");
    assert.ok(desc.includes("`*/N`") || desc.includes("*/N"), "description must mention `*/N` (step) field");
    assert.ok(
      desc.toLowerCase().includes("integer") || desc.toLowerCase().includes("single integer"),
      "description must mention single integer fields",
    );

    // Must NOT show a range example (D-7: ranges are unsupported and must not be suggested)
    assert.ok(
      !desc.includes("1-5") || desc.includes("NOT") || desc.includes("not supported"),
      "description must not present a range example without marking it as unsupported",
    );
  });
});
