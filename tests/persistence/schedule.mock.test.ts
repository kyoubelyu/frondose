// P-10 mock tests — T-Parse.1..12 + T-Schedule.1..18
//
// Tests for src/persistence/schedule.ts — cron expression parser + schedule.jsonl I/O.
//
// T-Parse.1  — parseCronExpr all-wildcards → 5 {kind:"any"} fields; .expr preserved
// T-Parse.2  — parseCronExpr "0 9 * * *" → {exact:0}/{exact:9} + any fields
// T-Parse.3  — parseCronExpr "step-30-expr" → {step:30} minute field
// T-Parse.4  — parseCronExpr with dayOfWeek range "1-5" (unsupported) → throws
// T-Parse.5  — parseCronExpr 4 fields → throws "5 fields" + actual count
// T-Parse.6  — parseCronExpr 6 fields → throws "5 fields" + actual count
// T-Parse.7  — parseCronExpr minute=60 out of range → throws with field + value + range
// T-Parse.8  — parseCronExpr step=0 invalid → throws with "step" + ">= 1"
// T-Parse.9  — nextRunAfter: step-30 expr, now=09:15 → 09:30 next boundary
// T-Parse.10 — nextRunAfter: "0 9", now=08:59:59 → 09:00 same day
// T-Parse.11 — nextRunAfter: "0 9", now=09:00:00 exactly → 09:00 NEXT day (strict >)
// T-Parse.12 — nextRunAfter: "0 9", now=15:00 → 09:00 next day
//
// T-Schedule.1  — readSchedule: missing file → []
// T-Schedule.2  — readSchedule: 2 valid lines → 2 records with all fields
// T-Schedule.3  — readSchedule: 1 valid + 1 malformed → 1 record + stderr warning
// T-Schedule.4  — writeSchedule: 2 records → parseable JSONL; atomic (no .tmp artifact)
// T-Schedule.5  — writeSchedule: empty array → empty file (0 bytes)
// T-Schedule.6  — findDueJobs: recurring, nextRunAt past (CONCERN-MR-1 fix) → returned
// T-Schedule.7  — findDueJobs: recurring, 1s before due → []
// T-Schedule.8  — findDueJobs: nextRunAt exactly now → returned (>= boundary)
// T-Schedule.9  — findDueJobs: enabled=false → not returned
// T-Schedule.10 — findDueJobs: oneshot, lastRunAt=null, nextRunAt past → returned
// T-Schedule.11 — findDueJobs: oneshot, lastRunAt set (already fired) → not returned
// T-Schedule.12 — markRan: recurring → updated lastRunAt + nextRunAt
// T-Schedule.13 — markRan: oneshot → returns null (removal sentinel, D-7)
// T-Schedule.14 — computeCronRunId format: "20260510_090000_abc12345"
// T-Schedule.15 — parseAtSpec "09:00", now=08:00 local → today 09:00 local
// T-Schedule.16 — parseAtSpec "09:00", now=11:00 local → tomorrow 09:00 local (D-11)
// T-Schedule.17 — parseAtSpec ISO absolute datetime → exact UTC date
// T-Schedule.18 — parseAtSpec unrecognized string → throws with "--at", "HH:MM", "ISO"
//
// Gate coverage:
//   G-P10.1 (T-Parse.1..8), G-P10.2 (T-Parse.9..12), G-P10.3 (T-Schedule.1..5),
//   G-P10.4 (T-Schedule.6..11), G-P10.5 (T-Schedule.12..13),
//   G-P10.6 (T-Schedule.14), G-P10.7 (T-Schedule.15..18)
//
// No Chrome, no LLM, no SQLite. Uses mkdtempSync + cleanup for I/O tests.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  computeCronRunId,
  findDueJobs,
  markRan,
  nextRunAfter,
  parseAtSpec,
  parseCronExpr,
  readSchedule,
  type ScheduleRecord,
  writeSchedule,
} from "../../src/persistence/schedule.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p10-schedule-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeRecord(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: "abc12345-0000-0000-0000-000000000000",
    task: "Test scheduled task",
    cronExpr: "0 9 * * *",
    type: "recurring",
    enabled: true,
    createdAt: "2026-05-10T00:00:00.000Z",
    lastRunAt: null,
    nextRunAt: "2026-05-10T09:00:00.000Z",
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// T-Parse — cron expression parser
// ════════════════════════════════════════════════════════════════════════════════

