/**
 * F-REN-3 Step 5 — Filled assertions: T-FREN3.8, T-FREN3.13
 * (T-FREN3.12 — the launchd plist renderers — retired with the CLI launchd
 * vertical: src/cli/subcommands/launchd.ts + serverLaunchd.ts are deleted per
 * the P-OPEN-SOURCE-SPLIT ledger.)
 *
 * Covers:
 *   T-FREN3.8  — main.rs spawn_frondose_serve .env() calls emit FRONDOSE_AUTOUPDATE +
 *                FRONDOSE_SIDECAR_OWNER (no MAI_ remains); cargo check 0
 *   T-FREN3.13 — plist back-compat: legacy plist carrying MAI_MODEL is no longer
 *                honored — resolveModelSpec falls back to DEFAULT_MODEL_SPEC
 *
 * Gate coverage:
 *   G-FREN3.rust-set  (T-FREN3.8)
 *   G-FREN3.plist-back-compat (T-FREN3.13)
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/contract/fren3-plist-and-rust.mock.test.ts
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_MODEL_SPEC, resolveModelSpec } from "../../src/agent/modelResolver.js";

const REPO = resolve(process.cwd());
// CH-3 module split (2026-06-18): spawn_frondose_serve moved from main.rs to sidecar.rs
// as a pure move. Concatenate all *.rs files in the crate so T-FREN3.8 finds the body.
const CRATE_SRC_DIR = resolve(REPO, "src/tauri/src-tauri/src");
const MAIN_RS = readdirSync(CRATE_SRC_DIR)
  .filter((f) => f.endsWith(".rs"))
  .sort()
  .map((f) => readFileSync(resolve(CRATE_SRC_DIR, f), "utf8"))
  .join("\n");

// ─── Rust source helpers ──────────────────────────────────────────────────────

/** Extract spawn_frondose_serve body (ends at Ok(child) + closing brace). */
function spawnMaiServeSource(): string {
  const match = MAIN_RS.match(/async fn spawn_frondose_serve[\s\S]*?Ok\(child\)\s*\n}/);
  assert.ok(match, "main.rs must contain spawn_frondose_serve");
  return match[0];
}

// ─── env save/restore helper ──────────────────────────────────────────────────

function saveEnv(...keys: string[]): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  };
}

// ─── T-FREN3.8 ────────────────────────────────────────────────────────────────

describe("Rust SET sites — spawn_frondose_serve emits FRONDOSE_* env-var names after Group B rename (G-FREN3.rust-set)", () => {
  it("T-FREN3.8: main.rs spawn_frondose_serve sets FRONDOSE_AUTOUPDATE + FRONDOSE_SIDECAR_OWNER; no MAI_AUTOUPDATE / MAI_SIDECAR_OWNER remains in spawn body", () => {
    // Given: src/tauri/src-tauri/src/main.rs after Group B Rust SET rename
    // When:  spawn_frondose_serve function body is extracted and scanned
    // Then:  .env("FRONDOSE_AUTOUPDATE", "skip") present;
    //        .env("FRONDOSE_SIDECAR_OWNER", "frondose-app") present;
    //        .env("MAI_AUTOUPDATE"...) absent;
    //        .env("MAI_SIDECAR_OWNER"...) absent

    const spawnBody = spawnMaiServeSource();

    assert.match(
      spawnBody,
      /\.env\s*\(\s*"FRONDOSE_AUTOUPDATE"\s*,\s*"skip"\s*\)/,
      'spawn_frondose_serve must set .env("FRONDOSE_AUTOUPDATE", "skip")',
    );
    assert.match(
      spawnBody,
      /\.env\s*\(\s*"FRONDOSE_SIDECAR_OWNER"\s*,\s*"frondose-app"\s*\)/,
      'spawn_frondose_serve must set .env("FRONDOSE_SIDECAR_OWNER", "frondose-app")',
    );
    assert.doesNotMatch(
      spawnBody,
      /\.env\s*\(\s*"MAI_AUTOUPDATE"/,
      'spawn_frondose_serve must NOT contain legacy .env("MAI_AUTOUPDATE"...)',
    );
    assert.doesNotMatch(
      spawnBody,
      /\.env\s*\(\s*"MAI_SIDECAR_OWNER"/,
      'spawn_frondose_serve must NOT contain legacy .env("MAI_SIDECAR_OWNER"...)',
    );
  });
});

// ─── T-FREN3.12 ─── RETIRED with the CLI launchd vertical ────────────────────
// (src/cli/subcommands/launchd.ts + serverLaunchd.ts are deleted per the
// P-OPEN-SOURCE-SPLIT ledger; the App is Tauri-managed, no plist renderer.)

// ─── T-FREN3.13 ───────────────────────────────────────────────────────────────

describe("plist shim REMOVED — legacy <key>MAI_MODEL</key> from an existing on-disk plist is no longer honored (F-REN-4e shim removal)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = saveEnv("MAI_MODEL", "FRONDOSE_MODEL");
  });
  afterEach(() => restore());

  it("T-FREN3.13: when daemon env carries MAI_MODEL='deepseek:legacy-installed' (from old plist) + FRONDOSE_MODEL unset, resolveModelSpec({}) returns DEFAULT_MODEL_SPEC (shim removed F-REN-4e — operator must update plist to FRONDOSE_MODEL)", () => {
    // Given: process.env.MAI_MODEL = "deepseek:legacy-installed" (simulates launchd injecting
    //        the legacy plist key into the daemon's process env); FRONDOSE_MODEL unset
    // When:  resolveModelSpec({}) is called (reads frondoseEnv("MODEL") = FRONDOSE_MODEL only)
    // Then:  returns DEFAULT_MODEL_SPEC — MAI_MODEL is no longer consulted (shim gone F-REN-4e);
    //        operator must update plist from MAI_MODEL → FRONDOSE_MODEL key

    delete process.env.FRONDOSE_MODEL;
    process.env.MAI_MODEL = "deepseek:legacy-installed";

    assert.equal(resolveModelSpec({}), DEFAULT_MODEL_SPEC);
  });
});
