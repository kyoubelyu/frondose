/**
 * P-EMBED-KEYS — build-time-embedded DEFAULT credentials (LLM + Brave) for internal-test
 * (内测) installs. Test names follow BDD-light: "T-Component.N: when <preconditions>, <action>
 * → <expected>".
 *
 * No Chrome, no LLM required.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readAuth } from "../../src/persistence/auth.js";
import { DEFAULT_CREDENTIALS_PATH, readDefaultCredentials } from "../../src/persistence/defaultCredentials.js";
import { readSearchConfig } from "../../src/persistence/search.js";
import { legacyMerged, readSecrets } from "../../src/persistence/secrets.js";
import { cleanupTmpDir } from "../_helpers/tmp";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "frondose-embed-keys-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

/** Restore env var helper (mirrors tests/persistence/secrets.mock.test.ts). */
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

const NO_LEGACY_ENV_KEYS = ["FRONDOSE_LEGACY_AUTH_PATH", "FRONDOSE_LEGACY_GITHUB_PATH", "FRONDOSE_LEGACY_SEARCH_PATH"];

/** Point every legacy source at nonexistent files in `dir`, isolating the test from the
 *  operator's real ~/.frondose files (mirrors the pattern in secrets.mock.test.ts). */
function blockLegacyFallback(dir: string): void {
  process.env.FRONDOSE_LEGACY_AUTH_PATH = join(dir, "no-auth.json");
  process.env.FRONDOSE_LEGACY_GITHUB_PATH = join(dir, "no-github.json");
  process.env.FRONDOSE_LEGACY_SEARCH_PATH = join(dir, "no-search.json");
}

// ─── readDefaultCredentials — the reader ────────────────────────────────────

describe("readDefaultCredentials — reads the gitignored generated JSON sidecar", () => {
  it("T-DEFCRED.1: when the generated file has all four fields, readDefaultCredentials returns them verbatim", () => {
    // Given: a fixture JSON with llmBaseUrl/llmModel/llmKey/braveKey all set
    // When:  readDefaultCredentials(path) is called with that fixture path
    // Then:  all four fields round-trip exactly
    const { dir, cleanup } = makeTmpDir();
    try {
      const path = join(dir, "defaultCredentials.generated.json");
      writeFileSync(
        path,
        JSON.stringify({
          llmBaseUrl: "https://api.example-provider.test/v1",
          llmModel: "placeholder-model",
          llmKey: "placeholder-llm",
          braveKey: "placeholder-brave",
        }),
        "utf-8",
      );
      const result = readDefaultCredentials(path);
      assert.deepEqual(result, {
        llmBaseUrl: "https://api.example-provider.test/v1",
        llmModel: "placeholder-model",
        llmKey: "placeholder-llm",
        braveKey: "placeholder-brave",
      });
    } finally {
      cleanup();
    }
  });

  it("T-DEFCRED.2: when the generated file is absent, readDefaultCredentials returns all-null (no throw)", () => {
    // Given: a path that does not exist on disk
    // When:  readDefaultCredentials(path) is called
    // Then:  {llmBaseUrl:null, llmModel:null, llmKey:null, braveKey:null}; no throw
    const { dir, cleanup } = makeTmpDir();
    try {
      const path = join(dir, "does-not-exist.json");
      const result = readDefaultCredentials(path);
      assert.deepEqual(result, { llmBaseUrl: null, llmModel: null, llmKey: null, braveKey: null });
    } finally {
      cleanup();
    }
  });

  it("T-DEFCRED.3: when the generated file is corrupt JSON, readDefaultCredentials returns all-null (no throw)", () => {
    // Given: a file containing invalid JSON
    // When:  readDefaultCredentials(path) is called
    // Then:  all-null defaults; the corrupt read is swallowed, never thrown to the caller
    const { dir, cleanup } = makeTmpDir();
    try {
      const path = join(dir, "corrupt.json");
      writeFileSync(path, "{not valid json", "utf-8");
      const result = readDefaultCredentials(path);
      assert.deepEqual(result, { llmBaseUrl: null, llmModel: null, llmKey: null, braveKey: null });
    } finally {
      cleanup();
    }
  });

  it("T-DEFCRED.4: when a field is blank/whitespace-only, readDefaultCredentials normalizes it to null", () => {
    // Given: braveKey is an empty string, llmModel is whitespace-only
    // When:  readDefaultCredentials(path) is called
    // Then:  both normalize to null (empty-string env vars must never masquerade as configured)
    const { dir, cleanup } = makeTmpDir();
    try {
      const path = join(dir, "blank-fields.json");
      writeFileSync(path, JSON.stringify({ llmBaseUrl: "https://x.test/v1", llmModel: "   ", llmKey: "k", braveKey: "" }), "utf-8");
      const result = readDefaultCredentials(path);
      assert.equal(result.llmModel, null, "T-DEFCRED.4: whitespace-only llmModel must normalize to null");
      assert.equal(result.braveKey, null, "T-DEFCRED.4: empty-string braveKey must normalize to null");
    } finally {
      cleanup();
    }
  });

  it("T-DEFCRED.5: real shipped reader — when the co-located generated file is absent in this checkout, readDefaultCredentials() (no args) returns all-null; skips with reason when a prior local build left the file on disk", (t) => {
    // Given: the REAL default path (co-located with src/persistence/defaultCredentials.ts). The
    //        generated file is gitignored and never committed (T-NOKEY.1/2), but a local checkout
    //        that has run scripts/gen-default-credentials.ts (directly, or via scripts/release.sh —
    //        see docs/issue-test-debt-15-intake.md item 4) leaves it on disk permanently. That is a
    //        build-history-dependent per-machine artifact, not a code defect, so this test SKIPS
    //        with an explicit reason on such a machine rather than failing or silently passing.
    // When:  readDefaultCredentials() is called with no override — the actual production path
    // Then:  on a fresh checkout (file absent) the reader returns all-null, proving
    //        "absent-defaults => behaves like today" for the real code path, not just an injected
    //        test path; on a machine where the file pre-exists, this assertion is skipped (T-DEFCRED.2
    //        already covers absent-file reader behavior hermetically via an injected fixture path).
    if (existsSync(DEFAULT_CREDENTIALS_PATH())) {
      t.skip(
        "T-DEFCRED.5: skipped — src/persistence/defaultCredentials.generated.json already exists on " +
          "this checkout (build history, e.g. scripts/release.sh has run here before; gitignored, never " +
          "committed — see docs/issue-test-debt-15-intake.md item 4). Absent-file behavior is covered " +
          "hermetically by T-DEFCRED.2.",
      );
      return;
    }
    assert.equal(existsSync(DEFAULT_CREDENTIALS_PATH()), false, "T-DEFCRED.5: generated file must not be committed/present");
    assert.deepEqual(readDefaultCredentials(), { llmBaseUrl: null, llmModel: null, llmKey: null, braveKey: null });
  });
});

