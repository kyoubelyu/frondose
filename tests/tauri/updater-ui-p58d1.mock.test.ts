/**
 * P-58d.1-UI Step 5 — T-UI.5–10 — [assertion bodies FILLED]
 *
 * UI layer for the P-58d.1 updater: "Update server URL" input + "Check for updates" button
 * in the Frondose Settings panel, wired to existing `mai_get_settings` / `mai_set_settings` /
 * `mai_check_update` Tauri commands (all shipped in P-58d.1). A-1: gear handler wrapped with
 * `.catch(→surfaceError)` (app.ts change).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * CONSTRAINT (documented): the Tauri WKWebView has no CDP/DevTools attach point, so a real
 * button-click CANNOT be driven live. All behavioral tests (T-UI.5–9a) are mock/DOM-stub
 * level (same harness as settings-pY6.mock.test.ts). T-UI.9b + T-UI.10 are structural source
 * assertions. NOT live-click verified in any test.
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Gate coverage:
 *   G-P58d.1-UI.1 ↦ T-UI.5  (button invokes mai_check_update)
 *   G-P58d.1-UI.2 ↦ T-UI.6 + T-UI.7 (load populates / save sends updateServerUrl)
 *   G-P58d.1-UI.3 ↦ T-UI.8  (invalid-URL rejection surfaced via surfaceError)
 *   G-P58d.1-UI.4 ↦ T-UI.9  (A-1: open() propagates rejection; app.ts gear handler catches)
 *   G-P58d.1-UI.5 ↦ T-UI.10 (scope: changes ⊆ {settings.ts, index.html, app.ts + .js/.map})
 *
 * PLACEMENT decision (validator's call per plan §3): new file — extends rather than modifies
 * the already-passing settings-pY6.mock.test.ts (T-UI.1–4 + T-Scope.1 unchanged; surgical).
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/updater-ui-p58d1.mock.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Read source files at module level — used in structural assertions (T-UI.9b, T-UI.10).
const APP_TS_SRC = readFileSync(join(REPO, "src", "tauri", "ui", "app.ts"), "utf-8");
const SETTINGS_TS_SRC = readFileSync(join(REPO, "src", "tauri", "ui", "settings.ts"), "utf-8");

// ── Gate-on-builder: settings.ts gains the updateServerUrl field + checkUpdate() at Step 4b. ──
// biome-ignore lint/suspicious/noExplicitAny: gate-on-builder dynamic import (settings.js may not be built yet)
let createSettingsPanel: ((deps: any) => { open(): Promise<void>; close(): void }) | undefined;
before(async () => {
  try {
    // Import the compiled .js (builder runs `npm run build:tauri-ui` at Step 4b).
    createSettingsPanel = (await import("../../src/tauri/ui/settings.js")).createSettingsPanel;
  } catch {
    // settings.ts not built or not yet updated — gate will fail with clear message.
  }
});

// ── Extended DOM stub (includes textContent for the #settings-update-status span) ──────────────

/** FakeEl interface — extends the P-Y6 stub with `textContent` (plan §6.4-U1b: FieldLike gains it). */
interface FakeEl {
  id: string;
  value: string;
  placeholder: string;
  textContent: string | null; // P-58d.1-UI: used by the status span; inputs leave this null
  listeners: Record<string, () => void>;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
}

/**
 * Full ID set — includes the P-Y6 IDs that settings.ts accesses on load/save, PLUS the three
 * P-58d.1-UI additions. Without all P-Y6 IDs present, getElementById returns null and the
 * existing fields silently degrade (all guarded with `if (el)`), which is acceptable; but
 * having them makes the mock more realistic.
 */
const SETTINGS_IDS = [
  "settings-panel",
  "settings-save",
  "settings-close",
  "settings-baseurl",
  "settings-model",
  "settings-key",
  "settings-fullname",
  "settings-company",
  "settings-role",
  "settings-headline",
  "settings-icp-roles",
  "settings-soul",
  // P-58d.1-UI additions:
  "settings-update-url",
  "settings-check-update",
  "settings-update-status",
];

/** Install a minimal document.getElementById stub for the settings panel tests. */
function installDomStub(): Record<string, FakeEl> {
  const els: Record<string, FakeEl> = {};
  for (const id of SETTINGS_IDS) {
    const cls = new Set<string>();
    els[id] = {
      id,
      value: "",
      placeholder: "",
      textContent: null,
      listeners: {},
      classList: {
        add: (c) => cls.add(c),
        remove: (c) => cls.delete(c),
        contains: (c) => cls.has(c),
      },
    };
    // Attach addEventListener so save() / close() / checkUpdate() listeners can be fired in-test.
    (els[id] as unknown as { addEventListener: (ev: string, fn: () => void) => void }).addEventListener = (ev, fn) => {
      els[id].listeners[ev] = fn;
    };
  }
  (globalThis as unknown as { document: unknown }).document = {
    getElementById: (id: string) => els[id] ?? null,
  };
  return els;
}

