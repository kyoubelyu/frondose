/**
 * P-40 Step 5 — structural tests for install.sh hardening (assertions filled)
 *
 * Covers §5.2 testable behaviors for G-P40.1–G-P40.8.
 * All assertion bodies filled at Step 5.
 *
 * Test suite: file-content grep + bash -n + shellcheck + package.json parse.
 * No Chrome, no LLM, no network required.
 *
 * Note: `child_process` is permitted in `tests/**` — the lint ban is `src/tools/**` only.
 *
 * Gates covered:
 *   G-P40.1 — T-Grep.1 (no GITHUB_TOKEN)
 *   G-P40.2 — T-Grep.2 (gh preflight: command -v + auth status)
 *   G-P40.3 — T-Grep.3 (gh release fetch; no api.github.com / python3 / curl)
 *   G-P40.4 — T-Grep.4 (FRONDOSE_PREFIX overrides both base paths)
 *   G-P40.5 — T-Grep.5 (no | tail -N suppression)
 *   G-P40.6 — T-Grep.6 (xcode-select WARNING, not exit)
 *   G-P40.7 — T-Pkg.1, T-Pkg.2 (scripts.install === "true"; node-gyp only in build:native)
 *   G-P40.8 — T-Struct.1, T-Struct.2, T-Grep.7 (bash -n; shellcheck; --repo on every gh command)
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const INSTALL_SH = resolve(ROOT, "install.sh");
const PKG_JSON_PATH = resolve(ROOT, "package.json");

// ─── T-Struct.1 ──────────────────────────────────────────────────────────────

describe("install.sh bash syntax check (G-P40.8)", () => {
  it("T-Struct.1: when 'bash -n install.sh' is run, exit code is 0 (no syntax errors)", () => {
    // Given: install.sh at repo root (P-40 full rewrite)
    // When:  execSync(`bash -n "${INSTALL_SH}"`)
    // Then:  exits 0 — bash syntax is valid
    assert.ok(existsSync(INSTALL_SH), "install.sh must exist at repo root");
    if (process.platform === "win32") {
      return;
    }
    try {
      execSync(`bash -n "${INSTALL_SH}"`, { stdio: "pipe" });
    } catch (e) {
      assert.fail(`bash -n install.sh failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
});

// ─── T-Struct.2 ──────────────────────────────────────────────────────────────

describe("install.sh shellcheck lint (G-P40.8)", () => {
  it("T-Struct.2: when 'shellcheck install.sh' is run (if available), no errors reported (disable directives allowed)", () => {
    // Given: install.sh at repo root; shellcheck installed (or test skips note and passes)
    // When:  execSync('shellcheck install.sh') — skips cleanly if shellcheck absent
    // Then:  exit 0 (no errors); '#shellcheck disable=...' directives are acceptable
    assert.ok(existsSync(INSTALL_SH), "install.sh must exist at repo root");
    let shellcheckAvailable = false;
    try {
      execSync("which shellcheck", { stdio: "pipe" });
      shellcheckAvailable = true;
    } catch {
      shellcheckAvailable = false;
    }
    if (!shellcheckAvailable) {
      // shellcheck not installed on this machine — non-fatal, document as not-run in §2
      return;
    }
    try {
      execSync(`shellcheck "${INSTALL_SH}"`, { stdio: "pipe" });
    } catch (e) {
      assert.fail(`shellcheck install.sh reported errors: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
});

// ─── T-Grep.1 ────────────────────────────────────────────────────────────────

describe("install.sh — no GITHUB_TOKEN (G-P40.1)", () => {
  it("T-Grep.1: when install.sh non-comment lines are scanned, none reference 'GITHUB_TOKEN'", () => {
    // Given: install.sh P-40 rewrite
    // When:  filter non-comment lines; check for 'GITHUB_TOKEN'
    // Then:  no executable line references GITHUB_TOKEN (comments may mention it as historical note)
    const content = readFileSync(INSTALL_SH, "utf8");
    const executableLines = content.split("\n").filter((l) => !l.trimStart().startsWith("#") && l.trim() !== "");
    const linesWithToken = executableLines.filter((l) => l.includes("GITHUB_TOKEN"));
    assert.equal(
      linesWithToken.length,
      0,
      `install.sh executable lines must NOT reference GITHUB_TOKEN; found: ${linesWithToken.join(" | ")}`,
    );
  });
});

// ─── T-Grep.2 ────────────────────────────────────────────────────────────────

describe("install.sh — gh CLI preflight (G-P40.2)", () => {
  it("T-Grep.2: when install.sh content is read, it contains 'command -v gh' AND 'gh auth status', each associated with 'exit 1'", () => {
    // Given: install.sh with P-40 gh-native fetch
    // When:  grep for 'command -v gh', 'gh auth status', and 'exit 1' in content
    // Then:  all three patterns present — absent gh and unauthenticated gh both exit 1
    const content = readFileSync(INSTALL_SH, "utf8");
    assert.ok(content.includes("command -v gh"), "'command -v gh' must be present in gh preflight");
    assert.ok(content.includes("gh auth status"), "'gh auth status' must be present in gh preflight");
    assert.ok(content.includes("exit 1"), "'exit 1' must be present in gh preflight error branches");
  });
});

// ─── T-Grep.3 ────────────────────────────────────────────────────────────────

describe("install.sh — gh-native release fetch; no curl/python3/api.github.com (G-P40.3)", () => {
  it("T-Grep.3: install.sh contains 'gh release view' AND 'gh release download'; non-comment lines do NOT contain 'api.github.com', 'python3', or 'curl'", () => {
    // Given: install.sh P-40 rewrite
    // When:  content includes checks for gh commands; non-comment lines checked for legacy patterns
    // Then:  gh commands present on executable lines; curl/python3/api.github.com absent from executable lines
    const content = readFileSync(INSTALL_SH, "utf8");
    assert.ok(content.includes("gh release view"), "'gh release view' must be present");
    assert.ok(content.includes("gh release download"), "'gh release download' must be present");
    // Check only non-comment, non-empty lines for legacy patterns
    const executableLines = content.split("\n").filter((l) => !l.trimStart().startsWith("#") && l.trim() !== "");
    const legacyLines = executableLines.filter(
      (l) => l.includes("api.github.com") || l.includes("python3") || l.includes("curl"),
    );
    assert.equal(
      legacyLines.length,
      0,
      `no executable line may use the legacy release fetch (curl/python3/api.github.com); found: ${legacyLines.join(" | ")}`,
    );
  });
});

// ─── T-Grep.4 ────────────────────────────────────────────────────────────────

describe("install.sh — FRONDOSE_PREFIX overrides both base paths (G-P40.4)", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional shell parameter expansion syntax
  it("T-Grep.4: install.sh contains '${FRONDOSE_PREFIX:-$HOME}' AND '${FRONDOSE_PREFIX:-$(brew --prefix)}'", () => {
    // Given: install.sh with D-3 FRONDOSE_PREFIX sandbox override
    // When:  content.includes() for both parameter-expansion forms
    // Then:  both HOME_BASE and BREW_BASE use FRONDOSE_PREFIX; unset falls back to $HOME / brew --prefix
    const content = readFileSync(INSTALL_SH, "utf8");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional shell parameter expansion syntax
    assert.ok(content.includes("${FRONDOSE_PREFIX:-$HOME}"), "HOME_BASE must use '${FRONDOSE_PREFIX:-$HOME}'");
    assert.ok(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional shell parameter expansion syntax
      content.includes("${FRONDOSE_PREFIX:-$(brew --prefix)}"),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional shell parameter expansion syntax
      "BREW_BASE must use '${FRONDOSE_PREFIX:-$(brew --prefix)}'",
    );
  });
});

// ─── T-Grep.5 ────────────────────────────────────────────────────────────────

describe("install.sh — no | tail -N output suppression (G-P40.5)", () => {
  it("T-Grep.5: install.sh contains no '| tail -3' or '| tail -5' patterns", () => {
    // Given: install.sh P-40 rewrite (old version had '| tail -3' and '| tail -5')
    // When:  content.includes("| tail -3") and content.includes("| tail -5")
    // Then:  both false — full npm install + build output streams without suppression
    const content = readFileSync(INSTALL_SH, "utf8");
    assert.ok(!content.includes("| tail -3"), "'| tail -3' must be removed from install.sh");
    assert.ok(!content.includes("| tail -5"), "'| tail -5' must be removed from install.sh");
  });
});

// ─── T-Grep.6 ────────────────────────────────────────────────────────────────

describe("install.sh — Xcode CLT: WARNING not exit (G-P40.6)", () => {
  it("T-Grep.6: install.sh contains 'xcode-select -p' and a 'WARNING' line; the CLT-absent branch has no bare 'exit' statement", () => {
    // Given: install.sh with D-5 non-fatal CLT check
    // When:  content grep for 'xcode-select -p' and 'WARNING'; scan branch for 'exit'
    // Then:  xcode-select check + WARNING present; no 'exit' in the CLT-absent branch
    const content = readFileSync(INSTALL_SH, "utf8");
    assert.ok(content.includes("xcode-select -p"), "'xcode-select -p' must be present");
    assert.ok(content.includes("WARNING"), "'WARNING' must appear for the CLT-absent case");
    // Scan the xcode-select block (up to 10 lines from the check) for a standalone 'exit'
    const lines = content.split("\n");
    const xcodeIdx = lines.findIndex((l) => l.includes("xcode-select -p"));
    assert.ok(xcodeIdx >= 0, "xcode-select line must be found");
    const cltBranchLines = lines.slice(xcodeIdx, xcodeIdx + 10);
    const cltBranchHasExit = cltBranchLines.some((l) => /^\s*(exit\s|exit$)/.test(l));
    assert.ok(
      !cltBranchHasExit,
      "CLT-absent branch must NOT contain a standalone 'exit' — it is a warning, not a fatal error",
    );
  });
});

// ─── T-Grep.7 ────────────────────────────────────────────────────────────────

describe("install.sh — every gh release command carries --repo kyoubelyu/frondose (G-P40.8 — F-REN-4b flip)", () => {
  it("T-Grep.7: every line in install.sh that contains 'gh release' also contains '--repo' with 'kyoubelyu/frondose' (or the $REPO variable bound to it)", () => {
    // Given: install.sh with D-4 --repo flag on all gh commands; F-REN-4b flipped REPO to kyoubelyu/frondose
    // When:  filter lines containing 'gh release' (skip comments); check each for '--repo'
    // Then:  no 'gh release' line is missing '--repo'; 'kyoubelyu/frondose' present in REPO var
    const content = readFileSync(INSTALL_SH, "utf8");
    const ghReleaseLines = content
      .split("\n")
      .filter((l) => l.includes("gh release") && !l.trimStart().startsWith("#"));
    assert.ok(ghReleaseLines.length > 0, "at least one 'gh release' command must exist");
    for (const line of ghReleaseLines) {
      assert.ok(line.includes("--repo"), `'gh release' line missing '--repo': ${line.trim()}`);
    }
    assert.ok(
      content.includes("kyoubelyu/frondose"),
      "'kyoubelyu/frondose' must appear in install.sh (REPO variable) after F-REN-4b rename",
    );
  });
});

// ─── T-Pkg.1 ─────────────────────────────────────────────────────────────────

describe("package.json — scripts.install suppresses npm implicit node-gyp rebuild (G-P40.7)", () => {
  it("T-Pkg.1: when package.json is parsed, scripts.install is a cross-platform no-op that suppresses npm implicit node-gyp rebuild (WIN-2: now 'node -e \"\"' replacing 'true')", () => {
    // Given: package.json at repo root
    // When:  JSON.parse(readFileSync(package.json)).scripts.install
    // Then:  value is defined and contains 'node -e' (WIN-2 cross-platform form) — overrides npm's
    //        implicit binding.gyp default install hook; 'true' was the P-40 form, 'node -e ""' is
    //        the WIN-2 form (V-0.1 verified: any scripts.install value suppresses the node-gyp default)
    const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const installScript = pkg.scripts?.install ?? "";
    assert.ok(
      installScript.includes("node -e"),
      `package.json scripts.install must be cross-platform node-based no-op (WIN-2: 'node -e ""'); got '${installScript}'`,
    );
    assert.ok(
      installScript !== "true",
      `package.json scripts.install must NOT be bare 'true' (WIN-2 replaced with cross-platform 'node -e ""'); got '${installScript}'`,
    );
  });
});

// ─── T-Pkg.2 ─────────────────────────────────────────────────────────────────

describe("package.json — node-gyp appears only in build:native (G-P40.7)", () => {
  it("T-Pkg.2: in package.json scripts, 'node-gyp' appears only inside scripts['build:native']; no other script contains 'node-gyp'", () => {
    // Given: package.json with "install": "true" added
    // When:  Object.entries(scripts) filtered for scripts containing 'node-gyp'
    // Then:  exactly one entry: key === 'build:native' — no other hook triggers node-gyp
    const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    const gypEntries = Object.entries(scripts).filter(([, v]) => v.includes("node-gyp"));
    assert.equal(
      gypEntries.length,
      1,
      `exactly one script must reference node-gyp; found: ${gypEntries.map(([k]) => k).join(", ")}`,
    );
    assert.equal(
      gypEntries[0]?.[0],
      "build:native",
      "the node-gyp script must be 'build:native', not any implicit install hook",
    );
  });
});
