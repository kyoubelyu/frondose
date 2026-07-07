/**
 * P-AUTO-ISOLATE Step 2 — Test Scaffold — the new `stop_auto` agent tool
 * (`src/tools/cron/stopAuto.ts`, NEW file per plan §3.1 / §6.3).
 *
 * Covers (plan §5): T-StopAuto.1, T-StopAuto.2, T-StopAuto.5.
 *
 * Per outside-in TDD + BDD-light: ALL assertion bodies are
 * `assert.fail("TODO Step 5: …")` — RED at Step 2/3/4a. The module does not
 * exist yet, so `import(...)` is guarded (dynamic-import-via-computed-URL
 * idiom — established convention, e.g. tests/overlay/eventBus-p55.mock.test.ts)
 * and this whole file fails at the import-guard branch until Codex's Step 4b
 * creates `src/tools/cron/stopAuto.ts` per plan §6.3.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/cron/stopAuto-pAutoIsolate.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readSchedule } from "../../../src/persistence/schedule.js";

// biome-ignore lint/suspicious/noExplicitAny: makeStopAutoTool does not exist yet at Step 2
type AnyFn = (...args: any[]) => any;

/** Dynamically import the not-yet-existing module; null on any failure (module missing or export missing). */
async function importStopAutoTool(): Promise<AnyFn | null> {
  try {
    const mod = await import("../../../src/tools/cron/stopAuto.js");
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import of a module that may not export this yet
    return (mod as any).makeStopAutoTool ?? null;
  } catch {
    return null;
  }
}