/**
 * Mock invoke that records all calls.
 * - `mai_get_settings` returns `getResp`.
 * - Other commands return `{ ok: true }` unless `rejectCmd` matches — used for T-UI.8 + T-UI.9a.
 */
function mockInvoke(getResp: Record<string, unknown>, rejectCmd?: string) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (rejectCmd && cmd === rejectCmd) throw new Error(`mock: ${cmd} rejected`);
    return cmd === "mai_get_settings" ? getResp : { ok: true };
  };
  return { invoke, calls };
}

/** Sample mai_get_settings response including the P-58d.1 updateServerUrl field. */
const SAMPLE_GET_UI = {
  ok: true,
  llm: {
    baseUrl: "https://x/v1",
    model: "deepseek-chat",
    hasKey: true,
    maskedKey: "sk-***9999",
    provider: "deepseek",
  },
  identity: { fullName: "A" },
  soul: { override: "s" },
  updateServerUrl: "http://192.168.1.50:8765", // P-58d.1-UI
};

/** Flush microtasks so async save() / open() / checkUpdate() settle after click(). */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// biome-ignore lint/suspicious/noExplicitAny: test reaches into DOM-stub listener map
// biome-ignore lint/correctness/noUnusedVariables: Els used in T-UI.7/8 findLastSetCall helper
type Els = Record<string, any>;

// ─── T-UI.5 ─────────────────────────────────────────────────────────────────

describe("settings panel — 'Check for updates' button calls invoke('mai_check_update') (G-P58d.1-UI.1)", () => {
  // Given: createSettingsPanel({invoke: mockInvoke, surfaceError}) with DOM stub including settings-check-update
  // When:  the settings-check-update click listener fires
  // Then:  invoke was called with cmd === "mai_check_update" (proving the button is wired to the shipped command)
  it("T-UI.5: clicking the settings-check-update button calls invoke with cmd='mai_check_update'", async () => {
    if (!createSettingsPanel) assert.fail("createSettingsPanel not loaded — run npm run build:tauri-ui first");
    const els = installDomStub();
    const m = mockInvoke(SAMPLE_GET_UI);
    createSettingsPanel({ invoke: m.invoke, surfaceError: () => {} });
    // Fire the check-update click (checkUpdate() is async; tick() lets microtasks settle).
    els["settings-check-update"].listeners.click();
    await tick();
    assert.ok(
      m.calls.some((c: { cmd: string }) => c.cmd === "mai_check_update"),
      `expected a mai_check_update call; got: ${JSON.stringify(m.calls.map((c: { cmd: string }) => c.cmd))}`,
    );
  });
});

// ─── T-UI.6 ─────────────────────────────────────────────────────────────────

describe("settings panel — open() populates settings-update-url from mai_get_settings (G-P58d.1-UI.2)", () => {
  // Given: mock mai_get_settings returning updateServerUrl: "http://192.168.1.50:8765"
  // When:  panel.open()
  // Then:  els["settings-update-url"].value === "http://192.168.1.50:8765"
  //        AND with null updateServerUrl in response → value === "" (no crash, no undefined)
  it("T-UI.6: open() populates settings-update-url from the response (null updateServerUrl → '')", async () => {
    if (!createSettingsPanel) assert.fail("createSettingsPanel not loaded — run npm run build:tauri-ui first");

    // (a) updateServerUrl set → input populated
    {
      const els = installDomStub();
      const m = mockInvoke({ ...SAMPLE_GET_UI, updateServerUrl: "http://192.168.1.50:8765" });
      const panel = createSettingsPanel({ invoke: m.invoke, surfaceError: () => {} });
      await panel.open();
      assert.equal(
        els["settings-update-url"].value,
        "http://192.168.1.50:8765",
        "open() must populate settings-update-url from response",
      );
    }

    // (b) null updateServerUrl → empty string (no crash, no "null" string)
    {
      const els = installDomStub();
      const m = mockInvoke({ ...SAMPLE_GET_UI, updateServerUrl: null });
      const panel = createSettingsPanel({ invoke: m.invoke, surfaceError: () => {} });
      await panel.open();
      assert.equal(
        els["settings-update-url"].value,
        "",
        "null updateServerUrl must produce empty string input (not 'null' or undefined)",
      );
    }
  });
});

