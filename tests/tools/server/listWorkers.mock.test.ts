/**
 * P-25 Step 5 — T-SRV.LIST.1..2 (UPDATED at P-26 Step 5)
 *
 * Originally tested the P-25 stub. Updated to use the P-26 real implementation API:
 * - `listWorkersTool` singleton export removed (P-26 uses factory pattern only)
 * - `makeListWorkersTool(workersDb: DB | null)` now requires a DB argument
 *
 * Full P-26 coverage is in tests/tools/listWorkers.real.mock.test.ts (T-LW.1..3).
 * These P-25 tests verify the same contract under the new API.
 * Gate coverage: G-P25.6 (superseded by G-P26.22)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeListWorkersTool } from "../../../src/tools/server/listWorkers.js";

// ─── T-SRV.LIST ───────────────────────────────────────────────────────────────

describe("list_workers tool (G-P25.6, updated P-26)", () => {
  it("T-SRV.LIST.1: makeListWorkersTool(null).execute({}) returns {workers:[], note:'workers.sqlite not yet initialized'}", async () => {
    // Given: makeListWorkersTool(null) — null-guard path for server boot before workers registered
    // When:  execute({}, {}) called
    // Then:  returns { workers: [], note: "workers.sqlite not yet initialized" } (P-26 null-guard behavior)
    const tool = makeListWorkersTool(null);
    // biome-ignore lint/suspicious/noExplicitAny: test call needs to invoke execute
    const result = await (tool as any).execute({}, {});
    assert.deepEqual(result, {
      workers: [],
      note: "workers.sqlite not yet initialized",
    });
  });

  it("T-SRV.LIST.2: makeListWorkersTool(null) returns a tool with an execute function", () => {
    // Given: makeListWorkersTool(null) called
    // When:  result inspected
    // Then:  result has an execute function (P-26 returns Tool, not ToolSet)
    const tool = makeListWorkersTool(null);
    assert.ok(typeof (tool as { execute?: unknown }).execute === "function",
      "makeListWorkersTool(null) must return a tool with execute function");
  });
});
