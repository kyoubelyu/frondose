/**
 * P-AUTO-9 Step 3 — Test Scaffold — T-A9.State.1..9 (G-A9.1..9).
 * getAutoRunState: dense counters + connectsRemaining.
 *
 * All assertion bodies are TODO (will fail at assertion-TODO branch until Step 5).
 * Scaffolds compile and reach the assertion-TODO branch after builder Step 4.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/tools/sales/getAutoRunState.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: runtime resolution before builder Step 4
type AnyFn = (...args: any[]) => any;

function makeTmpPath(): string {
  return join(tmpdir(), `get-auto-run-state-test-${randomUUID()}.sqlite`);
}

/**
 * Helper: open a sales DB at tmpPath, insert a running auto_runs row, and
 * return { db, runId }. Uses openSalesDatabase so the schema migration runs.
 */
async function seedRunningAutoRun(
  tmpPath: string,
  opts: { maxConnects: number | null } = { maxConnects: 5 },
): Promise<{ db: any; runId: string }> {
  const { openSalesDatabase } = (await import("../../../src/persistence/salesDb.js")) as any;
  const db = openSalesDatabase(tmpPath);
  const runId = randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, now, null, 480, opts.maxConnects, "running", null, null);
  return { db, runId };
}

/**
 * Helper: insert `count` ledger rows with action_type='connect_sent' for the given run.
 * `results` is an array of result-strings; defaults to 'success'.
 */
function insertConnectSentRows(
  db: any,
  runId: string,
  count: number,
  results?: string[],
): void {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const result = results?.[i] ?? "success";
    db.prepare(
      "INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, result, ts) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(randomUUID(), runId, "connect_sent", null, result, now + i);
  }
}

