/**
 * P-SP-A mock tests — T-SP-A.DBHandle.1
 * _dbHandle.ts lifecycle: close-then-reopen returns fresh open handle (C2 fix).
 *
 * Guardian CONCERN-2: closeSalesDatabase(path) removes from salesDb.ts cache but
 * NOT from _dbHandle.ts cache — a subsequent getSalesDb(path) call would return
 * a stale closed handle causing "This database connection is not open" errors.
 * This test proves the C2 fix landed: after closeSalesDatabase, getSalesDb
 * returns a fresh, open handle.
 *
 * Step 5: assertion bodies filled.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeSalesDatabase } from "../../src/persistence/salesDb.js";
import { getSalesDb } from "../../src/tools/sales/_dbHandle.js";

describe("T-SP-A.DBHandle — _dbHandle.ts lifecycle (C2 double-cache fix)", () => {
  // ─── T-SP-A.DBHandle.1 ───────────────────────────────────────────────────────
  it("T-SP-A.DBHandle.1: closeSalesDatabase then getSalesDb returns a fresh open handle (not stale closed)", async () => {
    // Given: openSalesDatabase(':memory:') called once via getSalesDb — handle cached
    // When:  closeSalesDatabase(':memory:') called — removes from salesDb.ts cache
    //        then getSalesDb(':memory:') called again from tool layer
    // Then:  returned handle is OPEN (handle.open === true or equivalent);
    //        a simple SELECT 1 executes without throwing 'database connection is not open'

    // Step 1: Open a handle via getSalesDb (delegates to openSalesDatabase — caches in salesDb.ts)
    const handle1 = getSalesDb(":memory:");
    assert.ok(handle1.open, "Initial handle must be open");

    // Step 2: Close — removes from salesDb.ts cache
    closeSalesDatabase(":memory:");
    assert.ok(!handle1.open, "Handle must be closed after closeSalesDatabase");

    // Step 3: Re-open via getSalesDb — must return a FRESH, OPEN handle (not the stale closed one)
    const handle2 = getSalesDb(":memory:");
    assert.ok(
      handle2.open,
      "C2 fix: getSalesDb after closeSalesDatabase must return a fresh open handle",
    );

    // Step 4: Verify the new handle is actually usable (SELECT 1 does not throw)
    assert.doesNotThrow(
      () => handle2.prepare("SELECT 1 AS n").get(),
      "Fresh handle must execute queries without 'database connection is not open' error",
    );

    // Step 5: verify the schema was re-applied (V1 migration ran on fresh DB)
    const tables = handle2
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    assert.ok(
      tableNames.includes("raw_candidates"),
      "Fresh handle must have V1 schema (raw_candidates table present)",
    );

    // Cleanup
    closeSalesDatabase(":memory:");
  });
});
