/**
 * P-Y2-Magical Step 4a - T-PY2MAG.CSS.2 + Card.1 + Scope.1 + Generated.1.
 *
 * Overlay contract tests for the badge-only Magical visual delta. The generated CSS test runs
 * the overlay asset build in a temp copy so it does not edit production generated artifacts.
 *
 * Run:
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/overlay/magical-css-card-pY2.mock.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { FRONDOSE_CSS } from "../../src/overlay/frondoseCss.generated.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEX_HTML = readFileSync(join(REPO, "src", "tauri", "ui", "index.html"), "utf8");
const SHELL_TS = readFileSync(join(REPO, "src", "overlay", "bootstrapShell.ts"), "utf8");
const LEGACY_TS = readFileSync(join(REPO, "src", "overlay", "bootstrapLegacy.ts"), "utf8");
const SHARED_BUNDLE_TS = readFileSync(join(REPO, "src", "overlay", "sharedRenderBundle.generated.ts"), "utf8");
const GENERATED_CSS_TS = readFileSync(join(REPO, "src", "overlay", "frondoseCss.generated.ts"), "utf8");
const CSS_TRANSFORM_TS = readFileSync(join(REPO, "src", "overlay", "cssTransform.ts"), "utf8");

function copyIntoTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "p-y2-magical-gen-"));
  // P-72 slice 12: render.ts is now a pure re-export barrel; the render/ leaves must be copied too
  for (const dir of ["scripts", "src/overlay", "src/tauri/ui", "src/tauri/ui/render"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  for (const file of [
    "package.json",
    "scripts/gen-overlay-assets.ts",
    "src/overlay/cssTransform.ts",
    "src/overlay/sharedEntry.ts",
    "src/tauri/ui/frondoseTokens.ts",
    "src/tauri/ui/mode.ts",
    "src/tauri/ui/render.ts",
    "src/tauri/ui/index.html",
  ]) {
    copyFileSync(join(REPO, file), join(root, file));
  }
  // Copy the render/ leaf .ts files (barrel delegates to these; esbuild bundles from .ts source)
  const renderDir = join(REPO, "src/tauri/ui/render");
  for (const entry of readdirSync(renderDir)) {
    if (entry.endsWith(".ts")) {
      copyFileSync(join(renderDir, entry), join(root, "src/tauri/ui/render", entry));
    }
  }
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  return root;
}

describe("P-Y2-Magical generated overlay CSS (T-PY2MAG.CSS.2)", () => {
  it("T-PY2MAG.CSS.2: FRONDOSE_CSS contains transformed Magical badge vars/rule and any source Magical status-dot rule", () => {
    // Given: src/tauri/ui/index.html feeds frondoseCss.generated.ts through cssTransform.ts
    // When:  the generated shadow CSS is inspected
    // Then:  Magical badge styling is present in shadow form, and status-dot parity is preserved if sourced
    for (const expected of [
      "--magical-bg: #E8F0E3",
      "--magical-ink: #3A5A2C",
      "--magical-border: #C5D9BD",
      "--magical-dot: #5A8043",
    ]) {
      assert.ok(FRONDOSE_CSS.includes(expected), `FRONDOSE_CSS must include ${expected}`);
    }
    assert.match(
      FRONDOSE_CSS,
      /\.mode-badge\.magical\s*\{[^}]*color:\s*var\(--magical-ink\)[^}]*background:\s*var\(--magical-bg\)[^}]*border:\s*0\.5px solid var\(--magical-border\)/s,
      "generated CSS must carry the transformed Magical badge rule",
    );

    const sourceHasStatusDot =
      /body\.mode-magical\s+\.status-dot/.test(INDEX_HTML) ||
      /:host\(\.mode-magical\)\s+\.status-dot/.test(CSS_TRANSFORM_TS);
    if (sourceHasStatusDot) {
      assert.match(
        FRONDOSE_CSS,
        /:host\(\.mode-magical\)\s+\.status-dot\s*\{[^}]*var\(--magical-dot\)/s,
        "source Magical status-dot rule must be transformed to :host(.mode-magical) .status-dot",
      );
    }
  });
});

describe("P-Y2-Magical collapsed suggestion card (T-PY2MAG.Card.1)", () => {
  it("T-PY2MAG.Card.1: bootstrapLegacy.ts collapsed card inline style uses border-left:4px solid #5A8043", () => {
    // Given: passive suggest_card renders the collapsed float through bootstrapLegacy.ts
    // When:  the inline cssText is inspected
    // Then:  the left border uses Frondose green, not the old blue border
    assert.ok(
      LEGACY_TS.includes("border-left:4px solid #5A8043"),
      "collapsed suggest_card float must use Magical/Frondose green left border",
    );
    assert.ok(
      !LEGACY_TS.includes("border-left:4px solid #15487B"),
      "collapsed suggest_card float must not keep the old navy/blue left border",
    );
  });
});

describe("P-Y2-Magical badge-only scope (T-PY2MAG.Scope.1)", () => {
  it("T-PY2MAG.Scope.1: no mode-magical-tab appears in index.html, bootstrapShell.ts, or generated shared bundle", () => {
    // Given: Step 3 accepted badge-only Magical UI
    // When:  desktop, overlay shell, and generated shared bundle are scanned
    // Then:  no third tab DOM id is present anywhere in the UI surfaces
    for (const [label, source] of [
      ["src/tauri/ui/index.html", INDEX_HTML],
      ["src/overlay/bootstrapShell.ts", SHELL_TS],
      ["src/overlay/sharedRenderBundle.generated.ts", SHARED_BUNDLE_TS],
    ] as const) {
      assert.ok(!source.includes("mode-magical-tab"), `${label} must not contain mode-magical-tab`);
    }
  });
});

describe("P-Y2-Magical generated CSS freshness (T-PY2MAG.Generated.1)", () => {
  it("T-PY2MAG.Generated.1: fresh build:overlay-assets output for frondoseCss.generated.ts equals the committed artifact", () => {
    // Given: a temp copy of the overlay asset generation inputs
    // When:  npm run build:overlay-assets runs there
    // Then:  its generated frondoseCss.generated.ts is byte-identical to the repo artifact
    const tempRepo = copyIntoTempRepo();
    execFileSync("npm", ["run", "build:overlay-assets", "--silent"], {
      cwd: tempRepo,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: join(tempRepo, ".npm-cache") },
    });
    const fresh = readFileSync(join(tempRepo, "src", "overlay", "frondoseCss.generated.ts"), "utf8");
    assert.equal(fresh, GENERATED_CSS_TS, "frondoseCss.generated.ts must match a fresh build:overlay-assets output");
  });
});
