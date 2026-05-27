/**
 * P-SP-E Step 5 — T-E.End.1..5 (G-PSPE.6..7) — assertions filled.
 * end_auto_run tool: happy path + status enum + summary requirement + idempotent + not-found.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/sales/endAutoRun.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: runtime resolution
type AnyFn = (...args: any[]) => any;

function makeTmpPath(): string {
  return join(tmpdir(), `end-auto-run-test-${randomUUID()}.sqlite`);
}

/** Seed a running auto_runs row. Returns {runId}. */
// biome-ignore lint/suspicious/noExplicitAny: test helper
async function seedRunningRow(tmpPath: string): Promise<string> {
  const dbMod = await import("../../../src/persistence/salesDb.js");
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  const db = (dbMod as any).openSalesDatabase(tmpPath);
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  const row = (dbMod as any).insertAutoRun(db, { maxDurationMinutes: 15, maxConnects: 5 });
  return row.id;
}

describe("T-E.End — end_auto_run tool (P-SP-E Sketch C)", () => {
  // ─── T-E.End.1 ───────────────────────────────────────────────────────────────
  it("T-E.End.1: running row + end_auto_run({runId, status:'completed', summary:'3 connects sent'}) → row status='completed', ended_at≈now, summary+counters written", async () => {
    // Given: temp sales.sqlite with 1 running auto_runs row; ledger may have 0 rows
    // When:  makeEndAutoRunTool(tmpPath).execute({runId, status:'completed', summary:'3 connects sent, 17 candidates observed'})
    // Then:  ok=true, alreadyEnded=false; row status='completed', ended_at non-null, summary set
    const tmpPath = makeTmpPath();
    const runId = await seedRunningRow(tmpPath);

    const mod = await import("../../../src/tools/sales/endAutoRun.js").catch(() => null);
    const makeEndAutoRunTool: AnyFn = mod?.makeEndAutoRunTool ?? null;
    if (!makeEndAutoRunTool) {
      assert.ok(false, "makeEndAutoRunTool not exported — Sketch C not built");
      return;
    }

    const tool = makeEndAutoRunTool(tmpPath);
    const beforeEnd = Date.now();
    const result = await tool.execute({
      runId,
      status: "completed",
      summary: "3 connects sent, 17 candidates observed",
    });
    const afterEnd = Date.now();

    assert.ok(result.ok === true, `T-E.End.1: envelope must be ok=true; got: ${JSON.stringify(result)}`);
    assert.equal(result.data?.alreadyEnded, false, "T-E.End.1: alreadyEnded must be false on first call");
    assert.equal(result.data?.status, "completed", "T-E.End.1: returned status must be 'completed'");

    // Verify DB row
    const dbMod = await import("../../../src/persistence/salesDb.js");
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const db = (dbMod as any).openSalesDatabase(tmpPath);
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const row = (db as any).prepare("SELECT * FROM auto_runs WHERE id = ?").get(runId);
    assert.ok(row !== undefined, "T-E.End.1: row must exist");
    assert.equal(row.status, "completed", "T-E.End.1: DB row status must be 'completed'");
    assert.ok(
      row.ended_at !== null && row.ended_at >= beforeEnd && row.ended_at <= afterEnd,
      "T-E.End.1: ended_at must be ≈ Date.now()",
    );
    assert.ok(
      row.summary !== null && row.summary.includes("3 connects sent"),
      "T-E.End.1: summary must be set and include the provided text",
    );
    assert.ok(row.counters !== null, "T-E.End.1: counters must be non-null (auto-populated from ledger)");
  });

  // ─── T-E.End.2 ───────────────────────────────────────────────────────────────
  it("T-E.End.2: each valid status (completed / stopped_by_agent / blocked) succeeds; stopped_by_user REJECTED by Zod", async () => {
    // Given: 3 separate running auto_runs rows (one per valid status)
    // When:  end_auto_run called with each status in turn
    // Then:  completed → ok; stopped_by_agent → ok; blocked → ok;
    //        stopped_by_user → ok=false (Zod rejects: reserved for server-side cancel)
    const mod = await import("../../../src/tools/sales/endAutoRun.js").catch(() => null);
    const makeEndAutoRunTool: AnyFn = mod?.makeEndAutoRunTool ?? null;
    if (!makeEndAutoRunTool) {
      assert.ok(false, "makeEndAutoRunTool not exported — Sketch C not built");
      return;
    }

    // Test each valid status
    for (const status of ["completed", "stopped_by_agent", "blocked"]) {
      const tmpPath = makeTmpPath();
      const runId = await seedRunningRow(tmpPath);
      const tool = makeEndAutoRunTool(tmpPath);
      const result = await tool.execute({
        runId,
        status,
        summary: "Run completed successfully here",
      });
      assert.ok(
        result.ok === true,
        `T-E.End.2: status '${status}' must produce ok=true; got: ${JSON.stringify(result)}`,
      );
    }

    // Test stopped_by_user — must be rejected by Zod
    const tmpPath = makeTmpPath();
    const runId = await seedRunningRow(tmpPath);
    const tool = makeEndAutoRunTool(tmpPath);
    const resultUser = await tool.execute({
      runId,
      status: "stopped_by_user",
      summary: "User cancelled the run forcefully here",
    });
    assert.ok(
      resultUser.ok === false,
      `T-E.End.2: stopped_by_user must return ok=false (Zod-rejected per OQ-E5); got: ${JSON.stringify(resultUser)}`,
    );
  });

  // ─── T-E.End.3 ───────────────────────────────────────────────────────────────
  it("T-E.End.3: end_auto_run on already-ended row → returns {ok:true, alreadyEnded:true}; no DB mutation; ended_at unchanged", async () => {
    // Given: 1 running row; first end_auto_run call completes it (ended_at=T1)
    // When:  second end_auto_run call with different status and summary
    // Then:  second call returns ok=true, alreadyEnded=true;
    //        row still has original ended_at T1 (no overwrite); original status/summary preserved
    const tmpPath = makeTmpPath();
    const runId = await seedRunningRow(tmpPath);

    const mod = await import("../../../src/tools/sales/endAutoRun.js").catch(() => null);
    const makeEndAutoRunTool: AnyFn = mod?.makeEndAutoRunTool ?? null;
    if (!makeEndAutoRunTool) {
      assert.ok(false, "makeEndAutoRunTool not exported — Sketch C not built");
      return;
    }

    const tool = makeEndAutoRunTool(tmpPath);

    // First call
    await tool.execute({ runId, status: "completed", summary: "All leads processed successfully" });

    // Read ended_at after first call
    const dbMod = await import("../../../src/persistence/salesDb.js");
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const db = (dbMod as any).openSalesDatabase(tmpPath);
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const rowAfterFirst = (db as any).prepare("SELECT ended_at, status FROM auto_runs WHERE id = ?").get(runId);
    const endedAtT1 = rowAfterFirst.ended_at;

    // Wait 10ms to ensure clock would produce a different timestamp
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Second call — different status + summary
    const result2 = await tool.execute({
      runId,
      status: "stopped_by_agent",
      summary: "This should be ignored if alreadyEnded",
    });

    assert.ok(result2.ok === true, `T-E.End.3: second call must return ok=true; got: ${JSON.stringify(result2)}`);
    assert.equal(result2.data?.alreadyEnded, true, "T-E.End.3: alreadyEnded must be true on second call");

    // Verify no mutation
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const rowAfterSecond = (db as any).prepare("SELECT ended_at, status FROM auto_runs WHERE id = ?").get(runId);
    assert.equal(rowAfterSecond.ended_at, endedAtT1, "T-E.End.3: ended_at must NOT be mutated by second call");
    assert.equal(rowAfterSecond.status, "completed", "T-E.End.3: status must NOT be mutated by second call");
  });

  // ─── T-E.End.4 ───────────────────────────────────────────────────────────────
  it("T-E.End.4: Zod schema rejects summary < 10 chars (OQ-E10 requirement)", async () => {
    // Given: running auto_runs row; end_auto_run called with summary='short' (5 chars < min 10)
    // When:  execute({runId, status:'completed', summary:'short'}) called
    // Then:  returned envelope ok=false; row status still 'running' (no mutation on Zod rejection)
    const tmpPath = makeTmpPath();
    const runId = await seedRunningRow(tmpPath);

    const mod = await import("../../../src/tools/sales/endAutoRun.js").catch(() => null);
    const makeEndAutoRunTool: AnyFn = mod?.makeEndAutoRunTool ?? null;
    if (!makeEndAutoRunTool) {
      assert.ok(false, "makeEndAutoRunTool not exported — Sketch C not built");
      return;
    }

    const tool = makeEndAutoRunTool(tmpPath);
    const result = await tool.execute({ runId, status: "completed", summary: "short" });

    assert.ok(
      result.ok === false,
      `T-E.End.4: summary 'short' (5 chars) must return ok=false (min=10 per OQ-E10); got: ${JSON.stringify(result)}`,
    );

    // Verify row still running (no DB mutation on Zod rejection)
    const dbMod = await import("../../../src/persistence/salesDb.js");
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const db = (dbMod as any).openSalesDatabase(tmpPath);
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const row = (db as any).prepare("SELECT status FROM auto_runs WHERE id = ?").get(runId);
    assert.equal(row?.status, "running", "T-E.End.4: row status must still be 'running' after Zod rejection");
  });

  // ─── T-E.End.5 ───────────────────────────────────────────────────────────────
  it("T-E.End.5: end_auto_run({runId:'nonexistent'}) → returns {ok:false, error:{kind:'not_found'}}", async () => {
    // Given: empty sales.sqlite (no auto_runs rows); nonexistent runId provided
    // When:  makeEndAutoRunTool(tmpPath).execute({runId:'no-such-id', status:'completed', summary:'test summary here'})
    // Then:  returned envelope has ok=false AND error.kind === 'not_found';
    //        no row created in auto_runs
    const tmpPath = makeTmpPath();

    const mod = await import("../../../src/tools/sales/endAutoRun.js").catch(() => null);
    const makeEndAutoRunTool: AnyFn = mod?.makeEndAutoRunTool ?? null;
    if (!makeEndAutoRunTool) {
      assert.ok(false, "makeEndAutoRunTool not exported — Sketch C not built");
      return;
    }

    const tool = makeEndAutoRunTool(tmpPath);
    const result = await tool.execute({
      runId: "no-such-id-at-all",
      status: "completed",
      summary: "test summary here for length",
    });

    assert.ok(result.ok === false, `T-E.End.5: nonexistent runId must return ok=false; got: ${JSON.stringify(result)}`);
    assert.equal(
      result.error?.kind,
      "not_found",
      `T-E.End.5: error.kind must be 'not_found'; got: ${JSON.stringify(result.error)}`,
    );
  });
});
