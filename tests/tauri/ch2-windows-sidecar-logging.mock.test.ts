/**
 * CH-2 Step 2 scaffold — T-CH2.1 through T-CH2.12 + T-CH2.5-neg
 *
 * Source-scan tests for the Windows sidecar log redirect added to
 * `src/tauri/src-tauri/src/main.rs` by CH-2. No Rust toolchain is invoked
 * for T-CH2.1–11; T-CH2.12 invokes `cargo check` on macOS.
 *
 * Gate coverage (plan §5):
 *   T-CH2.1   — exactly one `fn windows_sidecar_log_path` preceded by `#[cfg(windows)]`
 *   T-CH2.2   — helper body contains all four path components (.frondose, agent, logs, sidecar.log)
 *   T-CH2.3   — helper body uses USERPROFILE (not HOME)
 *   T-CH2.4   — helper body calls create_dir_all exactly once
 *   T-CH2.5   — spawn_frondose_serve body still has ≥2 Stdio::inherit (macOS path unchanged)
 *   T-CH2.5-neg — ANTI-FALSE-PASS: fails if Stdio::inherit count drops to 0 in the whole file
 *   T-CH2.6   — spawn_frondose_serve body has ≥2 #[cfg(windows)] blocks OR one merged block with creation_flags(0x08000000) AND OpenOptions
 *   T-CH2.7   — OpenOptions + .append(true) + .create(true) inside a #[cfg(windows)] block
 *   T-CH2.8   — ≥2 Stdio::from inside #[cfg(windows)] (stdout + stderr)
 *   T-CH2.9   — ≥1 Stdio::null inside #[cfg(windows)] (failure fallback)
 *   T-CH2.10  — exactly one 0x08000000 in spawn_frondose_serve body
 *   T-CH2.11  — exactly one windows_subsystem = "windows" in the file
 *   T-CH2.12  — cargo check exits 0 on macOS (non-Windows build not broken by cfg-windows code)
 *
 * WHY TEXT-SCAN: main.rs is a single-module Rust file; the tested properties are
 * structural markers (cfg attributes + specific identifier strings). A regex scan is
 * deterministic, requires no Rust toolchain for T-CH2.1–11, and fails loudly if the
 * required blocks are absent or placed outside the cfg guards.
 *
 * PRE-IMPL RED STATE (Step 2 scaffold): the helper `fn windows_sidecar_log_path` does not
 * exist in main.rs yet, and no Windows redirect block exists in spawn_frondose_serve.
 * All tests except T-CH2.5 and T-CH2.11 (which scan existing content) are expected to
 * FAIL at Step 2. T-CH2.5-neg is expected to PASS at Step 2 (Stdio::inherit exists now).
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/tauri/ch2-windows-sidecar-logging.mock.test.ts
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN_RS_PATH = join(REPO, "src/tauri/src-tauri/src/main.rs");

// CH-3 module split (2026-06-18): after CH-3, windows_sidecar_log_path moved to
// resolve.rs and spawn_frondose_serve moved to sidecar.rs. Read all *.rs files in
// the crate and concatenate them so every test finds the symbol it guards regardless
// of which module it lives in. Intent of each test is preserved without weakening.
// T-CH2.11 (windows_subsystem in main.rs) and T-CH2.12 (cargo check) are unaffected.
const CRATE_SRC_DIR = join(REPO, "src/tauri/src-tauri/src");
const mainRs = readdirSync(CRATE_SRC_DIR)
  .filter((f) => f.endsWith(".rs"))
  .sort()
  .map((f) => readFileSync(join(CRATE_SRC_DIR, f), "utf8"))
  .join("\n");

// ---------------------------------------------------------------------------
// Helpers: extract function bodies by brace-matching
// ---------------------------------------------------------------------------

/**
 * Extract the body text of the first function whose `fn` declaration line matches
 * `fnNamePattern`. Returns the content between the opening `{` and its matching `}`.
 * Returns null if the function is not found.
 */