// ─── First-run seeding via legacyMerged / readSecrets ───────────────────────

describe("default-seeding — fresh/unconfigured install + embedded defaults present → auth + search seeded", () => {
  it("T-SEED.1: when secrets.json is absent, no legacy files exist, and defaults are fully set with a non-DeepSeek custom baseUrl, readSecrets seeds a 'custom' provider + brave key and persists them", () => {
    // Given: no secrets.json; no legacy auth/github/search; a generated-defaults fixture with a
    //        non-DeepSeek custom OpenAI-compatible baseUrl + LLM key/model + Brave key
    // When:  readSecrets(secretsPath, { defaultCredentialsPath: fixture })
    // Then:  providers.custom = {key, baseUrl, type:'openai'}; default = 'custom:<model>';
    //        search.braveApiKey set; secrets.json written to disk (persisted, not just in-memory)
    const { dir, cleanup } = makeTmpDir();
    const saved = saveEnv(...NO_LEGACY_ENV_KEYS);
    try {
      blockLegacyFallback(dir);
      const secretsPath = join(dir, "secrets.json");
      const defaultsPath = join(dir, "defaultCredentials.generated.json");
      writeFileSync(
        defaultsPath,
        JSON.stringify({
          llmBaseUrl: "https://api.example-provider.test/v1",
          llmModel: "placeholder-model",
          llmKey: "placeholder-llm",
          braveKey: "placeholder-brave",
        }),
        "utf-8",
      );

      const result = readSecrets(secretsPath, { defaultCredentialsPath: defaultsPath });
      assert.equal(result.providers?.custom?.key, "placeholder-llm", "T-SEED.1: seeded key must match the default");
      assert.equal(
        result.providers?.custom?.baseUrl,
        "https://api.example-provider.test/v1",
        "T-SEED.1: seeded baseUrl must match the default",
      );
      assert.equal(result.providers?.custom?.type, "openai", "T-SEED.1: seeded provider type must be 'openai' (P-57d)");
      assert.equal(result.default, "custom:placeholder-model", "T-SEED.1: default spec must point at the seeded provider");
      assert.equal(result.search?.braveApiKey, "placeholder-brave", "T-SEED.1: brave key must be seeded");

      assert.ok(existsSync(secretsPath), "T-SEED.1: secrets.json must be persisted to disk (one-shot write)");
      const onDisk = JSON.parse(readFileSync(secretsPath, "utf-8"));
      assert.equal(onDisk.providers.custom.key, "placeholder-llm", "T-SEED.1: on-disk file must contain the seeded key");
      assert.equal(onDisk.search.braveApiKey, "placeholder-brave", "T-SEED.1: on-disk file must contain the seeded brave key");

      // Cross-check via the readAuth/readSearchConfig shims a caller (Settings, modelResolver) actually uses.
      const auth = readAuth(join(dir, "auth.json"));
      assert.equal(auth?.providers?.custom?.key, "placeholder-llm", "T-SEED.1: readAuth shim must see the seeded provider");
      const search = readSearchConfig(join(dir, "search.json"));
      assert.equal(search.braveApiKey, "placeholder-brave", "T-SEED.1: readSearchConfig shim must see the seeded brave key");
    } finally {
      restoreEnv(saved);
      cleanup();
    }
  });

  it("T-SEED.2: when the default llmBaseUrl is DeepSeek's official host, the seeded provider name is 'deepseek' not 'custom'", () => {
    // Given: defaults with llmBaseUrl = https://api.deepseek.com/v1
    // When:  legacyMerged(..., defaultsPath) is called (via readSecrets' first-run path)
    // Then:  providers.deepseek is set (chooseSettingsProvider's own isDeepSeekBaseUrl detection,
    //        mirrored here so a DeepSeek default and a Settings-saved DeepSeek key land on the
    //        same provider key instead of splitting into two configured providers)
    const { dir, cleanup } = makeTmpDir();
    const saved = saveEnv(...NO_LEGACY_ENV_KEYS);
    try {
      blockLegacyFallback(dir);
      const secretsPath = join(dir, "secrets.json");
      const defaultsPath = join(dir, "defaultCredentials.generated.json");
      writeFileSync(
        defaultsPath,
        JSON.stringify({
          llmBaseUrl: "https://api.deepseek.com/v1",
          llmModel: "deepseek-v4-flash",
          llmKey: "placeholder-deepseek",
          braveKey: null,
        }),
        "utf-8",
      );

      const result = readSecrets(secretsPath, { defaultCredentialsPath: defaultsPath });
      assert.equal(result.providers?.deepseek?.key, "placeholder-deepseek", "T-SEED.2: must seed under the 'deepseek' provider name");
      assert.equal(result.default, "deepseek:deepseek-v4-flash");
      assert.equal(result.providers?.custom, undefined, "T-SEED.2: must NOT also create a 'custom' entry");
    } finally {
      restoreEnv(saved);
      cleanup();
    }
  });

  it("T-SEED.3: when the default llmBaseUrl is an official reserved-vendor host (scope-lock), the LLM default is refused but Brave still seeds", () => {
    // Given: defaults with llmBaseUrl = https://api.anthropic.com/v1 (official Anthropic host)
    //        + a Brave key
    // When:  readSecrets(...) runs the first-run seed path
    // Then:  NO providers are seeded (scope-lock refusal — mirrors buildModel's own
    //        isOfficialDirectProviderBaseUrl guard); search.braveApiKey is still seeded
    //        independently (the two defaults are applied/rejected independently)
    const { dir, cleanup } = makeTmpDir();
    const saved = saveEnv(...NO_LEGACY_ENV_KEYS);
    try {
      blockLegacyFallback(dir);
      const secretsPath = join(dir, "secrets.json");
      const defaultsPath = join(dir, "defaultCredentials.generated.json");
      writeFileSync(
        defaultsPath,
        JSON.stringify({
          llmBaseUrl: "https://api.anthropic.com/v1",
          llmModel: "claude-x",
          llmKey: "placeholder-anthropic",
          braveKey: "placeholder-brave",
        }),
        "utf-8",
      );

      const stderrChunks: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      (process.stderr as any).write = (chunk: string | Buffer) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      };
      let result: ReturnType<typeof readSecrets>;
      try {
        result = readSecrets(secretsPath, { defaultCredentialsPath: defaultsPath });
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: restore
        (process.stderr as any).write = origWrite;
      }

      assert.equal(result.providers, undefined, "T-SEED.3: scope-locked baseUrl must NOT seed any provider");
      assert.equal(result.search?.braveApiKey, "placeholder-brave", "T-SEED.3: brave key must still seed independently");
      assert.ok(
        stderrChunks.join("").includes("reserved direct-vendor"),
        "T-SEED.3: a scope-lock refusal warning must be emitted to stderr",
      );
    } finally {
      restoreEnv(saved);
      cleanup();
    }
  });
});

