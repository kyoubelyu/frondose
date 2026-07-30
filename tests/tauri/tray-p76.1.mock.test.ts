/**
 * P-76.1 — T-Tray.* / T-Belt.1 / T-Ver.1 source-structural regression coverage
 *
 * Verifies the tray wiring + close-arm rewrite for the hide-to-tray slice.
 * Model: tests/tauri/adhocSign.mock.test.ts (read source + assert patterns; no build required).
 *
 * ★ Honest split (from plan §5):
 *   - These tests verify SOURCE WIRING only (grep patterns in Rust/config).
 *   - The ACTUAL tray/hide OS behavior needs a universal rebuild + dogfood (§5c S-Live.*).
 *     T-Belt.1 + T-Ver.1 do not require a rebuild.
 *
 * C-1 guard (plan §9): _tray MUST be at outer scope (not dropped in an inner block).
 * C-2 guard (plan §9): tauri.conf.json MUST NOT add a `trayIcon` entry (double-icon bug).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * Gate coverage:
 *   T-Tray.1 → G-P76.1-Tray.1 (tray build wiring + C-2 no-conf-trayIcon + C-1 outer scope)
 *   T-Tray.2 → G-P76.1-Tray.2 (close = hide, not quit)
 *   T-Tray.3 → G-P76.1-Tray.3 (menu ids show+quit wired correctly)
 *   T-Tray.4 → G-P76.1-Tray.4 (quit arm + ExitRequested both retain shutdown)
 *   T-Belt.1 → G-P76.1-Belt.1 (E4: belt unchanged, no cron escalation on hide)
 *   T-Ver.1  → G-P76.1-Ver.1  (version quad-sync — drift guard)
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/tauri/tray-p76.1.mock.test.ts
 * ════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Read source files once at module level — no build required.
const mainRs = readFileSync(join(REPO, "src/tauri/src-tauri/src/main.rs"), "utf-8");
const cargoToml = readFileSync(join(REPO, "src/tauri/src-tauri/Cargo.toml"), "utf-8");
const tauriConf = JSON.parse(readFileSync(join(REPO, "src/tauri/src-tauri/tauri.conf.json"), "utf-8")) as {
  version?: string;
  app?: { trayIcon?: unknown };
};
const packageJson = JSON.parse(readFileSync(join(REPO, "package.json"), "utf-8")) as { version?: string };
const routesSrc = readFileSync(join(REPO, "src/cli/subcommands/serve/routes.ts"), "utf-8");
// P-72 slice 6: cronEnabled=false on disconnect moved to routes/events.ts; widen T-Belt.1(b) to check EITHER.
const routesEventsSrc = readFileSync(join(REPO, "src/cli/subcommands/serve/routes/events.ts"), "utf-8");

// ─── Source-slicing helpers ───────────────────────────────────────────────────

/**
 * Slice the CloseRequested arm body from `api.prevent_close()` to the `// Cmd+Q` inter-arm
 * comment. Using `api.prevent_close()` as the start avoids picking up the stale D-RUN-1
 * header comment; stopping at `// Cmd+Q` avoids including the following comment line that
 * mentions `shutdown_sidecar` (e.g. "shutdown_sidecar is idempotent").
 */
function sliceCloseArm(src: string): string {
  // Anchor on the unique `api.prevent_close()` call (only present in the close arm body).
  const start = src.indexOf("api.prevent_close()");
  if (start === -1) return "";
  // End at the `// Cmd+Q` comment that separates the close arm from ExitRequested.
  // If that comment is absent (future refactor), fall back to the ExitRequested code arm.
  const cmdQIdx = src.indexOf("// Cmd+Q", start);
  const exitCodeIdx = src.indexOf("RunEvent::ExitRequested {", start);
  const end = cmdQIdx !== -1 ? cmdQIdx : exitCodeIdx !== -1 ? exitCodeIdx : undefined;
  return end !== undefined ? src.slice(start, end) : src.slice(start);
}

/**
 * Slice the ExitRequested arm body. Finds the CODE-form `RunEvent::ExitRequested {`
 * (which includes `{`) instead of the COMMENT-form `RunEvent::ExitRequested never fires`
 * to avoid a false-positive match on the D-RUN-1 safety comment above the close arm.
 */
function sliceExitRequestedArm(src: string): string {
  // The code-form always ends with `{ ..` or `{` — distinguish from the comment-form.
  const start = src.indexOf("RunEvent::ExitRequested {");
  if (start === -1) return "";
  // End at the next top-level arm boundary or closing brace block.
  const nextArm = src.indexOf("_ => {}", start);
  return nextArm !== -1 ? src.slice(start, nextArm) : src.slice(start);
}

