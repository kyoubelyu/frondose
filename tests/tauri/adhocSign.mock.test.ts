/**
 * P-58d.4 Step 4a — T-Conf.1–2 — Track 2: Ad-hoc signing + headless DMG
 *
 * Mock / structural tests for the ad-hoc signing config contract.
 * No build required — these parse the real config files on disk.
 *
 * T-Conf.1: bundle.macOS.signingIdentity === "-" AND bundle.macOS.hardenedRuntime === false
 *           → currently FAILS until builder F1 adds the bundle.macOS block to tauri.conf.json.
 *           → [3b CMR-1] enforces the CANONICAL schema casing "macOS" (capital OS), not "macos".
 *             Tauri 2.9.2 accepts "macos" as a serde alias, but using the non-canonical form
 *             is config drift — this assertion guards against it.
 * T-Conf.2: No-regression guard — P-58d.1 updater contract + P-58d.3 self-containment intact.
 *           createUpdaterArtifacts===true, resources["../../../build/runtime/"]==="runtime/",
 *           targets includes "app"+"dmg", pubkey===28D6A7F5 string, endpoints deep-equals [].
 *           → currently PASSES (regression guard; must still pass after F1 adds bundle.macOS).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * Gate coverage:
 *   C-2 (artifacts run on arm64) ↦ T-Conf.1  (ad-hoc signing config)
 *   No-regression (P-58d.1 updater + P-58d.3 self-containment) ↦ T-Conf.2
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/tauri/adhocSign.mock.test.ts
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Parse tauri.conf.json once at module level (no build required).
const tauriConf = JSON.parse(readFileSync(join(REPO, "src/tauri/src-tauri/tauri.conf.json"), "utf-8")) as {
  version?: string;
  bundle?: {
    active?: boolean;
    targets?: string[];
    createUpdaterArtifacts?: boolean;
    macOS?: {
      signingIdentity?: string | null;
      hardenedRuntime?: boolean;
    };
    resources?: Record<string, string>;
    icon?: string[];
  };
  plugins?: {
    updater?: {
      pubkey?: string;
      endpoints?: string[];
      dangerousInsecureTransportProtocol?: boolean;
    };
  };
};

// ─── P-58d.1 pubkey (key 28D6A7F5 — committed at P-58d.1, must not drift) ──────────────────────
// Decoded: `minisign public key: 28D6A7F52EFF86C0 / RWTA...`
const P58D1_PUBKEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDI4RDZBN0Y1MkVGRjg2QzAKUldUQWh2OHU5YWZXS09jSkN3VDFxWkhMMkFsNHl1VXkxNTBSUG8yVG9BWktGWjdHYXV3RmhQQlMK";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T-Conf.1 — bundle.macOS ad-hoc signing config (C-2)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("tauri.conf.json bundle.macOS — ad-hoc signing config (C-2, G-P58d4-C2)", () => {
  it('T-Conf.1: bundle.macOS.signingIdentity === "-" AND bundle.macOS.hardenedRuntime === false (F1 required — FAILS pre-builder)', () => {
    // Given: tauri.conf.json (current checkout, F1 not yet applied)
    // When:  parsed
    // Then:  bundle.macOS.signingIdentity === "-" AND bundle.macOS.hardenedRuntime === false
    //        using the canonical schema key "macOS" (capital OS — [3b CMR-1])
    //
    // Currently FAILS — bundle.macOS is undefined until builder applies F1.
    // After F1 lands this becomes a regression guard for:
    //   - ad-hoc signing (Tauri calls `codesign -s -` during tauri build)
    //   - hardenedRuntime disabled (unsigned bundled addons can load: better_sqlite3.node, cgevent.node)
    assert.ok(
      tauriConf.bundle?.macOS != null,
      'bundle.macOS must be defined (F1 not yet applied — add { "signingIdentity": "-", "hardenedRuntime": false }). ' +
        "[3b CMR-1]: use the canonical schema casing 'macOS' (capital OS), not 'macos'.",
    );
    assert.strictEqual(
      tauriConf.bundle?.macOS?.signingIdentity,
      "-",
      'bundle.macOS.signingIdentity must be "-" (ad-hoc identity — Tauri signs with `codesign -s -`)',
    );
    assert.strictEqual(
      tauriConf.bundle?.macOS?.hardenedRuntime,
      false,
      "bundle.macOS.hardenedRuntime must be false (unsigned bundled native addons must be loadable; " +
        "hardened runtime would require entitlements to dlopen them). Tech-debt: re-enable for P-58c.",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T-Conf.2 — No-regression: P-58d.1 updater + P-58d.3 self-containment still intact
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("tauri.conf.json no-regression — P-58d.1 updater + P-58d.3 self-containment (G-P58d4-NoReg)", () => {
  it("T-Conf.2: createUpdaterArtifacts===true; resources[runtime]===runtime/; targets includes app+dmg; pubkey===28D6A7F5; endpoints deep-equals []", () => {
    // Given: tauri.conf.json (current checkout; F1 adds bundle.macOS — must not disturb these)
    // When:  parsed
    // Then:  all P-58d.1 updater invariants + P-58d.3 resource-map hold.
    //        If any of these fail AFTER F1 is applied, the builder accidentally broke
    //        the P-58d.1 updater wiring or the P-58d.3 self-containment config.
    //
    // Currently PASSES (regression guard). Also passes before F1 — these are independent fields.

    // (a) createUpdaterArtifacts — controls .app.tar.gz + .sig emission (P-58d.1)
    assert.strictEqual(
      tauriConf.bundle?.createUpdaterArtifacts,
      true,
      "bundle.createUpdaterArtifacts must be true (P-58d.1 updater wiring)",
    );

    // (b) bundle.resources — P-58d.3 self-containment: tauri copies build/runtime/ into Resources/runtime/
    assert.ok(
      tauriConf.bundle?.resources != null,
      "bundle.resources must be defined (P-58d.3 self-containment — must not be removed by F1)",
    );
    assert.strictEqual(
      tauriConf.bundle?.resources?.["../../../build/runtime/"],
      "runtime/",
      'bundle.resources["../../../build/runtime/"] must equal "runtime/" (P-58d.3 bundled-runtime map)',
    );

    // (c) targets — both "app" (updater artifacts) and "dmg" (installer) must remain
    const targets = tauriConf.bundle?.targets ?? [];
    assert.ok(targets.includes("app"), 'bundle.targets must include "app"');
    assert.ok(targets.includes("dmg"), 'bundle.targets must include "dmg"');

    // (d) pubkey — must remain the P-58d.1 28D6A7F5 key (changing this would brick existing installs)
    assert.strictEqual(
      tauriConf.plugins?.updater?.pubkey,
      P58D1_PUBKEY,
      `plugins.updater.pubkey must be the P-58d.1 28D6A7F5 minisign public key (got: ${tauriConf.plugins?.updater?.pubkey?.slice(0, 40)}…)`,
    );

    // (e) endpoints — must remain [] (populated at runtime via UpdaterExt; baking them in is rejected)
    assert.deepStrictEqual(
      tauriConf.plugins?.updater?.endpoints,
      [],
      "plugins.updater.endpoints must deep-equal [] (runtime-set via UpdaterExt, not baked in)",
    );
  });
});
