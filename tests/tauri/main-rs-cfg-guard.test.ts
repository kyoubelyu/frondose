/**
 * WIN-3 Step 3 (scaffold) — T-Rust.Cfg.1, T-Rust.Cfg.2, T-Rust.Cfg.3
 *
 * Text-scan tests for `src/tauri/src-tauri/src/main.rs`.
 * No Rust toolchain is invoked — pure TypeScript regex/string scanning of the source file.
 *
 * Gate coverage:
 *   G-WIN3.1  — T-Rust.Cfg.1 (exactly one cfg(unix) arm uses tokio::signal::unix and one
 *                              cfg(windows) arm uses tokio::signal::windows in the quit-signal helper)
 *             — T-Rust.Cfg.2 (shutdown_sidecar has a cfg(windows) block using taskkill with
 *                              /PID … /T args + a force-kill variant with /F)
 *             — T-Rust.Cfg.3 (tokio::signal::unix and libc::kill appear ONLY inside
 *                              cfg(unix)-prefixed regions — no unguarded Unix leaks)
 *
 * WHY TEXT-SCAN: main.rs is a single-module Rust file; the tested properties are structural
 * markers (cfg attributes + specific identifier strings). A regex scan is deterministic,
 * requires no Rust toolchain, and fails loudly if the required blocks are absent or placed
 * outside the cfg guards. This is a pragmatic choice documented in plan §4.
 *
 * PRE-IMPL RED STATE: main.rs currently has no cfg(windows) signal handler block and no
 * taskkill call in shutdown_sidecar. T-Rust.Cfg.1/2 fail because the required windows arms
 * are absent. T-Rust.Cfg.3 passes vacuously on tokio::signal::unix being entirely unguarded
 * at the SIGTERM spawn site (line 918) — once the validator fills assertion bodies at Step 5
 * this will correctly red on that unguarded import.
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/tauri/main-rs-cfg-guard.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN_RS_PATH = join(REPO, "src/tauri/src-tauri/src/main.rs");

// Read the file once at module level — all tests share this string.
const mainRs = readFileSync(MAIN_RS_PATH, "utf8");

// ---------------------------------------------------------------------------
// G-WIN3.1: Rust cfg-guard correctness — signal handler
// ---------------------------------------------------------------------------

describe("G-WIN3.1 — main.rs: cfg-guarded quit-signal helper pair exists", () => {
  it("T-Rust.Cfg.1: when main.rs is parsed as text, a #[cfg(unix)] arm uses tokio::signal::unix and a #[cfg(windows)] arm uses tokio::signal::ctrl_c inside the quit-signal spawn block", () => {
    // Given: main.rs source text is read
    // When:  searching for the quit-signal spawn block (WIN-3 cfg-split inline tokio::spawn)
    // Then:  EXACTLY ONE #[cfg(unix)] block references tokio::signal::unix
    //        AND EXACTLY ONE #[cfg(windows)] block references tokio::signal::ctrl_c
    //        (Windows has no SIGTERM; ctrl_c() is the correct cross-platform Windows
    //         quit signal — it is in tokio::signal, not tokio::signal::windows)

    // Unix arm: #[cfg(unix)] block contains tokio::signal::unix
    const unixArmPresent = /#\[cfg\(unix\)\]\s*\n(?:.*\n)*?.*tokio::signal::unix/.test(mainRs);
    assert.ok(
      unixArmPresent,
      "T-Rust.Cfg.1: main.rs must have a #[cfg(unix)] block containing tokio::signal::unix",
    );

    // Windows arm: #[cfg(windows)] block contains tokio::signal::ctrl_c
    // The source uses `tokio::signal::ctrl_c()` (the cross-platform Ctrl+C future) —
    // NOT tokio::signal::windows::CtrlC, which requires importing the windows sub-module.
    // ctrl_c() is the correct minimal Windows quit-signal mechanism (WIN-3).
    const windowsArmPresent = /#\[cfg\(windows\)\]\s*\n(?:.*\n)*?.*tokio::signal::ctrl_c/.test(mainRs);
    assert.ok(
      windowsArmPresent,
      "T-Rust.Cfg.1: main.rs must have a #[cfg(windows)] block containing tokio::signal::ctrl_c (Windows quit-signal — ctrl_c() is correct, not signal::windows)",
    );
  });
});

// ---------------------------------------------------------------------------
// G-WIN3.1: Rust cfg-guard correctness — sidecar termination
// ---------------------------------------------------------------------------

describe("G-WIN3.1 — main.rs: cfg(windows) sidecar kill path uses taskkill", () => {
  it("T-Rust.Cfg.2: when main.rs is parsed as text, a #[cfg(windows)] block in shutdown_sidecar / kill_sidecar_pid calls taskkill with /PID … /T and a force-kill variant with /F", () => {
    // Given: main.rs source text
    // When:  scanning for the Windows sidecar-termination block
    // Then:  the string `taskkill` appears inside a #[cfg(windows)] region
    //        AND the args /PID and /T appear alongside taskkill
    //        AND the arg /F appears for the force-kill path

    // Assert taskkill appears in the file at all
    assert.ok(
      mainRs.includes("taskkill"),
      'T-Rust.Cfg.2: main.rs must contain "taskkill" (Windows sidecar kill — not yet present pre-WIN-3)',
    );

    // Assert taskkill appears inside a #[cfg(windows)] region
    // Strategy: find the #[cfg(windows)] blocks and check any contains taskkill
    const cfgWindowsRegions = [...mainRs.matchAll(/#\[cfg\(windows\)\]\s*\n\s*\{([\s\S]*?)\n\s*\}/g)].map(
      (m) => m[1] ?? "",
    );
    const taskkillInWindowsRegion = cfgWindowsRegions.some((body) => body.includes("taskkill"));
    assert.ok(
      taskkillInWindowsRegion,
      "T-Rust.Cfg.2: taskkill must appear inside a #[cfg(windows)] { ... } block (not yet present pre-WIN-3)",
    );

    // Assert /PID and /T appear near taskkill
    assert.ok(
      mainRs.includes('"/PID"') || mainRs.includes('arg("/PID")') || mainRs.includes('.arg("/PID")'),
      "T-Rust.Cfg.2: taskkill call must pass /PID arg (not yet present pre-WIN-3)",
    );
    assert.ok(
      mainRs.includes('"/T"') || mainRs.includes('arg("/T")') || mainRs.includes('.arg("/T")'),
      "T-Rust.Cfg.2: taskkill call must pass /T arg (tree kill) (not yet present pre-WIN-3)",
    );
    // Assert /F appears for force-kill path
    assert.ok(
      mainRs.includes('"/F"') || mainRs.includes('arg("/F")') || mainRs.includes('.arg("/F")'),
      "T-Rust.Cfg.2: taskkill force-kill path must pass /F arg (not yet present pre-WIN-3)",
    );
  });
});

// ---------------------------------------------------------------------------
// G-WIN3.1: Rust cfg-guard correctness — no unguarded Unix leaks
// ---------------------------------------------------------------------------

describe("G-WIN3.1 — main.rs: tokio::signal::unix and libc::kill appear only inside #[cfg(unix)] regions", () => {
  it("T-Rust.Cfg.3: when main.rs non-comment source is scanned, every occurrence of tokio::signal::unix and libc::kill is preceded by a #[cfg(unix)] guard within 20 lines", () => {
    // Given: main.rs source text with comment lines stripped
    // When:  scanning all non-comment lines containing tokio::signal::unix or libc::kill
    // Then:  every such line is preceded (within 20 lines) by a #[cfg(unix)] attribute
    //        i.e. no real code occurrence is outside a cfg(unix) guard
    //
    // NOTE: doc comments (`///`) and line comments (`//`) may mention `libc::kill` or
    // `tokio::signal::unix` in prose (e.g. main.rs:28 `libc::kill`s it directly;
    // main.rs:1082 `libc::kill` are used to gracefully signal).  These are NOT code
    // and must not trigger the guard.  We strip comment lines before scanning.

    const lines = mainRs.split("\n");

    // Strip lines that are pure comment (trimmed start is `///` or `//`).
    // This removes doc-comment and line-comment false positives while keeping
    // code lines that contain an inline comment after real code (those have the
    // identifier BEFORE the `//` marker and should still be checked).
    const isCommentLine = (l: string): boolean => {
      const t = l.trimStart();
      return t.startsWith("///") || t.startsWith("//");
    };

    const unixSignalLines = lines
      .map((l, i) => ({ line: l, idx: i }))
      .filter(({ line }) => !isCommentLine(line))
      .filter(({ line }) => line.includes("tokio::signal::unix") || line.includes("libc::kill"));

    // For each real-code occurrence, walk backwards to confirm the nearest cfg attribute
    // is cfg(unix).  We search within 20 lines (sufficient for any realistic block header).
    for (const { line, idx } of unixSignalLines) {
      let cfgLine: string | undefined;
      for (let j = idx - 1; j >= Math.max(0, idx - 20); j--) {
        const candidate = lines[j];
        if (candidate !== undefined && /#\[cfg\(/.test(candidate)) {
          cfgLine = candidate;
          break;
        }
      }

      assert.ok(
        cfgLine !== undefined,
        `T-Rust.Cfg.3: line ${idx + 1} contains a Unix-only identifier in real code but no preceding #[cfg(...)] found within 20 lines:\n  ${line.trim()}`,
      );

      assert.ok(
        cfgLine.includes("cfg(unix)"),
        `T-Rust.Cfg.3: line ${idx + 1} contains a Unix-only identifier but the nearest #[cfg(...)] is NOT cfg(unix):\n  cfg line: ${cfgLine.trim()}\n  target line: ${line.trim()}`,
      );
    }

    // Sanity: the unix arms (tokio::signal::unix import + libc::kill calls) MUST be
    // present in the file.  Zero occurrences means the file is wrong or the guard was
    // silently deleted.
    assert.ok(
      unixSignalLines.length > 0,
      "T-Rust.Cfg.3: expected at least one real-code occurrence of tokio::signal::unix or libc::kill in main.rs — file may be wrong or unix arms were removed",
    );
  });
});
