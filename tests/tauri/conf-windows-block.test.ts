/**
 * WIN-3 Step 3 (scaffold) — T-Conf.Win.1, T-Conf.Win.2, T-Conf.Win.3, T-Conf.Win.4
 *
 * Structural assertions on `src/tauri/src-tauri/tauri.conf.json`.
 * Tests read and parse the real file — no build or Tauri toolchain required.
 *
 * Gate coverage:
 *   G-WIN3.2  — T-Conf.Win.1 (bundle.windows.webviewInstallMode.type === "downloadBootstrapper"
 *                              AND .silent === true)
 *             — T-Conf.Win.2 (bundle.windows.nsis.installerIcon === "icons/icon.ico",
 *                              .installMode === "perMachine", .languages includes "English")
 *   G-WIN3.2 + G-WIN3.M-1 pre-check:
 *             — T-Conf.Win.3 (bundle.targets deep-equals ["app","dmg"] — UNCHANGED from
 *                              pre-WIN-3; macOS release path uses --bundles app CLI override)
 *             — T-Conf.Win.4 (bundle.resources["../../../build/runtime/"] === "runtime/" —
 *                              UNCHANGED; validates Codex did NOT disturb the resources map)
 *
 * PRE-IMPL RED STATE:
 *   T-Conf.Win.1 fails — bundle.windows block does not yet exist in tauri.conf.json.
 *   T-Conf.Win.2 fails — same reason.
 *   T-Conf.Win.3 PASSES (bundle.targets already === ["app","dmg"] — regression guard).
 *   T-Conf.Win.4 PASSES (bundle.resources already correct — regression guard).
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/tauri/conf-windows-block.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Parse once at module level — cheap, no I/O in tests.
type TauriConf = {
  bundle?: {
    active?: boolean;
    targets?: string[];
    createUpdaterArtifacts?: boolean;
    resources?: Record<string, string>;
    windows?: {
      webviewInstallMode?: {
        type?: string;
        silent?: boolean;
      };
      nsis?: {
        installerIcon?: string;
        installMode?: string;
        languages?: string[];
        displayLanguageSelector?: boolean;
      };
    };
    macOS?: Record<string, unknown>;
  };
  plugins?: Record<string, unknown>;
};

const tauriConf: TauriConf = JSON.parse(readFileSync(join(REPO, "src/tauri/src-tauri/tauri.conf.json"), "utf-8"));

// ---------------------------------------------------------------------------
// G-WIN3.2: bundle.windows webviewInstallMode shape
// ---------------------------------------------------------------------------

describe("G-WIN3.2 — tauri.conf.json: bundle.windows.webviewInstallMode is downloadBootstrapper+silent", () => {
  it('T-Conf.Win.1: bundle.windows.webviewInstallMode.type === "downloadBootstrapper" and .silent === true', () => {
    // Given: tauri.conf.json parsed from the repo (pre-WIN-3 has no bundle.windows block)
    // When:  bundle.windows.webviewInstallMode is inspected
    // Then:  type === "downloadBootstrapper" AND silent === true

    const winBlock = tauriConf.bundle?.windows;
    assert.ok(
      winBlock != null,
      'T-Conf.Win.1: bundle.windows must exist in tauri.conf.json (WIN-3 F-2 not yet applied — add the "windows" block per plan §6.4 L-2)',
    );

    const wvMode = winBlock.webviewInstallMode;
    assert.ok(wvMode != null, "T-Conf.Win.1: bundle.windows.webviewInstallMode must be defined");
    assert.strictEqual(
      wvMode.type,
      "downloadBootstrapper",
      `T-Conf.Win.1: webviewInstallMode.type must be "downloadBootstrapper" (got: ${JSON.stringify(wvMode.type)})`,
    );
    assert.strictEqual(
      wvMode.silent,
      true,
      `T-Conf.Win.1: webviewInstallMode.silent must be true (got: ${JSON.stringify(wvMode.silent)})`,
    );
  });
});

// ---------------------------------------------------------------------------
// G-WIN3.2: bundle.windows.nsis installer config
// ---------------------------------------------------------------------------

describe("G-WIN3.2 — tauri.conf.json: bundle.windows.nsis installer icon, installMode, and languages", () => {
  it('T-Conf.Win.2: nsis.installerIcon === "icons/icon.ico", .installMode === "perMachine", .languages includes "English"', () => {
    // Given: tauri.conf.json parsed (pre-WIN-3 has no bundle.windows block)
    // When:  bundle.windows.nsis is inspected
    // Then:  installerIcon === "icons/icon.ico"
    //        installMode === "perMachine"
    //        languages array includes "English"

    const nsis = tauriConf.bundle?.windows?.nsis;
    assert.ok(
      nsis != null,
      "T-Conf.Win.2: bundle.windows.nsis must exist in tauri.conf.json (WIN-3 F-2 not yet applied)",
    );
    assert.strictEqual(
      nsis.installerIcon,
      "icons/icon.ico",
      `T-Conf.Win.2: nsis.installerIcon must be "icons/icon.ico" (got: ${JSON.stringify(nsis.installerIcon)})`,
    );
    assert.strictEqual(
      nsis.installMode,
      "perMachine",
      `T-Conf.Win.2: nsis.installMode must be "perMachine" (got: ${JSON.stringify(nsis.installMode)})`,
    );
    const langs = nsis.languages ?? [];
    assert.ok(
      langs.includes("English"),
      `T-Conf.Win.2: nsis.languages must include "English" (got: ${JSON.stringify(langs)})`,
    );
  });
});

// ---------------------------------------------------------------------------
// G-WIN3.2 + G-WIN3.M-1 pre-check: bundle.targets UNCHANGED
// ---------------------------------------------------------------------------

describe('G-WIN3.2 + G-WIN3.M-1 pre-check — tauri.conf.json: bundle.targets still ["app","dmg"]', () => {
  it('T-Conf.Win.3: bundle.targets deep-equals ["app","dmg"] — macOS release path unaffected by WIN-3', () => {
    // Given: tauri.conf.json parsed
    // When:  bundle.targets is read
    // Then:  it deep-equals ["app","dmg"] — WIN-3 must NOT change this field;
    //        the Windows release path uses --bundles nsis CLI override instead

    const targets = tauriConf.bundle?.targets;
    assert.deepStrictEqual(
      targets,
      ["app", "dmg"],
      `T-Conf.Win.3: bundle.targets must remain ["app","dmg"] (got: ${JSON.stringify(targets)}) — do NOT change this field in WIN-3`,
    );
  });
});

// ---------------------------------------------------------------------------
// G-WIN3.M-1 pre-check: bundle.resources UNCHANGED
// ---------------------------------------------------------------------------

describe('G-WIN3.M-1 pre-check — tauri.conf.json: bundle.resources["../../../build/runtime/"] === "runtime/"', () => {
  it('T-Conf.Win.4: bundle.resources["../../../build/runtime/"] === "runtime/" — macOS bundling contract preserved', () => {
    // Given: tauri.conf.json parsed
    // When:  bundle.resources is read
    // Then:  bundle.resources["../../../build/runtime/"] === "runtime/"
    //        WIN-3 must NOT disturb this mapping — it is the load-bearing runtime-bundle wiring
    //        from P-58d.3 that ships the self-contained Node runtime into the .app / .exe

    const resources = tauriConf.bundle?.resources;
    assert.ok(resources != null, "T-Conf.Win.4: bundle.resources must be defined (P-58d.3 wiring)");
    assert.strictEqual(
      resources["../../../build/runtime/"],
      "runtime/",
      `T-Conf.Win.4: bundle.resources["../../../build/runtime/"] must equal "runtime/" (got: ${JSON.stringify(resources["../../../build/runtime/"])})`,
    );
  });
});
