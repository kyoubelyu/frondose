/**
 * P-24 Step 5 — secrets.ts + auth/github/search shim assertions
 *
 * Test names follow BDD-light: "T-Component.N: when <preconditions>, <action> → <expected>"
 * Assertion bodies filled at Step 5.
 *
 * Gate coverage:
 *   G-P24.1 — T-MIGRATE.AUTH.1, T-MIGRATE.GH.1, T-MIGRATE.SEARCH.1 (in migration.mock.test.ts)
 *   G-P24.3 — T-SECRETS.2, T-SECRETS.6, T-SHIM.AUTH.2
 *   G-P24.7 — T-SECRETS.2
 *   G-P24.8 — T-SECRETS.1, T-SECRETS.4, T-SECRETS.5
 *   G-P24.10 — T-SECRETS.3, T-SHIM.AUTH.1, T-SHIM.AUTH.2, T-SHIM.GH.1, T-SHIM.SEARCH.1
 *
 * No Chrome, no LLM required.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readAuth, writeAuth } from "../../src/persistence/auth.js";
import { readGithubConfig } from "../../src/persistence/github.js";
import { readSearchConfig } from "../../src/persistence/search.js";
import { readSecrets, writeSecrets } from "../../src/persistence/secrets.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "mai-p24-secrets-"));
  return {
    dir,
    secretsPath: join(dir, "secrets.json"),
    authPath: join(dir, "auth.json"),
    cleanup: () => cleanupTmpDir(dir),
  };
}

/** Restore env var helper. */
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

const posixPermissionsOptions: { skip?: string } =
  process.platform === "win32"
    ? { skip: "POSIX chmod/read-only directory semantics are not portable to Windows." }
    : {};

// ─── T-SECRETS.1 ─────────────────────────────────────────────────────────────

describe("readSecrets — missing file → default empty shape (G-P24.8)", () => {
  it("T-SECRETS.1: when no secrets.json on disk, readSecrets returns default {schema_version:1} shape; no file write", () => {
    // Given: secrets.json does not exist at secretsPath
    // When:  readSecrets(secretsPath) is called
    // Then:  returns {schema_version:1}; no file written to disk
    const { dir, secretsPath, cleanup } = makeTmpDir();
    const saved = saveEnv("FRONDOSE_LEGACY_AUTH_PATH", "FRONDOSE_LEGACY_GITHUB_PATH", "FRONDOSE_LEGACY_SEARCH_PATH");
    try {
      // Prevent fallback reads from real legacy files (operator may have auth.json / github.json)
      process.env.FRONDOSE_LEGACY_AUTH_PATH = join(dir, "no-auth.json");
      process.env.FRONDOSE_LEGACY_GITHUB_PATH = join(dir, "no-github.json");
      process.env.FRONDOSE_LEGACY_SEARCH_PATH = join(dir, "no-search.json");

      const result = readSecrets(secretsPath);
      assert.deepEqual(result, { schema_version: 1 }, "T-SECRETS.1: empty defaults must match {schema_version:1}");
      assert.ok(!existsSync(secretsPath), "T-SECRETS.1: no secrets.json must be written when no legacy data");
    } finally {
      restoreEnv(saved);
      cleanup();
    }
  });
});

// ─── T-SECRETS.2 ─────────────────────────────────────────────────────────────

describe("writeSecrets — file mode 0o600 + round-trip (G-P24.3 + G-P24.7)", () => {
  it("T-SECRETS.2: when writeSecrets({schema_version:1}, path) called, file has mode 0o600 and JSON round-trips", () => {
    // Given: empty secrets payload {schema_version:1}
    // When:  writeSecrets called
    // Then:  file exists at path; statSync(path).mode & 0o777 === 0o600; JSON.parse(readFile) deep-equals input
    const { secretsPath, cleanup } = makeTmpDir();
    try {
      const payload = { schema_version: 1 as const };
      writeSecrets(payload, secretsPath);
      assert.ok(existsSync(secretsPath), "T-SECRETS.2: secrets.json must exist after writeSecrets");
      if (process.platform !== "win32") {
        const mode = statSync(secretsPath).mode & 0o777;
        assert.equal(mode, 0o600, `T-SECRETS.2: file mode must be 0o600; got ${mode.toString(8)}`);
      }
      const readBack = JSON.parse(readFileSync(secretsPath, "utf-8"));
      assert.deepEqual(readBack, payload, "T-SECRETS.2: JSON must round-trip");
    } finally {
      cleanup();
    }
  });
});

// ─── T-SECRETS.3 ─────────────────────────────────────────────────────────────

