/**
 * P-58a Step 4a — T-Build.1..2 + T-Release.1 + T-Version.1 + T-Reconcile.1..2 + T-Repush.1 — SCAFFOLD
 * (assertion bodies = TODO; intentionally RED).
 *
 * Build-hygiene + reconcile/re-push (plan §6.4-J/K/L/M + H2/H3 + I): the stale-dist no-paint root-cause fixes —
 * `build:tauri` regenerates the overlay assets, an `assert-dist` guard (findMissingDistMarkers), conditional
 * `--prerelease` for pre-release tags, the tauri/package version-drift guard — plus the desktop reconcile
 * (initial cron-mode SSE frame + boot syncModeUi, not force-POST Manual) and the ring re-push on mid-Auto ctxId.
 *
 * LOAD: MIXED. T-Build.1/T-Release.1/T-Version.1/T-Reconcile.1-2/T-Repush.1 are STRUCTURAL (read package.json /
 * release.yml / tauri.conf.json / routes.ts / app.ts — LOADS NOW). T-Build.2 imports `findMissingDistMarkers`
 * from `scripts/assert-dist.ts` (NEW, builder 4b B5) → GATE-ON-BUILDER (dynamic import).
 * ⚠ BUILDER NOTE (T-Build.2): the assert-dist top-level main calls `process.exit(1)` — it MUST be guarded
 * (e.g. `if (process.argv[1]?.endsWith("assert-dist.ts"|".js"))`) so importing `findMissingDistMarkers` has NO
 * side effect / never exits the test process. The pure fn is the unit under test.
 *
 * Gate coverage: G-P58a.2 (build path + assert-dist), .3 (release prerelease), .4 (version drift),
 *   .7 (reconcile: initial frame + boot syncModeUi), .8 (ring re-push).
 *
 * Run (mock): node --import tsx --test --test-force-exit --test-timeout=30000 \
 *   tests/build/hygiene-p58a.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG = readFileSync(join(REPO, "package.json"), "utf8");
const TAURI_CONF = readFileSync(join(REPO, "src", "tauri", "src-tauri", "tauri.conf.json"), "utf8");
const RELEASE_YML = readFileSync(join(REPO, ".github", "workflows", "release.yml"), "utf8");
const ROUTES_TS = readFileSync(join(REPO, "src", "cli", "subcommands", "serve", "routes.ts"), "utf8");
// P-72 slice 6: sseClients.add + cron-mode frame moved to routes/events.ts
const ROUTES_EVENTS_TS = readFileSync(join(REPO, "src", "cli", "subcommands", "serve", "routes", "events.ts"), "utf8");
// P-72 slice 6: showEdgeRing ctxId callback moved to routes/cdp.ts
const ROUTES_CDP_TS = readFileSync(join(REPO, "src", "cli", "subcommands", "serve", "routes", "cdp.ts"), "utf8");
const APP_TS = readFileSync(join(REPO, "src", "tauri", "ui", "app.ts"), "utf8");

// gate-on-builder: scripts/assert-dist.ts is NEW (builder 4b B5)
let findMissingDistMarkers: ((root?: string) => string[]) | undefined;
before(async () => {
  try {
    const spec = "../../scripts/assert-dist.js";
    findMissingDistMarkers = (await import(spec)).findMissingDistMarkers;
  } catch {
    // assert-dist.ts not built yet (pre-4b) — or its main isn't import-safe (a builder requirement; see header).
  }
});

/** A fake dist root with dist/overlay/*.js carrying the given marker text. */
function makeFakeDist(opts: { withTakeover?: boolean; markers?: string[] }): string {
  const root = mkdtempSync(join(tmpdir(), "p58a-dist-"));
  const overlay = join(root, "dist", "overlay");
  mkdirSync(overlay, { recursive: true });
  writeFileSync(join(overlay, "bootstrap.js"), (opts.markers ?? []).join(";\n"));
  if (opts.withTakeover) writeFileSync(join(overlay, "bootstrapTakeover.js"), (opts.markers ?? []).join(";\n"));
  return root;
}

