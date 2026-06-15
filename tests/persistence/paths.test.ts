/**
 * P-52 Step 4a scaffold — T-Paths.1 (G-P52.1).
 *
 * Failing-at-Step-4a scaffold for the NEW `src/persistence/paths.ts` helper
 * (plan §6.1). At Step 4a `getHomeBase()` does NOT yet exist — Codex creates
 * the module at Step 4b. The test imports the helper through a dynamic-import
 * sentinel pattern so the scaffold compiles cleanly even when the module is
 * absent. The assertion body is `assert.fail("TODO Step 5: …")` per
 * CLAUDE.md § Test Discipline; validator fills at Step 5.
 *
 * Gate coverage: G-P52.1 — `getHomeBase()` precedence + empty/whitespace fallback.
 *
 * Builder cue (Step 4b §6.1):
 *   export function getHomeBase(): string {
 *     const raw = process.env.MAI_HOME_BASE;
 *     return raw && raw.trim() !== "" ? raw : homedir();
 *   }
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, it } from "node:test";

// Dynamic import sentinel: `getHomeBase` is exported from a module that may
// not exist at Step 4a (Codex creates it at Step 4b). The sentinel pattern
// keeps the scaffold compileable — the cast suppresses the missing-module
// type error; at runtime it throws if the module/exports are not yet present.
async function getHomeBaseHelper(): Promise<() => string> {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic-import escape for Step-4a scaffolds
  const mod = (await import("../../src/persistence/paths.js" as string)) as any;
  return mod.getHomeBase as () => string;
}

// ─── T-Paths.1 ───────────────────────────────────────────────────────────────

describe("getHomeBase() precedence + empty/whitespace fallback (G-P52.1)", () => {
  it("T-Paths.1: when FRONDOSE_HOME_BASE is set to a non-empty value, getHomeBase()===that value; when unset or empty / whitespace-only, getHomeBase()===os.homedir() (BLOCKER-5 empty-string trap closed)", async () => {
    // Given: the exported `getHomeBase()` helper from `src/persistence/paths.ts`
    //        AND a saved snapshot of `process.env.FRONDOSE_HOME_BASE` (the test
    //        mutates the env between calls — restore in `finally`).
    // When:  the helper is called under four env states:
    //          (a) FRONDOSE_HOME_BASE = "/tmp/p52-a"   → "/tmp/p52-a"
    //          (b) FRONDOSE_HOME_BASE deleted           → os.homedir()
    //          (c) FRONDOSE_HOME_BASE = ""              → os.homedir() (Step-3b BLOCKER-5)
    //          (d) FRONDOSE_HOME_BASE = "   "           → os.homedir()
    // Then:  each call returns the expected value (per row above).
    //        Lazy-getter pattern: each call re-reads env, so mutating between
    //        calls within a single test is the correct verification surface.
    const priorEnv = process.env.FRONDOSE_HOME_BASE;
    const restore = (): void => {
      if (priorEnv === undefined) {
        delete process.env.FRONDOSE_HOME_BASE;
      } else {
        process.env.FRONDOSE_HOME_BASE = priorEnv;
      }
    };
    try {
      const getHomeBase = await getHomeBaseHelper();

      // (a) Set to a non-empty value → returned as-is.
      process.env.FRONDOSE_HOME_BASE = "/tmp/p52-a";
      assert.equal(getHomeBase(), "/tmp/p52-a", "FRONDOSE_HOME_BASE='/tmp/p52-a' → getHomeBase()==='/tmp/p52-a'");

      // (b) Deleted → fallback to homedir().
      delete process.env.FRONDOSE_HOME_BASE;
      assert.equal(getHomeBase(), homedir(), "FRONDOSE_HOME_BASE unset → getHomeBase()===os.homedir()");

      // (c) Empty string → fallback to homedir() (Step-3b BLOCKER-5 closed).
      process.env.FRONDOSE_HOME_BASE = "";
      assert.equal(
        getHomeBase(),
        homedir(),
        "FRONDOSE_HOME_BASE='' → getHomeBase()===os.homedir() (BLOCKER-5 empty-string trap closed)",
      );

      // (d) Whitespace-only → fallback to homedir().
      process.env.FRONDOSE_HOME_BASE = "   ";
      assert.equal(
        getHomeBase(),
        homedir(),
        "FRONDOSE_HOME_BASE='   ' → getHomeBase()===os.homedir() (whitespace-only trim fallback)",
      );

      // (e) Lazy-getter sanity: setting BACK to a non-empty value after the
      // empty/whitespace runs must observe the new value (proves each call re-reads env).
      process.env.FRONDOSE_HOME_BASE = "/tmp/p52-a-relset";
      assert.equal(
        getHomeBase(),
        "/tmp/p52-a-relset",
        "lazy-getter pattern: re-set FRONDOSE_HOME_BASE between calls is observed (no module-load-time caching)",
      );
    } finally {
      restore();
    }
  });
});