describe("readSecrets — provider entry migration applied on read (G-P24.10)", () => {
  it("T-SECRETS.3: when secrets.json has provider entry missing type, readSecrets returns entry with type inferred via migrateProviderEntry", () => {
    // Given: secrets.json on disk with providers.anthropic = {key:'sk-ant', baseUrl:'...'} (no type field)
    // When:  readSecrets(secretsPath)
    // Then:  returned providers.anthropic.type === 'anthropic' (P-21 migrateProviderEntry applied)
    const { secretsPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(
        secretsPath,
        JSON.stringify({ schema_version: 1, providers: { anthropic: { key: "sk-ant-test" } } }),
        "utf-8",
      );
      const result = readSecrets(secretsPath);
      assert.equal(result.providers?.anthropic?.type, "anthropic", "T-SECRETS.3: type must be inferred as 'anthropic'");
      assert.equal(result.providers?.anthropic?.key, "sk-ant-test", "T-SECRETS.3: key must be preserved");
      assert.ok(result.providers?.anthropic?.baseUrl, "T-SECRETS.3: baseUrl must be populated by migration");
    } finally {
      cleanup();
    }
  });
});

// ─── T-SECRETS.4 ─────────────────────────────────────────────────────────────

describe("readSecrets — malformed JSON → stderr + defaults (G-P24.8)", () => {
  it("T-SECRETS.4: when secrets.json contains malformed JSON, readSecrets emits stderr and returns default shape; no throw", () => {
    // Given: secrets.json file contains '{not json'
    // When:  readSecrets(secretsPath) — stderr captured
    // Then:  stderr contains 'secrets.json corrupt or invalid'; returns {schema_version:1}; no throw
    const { dir, secretsPath, cleanup } = makeTmpDir();
    const saved = saveEnv("FRONDOSE_LEGACY_AUTH_PATH", "FRONDOSE_LEGACY_GITHUB_PATH", "FRONDOSE_LEGACY_SEARCH_PATH");
    try {
      writeFileSync(secretsPath, "{not json", "utf-8");
      // Prevent fallback reads from real legacy files
      process.env.FRONDOSE_LEGACY_AUTH_PATH = join(dir, "no-auth.json");
      process.env.FRONDOSE_LEGACY_GITHUB_PATH = join(dir, "no-github.json");
      process.env.FRONDOSE_LEGACY_SEARCH_PATH = join(dir, "no-search.json");

      const stderrChunks: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      (process.stderr as any).write = (chunk: string | Buffer) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      };
      let result: ReturnType<typeof readSecrets>;
      try {
        result = readSecrets(secretsPath);
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: restore
        (process.stderr as any).write = origWrite;
      }
      const stderr = stderrChunks.join("");
      assert.ok(
        stderr.includes("corrupt or invalid"),
        `T-SECRETS.4: stderr must contain 'corrupt or invalid'; got: "${stderr}"`,
      );
      assert.deepEqual(result!, { schema_version: 1 }, "T-SECRETS.4: must return default {schema_version:1}");
    } finally {
      restoreEnv(saved);
      cleanup();
    }
  });
});

// ─── T-SECRETS.5 ─────────────────────────────────────────────────────────────

describe("readSecrets — schema_version forward-compat → stderr + defaults (G-P24.8)", () => {
  it("T-SECRETS.5: when secrets.json has schema_version:99, readSecrets emits Zod-literal-mismatch warning and returns defaults", () => {
    // Given: secrets.json with schema_version:99 (unsupported future version)
    // When:  readSecrets(secretsPath)
    // Then:  stderr warning emitted; returns {schema_version:1} defaults; no throw
    const { dir, secretsPath, cleanup } = makeTmpDir();
    const saved = saveEnv("FRONDOSE_LEGACY_AUTH_PATH", "FRONDOSE_LEGACY_GITHUB_PATH", "FRONDOSE_LEGACY_SEARCH_PATH");
    try {
      writeFileSync(secretsPath, JSON.stringify({ schema_version: 99, providers: {} }), "utf-8");
      // Prevent fallback reads from real legacy files
      process.env.FRONDOSE_LEGACY_AUTH_PATH = join(dir, "no-auth.json");
      process.env.FRONDOSE_LEGACY_GITHUB_PATH = join(dir, "no-github.json");
      process.env.FRONDOSE_LEGACY_SEARCH_PATH = join(dir, "no-search.json");

      const stderrChunks: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      (process.stderr as any).write = (chunk: string | Buffer) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      };
      let result: ReturnType<typeof readSecrets>;
      try {
        result = readSecrets(secretsPath);
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: restore
        (process.stderr as any).write = origWrite;
      }
      const stderr = stderrChunks.join("");
      assert.ok(stderr.length > 0, `T-SECRETS.5: stderr must contain a warning; got empty string`);
      assert.deepEqual(result!, { schema_version: 1 }, "T-SECRETS.5: must return default {schema_version:1}");
    } finally {
      restoreEnv(saved);
      cleanup();
    }
  });
});