describe("no-overwrite — a user's own configured secrets.json is never touched by embedded defaults", () => {
  it("T-NOOVERWRITE.1: when secrets.json already exists with a user-configured provider + brave key, readSecrets returns it unchanged even though embedded defaults are present", () => {
    // Given: secrets.json ALREADY exists on disk with the user's own provider + brave key
    // When:  readSecrets(secretsPath, { defaultCredentialsPath: fixture-with-different-values })
    // Then:  the happy path (file exists) still consults applyDefaultCredentials (P-EMBED-KEYS
    //        bugfix — see T-BACKFILL below) but its per-field guard is a no-op here since BOTH
    //        fields are already configured, so the user's own values pass through byte-for-byte
    //        and no rewrite occurs
    const { dir, cleanup } = makeTmpDir();
    try {
      const secretsPath = join(dir, "secrets.json");
      const userSecrets = {
        schema_version: 1,
        default: "custom:users-own-model",
        providers: { custom: { key: "users-own-key", baseUrl: "https://users-own-endpoint.test/v1", type: "openai" } },
        search: { braveApiKey: "users-own-brave-key" },
      };
      writeFileSync(secretsPath, JSON.stringify(userSecrets), "utf-8");

      const defaultsPath = join(dir, "defaultCredentials.generated.json");
      writeFileSync(
        defaultsPath,
        JSON.stringify({
          llmBaseUrl: "https://should-not-be-used.test/v1",
          llmModel: "should-not-be-used-model",
          llmKey: "should-not-be-used-key",
          braveKey: "should-not-be-used-brave",
        }),
        "utf-8",
      );

      const result = readSecrets(secretsPath, { defaultCredentialsPath: defaultsPath });
      assert.equal(result.providers?.custom?.key, "users-own-key", "T-NOOVERWRITE.1: user's own key must survive");
      assert.equal(
        result.providers?.custom?.baseUrl,
        "https://users-own-endpoint.test/v1",
        "T-NOOVERWRITE.1: user's own baseUrl must survive",
      );
      assert.equal(result.search?.braveApiKey, "users-own-brave-key", "T-NOOVERWRITE.1: user's own brave key must survive");

      // On-disk file must be byte-identical in the fields that matter (no rewrite occurred).
      const onDisk = JSON.parse(readFileSync(secretsPath, "utf-8"));
      assert.equal(onDisk.providers.custom.key, "users-own-key");
    } finally {
      cleanup();
    }
  });
});

