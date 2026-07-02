/**
 * P-58d.2 Step 4a — Scaffolds: T-Manifest.1–4
 *
 * Covers scripts/gen-latest-json.mjs — the Option-A dual-key Tauri updater
 * manifest generator (~30 LOC Node ESM script, extracted for testability).
 *
 * Strategy: write a tmp .sig fixture, run the script via execFileSync/spawnSync
 * with env vars, read OUT_PATH, assert the output JSON shape.
 * child_process in test code is explicitly permitted (the no-bash lint ban is
 * src/tools/** only; this is build-layer tooling in scripts/).
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * NOTE: gen-latest-json.mjs is not created until builder Step 4b.
 * execFileSync / spawnSync will throw ENOENT; each test wraps the call in
 * try/catch so the file-missing failure is logged, then assert.fail("TODO")
 * ensures the test still fails. After Step 4b the script exists and the tests
 * reach the TODO assertion branch.
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * Gate coverage:
 *   G-P58d2.2 ← T-Manifest.1–4 (+ S-Live.1 at Step 5)
 *
 * All assertion bodies are TODO — intentionally failing scaffolds (Step 4a).
 * Builder Step 4b creates gen-latest-json.mjs; validator Step 5 fills assertions.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit tests/scripts/genLatestJson.mock.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupTmpDir } from "../_helpers/tmp";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(REPO, "scripts", "gen-latest-json.mjs");

function makeTmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p58d2-manifest-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

// ── T-Manifest.1 ─────────────────────────────────────────────────────────────

describe("gen-latest-json.mjs — Option-A dual-key manifest (G-P58d2.2)", () => {
  it("T-Manifest.1: dual darwin-x86_64 + darwin-aarch64 keys; same url+sig; correct version", () => {
    // Given: SIG_PATH → tmp file with content "SIGBLOB123"; VERSION=0.5.0-alpha.29;
    //        MANIFEST_URL=http://192.168.1.100:4875/downloads/Frondose.app.tar.gz;
    //        OUT_PATH=<fresh tmp path>
    // When:  node scripts/gen-latest-json.mjs runs with those env vars
    // Then:  OUT_PATH JSON has platforms["darwin-x86_64"] AND platforms["darwin-aarch64"];
    //        BOTH .url === MANIFEST_URL; BOTH .signature === "SIGBLOB123";
    //        top-level version === "0.5.0-alpha.29"
    const { dir, cleanup } = makeTmp();
    try {
      const sigPath = join(dir, "test.sig");
      const outPath = join(dir, "latest.json");
      writeFileSync(sigPath, "SIGBLOB123", "utf-8");
      try {
        execFileSync("node", [SCRIPT], {
          env: {
            ...process.env,
            SIG_PATH: sigPath,
            VERSION: "0.5.0-alpha.29",
            MANIFEST_URL: "http://192.168.1.100:4875/downloads/Frondose.app.tar.gz",
            OUT_PATH: outPath,
          },
          encoding: "utf-8",
        });
      } catch {
        // Script not yet created (ENOENT) — builder Step 4b will create it
      }
      const manifest = JSON.parse(readFileSync(outPath, "utf-8")) as Record<string, unknown>;
      const platforms = manifest.platforms as Record<string, { url: string; signature: string }>;
      assert.deepEqual(Object.keys(platforms).sort(), ["darwin-aarch64", "darwin-x86_64"]);
      const manifestUrl = "http://192.168.1.100:4875/downloads/Frondose.app.tar.gz";
      assert.equal(platforms["darwin-x86_64"]?.url, manifestUrl);
      assert.equal(platforms["darwin-x86_64"]?.signature, "SIGBLOB123");
      assert.equal(platforms["darwin-aarch64"]?.url, manifestUrl);
      assert.equal(platforms["darwin-aarch64"]?.signature, "SIGBLOB123");
      assert.equal(manifest.version, "0.5.0-alpha.29");
    } finally {
      cleanup();
    }
  });
});

describe("gen-latest-json.mjs — WIN-5 dual-platform manifest keeps darwin and adds windows-x86_64", () => {
  it("T-Manifest.WIN5.1: when macOS and Windows artifact env are present, platforms contains darwin-x86_64, darwin-aarch64, and windows-x86_64", () => {
    // Given: macOS and Windows updater sig fixtures plus LAN artifact URLs
    // When:  node scripts/gen-latest-json.mjs runs with both platform pairs
    // Then:  darwin keys keep the macOS URL/signature and windows-x86_64 uses the Windows URL/signature
    const { dir, cleanup } = makeTmp();
    try {
      const macSigPath = join(dir, "mac.sig");
      const winSigPath = join(dir, "win.sig");
      const outPath = join(dir, "latest.json");
      writeFileSync(macSigPath, "MAC_SIG", "utf-8");
      writeFileSync(winSigPath, "WIN_SIG", "utf-8");

      execFileSync("node", [SCRIPT], {
        env: {
          ...process.env,
          SIG_PATH: macSigPath,
          VERSION: "v0.5.0-alpha.71",
          MANIFEST_URL: "http://192.168.1.100:4875/downloads/Frondose.app.tar.gz",
          WINDOWS_SIG_PATH: winSigPath,
          WINDOWS_MANIFEST_URL: "http://192.168.1.100:4875/downloads/Frondose-windows-x86_64-setup.exe",
          OUT_PATH: outPath,
          PUB_DATE: "2026-07-02T00:00:00Z",
        },
        encoding: "utf-8",
      });

      const manifest = JSON.parse(readFileSync(outPath, "utf-8")) as Record<string, unknown>;
      const platforms = manifest.platforms as Record<string, { url: string; signature: string }>;
      assert.deepEqual(Object.keys(platforms).sort(), ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]);
      assert.equal(platforms["darwin-x86_64"]?.url, "http://192.168.1.100:4875/downloads/Frondose.app.tar.gz");
      assert.equal(platforms["darwin-aarch64"]?.signature, "MAC_SIG");
      assert.equal(
        platforms["windows-x86_64"]?.url,
        "http://192.168.1.100:4875/downloads/Frondose-windows-x86_64-setup.exe",
      );
      assert.equal(platforms["windows-x86_64"]?.signature, "WIN_SIG");
      assert.equal(manifest.version, "0.5.0-alpha.71");
    } finally {
      cleanup();
    }
  });
});

describe("gen-latest-json.mjs — WIN-5 Windows env must be supplied as a complete pair", () => {
  it("T-Manifest.WIN5.2: when WINDOWS_MANIFEST_URL is set without WINDOWS_SIG_PATH, exit code !== 0 and OUT_PATH is not written", () => {
    // Given: Windows URL env is present but the Windows sig path is absent
    // When:  the manifest generator runs
    // Then:  it fails before writing OUT_PATH so a broken windows-x86_64 entry cannot publish
    const { dir, cleanup } = makeTmp();
    try {
      const macSigPath = join(dir, "mac.sig");
      const outPath = join(dir, "latest.json");
      writeFileSync(macSigPath, "MAC_SIG", "utf-8");
      const envNoWinSig: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k !== "WINDOWS_SIG_PATH" && k !== "WIN_SIG_PATH" && v !== undefined) {
          envNoWinSig[k] = v;
        }
      }

      const result = spawnSync("node", [SCRIPT], {
        env: {
          ...envNoWinSig,
          SIG_PATH: macSigPath,
          VERSION: "0.5.0-alpha.71",
          MANIFEST_URL: "http://host:4875/downloads/Frondose.app.tar.gz",
          WINDOWS_MANIFEST_URL: "http://host:4875/downloads/Frondose-windows-x86_64-setup.exe",
          OUT_PATH: outPath,
        },
        encoding: "utf-8",
      });

      assert.notEqual(result.status, 0, "incomplete Windows env pair must fail");
      assert.ok(!existsSync(outPath), "OUT_PATH must not be written when Windows env is incomplete");
    } finally {
      cleanup();
    }
  });
});

// ── T-Manifest.2 ─────────────────────────────────────────────────────────────

describe("gen-latest-json.mjs — strips leading 'v' from VERSION (G-P58d2.2)", () => {
  it("T-Manifest.2: when VERSION=v1.2.3, output top-level version === '1.2.3' (v stripped)", () => {
    // Given: VERSION=v1.2.3 (with leading 'v' prefix)
    // When:  script runs
    // Then:  output JSON top-level version === "1.2.3" (leading v stripped)
    const { dir, cleanup } = makeTmp();
    try {
      const sigPath = join(dir, "test.sig");
      const outPath = join(dir, "latest.json");
      writeFileSync(sigPath, "SIG", "utf-8");
      try {
        execFileSync("node", [SCRIPT], {
          env: {
            ...process.env,
            SIG_PATH: sigPath,
            VERSION: "v1.2.3",
            MANIFEST_URL: "http://host:4875/downloads/Frondose.app.tar.gz",
            OUT_PATH: outPath,
          },
          encoding: "utf-8",
        });
      } catch {
        // Script not yet created (ENOENT) — builder Step 4b will create it
      }
      const manifest = JSON.parse(readFileSync(outPath, "utf-8")) as Record<string, unknown>;
      assert.equal(manifest.version, "1.2.3"); // leading 'v' stripped by .replace(/^v/, "")
    } finally {
      cleanup();
    }
  });
});

// ── T-Manifest.3 ─────────────────────────────────────────────────────────────

describe("gen-latest-json.mjs — pub_date is RFC3339; explicit PUB_DATE passes through verbatim (G-P58d2.2)", () => {
  it("T-Manifest.3: unset PUB_DATE → RFC3339 auto; explicit PUB_DATE passes through verbatim", () => {
    // Given (a): PUB_DATE unset
    // When:  script runs
    // Then:  output pub_date matches /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
    // Given (b): PUB_DATE="2026-01-15T12:00:00Z"
    // When:  script runs
    // Then:  output pub_date === "2026-01-15T12:00:00Z" (passed through verbatim)
    const { dir, cleanup } = makeTmp();
    try {
      const sigPath = join(dir, "test.sig");
      const outPathA = join(dir, "latest-a.json");
      const outPathB = join(dir, "latest-b.json");
      writeFileSync(sigPath, "SIG", "utf-8");
      const baseEnv = {
        ...process.env,
        SIG_PATH: sigPath,
        VERSION: "0.5.0",
        MANIFEST_URL: "http://host:4875/downloads/Frondose.app.tar.gz",
      };

      // (a) no PUB_DATE → auto-generated RFC3339
      try {
        execFileSync("node", [SCRIPT], {
          env: { ...baseEnv, OUT_PATH: outPathA },
          encoding: "utf-8",
        });
      } catch {
        /* script not yet created */
      }

      // (b) explicit PUB_DATE passes through
      try {
        execFileSync("node", [SCRIPT], {
          env: { ...baseEnv, PUB_DATE: "2026-01-15T12:00:00Z", OUT_PATH: outPathB },
          encoding: "utf-8",
        });
      } catch {
        /* script not yet created */
      }

      // (a) auto-generated pub_date must be RFC3339 (no milliseconds, Z suffix)
      const mA = JSON.parse(readFileSync(outPathA, "utf-8")) as Record<string, unknown>;
      assert.match(String(mA.pub_date), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      // (b) explicit PUB_DATE must pass through verbatim
      const mB = JSON.parse(readFileSync(outPathB, "utf-8")) as Record<string, unknown>;
      assert.equal(mB.pub_date, "2026-01-15T12:00:00Z");
    } finally {
      cleanup();
    }
  });
});