describe("build:tauri regenerates the overlay assets (G-P58a.2)", () => {
  // Given: package.json. When: the build:tauri script is read. Then: it runs build:overlay-assets before tsc.
  it("T-Build.1: package.json build:tauri contains 'build:overlay-assets' (before tsc)", () => {
    const buildTauri = (JSON.parse(PKG).scripts as Record<string, string>)["build:tauri"] ?? "";
    assert.ok(buildTauri.includes("build:overlay-assets"), "build:tauri runs the overlay-assets gen step");
    assert.ok(
      buildTauri.indexOf("build:overlay-assets") < buildTauri.indexOf("tsc"),
      "the gen step runs BEFORE tsc (so dist reflects the current overlay source — the F-Y2.3-1 root-cause fix)",
    );
  });
});

describe("assert-dist core — findMissingDistMarkers (G-P58a.2)", () => {
  // Given: a fake dist MISSING __frondoseShowEdgeRing → non-empty array; a fake dist WITH bootstrapTakeover.js + all
  //        markers → []. (The script process.exit(1)s on non-empty — covered live in T-LIVE.BuildHygiene.)
  it("T-Build.2: findMissingDistMarkers flags a stale dist (missing marker/file) and passes a complete one", () => {
    assert.ok(findMissingDistMarkers, "builder 4b must export an import-safe findMissingDistMarkers");
    const bad = makeFakeDist({ withTakeover: false, markers: ["__frondoseShowWorkflow"] });
    const badMissing = findMissingDistMarkers(bad);
    assert.ok(badMissing.length > 0, "stale dist (no bootstrapTakeover.js + missing takeover markers) → non-empty");
    assert.ok(
      badMissing.some((m) => m.includes("bootstrapTakeover.js")) &&
        badMissing.some((m) => m.includes("__frondoseShowEdgeRing")),
      "reports the missing file AND the missing marker",
    );
    const good = makeFakeDist({
      withTakeover: true,
      markers: ["__frondoseShowWorkflow", "__frondoseShowEdgeRing", "__frondoseShowAgentTarget"],
    });
    assert.deepEqual(findMissingDistMarkers(good), [], "complete dist → no missing markers");
  });
});

describe("release.yml — conditional --prerelease (G-P58a.3)", () => {
  // Given: release.yml. When: inspected. Then: a case "$TAG" sets PRERELEASE=--prerelease for -alpha/-beta/-rc,
  //        AND $PRERELEASE is passed to `gh release create`.
  it("T-Release.1: release.yml sets --prerelease for -alpha/-beta/-rc tags and passes $PRERELEASE to gh release create", () => {
    assert.match(
      RELEASE_YML,
      /\*-alpha\*\|\*-beta\*\|\*-rc\*\)\s*PRERELEASE="--prerelease"/,
      "a case branch sets --prerelease for -alpha/-beta/-rc tags",
    );
    assert.match(RELEASE_YML, /\$PRERELEASE/, "$PRERELEASE is interpolated into the gh release create invocation");
    // a bare vX.Y.Z would not match the case → PRERELEASE stays "" (stable release)
    assert.match(RELEASE_YML, /PRERELEASE=""/, "PRERELEASE defaults empty (bare vX.Y.Z → stable, no --prerelease)");
  });
});

describe("version drift — tauri.conf.json === package.json (G-P58a.4)", () => {
  // Given: tauri.conf.json + package.json. When: both version fields read. Then: equal.
  it("T-Version.1: tauri.conf.json.version === package.json.version (no dual-bump drift)", () => {
    assert.equal(
      JSON.parse(TAURI_CONF).version,
      JSON.parse(PKG).version,
      "tauri.conf.json + package.json versions must match (Step-7 must bump BOTH)",
    );
  });
});