// ─── Backfill on an EXISTING secrets.json (the real-box bug) ────────────────
//
// Root-cause correction: the box symptom ("LLM seeded, Brave did not") was NOT
// caused by readSearchConfig() reading a different store than the seed writes to
// (it reads the identical secrets.json via readSecrets, verified by T-SEED.1 above
// passing end-to-end through readSearchConfig). The real cause: applyDefaultCredentials
// was only ever invoked from readSecrets' whole-file-ABSENT branch. Any install where
// secrets.json already exists — e.g. an upgrade, or the LLM key having been configured
// by some other prior means — skips that branch entirely via the "happy path" short
// circuit, so a field that's still unset (Brave) never gets backfilled even though its
// default is embedded. These tests cover the fixed behavior: applyDefaultCredentials is
// now also consulted on the happy path, per-field, never overwriting a configured field.
describe("backfill — an existing secrets.json missing one field still gets that field seeded", () => {
  it("T-BACKFILL.1: when secrets.json already exists with LLM configured but no search field, and a default Brave key is embedded, readSecrets backfills search without touching the existing LLM config", () => {
    // Given: secrets.json exists on disk with providers/default set (as if configured before
    //        this feature shipped, or by any other means) but NO search field at all
    // When:  readSecrets(secretsPath, { defaultCredentialsPath: fixture-with-a-brave-key })
    // Then:  search.braveApiKey is now seeded from the default AND persisted to disk; the
    //        pre-existing LLM config is untouched
    const { dir, cleanup } = makeTmpDir();
    try {
      const secretsPath = join(dir, "secrets.json");
      writeFileSync(
        secretsPath,
        JSON.stringify({
          schema_version: 1,
          default: "deepseek:deepseek-v4-flash",
          providers: {
            deepseek: { key: "pre-existing-llm-key", baseUrl: "https://api.deepseek.com/v1", type: "openai" },
          },
        }),
        "utf-8",
      );

      const defaultsPath = join(dir, "defaultCredentials.generated.json");
      writeFileSync(
        defaultsPath,
        JSON.stringify({
          llmBaseUrl: "https://should-not-be-used.test/v1",
          llmModel: "should-not-be-used-model",
          llmKey: "should-not-be-used-key",
          braveKey: "placeholder-brave",
        }),
        "utf-8",
      );

      const result = readSecrets(secretsPath, { defaultCredentialsPath: defaultsPath });
      assert.equal(result.search?.braveApiKey, "placeholder-brave", "T-BACKFILL.1: brave key must be backfilled");
      assert.equal(
        result.providers?.deepseek?.key,
        "pre-existing-llm-key",
        "T-BACKFILL.1: pre-existing LLM key must be untouched (embedded LLM default must NOT override it)",
      );
      assert.equal(result.default, "deepseek:deepseek-v4-flash", "T-BACKFILL.1: pre-existing default spec untouched");

      const onDisk = JSON.parse(readFileSync(secretsPath, "utf-8"));
      assert.equal(onDisk.search?.braveApiKey, "placeholder-brave", "T-BACKFILL.1: backfilled brave key must be persisted to disk");
      assert.equal(onDisk.providers.deepseek.key, "pre-existing-llm-key", "T-BACKFILL.1: on-disk LLM key must be untouched");

      // Cross-check via the actual shim the app reads (Settings' readSettings()).
      const search = readSearchConfig(join(dir, "search.json"));
      assert.equal(search.braveApiKey, "placeholder-brave", "T-BACKFILL.1: readSearchConfig shim must see the backfilled key");
    } finally {
      cleanup();
    }
  });

  it("T-BACKFILL.2: when secrets.json already exists fully configured (LLM + search) and no default is embedded, readSecrets does not rewrite the file", () => {
    // Given: secrets.json exists with BOTH fields already configured; no defaultCredentialsPath
    //        fixture exists on disk (absent-defaults case, applied to an existing file)
    // When:  readSecrets(secretsPath, { defaultCredentialsPath: nonexistentFixture })
    // Then:  result is unchanged; on-disk mtime-equivalent content is identical (no spurious write)
    const { dir, cleanup } = makeTmpDir();
    try {
      const secretsPath = join(dir, "secrets.json");
      const before = {
        schema_version: 1,
        default: "custom:users-own-model",
        providers: { custom: { key: "users-own-key", baseUrl: "https://users-own-endpoint.test/v1", type: "openai" } },
        search: { braveApiKey: "users-own-brave-key" },
      };
      writeFileSync(secretsPath, JSON.stringify(before), "utf-8");

      const result = readSecrets(secretsPath, { defaultCredentialsPath: join(dir, "does-not-exist.json") });
      assert.deepEqual(result, before, "T-BACKFILL.2: result must equal the on-disk file verbatim");

      const onDisk = JSON.parse(readFileSync(secretsPath, "utf-8"));
      assert.deepEqual(onDisk, before, "T-BACKFILL.2: on-disk file must be untouched");
    } finally {
      cleanup();
    }
  });
});

