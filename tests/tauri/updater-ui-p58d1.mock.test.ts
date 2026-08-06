/**
 * P-58d.1-UI Step 5 — T-UI.5–10 — [assertion bodies FILLED]
 *
 * UI layer for the P-58d.1 updater: "Update server URL" input + "Check for updates" button
 * in the Frondose Settings panel, wired to existing `frondose_get_settings` / `frondose_set_settings` /
 * `frondose_check_update` Tauri commands (all shipped in P-58d.1). A-1: gear handler wrapped with
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
 *   G-P58d.1-UI.1 ↦ T-UI.5  (button invokes frondose_check_update)
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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Read source files at module level — used in structural assertions (T-UI.9b, T-UI.10).
const APP_TS_SRC = readFileSync(join(REPO, "src", "tauri", "ui", "app.ts"), "utf-8");
const SETTINGS_TS_SRC = readFileSync(join(REPO, "src", "tauri", "ui", "settings.ts"), "utf-8");

function parsePorcelainFixturePaths(statusOut: string): string[] {
  return statusOut
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const path = line.slice(3).trim();
      return path.includes(" -> ") ? path.split(" -> ") : [path];
    })
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
}

const P58D1_UI_APPROVED_PATTERN = /^src\/tauri\/ui\/(settings|app|index)\.(ts|js|html|map|js\.map)$/;
const P58D1_UI_APPROVED_SIBLING_CHANGES = new Set([
  "src/agent/systemPrompt/soul.ts", // P-66 approved Soul trigger-habit wording rebaseline
  "src/tauri/src-tauri/Cargo.lock",
  "src/tauri/src-tauri/Cargo.toml",
  "src/tauri/src-tauri/tauri.conf.json",
  "src/agent/workflow/controller.ts", // P-67 accepted workflow lint invariant cleanup
  "src/overlay/host.ts", // P-67 accepted formatter-only overlay cleanup
  "src/persistence/salesDb.ts", // P-67 accepted formatter-only persistence cleanup
  "src/tools/browser/click.ts", // P-67 accepted formatter-only browser-tool cleanup
]);

function collectP58d1UiScopeViolations(statusOut: string): string[] {
  const violations: string[] = [];
  const changedPaths = parsePorcelainFixturePaths(statusOut);
  for (const p of changedPaths) {
    if (!P58D1_UI_APPROVED_PATTERN.test(p) && !P58D1_UI_APPROVED_SIBLING_CHANGES.has(p)) {
      violations.push(
        `out-of-scope change: '${p}' — P-58d.1-UI changes must be in settings.ts, app.ts, index.html, or approved siblings`,
      );
    }
    if (p.startsWith("src/tools/") && p !== "src/tools/browser/click.ts") {
      violations.push(`forbidden change in src/tools/ except P-67 formatter-only click.ts: ${p}`);
    }
    if (P58D1_UI_APPROVED_SIBLING_CHANGES.has(p)) continue;
    for (const pat of [/src\/tauri\/src-tauri\//, /src\/persistence\//, /src\/cli\//]) {
      if (pat.test(p)) {
        violations.push(`out-of-scope change in ${p} (Rust/config/serve — not a P-58d.1-UI file)`);
      }
    }
  }
  return violations;
}

function assertP58d1UiScope(statusOut: string): void {
  const violations = collectP58d1UiScopeViolations(statusOut);
  assert.deepEqual(violations, [], `unexpected P-58d.1-UI scope violations: ${JSON.stringify(violations)}`);
}

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
 * - `frondose_get_settings` returns `getResp`.
 * - Other commands return `{ ok: true }` unless `rejectCmd` matches — used for T-UI.8 + T-UI.9a.
 */
function mockInvoke(getResp: Record<string, unknown>, rejectCmd?: string) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (rejectCmd && cmd === rejectCmd) throw new Error(`mock: ${cmd} rejected`);
    return cmd === "frondose_get_settings" ? getResp : { ok: true };
  };
  return { invoke, calls };
}

/** Sample frondose_get_settings response including the P-58d.1 updateServerUrl field. */
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

describe("settings panel — 'Check for updates' button calls invoke('frondose_check_update') (G-P58d.1-UI.1)", () => {
  // Given: createSettingsPanel({invoke: mockInvoke, surfaceError}) with DOM stub including settings-check-update
  // When:  the settings-check-update click listener fires
  // Then:  invoke was called with cmd === "frondose_check_update" (proving the button is wired to the shipped command)
  it("T-UI.5: clicking the settings-check-update button calls invoke with cmd='frondose_check_update'", async () => {
    if (!createSettingsPanel) assert.fail("createSettingsPanel not loaded — run npm run build:tauri-ui first");
    const els = installDomStub();
    const m = mockInvoke(SAMPLE_GET_UI);
    createSettingsPanel({ invoke: m.invoke, surfaceError: () => {} });
    // Fire the check-update click (checkUpdate() is async; tick() lets microtasks settle).
    els["settings-check-update"].listeners.click();
    await tick();
    assert.ok(
      m.calls.some((c: { cmd: string }) => c.cmd === "frondose_check_update"),
      `expected a frondose_check_update call; got: ${JSON.stringify(m.calls.map((c: { cmd: string }) => c.cmd))}`,
    );
  });
});