function extractFunctionBody(src: string, fnNamePattern: RegExp): string | null {
  const lines = src.split("\n");
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && fnNamePattern.test(line)) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) {
    return null;
  }

  // Walk forward from the fn declaration to find the opening brace.
  let depth = 0;
  let bodyStart = -1;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      break;
    }
    for (const ch of line) {
      if (ch === "{") {
        if (depth === 0) {
          bodyStart = i;
        }
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && bodyStart !== -1) {
          // Matched closing brace — return from bodyStart line to here.
          return lines.slice(bodyStart, i + 1).join("\n");
        }
      }
    }
  }
  return null;
}

/**
 * Count non-overlapping occurrences of a literal string inside a haystack.
 */
function countLiteral(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) {
      break;
    }
    count++;
    pos = idx + needle.length;
  }
  return count;
}

/**
 * Count non-overlapping regex matches in a string. Use named `for` loop form
 * (not while-assign) to satisfy biome noAssignInExpressions.
 */
function countMatches(haystack: string, re: RegExp): number {
  // re must have the `g` flag.
  const matches = haystack.match(re);
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// T-CH2.1 — windows_sidecar_log_path: exactly one definition, #[cfg(windows)] guard
// ---------------------------------------------------------------------------

describe("CH-2 — helper: windows_sidecar_log_path exists and is cfg-guarded", () => {
  it("T-CH2.1: when main.rs is scanned, fn windows_sidecar_log_path exists exactly once, immediately preceded by #[cfg(windows)]", () => {
    // Given: src/tauri/src-tauri/src/main.rs source text
    // When:  searching for the function definition `fn windows_sidecar_log_path`
    // Then:  exactly one match, immediately preceded by a `#[cfg(windows)]` attribute

    // TODO(Step 4 impl): assert that fn exists after Codex adds it.
    const fnDefinitions = mainRs.match(/fn\s+windows_sidecar_log_path\b/g);
    assert.ok(
      fnDefinitions !== null && fnDefinitions.length === 1,
      "T-CH2.1: expected exactly one `fn windows_sidecar_log_path` definition in main.rs (not yet present pre-impl)",
    );

    // Now verify it is immediately preceded by `#[cfg(windows)]` on the prior non-blank line.
    const lines = mainRs.split("\n");
    let fnLine = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line !== undefined && /fn\s+windows_sidecar_log_path\b/.test(line)) {
        fnLine = i;
        break;
      }
    }
    assert.ok(fnLine !== -1, "T-CH2.1: fn line not found (should not reach here after count check)");

    // Walk backwards from fnLine to find the nearest non-blank line.
    let precedingLine: string | undefined;
    for (let i = fnLine - 1; i >= 0; i--) {
      const candidate = lines[i];
      if (candidate !== undefined && candidate.trim().length > 0) {
        precedingLine = candidate.trim();
        break;
      }
    }
    assert.ok(
      precedingLine !== undefined && precedingLine === "#[cfg(windows)]",
      `T-CH2.1: line preceding fn windows_sidecar_log_path must be exactly '#[cfg(windows)]', got: ${precedingLine ?? "(none)"}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T-CH2.2 — helper body contains all four path components
// ---------------------------------------------------------------------------

describe("CH-2 — helper body: path components .frondose / agent / logs / sidecar.log", () => {
  it("T-CH2.2: when the helper body is extracted, it contains .frondose, agent, logs, and sidecar.log", () => {
    // Given: windows_sidecar_log_path body extracted from main.rs
    // When:  scanning for the four agreed path segment literals
    // Then:  all four are present, proving the path resolves to the agreed location

    // TODO(Step 4 impl): fill body after Codex adds the function.
    const body = extractFunctionBody(mainRs, /fn\s+windows_sidecar_log_path\b/);
    assert.ok(body !== null, "T-CH2.2: windows_sidecar_log_path body not found (not yet present pre-impl)");

    for (const segment of [".frondose", "agent", "logs", "sidecar.log"]) {
      assert.ok(
        body.includes(segment),
        `T-CH2.2: expected helper body to contain "${segment}" (path component proving agreed log location)`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T-CH2.3 — helper body uses USERPROFILE, not HOME
// ---------------------------------------------------------------------------

describe("CH-2 — helper body: uses USERPROFILE (not HOME) for Windows home resolution", () => {
  it("T-CH2.3: when the helper body is extracted, USERPROFILE appears exactly once and HOME does not appear", () => {
    // Given: windows_sidecar_log_path body extracted from main.rs
    // When:  scanning for env-var name used to resolve home directory
    // Then:  USERPROFILE appears exactly once; HOME does not appear in the helper

    // TODO(Step 4 impl): fill after Codex adds the function.
    const body = extractFunctionBody(mainRs, /fn\s+windows_sidecar_log_path\b/);
    assert.ok(body !== null, "T-CH2.3: windows_sidecar_log_path body not found (not yet present pre-impl)");

    const userprofileCount = countLiteral(body, "USERPROFILE");
    assert.equal(
      userprofileCount,
      1,
      `T-CH2.3: expected exactly one "USERPROFILE" in helper body, got ${userprofileCount}`,
    );

    // HOME must not appear in the Windows-only helper (latent bug tracked in plan §6 note).
    assert.equal(
      body.includes('"HOME"'),
      false,
      "T-CH2.3: helper body must NOT use \"HOME\" (empty on Windows) — must use USERPROFILE",
    );
  });
});

// ---------------------------------------------------------------------------
// T-CH2.4 — helper body calls create_dir_all exactly once
// ---------------------------------------------------------------------------

describe("CH-2 — helper body: create_dir_all called exactly once", () => {
  it("T-CH2.4: when the helper body is extracted, create_dir_all appears exactly once", () => {
    // Given: windows_sidecar_log_path body extracted from main.rs
    // When:  scanning for create_dir_all
    // Then:  exactly one call, proving the log directory is created if absent

    // TODO(Step 4 impl): fill after Codex adds the function.
    const body = extractFunctionBody(mainRs, /fn\s+windows_sidecar_log_path\b/);
    assert.ok(body !== null, "T-CH2.4: windows_sidecar_log_path body not found (not yet present pre-impl)");

    const count = countLiteral(body, "create_dir_all");
    assert.equal(count, 1, `T-CH2.4: expected exactly one create_dir_all in helper body, got ${count}`);
  });
});

// ---------------------------------------------------------------------------
// T-CH2.5 — spawn_frondose_serve still has ≥2 Stdio::inherit (macOS path unchanged)
// ---------------------------------------------------------------------------

describe("CH-2 — spawn_frondose_serve: Stdio::inherit count ≥ 2 (macOS default path intact)", () => {
  it("T-CH2.5: when spawn_frondose_serve body is scanned, Stdio::inherit appears at least twice", () => {
    // Given: spawn_frondose_serve body extracted from main.rs
    // When:  counting Stdio::inherit occurrences
    // Then:  at least 2 (stdout + stderr), proving the macOS/default code path is unchanged

    const body = extractFunctionBody(mainRs, /async fn\s+spawn_frondose_serve\b/);
    assert.ok(body !== null, "T-CH2.5: spawn_frondose_serve body not found in main.rs");

    const count = countLiteral(body, "Stdio::inherit");
    assert.ok(
      count >= 2,
      `T-CH2.5: expected ≥2 Stdio::inherit in spawn_frondose_serve body (stdout+stderr macOS path), got ${count}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T-CH2.5-neg — ANTI-FALSE-PASS: if Stdio::inherit count ever drops to 0, this MUST fail
// ---------------------------------------------------------------------------

describe("CH-2 ANTI-FALSE-PASS — Stdio::inherit must not disappear from main.rs", () => {
  it("T-CH2.5-neg: when main.rs is scanned for Stdio::inherit, count is > 0 (regression guard)", () => {
    // Given: main.rs source text
    // When:  counting all Stdio::inherit occurrences in the entire file
    // Then:  count > 0 — if someone accidentally removes all inherit calls, this goes RED

    const count = countLiteral(mainRs, "Stdio::inherit");
    assert.ok(
      count > 0,
      `T-CH2.5-neg: Stdio::inherit was completely removed from main.rs — macOS code path is broken (count=${count}). This is an anti-false-pass regression guard.`,
    );
  });
});

// ---------------------------------------------------------------------------
// T-CH2.6 — spawn_frondose_serve: ≥2 #[cfg(windows)] blocks + creation_flags(0x08000000)
// ---------------------------------------------------------------------------

describe("CH-2 — spawn_frondose_serve: Windows cfg block(s) present with creation_flags and redirect", () => {
  it("T-CH2.6: when spawn_frondose_serve body is scanned, either ≥2 #[cfg(windows)] blocks exist OR one merged block contains both creation_flags(0x08000000) and OpenOptions; creation_flags(0x08000000) is always present", () => {
    // Given: spawn_frondose_serve body extracted from main.rs (post-impl)
    // When:  counting #[cfg(windows)] occurrences AND brace-matching each Windows block for its contents
    // Then:  EITHER cfgCount >= 2 (two separate blocks: WIN-8 + CH-2)
    //        OR exactly one brace-matched #[cfg(windows)] block contains BOTH creation_flags(0x08000000)
    //        AND OpenOptions (the append-create redirect) — merged-block implementation is equally correct

    // TODO(Step 4 impl): will pass after Codex adds the redirect (merged or two-block).
    const body = extractFunctionBody(mainRs, /async fn\s+spawn_frondose_serve\b/);
    assert.ok(body !== null, "T-CH2.6: spawn_frondose_serve body not found in main.rs");

    // creation_flags(0x08000000) must always be present regardless of block shape.
    assert.ok(
      body.includes("creation_flags(0x08000000)"),
      "T-CH2.6: creation_flags(0x08000000) must still be present in spawn_frondose_serve body (CREATE_NO_WINDOW unchanged)",
    );

    const cfgCount = countLiteral(body, "#[cfg(windows)]");

    // Branch A: two or more separate #[cfg(windows)] blocks (WIN-8 block + CH-2 redirect block).
    const hasTwoBlocks = cfgCount >= 2;

    // Branch B: exactly one merged #[cfg(windows)] block that contains BOTH
    //   creation_flags(0x08000000) AND OpenOptions (the append-create redirect code).
    // Extract all brace-matched #[cfg(windows)] block bodies.
    const cfgBlockBodies: string[] = [];
    const searchStr = "#[cfg(windows)]";
    let searchFrom = 0;
    while (true) {
      const cfgIdx = body.indexOf(searchStr, searchFrom);
      if (cfgIdx === -1) {
        break;
      }
      const braceOpen = body.indexOf("{", cfgIdx + searchStr.length);
      if (braceOpen === -1) {
        searchFrom = cfgIdx + searchStr.length;
        continue;
      }
      let depth = 0;
      let closeIdx = -1;
      for (let i = braceOpen; i < body.length; i++) {
        const ch = body[i];
        if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) {
            closeIdx = i;
            break;
          }
        }
      }
      if (closeIdx !== -1) {
        cfgBlockBodies.push(body.slice(braceOpen, closeIdx + 1));
        searchFrom = closeIdx + 1;
      } else {
        searchFrom = cfgIdx + searchStr.length;
      }
    }
    const hasMergedBlock = cfgBlockBodies.some(
      (blockBody) => blockBody.includes("creation_flags(0x08000000)") && blockBody.includes("OpenOptions"),
    );

    assert.ok(
      hasTwoBlocks || hasMergedBlock,
      `T-CH2.6: expected EITHER ≥2 #[cfg(windows)] blocks (got ${cfgCount}) OR one merged block containing both creation_flags(0x08000000) and OpenOptions. Pre-impl: 1 cfg block, no OpenOptions → both branches false → RED (correct). Post-impl: either branch must be true.`,
    );
  });
});

// ---------------------------------------------------------------------------
// T-CH2.7 — OpenOptions + .append(true) + .create(true) inside #[cfg(windows)]
// ---------------------------------------------------------------------------

describe("CH-2 — spawn_frondose_serve: OpenOptions append-create inside #[cfg(windows)]", () => {
  it("T-CH2.7: when spawn_frondose_serve body is scanned, OpenOptions and .append(true) and .create(true) appear inside a #[cfg(windows)] block", () => {
    // Given: spawn_frondose_serve body extracted from main.rs
    // When:  searching for OpenOptions, .append(true), .create(true) within a #[cfg(windows)] region
    // Then:  all three are present, proving append-create semantics (no truncation across launches)

    // TODO(Step 4 impl): fill after Codex adds the redirect block.
    const body = extractFunctionBody(mainRs, /async fn\s+spawn_frondose_serve\b/);
    assert.ok(body !== null, "T-CH2.7: spawn_frondose_serve body not found in main.rs");

    // Extract all #[cfg(windows)] blocks within the function body by brace-matching.
    const cfgWindowsBlockContents: string[] = [];
    const searchStr = "#[cfg(windows)]";
    let searchFrom = 0;
    while (true) {
      const cfgIdx = body.indexOf(searchStr, searchFrom);
      if (cfgIdx === -1) {
        break;
      }
      // Find the opening brace after this cfg attribute.
      const braceOpen = body.indexOf("{", cfgIdx + searchStr.length);
      if (braceOpen === -1) {
        searchFrom = cfgIdx + searchStr.length;
        continue;
      }
      // Brace-match to find the closing brace.
      let depth = 0;
      let closeIdx = -1;
      for (let i = braceOpen; i < body.length; i++) {
        const ch = body[i];
        if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) {
            closeIdx = i;
            break;
          }
        }
      }
      if (closeIdx !== -1) {
        cfgWindowsBlockContents.push(body.slice(braceOpen, closeIdx + 1));
        searchFrom = closeIdx + 1;
      } else {
        searchFrom = cfgIdx + searchStr.length;
      }
    }

    const combinedWindowsContent = cfgWindowsBlockContents.join("\n");

    assert.ok(
      combinedWindowsContent.includes("OpenOptions"),
      "T-CH2.7: OpenOptions must appear inside a #[cfg(windows)] block in spawn_frondose_serve (not yet present pre-impl)",
    );
    assert.ok(
      combinedWindowsContent.includes(".append(true)"),
      "T-CH2.7: .append(true) must appear inside a #[cfg(windows)] block in spawn_frondose_serve (not yet present pre-impl)",
    );
    assert.ok(
      combinedWindowsContent.includes(".create(true)"),
      "T-CH2.7: .create(true) must appear inside a #[cfg(windows)] block in spawn_frondose_serve (not yet present pre-impl)",
    );
  });
});