describe("absent-defaults — no generated file / env unset → nothing seeded, identical to today", () => {
  it("T-ABSENT.1: when secrets.json is absent, no legacy files exist, and the defaultCredentialsPath fixture does not exist on disk, readSecrets returns {schema_version:1} and writes NOTHING (today's exact behavior)", () => {
    // Given: no secrets.json; no legacy files; defaultCredentialsPath points at a nonexistent file
    // When:  readSecrets(secretsPath, { defaultCredentialsPath: nonexistentFixture })
    // Then:  returns {schema_version:1} exactly (T-SECRETS.1's own contract, unmodified);
    //        no secrets.json is written — this is the CI/dev-build safety net: a normal build
    //        with no FRONDOSE_DEFAULT_* env vars never seeds anything.
    const { dir, cleanup } = makeTmpDir();
    const saved = saveEnv(...NO_LEGACY_ENV_KEYS);
    try {
      blockLegacyFallback(dir);
      const secretsPath = join(dir, "secrets.json");
      const defaultsPath = join(dir, "defaultCredentials.generated.json"); // never written

      const result = readSecrets(secretsPath, { defaultCredentialsPath: defaultsPath });
      assert.deepEqual(result, { schema_version: 1 }, "T-ABSENT.1: must match today's exact empty-defaults shape");
      assert.ok(!existsSync(secretsPath), "T-ABSENT.1: no secrets.json must be written when defaults are absent");
    } finally {
      restoreEnv(saved);
      cleanup();
    }
  });

  it("T-ABSENT.2: when defaultCredentialsPath is omitted entirely (production call shape) and the real generated file is absent, legacyMerged behaves exactly as before this feature existed", () => {
    // Given: no secrets.json; no legacy files; NO defaultCredentialsPath override at all
    //        (exercises the exact call shape production code uses)
    // When:  legacyMerged(authPath, githubPath, searchPath) — 3-arg call, pre-P-EMBED-KEYS shape
    // Then:  returns {schema_version:1} — the real co-located generated file is absent in this
    //        checkout (T-DEFCRED.5), so behavior is byte-identical to the pre-feature baseline
    const { dir, cleanup } = makeTmpDir();
    try {
      const result = legacyMerged(join(dir, "no-auth.json"), join(dir, "no-github.json"), join(dir, "no-search.json"));
      assert.deepEqual(result, { schema_version: 1 });
    } finally {
      cleanup();
    }
  });
});

