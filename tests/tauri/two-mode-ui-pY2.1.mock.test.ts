/**
 * P-Y2.1 Step 5 — T-Theme.1..3 + T-Switcher.1..3 + T-Scope.1 (source-structural) — FILLED.
 *
 * Source-grep tests (the established Tauri pattern — see passive-toggle-p57g.mock.test.ts): read
 * `src/tauri/ui/app.ts` + `index.html` as strings and assert the reskin's structural shape (blend
 * palette vars, brand rename, two-mode DOM, switcher wiring, removed standalone toggles, retained SSE
 * handlers, boot-default Manual, file-size/scope discipline). Anchor hexes LOCKED at Step 5 (operator-
 * confirmed blend): navy #15487B / green #46B54A / sand #D9A75F.
 *
 * NOTE: T-Scope.1 uses node:child_process (git) — validator-owned test files are exempt from the
 * child_process lint ban (applies only to src/tools/**) per CLAUDE.md § Code & Test Policy.
 *
 * Gate coverage:
 *   G-PY2.1.1/.6 — blend palette vars + Inter, no legacy hex, var()-only; brand rename (T-Theme.1, .2)
 *   G-PY2.1.4/.5 — two-mode DOM scaffold (T-Theme.3)
 *   G-PY2.1.3/.2 — switcher drives both existing invokes; toggles removed, SSE retained; boot Manual (T-Switcher.1..3)
 *   G-PY2.1.8 — file sizes ≤800 + write-range scope (T-Scope.1)
 *
 * Run (mock): node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *   --test-timeout=30000 tests/tauri/two-mode-ui-pY2.1.mock.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const UI_DIR = join(REPO, "src", "tauri", "ui");
const APP_TS = readFileSync(join(UI_DIR, "app.ts"), "utf-8");
const INDEX_HTML = readFileSync(join(UI_DIR, "index.html"), "utf-8");

describe("two-mode-ui — theme + brand reskin in index.html (G-PY2.1.1, G-PY2.1.6)", () => {
  it("T-Theme.1: index.html :root has the blend palette vars (navy/green/sand) + Inter, NO legacy #0a66c2, components var()-only", () => {
    // Given: index.html
    // When:  grepped
    // Then:  :root defines blend anchors; 'Inter' in font stack; legacy '#0a66c2' ABSENT; raw hex ONLY on --var defs (components use var(--))
    assert.ok(INDEX_HTML.includes(":root"), "index.html must define a :root token block");
    assert.ok(INDEX_HTML.includes("--brand-600: #15487B"), "--brand-600 must be navy #15487B");
    assert.ok(INDEX_HTML.includes("--success: #46B54A"), "--success must be green #46B54A");
    assert.ok(INDEX_HTML.includes("--accent-500: #D9A75F"), "--accent-500 must be sand #D9A75F");
    assert.ok(INDEX_HTML.includes("#161A14"), "dark surface #161A14 must be present");
    assert.ok(INDEX_HTML.includes("#F4F2EB"), "light surface #F4F2EB must be present");
    assert.ok(/font-family:[^;]*"Inter"/.test(INDEX_HTML), "Inter must be in the font stack");
    assert.ok(!INDEX_HTML.includes("#0a66c2"), "legacy LinkedIn blue #0a66c2 must be ABSENT");
    assert.ok(INDEX_HTML.includes("var(--"), "component rules must reference var(--token)");
    // var()-only: every raw 6-digit hex must sit on a custom-property (--name:) definition line.
    const stray = INDEX_HTML.split("\n").filter((l) => /#[0-9A-Fa-f]{6}/.test(l) && !/--[\w-]+\s*:/.test(l));
    assert.equal(stray.length, 0, `raw hex must appear ONLY on --var defs; stray lines: ${JSON.stringify(stray)}`);
  });

  it("T-Theme.2: brand renamed Frondose (title + mark-crop <img> + wordmark + both SVGs exist); bundle-id/mai_* UNCHANGED", () => {
    // Given: src/tauri/ui/
    // When:  grepped + asset existence checked
    // Then:  <title>Frondose; brand bar mark-crop <img src="./frondose-logo-mark.svg">; both SVGs exist; wordmark 'Frondose'; NO 'com.kyoube.frondose'; mai_* invokes unchanged
    assert.ok(/<title>\s*Frondose\s*<\/title>/.test(INDEX_HTML), "<title> must be Frondose");
    assert.ok(INDEX_HTML.includes('src="./frondose-logo-mark.svg"'), "brand bar must use the mark-crop <img>");
    assert.ok(existsSync(join(UI_DIR, "frondose-logo-mark.svg")), "frondose-logo-mark.svg must exist");
    assert.ok(existsSync(join(UI_DIR, "frondose-logo.svg")), "frondose-logo.svg (full lockup) must exist");
    assert.ok(/>\s*Frondose\s*</.test(INDEX_HTML), "the 'Frondose' wordmark text must be present");
    assert.ok(!INDEX_HTML.includes("com.kyoube.frondose"), "bundle-id must NOT be renamed (no com.kyoube.frondose)");
    assert.ok(
      APP_TS.includes("mai_set_cron_mode") && APP_TS.includes("mai_set_passive_mode"),
      "mai_* invoke names unchanged",
    );
  });

  it("T-Theme.3: index.html has the two-mode DOM scaffold (switcher tabs, #auto-stage, retained #workflow-* IDs)", () => {
    // Given: index.html
    // When:  grepped
    // Then:  #mode-manual-tab, #mode-auto-tab, #auto-stage present + retained #workflow-card/#workflow-steps/#workflow-approve-btn/#workflow-handoff-btn
    for (const id of [
      'id="mode-manual-tab"',
      'id="mode-auto-tab"',
      'id="auto-stage"',
      'id="workflow-card"',
      'id="workflow-steps"',
      'id="workflow-approve-btn"',
      'id="workflow-handoff-btn"',
    ]) {
      assert.ok(INDEX_HTML.includes(id), `index.html must contain ${id}`);
    }
  });
});

describe("two-mode-ui — switcher wiring in app.ts (G-PY2.1.3, G-PY2.1.2, G-PY2.1.7)", () => {
  it("T-Switcher.1: applyMode invokes BOTH existing handlers from togglesForMode(mode); tab listeners call applyMode; NO new mai_set_mode", () => {
    // Given: app.ts
    // When:  inspected
    // Then:  applyMode invokes mai_set_cron_mode + mai_set_passive_mode (from togglesForMode); tabs → applyMode('manual')/('auto'); no mai_set_mode
    assert.ok(/async function applyMode/.test(APP_TS), "applyMode must be defined");
    assert.ok(
      APP_TS.includes('invoke<{ ok: boolean; cronEnabled?: boolean }>("mai_set_cron_mode"') ||
        /invoke[^\n]*"mai_set_cron_mode"/.test(APP_TS),
      "applyMode must invoke mai_set_cron_mode",
    );
    assert.ok(/invoke[^\n]*"mai_set_passive_mode"/.test(APP_TS), "applyMode must invoke mai_set_passive_mode");
    assert.ok(APP_TS.includes("togglesForMode(mode)"), "the invokes must derive from togglesForMode(mode)");
    assert.ok(
      APP_TS.includes('applyMode("manual")') && APP_TS.includes('applyMode("auto")'),
      "tab listeners must call applyMode('manual')/('auto')",
    );
    assert.ok(!APP_TS.includes("mai_set_mode"), "NO new mai_set_mode invoke (reuse the two existing handlers)");
  });

  it("T-Switcher.2: standalone toggles GONE; cron-mode/passive-mode SSE handlers RETAINED", () => {
    // Given: app.ts + index.html
    // When:  grepped
    // Then:  #auto-mode-toggle/#passive-mode-toggle/toggleAutoMode/togglePassiveMode/'Auto-mode:'/'Magical click:' ABSENT; case 'cron-mode'/'passive-mode' SSE RETAINED
    for (const gone of [
      "auto-mode-toggle",
      "passive-mode-toggle",
      "toggleAutoMode",
      "togglePassiveMode",
      "Auto-mode:",
      "Magical click:",
    ]) {
      assert.ok(
        !APP_TS.includes(gone) && !INDEX_HTML.includes(gone),
        `standalone-toggle vestige '${gone}' must be removed`,
      );
    }
    assert.ok(APP_TS.includes('case "cron-mode"'), "cron-mode SSE handler must REMAIN");
    assert.ok(APP_TS.includes('case "passive-mode"'), "passive-mode SSE handler must REMAIN");
  });

  it("T-Switcher.3: boot applies Manual at startup — an applyMode('manual') call follows loadIdentity() (supervised default → cron OFF + passive OFF)", () => {
    // Given: app.ts
    // When:  inspected
    // Then:  a boot-time applyMode('manual') follows loadIdentity() (supervised default). NOTE: applyMode('manual')
    //        also legitimately appears as the Manual-tab click listener — so we assert the BOOT ORDERING
    //        (last applyMode('manual') occurrence is after loadIdentity), not a file-wide count.
    const idIdx = APP_TS.indexOf("loadIdentity()");
    const bootManualIdx = APP_TS.lastIndexOf('applyMode("manual")');
    assert.ok(idIdx >= 0, "boot must call loadIdentity()");
    assert.ok(bootManualIdx > idIdx, "a boot applyMode('manual') call must follow loadIdentity() (supervised default)");
    // The Auto path is reachable only via the tab/SSE, never at boot — boot is Manual-only.
    assert.ok(
      APP_TS.includes('await applyMode("manual")') || APP_TS.includes('void applyMode("manual")'),
      "boot default applyMode('manual') must be present",
    );
  });
});

describe("two-mode-ui — scope + size discipline (G-PY2.1.8)", () => {
  it("T-Scope.1: app/render/mode/frondoseTokens each ≤800 lines; production diff confined to src/tauri/ui/", () => {
    // Given: the repo after builder B6
    // When:  count lines of the four ts files + list changed src/ paths via git
    // Then:  each ≤800; every changed/added src/ path is under src/tauri/ui/ — no serve/main.rs/overlay/tools
    for (const f of ["app.ts", "render.ts", "mode.ts", "frondoseTokens.ts"]) {
      const lines = readFileSync(join(UI_DIR, f), "utf-8").split("\n").length;
      assert.ok(lines <= 800, `${f} must be ≤800 lines; got ${lines}`);
    }
    // Operator-approved scope expansions (P-Y2.1, 2026-05-23), whitelisted alongside src/tauri/ui/:
    //  - tauri.conf.json: the Tauri window/product brand rename ("mai" → "Frondose") (visual rework).
    //  - src/overlay/inject.ts: the functional-hardening fix (callInOverlay try/catch so a missing
    //    overlay context no longer spams unhandled "Cannot find context" rejections during cron turns).
    const SCOPE_WHITELIST = new Set(["src/tauri/src-tauri/tauri.conf.json", "src/overlay/inject.ts"]);
    const status = execFileSync("git", ["status", "--porcelain", "--", "src/"], { cwd: REPO, encoding: "utf-8" });
    const srcPaths = status
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter((p) => p.length > 0)
      .flatMap((p) => (p.includes(" -> ") ? p.split(" -> ") : [p]));
    for (const p of srcPaths) {
      assert.ok(
        p.startsWith("src/tauri/ui/") || SCOPE_WHITELIST.has(p),
        `production change outside src/tauri/ui/ (or the approved whitelist) is out of scope: ${p}`,
      );
    }
  });
});