describe("T-A9.State — get_auto_run_state: dense counters + connectsRemaining (P-AUTO-9)", () => {
  // ─── T-A9.State.1 ────────────────────────────────────────────────────────────
  it("T-A9.State.1: running run, no connects yet → connectsRemaining === maxConnects, counters.connect_sent === 0", async () => {
    // Given: auto_runs row with status='running', maxConnects=5; zero auto_run_ledger rows
    // When:  makeGetAutoRunStateTool(tmpPath).execute({}) is called
    // Then:  result.data.counters.connect_sent === 0 AND result.data.connectsRemaining === 5
    const tmpPath = makeTmpPath();
    const { seedRunningAutoRun: _seed } = { seedRunningAutoRun };
    await seedRunningAutoRun(tmpPath, { maxConnects: 5 });

    const mod = await import("../../../src/tools/sales/getAutoRunState.js").catch(() => null);
    const makeGetAutoRunStateTool: AnyFn = (mod as any)?.makeGetAutoRunStateTool ?? null;
    if (!makeGetAutoRunStateTool) {
      assert.ok(false, "T-A9.State.1: makeGetAutoRunStateTool not exported — builder Step 4 not done");
      return;
    }
    const tool = makeGetAutoRunStateTool(tmpPath);
    const result = await tool.execute({});

    assert.ok(result.ok === true, `T-A9.State.1: envelope must be ok=true; got: ${JSON.stringify(result)}`);
    assert.strictEqual(
      result.data.counters.connect_sent,
      0,
      "T-A9.State.1: counters.connect_sent must be 0 when ledger is empty",
    );
    assert.strictEqual(
      result.data.connectsRemaining,
      5,
      "T-A9.State.1: connectsRemaining must equal maxConnects (5) at run start",
    );
  });

  // ─── T-A9.State.2 ────────────────────────────────────────────────────────────
  it("T-A9.State.2: running run, maxConnects === null → connectsRemaining === null", async () => {
    // Given: auto_runs row with status='running', maxConnects=null (cap opt-out)
    // When:  makeGetAutoRunStateTool(tmpPath).execute({}) is called
    // Then:  result.data.connectsRemaining === null AND result.data.run.maxConnects === null
    const tmpPath = makeTmpPath();
    await seedRunningAutoRun(tmpPath, { maxConnects: null });

    const mod = await import("../../../src/tools/sales/getAutoRunState.js").catch(() => null);
    const makeGetAutoRunStateTool: AnyFn = (mod as any)?.makeGetAutoRunStateTool ?? null;
    if (!makeGetAutoRunStateTool) {
      assert.ok(false, "T-A9.State.2: makeGetAutoRunStateTool not exported");
      return;
    }
    const tool = makeGetAutoRunStateTool(tmpPath);
    const result = await tool.execute({});

    assert.ok(result.ok === true, `T-A9.State.2: ok must be true; got: ${JSON.stringify(result)}`);
    assert.strictEqual(
      result.data.connectsRemaining,
      null,
      "T-A9.State.2: connectsRemaining must be null when maxConnects is null",
    );
    assert.strictEqual(
      result.data.run.maxConnects,
      null,
      "T-A9.State.2: run.maxConnects must be null",
    );
  });

  // ─── T-A9.State.3 ────────────────────────────────────────────────────────────
  it("T-A9.State.3: cap exhausted (connect_sent === maxConnects) → connectsRemaining === 0", async () => {
    // Given: auto_runs row with status='running', maxConnects=5; exactly 5 ledger rows with action_type='connect_sent'
    // When:  makeGetAutoRunStateTool(tmpPath).execute({}) is called
    // Then:  result.data.counters.connect_sent === 5 AND result.data.connectsRemaining === 0
    const tmpPath = makeTmpPath();
    const { db, runId } = await seedRunningAutoRun(tmpPath, { maxConnects: 5 });
    insertConnectSentRows(db, runId, 5);

    const mod = await import("../../../src/tools/sales/getAutoRunState.js").catch(() => null);
    const makeGetAutoRunStateTool: AnyFn = (mod as any)?.makeGetAutoRunStateTool ?? null;
    if (!makeGetAutoRunStateTool) {
      assert.ok(false, "T-A9.State.3: makeGetAutoRunStateTool not exported");
      return;
    }
    const tool = makeGetAutoRunStateTool(tmpPath);
    const result = await tool.execute({});

    assert.ok(result.ok === true, `T-A9.State.3: ok must be true; got: ${JSON.stringify(result)}`);
    assert.strictEqual(
      result.data.counters.connect_sent,
      5,
      "T-A9.State.3: counters.connect_sent must be 5",
    );
    assert.strictEqual(
      result.data.connectsRemaining,
      0,
      "T-A9.State.3: connectsRemaining must be 0 when cap is exhausted",
    );
  });

  // ─── T-A9.State.4 ────────────────────────────────────────────────────────────
  it("T-A9.State.4: counters are densified — message_sent, follow_up_sent, comment_posted present as 0 when absent from ledger", async () => {
    // Given: auto_runs row with status='running'; ledger has only connect_sent rows (zero of the other 3 types)
    // When:  makeGetAutoRunStateTool(tmpPath).execute({}) is called
    // Then:  typeof result.data.counters.message_sent === 'number' AND === 0;
    //        same for follow_up_sent and comment_posted; all four densified keys present
    const tmpPath = makeTmpPath();
    const { db, runId } = await seedRunningAutoRun(tmpPath, { maxConnects: 5 });
    insertConnectSentRows(db, runId, 2);

    const mod = await import("../../../src/tools/sales/getAutoRunState.js").catch(() => null);
    const makeGetAutoRunStateTool: AnyFn = (mod as any)?.makeGetAutoRunStateTool ?? null;
    if (!makeGetAutoRunStateTool) {
      assert.ok(false, "T-A9.State.4: makeGetAutoRunStateTool not exported");
      return;
    }
    const tool = makeGetAutoRunStateTool(tmpPath);
    const result = await tool.execute({});

    assert.ok(result.ok === true, `T-A9.State.4: ok must be true; got: ${JSON.stringify(result)}`);
    const { counters } = result.data;
    assert.strictEqual(
      typeof counters.message_sent,
      "number",
      "T-A9.State.4: counters.message_sent must be a number",
    );
    assert.strictEqual(counters.message_sent, 0, "T-A9.State.4: counters.message_sent must be 0 (densified default)");
    assert.strictEqual(
      typeof counters.follow_up_sent,
      "number",
      "T-A9.State.4: counters.follow_up_sent must be a number",
    );
    assert.strictEqual(
      counters.follow_up_sent,
      0,
      "T-A9.State.4: counters.follow_up_sent must be 0 (densified default)",
    );
    assert.strictEqual(
      typeof counters.comment_posted,
      "number",
      "T-A9.State.4: counters.comment_posted must be a number",
    );
    assert.strictEqual(
      counters.comment_posted,
      0,
      "T-A9.State.4: counters.comment_posted must be 0 (densified default)",
    );
    // All four densified keys must be present
    const keys = Object.keys(counters);
    for (const k of ["connect_sent", "message_sent", "follow_up_sent", "comment_posted"]) {
      assert.ok(keys.includes(k), `T-A9.State.4: counters must include key '${k}'`);
    }
  });

  // ─── T-A9.State.5 ────────────────────────────────────────────────────────────
  it("T-A9.State.5: no running run → run === null, connectsRemaining === null, counters densified to zeros", async () => {
    // Given: no auto_runs row with status='running' (empty DB)
    // When:  makeGetAutoRunStateTool(tmpPath).execute({}) is called
    // Then:  result.data.run === null; result.data.connectsRemaining === null;
    //        result.data.counters has all 4 keys all equal to 0; result.data.dailyOutbound is populated
    const tmpPath = makeTmpPath();
    // Open the DB to apply schema migrations but do NOT insert any auto_runs row
    const { openSalesDatabase } = (await import("../../../src/persistence/salesDb.js")) as any;
    openSalesDatabase(tmpPath);

    const mod = await import("../../../src/tools/sales/getAutoRunState.js").catch(() => null);
    const makeGetAutoRunStateTool: AnyFn = (mod as any)?.makeGetAutoRunStateTool ?? null;
    if (!makeGetAutoRunStateTool) {
      assert.ok(false, "T-A9.State.5: makeGetAutoRunStateTool not exported");
      return;
    }
    const tool = makeGetAutoRunStateTool(tmpPath);
    const result = await tool.execute({});

    assert.ok(result.ok === true, `T-A9.State.5: ok must be true; got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.data.run, null, "T-A9.State.5: run must be null when no active run");
    assert.strictEqual(
      result.data.connectsRemaining,
      null,
      "T-A9.State.5: connectsRemaining must be null when no run is active",
    );
    const { counters } = result.data;
    for (const k of ["connect_sent", "message_sent", "follow_up_sent", "comment_posted"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(counters, k), `T-A9.State.5: counters must have key '${k}'`);
      assert.strictEqual(counters[k], 0, `T-A9.State.5: counters.${k} must be 0 in no-run branch`);
    }
    assert.ok(
      result.data.dailyOutbound !== undefined && result.data.dailyOutbound !== null,
      "T-A9.State.5: dailyOutbound must still be populated in no-run branch",
    );
  });

  // ─── T-A9.State.6 ────────────────────────────────────────────────────────────
  // P-AUTO-13 UPDATE (Step 3, 2026-06-15): connectsRemaining now uses success-only count.
  // BEFORE P-AUTO-13: connectsRemaining used all-rows (countAutoLedgerByAction), so 3 mixed
  //   rows (1 success + 1 failed + 1 skipped) → connectsRemaining = maxConnects - 3 = 0.
  // AFTER P-AUTO-13: connectsRemaining uses countSuccessfulConnects (success rows only),
  //   so 3 mixed rows with 1 success → connectsRemaining = maxConnects - 1 = 2.
  // counters.connect_sent remains all-rows (densified view for the end_auto_run summary).
  // This is the P-AUTO-13 §4a BLOCKER fix: guard-rejected/failed connect rows do NOT consume
  // the connect budget.
  it("T-A9.State.6: mixed-result rows — connectsRemaining counts ONLY success rows; counters.connect_sent counts all rows", async () => {
    // Given: auto_runs row with status='running', maxConnects=3;
    //        3 ledger rows: one connect_sent/success, one connect_sent/failed, one connect_sent/skipped
    // When:  makeGetAutoRunStateTool(tmpPath).execute({}) is called
    // Then:  result.data.counters.connect_sent === 3 (all-rows densified view for the summary)
    //        AND result.data.connectsRemaining === 2 (maxConnects=3 - 1 success = 2)
    //        NOT connectsRemaining===0 (the old all-rows formula — WRONG after P-AUTO-13)
    const tmpPath = makeTmpPath();
    const { db, runId } = await seedRunningAutoRun(tmpPath, { maxConnects: 3 });
    insertConnectSentRows(db, runId, 3, ["success", "failed", "skipped"]);

    const mod = await import("../../../src/tools/sales/getAutoRunState.js").catch(() => null);
    const makeGetAutoRunStateTool: AnyFn = (mod as any)?.makeGetAutoRunStateTool ?? null;
    if (!makeGetAutoRunStateTool) {
      assert.ok(false, "T-A9.State.6: makeGetAutoRunStateTool not exported");
      return;
    }
    const tool = makeGetAutoRunStateTool(tmpPath);
    const result = await tool.execute({});

    assert.ok(result.ok === true, `T-A9.State.6: ok must be true; got: ${JSON.stringify(result)}`);
    assert.strictEqual(
      result.data.counters.connect_sent,
      3,
      "T-A9.State.6: counters.connect_sent must count ALL rows regardless of result (densified all-rows view for summary)",
    );
    // P-AUTO-13: connectsRemaining uses SUCCESS-ONLY count (not all-rows).
    // 1 success row → connectsRemaining = maxConnects(3) - successCount(1) = 2.
    assert.strictEqual(
      result.data.connectsRemaining,
      2,
      "T-A9.State.6 (P-AUTO-13): connectsRemaining must be 2 (maxConnects=3, 1 success row); " +
        "skipped/failed rows must NOT consume the connect budget",
    );
  });

  // ─── T-A9.State.7 ────────────────────────────────────────────────────────────
  it("T-A9.State.7: overflow defense — ledger has more connect_sent rows than maxConnects → connectsRemaining clamped to 0, never negative", async () => {
    // Given: auto_runs row with status='running', maxConnects=2; 3 connect_sent ledger rows
    // When:  makeGetAutoRunStateTool(tmpPath).execute({}) is called
    // Then:  result.data.connectsRemaining === 0 (not -1)
    const tmpPath = makeTmpPath();
    const { db, runId } = await seedRunningAutoRun(tmpPath, { maxConnects: 2 });
    insertConnectSentRows(db, runId, 3);

    const mod = await import("../../../src/tools/sales/getAutoRunState.js").catch(() => null);
    const makeGetAutoRunStateTool: AnyFn = (mod as any)?.makeGetAutoRunStateTool ?? null;
    if (!makeGetAutoRunStateTool) {
      assert.ok(false, "T-A9.State.7: makeGetAutoRunStateTool not exported");
      return;
    }
    const tool = makeGetAutoRunStateTool(tmpPath);
    const result = await tool.execute({});

    assert.ok(result.ok === true, `T-A9.State.7: ok must be true; got: ${JSON.stringify(result)}`);
    assert.strictEqual(
      result.data.connectsRemaining,
      0,
      "T-A9.State.7: connectsRemaining must be clamped to 0 (Math.max(0,...)) not -1",
    );
  });

  // ─── T-A9.State.8 ────────────────────────────────────────────────────────────
  it("T-A9.State.8: return-shape stability — both run===null and run!==null branches expose the same top-level keys", async () => {
    // Given: two calls — one with a running run, one against an empty DB
    // When:  makeGetAutoRunStateTool.execute({}) called for each
    // Then:  both result.data objects have exactly the keys {run, counters, connectsRemaining, dailyOutbound}
    const tmpPathWithRun = makeTmpPath();
    await seedRunningAutoRun(tmpPathWithRun, { maxConnects: 5 });

    const tmpPathNoRun = makeTmpPath();
    const { openSalesDatabase } = (await import("../../../src/persistence/salesDb.js")) as any;
    openSalesDatabase(tmpPathNoRun);

    const mod = await import("../../../src/tools/sales/getAutoRunState.js").catch(() => null);
    const makeGetAutoRunStateTool: AnyFn = (mod as any)?.makeGetAutoRunStateTool ?? null;
    if (!makeGetAutoRunStateTool) {
      assert.ok(false, "T-A9.State.8: makeGetAutoRunStateTool not exported");
      return;
    }

    const resultWithRun = await makeGetAutoRunStateTool(tmpPathWithRun).execute({});
    const resultNoRun = await makeGetAutoRunStateTool(tmpPathNoRun).execute({});

    assert.ok(resultWithRun.ok === true, "T-A9.State.8: run-present call must be ok");
    assert.ok(resultNoRun.ok === true, "T-A9.State.8: no-run call must be ok");

    const EXPECTED_KEYS = ["run", "counters", "connectsRemaining", "dailyOutbound"].sort();
    const keysWithRun = Object.keys(resultWithRun.data).sort();
    const keysNoRun = Object.keys(resultNoRun.data).sort();

    assert.deepStrictEqual(
      keysWithRun,
      EXPECTED_KEYS,
      `T-A9.State.8: run-present result.data must have keys ${EXPECTED_KEYS}; got ${keysWithRun}`,
    );
    assert.deepStrictEqual(
      keysNoRun,
      EXPECTED_KEYS,
      `T-A9.State.8: no-run result.data must have keys ${EXPECTED_KEYS}; got ${keysNoRun}`,
    );
  });

  // ─── T-A9.State.9 ────────────────────────────────────────────────────────────
  it("T-A9.State.9: dailyOutbound and run payload unchanged from prior behavior", async () => {
    // Given: a running auto_runs row
    // When:  makeGetAutoRunStateTool(tmpPath).execute({}) is called
    // Then:  result.data.dailyOutbound has all 7 expected keys
    //        {usedToday, cap, remaining, lastOutboundAt, cooldownMs, cooldownActive, cooldownRemainingMs};
    //        result.data.run contains id, status, started_at (or equivalent columns)
    const tmpPath = makeTmpPath();
    const { runId } = await seedRunningAutoRun(tmpPath, { maxConnects: 5 });

    const mod = await import("../../../src/tools/sales/getAutoRunState.js").catch(() => null);
    const makeGetAutoRunStateTool: AnyFn = (mod as any)?.makeGetAutoRunStateTool ?? null;
    if (!makeGetAutoRunStateTool) {
      assert.ok(false, "T-A9.State.9: makeGetAutoRunStateTool not exported");
      return;
    }
    const tool = makeGetAutoRunStateTool(tmpPath);
    const result = await tool.execute({});

    assert.ok(result.ok === true, `T-A9.State.9: ok must be true; got: ${JSON.stringify(result)}`);

    // dailyOutbound shape unchanged
    const { dailyOutbound } = result.data;
    for (const k of ["usedToday", "cap", "remaining", "lastOutboundAt", "cooldownMs", "cooldownActive", "cooldownRemainingMs"]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(dailyOutbound, k),
        `T-A9.State.9: dailyOutbound must have key '${k}'`,
      );
    }

    // run payload still carries essential columns
    const { run } = result.data;
    assert.ok(run !== null, "T-A9.State.9: run must not be null");
    assert.strictEqual(run.id, runId, "T-A9.State.9: run.id must match seeded runId");
    assert.strictEqual(run.status, "running", "T-A9.State.9: run.status must be 'running'");
    assert.ok(typeof run.started_at === "number" || typeof run.startedAt === "number",
      "T-A9.State.9: run must carry started_at (or startedAt) as a number",
    );
  });
});
