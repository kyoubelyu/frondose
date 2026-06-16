/**
 * P-Y2.2a Step 5 — T-Bundle.1..3 — FILLED.
 *
 * Verifies the inlining infra (plan §6.4-A/B/D): the committed `SHARED_RENDER_JS` IIFE in
 * `src/overlay/sharedRenderBundle.generated.ts` is a clean self-contained bundle exposing the shared
 * render builders on the `__frondoseShared` global, AND a fresh esbuild of `src/overlay/sharedEntry.ts`
 * reproduces the same builder surface (drift guard).
 *
 * ★ LOAD-BEARING (builder 4b drift #1): the gen script resolves NodeNext `.js` imports to their `.ts`
 * source via an onResolve plugin (`scripts/gen-overlay-assets.ts` `tsSourceResolve`), so the bundle
 * reflects the CURRENT render.ts — NOT the committed-but-stale `src/tauri/ui/render.js` (which lacks the
 * new `buildLeafMark`; F-Y5-1 stale-.js class). Without the plugin the overlay leaf logo + compact stage
 * would be MISSING. T-Bundle.3 MIRRORS that plugin so the drift guard reproduces the correct surface.
 *
 * Gate coverage: G-PY2.2a.1 (inlining infra — clean IIFE exposing the shared builders; fresh + drift-guarded).
 *
 * Run (mock): node --import tsx --test --test-force-exit --test-timeout=60000 \
 *   tests/overlay/sharedBundle-pY2.2a.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { SHARED_RENDER_JS } from "../../src/overlay/sharedRenderBundle.generated.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// The 5 builder names the overlay calls (the exported surface — §6.4-F call sites).
const BUILDER_NAMES = ["buildIwfCard", "buildAutoStage", "buildSwitcher", "buildLeafMark", "computeProgress"];

describe("SHARED_RENDER_JS — clean IIFE, not an ES module (G-PY2.2a.1)", () => {
  // Given: the committed SHARED_RENDER_JS string.  When: scanned line-by-line.
  // Then: NO line matches /^\s*(import|export)\b/ (a self-contained IIFE, injectable into the overlay world).
  it("T-Bundle.1: when SHARED_RENDER_JS is scanned line-by-line, no line is a top-level import/export (clean IIFE)", () => {
    assert.ok(SHARED_RENDER_JS.length > 0, "SHARED_RENDER_JS must be non-empty");
    const offenders = SHARED_RENDER_JS.split("\n").filter((l) => /^\s*(import|export)\b/.test(l));
    assert.deepEqual(
      offenders,
      [],
      `bundle must be a self-contained IIFE — no top-level import/export; found ${JSON.stringify(offenders.slice(0, 3))}`,
    );
  });
});

describe("SHARED_RENDER_JS — exposes the shared builders on __frondoseShared (G-PY2.2a.1)", () => {
  // Given: SHARED_RENDER_JS.  When: searched.
  // Then: contains "__frondoseShared" AND each of the 5 builder names (incl. buildLeafMark — the plugin-fix proof).
  it("T-Bundle.2: SHARED_RENDER_JS contains '__frondoseShared' and the 5 builder names (buildIwfCard/buildAutoStage/buildSwitcher/buildLeafMark/computeProgress)", () => {
    assert.ok(SHARED_RENDER_JS.includes("__frondoseShared"), "bundle must define the __frondoseShared global");
    const missing = BUILDER_NAMES.filter((n) => !SHARED_RENDER_JS.includes(n));
    assert.deepEqual(
      missing,
      [],
      `bundle must expose every shared builder; missing ${JSON.stringify(missing)} (buildLeafMark missing ⇒ the .js→.ts plugin regressed)`,
    );
  });
});

describe("fresh esbuild of sharedEntry.ts reproduces the builder surface — drift guard (G-PY2.2a.1)", () => {
  // Given: a FRESH esbuild of sharedEntry.ts mirroring the gen script's tsSourceResolve plugin (so .js
  //        imports resolve to .ts source). When: outputFiles[0].text is scanned.
  // Then: it contains the same 5 builder names (regen after a render.ts edit keeps the contract). Exact-byte
  //       equality is NOT asserted (esbuild-version-fragile). The plugin is load-bearing — see header.
  it("T-Bundle.3: a fresh esbuild of sharedEntry.ts (with the .js→.ts resolve plugin) produces an IIFE containing the same 5 builder names (drift guard)", async () => {
    const tsSourceResolve: Plugin = {
      name: "ts-source-resolve",
      setup(b) {
        b.onResolve({ filter: /\.js$/ }, (args) => {
          if (args.kind === "entry-point" || !args.path.startsWith(".")) return undefined;
          const tsPath = resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
          return existsSync(tsPath) ? { path: tsPath } : undefined;
        });
      },
    };
    const result = await build({
      entryPoints: [resolve(REPO, "src/overlay/sharedEntry.ts")],
      bundle: true,
      format: "iife",
      globalName: "__frondoseShared",
      platform: "browser",
      target: "es2022",
      write: false,
      plugins: [tsSourceResolve],
    });
    const txt = result.outputFiles[0]?.text ?? "";
    assert.ok(txt.includes("__frondoseShared"), "fresh bundle must define __frondoseShared");
    const missing = BUILDER_NAMES.filter((n) => !txt.includes(n));
    assert.deepEqual(missing, [], `fresh esbuild must reproduce every builder; missing ${JSON.stringify(missing)}`);
  });
});
