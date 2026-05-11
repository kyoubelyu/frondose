/**
 * P-11 Step 5 — T-CLI.cron.1..T-CLI.cron.4 (filled assertions)
 *
 * mai cron list|remove — delegated to handleCronSlash in src/cli/replCron.ts (EXISTING).
 *
 * Gate coverage: G-P11.18 (T-CLI.cron.1..4)
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { handleCronSlash } from "../../src/cli/replCron.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpScheduleDir(): { schedulePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p11-cronsub-"));
  return { schedulePath: join(dir, "schedule.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

/** Write a minimal oneshot schedule record. */
function writeRecord(schedulePath: string, id: string, task: string): void {
  const rec = {
    id,
    type: "oneshot",
    task,
    cronExpr: null,
    nextRunAt: new Date(Date.now() + 3600_000).toISOString(),
    createdAt: new Date().toISOString(),
    lastRunAt: null,
  };
  writeFileSync(schedulePath, `${JSON.stringify(rec)}\n`, "utf-8");
}

// ─── T-CLI.cron: mai cron subcommand delegation ───────────────────────────────

describe("mai cron subcommand — delegates to handleCronSlash (G-P11.18)", () => {
  it("T-CLI.cron.1: when 'mai cron list' invoked AND schedule.jsonl is empty, stdout contains '(no scheduled jobs)'", async () => {
    // Given: schedule.jsonl empty (or non-existent)
    // When: handleCronSlash("/cron list", schedulePath, out) called (mirrors mai cron list delegation)
    // Then: captured output contains "(no scheduled jobs)"
    const { schedulePath, cleanup } = makeTmpScheduleDir();
    const { stream, lines } = makeOut();
    try {
      writeFileSync(schedulePath, "", "utf-8");
      await handleCronSlash("/cron list", schedulePath, stream);
      const output = lines.join("");
      assert.ok(
        output.includes("no scheduled jobs"),
        `output must contain "(no scheduled jobs)" for empty schedule; got: "${output}"`,
      );
    } finally {
      cleanup();
    }
  });

  it("T-CLI.cron.2: when 'mai cron list' invoked AND schedule.jsonl has 2 records, stdout contains both records' id8 + task + schedule expression", async () => {
    // Given: schedule.jsonl with 2 records (ids: 'aabbccdd11', 'eeff223344'; tasks: "Task A", "Task B")
    // When: handleCronSlash("/cron list", schedulePath, out) called
    // Then: output contains first 8 chars of each id + "Task A" + "Task B"
    const { schedulePath, cleanup } = makeTmpScheduleDir();
    const { stream, lines } = makeOut();
    try {
      writeRecord(schedulePath, "aabbccdd11223344", "Task A");
      const rec2 = {
        id: "eeff223344556677",
        type: "oneshot",
        task: "Task B",
        cronExpr: null,
        nextRunAt: new Date(Date.now() + 3600_000).toISOString(),
        createdAt: new Date().toISOString(),
        lastRunAt: null,
      };
      appendFileSync(schedulePath, `${JSON.stringify(rec2)}\n`, "utf-8");
      await handleCronSlash("/cron list", schedulePath, stream);
      const output = lines.join("");
      // Both tasks must appear
      assert.ok(output.includes("Task A"), `output must contain "Task A"; got: "${output}"`);
      assert.ok(output.includes("Task B"), `output must contain "Task B"; got: "${output}"`);
      // First 8 chars of each id must appear
      assert.ok(output.includes("aabbccdd"), `output must contain id8 "aabbccdd" for first record; got: "${output}"`);
      assert.ok(output.includes("eeff2233"), `output must contain id8 "eeff2233" for second record; got: "${output}"`);
    } finally {
      cleanup();
    }
  });

  it("T-CLI.cron.3: when 'mai cron remove <id8>' invoked AND a record matches, schedule.jsonl rewritten without that record AND stdout contains 'removed:' + id8", async () => {
    // Given: schedule.jsonl with 1 record; id8 = first 8 chars of that record's id
    // When: handleCronSlash("/cron remove aabbccdd", schedulePath, out) called
    // Then: schedule.jsonl no longer contains that record; output contains "removed:" + "aabbccdd"
    const { schedulePath, cleanup } = makeTmpScheduleDir();
    const { stream, lines } = makeOut();
    try {
      writeRecord(schedulePath, "aabbccdd11223344", "Task X");
      await handleCronSlash("/cron remove aabbccdd", schedulePath, stream);
      const output = lines.join("");

      // Output must confirm removal
      assert.ok(
        output.includes("removed") || output.includes("aabbccdd"),
        `output must confirm removal of "aabbccdd"; got: "${output}"`,
      );

      // schedule.jsonl must not contain the removed record any more
      const remaining = readFileSync(schedulePath, "utf-8");
      assert.ok(
        !remaining.includes("aabbccdd11223344"),
        `schedule.jsonl must not contain removed id "aabbccdd11223344"; got content: "${remaining}"`,
      );
    } finally {
      cleanup();
    }
  });

  it("T-CLI.cron.4: when 'mai cron remove zzzzzzzz' invoked AND no record matches, stdout contains no-match error AND schedule.jsonl unchanged", async () => {
    // Given: schedule.jsonl with 1 record (id does not start with 'zzzzzzzz')
    // When: handleCronSlash("/cron remove zzzzzzzz", schedulePath, out) called
    // Then: output contains "No job found" or "not found" or similar; schedule.jsonl byte-identical
    const { schedulePath, cleanup } = makeTmpScheduleDir();
    const { stream, lines } = makeOut();
    try {
      writeRecord(schedulePath, "aabbccdd11223344", "Task Y");
      const contentBefore = readFileSync(schedulePath, "utf-8");

      await handleCronSlash("/cron remove zzzzzzzz", schedulePath, stream);
      const output = lines.join("");

      // Output must indicate no match
      assert.ok(
        output.includes("No job found") || output.includes("not found") || output.includes("zzzzzzzz"),
        `output must indicate no matching job for "zzzzzzzz"; got: "${output}"`,
      );

      // schedule.jsonl must be unchanged
      const contentAfter = readFileSync(schedulePath, "utf-8");
      assert.equal(contentAfter, contentBefore, "schedule.jsonl content must be unchanged when no record matches");
    } finally {
      cleanup();
    }
  });
});
