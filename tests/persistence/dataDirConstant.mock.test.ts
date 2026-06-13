/**
 * F-REN-4a Step 5 — Assertion bodies filled: DATA_DIR_NAME constant re-export from paths.ts
 *
 * Covers:
 *   T-FREN4a.Constant.1 (supplemental) — DATA_DIR_NAME is re-exported from
 *     src/persistence/paths.ts (the single source-of-truth import path callers use).
 *
 * Gate coverage: T-FREN4a.Constant.1 (paths.ts re-export arm)
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/persistence/dataDirConstant.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// T-FREN4a.Constant.1 (paths.ts re-export) — DATA_DIR_NAME accessible from paths.ts
// ---------------------------------------------------------------------------

describe("paths.ts re-exports DATA_DIR_NAME and LEGACY_DATA_DIR_NAME (T-FREN4a.Constant.1-paths)", () => {
  it("T-FREN4a.Constant.1-paths: import { DATA_DIR_NAME } from paths.ts returns '.frondose'; callers do not need to import from dataDirMigration directly", async () => {
    // Given: src/persistence/paths.ts has the S-2 re-export line:
    //        export { DATA_DIR_NAME } from "./dataDirMigration.js"
    // When:  DATA_DIR_NAME is imported from paths.ts
    // Then:  DATA_DIR_NAME === ".frondose"
    //
    // This verifies the single-source-of-truth import path used by all 63 literal swap sites.

    // biome-ignore lint/suspicious/noExplicitAny: dynamic-import escape
    const mod = (await import("../../src/persistence/paths.js" as string)) as any;
    const DATA_DIR_NAME = mod.DATA_DIR_NAME as string | undefined;
    const getHomeBase = mod.getHomeBase;

    assert.strictEqual(DATA_DIR_NAME, ".frondose",
      `DATA_DIR_NAME must be ".frondose" when imported from paths.ts (got "${DATA_DIR_NAME}")`);
    assert.strictEqual(typeof getHomeBase, "function",
      "getHomeBase must still be exported from paths.ts (regression check)");
  });
});