// ─── T-UI.7 ─────────────────────────────────────────────────────────────────

describe("settings panel — save() sends updateServerUrl in the mai_set_settings patch (G-P58d.1-UI.2)", () => {
  // Given: panel after open(); els["settings-update-url"].value = "http://host:8765"
  // When:  save() fires (settings-save click listener)
  // Then:  the last mai_set_settings call's args.settings.updateServerUrl === "http://host:8765"
  //        AND with the input empty → args.settings.updateServerUrl === null (clear, mirrors soul.override)
  it("T-UI.7: save() includes updateServerUrl in the patch; empty input sends null (clear)", async () => {
    if (!createSettingsPanel) assert.fail("createSettingsPanel not loaded — run npm run build:tauri-ui first");

    // (a) non-empty value → included verbatim in patch
    {
      const els = installDomStub();
      const m = mockInvoke(SAMPLE_GET_UI);
      const panel = createSettingsPanel({ invoke: m.invoke, surfaceError: () => {} });
      await panel.open();
      els["settings-update-url"].value = "http://host:8765";
      els["settings-save"].listeners.click();
      await tick();
      const setCall = [...m.calls].reverse().find((c: { cmd: string }) => c.cmd === "mai_set_settings");
      assert.ok(setCall, "expected a mai_set_settings call after save click");
      assert.equal(
        (setCall.args as { settings: { updateServerUrl: unknown } }).settings.updateServerUrl,
        "http://host:8765",
        "updateServerUrl must be forwarded verbatim in the patch",
      );
    }

    // (b) empty value → null (clear — mirrors soul.override semantics)
    {
      const els = installDomStub();
      const m = mockInvoke(SAMPLE_GET_UI);
      const panel = createSettingsPanel({ invoke: m.invoke, surfaceError: () => {} });
      await panel.open();
      els["settings-update-url"].value = "";
      els["settings-save"].listeners.click();
      await tick();
      const setCall = [...m.calls].reverse().find((c: { cmd: string }) => c.cmd === "mai_set_settings");
      assert.ok(setCall, "expected a mai_set_settings call after save click (empty input)");
      assert.equal(
        (setCall.args as { settings: { updateServerUrl: unknown } }).settings.updateServerUrl,
        null,
        "empty updateServerUrl input must send null (clear), not empty string",
      );
    }
  });
});

// ─── T-UI.8 ─────────────────────────────────────────────────────────────────

describe("settings panel — save() rejection (mai_set_settings rejects) calls surfaceError (G-P58d.1-UI.3)", () => {
  // Given: mockInvoke whose mai_set_settings REJECTS (simulates the serve settingsPatchSchema .url() 400
  //        from P-58d.1 T-UpdSettings.5 — the serve-side rejection is already proven; here we assert the UI surfaces it)
  // When:  save() fires (settings-save click listener)
  // Then:  surfaceError is called — the rejection is shown to the operator, not swallowed
  it("T-UI.8: when mai_set_settings rejects, save() calls surfaceError (not swallowed by the try/catch)", async () => {
    if (!createSettingsPanel) assert.fail("createSettingsPanel not loaded — run npm run build:tauri-ui first");

    const els = installDomStub();
    const m = mockInvoke(SAMPLE_GET_UI, "mai_set_settings"); // mai_set_settings rejects
    let surfaceErrorCalled = false;
    const panel = createSettingsPanel({
      invoke: m.invoke,
      surfaceError: (_label: string, _e: unknown) => {
        surfaceErrorCalled = true;
      },
    });
    await panel.open(); // succeeds (mai_get_settings returns SAMPLE_GET_UI)
    els["settings-save"].listeners.click();
    await tick();
    assert.equal(surfaceErrorCalled, true, "surfaceError must be called when mai_set_settings rejects (not swallowed)");
  });
});

// ─── T-UI.9 ─────────────────────────────────────────────────────────────────

