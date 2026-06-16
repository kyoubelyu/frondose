/**
 * P-31 Step 4a — T-CLI.* scaffolds (mai cron schedule CLI subcommand)
 *
 * Gate coverage:
 *   G-P31.6  — T-CLI.1 (--cron <expr> writes recurring record)
 *   G-P31.7  — T-CLI.2 (--at <time> writes oneshot record)
 *   G-P31.8  — T-CLI.3 (no flag → error, no write), T-CLI.4 (bad expr → error)
 *
 * The CLI delegates to handleCronSlash (replCron.ts:183), so tests drive that
 * function directly with a tmp schedulePath + capture stream (plan §11 DI surface).
 * handleCronSlash exists pre-P-31 and is importable now.
 *
 * NOTE (Step 4a): all assertion bodies are TODO — tests fail at assert.fail("TODO").
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import { handleCronSlash } from "../../src/cli/replCron.js";
import { readSchedule } from "../../src/persistence/schedule.js";
import { cleanupTmpDir } from "../_helpers/tmp";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p31-cli-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

/** Capture stream for handleCronSlash output. */
function makeCapture(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines };
}

// ─── T-CLI.1 ──────────────────────────────────────────────────────────────────

describe("mai cron schedule --cron (G-P31.6)", () => {
  it('T-CLI.1: handleCronSlash(\'/cron schedule "post update" --cron "30 8 * * *"\', schedulePath, out) writes a recurring ScheduleRecord to schedulePath', async () => {
    // Given:  empty tmp schedulePath; capture stream
    // When:   handleCronSlash('/cron schedule "post update" --cron "30 8 * * *"', schedulePath, out)
    // Then:   readSchedule(schedulePath) has 1 record with type:"recurring", cronExpr:"30 8 * * *", task:"post update"

    const { dir, cleanup } = makeTmpDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const { stream } = makeCapture();

      await handleCronSlash('/cron schedule "post update" --cron "30 8 * * *"', schedulePath, stream);

      const records = readSchedule(schedulePath);
      assert.equal(records.length, 1, "must write exactly 1 record to schedulePath");
      const rec = records[0];
      assert.ok(rec !== undefined, "record must exist");
      assert.equal(rec.type, "recurring", "type must be 'recurring' for --cron flag");
      assert.equal(rec.cronExpr, "30 8 * * *", "cronExpr must match the --cron argument");
      assert.equal(rec.task, "post update", "task must match the quoted task argument");
      assert.equal(rec.enabled, true, "record.enabled must be true");
      // nextRunAt must be a future ISO date
      assert.ok(!Number.isNaN(Date.parse(rec.nextRunAt)), `nextRunAt must be valid ISO; got ${rec.nextRunAt}`);
    } finally {
      cleanup();
    }
  });
});

// ─── T-CLI.2 ──────────────────────────────────────────────────────────────────

describe("mai cron schedule --at (G-P31.7)", () => {
  it('T-CLI.2: handleCronSlash(\'/cron schedule "ping" --at "14:30"\', schedulePath, out) writes a oneshot ScheduleRecord', async () => {
    // Given:  empty tmp schedulePath; capture stream
    // When:   handleCronSlash('/cron schedule "ping" --at "14:30"', schedulePath, out)
    // Then:   readSchedule has 1 record with type:"oneshot"

    const { dir, cleanup } = makeTmpDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const { stream } = makeCapture();

      await handleCronSlash('/cron schedule "ping" --at "14:30"', schedulePath, stream);

      const records = readSchedule(schedulePath);
      assert.equal(records.length, 1, "must write exactly 1 record for --at oneshot");
      const rec = records[0];
      assert.ok(rec !== undefined, "record must exist");
      assert.equal(rec.type, "oneshot", "type must be 'oneshot' for --at flag");
      assert.equal(rec.task, "ping", "task must match the quoted task argument");
      // cronExpr for oneshot is "at:<ISO>" — e.g. "at:2026-05-19T14:30:00.000Z"
      assert.ok(rec.cronExpr.startsWith("at:"), `oneshot cronExpr must start with 'at:'; got "${rec.cronExpr}"`);
      assert.equal(rec.enabled, true, "record.enabled must be true");
    } finally {
      cleanup();
    }
  });
});

// ─── T-CLI.3 ──────────────────────────────────────────────────────────────────

describe("mai cron schedule — no flag → error (G-P31.8)", () => {
  it("T-CLI.3: handleCronSlash('/cron schedule \"x\"', schedulePath, out) (no --cron / --at) writes an error message; schedule.jsonl is NOT created/modified", async () => {
    // Given:  empty tmp schedulePath; capture stream
    // When:   handleCronSlash('/cron schedule "x"', schedulePath, out) — no flag
    // Then:   error written to stream; readSchedule(schedulePath) returns []

    const { dir, cleanup } = makeTmpDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const { stream, lines } = makeCapture();

      await handleCronSlash('/cron schedule "x"', schedulePath, stream);

      // parseCronSlashLine throws: "/cron schedule: --cron or --at required"
      // handleCronSlash catches and writes: "/cron: /cron schedule: --cron or --at required\n"
      const output = lines.join("");
      assert.ok(output.length > 0, "error message must be written to stream when no flag given");
      assert.ok(
        output.includes("--cron") || output.includes("--at") || output.includes("required"),
        `error must mention --cron / --at requirement; got: "${output}"`,
      );
      // No record must be written on parse error
      assert.equal(readSchedule(schedulePath).length, 0, "schedule.jsonl must remain empty on parse error");
    } finally {
      cleanup();
    }
  });
});

// ─── T-CLI.4 ──────────────────────────────────────────────────────────────────

describe("mai cron schedule --cron <bad_expr> → parser error (G-P31.8 sibling)", () => {
  it('T-CLI.4: handleCronSlash(\'/cron schedule "x" --cron "bad_expr"\', schedulePath, out) surfaces parseCronExpr error; no record written', async () => {
    // Given:  empty tmp schedulePath; capture stream
    // When:   handleCronSlash('/cron schedule "x" --cron "bad_expr"', schedulePath, out)
    // Then:   error (parseCronExpr message) written to stream; readSchedule returns []

    const { dir, cleanup } = makeTmpDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const { stream, lines } = makeCapture();

      await handleCronSlash('/cron schedule "x" --cron "bad_expr"', schedulePath, stream);

      // parseCronExpr("bad_expr") throws: "cron expression must have 5 fields (got 1): "bad_expr""
      // handleCronSlash catches (inside schedule branch) and writes: "/cron schedule: cron expression..."
      const output = lines.join("");
      assert.ok(output.length > 0, "error message must be written to stream when cron_expr is invalid");
      assert.ok(
        output.includes("cron") || output.includes("field") || output.includes("bad_expr"),
        `error must reference the invalid expr; got: "${output}"`,
      );
      // No record must be written on parser error
      assert.equal(readSchedule(schedulePath).length, 0, "schedule.jsonl must remain empty on cron parser error");
    } finally {
      cleanup();
    }
  });
});
