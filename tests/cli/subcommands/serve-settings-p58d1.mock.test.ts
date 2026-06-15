/**
 * P-58d.1 Step 4a — T-UpdSettings.1–6 — [Step 5: assertion bodies FILLED]
 *
 * Serve `/settings` surface for the new `updateServerUrl` field (plan §6.4-F4):
 *
 * Key invariants:
 *  - T-UpdSettings.1: PLAINTEXT read (NOT masked — contrast llm.maskedKey). updateServerUrl is not
 *    a secret; operators need to see/edit it directly.
 *  - T-UpdSettings.5 (★): validate-before-write at the SETTINGS layer. settingsPatchSchema keeps
 *    z.string().url() for updateServerUrl — this is WHERE strictness lives (CMR-1 split: lenient at
 *    persistence, strict at write). A malformed URL → parseSettingsPatch returns {ok:false} → route
 *    400s + config UNCHANGED.
 *  - T-UpdSettings.3: omit in patch = unchanged (no destructive clear).
 *  - T-UpdSettings.4: explicit null = clear (set to null / disabled).
 *  - T-UpdSettings.6: routes.ts spreads readSettings() with NO EDIT needed — the field flows through.
 *
 * LOAD: settings.ts EXISTS (shipped P-Y6). The builder (Step 4b) ADDS the updateServerUrl field to
 *   SettingsView / readSettings / settingsPatchSchema / applySettings. Until 4b, calling these
 *   functions succeeds but the field is absent — assertion bodies are TODO so the tests fail.
 *
 * Gate coverage: G-P58d.1.2 (T-UpdSettings.1–6 — plaintext read / set / omit / clear / reject / spread).
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/cli/subcommands/serve-settings-p58d1.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { applySettings, parseSettingsPatch, readSettings } from "../../../src/cli/subcommands/serve/settings.js";
import { DEFAULT_CONFIG_PATH, readConfig, writeConfig } from "../../../src/persistence/config.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Run fn with MAI_HOME_BASE pointing at a fresh temp dir (DEFAULT_CONFIG_PATH resolves under it). */
function withTempHome<T>(fn: (home: string) => T): T {
  const prev = process.env.FRONDOSE_HOME_BASE;
  const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "p58d1-settings-"));
  process.env.FRONDOSE_HOME_BASE = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.FRONDOSE_HOME_BASE;
    else process.env.FRONDOSE_HOME_BASE = prev;
    rmSync(home, { recursive: true, force: true }); // cleanup temp dir
  }
}

/** Seed a minimal v2 config.json with optional overrides. */
function seedConfig(over: Record<string, unknown> = {}): void {
  writeConfig(
    {
      schema_version: 2,
      server: {
        url: null,
        bind_address: null,
        poll_interval_s: 30,
        web_port: 8090,
        ssh_user: null,
        ssh_port: 22,
        rest_port: 3031,
      },
      worker: { id: null, hostname: null, label: null, input_mode: "cdp" },
      telegram: { enabled: false, boundUserId: null, proxyUrl: null },
      soul: { override: null },
      ...over,
      // biome-ignore lint/suspicious/noExplicitAny: minimal ConfigJsonV2 fixture for test seeding
    } as any,
    DEFAULT_CONFIG_PATH(),
  );
}

// ─── T-UpdSettings.1 ─────────────────────────────────────────────────────────

describe("readSettings — updateServerUrl is returned PLAINTEXT, NOT masked (G-P58d.1.2)", () => {
  // Given: config.json with updateServerUrl "http://host:8765" (a plain URL, not a secret)
  // When:  readSettings()
  // Then:  view.updateServerUrl === "http://host:8765" VERBATIM
  //        (no maskKey applied, no bullet/asterisk mask markers — contrast view.llm.maskedKey)
  it("T-UpdSettings.1: readSettings exposes updateServerUrl verbatim (plaintext, NOT masked)", () => {
    withTempHome(() => {
      seedConfig({ updateServerUrl: "http://host:8765" });
      const view = readSettings();
      assert.equal(view.updateServerUrl, "http://host:8765", "updateServerUrl returned verbatim");
      // No mask characters (contrast llm.maskedKey which uses •••)
      const urlStr = String(view.updateServerUrl);
      assert.ok(!urlStr.includes("•"), "no bullet mask markers");
      assert.ok(!urlStr.includes("***"), "no asterisk mask markers");
    });
  });
});

// ─── T-UpdSettings.2 ─────────────────────────────────────────────────────────

describe("applySettings — POST {updateServerUrl} sets it; other fields unchanged (G-P58d.1.2)", () => {
  // Given: config with soul override set AND no updateServerUrl
  //        AND a valid patch {updateServerUrl: "http://host:8765"}
  // When:  parseSettingsPatch(patch) → ok:true → applySettings(patch)
  // Then:  readConfig(DEFAULT_CONFIG_PATH()).updateServerUrl === "http://host:8765"
  //        AND soul.override is unchanged from before the patch
  it("T-UpdSettings.2: applySettings({updateServerUrl:'http://host:8765'}) writes the field; soul unchanged", () => {
    withTempHome(() => {
      seedConfig({ soul: { override: "my-soul" }, updateServerUrl: null });
      const patchResult = parseSettingsPatch({ updateServerUrl: "http://host:8765" });
      assert.ok(patchResult.ok, `parseSettingsPatch must succeed: ${!patchResult.ok ? patchResult.error : ""}`);
      if (patchResult.ok) applySettings(patchResult.patch);
      const cfg = readConfig(DEFAULT_CONFIG_PATH());
      assert.equal(cfg.updateServerUrl, "http://host:8765", "updateServerUrl written");
      assert.equal(cfg.soul.override, "my-soul", "soul.override preserved — only updateServerUrl changed");
    });
  });
});