// ---------------------------------------------------------------------------
// T-CH2.8 — ≥2 Stdio::from inside #[cfg(windows)] in spawn_frondose_serve
// ---------------------------------------------------------------------------

describe("CH-2 — spawn_frondose_serve: ≥2 Stdio::from inside #[cfg(windows)] (stdout + stderr)", () => {
  it("T-CH2.8: when spawn_frondose_serve #[cfg(windows)] content is scanned, Stdio::from appears at least twice", () => {
    // Given: spawn_frondose_serve body extracted, then #[cfg(windows)] block content isolated
    // When:  counting Stdio::from occurrences inside cfg(windows) blocks only
    // Then:  ≥2 (one for stdout, one for stderr), proving both handles are redirected

    // TODO(Step 4 impl): fill after Codex adds the redirect block.
    const body = extractFunctionBody(mainRs, /async fn\s+spawn_frondose_serve\b/);
    assert.ok(body !== null, "T-CH2.8: spawn_frondose_serve body not found in main.rs");

    // Extract #[cfg(windows)] block content (same extraction as T-CH2.7).
    const cfgWindowsBlockContents: string[] = [];
    const searchStr = "#[cfg(windows)]";
    let searchFrom = 0;
    while (true) {
      const cfgIdx = body.indexOf(searchStr, searchFrom);
      if (cfgIdx === -1) {
        break;
      }
      const braceOpen = body.indexOf("{", cfgIdx + searchStr.length);
      if (braceOpen === -1) {
        searchFrom = cfgIdx + searchStr.length;
        continue;
      }
      let depth = 0;
      let closeIdx = -1;
      for (let i = braceOpen; i < body.length; i++) {
        const ch = body[i];
        if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) {
            closeIdx = i;
            break;
          }
        }
      }
      if (closeIdx !== -1) {
        cfgWindowsBlockContents.push(body.slice(braceOpen, closeIdx + 1));
        searchFrom = closeIdx + 1;
      } else {
        searchFrom = cfgIdx + searchStr.length;
      }
    }

    const combined = cfgWindowsBlockContents.join("\n");
    const count = countLiteral(combined, "Stdio::from");
    assert.ok(
      count >= 2,
      `T-CH2.8: expected ≥2 Stdio::from inside #[cfg(windows)] blocks (stdout + stderr redirect), got ${count} (not yet present pre-impl)`,
    );
  });
});