// ── T-Manifest.4 ─────────────────────────────────────────────────────────────

describe("gen-latest-json.mjs — missing SIG_PATH → non-zero exit; OUT_PATH not written [3b NIT-2] (G-P58d2.2)", () => {
  it("T-Manifest.4: when SIG_PATH is unset, exit code !== 0 AND OUT_PATH file does not exist after run", () => {
    // Given: SIG_PATH intentionally absent from env; others present;
    //        OUT_PATH is a FRESH non-existent temp path (asserting absence of a freshly-chosen
    //        path avoids the misread where a pre-existing file looks like a partial write)
    // When:  script runs
    // Then:  exit code !== 0 (script prints error + process.exit(1))
    //        AND the OUT_PATH file does not exist after the run (no partial write)
    const { dir, cleanup } = makeTmp();
    try {
      const outPath = join(dir, "should-not-exist.json");
      // Pre-condition: OUT_PATH must not exist before the script runs
      assert.ok(!existsSync(outPath), "pre-condition: OUT_PATH must be absent before the script run");

      // Build env WITHOUT SIG_PATH
      const envNoSigPath: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k !== "SIG_PATH" && v !== undefined) {
          envNoSigPath[k] = v;
        }
      }

      const result = spawnSync("node", [SCRIPT], {
        env: {
          ...envNoSigPath,
          VERSION: "0.5.0",
          MANIFEST_URL: "http://host:4875/downloads/Frondose.app.tar.gz",
          OUT_PATH: outPath,
          // SIG_PATH deliberately omitted
        },
        encoding: "utf-8",
      });

      assert.notEqual(result.status, 0, "missing SIG_PATH must produce a non-zero exit code");
      assert.ok(!existsSync(outPath), "OUT_PATH must not be written when required env is missing [3b NIT-2]");
    } finally {
      cleanup();
    }
  });
});

