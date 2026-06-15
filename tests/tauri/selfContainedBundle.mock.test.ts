/**
 * P-58d.3 Step 4a — T-Conf.1–3 — [scaffold-time; assertion bodies REAL]
 *
 * Mock / structural tests for the self-contained universal `.app` config contract.
 * No build is required — these parse the real config files on disk.
 *
 * T-Conf.1: tauri.conf.json has bundle.resources["../../../build/runtime/"] === "runtime/"
 *           → currently FAILS until builder F2 adds the resources map.
 * T-Conf.2: P-58d.1 updater no-regression (createUpdaterArtifacts + endpoints + pubkey + targets)
 *           → currently PASSES (regression guard; verifies F2 doesn't break P-58d.1 updater wiring).
 * T-Conf.3: package.json.version === tauri.conf.json.version (drift guard mirror of build-release CLR-3)
 *           → currently PASSES (regression guard; catches a missed Step-7 bump pre-release).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * Gate coverage:
 *   G-P58d3.2 (universal node + better_sqlite3.node) ↦ T-Conf.1
 *   G-P58d3.3 (updater swaps full bundle — no-regression) ↦ T-Conf.2
 *   G-P58d3.5 (no-bash / contract / version drift) ↦ T-Conf.3
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/tauri/selfContainedBundle.mock.test.ts
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Parse config files once at module level (no build required).
const tauriConf = JSON.parse(readFileSync(join(REPO, "src/tauri/src-tauri/tauri.conf.json"), "utf-8")) as {
  version?: string;
  bundle?: {
    active?: boolean;
    targets?: string[];
    createUpdaterArtifacts?: boolean;
    resources?: Record<string, string>;
  };
  plugins?: {
    updater?: {
      pubkey?: string;
      endpoints?: string[];
      dangerousInsecureTransportProtocol?: boolean;
    };
  };
};

const pkgJson = JSON.parse(readFileSync(join(REPO, "package.json"), "utf-8")) as { version: string };
const packageLock = JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf-8")) as {
  version?: string;
  packages?: Record<string, { version?: string }>;
};
const cargoToml = readFileSync(join(REPO, "src/tauri/src-tauri/Cargo.toml"), "utf-8");
const cargoLock = readFileSync(join(REPO, "src/tauri/src-tauri/Cargo.lock"), "utf-8");

function cargoTomlPackageVersion(): string {
  const packageSection = cargoToml.match(/\[package\][\s\S]*?(?:\n\[|$)/)?.[0] ?? "";
  const version = packageSection.match(/\nversion\s*=\s*"([^"]+)"/)?.[1];
  assert.ok(version, "Cargo.toml [package].version must be present");
  return version;
}

function cargoLockMaiTauriVersion(): string {
  const version = cargoLock.match(/\[\[package\]\]\s*\nname = "frondose"\s*\nversion = "([^"]+)"/)?.[1];
  assert.ok(version, 'Cargo.lock [[package]] name = "frondose" version must be present');
  return version;
}

// ─── P-58d.1 pubkey (key 28D6A7F5 — committed at P-58d.1, must not drift) ──────────────────────
// Decoded: `minisign public key: 28D6A7F52EFF86C0 / RWTA...`
const P58D1_PUBKEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDI4RDZBN0Y1MkVGRjg2QzAKUldUQWh2OHU5YWZXS09jSkN3VDFxWkhMMkFsNHl1VXkxNTBSUG8yVG9BWktGWjdHYXV3RmhQQlMK";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T-Conf.1 — bundle.resources copies assembled runtime into Contents/Resources/runtime/
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("tauri.conf.json bundle.resources — self-contained runtime bundling (G-P58d3.2)", () => {
  it('T-Conf.1: bundle.resources["../../../build/runtime/"] === "runtime/" (F2 required — FAILS pre-builder)', () => {
    // Given: tauri.conf.json (current checkout, F2 not yet applied)
    // When:  parsed
    // Then:  bundle.resources["../../../build/runtime/"] === "runtime/"
    //        (tauri-build copies $REPO_ROOT/build/runtime/ into Contents/Resources/runtime/
    //         so resolve_node/resolve_mai_bin can locate the bundled artifacts at runtime)
    //
    // Currently FAILS — bundle.resources is undefined until builder applies F2.
    // After F2 lands this becomes a regression guard.
    assert.ok(
      tauriConf.bundle?.resources != null,
      'bundle.resources must be defined (F2 not yet applied — add { "../../../build/runtime/": "runtime/" })',
    );
    assert.strictEqual(
      tauriConf.bundle?.resources?.["../../../build/runtime/"],
      "runtime/",
      'bundle.resources["../../../build/runtime/"] must equal "runtime/"',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T-Conf.2 — P-58d.1 updater no-regression (createUpdaterArtifacts + endpoints + pubkey + targets)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("tauri.conf.json updater contract — P-58d.1 no-regression (G-P58d3.3)", () => {
  it('T-Conf.2: createUpdaterArtifacts===true; endpoints points at local update-server; pubkey===28D6A7F5 string; targets includes "app"+"dmg"', () => {
    // Given: tauri.conf.json
    // When:  parsed
    // Then:  all four P-58d.1 updater invariants hold (with the P-58d endpoint baked in).

    // (a) createUpdaterArtifacts — controls .app.tar.gz + .sig emission
    assert.strictEqual(
      tauriConf.bundle?.createUpdaterArtifacts,
      true,
      "bundle.createUpdaterArtifacts must be true (P-58d.1 updater wiring)",
    );

    // (b) endpoints — Phase 12 (P-58d) wired the local update-server URL as
    // the baked-in default. Runtime override still flows through UpdaterExt
    // when config.json:updateServerUrl is set (run_update_check builds its
    // own updater with that URL); the baked-in value is the fallback for a
    // fresh install with no config.
    assert.deepStrictEqual(
      tauriConf.plugins?.updater?.endpoints,
      ["http://127.0.0.1:4875/latest.json"],
      "plugins.updater.endpoints must point at the local update-server (P-58d wiring)",
    );

    // (c) pubkey — must remain the P-58d.1 28D6A7F5 key (changing this would brick existing installs)
    assert.strictEqual(
      tauriConf.plugins?.updater?.pubkey,
      P58D1_PUBKEY,
      `plugins.updater.pubkey must be the P-58d.1 28D6A7F5 minisign public key (got: ${tauriConf.plugins?.updater?.pubkey?.slice(0, 40)}…)`,
    );

    // (d) targets — both "app" (updater artifacts) and "dmg" (installer) must remain
    const targets = tauriConf.bundle?.targets ?? [];
    assert.ok(targets.includes("app"), 'bundle.targets must include "app"');
    assert.ok(targets.includes("dmg"), 'bundle.targets must include "dmg"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T-Conf.3 — version drift guard (mirrors build-release.sh CLR-3 gate)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("version drift guard — package, lockfile, Tauri, and Cargo metadata align (G-P58d3.5)", () => {
  it("T-Conf.3: package.json, package-lock, tauri.conf.json, Cargo.toml, and Cargo.lock all share one version", () => {
    // Given: package.json, root package-lock fields, tauri.conf.json, Cargo.toml, and Cargo.lock.
    // When:  all release identity versions are compared.
    // Then:  they match package.json.version; same-version build:release output is validation-only until Step 7 bumps.
    //
    // P-66 expected-red before builder: package.json is 0.5.0-alpha.41 while package-lock is
    // 0.5.0-alpha.26 and Tauri/Cargo metadata are 0.5.0-alpha.33.
    const expected = pkgJson.version;
    const versions = {
      "package-lock.json.version": packageLock.version,
      'package-lock.json.packages[""].version': packageLock.packages?.[""]?.version,
      "tauri.conf.json.version": tauriConf.version,
      "Cargo.toml [package].version": cargoTomlPackageVersion(),
      "Cargo.lock mai-tauri version": cargoLockMaiTauriVersion(),
    };

    for (const [label, version] of Object.entries(versions)) {
      assert.strictEqual(version, expected, `${label} (${version}) must equal package.json.version (${expected})`);
    }
  });
});
