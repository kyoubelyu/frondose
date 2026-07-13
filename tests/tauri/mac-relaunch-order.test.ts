/**
 * P-FIX-MAC-UPDATER-RELAUNCH Step 2 (scaffold) — T-STRUCT.1–5
 *
 * Text-scan tests for `src/tauri/src-tauri/src/updater.rs` + `commands.rs`
 * (WIN-3 `main-rs-cfg-guard.test.ts` convention: no Rust toolchain — deterministic
 * regex/string scanning of the crate source; RED pre-implementation).
 *
 * Gate coverage (plan §5):
 *   MR-1 ↦ T-STRUCT.1 (download BEFORE sidecar shutdown BEFORE install, inside install_and_relaunch)
 *   MR-2 ↦ T-STRUCT.4 (absolute /usr/bin/open + -n; no PATH lookup of "open")
 *   MR-7 ↦ T-STRUCT.3 (three-way cfg split; app.restart() survives ONLY in the not(any(win,mac)) branch)
 *   latent-bug ↦ T-STRUCT.2 (commands.rs: no app.restart(); routes through install_and_relaunch)
 *   MR-1/MR-6 ↦ T-STRUCT.5 (no download_and_install anywhere; AppTranslocation pre-flight present)
 *
 * PRE-IMPL RED STATE: install_and_relaunch does not exist; commands.rs still calls
 * app.restart(); both files still call download_and_install; no /usr/bin/open, no
 * AppTranslocation guard, no not(any(...)) cfg branch. All five tests fail loudly.
 *
 * Run:
 *   node --import tsx --test --test-force-exit tests/tauri/mac-relaunch-order.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const UPDATER_RS = readFileSync(join(REPO, "src/tauri/src-tauri/src/updater.rs"), "utf8");
const COMMANDS_RS = readFileSync(join(REPO, "src/tauri/src-tauri/src/commands.rs"), "utf8");

/** Slice updater.rs from the install_and_relaunch fn header to end-of-file (the fn +
 * its helpers below it); precise-enough scope for ordering assertions without a Rust parser. */
function installAndRelaunchRegion(): { start: number; text: string } {
  const start = UPDATER_RS.indexOf("async fn install_and_relaunch");
  return { start, text: start >= 0 ? UPDATER_RS.slice(start) : "" };
}

describe("MR-1 — install_and_relaunch orders download BEFORE sidecar shutdown BEFORE install", () => {
  // Given: updater.rs source text
  // When:  the install_and_relaunch region is scanned
  // Then:  `.download(` appears before the sidecar-shutdown call, which appears before `.install(`
  //        — a failed/interrupted download can never leave the app sidecar-dead (MR-1).
  it("T-STRUCT.1: within install_and_relaunch, .download( < shutdown_sidecar < .install(", () => {
    const region = installAndRelaunchRegion();
    assert.ok(region.start >= 0, "updater.rs must define `async fn install_and_relaunch` (shared helper, plan §6b)");
    const iDownload = region.text.indexOf(".download(");
    const iShutdown = region.text.indexOf("shutdown_sidecar");
    const iInstall = region.text.indexOf(".install(");
    assert.ok(iDownload >= 0, "install_and_relaunch must call Update::download( (the verify-first seam)");
    assert.ok(iShutdown >= 0, "install_and_relaunch must shut down the sidecar (via shutdown_sidecar*)");
    assert.ok(iInstall >= 0, "install_and_relaunch must call Update::install(");
    assert.ok(
      iDownload < iShutdown && iShutdown < iInstall,
      `ordering violated: download@${iDownload}, shutdown@${iShutdown}, install@${iInstall} — must be download < shutdown < install (MR-1)`,
    );
  });
});

describe("latent second bug — commands.rs manual check adopts the shared platform-correct path", () => {
  // Given: commands.rs source text
  // When:  scanned for the old bare-restart shape
  // Then:  app.restart() is gone and frondose_check_update routes through install_and_relaunch.
  it("T-STRUCT.2: commands.rs contains no app.restart() and calls install_and_relaunch", () => {
    assert.ok(
      !/app\.restart\(\)/.test(COMMANDS_RS),
      "commands.rs must no longer call app.restart() (the mac-silent-death / windows-exe-lock shape)",
    );
    assert.ok(
      COMMANDS_RS.includes("install_and_relaunch"),
      "frondose_check_update must route through crate::updater::install_and_relaunch",
    );
  });
});

