/**
 * P-AUTO-1+2 Step 3 — Test Scaffold (outside-in TDD, all assertions TODO/failing)
 * Covers: G-A2.Default — DEFAULT_AUTO_RUN_MAX_CONNECTS=5 applied to omitted caps;
 *         explicit null preserved as opt-out; cron default also 5.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/sales/startAutoRunDefault.mock.test.ts
 *
 * Builder seams required:
 *   - DEFAULT_AUTO_RUN_MAX_CONNECTS = 5 exported from src/persistence/sales/auto-run.ts
 *   - insertAutoRun({maxConnects:undefined}) → maxConnects=5 (not null)
 *   - insertAutoRun({maxConnects:null}) → maxConnects=null (explicit opt-out preserved)
 *   - start_auto_run({}) → maxConnects=5 (parsed.maxConnects===undefined → DEFAULT)
 *   - start_auto_run({maxConnects:null}) → maxConnects=null (explicit null preserved)
 *   - cron.ts requestedConnects: no [AUTO_CONNECTS] directive → passes DEFAULT_AUTO_RUN_MAX_CONNECTS
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: runtime resolution
type AnyFn = (...args: any[]) => any;

let openSalesDatabase: AnyFn;
let insertAutoRun: AnyFn;
let DEFAULT_AUTO_RUN_MAX_CONNECTS: number | undefined;

before(async () => {
  const dbMod = await import("../../../src/persistence/salesDb.js").catch(() => null);
  openSalesDatabase = dbMod?.openSalesDatabase ?? null;
  insertAutoRun = dbMod?.insertAutoRun ?? null;
  // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
  DEFAULT_AUTO_RUN_MAX_CONNECTS = (dbMod as any)?.DEFAULT_AUTO_RUN_MAX_CONNECTS ?? undefined;
});

function makeTmpPath(): string {
  return join(tmpdir(), `startAutoDefault-${randomUUID()}.sqlite`);
}

describe("G-A2.Default — DEFAULT_AUTO_RUN_MAX_CONNECTS=5 for omitted caps (P-AUTO-1+2)", () => {
  // ─── T-A2.Def.1 ───────────────────────────────────────────────────────────
  it("T-A2.Def.1: DEFAULT_AUTO_RUN_MAX_CONNECTS constant === 5 (exported from auto-run.ts)", async () => {
    // Given: src/persistence/sales/auto-run.ts exports DEFAULT_AUTO_RUN_MAX_CONNECTS
    // When:  the value is read
    // Then:  it equals 5 (the conservative default per §3.3)
    const dbMod = await import("../../../src/persistence/salesDb.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const val = (dbMod as any)?.DEFAULT_AUTO_RUN_MAX_CONNECTS;
    if (val === undefined) {
      assert.fail("T-A2.Def.1: DEFAULT_AUTO_RUN_MAX_CONNECTS not exported — builder must add it to auto-run.ts + re-export via salesDb.ts");
    }
    assert.equal(val, 5, `T-A2.Def.1: DEFAULT_AUTO_RUN_MAX_CONNECTS must be 5; got ${val}`);
  });

  // ─── T-A2.Def.2 ───────────────────────────────────────────────────────────
  it("T-A2.Def.2: insertAutoRun(db, {}) → maxConnects === 5 (omitted = DEFAULT, not null)", async () => {
    // Given: empty DB; insertAutoRun called with no maxConnects argument
    // When:  insertAutoRun(db, {}) called
    // Then:  returned row.maxConnects === 5 (today: null — must change)
    if (!openSalesDatabase || !insertAutoRun) {
      assert.fail("T-A2.Def.2: salesDb not importable");
    }
    const db = openSalesDatabase(makeTmpPath());
    const row = insertAutoRun(db, {});
    assert.equal(
      row.maxConnects,
      5,
      `T-A2.Def.2: insertAutoRun({}) must return maxConnects=5 (DEFAULT); got ${row.maxConnects}`,
    );
  });

  // ─── T-A2.Def.3 ───────────────────────────────────────────────────────────
  it("T-A2.Def.3: insertAutoRun(db, {maxConnects:undefined}) → maxConnects === 5 (explicit undefined = omitted = DEFAULT)", async () => {
    // Given: empty DB; insertAutoRun called with maxConnects=undefined
    // When:  insertAutoRun(db, {maxConnects:undefined}) called
    // Then:  returned row.maxConnects === 5 (same as omitted)
    if (!openSalesDatabase || !insertAutoRun) {
      assert.fail("T-A2.Def.3: salesDb not importable");
    }
    const db = openSalesDatabase(makeTmpPath());
    const row = insertAutoRun(db, { maxConnects: undefined });
    assert.equal(
      row.maxConnects,
      5,
      `T-A2.Def.3: insertAutoRun({maxConnects:undefined}) must return 5 (DEFAULT); got ${row.maxConnects}`,
    );
  });

  // ─── T-A2.Def.4 ───────────────────────────────────────────────────────────
  it("T-A2.Def.4: insertAutoRun(db, {maxConnects:null}) → maxConnects === null (explicit opt-out preserved)", async () => {
    // Given: empty DB; insertAutoRun called with explicit maxConnects=null (operator opts out of cap)
    // When:  insertAutoRun(db, {maxConnects:null}) called
    // Then:  returned row.maxConnects === null (explicit null MUST be preserved, not replaced by 5)
    if (!openSalesDatabase || !insertAutoRun) {
      assert.fail("T-A2.Def.4: salesDb not importable");
    }
    const db = openSalesDatabase(makeTmpPath());
    const row = insertAutoRun(db, { maxConnects: null });
    assert.equal(
      row.maxConnects,
      null,
      `T-A2.Def.4: insertAutoRun({maxConnects:null}) must preserve null; got ${row.maxConnects}`,
    );
  });

  // ─── T-A2.Def.5 ───────────────────────────────────────────────────────────
  it("T-A2.Def.5: start_auto_run tool execute({}) → maxConnects === 5 in the returned row", async () => {
    // Given: salesDbPath pointing to an empty DB
    //        start_auto_run called with no maxConnects (tool receives {})
    // When:  makeStartAutoRunTool(salesDbPath).execute({}) called
    // Then:  returned envelope ok=true; maxConnects === 5 (not null — today it is null)
    const salesDbPath = makeTmpPath();

    // We must open the DB first so the schema is ready
    if (!openSalesDatabase) {
      assert.fail("T-A2.Def.5: openSalesDatabase not importable");
    }
    openSalesDatabase(salesDbPath); // ensures schema

    const toolMod = await import("../../../src/tools/sales/startAutoRun.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeStartAutoRunTool: AnyFn = (toolMod as any)?.makeStartAutoRunTool ?? null;
    if (!makeStartAutoRunTool) {
      assert.fail("T-A2.Def.5: makeStartAutoRunTool not importable");
    }

    const tool = makeStartAutoRunTool(salesDbPath);
    // biome-ignore lint/suspicious/noExplicitAny: tool result shape
    const result: any = await tool.execute({});
    assert.ok(result.ok === true, `T-A2.Def.5: start_auto_run({}) must return ok=true; got: ${JSON.stringify(result)}`);
    // The tool returns {ok:true, command:'start_auto_run', data:{..., maxConnects}}
    // Must not use ?? here — null is a valid value (explicit opt-out); use direct property lookup
    const resultData = result.data ?? result;
    assert.equal(
      resultData.maxConnects,
      5,
      `T-A2.Def.5: maxConnects must be 5 (DEFAULT); got: ${JSON.stringify(result)}`,
    );
  });

  // ─── T-A2.Def.6 ───────────────────────────────────────────────────────────
  it("T-A2.Def.6: start_auto_run tool execute({maxConnects:null}) → maxConnects === null (explicit opt-out via tool)", async () => {
    // Given: salesDbPath pointing to an empty DB
    //        start_auto_run called with maxConnects=null (operator explicitly opts out)
    // When:  makeStartAutoRunTool(salesDbPath).execute({maxConnects:null}) called
    // Then:  returned envelope ok=true; maxConnects === null (explicit null preserved)
    const salesDbPath = makeTmpPath();
    if (!openSalesDatabase) {
      assert.fail("T-A2.Def.6: openSalesDatabase not importable");
    }
    openSalesDatabase(salesDbPath);

    const toolMod = await import("../../../src/tools/sales/startAutoRun.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeStartAutoRunTool: AnyFn = (toolMod as any)?.makeStartAutoRunTool ?? null;
    if (!makeStartAutoRunTool) {
      assert.fail("T-A2.Def.6: makeStartAutoRunTool not importable");
    }

    const tool = makeStartAutoRunTool(salesDbPath);
    // biome-ignore lint/suspicious/noExplicitAny: tool result shape
    const result: any = await tool.execute({ maxConnects: null });
    assert.ok(result.ok === true, `T-A2.Def.6: start_auto_run({maxConnects:null}) must return ok=true; got: ${JSON.stringify(result)}`);
    // The tool returns {ok:true, command:'start_auto_run', data:{..., maxConnects}}
    // Use explicit 'maxConnects' key lookup — null is falsy so ?? would skip it
    const data = result.data ?? result.value ?? result;
    assert.ok(
      Object.prototype.hasOwnProperty.call(data, "maxConnects"),
      `T-A2.Def.6: result must have a maxConnects field; got: ${JSON.stringify(result)}`,
    );
    assert.equal(
      data.maxConnects,
      null,
      `T-A2.Def.6: explicit null must be preserved; got: ${JSON.stringify(result)}`,
    );
  });

  // ─── T-A2.Def.7 ───────────────────────────────────────────────────────────
  it("T-A2.Def.7: insertAutoRun with explicit maxConnects=3 → maxConnects === 3 (non-default explicit value preserved)", async () => {
    // Given: empty DB; insertAutoRun called with maxConnects=3 (explicit non-null non-default)
    // When:  insertAutoRun(db, {maxConnects:3}) called
    // Then:  returned row.maxConnects === 3 (explicit value passed through unchanged)
    if (!openSalesDatabase || !insertAutoRun) {
      assert.fail("T-A2.Def.7: salesDb not importable");
    }
    const db = openSalesDatabase(makeTmpPath());
    const row = insertAutoRun(db, { maxConnects: 3 });
    assert.equal(
      row.maxConnects,
      3,
      `T-A2.Def.7: explicit maxConnects=3 must be preserved; got ${row.maxConnects}`,
    );
  });
});