// ─── T-UpdSettings.3 ─────────────────────────────────────────────────────────

describe("applySettings — OMITTING updateServerUrl in patch leaves existing value unchanged (G-P58d.1.2)", () => {
  // Given: config with updateServerUrl "http://old:1"
  //        AND a patch that omits updateServerUrl entirely (e.g. only {soul:{override:"x"}})
  // When:  applySettings(patch)
  // Then:  readConfig().updateServerUrl is STILL "http://old:1" (omit = unchanged, no destructive clear)
  it("T-UpdSettings.3: a patch omitting updateServerUrl leaves the existing value intact (omit=unchanged)", () => {
    withTempHome(() => {
      seedConfig({ updateServerUrl: "http://old:1" });
      const patchResult = parseSettingsPatch({ soul: { override: "x" } });
      assert.ok(patchResult.ok, "soul-only patch must parse ok");
      if (patchResult.ok) applySettings(patchResult.patch);
      const cfg = readConfig(DEFAULT_CONFIG_PATH());
      assert.equal(cfg.updateServerUrl, "http://old:1", "updateServerUrl unchanged (omit=unchanged)");
    });
  });
});

// ─── T-UpdSettings.4 ─────────────────────────────────────────────────────────

describe("applySettings — {updateServerUrl: null} clears the field (G-P58d.1.2)", () => {
  // Given: config with updateServerUrl "http://old:1"
  //        AND a patch {updateServerUrl: null}
  // When:  applySettings(patch)
  // Then:  readConfig().updateServerUrl === null (null=clear — updater disabled)
  it("T-UpdSettings.4: applySettings({updateServerUrl:null}) clears the field to null", () => {
    withTempHome(() => {
      seedConfig({ updateServerUrl: "http://old:1" });
      const patchResult = parseSettingsPatch({ updateServerUrl: null });
      assert.ok(patchResult.ok, "null patch must parse ok (nullable)");
      if (patchResult.ok) applySettings(patchResult.patch);
      const cfg = readConfig(DEFAULT_CONFIG_PATH());
      assert.equal(cfg.updateServerUrl, null, "updateServerUrl cleared to null (updater disabled)");
    });
  });
});

// ─── T-UpdSettings.5 ─────────────────────────────────────────────────────────

describe("parseSettingsPatch — invalid updateServerUrl → {ok:false}; config left UNCHANGED (CMR-1 write gate) (G-P58d.1.2)", () => {
  // Given: a POST body {updateServerUrl: "not a url"} (fails z.string().url())
  // When:  parseSettingsPatch(body)
  // Then:  returns {ok:false} (the .url() constraint rejects the value)
  //        → the route 400s and writes NOTHING (config unchanged)
  // ★ This is WHERE url strictness lives (CMR-1 split: lenient persistence / strict write-path)
  it("T-UpdSettings.5: parseSettingsPatch({updateServerUrl:'not a url'}) → {ok:false}; no write occurs (validate-before-write)", () => {
    withTempHome(() => {
      seedConfig({ updateServerUrl: "http://original:1" });
      const result = parseSettingsPatch({ updateServerUrl: "not a url" });
      assert.equal(result.ok, false, "invalid URL rejected by z.string().url() (strict write-path gate)");
      // Route follows its contract: only calls applySettings when ok=true → config unchanged
      const cfg = readConfig(DEFAULT_CONFIG_PATH());
      assert.equal(cfg.updateServerUrl, "http://original:1", "config untouched — gate prevented write");
    });
  });
});

// ─── T-UpdSettings.6 ─────────────────────────────────────────────────────────

describe("GET /settings response carries updateServerUrl without any routes.ts edit (G-P58d.1.2)", () => {
  // Given: config with updateServerUrl "http://tailscale-host:8765"
  // When:  the GET /settings payload is assembled as { ok: true, ...readSettings() }
  //        (routes.ts spreads readSettings() — plan §6.4-F4 note: NO routes.ts edit needed)
  // Then:  the payload's updateServerUrl === "http://tailscale-host:8765"
  //        (proves the field flows through the spread with zero route-layer change)
  it("T-UpdSettings.6: the GET /settings payload (ok:true, ...readSettings()) includes updateServerUrl verbatim (no routes.ts edit needed)", () => {
    withTempHome(() => {
      seedConfig({ updateServerUrl: "http://tailscale-host:8765" });
      const payload = { ok: true, ...readSettings() };
      assert.equal(
        payload.updateServerUrl,
        "http://tailscale-host:8765",
        "updateServerUrl flows through readSettings() spread — no routes.ts edit required",
      );
    });
  });
});