describe("MR-7 — three-way cfg split; app.restart() only survives in the Linux branch", () => {
  // Given: updater.rs source text
  // When:  scanned for the platform split
  // Then:  windows, macos, and not(any(windows, macos)) branches all exist, and every
  //        remaining app.restart() sits in the not(any(...)) (Linux-preserving) branch.
  it("T-STRUCT.3: cfg(windows) + cfg(macos) + cfg(not(any(windows, macos))) present; app.restart() count==1 inside the not(any) branch", () => {
    assert.ok(UPDATER_RS.includes('#[cfg(target_os = "windows")]'), "windows cfg branch required");
    assert.ok(UPDATER_RS.includes('#[cfg(target_os = "macos")]'), "macos cfg branch required");
    const notAny = '#[cfg(not(any(target_os = "windows", target_os = "macos")))]';
    assert.ok(UPDATER_RS.includes(notAny), `Linux-preserving branch required: ${notAny} (MR-7 cfg hole)`);
    const restarts = UPDATER_RS.match(/app\.restart\(\)/g) ?? [];
    assert.equal(
      restarts.length,
      1,
      `exactly ONE app.restart() may remain in updater.rs (the Linux branch); found ${restarts.length}`,
    );
    const iNotAny = UPDATER_RS.indexOf(notAny);
    const iRestart = UPDATER_RS.indexOf("app.restart()");
    assert.ok(
      iNotAny >= 0 && iRestart > iNotAny && iRestart - iNotAny < 400,
      "the surviving app.restart() must sit inside (within ~400 chars after) the not(any(windows, macos)) branch",
    );
  });
});

describe("MR-2 — the approved relaunch site is exactly /usr/bin/open -n <bundle>", () => {
  // Given: updater.rs source text
  // When:  scanned for the spawn form
  // Then:  the absolute /usr/bin/open path + "-n" arg exist; no PATH lookup Command::new("open").
  it('T-STRUCT.4: literal "/usr/bin/open" + "-n" present; no Command::new("open") PATH lookup', () => {
    assert.ok(UPDATER_RS.includes('"/usr/bin/open"'), 'the approved site is the ABSOLUTE path "/usr/bin/open" (MR-2)');
    assert.ok(UPDATER_RS.includes('"-n"'), 'open must be passed "-n" (new instance) per the operator-approved site');
    assert.ok(
      !UPDATER_RS.includes('Command::new("open")'),
      'PATH lookup Command::new("open") is forbidden — absolute /usr/bin/open only (MR-2)',
    );
  });
});

