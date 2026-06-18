/**
 * CH-5 — T-CH5.1 through T-CH5.5
 *
 * Source-scan tests for the `config_home_dir()` helper added to
 * `src/tauri/src-tauri/src/main.rs` by CH-5 to fix the Windows updater-config
 * HOME bug. No Rust toolchain is invoked — pure TypeScript regex/string scanning
 * of the source file.
 *
 * Bug: `read_update_server_url()` and `read_update_check_interval_sec()` read
 * `~/.frondose/agent/config.json` via `std::env::var("HOME")`, which is EMPTY on
 * Windows — the Windows auto-updater config was unreadable (server URL always None,
 * interval always default).
 *
 * Fix: a new `fn config_home_dir() -> Option<String>` helper returns `$HOME` if set
 * and non-empty, else falls back to `%USERPROFILE%`. Both config readers now call
 * `config_home_dir()` instead of `std::env::var("HOME")` directly.
 *
 * Gate coverage:
 *   T-CH5.1  — fn config_home_dir exists exactly once
 *   T-CH5.2  — config_home_dir body references both "HOME" and "USERPROFILE"
 *   T-CH5.3  — read_update_server_url body calls config_home_dir, NOT bare HOME
 *   T-CH5.4  — read_update_check_interval_sec body calls config_home_dir, NOT bare HOME
 *   T-CH5.5  — REGRESSION GUARD: the only std::env::var("HOME") in the whole file is
 *               inside config_home_dir (count outside helper body = 0)
 *
 * POST-FIX GREEN STATE: all five tests are expected to PASS on the current branch
 * (the fix is already in place). T-CH5.5 would go RED if a future edit reintroduced
 * a bare `std::env::var("HOME")` call in any config-reading path.
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/tauri/ch5-updater-home-resolution.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// CH-3 module split (2026-06-18): config_home_dir, read_update_server_url, and
// read_update_check_interval_sec moved from main.rs to updater.rs as a pure move.
// Read updater.rs directly — all CH-5 tests assert on this module's content.
// T-CH5.5 (regression guard) removes the config_home_dir body from updater.rs and
// checks the remainder has zero var("HOME") calls — still correct in updater.rs.
const UPDATER_RS_PATH = join(REPO, "src/tauri/src-tauri/src/updater.rs");
const mainRs = readFileSync(UPDATER_RS_PATH, "utf8");

// ---------------------------------------------------------------------------
// Helpers: brace-matched function body extraction + literal counting
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

  // Walk forward from the fn declaration to find the opening brace and brace-match.
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

// ---------------------------------------------------------------------------
// T-CH5.1 — fn config_home_dir exists exactly once
// ---------------------------------------------------------------------------

describe("CH-5 — main.rs: fn config_home_dir exists exactly once", () => {
  it("T-CH5.1: when main.rs is scanned for fn config_home_dir, exactly one definition is found", () => {
    // Given: src/tauri/src-tauri/src/main.rs source text (CH-5 fix applied)
    // When:  counting occurrences of `fn config_home_dir` in the source
    // Then:  exactly one definition — the cross-platform home-dir helper introduced by CH-5

    const matches = mainRs.match(/\bfn\s+config_home_dir\b/g);
    assert.ok(
      matches !== null && matches.length === 1,
      `T-CH5.1: expected exactly one \`fn config_home_dir\` definition in main.rs, got ${matches?.length ?? 0}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T-CH5.2 — config_home_dir body references both "HOME" and "USERPROFILE"
// ---------------------------------------------------------------------------

describe("CH-5 — config_home_dir body: references HOME (primary) and USERPROFILE (Windows fallback)", () => {
  it('T-CH5.2: when the config_home_dir body is extracted, it contains both "HOME" and "USERPROFILE"', () => {
    // Given: config_home_dir body brace-matched from main.rs
    // When:  scanning the body for the two env-var key strings
    // Then:  both "HOME" and "USERPROFILE" are present — HOME-first with USERPROFILE fallback

    const body = extractFunctionBody(mainRs, /\bfn\s+config_home_dir\b/);
    assert.ok(body !== null, "T-CH5.2: config_home_dir body not found in main.rs");

    assert.ok(
      body.includes('"HOME"'),
      'T-CH5.2: config_home_dir body must reference "HOME" (primary env var on macOS/Unix)',
    );
    assert.ok(
      body.includes('"USERPROFILE"'),
      'T-CH5.2: config_home_dir body must reference "USERPROFILE" (Windows fallback env var)',
    );
  });
});

// ---------------------------------------------------------------------------
// T-CH5.3 — read_update_server_url calls config_home_dir, NOT bare std::env::var("HOME")
// ---------------------------------------------------------------------------

describe("CH-5 — read_update_server_url: calls config_home_dir(), not bare std::env::var(\"HOME\")", () => {
  it('T-CH5.3: when read_update_server_url body is extracted, config_home_dir is called and std::env::var("HOME") is absent', () => {
    // Given: read_update_server_url body brace-matched from main.rs
    // When:  scanning the body for config_home_dir call vs. bare HOME env read
    // Then:  config_home_dir appears; std::env::var("HOME") does NOT (the bug is fixed)

    const body = extractFunctionBody(mainRs, /\bfn\s+read_update_server_url\b/);
    assert.ok(body !== null, "T-CH5.3: read_update_server_url body not found in main.rs");

    assert.ok(
      body.includes("config_home_dir"),
      "T-CH5.3: read_update_server_url must call config_home_dir() (cross-platform home resolution)",
    );

    assert.equal(
      body.includes('std::env::var("HOME")'),
      false,
      'T-CH5.3: read_update_server_url must NOT contain a bare std::env::var("HOME") call (the CH-5 bug — empty on Windows)',
    );
  });
});

// ---------------------------------------------------------------------------
// T-CH5.4 — read_update_check_interval_sec calls config_home_dir, NOT bare HOME
// ---------------------------------------------------------------------------

describe("CH-5 — read_update_check_interval_sec: calls config_home_dir(), not bare std::env::var(\"HOME\")", () => {
  it('T-CH5.4: when read_update_check_interval_sec body is extracted, config_home_dir is called and std::env::var("HOME") is absent', () => {
    // Given: read_update_check_interval_sec body brace-matched from main.rs
    // When:  scanning the body for config_home_dir call vs. bare HOME env read
    // Then:  config_home_dir appears; std::env::var("HOME") does NOT

    const body = extractFunctionBody(mainRs, /\bfn\s+read_update_check_interval_sec\b/);
    assert.ok(body !== null, "T-CH5.4: read_update_check_interval_sec body not found in main.rs");

    assert.ok(
      body.includes("config_home_dir"),
      "T-CH5.4: read_update_check_interval_sec must call config_home_dir() (cross-platform home resolution)",
    );

    assert.equal(
      body.includes('std::env::var("HOME")'),
      false,
      'T-CH5.4: read_update_check_interval_sec must NOT contain a bare std::env::var("HOME") call (the CH-5 bug — empty on Windows)',
    );
  });
});

// ---------------------------------------------------------------------------
// T-CH5.5 — REGRESSION GUARD: the only std::env::var("HOME") in the file is
//            inside config_home_dir; count OUTSIDE that body = 0
// ---------------------------------------------------------------------------

describe('CH-5 REGRESSION GUARD — std::env::var("HOME") outside config_home_dir body must be 0', () => {
  it('T-CH5.5: when the config_home_dir body is removed from main.rs, std::env::var("HOME") does not appear in the remainder', () => {
    // Given: main.rs source text; config_home_dir body brace-matched and excised
    // When:  counting std::env::var("HOME") occurrences in the remainder (everything
    //        outside config_home_dir)
    // Then:  count is 0 — any future edit that reintroduces a bare HOME read in a
    //        config-reading path (e.g. a new reader, a copy-paste of the old code)
    //        will make this test go RED

    const helperBody = extractFunctionBody(mainRs, /\bfn\s+config_home_dir\b/);
    assert.ok(helperBody !== null, "T-CH5.5: config_home_dir body not found — cannot perform regression check");

    // Remove the helper body from the source text (replace with empty string).
    // This isolates every OTHER occurrence of std::env::var("HOME") in the file.
    const remainder = mainRs.replace(helperBody, "");

    // Match the broad `var("HOME")` substring so the guard also catches the
    // `env::var("HOME")` variant (with a `use std::env` import), not only the
    // fully-qualified `std::env::var("HOME")` form (CH-5 audit F-1).
    const countOutside = countLiteral(remainder, 'var("HOME")');
    assert.equal(
      countOutside,
      0,
      `T-CH5.5: found ${countOutside} occurrence(s) of var("HOME") OUTSIDE config_home_dir body. ` +
        "The only legitimate HOME read must be inside config_home_dir. " +
        "A bare HOME read elsewhere means the CH-5 bug has been reintroduced in a config-reading path.",
    );
  });
});
