/**
 * P-APP-4 Step 4a scaffold - app-owned overlay ownership and stale replacement.
 *
 * These tests intentionally go red before Step 4b because the production overlay
 * still has no owner/version substitution and still short-circuits on the stale
 * __frondoseBootstrapped flag.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/overlay/appOwnedOverlay-papp4.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BOOTSTRAP_TS = readFileSync(join(REPO, "src", "overlay", "bootstrap.ts"), "utf8");

type FakeCdpClient = {
  Runtime: {
    enable: () => Promise<void>;
    addBinding: (_input: { name: string }) => Promise<void>;
  };
  Page: {
    enable: () => Promise<void>;
    addScriptToEvaluateOnNewDocument: (_input: {
      source: string;
      worldName: string;
      runImmediately: boolean;
    }) => Promise<{ identifier: string }>;
  };
};

function freshHostModuleUrl(): string {
  const url = pathToFileURL(join(REPO, "src", "overlay", "host.ts")).href;
  return `${url}?papp4=${Date.now()}-${Math.random()}`;
}

async function captureInstallSource(owner: string | undefined): Promise<string> {
  const previousOwner = process.env.FRONDOSE_SIDECAR_OWNER;
  if (owner === undefined) delete process.env.FRONDOSE_SIDECAR_OWNER;
  else process.env.FRONDOSE_SIDECAR_OWNER = owner;

  let capturedSource = "";
  const client: FakeCdpClient = {
    Runtime: {
      enable: async () => undefined,
      addBinding: async () => undefined,
    },
    Page: {
      enable: async () => undefined,
      addScriptToEvaluateOnNewDocument: async (input) => {
        capturedSource = input.source;
        assert.equal(input.worldName, "frondose-overlay");
        assert.equal(input.runImmediately, true);
        return { identifier: "overlay-script-id" };
      },
    },
  };

  try {
    const { installOverlay } = (await import(freshHostModuleUrl())) as {
      installOverlay: (client: FakeCdpClient) => Promise<string>;
    };
    const identifier = await installOverlay(client);
    assert.equal(identifier, "overlay-script-id");
    assert.ok(capturedSource.length > 0, "installOverlay must inject non-empty bootstrap source");
    return capturedSource;
  } finally {
    if (previousOwner === undefined) delete process.env.FRONDOSE_SIDECAR_OWNER;
    else process.env.FRONDOSE_SIDECAR_OWNER = previousOwner;
  }
}

function assertNoOwnerPlaceholders(source: string): void {
  assert.ok(!/__FRONDOSE_OVERLAY_OWNER__/.test(source), "owner placeholder must be substituted");
  assert.ok(!/__FRONDOSE_OVERLAY_VERSION__/.test(source), "version placeholder must be substituted");
}

describe("P-APP-4 overlay owner substitution", () => {
  afterEach(() => {
    delete process.env.FRONDOSE_SIDECAR_OWNER;
  });

  it("T-PAPP4.Overlay.1: installOverlay substitutes app owner when FRONDOSE_SIDECAR_OWNER=frondose-app", async () => {
    // Given: the Tauri app sidecar marks itself with FRONDOSE_SIDECAR_OWNER=frondose-app.
    // When:  installOverlay assembles the injected overlay bootstrap.
    // Then:  the injected source carries app owner/version markers and no unresolved placeholders.
    const source = await captureInstallSource("frondose-app");

    assert.ok(/FRONDOSE_OVERLAY_OWNER\s*=\s*["']frondose-app["']/.test(source), "app-owned injection must use frondose-app");
    assert.ok(
      /FRONDOSE_OVERLAY_VERSION\s*=\s*["']p-app-4-overlay-v1["']/.test(source),
      "app-owned injection must carry the P-APP-4 overlay version marker",
    );
    assertNoOwnerPlaceholders(source);
  });

  it("T-PAPP4.Overlay.2: default transitional serve injection uses owner frondose-serve", async () => {
    // Given: a legacy/internal serve path without the app-owned sidecar env marker.
    // When:  installOverlay assembles the injected overlay bootstrap.
    // Then:  the injected source is marked frondose-serve, not frondose-app.
    const source = await captureInstallSource(undefined);

    assert.ok(/FRONDOSE_OVERLAY_OWNER\s*=\s*["']frondose-serve["']/.test(source), "default owner must be frondose-serve");
    assert.ok(
      !/FRONDOSE_OVERLAY_OWNER\s*=\s*["']frondose-app["']/.test(source),
      "default transitional serve injection must not claim app ownership",
    );
    assertNoOwnerPlaceholders(source);
  });
});

describe("P-APP-4 bootstrap owner markers", () => {
  it("T-PAPP4.Overlay.3: OVERLAY_BOOTSTRAP_JS does not contain the bare __frondoseBootstrapped guard", () => {
    // Given: live Chrome can already contain a stale unowned overlay from an older sidecar.
    // When:  bootstrap source handles idempotency.
    // Then:  it may return only after matching owner/version, not on the bare bootstrapped flag.
    assert.ok(
      !/if\s*\(\s*window\.__frondoseBootstrapped\s*\)\s*return\s*;/.test(BOOTSTRAP_TS),
      "bare __frondoseBootstrapped guard would preserve stale non-app overlay state",
    );
  });

  it("T-PAPP4.Overlay.4: bootstrap source sets host dataset and isolated-window owner/version markers", () => {
    // Given: live L1 acceptance must prove page overlay ownership mechanically.
    // When:  the overlay host is created.
    // Then:  both host data attributes and isolated-world globals expose owner/version markers.
    assert.ok(
      /(?:dataset\.frondoseOverlayOwner|setAttribute\(["']data-frondose-overlay-owner["'])/.test(BOOTSTRAP_TS),
      "host must set data-frondose-overlay-owner",
    );
    assert.ok(
      /(?:dataset\.frondoseOverlayVersion|setAttribute\(["']data-frondose-overlay-version["'])/.test(BOOTSTRAP_TS),
      "host must set data-frondose-overlay-version",
    );
    assert.ok(/window\.__frondoseOverlayOwner\s*=/.test(BOOTSTRAP_TS), "bootstrap must set window.__frondoseOverlayOwner");
    assert.ok(/window\.__frondoseOverlayVersion\s*=/.test(BOOTSTRAP_TS), "bootstrap must set window.__frondoseOverlayVersion");
  });

  it("T-PAPP4.Overlay.5: stale replacement is hardened against P-57e style self-heal", () => {
    // Given: P-57e observers can reappend the old root and restore HOST_STYLE after style wipes.
    // When:  a stale or unowned root is replaced.
    // Then:  old root quarantine must not rely on rename + display:none alone, detached stale cards are removed,
    //        exactly one active root can remain, and sessionStorage dialog replay stays intact.
    assert.ok(/__frondose_root_stale_/.test(BOOTSTRAP_TS), "stale root must be renamed away from active #__frondose_root");
    assert.ok(
      /(?:dataset\.frondoseOverlayStale|setAttribute\(["']data-frondose-overlay-stale["'])/.test(BOOTSTRAP_TS),
      "stale root must be marked with data-frondose-overlay-stale",
    );

    const clearsStaleShadow =
      /shadowRoot[\s\S]{0,200}\.replaceChildren\(\)/.test(BOOTSTRAP_TS) ||
      /shadowRoot[\s\S]{0,200}\.(?:innerHTML|textContent)\s*=\s*["']{2}/.test(BOOTSTRAP_TS) ||
      /while\s*\([\s\S]{0,120}shadowRoot\.firstChild[\s\S]{0,220}removeChild/.test(BOOTSTRAP_TS);
    assert.ok(
      clearsStaleShadow,
      "stale root must clear or neutralize old shadow content so HOST_STYLE self-heal cannot make it visible again",
    );

    assert.ok(
      /__frondose_collapsed_card[\s\S]{0,160}\.remove\(/.test(BOOTSTRAP_TS),
      "detached collapsed cards must be removed",
    );
    assert.ok(/__frondose_cron_banner[\s\S]{0,160}\.remove\(/.test(BOOTSTRAP_TS), "detached cron banners must be removed");
    assert.ok(/host\.id\s*=\s*["']__frondose_root["']/.test(BOOTSTRAP_TS), "new host must remain the active app-owned root");
    assert.ok(/frondoseReadDialogState|FRONDOSE_DIALOG_KEY/.test(BOOTSTRAP_TS), "sessionStorage dialog replay must be preserved");
    assert.ok(/window\.__frondoseShowCard\(saved\.card\)/.test(BOOTSTRAP_TS), "saved card replay must be preserved");
  });
});