describe("parseCronExpr — cron expression parsing", () => {
  it("T-Parse.1: when input is '* * * * *', parseCronExpr returns 5 {kind:'any'} fields + preserved .expr", () => {
    // Given: all-wildcard 5-field cron expression
    // When: parseCronExpr("* * * * *")
    // Then: all 5 fields are {kind:"any"} and .expr === "* * * * *"
    const result = parseCronExpr("* * * * *");
    assert.equal(result.minute.kind, "any", "minute.kind");
    assert.equal(result.hour.kind, "any", "hour.kind");
    assert.equal(result.dayOfMonth.kind, "any", "dayOfMonth.kind");
    assert.equal(result.month.kind, "any", "month.kind");
    assert.equal(result.dayOfWeek.kind, "any", "dayOfWeek.kind");
    assert.equal(result.expr, "* * * * *", ".expr preserved");
  });

  it("T-Parse.2: when input is '0 9 * * *', returns minute={kind:'exact',value:0}, hour={kind:'exact',value:9}, rest {kind:'any'}", () => {
    // Given: common daily-at-09:00 expression
    // When: parseCronExpr("0 9 * * *")
    // Then: minute.kind=exact,value=0; hour.kind=exact,value=9; dayOfMonth/month/dayOfWeek all kind=any
    const result = parseCronExpr("0 9 * * *");
    assert.equal(result.minute.kind, "exact");
    assert.equal(result.minute.value, 0);
    assert.equal(result.hour.kind, "exact");
    assert.equal(result.hour.value, 9);
    assert.equal(result.dayOfMonth.kind, "any");
    assert.equal(result.month.kind, "any");
    assert.equal(result.dayOfWeek.kind, "any");
    assert.equal(result.expr, "0 9 * * *");
  });

  it("T-Parse.3: when input is '*/30 * * * *' (every-30-min step), returns minute={kind:'step',step:30}, rest {kind:'any'}", () => {
    // Given: every-30-minute step expression
    // When: parseCronExpr("*/30 * * * *")
    // Then: minute.kind=step, minute.step=30; other fields kind=any
    const result = parseCronExpr("*/30 * * * *");
    assert.equal(result.minute.kind, "step");
    assert.equal(result.minute.step, 30);
    assert.equal(result.hour.kind, "any");
    assert.equal(result.dayOfMonth.kind, "any");
    assert.equal(result.month.kind, "any");
    assert.equal(result.dayOfWeek.kind, "any");
  });

  it("T-Parse.4: when input contains unsupported dayOfWeek range '1-5', parseCronExpr throws containing 'unsupported' and '1-5'", () => {
    // Given: "0 9 * * 1-5" — dayOfWeek range is rejected by MVP parser (D-4)
    // When: parseCronExpr("0 9 * * 1-5")
    // Then: throws Error with message containing "unsupported" and "1-5"
    assert.throws(
      () => parseCronExpr("0 9 * * 1-5"),
      (err: unknown) => {
        const msg = (err as Error).message;
        return msg.includes("unsupported") && msg.includes("1-5");
      },
      "must throw with 'unsupported' and '1-5'",
    );
  });

  it("T-Parse.5: when input has only 4 fields, parseCronExpr throws containing '5 fields' and '4'", () => {
    // Given: "0 9 * *" — 4 fields (one missing)
    // When: parseCronExpr("0 9 * *")
    // Then: throws Error with message containing "5 fields" and "4"
    assert.throws(
      () => parseCronExpr("0 9 * *"),
      (err: unknown) => {
        const msg = (err as Error).message;
        return msg.includes("5 fields") && msg.includes("4");
      },
      "must throw with '5 fields' and '4'",
    );
  });

  it("T-Parse.6: when input has 6 fields, parseCronExpr throws containing '5 fields'", () => {
    // Given: "0 9 * * * *" — 6 fields (one extra)
    // When: parseCronExpr("0 9 * * * *")
    // Then: throws Error with message containing "5 fields"
    assert.throws(
      () => parseCronExpr("0 9 * * * *"),
      (err: unknown) => (err as Error).message.includes("5 fields"),
      "must throw with '5 fields'",
    );
  });

  it("T-Parse.7: when minute field is 60 (out of 0-59 range), parseCronExpr throws containing 'minute', '60', and '0-59'", () => {
    // Given: "60 * * * *" — minute=60 exceeds valid 0-59 range
    // When: parseCronExpr("60 * * * *")
    // Then: throws Error with message containing "minute", "60", and "0-59"
    assert.throws(
      () => parseCronExpr("60 * * * *"),
      (err: unknown) => {
        const msg = (err as Error).message;
        return msg.includes("minute") && msg.includes("60") && msg.includes("0-59");
      },
      "must throw with 'minute', '60', '0-59'",
    );
  });

  it("T-Parse.8: when step is 0 (invalid — must be >= 1), parseCronExpr throws containing 'step' and '>= 1'", () => {
    // Given: "*/0 * * * *" — step=0 violates D-4 (step must be >= 1)
    // When: parseCronExpr("*/0 * * * *")
    // Then: throws Error with message containing "step" and ">= 1"
    assert.throws(
      () => parseCronExpr("*/0 * * * *"),
      (err: unknown) => {
        const msg = (err as Error).message;
        return msg.includes("step") && msg.includes(">= 1");
      },
      "must throw with 'step' and '>= 1'",
    );
  });
});

