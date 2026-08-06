/**
 * P-AUTO-8 — selectSystemForTurn pure helper unit tests
 *
 * Covers the 3 routing branches of selectSystemForTurn in isolation.
 * selectSystemForTurn is a pure function (no side effects, no imports that
 * touch the file system at runtime) so no module mocks are required.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=15000 \
 *     tests/cli/subcommands/serve/selectSystem.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServeDeps, ServeState } from "../../../../src/app/backend/context.js";
import { selectSystemForTurn } from "../../../../src/app/backend/turn/selectSystem.js";

// ── Minimal stub factory ──────────────────────────────────────────────────────

/**
 * Minimal ServeDeps stub for selectSystemForTurn: only system, systemResume,
 * and composeOperatorSystem are accessed by the helper. Cast to ServeDeps so
 * the rest of the interface is not a compile burden.
 */
function makeMinimalDeps(overrides?: {
  system?: string;
  systemResume?: string;
  composeOperatorSystem?: (mode: string) => string;
}): ServeDeps {
  return {
    system: overrides?.system ?? "band-only-system",
    systemResume: overrides?.systemResume ?? "system-resume-with-fragment",
    composeOperatorSystem: overrides?.composeOperatorSystem ?? ((mode: string) => `<OPERATOR:${mode}>`),
  } as unknown as ServeDeps;
}

/**
 * Minimal ServeState stub: only cronEnabled and passiveEnabled are accessed
 * by modeFromState inside the helper's operator branch.
 */