// ─── T-UI.6 ─────────────────────────────────────────────────────────────────

describe("settings panel — open() populates settings-update-url from frondose_get_settings (G-P58d.1-UI.2)", () => {
  // Given: mock frondose_get_settings returning updateServerUrl: "http://192.168.1.50:8765"
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

describe("settings panel — save() sends updateServerUrl in the frondose_set_settings patch (G-P58d.1-UI.2)", () => {
  // Given: panel after open(); els["settings-update-url"].value = "http://host:8765"
  // When:  save() fires (settings-save click listener)
  // Then:  the last frondose_set_settings call's args.settings.updateServerUrl === "http://host:8765"
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
      const setCall = [...m.calls].reverse().find((c: { cmd: string }) => c.cmd === "frondose_set_settings");
      assert.ok(setCall, "expected a frondose_set_settings call after save click");
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
      const setCall = [...m.calls].reverse().find((c: { cmd: string }) => c.cmd === "frondose_set_settings");
      assert.ok(setCall, "expected a frondose_set_settings call after save click (empty input)");
      assert.equal(
        (setCall.args as { settings: { updateServerUrl: unknown } }).settings.updateServerUrl,
        null,
        "empty updateServerUrl input must send null (clear), not empty string",
      );
    }
  });
});

// ─── T-UI.8 ─────────────────────────────────────────────────────────────────

describe("settings panel — save() rejection (frondose_set_settings rejects) calls surfaceError (G-P58d.1-UI.3)", () => {
  // Given: mockInvoke whose frondose_set_settings REJECTS (simulates the serve settingsPatchSchema .url() 400
  //        from P-58d.1 T-UpdSettings.5 — the serve-side rejection is already proven; here we assert the UI surfaces it)
  // When:  save() fires (settings-save click listener)
  // Then:  surfaceError is called — the rejection is shown to the operator, not swallowed
  it("T-UI.8: when frondose_set_settings rejects, save() calls surfaceError (not swallowed by the try/catch)", async () => {
    if (!createSettingsPanel) assert.fail("createSettingsPanel not loaded — run npm run build:tauri-ui first");

    const els = installDomStub();
    const m = mockInvoke(SAMPLE_GET_UI, "frondose_set_settings"); // frondose_set_settings rejects
    let surfaceErrorCalled = false;
    const panel = createSettingsPanel({
      invoke: m.invoke,
      surfaceError: (_label: string, _e: unknown) => {
        surfaceErrorCalled = true;
      },
    });
    await panel.open(); // succeeds (frondose_get_settings returns SAMPLE_GET_UI)
    els["settings-save"].listeners.click();
    await tick();
    assert.equal(
      surfaceErrorCalled,
      true,
      "surfaceError must be called when frondose_set_settings rejects (not swallowed)",
    );
  });
});

// ─── T-UI.9 ─────────────────────────────────────────────────────────────────