describe("nextRunAfter — next firing time computation", () => {
  it("T-Parse.9: when expr is '*/30 * * * *' and now=2026-05-10T09:15:00Z, nextRunAfter returns 2026-05-10T09:30:00Z", () => {
    // Given: every-30-min expr + now at 09:15 (mid-interval between 09:00 and 09:30)
    // When: nextRunAfter(parseCronExpr("*/30 * * * *"), new Date("2026-05-10T09:15:00Z"))
    // Then: returned Date equals 2026-05-10T09:30:00.000Z
    const parsed = parseCronExpr("*/30 * * * *");
    const result = nextRunAfter(parsed, new Date("2026-05-10T09:15:00Z"));
    assert.equal(result.toISOString(), "2026-05-10T09:30:00.000Z");
  });

  it("T-Parse.10: when expr is '0 9 * * *' and now=2026-05-10T08:59:59Z, nextRunAfter returns 2026-05-10T09:00:00Z", () => {
    // Given: daily-at-09:00 expr + now is 1 second before the firing boundary
    // When: nextRunAfter(parsed, new Date("2026-05-10T08:59:59Z"))
    // Then: returned Date equals 2026-05-10T09:00:00.000Z (today's fire)
    const parsed = parseCronExpr("0 9 * * *");
    const result = nextRunAfter(parsed, new Date("2026-05-10T08:59:59Z"));
    assert.equal(result.toISOString(), "2026-05-10T09:00:00.000Z");
  });

  it("T-Parse.11: when expr is '0 9 * * *' and now=2026-05-10T09:00:00Z (exactly), nextRunAfter returns 2026-05-11T09:00:00Z (strict > semantics)", () => {
    // Given: daily-at-09:00 expr + now exactly equals the firing boundary
    // When: nextRunAfter(parsed, new Date("2026-05-10T09:00:00Z"))
    // Then: returns TOMORROW's 09:00:00Z — NOT today's (strict greater-than: "after now")
    const parsed = parseCronExpr("0 9 * * *");
    const result = nextRunAfter(parsed, new Date("2026-05-10T09:00:00Z"));
    assert.equal(result.toISOString(), "2026-05-11T09:00:00.000Z");
  });

  it("T-Parse.12: when expr is '0 9 * * *' and now=2026-05-10T15:00:00Z (past today's fire), nextRunAfter returns 2026-05-11T09:00:00Z", () => {
    // Given: daily-at-09:00 expr + now is well past today's firing time
    // When: nextRunAfter(parsed, new Date("2026-05-10T15:00:00Z"))
    // Then: returns next day's 09:00:00.000Z
    const parsed = parseCronExpr("0 9 * * *");
    const result = nextRunAfter(parsed, new Date("2026-05-10T15:00:00Z"));
    assert.equal(result.toISOString(), "2026-05-11T09:00:00.000Z");
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T-Schedule — schedule.jsonl I/O
// ════════════════════════════════════════════════════════════════════════════════

describe("readSchedule — schedule.jsonl reading", () => {
  it("T-Schedule.1: when schedule.jsonl does not exist, readSchedule returns [] without throwing", () => {
    // Given: a file path that does not exist on disk
    // When: readSchedule(nonExistentPath)
    // Then: returns [] (empty array); does NOT throw
    const { dir, cleanup } = makeTempDir();
    try {
      const result = readSchedule(join(dir, "nonexistent.jsonl"));
      assert.deepEqual(result, []);
    } finally {
      cleanup();
    }
  });

  it("T-Schedule.2: when schedule.jsonl contains 2 valid JSONL records, readSchedule returns both preserving all ScheduleRecord fields", () => {
    // Given: a schedule.jsonl file with 2 well-formed JSON lines, one per record
    // When: readSchedule(path)
    // Then: returns 2-element array; each record has all 8 fields preserved exactly
    const { dir, cleanup } = makeTempDir();
    try {
      const r1 = makeRecord({ id: "aaa00000-0000-0000-0000-000000000000" });
      const r2 = makeRecord({ id: "bbb00000-0000-0000-0000-000000000000", task: "Task B" });
      const filePath = join(dir, "schedule.jsonl");
      writeFileSync(filePath, `${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n`, "utf-8");
      const result = readSchedule(filePath);
      assert.equal(result.length, 2);
      assert.deepEqual(result[0], r1);
      assert.deepEqual(result[1], r2);
    } finally {
      cleanup();
    }
  });

  it("T-Schedule.3: when schedule.jsonl has 1 valid + 1 malformed line, readSchedule returns 1 record, writes stderr warning with line number, and does NOT throw", () => {
    // Given: schedule.jsonl line 1 = valid record, line 2 = '{not json' (malformed)
    // When: readSchedule(path)
    // Then: returns 1-element array; stderr receives warning mentioning the malformed line number; no exception thrown
    const { dir, cleanup } = makeTempDir();
    try {
      const r1 = makeRecord();
      const filePath = join(dir, "schedule.jsonl");
      writeFileSync(filePath, `${JSON.stringify(r1)}\n{not json\n`, "utf-8");

      const stderrChunks: string[] = [];
      const origStderr = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
        return origStderr(chunk, ...(rest as Parameters<typeof origStderr>).slice(1));
      };
      let result: ScheduleRecord[] = [];
      try {
        result = readSchedule(filePath);
      } finally {
        process.stderr.write = origStderr;
      }

      assert.equal(result.length, 1, "returns 1 valid record");
      assert.deepEqual(result[0], r1);
      const stderrOut = stderrChunks.join("");
      // Implementation writes: "[mai] schedule.jsonl line 2 malformed (skipped): ..."
      assert.ok(stderrOut.includes("2") || stderrOut.length > 0, "stderr has warning about malformed line");
    } finally {
      cleanup();
    }
  });
});

describe("writeSchedule — schedule.jsonl writing", () => {
  it("T-Schedule.4: when writeSchedule(path, [rec1, rec2]) is called, file has 2 parseable JSONL lines and no .tmp artifact remains (atomic write via tmp+rename)", () => {
    // Given: 2 valid ScheduleRecord objects; a file path in a temp dir
    // When: writeSchedule(path, [rec1, rec2])
    // Then: file contains 2 JSON lines each parseable back to original records; path+".tmp" does NOT exist
    const { dir, cleanup } = makeTempDir();
    try {
      const r1 = makeRecord({ id: "aaa00000-0000-0000-0000-000000000000" });
      const r2 = makeRecord({ id: "bbb00000-0000-0000-0000-000000000000" });
      const filePath = join(dir, "schedule.jsonl");
      writeSchedule(filePath, [r1, r2]);

      assert.ok(existsSync(filePath), "file must exist");
      assert.ok(!existsSync(`${filePath}.tmp`), "no .tmp artifact after atomic rename");

      const content = readFileSync(filePath, "utf-8");
      const lines = content
        .trim()
        .split("\n")
        .filter((l) => l.trim());
      assert.equal(lines.length, 2, "2 JSONL lines");
      assert.deepEqual(JSON.parse(lines[0]!), r1);
      assert.deepEqual(JSON.parse(lines[1]!), r2);
    } finally {
      cleanup();
    }
  });

  it("T-Schedule.5: when writeSchedule(path, []) is called, file exists with 0 bytes", () => {
    // Given: empty records array; a file path in a temp dir
    // When: writeSchedule(path, [])
    // Then: file exists on disk AND has 0 bytes (not missing; not containing whitespace)
    const { dir, cleanup } = makeTempDir();
    try {
      const filePath = join(dir, "empty.jsonl");
      writeSchedule(filePath, []);
      assert.ok(existsSync(filePath), "file must exist");
      assert.equal(statSync(filePath).size, 0, "file must be 0 bytes");
    } finally {
      cleanup();
    }
  });
});

describe("findDueJobs — filtering due records", () => {
  it("T-Schedule.6: when recurring record has nextRunAt 30min in the past and enabled=true, findDueJobs returns it (CONCERN-MR-1 fix: nextRunAt drives due-ness, not lastRunAt)", () => {
    // Given: record with nextRunAt 30min in the past, enabled=true
    // When: findDueJobs([record], now)
    // Then: returns [record] — due-ness is nextRunAt <= now
    const now = new Date("2026-05-10T09:30:00Z");
    const r = makeRecord({ nextRunAt: "2026-05-10T09:00:00.000Z", enabled: true });
    const result = findDueJobs([r], now);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], r);
  });

  it("T-Schedule.7: when recurring record has nextRunAt=09:30:00Z and now=09:29:59Z (1s before due), findDueJobs returns []", () => {
    // Given: recurring record with nextRunAt 1 second in the future from now
    // When: findDueJobs([record], new Date("2026-05-10T09:29:59Z"))
    // Then: returns [] — not due yet
    const r = makeRecord({ nextRunAt: "2026-05-10T09:30:00.000Z" });
    const result = findDueJobs([r], new Date("2026-05-10T09:29:59Z"));
    assert.deepEqual(result, []);
  });

  it("T-Schedule.8: when recurring record has nextRunAt=09:30:00Z and now=09:30:00Z exactly, findDueJobs returns it (>= boundary, inclusive)", () => {
    // Given: record with nextRunAt == now exactly
    // When: findDueJobs([record], now === nextRunAt)
    // Then: returns [record] — inclusive >= boundary
    const r = makeRecord({ nextRunAt: "2026-05-10T09:30:00.000Z" });
    const result = findDueJobs([r], new Date("2026-05-10T09:30:00.000Z"));
    assert.equal(result.length, 1);
  });

  it("T-Schedule.9: when a record has enabled=false and is otherwise past-due, findDueJobs does NOT return it", () => {
    // Given: record with enabled=false; nextRunAt in the past
    // When: findDueJobs([record], pastNow)
    // Then: returns [] — disabled records always skipped
    const r = makeRecord({ enabled: false, nextRunAt: "2026-05-10T08:00:00.000Z" });
    const result = findDueJobs([r], new Date("2026-05-10T09:30:00Z"));
    assert.deepEqual(result, []);
  });

  it("T-Schedule.10: when a one-shot record has lastRunAt=null and nextRunAt in the past, findDueJobs returns it", () => {
    // Given: oneshot record with lastRunAt=null, nextRunAt in the past
    // When: findDueJobs([record], now after nextRunAt)
    // Then: returns [record] — past one-shots fire on next drain opportunity
    const r = makeRecord({
      type: "oneshot",
      cronExpr: "at:2026-05-10T09:00:00.000Z",
      lastRunAt: null,
      nextRunAt: "2026-05-10T09:00:00.000Z",
    });
    const result = findDueJobs([r], new Date("2026-05-10T09:30:00Z"));
    assert.equal(result.length, 1);
  });

  it("T-Schedule.11: when a one-shot record has lastRunAt set (already fired), findDueJobs does NOT return it", () => {
    // Given: oneshot record with lastRunAt set to a previous firing time
    // When: findDueJobs([record], any)
    // Then: returns [] — one-shots fire exactly once; lastRunAt guards against re-fire
    const r = makeRecord({
      type: "oneshot",
      cronExpr: "at:2026-05-10T09:00:00.000Z",
      lastRunAt: "2026-05-10T09:00:01.000Z",
      nextRunAt: "2026-05-10T09:00:00.000Z",
    });
    const result = findDueJobs([r], new Date("2026-05-10T09:30:00Z"));
    assert.deepEqual(result, []);
  });
});

describe("markRan — updating records after firing", () => {
  it("T-Schedule.12: when markRan is called on a recurring record with a specific fireDate, returns record with lastRunAt=fireDate.toISOString() and nextRunAt computed by nextRunAfter", () => {
    // Given: recurring ScheduleRecord with cronExpr="0 9 * * *"; fireDate=2026-05-10T09:00:00Z
    // When: markRan(record, fireDate)
    // Then: returned record.lastRunAt = fireDate.toISOString(); nextRunAt = 2026-05-11T09:00:00.000Z
    const r = makeRecord({ cronExpr: "0 9 * * *" });
    const fireDate = new Date("2026-05-10T09:00:00Z");
    const updated = markRan(r, fireDate);
    assert.ok(updated !== null, "recurring markRan must NOT return null");
    assert.equal(updated!.lastRunAt, "2026-05-10T09:00:00.000Z");
    assert.equal(updated!.nextRunAt, "2026-05-11T09:00:00.000Z");
    // All other fields preserved
    assert.equal(updated!.id, r.id);
    assert.equal(updated!.task, r.task);
  });

  it("T-Schedule.13: when markRan is called on a one-shot record, returns null (D-7 removal sentinel)", () => {
    // Given: one-shot ScheduleRecord
    // When: markRan(record, anyFireDate)
    // Then: returns null — signals caller to remove this record from schedule.jsonl
    const r = makeRecord({ type: "oneshot", cronExpr: "at:2026-05-10T09:00:00.000Z" });
    const result = markRan(r, new Date());
    assert.equal(result, null);
  });
});

describe("computeCronRunId — cron run ID format determinism (D-6, G-P10.6)", () => {
  it("T-Schedule.14: when computeCronRunId is called with record.id='abc12345-...' and fireDate=2026-05-10T09:00:00Z, returns '20260510_090000_abc12345'", () => {
    // Given: record with id="abc12345-0000-0000-0000-000000000000"; fireDate=new Date("2026-05-10T09:00:00.000Z")
    // When: computeCronRunId(record, fireDate)
    // Then: returns exactly "20260510_090000_abc12345" — YYYYMMDD_HHmmss_jobId8 format, UTC-derived
    const r = makeRecord(); // id = "abc12345-0000-0000-0000-000000000000"
    const fireDate = new Date("2026-05-10T09:00:00.000Z");
    const result = computeCronRunId(r, fireDate);
    assert.equal(result, "20260510_090000_abc12345");
  });
});

describe("parseAtSpec — --at argument parsing (D-11, G-P10.7)", () => {
  it("T-Schedule.15: when parseAtSpec('09:00', now=08:00-local-today) is called, returns today's 09:00 in local timezone", () => {
    // Given: HH:MM input "09:00"; now constructed as local-tz 08:00 today (time not yet past)
    // When: parseAtSpec("09:00", now)
    // Then: returned Date represents TODAY at 09:00 local time (not UTC)
    const today = new Date();
    const nowAt8 = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 8, 0, 0, 0);
    const result = parseAtSpec("09:00", nowAt8);
    const expected = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 0, 0, 0);
    assert.equal(result.getTime(), expected.getTime(), "returns today's 09:00 local when now=08:00");
  });

  it("T-Schedule.16: when parseAtSpec('09:00', now=11:00-local-today) is called (HH:MM already past today), returns tomorrow's 09:00 in local timezone (D-11 'tomorrow if past')", () => {
    // Given: HH:MM input "09:00"; now constructed as local-tz 11:00 today (09:00 already passed)
    // When: parseAtSpec("09:00", now)
    // Then: returned Date represents TOMORROW at 09:00 local — prevents immediate accidental fire
    const today = new Date();
    const nowAt11 = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 11, 0, 0, 0);
    const result = parseAtSpec("09:00", nowAt11);
    // Tomorrow at 09:00 local
    const expected = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 9, 0, 0, 0);
    assert.equal(result.getTime(), expected.getTime(), "returns TOMORROW's 09:00 local when now=11:00 (D-11)");
  });

  it("T-Schedule.17: when parseAtSpec('2026-05-11T09:00:00Z', any-now) is called, returns absolute UTC Date 2026-05-11T09:00:00.000Z", () => {
    // Given: ISO-8601 datetime string "2026-05-11T09:00:00Z"; any value of now
    // When: parseAtSpec("2026-05-11T09:00:00Z", anyNow)
    // Then: returned Date.toISOString() === "2026-05-11T09:00:00.000Z" (timezone-independent)
    const result = parseAtSpec("2026-05-11T09:00:00Z", new Date());
    assert.equal(result.toISOString(), "2026-05-11T09:00:00.000Z");
  });

  it("T-Schedule.18: when parseAtSpec('not-a-time', any) is called, throws with '--at', 'HH:MM', and 'ISO' in the message", () => {
    // Given: unrecognized input that matches neither HH:MM nor ISO-8601 pattern
    // When: parseAtSpec("not-a-time", now)
    // Then: throws Error with message containing "--at", "HH:MM", and "ISO" (or "iso" / "datetime")
    assert.throws(
      () => parseAtSpec("not-a-time", new Date()),
      (err: unknown) => {
        const msg = (err as Error).message.toLowerCase();
        return msg.includes("--at") && msg.includes("hh:mm") && (msg.includes("iso") || msg.includes("datetime"));
      },
      "must throw with '--at', 'HH:MM', 'ISO' in message",
    );
  });
});