describe("settings panel — A-1: open() propagates rejection + app.ts gear handler catches (G-P58d.1-UI.4)", () => {
  // Given: (9a behavioral) mockInvoke whose mai_get_settings REJECTS
  // When:  panel.open()
  // Then:  open() returns a REJECTED promise (assert.rejects passes);
  //        the rejection is NOT swallowed internally — the caller sees it
  // (A-1 guarantee: the gap is the CALL SITE in app.ts, not inside open() — open() already propagates)
  it("T-UI.9a: open() propagates a mai_get_settings rejection (does not swallow internally)", async () => {
    if (!createSettingsPanel) assert.fail("createSettingsPanel not loaded — run npm run build:tauri-ui first");

    installDomStub();
    const m = mockInvoke(SAMPLE_GET_UI, "mai_get_settings"); // mai_get_settings rejects
    const panel = createSettingsPanel({ invoke: m.invoke, surfaceError: () => {} });
    // open() calls load() which awaits invoke("mai_get_settings") → throws → propagates out of open()
    await assert.rejects(
      () => panel.open(),
      (err: Error) => {
        assert.match(err.message, /mock: mai_get_settings rejected/, "rejection message must propagate");
        return true;
      },
    );
  });

  // Given: (9b structural) the app.ts source
  // When:  inspected after builder Step 4b
  // Then:  the settingsGearEl click handler wraps settings.open() with .catch((e) => surfaceError(...))
  //        NOT a bare `void settings.open()` — so a degraded-window (dead-sidecar) rejection on open()
  //        cannot become an unhandled rejection crash
  it("T-UI.9b: app.ts gear handler wraps settings.open() with .catch(→surfaceError) — not bare void [structural]", () => {
    assert.ok(
      APP_TS_SRC.includes("settings.open().catch("),
      "A-1 hardening: app.ts gear handler must call settings.open().catch(…), not bare void settings.open()",
    );
    assert.ok(
      !APP_TS_SRC.includes("void settings.open()"),
      "A-1 hardening: bare `void settings.open()` must be removed from app.ts (replaced by .catch pattern)",
    );
  });
});

// ─── T-UI.10 ────────────────────────────────────────────────────────────────

describe("scope — P-58d.1-UI production changes ⊆ {settings.ts, index.html, app.ts + .js/.map} (G-P58d.1-UI.5)", () => {
  // Given: the git diff after builder Step 4b
  // When:  inspected (git status --porcelain -- src/)
  // Then:  production src/ changes ⊆ {src/tauri/ui/settings.ts, index.html, app.ts + compiled .js/.map};
  //        NO src/tools/** edits; NO Rust/config/serve change;
  //        mai_get_settings / mai_set_settings / mai_check_update are referenced (not renamed/added)
  it("T-UI.10: diff ⊆ {settings.ts, index.html, app.ts + .js/.map}; no src/tools/**; no Rust/config/serve change [structural]", () => {
    // git status --porcelain -- src/ lists uncommitted src/ changes (builder's 4b edits).
    const statusOut = execFileSync("git", ["status", "--porcelain", "--", "src/"], {
      cwd: REPO,
      encoding: "utf-8",
    });

    // Parse: each line is "<XY> <path>" where XY is 2 chars + space = 3-char prefix.
    const changedPaths = statusOut
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.slice(3).trim()); // strip "XY " status prefix

    assert.ok(changedPaths.length > 0, "expected some src/ changes after builder Step 4b (none found)");

    // Every changed path must be under src/tauri/ui/ and match the approved file set.
    // Note: source maps have a two-part extension (.js.map), so we allow both .js.map and bare .map.
    const approvedPattern = /^src\/tauri\/ui\/(settings|app|index)\.(ts|js|html|map|js\.map)$/;
    for (const p of changedPaths) {
      assert.ok(
        approvedPattern.test(p),
        `out-of-scope change: '${p}' — P-58d.1-UI changes must be ⊆ {settings.ts, app.ts, index.html, .js/.map}`,
      );
    }

    // No src/tools/** edits.
    for (const p of changedPaths) {
      assert.ok(!p.startsWith("src/tools/"), `forbidden change in src/tools/: ${p}`);
    }

    // No Rust / config / serve paths.
    const forbiddenPatterns = [/src\/tauri\/src-tauri\//, /src\/persistence\//, /src\/cli\//];
    for (const p of changedPaths) {
      for (const pat of forbiddenPatterns) {
        assert.ok(!pat.test(p), `out-of-scope change in ${p} (Rust/config/serve — not a P-58d.1-UI file)`);
      }
    }

    // All three Tauri commands must be referenced in settings.ts (not renamed).
    assert.ok(
      SETTINGS_TS_SRC.includes('"mai_check_update"'),
      "settings.ts must reference mai_check_update (check for rename)",
    );
    assert.ok(
      SETTINGS_TS_SRC.includes('"mai_get_settings"'),
      "settings.ts must reference mai_get_settings (check for rename)",
    );
    assert.ok(
      SETTINGS_TS_SRC.includes('"mai_set_settings"'),
      "settings.ts must reference mai_set_settings (check for rename)",
    );
  });
});
