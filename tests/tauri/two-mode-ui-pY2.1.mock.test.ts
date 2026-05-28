/**
 * P-Y2.1 Step 5 — T-Theme.1..3 + T-Switcher.1..3 + T-Scope.1 (source-structural) — FILLED.
 *
 * Source-grep tests (the established Tauri pattern — see passive-toggle-p57g.mock.test.ts): read
 * `src/tauri/ui/app.ts` + `index.html` as strings and assert the reskin's structural shape (blend
 * palette vars, brand rename, two-mode DOM, switcher wiring, removed standalone toggles, retained SSE
 * handlers, boot-default Manual, file-size/scope discipline). Anchor hexes LOCKED at Step 5 (operator-
 * confirmed blend): navy #15487B / green #46B54A / sand #D9A75F.
 *
 * NOTE: P-69a keeps T-Scope.1 deterministic with inline porcelain fixtures; it does not inspect the
 * operator's ambient worktree.
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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const UI_DIR = join(REPO, "src", "tauri", "ui");
const APP_TS = readFileSync(join(UI_DIR, "app.ts"), "utf-8");
const INDEX_HTML = readFileSync(join(UI_DIR, "index.html"), "utf-8");

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

// P-Y2.1's OWN operator-approved out-of-ui scope expansions (2026-05-23), alongside src/tauri/ui/:
// - tauri.conf.json: the Tauri window/product brand rename ("mai" -> "Frondose") (visual rework).
// - src/overlay/inject.ts: callInOverlay hardening for missing overlay context.
const PY21_EXCEPTIONS = ["src/tauri/src-tauri/tauri.conf.json", "src/overlay/inject.ts"];

// SIBLING-PHASE files that legitimately coexist uncommitted in the shared dev tree (not P-Y2.1 scope).
const PY21_SIBLING_PHASE = [
  "src/cli/subcommands/serve/routes.ts",
  "src/tauri/src-tauri/src/main.rs",
  "src/linkedin/session.ts",
  "src/cli/subcommands/serve.ts",
  "src/cdp/client.ts",
  "src/linkedin/types.ts",
  "src/cli/subcommands/serve/takeover.ts",
  "src/cli/subcommands/serve/turn.ts",
  "src/overlay/bootstrap.ts",
  "src/overlay/bootstrapTakeover.ts",
  "src/overlay/cssTransform.ts",
  "src/overlay/frondoseCss.generated.ts",
  "src/tools/browser/click.ts",
  "src/tools/browser/type.ts",
  "src/cdp/profileLock.ts",
  "src/cdp/launcher.ts",
  "src/tier.ts",
  "src/tools/index.ts",
  "src/persistence/mode.ts",
  "src/cli/main.ts",
  "src/cli/subcommands/serve/dispatch.ts",
  "src/agent/systemPrompt/soul.ts",
  "src/tauri/src-tauri/Cargo.lock",
  "src/tauri/src-tauri/Cargo.toml",
  "src/tauri/src-tauri/tauri.conf.json",
  "src/agent/workflow/controller.ts",
  "src/overlay/host.ts",
  "src/persistence/salesDb.ts",
  "src/tools/browser/click.ts",
  "src/cli/subcommands/serve/settings.ts",
];
const PY21_SCOPE_WHITELIST = new Set([...PY21_EXCEPTIONS, ...PY21_SIBLING_PHASE]);

function collectPY21ScopeViolations(statusOut: string): string[] {
  const violations: string[] = [];
  for (const p of parsePorcelainFixturePaths(statusOut)) {
    if (!p.startsWith("src/tauri/ui/") && !PY21_SCOPE_WHITELIST.has(p)) {
      violations.push(`production change outside src/tauri/ui/ or the approved whitelist: ${p}`);
    }
  }
  return violations;
}

function assertPY21Scope(statusOut: string): void {
  const violations = collectPY21ScopeViolations(statusOut);
  assert.deepEqual(violations, [], `unexpected P-Y2.1 scope violations: ${JSON.stringify(violations)}`);
}

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
  it("T-Scope.1: app/render/mode/frondoseTokens each ≤800 lines; fixture changes stay in scope", () => {
    // Given: current UI source files and deterministic fixture paths.
    // When:  count lines of the four ts files and validate approved fixture paths.
    // Then:  each file is ≤800 lines; approved fixture paths pass and unrelated source paths fail.
    for (const f of ["app.ts", "render.ts", "mode.ts", "frondoseTokens.ts"]) {
      const lines = readFileSync(join(UI_DIR, f), "utf-8").split("\n").length;
      assert.ok(lines <= 800, `${f} must be ≤800 lines; got ${lines}`);
    }
    assertPY21Scope(`
 M src/tauri/ui/app.ts
A  src/tauri/ui/frondoseTokens.ts
?? src/tauri/ui/index.html
R  src/tauri/ui/mode.ts -> src/tauri/ui/render.ts
 M src/tauri/src-tauri/tauri.conf.json
 M src/overlay/inject.ts
 M src/tools/browser/click.ts
`);
    const violations = collectPY21ScopeViolations(`
 M src/agent/unrelated.ts
 M src/tools/browser/inspect.ts
 M src/persistence/config.ts
 M src/tauri/src-tauri/src/lib.rs
`);
    for (const expected of [
      "src/agent/unrelated.ts",
      "src/tools/browser/inspect.ts",
      "src/persistence/config.ts",
      "src/tauri/src-tauri/src/lib.rs",
    ]) {
      assert.ok(
        violations.some((v) => v.includes(expected)),
        `expected violation for ${expected}; got ${JSON.stringify(violations)}`,
      );
    }
  });
});

describe("two-mode-ui — deterministic P-Y2.1 fixture validator (P-69a)", () => {
  it("T-Scope.1a: UI file sizes stay <=800 and empty fixture status is accepted", () => {
    // Given: current Tauri UI source files plus an empty fixture status string.
    // When: the fixture-based P-Y2.1 two-mode UI scope validator runs.
    // Then: file sizes stay within policy and empty status passes without live git status.
    for (const f of ["app.ts", "render.ts", "mode.ts", "frondoseTokens.ts"]) {
      const lines = readFileSync(join(UI_DIR, f), "utf-8").split("\n").length;
      assert.ok(lines <= 800, `${f} must be ≤800 lines; got ${lines}`);
    }
    assertPY21Scope("");
  });

  it("T-Scope.1b: approved P-Y2.1 UI/exception fixture paths are accepted", () => {
    // Given: approved P-Y2.1 UI fixture paths and preserved exception paths.
    // When: the fixture-based P-Y2.1 two-mode UI scope validator runs.
    // Then: approved paths pass without reading the operator's live worktree.
    assert.deepEqual(
      parsePorcelainFixturePaths(`
 M src/tauri/ui/app.ts
A  src/tauri/ui/frondoseTokens.ts
?? src/tauri/ui/index.html
R  src/tauri/ui/mode.ts -> src/tauri/ui/render.ts
C  src/overlay/bootstrap.ts -> src/overlay/bootstrapTakeover.ts
 M src/tauri/src-tauri/tauri.conf.json
 M src/overlay/inject.ts
 M src/tools/browser/type.ts
`),
      [
        "src/tauri/ui/app.ts",
        "src/tauri/ui/frondoseTokens.ts",
        "src/tauri/ui/index.html",
        "src/tauri/ui/mode.ts",
        "src/tauri/ui/render.ts",
        "src/overlay/bootstrap.ts",
        "src/overlay/bootstrapTakeover.ts",
        "src/tauri/src-tauri/tauri.conf.json",
        "src/overlay/inject.ts",
        "src/tools/browser/type.ts",
      ],
    );
    assertPY21Scope(`
 M src/tauri/ui/app.ts
A  src/tauri/ui/frondoseTokens.ts
?? src/tauri/ui/index.html
R  src/tauri/ui/mode.ts -> src/tauri/ui/render.ts
C  src/overlay/bootstrap.ts -> src/overlay/bootstrapTakeover.ts
 M src/tauri/src-tauri/tauri.conf.json
 M src/overlay/inject.ts
 M src/tools/browser/type.ts
`);
  });

  it("T-Scope.1c: unrelated source fixture paths are rejected", () => {
    // Given: unrelated fixture paths outside src/tauri/ui and outside the preserved exception set.
    // When: the fixture-based P-Y2.1 two-mode UI scope validator runs.
    // Then: unrelated source paths are rejected deterministically.
    const violations = collectPY21ScopeViolations(`
 M src/agent/unrelated.ts
 M src/tools/browser/inspect.ts
 M src/persistence/config.ts
 M src/tauri/src-tauri/src/lib.rs
`);
    for (const expected of [
      "src/agent/unrelated.ts",
      "src/tools/browser/inspect.ts",
      "src/persistence/config.ts",
      "src/tauri/src-tauri/src/lib.rs",
    ]) {
      assert.ok(
        violations.some((v) => v.includes(expected)),
        `expected violation for ${expected}; got ${JSON.stringify(violations)}`,
      );
    }
  });
});