describe("desktop reconcile — initial cron-mode frame on SSE connect (G-P58a.7)", () => {
  // Given: routes.ts /agent/events. When: inspected. Then: after state.sseClients.add(res), it writes a cron-mode
  //        SSE frame carrying state.cronEnabled to the NEW res.
  it("T-Reconcile.1: /agent/events writes a cron-mode SSE frame (state.cronEnabled) right after sseClients.add(res)", () => {
    // P-72 slice 6: the handler was split into routes/events.ts; widen to check EITHER location.
    const addIdx =
      ROUTES_EVENTS_TS.indexOf("state.sseClients.add(res)") > 0
        ? ROUTES_EVENTS_TS.indexOf("state.sseClients.add(res)")
        : ROUTES_TS.indexOf("state.sseClients.add(res)");
    const src = ROUTES_EVENTS_TS.indexOf("state.sseClients.add(res)") > 0 ? ROUTES_EVENTS_TS : ROUTES_TS;
    assert.ok(addIdx > 0, "the /agent/events handler adds the new client (routes.ts or routes/events.ts after P-72 slice 6)");
    const after = src.slice(addIdx, addIdx + 220);
    assert.match(after, /res\.write\(/, "writes to the new res right after add");
    assert.match(after, /["']cron-mode["']|type.*cron-mode/, "the initial frame is a cron-mode frame");
    assert.match(after, /state\.cronEnabled/, "carries state.cronEnabled (the persisted source of truth)");
  });
});

describe("desktop reconcile — boot no longer force-POSTs Manual (G-P58a.7)", () => {
  // Given: app.ts boot(). When: inspected. Then: it calls syncModeUi("manual") (UI-only), NOT
  //        await applyMode("manual") (which would POST cron-mode{false} + overwrite persisted mode).
  it("T-Reconcile.2: app.ts boot uses syncModeUi('manual') (UI-only), not await applyMode('manual')", () => {
    // Scope to boot() — applyMode("manual") legitimately exists in the Manual-tab CLICK handler (user-initiated).
    const bootIdx = APP_TS.indexOf("async function boot");
    assert.ok(bootIdx > 0, "boot() exists");
    const bootEnd = APP_TS.indexOf("void boot()", bootIdx);
    const bootRegion = APP_TS.slice(bootIdx, bootEnd > 0 ? bootEnd : bootIdx + 600);
    assert.match(bootRegion, /syncModeUi\(\s*["']manual["']\s*\)/, "boot() does a UI-only syncModeUi('manual') init");
    assert.ok(
      !/await\s+applyMode\(\s*["']manual["']\s*\)/.test(bootRegion),
      "boot() must NOT await applyMode('manual') (that would POST cron-mode{false} + overwrite the persisted mode)",
    );
  });
});

describe("ring re-push on mid-Auto-turn ctxId capture (G-P58a.8)", () => {
  // Given: routes.ts ensureOverlaySubscription ctxId callback. When: inspected. Then: after
  //        state.overlayContextId = id, it calls showEdgeRing(state, deps.session) guarded by
  //        state.currentTurn !== null && state.cronEnabled.
  it("T-Repush.1: the ctxId callback re-pushes showEdgeRing guarded by currentTurn!==null && cronEnabled", () => {
    // P-72 slice 6: showEdgeRing import + ctxId callback moved to routes/cdp.ts; widen to check EITHER location.
    assert.ok(
      /import\s*\{\s*showEdgeRing\s*\}\s*from\s*["'][.\/]*takeover\.js["']/.test(ROUTES_CDP_TS) ||
        /import\s*\{\s*showEdgeRing\s*\}\s*from\s*["'][.\/]*takeover\.js["']/.test(ROUTES_TS),
      "imports showEdgeRing (routes.ts or routes/cdp.ts after P-72 slice 6)",
    );
    const cdpIdIdx = ROUTES_CDP_TS.indexOf("state.overlayContextId = id");
    const routesIdIdx = ROUTES_TS.indexOf("state.overlayContextId = id");
    const idIdx = cdpIdIdx > 0 ? cdpIdIdx : routesIdIdx;
    const src = cdpIdIdx > 0 ? ROUTES_CDP_TS : ROUTES_TS;
    assert.ok(idIdx > 0, "the ctxId callback assigns state.overlayContextId (routes.ts or routes/cdp.ts after P-72 slice 6)");
    const after = src.slice(idIdx, idIdx + 220);
    assert.match(
      after,
      /if\s*\(\s*state\.currentTurn\s*!==\s*null\s*&&\s*state\.cronEnabled\s*\)\s*showEdgeRing\(state,\s*deps\.session\)/,
      "re-pushes showEdgeRing guarded by currentTurn!==null && cronEnabled (mid-Auto-turn ctxId capture)",
    );
  });
});