describe("critic-r2 — guard release on every error path; exit never on an error path; debug override fenced", () => {
  // Given: the install_and_relaunch region of updater.rs
  // When:  every `emit_update_status(app, "error"` site is located
  // Then:  each is followed by end_update() within 300 chars (guard released on EVERY error
  //        path); app.exit(0) appears exactly twice (Windows defensive + macOS accepted-relaunch)
  //        and never within 300 chars after an "error" emit; and the FRONDOSE_DEBUG_OPEN_BIN
  //        override appears only under #[cfg(debug_assertions)].
  it('T-STRUCT.6: every "error" emit → end_update() nearby; app.exit(0) x2 never on error paths; FRONDOSE_DEBUG_OPEN_BIN only under cfg(debug_assertions)', () => {
    const region = installAndRelaunchRegion();
    assert.ok(region.start >= 0, "updater.rs must define `async fn install_and_relaunch`");
    const errEmits: number[] = [];
    let from = 0;
    for (;;) {
      const i = region.text.indexOf('emit_update_status(app, "error"', from);
      if (i < 0) break;
      errEmits.push(i);
      from = i + 1;
    }
    assert.ok(
      errEmits.length >= 3,
      `expected >=3 error-emit paths (preflight/download/install/relaunch); found ${errEmits.length}`,
    );
    for (const i of errEmits) {
      // Semantic window (critic-r2b refinement carried into Step 4): every error path is
      // `emit → end_update() → return/Err` — assert within the path, i.e. up to and
      // including the path's own `return `/`Err(` terminator, NOT a fixed byte radius
      // (a following cfg block's app.exit(0) may legitimately sit right after the return).
      const window = region.text.slice(i, i + 400);
      const iTerm = window.search(/return |Err\(msg\)/);
      assert.ok(iTerm > 0, `error emit @${i} must be followed by an error-return within 400 chars`);
      const path = window.slice(0, iTerm);
      assert.ok(
        path.includes("end_update()"),
        `error emit @${i} must release the guard (end_update BEFORE the error return); got: ${path.slice(0, 160)}…`,
      );
      assert.ok(
        !path.includes("app.exit(0)"),
        `error emit @${i} must NOT reach app.exit(0) before its error return (no exit on failure, MR-2)`,
      );
    }
    const exits = region.text.match(/app\.exit\(0\)/g) ?? [];
    assert.equal(
      exits.length,
      2,
      `install_and_relaunch must contain exactly 2 app.exit(0) sites (windows defensive + macOS accepted); found ${exits.length}`,
    );
    // Debug-only override fencing (critic-r2b: comment-insensitive — locate the CODE
    // occurrence, the actual std::env::var lookup, not a doc comment mentioning the name).
    const CODE_LOOKUP = 'std::env::var("FRONDOSE_DEBUG_OPEN_BIN")';
    const iLookup = UPDATER_RS.indexOf(CODE_LOOKUP);
    assert.ok(iLookup >= 0, `the ${CODE_LOOKUP} debug-only override lookup is required for the §7 Stage B3 drill`);
    assert.equal(
      UPDATER_RS.indexOf(CODE_LOOKUP, iLookup + 1),
      -1,
      "exactly ONE env-var lookup site for the debug override (every occurrence must be provably fenced)",
    );
    // The immediately preceding non-empty line(s) must carry the cfg fence: scan backwards from
    // the lookup's line start over comment/attribute lines only.
    const lineStart = UPDATER_RS.lastIndexOf("\n", iLookup);
    const precedingLines = UPDATER_RS.slice(0, lineStart).split("\n");
    let fenced = false;
    for (let li = precedingLines.length - 1; li >= 0 && li >= precedingLines.length - 4; li--) {
      const line = precedingLines[li].trim();
      if (line === "#[cfg(debug_assertions)]") {
        fenced = true;
        break;
      }
      if (line.startsWith("//") || line.startsWith("#[") || line.length === 0) continue; // attributes/comments may sit between
      break; // any other code line breaks the fence adjacency
    }
    assert.ok(
      fenced,
      "the std::env::var(FRONDOSE_DEBUG_OPEN_BIN) statement must be IMMEDIATELY fenced by #[cfg(debug_assertions)] (release spawn site takes no env influence)",
    );
    // Release-path pin: the production bin remains the hardcoded absolute constant.
    assert.ok(
      UPDATER_RS.includes('MACOS_OPEN_BIN: &str = "/usr/bin/open"'),
      'the production bin must remain the hardcoded MACOS_OPEN_BIN = "/usr/bin/open" constant',
    );
  });
});

describe("MR-1/MR-6 — download/install seam adopted crate-wide; translocation pre-flight exists", () => {
  // Given: updater.rs + commands.rs source text
  // When:  scanned for the legacy one-shot API and the unsupported-location guard
  // Then:  download_and_install is gone from both files; the AppTranslocation guard exists.
  it("T-STRUCT.5: no download_and_install in updater.rs/commands.rs; AppTranslocation guard present", () => {
    assert.ok(
      !UPDATER_RS.includes("download_and_install"),
      "updater.rs must use the download()/install() seam, not download_and_install (MR-1)",
    );
    assert.ok(
      !COMMANDS_RS.includes("download_and_install"),
      "commands.rs must route through the shared helper, not its own download_and_install (MR-1)",
    );
    assert.ok(
      UPDATER_RS.includes("AppTranslocation"),
      "updater.rs must detect App Translocation and fail visibly BEFORE download (MR-6)",
    );
  });
});