// ─── T-Tray.1 ────────────────────────────────────────────────────────────────

describe("P-76.1 tray build wiring (G-P76.1-Tray.1)", () => {
  it("T-Tray.1: Cargo.toml includes tray-icon feature; main.rs has TrayIconBuilder + default_window_icon; _tray is bound at outer scope before app.run; tauri.conf.json has NO trayIcon entry (C-1 + C-2)", () => {
    // Given: post-builder Cargo.toml, main.rs, and tauri.conf.json.
    // When:  source text + JSON are inspected.
    // Then:  (a) Cargo.toml tauri features include 'tray-icon' (needed for TrayIconBuilder API).
    //        (b) main.rs contains TrayIconBuilder::new() (programmatic tray, not conf-declared).
    //        (c) main.rs uses default_window_icon() for the tray icon (no new asset required).
    //        (d) [C-1] `let _tray` is bound at outer scope BEFORE app.run( (handle outlives run).
    //        (e) [C-2] tauri.conf.json app.trayIcon is absent (conf-declared tray would register a
    //            second menu-less icon alongside the programmatic one — the double-icon bug).

    // (a) Cargo tray-icon feature
    assert.ok(
      cargoToml.includes(`"tray-icon"`),
      'T-Tray.1(a): Cargo.toml tauri features must include "tray-icon" (required for TrayIconBuilder API)',
    );

    // (b) Programmatic TrayIconBuilder present
    assert.ok(
      mainRs.includes("TrayIconBuilder::new()"),
      "T-Tray.1(b): main.rs must contain TrayIconBuilder::new() (programmatic tray build)",
    );

    // (c) Icon from default_window_icon (no new asset)
    assert.ok(
      mainRs.includes("default_window_icon()"),
      "T-Tray.1(c): main.rs must call default_window_icon() for the tray icon (reuses bundled icon)",
    );

    // (d) C-1: _tray at outer scope — `let _tray` must appear BEFORE `app.run(`
    const trayIdx = mainRs.indexOf("let _tray");
    const runIdx = mainRs.indexOf("app.run(");
    assert.ok(trayIdx !== -1, "T-Tray.1(d) C-1: main.rs must contain `let _tray` (outer-scope handle binding)");
    assert.ok(
      runIdx !== -1 && trayIdx < runIdx,
      `T-Tray.1(d) C-1: \`let _tray\` (idx ${trayIdx}) must appear BEFORE \`app.run(\` (idx ${runIdx}) — handle must outlive the run call`,
    );

    // (e) C-2: no conf-declared trayIcon — absent from tauri.conf.json
    assert.ok(
      tauriConf.app?.trayIcon == null,
      "T-Tray.1(e) C-2: tauri.conf.json must NOT have app.trayIcon — the tray is built programmatically; a conf entry would double the icon",
    );
    // Belt-and-suspenders: check raw JSON text too
    assert.ok(
      !readFileSync(join(REPO, "src/tauri/src-tauri/tauri.conf.json"), "utf-8").includes('"trayIcon"'),
      'T-Tray.1(e) C-2: tauri.conf.json source must not contain any "trayIcon" key',
    );
  });
});

// ─── T-Tray.2 ────────────────────────────────────────────────────────────────

describe("P-76.1 close = hide, not quit (G-P76.1-Tray.2)", () => {
  it("T-Tray.2: CloseRequested arm calls api.prevent_close() + win.hide(); does NOT call shutdown_sidecar or exit(", () => {
    // Given: post-builder main.rs CloseRequested arm (E1 rewrite).
    // When:  the arm body is sliced (from WindowEvent::CloseRequested to the next RunEvent::).
    // Then:  (a) api.prevent_close() is present (window close is intercepted).
    //        (b) .hide() is called on the window (window disappears; process keeps running).
    //        (c) shutdown_sidecar is absent (sidecar + agent keep running while hidden).
    //        (d) exit( is absent (app does NOT exit on close — tray Quit is the explicit exit).

    const closeArm = sliceCloseArm(mainRs);

    // (a) prevent_close
    assert.ok(
      closeArm.includes("api.prevent_close()"),
      "T-Tray.2(a): CloseRequested arm must call api.prevent_close() (intercept the OS close signal)",
    );

    // (b) hide
    assert.ok(
      closeArm.includes(".hide()"),
      "T-Tray.2(b): CloseRequested arm must call .hide() on the window (window hidden, not destroyed)",
    );

    // (c) no shutdown_sidecar in close arm CODE (sidecar stays alive while hidden)
    assert.ok(
      !closeArm.includes("shutdown_sidecar"),
      "T-Tray.2(c): CloseRequested arm body must NOT call shutdown_sidecar (sidecar + agent keep running while hidden)",
    );

    // (d) no exit( in close arm (app stays alive — tray Quit is the explicit stop)
    assert.ok(
      !closeArm.includes("exit("),
      "T-Tray.2(d): CloseRequested arm must NOT call exit( — tray Quit is the explicit full stop",
    );
  });
});