// ─── T-SECRETS.6 ─────────────────────────────────────────────────────────────

describe("writeSecrets — directory read-only: original unchanged; error propagates (G-P24.3)", () => {
  it(
    "T-SECRETS.6: when writeSecrets is called and the target directory is read-only (EACCES), original secrets.json unchanged and error propagates",
    posixPermissionsOptions,
    () => {
      // Given: existing secrets.json with {schema_version:1, default:'anthropic:claude-sonnet-4-5'}
      //        directory made read-only (0o555) to trigger EACCES on tmp file creation
      // When:  writeSecrets({schema_version:1, default:'new-model'}, secretsPath)
      // Then:  error propagates to caller; original secrets.json content unchanged
      // Note:  This exercises the EACCES path via directory permissions (not renameSync mock,
      //        which is blocked by ESM live bindings). Invariant is identical: write fails → original preserved.
      const { dir, secretsPath, cleanup } = makeTmpDir();
      try {
        writeFileSync(
          secretsPath,
          JSON.stringify({ schema_version: 1, default: "anthropic:claude-sonnet-4-5" }),
          "utf-8",
        );
        const origContent = readFileSync(secretsPath, "utf-8");

        // Make directory read-only → writeFileSync(tmp, ...) will fail with EACCES
        chmodSync(dir, 0o555);
        let threw = false;
        try {
          writeSecrets({ schema_version: 1, default: "new-model" }, secretsPath);
        } catch (e) {
          threw = true;
          assert.ok(e instanceof Error, "T-SECRETS.6: thrown value must be an Error");
        } finally {
          chmodSync(dir, 0o755); // restore before reads
        }
        assert.ok(threw, "T-SECRETS.6: writeSecrets must throw when directory is read-only");
        assert.equal(
          readFileSync(secretsPath, "utf-8"),
          origContent,
          "T-SECRETS.6: original secrets.json must be unchanged after error",
        );
      } finally {
        try {
          chmodSync(dir, 0o755);
        } catch {
          /* already restored */
        }
        cleanup();
      }
    },
  );
});

// ─── T-SHIM.AUTH.1 ───────────────────────────────────────────────────────────

describe("readAuth shim — reads secrets.json; returns AuthJson shape (G-P24.10)", () => {
  it("T-SHIM.AUTH.1: when secrets.json contains providers.anthropic, legacy readAuth() shim returns AuthJson with those providers", () => {
    // Given: secrets.json with {providers:{anthropic:{key:'k1',baseUrl:'...',type:'anthropic'}}, default:'anthropic:claude-sonnet-4-5'}
    //        authPathToSecretsPath(authPath) = co-located secrets.json in same dir
    // When:  readAuth(authPath) — shim routes to readSecrets(authPathToSecretsPath(authPath))
    // Then:  returns AuthJson shape: {default:'anthropic:claude-sonnet-4-5', providers:{anthropic:{key:'k1',...}}}
    //        identical to pre-P-24 behavior (G-P24.10 regression check)
    const { dir, authPath, cleanup } = makeTmpDir();
    try {
      const secretsPath = join(dir, "secrets.json");
      writeFileSync(
        secretsPath,
        JSON.stringify({
          schema_version: 1,
          default: "anthropic:claude-sonnet-4-5",
          providers: { anthropic: { key: "k1", baseUrl: "https://api.anthropic.com/v1", type: "anthropic" } },
        }),
        "utf-8",
      );
      const result = readAuth(authPath);
      assert.ok(result !== null, "T-SHIM.AUTH.1: readAuth must return non-null when secrets.json has providers");
      assert.equal(result?.default, "anthropic:claude-sonnet-4-5", "T-SHIM.AUTH.1: default field must round-trip");
      assert.equal(result?.providers?.anthropic?.key, "k1", "T-SHIM.AUTH.1: provider key must be returned");
    } finally {
      cleanup();
    }
  });
});

// ─── T-SHIM.AUTH.2 ───────────────────────────────────────────────────────────

