/**
 * P-Y2-Magical Step 4a - T-PY2MAG.Mode.1..3 + T-PY2MAG.CSS.1.
 *
 * Badge-only Magical mode contract for the desktop Tauri UI. These tests pin the accepted
 * Step 3 decision: no third Magical tab; Magical is shown by the badge + Observing status
 * while the Manual surface remains available.
 *
 * Run:
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/magical-mode-ui-pY2.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { statusForMode } from "../../src/tauri/ui/mode.js";
import { buildSwitcher } from "../../src/tauri/ui/render.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const UI_DIR = join(REPO, "src", "tauri", "ui");
const APP_TS = readFileSync(join(UI_DIR, "app.ts"), "utf8");
const INDEX_HTML = readFileSync(join(UI_DIR, "index.html"), "utf8");

function fakeTab(initial = "") {
  const classes = new Set<string>(initial.split(" ").filter(Boolean));
  return {
    classList: {
      add: (token: string) => void classes.add(token),
      remove: (token: string) => void classes.delete(token),
      toggle: (token: string, force?: boolean) => {
        const enabled = force ?? !classes.has(token);
        if (enabled) classes.add(token);
        else classes.delete(token);
      },
    },
    textContent: null as string | null,
    setAttribute: (_name: string, _value: string) => undefined,
    has: (token: string) => classes.has(token),
  };
}

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return INDEX_HTML.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? "";
}

describe("P-Y2-Magical desktop mode state (T-PY2MAG.Mode)", () => {
  it('T-PY2MAG.Mode.1: syncModeUi("magical") sets badge text MAGICAL, class "mode-badge magical", and status text Observing', () => {
    // Given: app.ts syncModeUi(mode) and mode.ts statusForMode("magical")
    // When:  the Magical branch is inspected
    // Then:  badge text/class and status text resolve to the accepted Magical contract
    assert.equal(statusForMode("magical").label, "Observing", 'statusForMode("magical") must label the state Observing');
    assert.match(APP_TS, /function syncModeUi\(mode: AppMode\): void \{[\s\S]*statusEl\.textContent = status\.label/, "syncModeUi must write the status label into #status");
    assert.ok(APP_TS.includes('mode === "magical" ? "MAGICAL"'), 'syncModeUi must render MAGICAL badge text for mode === "magical"');
    assert.ok(
      APP_TS.includes("`mode-badge ${mode}`") || APP_TS.includes('"mode-badge magical"'),
      'syncModeUi must set class "mode-badge magical" for Magical mode',
    );
  });

  it("T-PY2MAG.Mode.2: index.html has no #mode-magical-tab; the switcher remains manual + auto only", () => {
    // Given: badge-only Magical mode was accepted at Step 3
    // When:  the desktop switcher markup is inspected
    // Then:  only #mode-manual-tab and #mode-auto-tab exist; no #mode-magical-tab is introduced
    assert.ok(INDEX_HTML.includes('id="mode-manual-tab"'), "manual tab must remain present");
    assert.ok(INDEX_HTML.includes('id="mode-auto-tab"'), "auto tab must remain present");
    assert.ok(!INDEX_HTML.includes("mode-magical-tab"), "Magical must stay badge-only; no mode-magical-tab");
    assert.equal((INDEX_HTML.match(/id="mode-(manual|auto)-tab"/g) ?? []).length, 2, "switcher must remain exactly two mode tabs");
  });

  it('T-PY2MAG.Mode.3: buildSwitcher(manual, auto, "magical") leaves both two-mode tabs inactive', () => {
    // Given: both tabs could have stale active classes before the mode is recomputed
    // When:  buildSwitcher(..., "magical") runs
    // Then:  neither Manual nor Auto is highlighted; Magical is indicated by the badge instead
    const manual = fakeTab("active");
    const auto = fakeTab("active");

    buildSwitcher(manual, auto, "magical");

    assert.equal(manual.has("active"), false, "manual tab must not stay active in Magical mode");
    assert.equal(auto.has("active"), false, "auto tab must not stay active in Magical mode");
  });
});

describe("P-Y2-Magical desktop CSS (T-PY2MAG.CSS.1)", () => {
  it("T-PY2MAG.CSS.1: index.html defines Magical vars and .mode-badge.magical uses green bg/ink/border vars", () => {
    // Given: index.html is the single source for desktop and generated overlay CSS
    // When:  Magical token vars and the .mode-badge.magical rule are inspected
    // Then:  the badge uses the phase-local green token vars rather than the Manual placeholder styling
    for (const expected of [
      "--magical-bg: #E8F0E3",
      "--magical-ink: #3A5A2C",
      "--magical-border: #C5D9BD",
      "--magical-dot: #5A8043",
    ]) {
      assert.ok(INDEX_HTML.includes(expected), `index.html must define ${expected}`);
    }

    const rule = cssRule(".mode-badge.magical");
    assert.match(rule, /color:\s*var\(--magical-ink\)/, "Magical badge text must use --magical-ink");
    assert.match(rule, /background:\s*var\(--magical-bg\)/, "Magical badge background must use --magical-bg");
    assert.match(rule, /border:\s*0\.5px solid var\(--magical-border\)/, "Magical badge border must use --magical-border");
    assert.match(rule, /font-weight:\s*700/, "Magical badge must use the accepted stronger badge weight");
  });
});