// ─── T-Tray.3 ────────────────────────────────────────────────────────────────

describe("P-76.1 tray menu wired: show→restore, quit→shutdown (G-P76.1-Tray.3)", () => {
  it("T-Tray.3: menu item ids are exactly show + quit (no stop); on_menu_event routes show→.show() and quit→shutdown_sidecar+exit(", () => {
    // Given: post-builder main.rs on_menu_event closure.
    // When:  the source is inspected for menu item ids and event routing.
    // Then:  (a) MenuItemBuilder::with_id("show", …) present.
    //        (b) MenuItemBuilder::with_id("quit", …) present.
    //        (c) No MenuItemBuilder::with_id("stop", …) (Quit IS the stop; no separate item).
    //        (d) on_menu_event match arm "show" routes to .show() (window restore).
    //        (e) on_menu_event match arm "quit" routes to shutdown_sidecar + exit(.

    // Slice on_menu_event body (from on_menu_event to its closing .build() call)
    const menuStart = mainRs.indexOf("on_menu_event");
    const buildIdx = menuStart !== -1 ? mainRs.indexOf(".build(&app)", menuStart) : -1;
    const menuBody = menuStart !== -1 ? mainRs.slice(menuStart, buildIdx !== -1 ? buildIdx + 30 : undefined) : "";

    // (a) show item id
    assert.ok(
      mainRs.includes('with_id("show"'),
      'T-Tray.3(a): main.rs must contain MenuItemBuilder::with_id("show", …) for the Show menu item',
    );

    // (b) quit item id
    assert.ok(
      mainRs.includes('with_id("quit"'),
      'T-Tray.3(b): main.rs must contain MenuItemBuilder::with_id("quit", …) for the Quit menu item',
    );

    // (c) no stop item id
    assert.ok(
      !mainRs.includes('with_id("stop"'),
      'T-Tray.3(c): main.rs must NOT contain MenuItemBuilder::with_id("stop", …) — Quit is the single full-stop',
    );

    // (d) show arm → window restore
    assert.ok(
      menuBody.includes('"show"') && menuBody.includes(".show()"),
      'T-Tray.3(d): on_menu_event must route "show" id to .show() (window restore)',
    );

    // (e) quit arm → shutdown_sidecar + exit(
    const quitIdx = menuBody.indexOf('"quit"');
    const quitSlice = quitIdx !== -1 ? menuBody.slice(quitIdx) : "";
    assert.ok(
      quitSlice.includes("shutdown_sidecar"),
      'T-Tray.3(e): on_menu_event "quit" arm must call shutdown_sidecar (graceful agent halt)',
    );
    assert.ok(
      quitSlice.includes("exit("),
      'T-Tray.3(e): on_menu_event "quit" arm must call exit( (app exits after sidecar shutdown)',
    );
  });
});

// ─── T-Tray.4 ────────────────────────────────────────────────────────────────

