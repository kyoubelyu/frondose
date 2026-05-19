/**
 * P-28 Step 4a — T-MIGRATE.V1V2.1..7
 *
 * Tests for config.json v1→v2 migration in src/persistence/config.ts.
 * Gate coverage: G-P28.1 (v1+identity.json fold), G-P28.2 (v1 no identity.json),
 *                G-P28.3 (v1+soul_band_override.txt fold), G-P28.4 (v2 direct parse),
 *                G-P28.5 (migration persisted on disk), G-P28.6 (v1 fields lossless),
 *                G-P28.7 (server identity.json shape mismatch → identity undefined)
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readConfig } from "../../src/persistence/config.js";

function makeTmpDir(): { dir: string; configPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p28-cfgv2-"));
  return {
    dir,
    configPath: join(dir, "config.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Minimal valid v1 config JSON. */
function v1Json(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema_version: 1, ...extra });
}

/** Minimal valid IdentityRecord-shaped JSON (passes identityRecordSchema). */
function identityJson(fullName = "BD Alice"): string {
  return JSON.stringify({ fullName, updatedAt: new Date().toISOString() });
}

/** A ServerIdentity-shaped JSON (fails identityRecordSchema — no updatedAt). */
function serverIdentityJson(): string {
  return JSON.stringify({
    workerId: "w1",
    personaId: "p1",
    registeredAt: new Date().toISOString(),
  });
}

// ─── T-MIGRATE.V1V2.1 ─────────────────────────────────────────────────────────

