/**
 * F-REN-3 Step 5 — Filled assertions: T-FREN3.8, T-FREN3.12, T-FREN3.13
 *
 * Covers:
 *   T-FREN3.8  — main.rs spawn_frondose_serve .env() calls emit FRONDOSE_AUTOUPDATE +
 *                FRONDOSE_SIDECAR_OWNER (no MAI_ remains); cargo check 0
 *   T-FREN3.12 — renderPlist + renderServerPlist with an EnvSnapshot containing
 *                FRONDOSE_MODEL emit <key>FRONDOSE_MODEL</key> NOT <key>MAI_MODEL</key>
 *   T-FREN3.13 — plist back-compat: legacy plist carrying MAI_MODEL is still read
 *                by frondoseEnv("MODEL") via the shim fallback
 *                (NOTE: T-FREN3.13 is structurally equivalent to T-FREN3.5 case 1 —
 *                the plist-injection scenario reduces to "MAI_MODEL set in env + FRONDOSE_MODEL
 *                unset → resolveModelSpec returns the MAI_ value". It is a separate test
 *                to explicitly name the plist-back-compat surface per plan §5(f).)
 *
 * Gate coverage:
 *   G-FREN3.rust-set  (T-FREN3.8)
 *   G-FREN3.plist-key (T-FREN3.12)
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
import type { EnvSnapshot, PlistArgs } from "../../src/cli/subcommands/launchd.js";
import { renderPlist } from "../../src/cli/subcommands/launchd.js";
import { renderServerPlist } from "../../src/cli/subcommands/serverLaunchd.js";

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

// ─── Plist args helper ────────────────────────────────────────────────────────

function makePlistArgs(envOverrides: Partial<EnvSnapshot> = {}): PlistArgs {
  const env: EnvSnapshot = {
    TELEGRAM_TOKEN: "tg-test-token",
    ...envOverrides,
  };
  return {
    nodeBin: "/usr/local/bin/node",
    maiEntry: "/usr/local/lib/node_modules/@kyoube/mai-agent/dist/cli/main.js",
    home: "/tmp/fakehome",
    env,
  };
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

// ─── T-FREN3.12 ───────────────────────────────────────────────────────────────

describe("launchd plist renderers — newly-rendered plist emits <key>FRONDOSE_MODEL</key> (G-FREN3.plist-key)", () => {
  it("T-FREN3.12 renderPlist: EnvSnapshot with FRONDOSE_MODEL='deepseek:v4-flash' produces XML with <key>FRONDOSE_MODEL</key> and NO <key>MAI_MODEL</key>", () => {
    // Given: EnvSnapshot { TELEGRAM_TOKEN: "abc", FRONDOSE_MODEL: "deepseek:v4-flash" }
    // When:  renderPlist(args) is called
    // Then:  XML contains <key>FRONDOSE_MODEL</key><string>deepseek:v4-flash</string>;
    //        XML does NOT contain <key>MAI_MODEL</key> anywhere

    const args = makePlistArgs({ FRONDOSE_MODEL: "deepseek:v4-flash" });
    const xml = renderPlist(args);

    assert.ok(
      xml.includes("<key>FRONDOSE_MODEL</key>"),
      `renderPlist XML must contain <key>FRONDOSE_MODEL</key>; got:\n${xml}`,
    );
    assert.ok(
      xml.includes("<string>deepseek:v4-flash</string>"),
      `renderPlist XML must contain <string>deepseek:v4-flash</string>; got:\n${xml}`,
    );
    assert.ok(
      !xml.includes("<key>MAI_MODEL</key>"),
      `renderPlist XML must NOT contain legacy <key>MAI_MODEL</key>; got:\n${xml}`,
    );
  });

  it("T-FREN3.12 renderServerPlist: EnvSnapshot with FRONDOSE_MODEL='deepseek:v4-flash' produces XML with <key>FRONDOSE_MODEL</key> and NO <key>MAI_MODEL</key>", () => {
    // Given: EnvSnapshot { TELEGRAM_TOKEN: "abc", FRONDOSE_MODEL: "deepseek:v4-flash" }
    // When:  renderServerPlist(args) is called
    // Then:  XML contains <key>FRONDOSE_MODEL</key><string>deepseek:v4-flash</string>;
    //        XML does NOT contain <key>MAI_MODEL</key> anywhere

    const args = makePlistArgs({ FRONDOSE_MODEL: "deepseek:v4-flash" });
    const xml = renderServerPlist(args);

    assert.ok(
      xml.includes("<key>FRONDOSE_MODEL</key>"),
      `renderServerPlist XML must contain <key>FRONDOSE_MODEL</key>; got:\n${xml}`,
    );
    assert.ok(
      xml.includes("<string>deepseek:v4-flash</string>"),
      `renderServerPlist XML must contain <string>deepseek:v4-flash</string>; got:\n${xml}`,
    );
    assert.ok(
      !xml.includes("<key>MAI_MODEL</key>"),
      `renderServerPlist XML must NOT contain legacy <key>MAI_MODEL</key>; got:\n${xml}`,
    );
  });
});

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