// ---------------------------------------------------------------------------
// T-CH2.9 — ≥1 Stdio::null inside #[cfg(windows)] in spawn_frondose_serve (fallback)
// ---------------------------------------------------------------------------

describe("CH-2 — spawn_frondose_serve: Stdio::null fallback inside #[cfg(windows)]", () => {
  it("T-CH2.9: when spawn_frondose_serve #[cfg(windows)] content is scanned, Stdio::null appears at least once", () => {
    // Given: spawn_frondose_serve body extracted, #[cfg(windows)] content isolated
    // When:  counting Stdio::null occurrences inside cfg(windows) blocks
    // Then:  ≥1 (the error-fallback path per plan §4 step 2.5 — never aborts the spawn)

    // TODO(Step 4 impl): fill after Codex adds the redirect block.
    const body = extractFunctionBody(mainRs, /async fn\s+spawn_frondose_serve\b/);
    assert.ok(body !== null, "T-CH2.9: spawn_frondose_serve body not found in main.rs");

    // Same cfg-windows extraction as T-CH2.7.
    const cfgWindowsBlockContents: string[] = [];
    const searchStr = "#[cfg(windows)]";
    let searchFrom = 0;
    while (true) {
      const cfgIdx = body.indexOf(searchStr, searchFrom);
      if (cfgIdx === -1) {
        break;
      }
      const braceOpen = body.indexOf("{", cfgIdx + searchStr.length);
      if (braceOpen === -1) {
        searchFrom = cfgIdx + searchStr.length;
        continue;
      }
      let depth = 0;
      let closeIdx = -1;
      for (let i = braceOpen; i < body.length; i++) {
        const ch = body[i];
        if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) {
            closeIdx = i;
            break;
          }
        }
      }
      if (closeIdx !== -1) {
        cfgWindowsBlockContents.push(body.slice(braceOpen, closeIdx + 1));
        searchFrom = closeIdx + 1;
      } else {
        searchFrom = cfgIdx + searchStr.length;
      }
    }

    const combined = cfgWindowsBlockContents.join("\n");
    const count = countLiteral(combined, "Stdio::null");
    assert.ok(
      count >= 1,
      `T-CH2.9: expected ≥1 Stdio::null inside #[cfg(windows)] (failure fallback path), got ${count} (not yet present pre-impl)`,
    );
  });
});