describe("no-key-in-source — the generated file is never tracked by git; the reader has no embedded literals", () => {
  it("T-NOKEY.1: defaultCredentials.generated.json is listed in .gitignore", () => {
    // Given: the repo's .gitignore
    // When:  scanned for the generated-file path
    // Then:  src/persistence/defaultCredentials.generated.json is present (never committed)
    const gitignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf-8");
    assert.ok(
      gitignore.includes("src/persistence/defaultCredentials.generated.json"),
      "T-NOKEY.1: .gitignore must list the generated credentials file",
    );
  });

  it("T-NOKEY.2: git does not track any defaultCredentials.generated.* file in this checkout", () => {
    // Given: `git ls-files` over the repo
    // When:  filtered for the generated-credentials filename
    // Then:  zero tracked matches — the file has never been committed, by construction
    const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf-8" })
      .split("\n")
      .filter((f) => f.includes("defaultCredentials.generated"));
    assert.deepEqual(tracked, [], `T-NOKEY.2: generated credentials file must never be git-tracked; found: ${tracked.join(", ")}`);
  });

  it("T-NOKEY.3: the committed reader/gen-script source contains no hardcoded key-shaped literal (only env-var reads + null defaults)", () => {
    // Given: the committed source of defaultCredentials.ts + gen-default-credentials.ts
    // When:  scanned for a real-looking API key literal (long opaque token assigned to a
    //        llmKey/braveKey-shaped field, NOT via process.env)
    // Then:  no match — the only way a key value reaches these files is process.env.FRONDOSE_DEFAULT_*
    const readerSrc = readFileSync(join(REPO_ROOT, "src/persistence/defaultCredentials.ts"), "utf-8");
    const genSrc = readFileSync(join(REPO_ROOT, "scripts/gen-default-credentials.ts"), "utf-8");
    const suspiciousKeyLiteral = /(llmKey|braveKey)\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/;
    assert.equal(suspiciousKeyLiteral.test(readerSrc), false, "T-NOKEY.3: reader source must not hardcode a key literal");
    assert.equal(suspiciousKeyLiteral.test(genSrc), false, "T-NOKEY.3: gen-script source must not hardcode a key literal");
    assert.ok(genSrc.includes("process.env.FRONDOSE_DEFAULT_LLM_KEY"), "T-NOKEY.3: gen-script must read the key from env, not a literal");
    assert.ok(genSrc.includes("process.env.FRONDOSE_DEFAULT_BRAVE_KEY"), "T-NOKEY.3: gen-script must read the brave key from env, not a literal");
  });
});