function makeMinimalState(cronEnabled: boolean, passiveEnabled: boolean): ServeState {
  return { cronEnabled, passiveEnabled } as unknown as ServeState;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("selectSystemForTurn — 3-branch routing", () => {
  it("T-SelectSys.1: when isWorkflowResume=true, returns deps.systemResume (exact reference)", () => {
    // Given: deps with a distinct systemResume value; args.isWorkflowResume=true.
    // When:  selectSystemForTurn called.
    // Then:  returns deps.systemResume by exact reference (resume branch wins over all others).
    const deps = makeMinimalDeps({ systemResume: "RESUME_SYSTEM_STRING" });
    const state = makeMinimalState(false, false);

    const result = selectSystemForTurn({ isWorkflowResume: true, isCronTurn: false }, state, deps);

    assert.strictEqual(
      result,
      deps.systemResume,
      "isWorkflowResume=true must return deps.systemResume by exact reference",
    );
    assert.strictEqual(result, "RESUME_SYSTEM_STRING");
  });

  it("T-SelectSys.2: when isCronTurn=true (and isWorkflowResume=false), returns deps.system (exact reference)", () => {
    // Given: deps with a distinct system value; args.isWorkflowResume=false, args.isCronTurn=true.
    // When:  selectSystemForTurn called.
    // Then:  returns deps.system by exact reference (cron branch; no per-turn fragment appended).
    const deps = makeMinimalDeps({ system: "BAND_ONLY_SYSTEM" });
    const state = makeMinimalState(true, false);

    const result = selectSystemForTurn({ isWorkflowResume: false, isCronTurn: true }, state, deps);

    assert.strictEqual(result, deps.system, "isCronTurn=true must return deps.system by exact reference");
    assert.strictEqual(result, "BAND_ONLY_SYSTEM");
  });

  it("T-SelectSys.2b: when isWorkflowResume=true AND isCronTurn=true, resume wins (isWorkflowResume takes priority)", () => {
    // Given: both flags true.
    // When:  selectSystemForTurn called.
    // Then:  returns deps.systemResume (resume branch is the first if-check in the helper).
    const deps = makeMinimalDeps({
      system: "BAND_ONLY",
      systemResume: "RESUME_WIN",
    });
    const state = makeMinimalState(true, false);

    const result = selectSystemForTurn({ isWorkflowResume: true, isCronTurn: true }, state, deps);

    assert.strictEqual(result, deps.systemResume, "isWorkflowResume takes priority over isCronTurn");
  });

  describe("operator branch — calls composeOperatorSystem(modeFromState(state))", () => {
    it("T-SelectSys.3a: operator turn, state=manual (cronEnabled=false, passiveEnabled=false) → composeOperatorSystem('manual')", () => {
      // Given: both flags off → modeFromState returns "manual".
      // When:  selectSystemForTurn with isWorkflowResume=false, isCronTurn=false.
      // Then:  returns the string produced by deps.composeOperatorSystem("manual").
      const capturedMode: string[] = [];
      const deps = makeMinimalDeps({
        composeOperatorSystem: (mode: string) => {
          capturedMode.push(mode);
          return `<SYS:${mode}>`;
        },
      });
      const state = makeMinimalState(false, false);

      const result = selectSystemForTurn({ isWorkflowResume: false, isCronTurn: false }, state, deps);

      assert.deepEqual(capturedMode, ["manual"], "composeOperatorSystem must be called with mode='manual'");
      assert.strictEqual(result, "<SYS:manual>");
    });

    it("T-SelectSys.3b: operator turn, state=magical (cronEnabled=false, passiveEnabled=true) → composeOperatorSystem('magical')", () => {
      // Given: passiveEnabled=true, cronEnabled=false → modeFromState returns "magical".
      // When:  selectSystemForTurn with isWorkflowResume=false, isCronTurn=false.
      // Then:  returns the string produced by deps.composeOperatorSystem("magical").
      const capturedMode: string[] = [];
      const deps = makeMinimalDeps({
        composeOperatorSystem: (mode: string) => {
          capturedMode.push(mode);
          return `<SYS:${mode}>`;
        },
      });
      const state = makeMinimalState(false, true);

      const result = selectSystemForTurn({ isWorkflowResume: false, isCronTurn: false }, state, deps);

      assert.deepEqual(capturedMode, ["magical"], "composeOperatorSystem must be called with mode='magical'");
      assert.strictEqual(result, "<SYS:magical>");
    });

    it("T-SelectSys.3c: operator turn, state=auto (cronEnabled=true, passiveEnabled=false) → composeOperatorSystem('auto')", () => {
      // Given: cronEnabled=true → modeFromState returns "auto" (cron wins over passive).
      // When:  selectSystemForTurn with isWorkflowResume=false, isCronTurn=false.
      // Then:  returns the string produced by deps.composeOperatorSystem("auto").
      const capturedMode: string[] = [];
      const deps = makeMinimalDeps({
        composeOperatorSystem: (mode: string) => {
          capturedMode.push(mode);
          return `<SYS:${mode}>`;
        },
      });
      const state = makeMinimalState(true, false);

      const result = selectSystemForTurn({ isWorkflowResume: false, isCronTurn: false }, state, deps);

      assert.deepEqual(capturedMode, ["auto"], "composeOperatorSystem must be called with mode='auto'");
      assert.strictEqual(result, "<SYS:auto>");
    });

    it("T-SelectSys.3d: operator turn, state=cron-wins (cronEnabled=true, passiveEnabled=true) → composeOperatorSystem('auto')", () => {
      // Given: both flags true → modeFromState returns "auto" (cron wins over passive).
      // When:  selectSystemForTurn with isWorkflowResume=false, isCronTurn=false.
      // Then:  returns composeOperatorSystem("auto") — not "magical" (cron-over-passive precedence).
      const capturedMode: string[] = [];
      const deps = makeMinimalDeps({
        composeOperatorSystem: (mode: string) => {
          capturedMode.push(mode);
          return `<SYS:${mode}>`;
        },
      });
      const state = makeMinimalState(true, true);

      const result = selectSystemForTurn({ isWorkflowResume: false, isCronTurn: false }, state, deps);

      assert.deepEqual(
        capturedMode,
        ["auto"],
        "cronEnabled=true wins over passiveEnabled=true — must call composeOperatorSystem('auto')",
      );
      assert.strictEqual(result, "<SYS:auto>");
      assert.notStrictEqual(result, "<SYS:magical>", "must NOT return magical when cron wins");
    });
  });
});
