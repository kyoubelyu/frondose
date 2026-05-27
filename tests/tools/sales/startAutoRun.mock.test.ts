/**
 * P-SP-E Step 5 — T-E.Start.1..3 (G-PSPE.4..5) — assertions filled.
 * start_auto_run tool: new-row path + idempotent-resume path + Zod validation.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/sales/startAutoRun.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: runtime resolution
type AnyFn = (...args: any[]) => any;

function makeTmpPath(): string {
  return join(tmpdir(), `start-auto-run-test-${randomUUID()}.sqlite`);
}

describe("T-E.Start — start_auto_run tool (P-SP-E Sketch B)", () => {
  // ─── T-E.Start.1 ─────────────────────────────────────────────────────────────
  it("T-E.Start.1: clean DB → start_auto_run({maxDurationMinutes:30, maxConnects:5}) creates 1 row, returns {runId, startedAt, maxDurationMinutes:30, maxConnects:5}", async () => {
    // Given: fresh temp sales.sqlite (no running auto_runs row)
    // When:  makeStartAutoRunTool(tmpPath).execute({maxDurationMinutes:30, maxConnects:5}) called
    // Then:  returned envelope: ok=true, output.runId=UUID, output.maxDurationMinutes=30, output.maxConnects=5;
    //        auto_runs table has exactly 1 row with status='running'
    const tmpPath = makeTmpPath();
    const mod = await import("../../../src/tools/sales/startAutoRun.js").catch(() => null);
    const makeStartAutoRunTool: AnyFn = mod?.makeStartAutoRunTool ?? null;
    if (!makeStartAutoRunTool) {
      assert.ok(false, "makeStartAutoRunTool not exported — Sketch B not built");
      return;
    }

    const tool = makeStartAutoRunTool(tmpPath);
    const result = await tool.execute({ maxDurationMinutes: 30, maxConnects: 5 });

    assert.ok(result.ok === true, `T-E.Start.1: envelope must be ok=true; got: ${JSON.stringify(result)}`);
    assert.ok(typeof result.data?.runId === "string" && result.data.runId.length > 0,
      "T-E.Start.1: runId must be a non-empty UUID string");
    assert.equal(result.data?.maxDurationMinutes, 30, "T-E.Start.1: maxDurationMinutes must be 30");
    assert.equal(result.data?.maxConnects, 5, "T-E.Start.1: maxConnects must be 5");
    assert.ok(typeof result.data?.startedAt === "number", "T-E.Start.1: startedAt must be a number (unix ms)");
    assert.equal(result.data?.resumed, false, "T-E.Start.1: resumed must be false for new row");

    // Verify DB state: exactly 1 row with status='running'
    const dbMod = await import("../../../src/persistence/salesDb.js").catch(() => null);
    if (dbMod?.openSalesDatabase) {
      const db = dbMod.openSalesDatabase(tmpPath);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const rows = (db as any).prepare("SELECT * FROM auto_runs").all();
      assert.equal(rows.length, 1, "T-E.Start.1: auto_runs must have exactly 1 row");
      assert.equal(rows[0].status, "running", "T-E.Start.1: row status must be 'running'");
    }
  });

  // ─── T-E.Start.2 ─────────────────────────────────────────────────────────────
  it("T-E.Start.2: existing running row → start_auto_run({maxDurationMinutes:60, maxConnects:99}) returns EXISTING row (idempotent); auto_runs still has exactly 1 row", async () => {
    // Given: temp sales.sqlite with 1 already-running auto_runs row (status='running')
    // When:  start_auto_run called with DIFFERENT caps (60, 99) — second call
    // Then:  returned runId === original runId (NOT a new row);
    //        original caps (30, 5) are preserved; auto_runs still has exactly 1 row;
    //        output.resumed === true
    const tmpPath = makeTmpPath();
    const mod = await import("../../../src/tools/sales/startAutoRun.js").catch(() => null);
    const makeStartAutoRunTool: AnyFn = mod?.makeStartAutoRunTool ?? null;
    if (!makeStartAutoRunTool) {
      assert.ok(false, "makeStartAutoRunTool not exported — Sketch B not built");
      return;
    }

    const tool = makeStartAutoRunTool(tmpPath);

    // First call — creates row
    const result1 = await tool.execute({ maxDurationMinutes: 30, maxConnects: 5 });
    assert.ok(result1.ok === true, "T-E.Start.2: first call must succeed");
    const originalRunId = result1.data?.runId;

    // Second call — with DIFFERENT caps; should return original row
    const result2 = await tool.execute({ maxDurationMinutes: 60, maxConnects: 99 });
    assert.ok(result2.ok === true, `T-E.Start.2: second call must succeed; got: ${JSON.stringify(result2)}`);
    assert.equal(result2.data?.runId, originalRunId, "T-E.Start.2: runId must be the original (idempotent)");
    assert.equal(result2.data?.maxDurationMinutes, 30, "T-E.Start.2: original caps must be preserved (not 60)");
    assert.equal(result2.data?.maxConnects, 5, "T-E.Start.2: original maxConnects must be preserved (not 99)");
    assert.equal(result2.data?.resumed, true, "T-E.Start.2: resumed must be true for existing row");

    // Only 1 row in DB
    const dbMod = await import("../../../src/persistence/salesDb.js").catch(() => null);
    if (dbMod?.openSalesDatabase) {
      const db = dbMod.openSalesDatabase(tmpPath);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const rows = (db as any).prepare("SELECT * FROM auto_runs").all();
      assert.equal(rows.length, 1, "T-E.Start.2: auto_runs must still have exactly 1 row (idempotent)");
    }
  });

  // ─── T-E.Start.3 ─────────────────────────────────────────────────────────────
  it("T-E.Start.3: Zod schema rejects maxDurationMinutes:0 (min=1) AND maxConnects:-1 (min=0 or absent)", async () => {
    // Given: makeStartAutoRunTool Zod schema (maxDurationMinutes: z.number().int().min(1))
    // When:  execute({maxDurationMinutes:0}) or execute({maxConnects:-1}) called
    // Then:  returned envelope has ok=false AND error.kind describing the validation failure;
    //        no auto_runs row inserted
    const tmpPath = makeTmpPath();
    const mod = await import("../../../src/tools/sales/startAutoRun.js").catch(() => null);
    const makeStartAutoRunTool: AnyFn = mod?.makeStartAutoRunTool ?? null;
    if (!makeStartAutoRunTool) {
      assert.ok(false, "makeStartAutoRunTool not exported — Sketch B not built");
      return;
    }

    const tool = makeStartAutoRunTool(tmpPath);

    // Test maxDurationMinutes:0 (min is 1)
    const resultZeroDuration = await tool.execute({ maxDurationMinutes: 0 });
    assert.ok(resultZeroDuration.ok === false,
      `T-E.Start.3: maxDurationMinutes:0 must return ok=false (min=1); got: ${JSON.stringify(resultZeroDuration)}`);

    // Test maxConnects:-1 (min is 0)
    const resultNegConnects = await tool.execute({ maxDurationMinutes: 30, maxConnects: -1 });
    assert.ok(resultNegConnects.ok === false,
      `T-E.Start.3: maxConnects:-1 must return ok=false (min=0); got: ${JSON.stringify(resultNegConnects)}`);
  });
});