describe("P-76.1 Quit + ExitRequested still fully shut down (G-P76.1-Tray.4)", () => {
  it("T-Tray.4: tray quit arm has shutdown_sidecar+exit(; ExitRequested arm retains shutdown_sidecar", () => {
    // Given: post-builder main.rs tray on_menu_event quit arm + ExitRequested arm.
    // When:  each arm body is inspected.
    // Then:  (a) on_menu_event "quit" arm calls shutdown_sidecar + exit( (explicit full stop).
    //        (b) RunEvent::ExitRequested arm retains shutdown_sidecar (Cmd+Q/SIGTERM path unchanged).

    // (a) quit arm — same slice used in T-Tray.3(e)
    const menuStart = mainRs.indexOf("on_menu_event");
    const buildIdx = menuStart !== -1 ? mainRs.indexOf(".build(&app)", menuStart) : -1;
    const menuBody = menuStart !== -1 ? mainRs.slice(menuStart, buildIdx !== -1 ? buildIdx + 30 : undefined) : "";
    const quitIdx = menuBody.indexOf('"quit"');
    const quitSlice = quitIdx !== -1 ? menuBody.slice(quitIdx) : "";

    assert.ok(
      quitSlice.includes("shutdown_sidecar"),
      "T-Tray.4(a): tray quit arm must call shutdown_sidecar (graceful sidecar halt)",
    );
    assert.ok(
      quitSlice.includes("exit("),
      "T-Tray.4(a): tray quit arm must call exit( (app fully exits after shutdown)",
    );

    // (b) ExitRequested arm — Cmd+Q / SIGTERM path unchanged
    const exitArm = sliceExitRequestedArm(mainRs);
    assert.ok(
      exitArm.includes("shutdown_sidecar"),
      "T-Tray.4(b): RunEvent::ExitRequested arm must still call shutdown_sidecar (Cmd+Q/SIGTERM path preserved)",
    );
  });
});

// ─── T-Belt.1 ────────────────────────────────────────────────────────────────

describe("P-76.1 E4: serve belt unchanged + hide does not flip cron (G-P76.1-Belt.1)", () => {
  it("T-Belt.1: routes.ts has CLIENT_DISCONNECT_GRACE_MS=3000 + cronEnabled=false on disconnect; main.rs close arm has no cronEnabled write", () => {
    // Given: src/cli/subcommands/serve/routes.ts (the SSE disconnect-belt, already shipped).
    //        post-builder main.rs CloseRequested arm (hide path).
    // When:  source texts are inspected.
    // Then:  (a) routes.ts CLIENT_DISCONNECT_GRACE_MS === 3000 (belt timing preserved).
    //        (b) routes.ts sets cronEnabled=false on true disconnect (autonomy always halts on kill).
    //        (c) main.rs CloseRequested arm does NOT write cronEnabled (hide ≠ autonomy escalation).
    //        Note: when the window is hidden the SSE subscriber STAYS connected → belt does NOT fire.

    // (a) belt timeout constant — CLIENT_DISCONNECT_GRACE_MS = 3000 stays in routes.ts (passed as arg to handler)
    assert.ok(
      routesSrc.includes("CLIENT_DISCONNECT_GRACE_MS = 3000"),
      "T-Belt.1(a): routes.ts must still define CLIENT_DISCONNECT_GRACE_MS = 3000 (belt timing unchanged)",
    );

    // (b) cronEnabled=false on disconnect (the autonomy safety net)
    // P-72 slice 6: the assignment moved to routes/events.ts; widen to check EITHER location.
    assert.ok(
      routesSrc.includes("cronEnabled = false") || routesEventsSrc.includes("cronEnabled = false"),
      "T-Belt.1(b): routes.ts or routes/events.ts (after P-72 slice 6) must set cronEnabled = false on disconnect (no-autonomy-while-invisible invariant)",
    );

    // (c) CloseRequested (hide) arm must NOT write cronEnabled
    const closeArm = sliceCloseArm(mainRs);
    assert.ok(
      !closeArm.includes("cronEnabled"),
      "T-Belt.1(c): main.rs CloseRequested arm must NOT write cronEnabled — hide does not escalate autonomy",
    );
  });
});

// ─── T-Ver.1 ─────────────────────────────────────────────────────────────────

describe("P-76.1 version quad-sync (G-P76.1-Ver.1)", () => {
  it("T-Ver.1: package.json + tauri.conf.json + Cargo.toml report the same current version", () => {
    // Given: package.json, tauri.conf.json, and Cargo.toml from the current release state.
    // When:  version fields are read.
    // Then:  both app manifests and the Rust package report package.json's current version.
    const targetVersion = packageJson.version;
    assert.ok(targetVersion, "T-Ver.1: package.json must declare a non-empty version");

    assert.equal(
      tauriConf.version,
      targetVersion,
      `T-Ver.1: tauri.conf.json version must match package.json (${targetVersion})`,
    );

    // Cargo.toml: parse the version line
    const cargoVersionMatch = cargoToml.match(/^\[package\][^[]*?version\s*=\s*"([^"]+)"/ms);
    const cargoVersion = cargoVersionMatch?.[1] ?? "(not found)";
    assert.equal(
      cargoVersion,
      targetVersion,
      `T-Ver.1: Cargo.toml [package] version must match package.json (${targetVersion}); got ${cargoVersion}`,
    );
  });
});
