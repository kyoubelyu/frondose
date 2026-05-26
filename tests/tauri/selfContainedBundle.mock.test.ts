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
  it('T-Conf.2: createUpdaterArtifacts===true; endpoints deep-equals []; pubkey===28D6A7F5 string; targets includes "app"+"dmg"', () => {
    // Given: tauri.conf.json
    // When:  parsed
    // Then:  all four P-58d.1 updater invariants hold — F2 must not break them.
    //
    // Currently PASSES (regression guard). If this fails after F2 is applied,
    // the builder accidentally broke the P-58d.1 updater wiring.

    // (a) createUpdaterArtifacts — controls .app.tar.gz + .sig emission
    assert.strictEqual(
      tauriConf.bundle?.createUpdaterArtifacts,
      true,
      "bundle.createUpdaterArtifacts must be true (P-58d.1 updater wiring)",
    );

    // (b) endpoints — must remain [] (populated at runtime via UpdaterExt; build-time bake is rejected)
    assert.deepStrictEqual(
      tauriConf.plugins?.updater?.endpoints,
      [],
      "plugins.updater.endpoints must deep-equal [] (runtime-set via UpdaterExt, not baked in)",
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
describe("version drift guard — package.json === tauri.conf.json (G-P58d3.5)", () => {
  it("T-Conf.3: package.json.version === tauri.conf.json.version (catches missed Step-7 bump pre-release)", () => {
    // Given: package.json + tauri.conf.json (current checkout)
    // When:  versions compared
    // Then:  equal — a version drift detected here means the Step-7 quad-bump was missed,
    //        which would cause build-release.sh to exit 1 before producing artifacts.
    //
    // Currently PASSES (regression guard — both at 0.5.0-alpha.29 after P-58d.2 Step-7).
    assert.strictEqual(
      pkgJson.version,
      tauriConf.version,
      `package.json.version (${pkgJson.version}) must equal tauri.conf.json.version (${tauriConf.version}) — re-run the Step-7 quad-bump`,
    );
  });
});