function writeScheduleRecords(schedulePath: string, records: unknown[]): void {
  writeFileSync(schedulePath, records.length === 0 ? "" : `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

function makeAutoSessionRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    task: "standing task",
    cronExpr: "*/15 * * * *",
    type: "recurring",
    nextRunAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    lastRunAt: null,
    createdAt: new Date().toISOString(),
    enabled: true,
    kind: "auto_session",
    sessionId: randomUUID(),
    ...overrides,
  };
}

function makeLegacyRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    task: "legacy schedule_task record (no kind field)",
    cronExpr: "0 9 * * *",
    type: "recurring",
    nextRunAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    lastRunAt: null,
    createdAt: new Date().toISOString(),
    enabled: true,
    ...overrides,
  };
}

/** Call `tool.execute(input)` with the runtime cast Vercel `tool({...})` requires. */
async function runStopAuto(tool: unknown, input: Record<string, unknown> = {}): Promise<unknown> {
  return await (tool as unknown as { execute: (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown> }).execute(
    input,
    { toolCallId: "t-stopauto", messages: [] },
  );
}

// ─── T-StopAuto.1 — tool disables the schedule record ───────────────────────

describe("makeStopAutoTool — disables the enabled kind:auto_session schedule record (T-StopAuto.1, LOCKED-3)", () => {
  it("T-StopAuto.1: given schedule.jsonl has one kind:auto_session, enabled:true record, when stop_auto({summary:'done'}) executes, then readSchedule(schedulePath) shows that record with enabled:false, and the tool return envelope is {ok:true, data:{sessionsDisabled:1, summary:'done'}}", async () => {
    // Given: schedule.jsonl has ONE enabled kind:auto_session record
    // When:  makeStopAutoTool(schedulePath).execute({summary:'done'})
    // Then:  readSchedule shows that record enabled:false; envelope {ok:true, data:{sessionsDisabled:1, summary:'done'}}
    const makeStopAutoTool = await importStopAutoTool();
    const schedulePath = join(tmpdir(), `stopauto-t1-${randomUUID()}.jsonl`);
    const record = makeAutoSessionRecord();
    writeScheduleRecords(schedulePath, [record]);

    let result: unknown = null;
    if (makeStopAutoTool !== null) {
      const tool = makeStopAutoTool(schedulePath);
      result = await runStopAuto(tool, { summary: "done" });
    }
    const after = readSchedule(schedulePath);
    const stillEnabled = after.find((r) => r.id === record.id)?.enabled;

    assert.ok(makeStopAutoTool !== null, "makeStopAutoTool must be importable from src/tools/cron/stopAuto.ts");
    assert.equal(stillEnabled, false, "the auto_session record must be disabled after stop_auto");
    assert.deepEqual(
      result,
      { ok: true, command: "stop_auto", data: { sessionsDisabled: 1, summary: "done" } },
      "stop_auto({summary:'done'}) must return {ok:true,command:'stop_auto',data:{sessionsDisabled:1,summary:'done'}}",
    );
  });
});

// ─── T-StopAuto.2 — idempotent when nothing to stop ─────────────────────────

describe("makeStopAutoTool — idempotent when no auto_session records exist (T-StopAuto.2)", () => {
  it("T-StopAuto.2: given no auto_session records exist, when stop_auto() executes, then it returns {ok:true, data:{sessionsDisabled:0, summary:null}} — no error", async () => {
    // Given: schedule.jsonl has zero records (or only non-auto_session records)
    // When:  makeStopAutoTool(schedulePath).execute({}) (summary omitted)
    // Then:  {ok:true, data:{sessionsDisabled:0, summary:null}} — never an error envelope
    const makeStopAutoTool = await importStopAutoTool();
    const schedulePath = join(tmpdir(), `stopauto-t2-${randomUUID()}.jsonl`);
    writeScheduleRecords(schedulePath, []);

    let result: unknown = null;
    if (makeStopAutoTool !== null) {
      const tool = makeStopAutoTool(schedulePath);
      result = await runStopAuto(tool, {});
    }

    assert.ok(makeStopAutoTool !== null, "makeStopAutoTool must be importable");
    assert.deepEqual(
      result,
      { ok: true, command: "stop_auto", data: { sessionsDisabled: 0, summary: null } },
      "stop_auto() with no auto_session records must return {ok:true,data:{sessionsDisabled:0,summary:null}}",
    );
  });
});

// ─── T-StopAuto.5 — leaves non-auto records untouched ───────────────────────

describe("makeStopAutoTool — leaves legacy (non-auto_session) schedule records untouched (T-StopAuto.5)", () => {
  it("T-StopAuto.5: given schedule.jsonl has one kind:auto_session record AND one legacy record (no kind, enabled:true), when stop_auto() runs, then the legacy record is unchanged (enabled:true, no kind added)", async () => {
    // Given: schedule.jsonl has TWO records — one kind:auto_session (enabled:true) and
    //        one legacy record with NO kind field (enabled:true, e.g. an operator schedule_task)
    // When:  makeStopAutoTool(schedulePath).execute({})
    // Then:  the legacy record's enabled stays true AND it gains NO 'kind' field
    //        (disableAutoSessionRecords must only touch kind==='auto_session' rows)
    const makeStopAutoTool = await importStopAutoTool();
    const schedulePath = join(tmpdir(), `stopauto-t5-${randomUUID()}.jsonl`);
    const autoRecord = makeAutoSessionRecord();
    const legacyRecord = makeLegacyRecord();
    writeScheduleRecords(schedulePath, [autoRecord, legacyRecord]);

    if (makeStopAutoTool !== null) {
      const tool = makeStopAutoTool(schedulePath);
      await runStopAuto(tool, {});
    }
    const after = readSchedule(schedulePath);
    const legacyAfter = after.find((r) => r.id === legacyRecord.id);

    assert.ok(makeStopAutoTool !== null, "makeStopAutoTool must be importable");
    assert.equal(legacyAfter?.enabled, true, "the legacy (non-auto_session) record must remain enabled:true");
    assert.equal((legacyAfter as { kind?: unknown } | undefined)?.kind, undefined, "the legacy record must gain no 'kind' field");
  });
});