// ---------------------------------------------------------------------------
// T-CH2.10 — exactly one 0x08000000 in spawn_frondose_serve body
// ---------------------------------------------------------------------------

describe("CH-2 — spawn_frondose_serve: exactly one 0x08000000 (CREATE_NO_WINDOW not duplicated)", () => {
  it("T-CH2.10: when spawn_frondose_serve body is scanned, 0x08000000 appears exactly once", () => {
    // Given: spawn_frondose_serve body extracted from main.rs
    // When:  counting occurrences of the literal 0x08000000
    // Then:  exactly one — CREATE_NO_WINDOW is present (WIN-8) and not accidentally duplicated

    const body = extractFunctionBody(mainRs, /async fn\s+spawn_frondose_serve\b/);
    assert.ok(body !== null, "T-CH2.10: spawn_frondose_serve body not found in main.rs");

    const count = countLiteral(body, "0x08000000");
    assert.equal(
      count,
      1,
      `T-CH2.10: expected exactly one 0x08000000 in spawn_frondose_serve body (CREATE_NO_WINDOW), got ${count}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T-CH2.11 — exactly one windows_subsystem = "windows" in the file
// ---------------------------------------------------------------------------

describe("CH-2 — main.rs: windows_subsystem = \"windows\" appears exactly once (line 5)", () => {
  it('T-CH2.11: when main.rs is scanned, windows_subsystem = "windows" appears exactly once', () => {
    // Given: main.rs source text
    // When:  counting windows_subsystem = "windows" occurrences
    // Then:  exactly one — the subsystem attribute (cfg_attr line 5) is untouched by CH-2

    const count = countMatches(mainRs, /windows_subsystem\s*=\s*"windows"/g);
    assert.equal(
      count,
      1,
      `T-CH2.11: expected exactly one windows_subsystem = "windows" in main.rs, got ${count}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T-CH2.12 — cargo check exits 0 on macOS (cfg-windows code does not regress host build)
// ---------------------------------------------------------------------------

describe("CH-2 — cargo: cargo check on macOS exits 0 (Windows-only cfg does not break host build)", () => {
  it("T-CH2.12: when cargo check runs on macOS with the CH-2 changes, it exits 0", { skip: process.platform !== "darwin" }, () => {
    // Given: src/tauri/src-tauri/Cargo.toml on the current branch (post CH-2 impl)
    // When:  cargo check --manifest-path src/tauri/src-tauri/Cargo.toml runs on macOS
    // Then:  exit 0 with no new errors attributable to CH-2 (cfg-windows block compiled out)

    const manifestPath = join(REPO, "src/tauri/src-tauri/Cargo.toml");

    // The build/runtime stub must exist for cargo to find the bundled-resource dir at compile time.
    // This is a known gotcha: mkdir -p build/runtime prevents cargo from failing on a missing dir.
    const buildRuntimeDir = join(REPO, "build/runtime");
    if (!existsSync(buildRuntimeDir)) {
      mkdirSync(buildRuntimeDir, { recursive: true });
    }

    let exitCode = 0;
    let errorOutput = "";
    try {
      execSync(`cargo check --manifest-path "${manifestPath}"`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
    } catch (err: unknown) {
      const e = err as { status?: number; stderr?: string; stdout?: string };
      exitCode = e.status ?? 1;
      errorOutput = e.stderr ?? e.stdout ?? String(err);
    }

    assert.equal(
      exitCode,
      0,
      `T-CH2.12: cargo check must exit 0 on macOS — Windows-only cfg code must be compiled out cleanly.\nError output:\n${errorOutput}`,
    );
  });
});