// ── T-Manifest.5 (P-UPDATE-INTRANET §6.C) ───────────────────────────────────

describe("gen-latest-json.mjs — unified multi-platform manifest, auto pub_date (P-UPDATE-INTRANET T-Manifest.5)", () => {
  it("T-Manifest.5: given both macOS and Windows sig+url pairs, platforms has exactly darwin-x86_64/darwin-aarch64/windows-x86_64, each signature===file contents, version===VERSION, pub_date is RFC3339", () => {
    // Given: SIG_PATH+MANIFEST_URL AND WINDOWS_SIG_PATH+WINDOWS_MANIFEST_URL, PUB_DATE unset
    // When:  node scripts/gen-latest-json.mjs runs (release.sh's unified-manifest step, plan §6.B step 3)
    // Then:  platforms has exactly the 3 keys, each {url,signature} correct, version===VERSION, pub_date auto-RFC3339
    // NOTE: gen-latest-json.mjs already supports the WINDOWS_ pair (verified :17-18/48-53) — this is an
    // ALREADY-GREEN regression pin of the unified-manifest contract release.sh (Step 4, not yet built) depends on.
    const { dir, cleanup } = makeTmp();
    try {
      const macSigPath = join(dir, "mac.sig");
      const winSigPath = join(dir, "win.sig");
      const outPath = join(dir, "latest.json");
      writeFileSync(macSigPath, "MAC_SIGNATURE_BLOB", "utf-8");
      writeFileSync(winSigPath, "WIN_SIGNATURE_BLOB", "utf-8");

      execFileSync("node", [SCRIPT], {
        env: {
          ...process.env,
          SIG_PATH: macSigPath,
          MANIFEST_URL: "http://intranet-host.local:4875/downloads/Frondose.app.tar.gz",
          WINDOWS_SIG_PATH: winSigPath,
          WINDOWS_MANIFEST_URL: "http://intranet-host.local:4875/downloads/Frondose-windows-x86_64-setup.exe",
          VERSION: "0.5.0-alpha.76",
          OUT_PATH: outPath,
          // PUB_DATE deliberately unset — asserts the auto-RFC3339 path with both platforms present
        },
        encoding: "utf-8",
      });

      const manifest = JSON.parse(readFileSync(outPath, "utf-8")) as Record<string, unknown>;
      const platforms = manifest.platforms as Record<string, { url: string; signature: string }>;
      assert.deepEqual(Object.keys(platforms).sort(), ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]);
      assert.equal(platforms["darwin-x86_64"]?.url, "http://intranet-host.local:4875/downloads/Frondose.app.tar.gz");
      assert.equal(platforms["darwin-x86_64"]?.signature, "MAC_SIGNATURE_BLOB");
      assert.equal(platforms["darwin-aarch64"]?.url, "http://intranet-host.local:4875/downloads/Frondose.app.tar.gz");
      assert.equal(platforms["darwin-aarch64"]?.signature, "MAC_SIGNATURE_BLOB");
      assert.equal(
        platforms["windows-x86_64"]?.url,
        "http://intranet-host.local:4875/downloads/Frondose-windows-x86_64-setup.exe",
      );
      assert.equal(platforms["windows-x86_64"]?.signature, "WIN_SIGNATURE_BLOB");
      assert.equal(manifest.version, "0.5.0-alpha.76");
      assert.match(String(manifest.pub_date), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    } finally {
      cleanup();
    }
  });
});
