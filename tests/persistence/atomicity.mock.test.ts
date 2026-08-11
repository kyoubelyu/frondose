/**
 * P-24 Step 5 — atomicity + mode assertions for secrets.ts + config.ts
 *
 * Covers: tmp+rename invariant, chmod 0o600 on fresh vs overwrite write,
 * writeConfig no-chmod assertion, directory-EACCES cleanup.
 *
 * Note on T-ATOMIC.1: ESM live bindings prevent mocking renameSync via
 * require/import namespace patching. Instead, we use chmodSync(dir, 0o555)
 * to make the directory read-only, triggering EACCES on writeFileSync(tmp,...).
 * This exercises the same invariant (write fails → original preserved → error propagates).
 *
 * Gate coverage:
 *   G-P24.3 — T-ATOMIC.1
 *   G-P24.5 — T-ATOMIC.4
 *   G-P24.7 — T-ATOMIC.2, T-ATOMIC.3
 *
 * No Chrome, no LLM required.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type ConfigJsonV2, readConfig, writeConfig } from "../../src/persistence/config.js";
import { writeSecrets } from "../../src/persistence/secrets.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "mai-p24-atomic-"));
  return {
    dir,
    secretsPath: join(dir, "secrets.json"),
    configPath: join(dir, "config.json"),
    cleanup: () => cleanupTmpDir(dir),
  };
}

const posixPermissionsOptions: { skip?: string } =
  process.platform === "win32"
    ? { skip: "POSIX chmod/read-only directory semantics are not portable to Windows." }
    : {};

// ─── T-ATOMIC.1 ──────────────────────────────────────────────────────────────

describe("writeSecrets — directory EACCES: original unchanged; error propagates (G-P24.3)", () => {
  it(
    "T-ATOMIC.1: when writeSecrets called and target directory is read-only, original secrets.json unchanged and error propagates",
    posixPermissionsOptions,
    () => {
      // Given: existing secrets.json with {schema_version:1, default:'anthropic:claude-sonnet-4-5'}
      //        directory made read-only (0o555) to trigger EACCES on tmp file creation
      // When:  writeSecrets({schema_version:1, default:'new-model'}, secretsPath)
      // Then:  EACCES error propagates to caller; original secrets.json content === 'anthropic:claude-sonnet-4-5'
      //        (exercises the same invariant as renameSync failure path: original preserved on write error)
      const { dir, secretsPath, cleanup } = makeTmpDir();
      try {
        writeFileSync(
          secretsPath,
          JSON.stringify({ schema_version: 1, default: "anthropic:claude-sonnet-4-5" }),
          "utf-8",
        );
        const origContent = readFileSync(secretsPath, "utf-8");

        chmodSync(dir, 0o555); // make directory read-only → writeFileSync(tmp,...) throws EACCES
        let threw = false;
        try {
          writeSecrets({ schema_version: 1, default: "new-model" }, secretsPath);
        } catch (e) {
          threw = true;
          assert.ok(e instanceof Error, "T-ATOMIC.1: thrown value must be an Error instance");
        } finally {
          chmodSync(dir, 0o755); // restore before any reads
        }
        assert.ok(threw, "T-ATOMIC.1: writeSecrets must throw when directory is read-only");
        assert.equal(
          readFileSync(secretsPath, "utf-8"),
          origContent,
          "T-ATOMIC.1: original secrets.json must be unchanged after EACCES",
        );
      } finally {
        try {
          chmodSync(dir, 0o755);
        } catch {
          // already restored
        }
        cleanup();
      }
    },
  );
});

// ─── T-ATOMIC.2 ──────────────────────────────────────────────────────────────

describe("writeSecrets — mode 0o600 preserved on overwrite (G-P24.7)", () => {
  it(
    "T-ATOMIC.2: when existing secrets.json at 0o600 is overwritten by writeSecrets, result still has mode 0o600",
    posixPermissionsOptions,
    () => {
      // Given: secrets.json exists at mode 0o600 (initial write by writeSecrets)
      // When:  writeSecrets called again with updated payload
      // Then:  statSync(secretsPath).mode & 0o777 === 0o600 (belt-and-suspenders chmodSync preserved mode)
      const { secretsPath, cleanup } = makeTmpDir();
      try {
        // First write → creates at 0o600
        writeSecrets({ schema_version: 1, default: "anthropic:claude-sonnet-4-5" }, secretsPath);
        assert.equal(
          statSync(secretsPath).mode & 0o777,
          0o600,
          "T-ATOMIC.2: pre-condition: initial write must be 0o600",
        );
        // Second write (overwrite)
        writeSecrets({ schema_version: 1, default: "openai:gpt-4o" }, secretsPath);
        const mode = statSync(secretsPath).mode & 0o777;
        assert.equal(mode, 0o600, `T-ATOMIC.2: overwrite must preserve 0o600 mode; got ${mode.toString(8)}`);
      } finally {
        cleanup();
      }
    },
  );
});

// ─── T-ATOMIC.3 ──────────────────────────────────────────────────────────────

describe("writeSecrets — mode 0o600 on fresh file (G-P24.7)", () => {
  it(
    "T-ATOMIC.3: when secrets.json does not exist before writeSecrets, fresh file has mode 0o600 (covers R-7 mode race on first write)",
    posixPermissionsOptions,
    () => {
      // Given: secretsPath does not exist
      // When:  writeSecrets({schema_version:1}, secretsPath)
      // Then:  statSync(secretsPath).mode & 0o777 === 0o600
      const { secretsPath, cleanup } = makeTmpDir();
      try {
        assert.ok(!existsSync(secretsPath), "T-ATOMIC.3: pre-condition: secretsPath must not exist");
        writeSecrets({ schema_version: 1 }, secretsPath);
        const mode = statSync(secretsPath).mode & 0o777;
        assert.equal(mode, 0o600, `T-ATOMIC.3: fresh file must have mode 0o600; got ${mode.toString(8)}`);
      } finally {
        cleanup();
      }
    },
  );
});

// ─── T-ATOMIC.4 ──────────────────────────────────────────────────────────────

describe("writeConfig — no chmod 0o600; tmp artifact gone after write (G-P24.5)", () => {
  it("T-ATOMIC.4: when writeConfig called, .tmp file does not remain; written file mode is NOT 0o600 (config has no secrets)", () => {
    // Given: valid ConfigJson (all defaults); config.json pre-written to avoid migration
    // When:  writeConfig(cfg, configPath)
    // Then:  configPath + '.tmp' does NOT exist after call
    //        statSync(configPath).mode & 0o777 !== 0o600 (umask-derived, not restricted)
    const { configPath, cleanup } = makeTmpDir();
    try {
      // Pre-write to avoid migration reading real ~/.mai/agent/telegram.json
      writeFileSync(configPath, JSON.stringify({ schema_version: 2, updateServerUrl: null }), "utf-8");
      const cfg: ConfigJsonV2 = readConfig(configPath);
      writeConfig(cfg, configPath);

      assert.ok(existsSync(configPath), "T-ATOMIC.4: config.json must exist after writeConfig");
      assert.ok(!existsSync(configPath + ".tmp"), "T-ATOMIC.4: .tmp artifact must not exist after write");
      const mode = statSync(configPath).mode & 0o777;
      assert.notEqual(
        mode,
        0o600,
        `T-ATOMIC.4: config.json must NOT have 0o600 mode (no secrets); got ${mode.toString(8)}`,
      );
    } finally {
      cleanup();
    }
  });
});
