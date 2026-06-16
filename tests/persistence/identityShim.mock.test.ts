/**
 * P-28 Step 4a — T-SHIM.IDENTITY.1..5
 *
 * Tests for the readIdentity/writeIdentity config.json shims in
 * src/persistence/identity.ts (B-1: configPath DI parameter).
 * Gate coverage: G-P28.8 (v2 config.identity authoritative),
 *                G-P28.9 (legacy identity.json fallback),
 *                G-P28.10 (writeIdentity updates both config + legacy),
 *                G-P28.32 (standalone mode regression)
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readConfig } from "../../src/persistence/config.js";
import type { IdentityRecord } from "../../src/persistence/identity.js";
import { readIdentity, writeIdentity } from "../../src/persistence/identity.js";
import { cleanupTmpDir } from "../_helpers/tmp";

function makeTmpDir(): { dir: string; configPath: string; legacyPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p28-idshim-"));
  return {
    dir,
    configPath: join(dir, "config.json"),
    legacyPath: join(dir, "identity.json"),
    cleanup: () => cleanupTmpDir(dir),
  };
}

function makeV2ConfigWithIdentity(fullName = "BD Alice"): string {
  return JSON.stringify({
    schema_version: 2,
    server: { url: null, bind_address: null, poll_interval_s: 30 },
    worker: { id: null, hostname: null, label: null },
    telegram: { enabled: false, boundUserId: null, proxyUrl: null },
    soul: { override: null },
    identity: { fullName, updatedAt: new Date().toISOString() },
  });
}

function makeV2ConfigNoIdentity(): string {
  return JSON.stringify({
    schema_version: 2,
    server: { url: null, bind_address: null, poll_interval_s: 30 },
    worker: { id: null, hostname: null, label: null },
    telegram: { enabled: false, boundUserId: null, proxyUrl: null },
    soul: { override: null },
  });
}

function makeLegacyIdentity(fullName = "Legacy Alice"): string {
  return JSON.stringify({ fullName, updatedAt: new Date().toISOString() });
}

const SAMPLE_RECORD: IdentityRecord = {
  fullName: "New Alice",
  updatedAt: new Date().toISOString(),
};

// ─── T-SHIM.IDENTITY.1 ────────────────────────────────────────────────────────

describe("readIdentity: v2 config.identity is authoritative (G-P28.8)", () => {
  it("T-SHIM.IDENTITY.1: given v2 config.json with identity set, readIdentity(legacyPath, configPath) returns config.identity (not the legacy file)", async () => {
    // Given: config.json = v2 with identity.fullName="BD Alice"
    //        identity.json = {fullName:"Legacy Alice"} (should be ignored)
    // When:  readIdentity(legacyPath, configPath)  [B-1: 2-arg form]
    // Then:  returns {fullName:"BD Alice"} (from config.json, not legacy file)
    const { configPath, legacyPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(configPath, makeV2ConfigWithIdentity("BD Alice"), "utf-8");
      writeFileSync(legacyPath, makeLegacyIdentity("Legacy Alice"), "utf-8");
      const result = readIdentity(legacyPath, configPath);
      assert.ok(result !== null, "T-SHIM.IDENTITY.1: readIdentity must return non-null when config has identity");
      assert.equal(
        result.fullName,
        "BD Alice",
        "T-SHIM.IDENTITY.1: must return config.identity (not legacy file) — config is authoritative (G-P28.8)",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-SHIM.IDENTITY.2 ────────────────────────────────────────────────────────

describe("readIdentity: legacy fallback when config.json absent (G-P28.9)", () => {
  it("T-SHIM.IDENTITY.2: given no config.json, legacy identity.json present, readIdentity returns the legacy record", async () => {
    // Given: no config.json; identity.json = {fullName:"Legacy Alice"}
    // When:  readIdentity(legacyPath, configPath)  — configPath points to nonexistent file
    // Then:  returns {fullName:"Legacy Alice"} (legacy fallback)
    const { configPath, legacyPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(legacyPath, makeLegacyIdentity("Legacy Alice"), "utf-8");
      // configPath intentionally NOT written (absent)
      const result = readIdentity(legacyPath, configPath);
      assert.ok(result !== null, "T-SHIM.IDENTITY.2: readIdentity must return non-null when legacy file exists");
      assert.equal(
        result.fullName,
        "Legacy Alice",
        "T-SHIM.IDENTITY.2: must return legacy record when config.json absent (G-P28.9)",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-SHIM.IDENTITY.3 ────────────────────────────────────────────────────────

describe("readIdentity: legacy fallback when config.identity absent (G-P28.9)", () => {
  it("T-SHIM.IDENTITY.3: given v2 config.json WITHOUT identity field + legacy identity.json, readIdentity falls back to legacy", async () => {
    // Given: config.json = v2 with NO identity field
    //        identity.json = {fullName:"Legacy Alice"}
    // When:  readIdentity(legacyPath, configPath)
    // Then:  returns {fullName:"Legacy Alice"} (legacy fallback since config.identity is undefined)
    const { configPath, legacyPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(configPath, makeV2ConfigNoIdentity(), "utf-8");
      writeFileSync(legacyPath, makeLegacyIdentity("Legacy Alice"), "utf-8");
      const result = readIdentity(legacyPath, configPath);
      assert.ok(result !== null, "T-SHIM.IDENTITY.3: readIdentity must return non-null when legacy file exists");
      assert.equal(
        result.fullName,
        "Legacy Alice",
        "T-SHIM.IDENTITY.3: must fall back to legacy when config.identity absent (G-P28.9)",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-SHIM.IDENTITY.4 ────────────────────────────────────────────────────────

describe("writeIdentity: updates config.json AND legacy identity.json (G-P28.10)", () => {
  it("T-SHIM.IDENTITY.4: given a record, writeIdentity(record, legacyPath, configPath) updates config.json.identity AND writes legacy identity.json", async () => {
    // Given: config.json = v2 (no identity); no legacy identity.json
    // When:  writeIdentity(record, legacyPath, configPath)  [B-1: 3-arg form]
    // Then:  readConfig(configPath).identity.fullName === "New Alice" (config updated)
    //        JSON.parse(readFileSync(legacyPath)).fullName === "New Alice" (legacy written)
    const { configPath, legacyPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(configPath, makeV2ConfigNoIdentity(), "utf-8");
      writeIdentity(SAMPLE_RECORD, legacyPath, configPath);

      // Verify config.json updated
      const updatedCfg = readConfig(configPath);
      assert.ok(
        updatedCfg.identity !== undefined,
        "T-SHIM.IDENTITY.4: config.json.identity must be set after writeIdentity",
      );
      assert.equal(
        updatedCfg.identity?.fullName,
        "New Alice",
        "T-SHIM.IDENTITY.4: config.json.identity.fullName must be 'New Alice' (G-P28.10)",
      );

      // Verify legacy identity.json written
      const legacyContent = JSON.parse(readFileSync(legacyPath, "utf-8")) as { fullName: string };
      assert.equal(
        legacyContent.fullName,
        "New Alice",
        "T-SHIM.IDENTITY.4: legacy identity.json must also be written (G-P28.10)",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-SHIM.IDENTITY.5 ────────────────────────────────────────────────────────

describe("readIdentity/writeIdentity: standalone mode regression (G-P28.32)", () => {
  it("T-SHIM.IDENTITY.5: standalone worker (no config.json) — readIdentity falls back to legacy; writeIdentity writes legacy; behavior unchanged from pre-P-28", async () => {
    // Given: no config.json; existing identity.json with fullName="Standalone Alice"
    // When:  readIdentity(legacyPath, configPath); writeIdentity(record, legacyPath, configPath)
    // Then:  read returns "Standalone Alice"; write succeeds; legacy file updated; no throw
    const { configPath, legacyPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(legacyPath, makeLegacyIdentity("Standalone Alice"), "utf-8");
      // configPath NOT written (standalone = no config.json)

      const read1 = readIdentity(legacyPath, configPath);
      assert.ok(read1 !== null, "T-SHIM.IDENTITY.5: readIdentity must return non-null (legacy fallback)");
      assert.equal(
        read1.fullName,
        "Standalone Alice",
        "T-SHIM.IDENTITY.5: must return legacy identity when no config.json (G-P28.32)",
      );

      // writeIdentity must not throw (creates config.json as side effect, but legacy is always written)
      assert.doesNotThrow(
        () => writeIdentity(SAMPLE_RECORD, legacyPath, configPath),
        "T-SHIM.IDENTITY.5: writeIdentity must not throw in standalone mode",
      );
      const legacyContent = JSON.parse(readFileSync(legacyPath, "utf-8")) as { fullName: string };
      assert.equal(
        legacyContent.fullName,
        "New Alice",
        "T-SHIM.IDENTITY.5: legacy identity.json must be updated after write",
      );
    } finally {
      cleanup();
    }
  });
});