describe("writeAuth shim — writes to secrets.json; auth.json untouched; github/search preserved (G-P24.3 + G-P24.10)", () => {
  it("T-SHIM.AUTH.2: when writeAuth(providers, authPath) called, secrets.json receives merged write; auth.json absent; github field untouched", () => {
    // Given: secrets.json with {schema_version:1, github:{token:'ghp_test', repo:'kyoubelyu/mai-agent'}}
    //        writeAuth({providers:{anthropic:{key:'k1'}}, default:'...'}, authPath)
    // When:  shim merges auth fields into secrets.json without disturbing github
    // Then:  secrets.json.providers set; secrets.json.github unchanged; auth.json does NOT exist
    const { dir, authPath, cleanup } = makeTmpDir();
    try {
      const secretsPath = join(dir, "secrets.json");
      writeFileSync(
        secretsPath,
        JSON.stringify({ schema_version: 1, github: { token: "ghp_test", repo: "kyoubelyu/mai-agent" } }),
        "utf-8",
      );
      writeAuth(
        {
          providers: { anthropic: { key: "k1" } },
          default: "anthropic:claude-sonnet-4-5",
        },
        authPath,
      );
      // Verify secrets.json was updated
      const secretsJson = JSON.parse(readFileSync(secretsPath, "utf-8")) as Record<string, unknown>;
      assert.ok(
        (secretsJson.providers as Record<string, unknown>)?.anthropic,
        "T-SHIM.AUTH.2: providers.anthropic must be written to secrets.json",
      );
      assert.deepEqual(
        secretsJson.github,
        { token: "ghp_test", repo: "kyoubelyu/mai-agent" },
        "T-SHIM.AUTH.2: github field must be preserved (C-1 RMW)",
      );
      // auth.json must NOT exist (write went to secrets.json)
      assert.ok(!existsSync(authPath), "T-SHIM.AUTH.2: auth.json must NOT exist (write landed on secrets.json)");
    } finally {
      cleanup();
    }
  });
});

// ─── T-SHIM.GH.1 ─────────────────────────────────────────────────────────────

describe("readGithubConfig shim — reads secrets.json.github (G-P24.10)", () => {
  it("T-SHIM.GH.1: when secrets.json.github = {token, repo}, readGithubConfig returns {token, repo}", () => {
    // Given: secrets.json with github:{token:'ghp_xxx', repo:'kyoubelyu/mai-agent'}
    //        githubPathToSecretsPath(githubPath) = co-located secrets.json in same dir
    // When:  readGithubConfig(githubPath) — shim routes to secrets.json
    // Then:  returns {token:'ghp_xxx', repo:'kyoubelyu/mai-agent'}
    const { dir, cleanup } = makeTmpDir();
    try {
      const secretsPath = join(dir, "secrets.json");
      writeFileSync(
        secretsPath,
        JSON.stringify({ schema_version: 1, github: { token: "ghp_xxx", repo: "kyoubelyu/mai-agent" } }),
        "utf-8",
      );
      const githubPath = join(dir, "github.json");
      const result = readGithubConfig(githubPath);
      assert.equal(result.token, "ghp_xxx", "T-SHIM.GH.1: token must be returned from secrets.json.github");
      assert.equal(result.repo, "kyoubelyu/mai-agent", "T-SHIM.GH.1: repo must be returned from secrets.json.github");
    } finally {
      cleanup();
    }
  });
});

// ─── T-SHIM.SEARCH.1 ─────────────────────────────────────────────────────────

describe("readSearchConfig shim — reads secrets.json.search (G-P24.10)", () => {
  it("T-SHIM.SEARCH.1: when secrets.json.search = {braveApiKey, tavilyApiKey}, readSearchConfig returns both keys", () => {
    // Given: secrets.json with search:{braveApiKey:'bsa_xxx', tavilyApiKey:'tv_xxx'}
    //        searchPathToSecretsPath(searchPath) = co-located secrets.json in same dir
    // When:  readSearchConfig(searchPath) — shim routes to secrets.json
    // Then:  returns {braveApiKey:'bsa_xxx', tavilyApiKey:'tv_xxx'}
    const { dir, cleanup } = makeTmpDir();
    try {
      const secretsPath = join(dir, "secrets.json");
      writeFileSync(
        secretsPath,
        JSON.stringify({ schema_version: 1, search: { braveApiKey: "bsa_xxx", tavilyApiKey: "tv_xxx" } }),
        "utf-8",
      );
      const searchPath = join(dir, "search.json");
      const result = readSearchConfig(searchPath);
      assert.equal(result.braveApiKey, "bsa_xxx", "T-SHIM.SEARCH.1: braveApiKey must be returned");
      assert.equal(result.tavilyApiKey, "tv_xxx", "T-SHIM.SEARCH.1: tavilyApiKey must be returned");
    } finally {
      cleanup();
    }
  });
});