describe("readConfig v1→v2: folds sibling identity.json (G-P28.1, G-P28.6)", () => {
  it("T-MIGRATE.V1V2.1: given v1 config.json + identity.json in same dir, readConfig returns v2 with identity folded and server.url preserved", async () => {
    // Given: config.json = {schema_version:1, server:{url:"http://100.64.0.5:3031"}}
    //        identity.json = {fullName:"BD Alice", updatedAt:"..."}
    // When:  readConfig(configPath)
    // Then:  result.schema_version === 2; result.identity.fullName === "BD Alice";
    //        result.server.url === "http://100.64.0.5:3031" (lossless G-P28.6)
    const { dir, configPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(configPath, v1Json({ server: { url: "http://100.64.0.5:3031" } }), "utf-8");
      writeFileSync(join(dir, "identity.json"), identityJson("BD Alice"), "utf-8");
      const result = readConfig(configPath);
      assert.equal(result.schema_version, 2, "T-MIGRATE.V1V2.1: schema_version must be 2 after migration");
      assert.ok(result.identity !== undefined && result.identity !== null, "T-MIGRATE.V1V2.1: identity must be folded");
      assert.equal(result.identity?.fullName, "BD Alice", "T-MIGRATE.V1V2.1: identity.fullName must be 'BD Alice'");
      assert.equal(
        result.server.url,
        "http://100.64.0.5:3031",
        "T-MIGRATE.V1V2.1: server.url must be preserved (G-P28.6)",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-MIGRATE.V1V2.2 ─────────────────────────────────────────────────────────

describe("readConfig v1→v2: no identity.json → identity undefined (G-P28.2)", () => {
  it("T-MIGRATE.V1V2.2: given v1 config.json, no identity.json in dir, readConfig returns v2 with identity === undefined", async () => {
    // Given: config.json = {schema_version:1}; no identity.json sibling
    // When:  readConfig(configPath)
    // Then:  result.schema_version === 2; result.identity === undefined
    const { configPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(configPath, v1Json(), "utf-8");
      const result = readConfig(configPath);
      assert.equal(result.schema_version, 2, "T-MIGRATE.V1V2.2: schema_version must be 2");
      assert.equal(
        result.identity,
        undefined,
        "T-MIGRATE.V1V2.2: identity must be undefined when no identity.json sibling",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-MIGRATE.V1V2.3 ─────────────────────────────────────────────────────────

describe("readConfig v1→v2: folds soul_band_override.txt (G-P28.3)", () => {
  it("T-MIGRATE.V1V2.3: given v1 config.json + soul_band_override.txt with multi-line text, readConfig returns v2 with soul.override set", async () => {
    // Given: config.json = {schema_version:1}
    //        soul_band_override.txt = "CUSTOM\nSOUL\nTEXT\n" (multi-line)
    // When:  readConfig(configPath)
    // Then:  result.schema_version === 2; result.soul.override === "CUSTOM\nSOUL\nTEXT" (trimmed)
    const { dir, configPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(configPath, v1Json(), "utf-8");
      writeFileSync(join(dir, "soul_band_override.txt"), "CUSTOM\nSOUL\nTEXT\n", "utf-8");
      const result = readConfig(configPath);
      assert.equal(result.schema_version, 2, "T-MIGRATE.V1V2.3: schema_version must be 2");
      assert.equal(
        result.soul.override,
        "CUSTOM\nSOUL\nTEXT",
        "T-MIGRATE.V1V2.3: soul.override must be trimmed soul_band_override.txt content",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-MIGRATE.V1V2.4 ─────────────────────────────────────────────────────────

describe("readConfig v2: direct parse, no re-write (G-P28.4)", () => {
  it("T-MIGRATE.V1V2.4: given existing v2 config.json, readConfig parses directly; on-disk bytes unchanged after call", async () => {
    // Given: config.json = {schema_version:2, soul:{override:null}, ...}
    // When:  readConfig(configPath) (capture bytes before + after)
    // Then:  result.schema_version === 2; file bytes identical before/after (no re-write)
    const { configPath, cleanup } = makeTmpDir();
    try {
      const v2 = JSON.stringify({
        schema_version: 2,
        server: { url: "http://srv", bind_address: null, poll_interval_s: 30 },
        worker: { id: "w1", hostname: "h1", label: null },
        telegram: { enabled: false, boundUserId: null, proxyUrl: null },
        soul: { override: null },
      });
      writeFileSync(configPath, v2, "utf-8");
      const bytesBefore = readFileSync(configPath, "utf-8");
      const result = readConfig(configPath);
      const bytesAfter = readFileSync(configPath, "utf-8");
      assert.equal(result.schema_version, 2, "T-MIGRATE.V1V2.4: schema_version must be 2 for v2 file");
      assert.equal(bytesAfter, bytesBefore, "T-MIGRATE.V1V2.4: file bytes must be unchanged — v2 is not re-written");
    } finally {
      cleanup();
    }
  });
});

// ─── T-MIGRATE.V1V2.5 ─────────────────────────────────────────────────────────

describe("readConfig v1→v2: migration persisted on disk (G-P28.5)", () => {
  it("T-MIGRATE.V1V2.5: given v1 config.json, after readConfig the on-disk file is v2; second readConfig reads v2 directly (idempotent)", async () => {
    // Given: config.json = {schema_version:1}
    // When:  first readConfig → migrates + writes v2; second readConfig
    // Then:  JSON.parse(file).schema_version === 2 after first call;
    //        second call result.schema_version === 2 (idempotent — no double-migration)
    const { configPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(configPath, v1Json(), "utf-8");
      const r1 = readConfig(configPath); // migrates + persists v2
      const diskAfter = JSON.parse(readFileSync(configPath, "utf-8")) as { schema_version: number };
      const r2 = readConfig(configPath); // reads v2 directly — no re-migration
      assert.equal(r1.schema_version, 2, "T-MIGRATE.V1V2.5: first readConfig must return schema_version 2");
      assert.equal(diskAfter.schema_version, 2, "T-MIGRATE.V1V2.5: on-disk schema_version must be 2 after migration");
      assert.equal(
        r2.schema_version,
        2,
        "T-MIGRATE.V1V2.5: second readConfig must return schema_version 2 (idempotent)",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-MIGRATE.V1V2.6 ─────────────────────────────────────────────────────────

describe("readConfig v1→v2: server-style identity.json shape mismatch (G-P28.7)", () => {
  it("T-MIGRATE.V1V2.6: given v1 config.json at server-style path + sibling ServerIdentity-shaped identity.json, config.identity stays undefined", async () => {
    // Given: config.json = {schema_version:1}
    //        identity.json = {workerId:"w1", personaId:"p1"} (ServerIdentity — no updatedAt)
    // When:  readConfig(configPath)
    // Then:  result.schema_version === 2; result.identity === undefined (safeParse rejects shape)
    const { dir, configPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(configPath, v1Json(), "utf-8");
      writeFileSync(join(dir, "identity.json"), serverIdentityJson(), "utf-8");
      const result = readConfig(configPath);
      assert.equal(result.schema_version, 2, "T-MIGRATE.V1V2.6: schema_version must be 2");
      assert.equal(
        result.identity,
        undefined,
        "T-MIGRATE.V1V2.6: identity must be undefined when shape fails identityRecordSchema (G-P28.7)",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-MIGRATE.V1V2.7 ─────────────────────────────────────────────────────────

describe("readConfig: corrupt config.json → DEFAULT_CONFIG_V2 (G-P28.4 sibling)", () => {
  it("T-MIGRATE.V1V2.7: given corrupt (non-JSON) config.json, readConfig returns DEFAULT_CONFIG_V2 with schema_version:2 without throwing", async () => {
    // Given: config.json = "NOT_JSON{" (syntactically invalid JSON)
    // When:  readConfig(configPath)
    // Then:  returns DEFAULT_CONFIG_V2 (schema_version:2, server/worker/telegram defaults); no throw
    const { configPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(configPath, "NOT_JSON{", "utf-8");
      let result: ReturnType<typeof readConfig> | undefined;
      assert.doesNotThrow(() => {
        result = readConfig(configPath);
      }, "T-MIGRATE.V1V2.7: readConfig must not throw on corrupt JSON");
      assert.ok(result !== undefined, "result must not be undefined");
      assert.equal(
        result?.schema_version,
        2,
        "T-MIGRATE.V1V2.7: corrupt config → DEFAULT_CONFIG_V2 with schema_version:2",
      );
      assert.equal(result?.server.url, null, "T-MIGRATE.V1V2.7: server.url must be null (DEFAULT_CONFIG_V2)");
    } finally {
      cleanup();
    }
  });
});