describe("settings panel — A-1: open() propagates rejection + app.ts gear handler catches (G-P58d.1-UI.4)", () => {
  // Given: (9a behavioral) mockInvoke whose frondose_get_settings REJECTS
  // When:  panel.open()
  // Then:  open() returns a REJECTED promise (assert.rejects passes);
  //        the rejection is NOT swallowed internally — the caller sees it
  // (A-1 guarantee: the gap is the CALL SITE in app.ts, not inside open() — open() already propagates)
  it("T-UI.9a: open() propagates a frondose_get_settings rejection (does not swallow internally)", async () => {
    if (!createSettingsPanel) assert.fail("createSettingsPanel not loaded — run npm run build:tauri-ui first");

    installDomStub();
    const m = mockInvoke(SAMPLE_GET_UI, "frondose_get_settings"); // frondose_get_settings rejects
    const panel = createSettingsPanel({ invoke: m.invoke, surfaceError: () => {} });
    // open() calls load() which awaits invoke("frondose_get_settings") → throws → propagates out of open()
    await assert.rejects(
      () => panel.open(),
      (err: Error) => {
        assert.match(err.message, /mock: frondose_get_settings rejected/, "rejection message must propagate");
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

describe("scope — P-58d.1-UI production fixture changes stay within the UI allowlist (G-P58d.1-UI.5)", () => {
  // Given: deterministic modified/added/untracked/rename fixture lines for approved P-58d.1-UI paths.
  // When:  the fixture scope validator parses them.
  // Then:  approved UI and sibling paths pass; forbidden tool/CLI/config/Rust paths fail; command names remain referenced.
  it("T-UI.10: fixture scope stays within UI files; no src/tools/Rust/config/serve escape [structural]", () => {
    assertP58d1UiScope(`
 M src/tauri/ui/settings.ts
A  src/tauri/ui/app.js
?? src/tauri/ui/index.html
R  src/tauri/ui/settings.js -> src/tauri/ui/settings.js.map
 M src/agent/systemPrompt/soul.ts
 M src/tools/browser/click.ts
`);
    const violations = collectP58d1UiScopeViolations(`
 M src/tools/browser/inspect.ts
 M src/cli/main.ts
 M src/persistence/config.ts
 M src/tauri/src-tauri/src/main.rs
`);
    assert.ok(
      violations.some((v) => v.includes("src/tools/browser/inspect.ts")),
      `expected src/tools violation; got ${JSON.stringify(violations)}`,
    );
    assert.ok(
      violations.some((v) => v.includes("src/cli/main.ts")),
      `expected CLI violation; got ${JSON.stringify(violations)}`,
    );
    assert.ok(
      violations.some((v) => v.includes("src/persistence/config.ts")),
      `expected config violation; got ${JSON.stringify(violations)}`,
    );
    assert.ok(
      violations.some((v) => v.includes("src/tauri/src-tauri/src/main.rs")),
      `expected Rust violation; got ${JSON.stringify(violations)}`,
    );

    assert.ok(
      SETTINGS_TS_SRC.includes('"frondose_check_update"'),
      "settings.ts must reference frondose_check_update (check for rename)",
    );
    assert.ok(
      SETTINGS_TS_SRC.includes('"frondose_get_settings"'),
      "settings.ts must reference frondose_get_settings (check for rename)",
    );
    assert.ok(
      SETTINGS_TS_SRC.includes('"frondose_set_settings"'),
      "settings.ts must reference frondose_set_settings (check for rename)",
    );
  });
});

describe("scope — deterministic P-58d.1-UI fixture validator (P-69a)", () => {
  it("T-UI.10a: empty fixture status is accepted; shipped updater command names remain referenced", () => {
    // Given: an empty fixture status string and current settings.ts source.
    // When: the fixture-based P-58d.1-UI scope validator runs.
    // Then: empty status passes and settings.ts still references the shipped updater commands.
    assertP58d1UiScope("");
    assert.ok(
      SETTINGS_TS_SRC.includes('"frondose_check_update"'),
      "settings.ts must reference frondose_check_update (check for rename)",
    );
    assert.ok(
      SETTINGS_TS_SRC.includes('"frondose_get_settings"'),
      "settings.ts must reference frondose_get_settings (check for rename)",
    );
    assert.ok(
      SETTINGS_TS_SRC.includes('"frondose_set_settings"'),
      "settings.ts must reference frondose_set_settings (check for rename)",
    );
  });

  it("T-UI.10b: approved P-58d.1 UI fixture paths are accepted", () => {
    // Given: approved updater UI fixture paths and preserved sibling exceptions.
    // When: the fixture-based P-58d.1-UI scope validator runs.
    // Then: approved paths pass without reading the operator's live worktree.
    assert.deepEqual(
      parsePorcelainFixturePaths(`
 M src/tauri/ui/settings.ts
A  src/tauri/ui/app.ts
?? src/tauri/ui/index.html
C  src/tauri/ui/app.js -> src/tauri/ui/app.js.map
 M src/agent/workflow/controller.ts
 M src/overlay/host.ts
 M src/persistence/salesDb.ts
 M src/tools/browser/click.ts
`),
      [
        "src/tauri/ui/settings.ts",
        "src/tauri/ui/app.ts",
        "src/tauri/ui/index.html",
        "src/tauri/ui/app.js",
        "src/tauri/ui/app.js.map",
        "src/agent/workflow/controller.ts",
        "src/overlay/host.ts",
        "src/persistence/salesDb.ts",
        "src/tools/browser/click.ts",
      ],
    );
    assertP58d1UiScope(`
 M src/tauri/ui/settings.ts
A  src/tauri/ui/app.ts
?? src/tauri/ui/index.html
C  src/tauri/ui/app.js -> src/tauri/ui/app.js.map
 M src/agent/workflow/controller.ts
 M src/overlay/host.ts
 M src/persistence/salesDb.ts
 M src/tools/browser/click.ts
`);
  });

  it("T-UI.10c: forbidden non-UI fixture paths are rejected", () => {
    // Given: forbidden fixture paths under src/tools, src/cli, src/persistence, and non-exception Rust paths.
    // When: the fixture-based P-58d.1-UI scope validator runs.
    // Then: forbidden paths fail with clear out-of-scope diagnostics.
    const violations = collectP58d1UiScopeViolations(`
 M src/tools/browser/type.ts
 M src/app/backend/settings.ts
 M src/persistence/config.ts
 M src/tauri/src-tauri/src/main.rs
 M src/agent/unrelated.ts
`);
    for (const expected of [
      "src/tools/browser/type.ts",
      "src/app/backend/settings.ts",
      "src/persistence/config.ts",
      "src/tauri/src-tauri/src/main.rs",
      "src/agent/unrelated.ts",
    ]) {
      assert.ok(
        violations.some((v) => v.includes(expected)),
        `expected violation for ${expected}; got ${JSON.stringify(violations)}`,
      );
    }
  });
});
