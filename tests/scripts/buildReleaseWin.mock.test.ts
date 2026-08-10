/**
 * WIN-5 — structural tests for scripts/build-release.ps1.
 *
 * The real NSIS bundle/signing run is Windows-hosted and currently ops-gated by
 * TAURI_SIGNING_PRIVATE_KEY. These tests source-check the release script wiring
 * that is safe to verify locally.
 *
 * Run:
 *   node --import tsx --test --test-force-exit tests/scripts/buildReleaseWin.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PS1 = readFileSync(join(REPO, "scripts", "build-release.ps1"), "utf-8");

describe("build-release.ps1 — Windows updater artifact signing gate", () => {
  it("T-WIN5.PS1.1: when TAURI_SIGNING_PRIVATE_KEY is present, missing signed updater artifact is fatal", () => {
    // Given: the PowerShell release script source
    // When:  the signing branch is inspected
    // Then:  TAURI_SIGNING_PRIVATE_KEY causes a missing updater artifact + .sig to throw, not silently publish
    assert.match(PS1, /\$env:TAURI_SIGNING_PRIVATE_KEY/);
    assert.match(PS1, /no signed Windows updater artifact \+ \.sig was found/);
  });

  it("T-WIN5.PS1.2: when TAURI_SIGNING_PRIVATE_KEY is absent, script warns and still publishes the installer", () => {
    // Given: the PowerShell release script source
    // When:  the no-key branch is inspected
    // Then:  it copies the NSIS installer and emits a clear deferred-signing warning
    assert.match(PS1, /Copy-Item -Force \$installer\.FullName \$publishedInstaller/);
    assert.match(PS1, /TAURI_SIGNING_PRIVATE_KEY is absent; Windows updater \.sig publication is deferred/);
  });
});

describe("build-release.ps1 — update-server site population", () => {
  it("T-WIN5.PS1.3: publishes Windows artifacts under the Frondose site downloads dir and regenerates latest.json", () => {
    // Given: the PowerShell release script source
    // When:  site population wiring is inspected
    // Then:  ~/.frondose/site is the default, Windows artifact env feeds gen-latest-json, and the landing page is copied
    assert.match(PS1, /\.frondose\\site/);
    assert.match(PS1, /Frondose-windows-x86_64-setup\.exe/);
    assert.match(PS1, /\$env:WINDOWS_SIG_PATH = \$publishedUpdaterSig/);
    assert.match(PS1, /\$env:WINDOWS_MANIFEST_URL = "\$updateServerUrl\/downloads\/\$publishedUpdaterName"/);
    assert.match(PS1, /node "\$PSScriptRoot\\gen-latest-json\.mjs"/);
    assert.match(PS1, /projects\\web\\index\.html/);
  });

  it("T-WIN5.PS1.4: UPDATE_SERVER_URL remains configurable while defaulting to the existing localhost:4875 flow", () => {
    // Given: the PowerShell release script source
    // When:  update-server URL wiring is inspected
    // Then:  UPDATE_SERVER_URL can point at a LAN host, with localhost:4875 kept as the fallback
    assert.match(PS1, /\$env:UPDATE_SERVER_URL/);
    assert.match(PS1, /http:\/\/localhost:4875/);
    assert.match(PS1, /\$updateServerUrl\/downloads\/Frondose\.app\.tar\.gz/);
  });
});
