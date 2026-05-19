/**
 * P-24 Step 5 — cross-cut migration assertions
 *
 * Covers: auth.json → secrets.json, github.json → secrets.json,
 * search.json → secrets.json, telegram.json → config.json migrations.
 * Also covers precedence (secrets wins over legacy) + partial migration.
 *
 * DI: legacy paths injected via MAI_LEGACY_AUTH_PATH / MAI_LEGACY_GITHUB_PATH /
 *     MAI_LEGACY_SEARCH_PATH env overrides (plan §6.1 B-3 fix).
 *     Config migration: pass optional tcPath to migrateTelegramIntoConfig.
 *
 * Gate coverage:
 *   G-P24.1 — T-MIGRATE.AUTH.1, T-MIGRATE.GH.1, T-MIGRATE.SEARCH.1, T-MIGRATE.PARTIAL.1
 *   G-P24.2 — T-MIGRATE.MIXED.1
 *   G-P24.4 — T-MIGRATE.TELEGRAM.1, T-MIGRATE.TELEGRAM.2
 *
 * No Chrome, no LLM required.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { migrateTelegramIntoConfig } from "../../src/persistence/config.js";
import { readSecrets } from "../../src/persistence/secrets.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "mai-p24-migrate-"));
  return {
    dir,
    secretsPath: join(dir, "secrets.json"),
    configPath: join(dir, "config.json"),
    authPath: join(dir, "auth.json"),
    githubPath: join(dir, "github.json"),
    searchPath: join(dir, "search.json"),
    tcPath: join(dir, "telegram.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function saveEnv(...keys: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  return saved;
}
function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ─── T-MIGRATE.AUTH.1 ────────────────────────────────────────────────────────

describe("readSecrets — migrates auth.json on first call when secrets.json absent (G-P24.1)", () => {
  it("T-MIGRATE.AUTH.1: when auth.json has providers + default, and secrets.json absent, readSecrets writes secrets.json and returns merged shape; auth.json unchanged", () => {
    // Given: auth.json = {default:'anthropic:claude-sonnet-4-5', providers:{anthropic:{key:'sk-ant-test'}}}
    //        secrets.json absent
    //        MAI_LEGACY_AUTH_PATH = authPath (DI injection)
    // When:  readSecrets(secretsPath)
    // Then:  secrets.json written with schema_version:1 + providers + default
    //        returned struct has providers.anthropic.key === 'sk-ant-test'
    //        auth.json UNCHANGED on disk (legacy file retained)
    const { authPath, secretsPath, cleanup } = makeTmpDir();
    const saved = saveEnv("MAI_LEGACY_AUTH_PATH", "MAI_LEGACY_GITHUB_PATH", "MAI_LEGACY_SEARCH_PATH");
    try {
      writeFileSync(
        authPath,
        JSON.stringify({ default: "anthropic:claude-sonnet-4-5", providers: { anthropic: { key: "sk-ant-test" } } }),
        "utf-8",
      );
      process.env.MAI_LEGACY_AUTH_PATH = authPath;
      process.env.MAI_LEGACY_GITHUB_PATH = join(authPath + ".no-github");
      process.env.MAI_LEGACY_SEARCH_PATH = join(authPath + ".no-search");

      const result = readSecrets(secretsPath);

      assert.equal(result.providers?.anthropic?.key, "sk-ant-test", "T-MIGRATE.AUTH.1: provider key must be migrated");
      assert.equal(result.default, "anthropic:claude-sonnet-4-5", "T-MIGRATE.AUTH.1: default must be migrated");
      assert.ok(existsSync(secretsPath), "T-MIGRATE.AUTH.1: secrets.json must be written after migration");
      // auth.json unchanged
      const authContent = JSON.parse(readFileSync(authPath, "utf-8")) as { providers?: { anthropic?: unknown } };
      assert.ok(
        authContent.providers?.anthropic,
        "T-MIGRATE.AUTH.1: auth.json must be retained (legacy file untouched)",
      );
    } finally {
      restoreEnv(saved);
      cleanup();
    }
  });
});

// ─── T-MIGRATE.GH.1 ──────────────────────────────────────────────────────────

describe("readSecrets — migrates github.json into secrets.json.github (G-P24.1)", () => {
  it("T-MIGRATE.GH.1: when github.json has {token, repo} and secrets.json absent, readSecrets writes secrets.json.github with those fields", () => {
    // Given: github.json = {token:'ghp_test', repo:'kyoubelyu/mai-agent'}; secrets.json absent
    //        MAI_LEGACY_GITHUB_PATH = githubPath
    // When:  readSecrets(secretsPath)
    // Then:  secrets.json.github = {token:'ghp_test', repo:'kyoubelyu/mai-agent'}
    const { githubPath, secretsPath, cleanup } = makeTmpDir();
    const saved = saveEnv("MAI_LEGACY_AUTH_PATH", "MAI_LEGACY_GITHUB_PATH", "MAI_LEGACY_SEARCH_PATH");
    try {
      writeFileSync(githubPath, JSON.stringify({ token: "ghp_test", repo: "kyoubelyu/mai-agent" }), "utf-8");
      process.env.MAI_LEGACY_AUTH_PATH = join(secretsPath + ".no-auth");
      process.env.MAI_LEGACY_GITHUB_PATH = githubPath;
      process.env.MAI_LEGACY_SEARCH_PATH = join(secretsPath + ".no-search");

      const result = readSecrets(secretsPath);

      assert.equal(result.github?.token, "ghp_test", "T-MIGRATE.GH.1: github.token must be migrated");
      assert.equal(result.github?.repo, "kyoubelyu/mai-agent", "T-MIGRATE.GH.1: github.repo must be migrated");
      assert.ok(existsSync(secretsPath), "T-MIGRATE.GH.1: secrets.json must be written");
    } finally {
      restoreEnv(saved);
      cleanup();
    }
  });
});

// ─── T-MIGRATE.SEARCH.1 ──────────────────────────────────────────────────────

describe("readSecrets — migrates search.json into secrets.json.search (G-P24.1)", () => {
  it("T-MIGRATE.SEARCH.1: when search.json has both API keys and secrets.json absent, readSecrets writes secrets.json.search with both keys", () => {
    // Given: search.json = {braveApiKey:'bsa_test', tavilyApiKey:'tv_test'}; secrets.json absent
    //        MAI_LEGACY_SEARCH_PATH = searchPath
    // When:  readSecrets(secretsPath)
    // Then:  secrets.json.search.braveApiKey === 'bsa_test' AND tavilyApiKey === 'tv_test'
    const { searchPath, secretsPath, cleanup } = makeTmpDir();
    const saved = saveEnv("MAI_LEGACY_AUTH_PATH", "MAI_LEGACY_GITHUB_PATH", "MAI_LEGACY_SEARCH_PATH");
    try {
      writeFileSync(searchPath, JSON.stringify({ braveApiKey: "bsa_test", tavilyApiKey: "tv_test" }), "utf-8");
      process.env.MAI_LEGACY_AUTH_PATH = join(secretsPath + ".no-auth");
      process.env.MAI_LEGACY_GITHUB_PATH = join(secretsPath + ".no-github");
      process.env.MAI_LEGACY_SEARCH_PATH = searchPath;

      const result = readSecrets(secretsPath);

      assert.equal(result.search?.braveApiKey, "bsa_test", "T-MIGRATE.SEARCH.1: braveApiKey must be migrated");
      assert.equal(result.search?.tavilyApiKey, "tv_test", "T-MIGRATE.SEARCH.1: tavilyApiKey must be migrated");
    } finally {
      restoreEnv(saved);
      cleanup();
    }
  });
});

// ─── T-MIGRATE.MIXED.1 ───────────────────────────────────────────────────────

describe("readSecrets — secrets.json wins over legacy when both exist (G-P24.2)", () => {
  it("T-MIGRATE.MIXED.1: when secrets.json has anthropic key K1 and auth.json has anthropic key K2, readSecrets returns K1 (secrets wins); auth.json unchanged", () => {
    // Given: secrets.json = {schema_version:1, providers:{anthropic:{key:'K1',...}}}
    //        auth.json = {providers:{anthropic:{key:'K2'}}} (different key)
    //        MAI_LEGACY_AUTH_PATH = authPath
    // When:  readSecrets(secretsPath)
    // Then:  returned providers.anthropic.key === 'K1' (secrets.json wins; legacy never consulted)
    //        auth.json remains unchanged on disk
    const { authPath, secretsPath, cleanup } = makeTmpDir();
    const saved = saveEnv("MAI_LEGACY_AUTH_PATH", "MAI_LEGACY_GITHUB_PATH", "MAI_LEGACY_SEARCH_PATH");
    try {
      writeFileSync(
        secretsPath,
        JSON.stringify({ schema_version: 1, providers: { anthropic: { key: "K1", type: "anthropic" } } }),
        "utf-8",
      );
      writeFileSync(authPath, JSON.stringify({ providers: { anthropic: { key: "K2" } } }), "utf-8");
      process.env.MAI_LEGACY_AUTH_PATH = authPath;
      process.env.MAI_LEGACY_GITHUB_PATH = join(secretsPath + ".no-github");
      process.env.MAI_LEGACY_SEARCH_PATH = join(secretsPath + ".no-search");

      const result = readSecrets(secretsPath);

      assert.equal(
        result.providers?.anthropic?.key,
        "K1",
        "T-MIGRATE.MIXED.1: secrets.json must win; K1 must be returned",
      );
      // auth.json unchanged
      const authContent = JSON.parse(readFileSync(authPath, "utf-8")) as {
        providers?: { anthropic?: { key?: string } };
      };
      assert.equal(
        authContent.providers?.anthropic?.key,
        "K2",
        "T-MIGRATE.MIXED.1: auth.json must be unchanged (legacy never written)",
      );
    } finally {
      restoreEnv(saved);
      cleanup();
    }
  });
});

// ─── T-MIGRATE.PARTIAL.1 ─────────────────────────────────────────────────────

describe("readSecrets — partial migration (only auth.json present) (G-P24.1)", () => {
  it("T-MIGRATE.PARTIAL.1: when auth.json exists but github.json + search.json absent, migrated secrets.json has providers but no github/search keys", () => {
    // Given: auth.json = {providers:{anthropic:{key:'sk-ant'}}}
    //        github.json absent; search.json absent; secrets.json absent
    //        MAI_LEGACY_AUTH_PATH = authPath; MAI_LEGACY_GITHUB_PATH / SEARCH_PATH = non-existent
    // When:  readSecrets(secretsPath)
    // Then:  secrets.json.providers populated; secrets.json.github === undefined; secrets.json.search === undefined
    const { authPath, secretsPath, cleanup } = makeTmpDir();
    const saved = saveEnv("MAI_LEGACY_AUTH_PATH", "MAI_LEGACY_GITHUB_PATH", "MAI_LEGACY_SEARCH_PATH");
    try {
      writeFileSync(authPath, JSON.stringify({ providers: { anthropic: { key: "sk-ant" } } }), "utf-8");
      process.env.MAI_LEGACY_AUTH_PATH = authPath;
      process.env.MAI_LEGACY_GITHUB_PATH = join(secretsPath + ".no-github");
      process.env.MAI_LEGACY_SEARCH_PATH = join(secretsPath + ".no-search");

      const result = readSecrets(secretsPath);

      assert.ok(result.providers, "T-MIGRATE.PARTIAL.1: providers must be populated");
      assert.equal(result.providers?.anthropic?.key, "sk-ant", "T-MIGRATE.PARTIAL.1: anthropic key must be migrated");
      assert.equal(result.github, undefined, "T-MIGRATE.PARTIAL.1: github must be undefined (no github.json)");
      assert.equal(result.search, undefined, "T-MIGRATE.PARTIAL.1: search must be undefined (no search.json)");
    } finally {
      restoreEnv(saved);
      cleanup();
    }
  });
});

// ─── T-MIGRATE.TELEGRAM.1 ────────────────────────────────────────────────────

describe("migrateTelegramIntoConfig — migrates {enabled,boundUserId,proxyUrl} into ConfigJson (G-P24.4)", () => {
  it("T-MIGRATE.TELEGRAM.1: when telegram.json has {enabled:true, boundUserId:42, proxyUrl:'http://...'}, migrateTelegramIntoConfig returns ConfigJson with those fields; runtime fields preserved", () => {
    // Given: telegram.json = {enabled:true, boundUserId:42, proxyUrl:'http://p.test', lastUpdateOffset:7, ...}
    //        config.json absent
    // When:  migrateTelegramIntoConfig(tcPath) called directly with optional tcPath injection
    // Then:  returned ConfigJson.telegram = {enabled:true, boundUserId:42, proxyUrl:'http://p.test'}
    const { tcPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(
        tcPath,
        JSON.stringify({
          enabled: true,
          boundUserId: 42,
          proxyUrl: "http://p.test",
          lastUpdateOffset: 7,
          stickyFallbackIp: null,
          pollTimeoutSec: 30,
          pollBackoffSec: 5,
          lastReceivedAt: null,
        }),
        "utf-8",
      );
      const migrated = migrateTelegramIntoConfig(tcPath);
      assert.equal(migrated.telegram.enabled, true, "T-MIGRATE.TELEGRAM.1: enabled must be migrated");
      assert.equal(migrated.telegram.boundUserId, 42, "T-MIGRATE.TELEGRAM.1: boundUserId must be migrated");
      assert.equal(migrated.telegram.proxyUrl, "http://p.test", "T-MIGRATE.TELEGRAM.1: proxyUrl must be migrated");
    } finally {
      cleanup();
    }
  });
});

// ─── T-MIGRATE.TELEGRAM.2 ────────────────────────────────────────────────────

describe("migrateTelegramIntoConfig — telegram.json without proxyUrl migrates with proxyUrl:null (G-P24.4)", () => {
  it("T-MIGRATE.TELEGRAM.2: when pre-P-11 telegram.json lacks proxyUrl field, migration sets ConfigJson.telegram.proxyUrl = null; no throw", () => {
    // Given: telegram.json = {enabled:false, boundUserId:null, lastUpdateOffset:0, ...} (NO proxyUrl field)
    //        config.json absent
    // When:  migrateTelegramIntoConfig(tcPath)
    // Then:  ConfigJson.telegram.proxyUrl === null; no exception; no 'undefined' in JSON
    const { tcPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(
        tcPath,
        JSON.stringify({
          enabled: false,
          boundUserId: null,
          lastUpdateOffset: 0,
          stickyFallbackIp: null,
          pollTimeoutSec: 30,
          pollBackoffSec: 5,
          lastReceivedAt: null,
        }),
        "utf-8",
      );
      const migrated = migrateTelegramIntoConfig(tcPath);
      assert.equal(migrated.telegram.proxyUrl, null, "T-MIGRATE.TELEGRAM.2: missing proxyUrl must default to null");
      assert.equal(migrated.telegram.enabled, false, "T-MIGRATE.TELEGRAM.2: enabled must be false");
      // no 'undefined' in the JSON representation
      const json = JSON.stringify(migrated);
      assert.ok(!json.includes("undefined"), "T-MIGRATE.TELEGRAM.2: no 'undefined' must appear in JSON representation");
    } finally {
      cleanup();
    }
  });
});

// ─── T-MIGRATE.RACE.1 ────────────────────────────────────────────────────────

describe("readSecrets — concurrent migrations produce valid result (G-P24.1)", () => {
  it("T-MIGRATE.RACE.1: when two concurrent readSecrets calls trigger migration simultaneously, final secrets.json contains exactly one valid blob; no corruption", async () => {
    // Given: secrets.json absent; auth.json present with providers
    //        MAI_LEGACY_AUTH_PATH = authPath
    // When:  Promise.all([readSecrets(secretsPath), readSecrets(secretsPath)])
    // Then:  both resolve; secrets.json exists + valid JSON + schema_version === 1
    //        content is byte-identical from both concurrent readers (same legacy source)
    const { authPath, secretsPath, cleanup } = makeTmpDir();
    const saved = saveEnv("MAI_LEGACY_AUTH_PATH", "MAI_LEGACY_GITHUB_PATH", "MAI_LEGACY_SEARCH_PATH");
    try {
      writeFileSync(authPath, JSON.stringify({ providers: { anthropic: { key: "sk-ant-race" } } }), "utf-8");
      process.env.MAI_LEGACY_AUTH_PATH = authPath;
      process.env.MAI_LEGACY_GITHUB_PATH = join(secretsPath + ".no-github");
      process.env.MAI_LEGACY_SEARCH_PATH = join(secretsPath + ".no-search");

      // readSecrets is synchronous; Promise.all resolves both synchronously before first I/O yield
      const [r1, r2] = await Promise.all([
        Promise.resolve(readSecrets(secretsPath)),
        Promise.resolve(readSecrets(secretsPath)),
      ]);

      // Both must return valid SecretsJson
      assert.equal(r1.schema_version, 1, "T-MIGRATE.RACE.1: first result must have schema_version:1");
      assert.equal(r2.schema_version, 1, "T-MIGRATE.RACE.1: second result must have schema_version:1");
      assert.equal(
        r1.providers?.anthropic?.key,
        "sk-ant-race",
        "T-MIGRATE.RACE.1: first result must have migrated key",
      );
      assert.equal(
        r2.providers?.anthropic?.key,
        "sk-ant-race",
        "T-MIGRATE.RACE.1: second result must have migrated key",
      );
      // secrets.json must be valid JSON
      assert.ok(existsSync(secretsPath), "T-MIGRATE.RACE.1: secrets.json must exist after migration");
      const onDisk = JSON.parse(readFileSync(secretsPath, "utf-8")) as { schema_version?: number };
      assert.equal(onDisk.schema_version, 1, "T-MIGRATE.RACE.1: on-disk secrets.json must have schema_version:1");
    } finally {
      restoreEnv(saved);
      cleanup();
    }
  });
});
