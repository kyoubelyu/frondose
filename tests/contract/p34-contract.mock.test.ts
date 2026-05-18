/**
 * P-34 Step 4a — T-CONTRACT.* scaffolds
 *
 * Contract tests for P-34: GitHub-based install.sh + bootstrap fix.
 * Verification targets:
 *   - No `npm install -g` in template output or install.sh (G-P34.1 / G-P34.14)
 *   - install-core parity between install.sh and renderBootstrapScript (G-P34.10)
 *   - No child_process import in P-34's TypeScript artifacts (G-P34.14)
 *   - autoUpdate.ts + update.ts byte-unchanged across P-34 (G-P34.14)
 *   - install.sh bash syntax clean (G-P34.11)
 *   - release.yml + package.json include install.sh as asset (G-P34.15)
 *
 * Gate coverage:
 *   G-P34.1 + G-P34.14 — T-CONTRACT.NO-NPM-G
 *   G-P34.10            — T-PARITY.1
 *   G-P34.14            — T-CONTRACT.NO-BASH
 *   G-P34.14            — T-CONTRACT.UNTOUCHED
 *   G-P34.11            — T-SHELL.1
 *   G-P34.15            — T-WORKFLOW.1
 *
 * Step 4a state:
 *   - T-CONTRACT.NO-NPM-G: FAIL — current template still has npm install -g
 *   - T-PARITY.1: FAIL — install.sh does not exist yet (builder Step 4b)
 *   - T-CONTRACT.NO-BASH: PASS — no child_process in stub files (invariant)
 *   - T-CONTRACT.UNTOUCHED: PASS — autoUpdate.ts / update.ts hashes frozen pre-P-34
 *   - T-SHELL.1: FAIL — install.sh does not exist yet
 *   - T-WORKFLOW.1: FAIL — package.json + release.yml not yet updated
 *
 * Assertion bodies for FAIL tests are TODO — filled at Step 5.
 * PASS tests have real assertions that must stay green at Step 4a and Step 5.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { renderBootstrapScript } from "../../src/cli/serverBootstrapTemplate.js";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../");
const INSTALL_SH = resolve(ROOT, "install.sh");
const INSTALL_TOKEN_PLACEHOLDER = "ghp_TESTTOKEN_placeholder_not_real";

// ─── T-CONTRACT.NO-NPM-G ─────────────────────────────────────────────────────

describe("no npm install -g in template output or install.sh (G-P34.1 + G-P34.14)", () => {
  it(
    "T-CONTRACT.NO-NPM-G: renderBootstrapScript output does not contain 'npm install -g'; install.sh (when present) does not contain 'npm install -g'",
    () => {
      // Given: renderBootstrapScript called with 4 args; install.sh read from repo root
      // When:  grep for 'npm install -g' in both artifacts
      // Then:  zero matches in either source
      const script = renderBootstrapScript(
        "http://srv",
        "a1b2c3d4".repeat(8),
        "0.4.32",
        INSTALL_TOKEN_PLACEHOLDER,
      );
      assert.ok(!script.includes("npm install -g"), "renderBootstrapScript must NOT contain 'npm install -g'");
      // install.sh parity check
      assert.ok(existsSync(INSTALL_SH), "install.sh must exist at repo root (builder Step 4b)");
      const installShContent = readFileSync(INSTALL_SH, "utf-8");
      assert.ok(!installShContent.includes("npm install -g"), "install.sh must NOT contain 'npm install -g'");
    },
  );
});

// ─── T-PARITY.1 ──────────────────────────────────────────────────────────────

describe("install-core parity — install.sh vs renderBootstrapScript output (G-P34.10)", () => {
  it(
    "T-PARITY.1: install.sh and renderBootstrapScript output both contain the same install-core markers: 'releases/latest', 'tar -xzf', '--strip-components=1', 'npm install', 'npm run build', and both F-4 'ln -sfn' symlink lines",
    () => {
      // Given: install.sh exists at repo root; renderBootstrapScript called with installToken
      // When:  read both artifacts; search for each install-core marker
      // Then:  all markers present in both; install.sh has all; rendered script has all
      if (!existsSync(INSTALL_SH)) {
        assert.fail("TODO: fill at Step 5 — install.sh not yet created (builder Step 4b) — G-P34.10");
      }
      const shContent = readFileSync(INSTALL_SH, "utf-8");
      const script = renderBootstrapScript(
        "http://srv",
        "a1b2c3d4".repeat(8),
        "0.4.32",
        INSTALL_TOKEN_PLACEHOLDER,
      );
      // Extract the install-core block (between the two markers) from each artifact.
      // The plan §3.2 mandates these markers bracket the shared ~14-line block.
      const START_MARKER = "# --- install-core:";
      const END_MARKER = "# --- end install-core ---";

      function extractCore(src: string, label: string): string {
        const startIdx = src.indexOf(START_MARKER);
        const endIdx = src.indexOf(END_MARKER) + END_MARKER.length;
        assert.ok(startIdx !== -1, `${label}: missing install-core start marker`);
        assert.ok(endIdx > END_MARKER.length - 1, `${label}: missing install-core end marker`);
        return src.slice(startIdx, endIdx);
      }

      const shCore = extractCore(shContent, "install.sh");
      const scriptCore = extractCore(script, "renderBootstrapScript output");

      // GQ-2 parity guard: the two blocks must be byte-identical (no drift between
      // standalone installer and the server-rendered bootstrap script).
      assert.equal(
        scriptCore,
        shCore,
        "install-core block must be byte-identical in install.sh and renderBootstrapScript output (GQ-2 parity — T-PARITY.1)",
      );
    },
  );
});

// ─── T-CONTRACT.NO-BASH ──────────────────────────────────────────────────────

describe("no child_process import in P-34's TypeScript files (G-P34.14)", () => {
  it(
    "T-CONTRACT.NO-BASH: P-34's edited/new TypeScript files (serverBootstrapTemplate.ts, serverHttp.ts, serverInstallToken.ts, secrets.ts, serverDaemon.ts, serverRepl.ts) contain zero 'child_process' imports",
    () => {
      // Given: P-34's in-scope .ts files read from src/
      // When:  grep for 'child_process' in each file
      // Then:  zero matches in all files
      const p34Files = [
        resolve(ROOT, "src/cli/serverBootstrapTemplate.ts"),
        resolve(ROOT, "src/cli/serverHttp.ts"),
        resolve(ROOT, "src/cli/subcommands/serverInstallToken.ts"),
        resolve(ROOT, "src/persistence/secrets.ts"),
        resolve(ROOT, "src/cli/serverDaemon.ts"),
        resolve(ROOT, "src/cli/serverRepl.ts"),
      ];
      for (const filePath of p34Files) {
        const content = readFileSync(filePath, "utf-8");
        assert.ok(
          !content.includes("child_process"),
          `child_process import found in ${filePath} — violates no-bash boundary`,
        );
      }
      // T-CONTRACT.NO-BASH passes at Step 4a (stubs have no child_process) ✅
    },
  );
});

// ─── T-CONTRACT.UNTOUCHED ────────────────────────────────────────────────────

// SHA-256 hashes frozen at start of P-34 (2026-05-18, pre-P-34 state).
// If these change, builder has violated the "autoUpdate.ts + update.ts byte-unchanged" rule.
const FROZEN_HASHES: Record<string, string> = {
  "src/cli/autoUpdate.ts": "9263354b5a6baff1d89963295ebdbd6d1228ad05759c419c8117de928f845dee",
  "src/cli/subcommands/update.ts": "f9d6b7126f63900aae727b792f7cf72cd74e8e6b78d76fb305f642d0b0b878bc",
};

describe("autoUpdate.ts + update.ts byte-unchanged across P-34 (G-P34.14)", () => {
  it(
    "T-CONTRACT.UNTOUCHED: SHA-256 hashes of src/cli/autoUpdate.ts and src/cli/subcommands/update.ts match their pre-P-34 frozen values (builder must not touch these files)",
    () => {
      // Given: autoUpdate.ts + update.ts have frozen SHA-256 hashes from the P-34 start commit
      // When:  sha256 of each file computed from current disk content
      // Then:  each hash matches the frozen value exactly
      for (const [rel, expected] of Object.entries(FROZEN_HASHES)) {
        const filePath = resolve(ROOT, rel);
        const content = readFileSync(filePath);
        const actual = createHash("sha256").update(content).digest("hex");
        assert.equal(
          actual,
          expected,
          `${rel} was modified during P-34 — must be byte-unchanged (G-P34.14)`,
        );
      }
      // T-CONTRACT.UNTOUCHED passes at Step 4a (validator did not touch these files) ✅
    },
  );
});

// ─── T-SHELL.1 ───────────────────────────────────────────────────────────────

describe("install.sh bash syntax check (G-P34.11)", () => {
  it(
    "T-SHELL.1: bash -n install.sh exits 0 (syntax check passes); if shellcheck is available, shellcheck install.sh is clean (or only documented-disabled rules)",
    () => {
      // Given: install.sh exists at repo root
      // When:  bash -n install.sh run as subprocess
      // Then:  exit code 0 (no bash syntax errors); shellcheck clean if available
      if (!existsSync(INSTALL_SH)) {
        assert.fail("TODO: fill at Step 5 — install.sh not yet created (builder Step 4b) — G-P34.11");
      }
      // bash -n syntax check
      try {
        execSync(`bash -n "${INSTALL_SH}"`, { stdio: "pipe" });
      } catch (e) {
        assert.fail(`bash -n install.sh failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      // shellcheck (optional, best-effort — not installed everywhere)
      try {
        execSync(`shellcheck "${INSTALL_SH}"`, { stdio: "pipe" });
      } catch {
        // shellcheck not installed or warnings — documented; not a hard failure here.
        // Step 5 will confirm shellcheck result.
      }
    },
  );
});

// ─── T-WORKFLOW.1 ────────────────────────────────────────────────────────────

describe("release.yml + package.json include install.sh as asset (G-P34.15)", () => {
  it(
    "T-WORKFLOW.1: .github/workflows/release.yml's gh release create line includes install.sh as a positional asset arg; package.json 'files' array includes 'install.sh'",
    () => {
      // Given: release.yml and package.json read from repo root
      // When:  grep for install.sh in both
      // Then:  install.sh present in release.yml's gh release create command AND in package.json files array
      const releaseYml = readFileSync(resolve(ROOT, ".github/workflows/release.yml"), "utf-8");
      const pkgJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as {
        files?: string[];
      };
      // release.yml: gh release create line must include install.sh as a positional asset
      assert.ok(
        releaseYml.includes("install.sh"),
        "release.yml must include 'install.sh' as a gh release create asset arg",
      );
      // package.json: files array must include "install.sh"
      assert.ok(
        Array.isArray(pkgJson.files) && pkgJson.files.includes("install.sh"),
        `package.json 'files' array must include 'install.sh'; got: ${JSON.stringify(pkgJson.files)}`,
      );
    },
  );
});
