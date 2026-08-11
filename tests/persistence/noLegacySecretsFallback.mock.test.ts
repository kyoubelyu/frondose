import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readAuth, writeAuth } from "../../src/persistence/auth.js";
import { DEFAULT_CREDENTIALS_PATH, readDefaultCredentials } from "../../src/persistence/defaultCredentials.js";
import { readGithubConfig, writeGithubConfig } from "../../src/persistence/github.js";
import { readSearchConfig, writeSearchConfig } from "../../src/persistence/search.js";
import { readSecrets } from "../../src/persistence/secrets.js";
import { cleanupTmpDir } from "../_helpers/tmp";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const roots: string[] = [];
const legacyEnvNames = [
  "FRONDOSE_LEGACY_AUTH_PATH",
  "FRONDOSE_LEGACY_GITHUB_PATH",
  "FRONDOSE_LEGACY_SEARCH_PATH",
] as const;
const inheritedLegacyEnv = new Map(legacyEnvNames.map((name) => [name, process.env[name]]));

function tempRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `frondose-no-legacy-secrets-${tag}-`));
  roots.push(root);
  return root;
}

function missingDefaults(root: string): string {
  return join(root, "missing-default-credentials.json");
}

function containsCanary(value: unknown): boolean {
  return JSON.stringify(value).includes("canary");
}

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name === "target" || entry.name === "node_modules")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.isFile() && path.endsWith(".ts") && !path.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

afterEach(() => {
  for (const name of legacyEnvNames) {
    const inherited = inheritedLegacyEnv.get(name);
    if (inherited === undefined) delete process.env[name];
    else process.env[name] = inherited;
  }
  while (roots.length > 0) cleanupTmpDir(roots.pop()!);
});

describe("current secrets never consult retired credential files", () => {
  it("T-NSLF.1: absent current secrets ignores hostile co-located retired files", () => {
    // Given three co-located retired files and no current secrets, when read with deterministic empty defaults, then no canary is imported or rewritten.
    const root = tempRoot("direct-absent");
    const secretsPath = join(root, "secrets.json");
    const fixtures = new Map([
      [
        join(root, "auth.json"),
        '{"default":"retired:model","providers":{"retired":{"key":"auth-canary","baseUrl":"https://retired.invalid/v1","type":"openai"}}}',
      ],
      [join(root, "github.json"), '{"token":"github-canary","repo":"retired/repo"}'],
      [join(root, "search.json"), '{"braveApiKey":"brave-canary","tavilyApiKey":"tavily-canary"}'],
    ]);
    for (const [path, raw] of fixtures) writeFileSync(path, raw, "utf8");

    const result = readSecrets(secretsPath, { defaultCredentialsPath: missingDefaults(root) });

    assert.deepEqual(result, { schema_version: 1 });
    assert.equal(existsSync(secretsPath), false);
    for (const [path, raw] of fixtures) assert.equal(readFileSync(path, "utf8"), raw);
  });

  it("T-NSLF.2: corrupt current secrets never falls through to a hostile retired provider", () => {
    // Given corrupt current bytes and a valid co-located retired provider, when read, then all fixture bytes remain unchanged.
    const root = tempRoot("direct-corrupt");
    const secretsPath = join(root, "secrets.json");
    const authPath = join(root, "auth.json");
    const corrupt = "{not-json";
    const retired =
      '{"providers":{"retired":{"key":"corrupt-fallback-canary","baseUrl":"https://retired.invalid/v1","type":"openai"}}}';
    writeFileSync(secretsPath, corrupt, "utf8");
    writeFileSync(authPath, retired, "utf8");

    const result = readSecrets(secretsPath, { defaultCredentialsPath: missingDefaults(root) });

    assert.deepEqual(result, { schema_version: 1 });
    assert.equal(readFileSync(secretsPath, "utf8"), corrupt);
    assert.equal(readFileSync(authPath, "utf8"), retired);
  });

  it("T-NSLF.3: legacy environment overrides outside the current directory have no effect", () => {
    // Given three env-selected retired files outside the current directory, when read, then no returned or persisted value contains a canary.
    const currentRoot = tempRoot("env-current");
    const retiredRoot = tempRoot("env-retired");
    const secretsPath = join(currentRoot, "secrets.json");
    const fixtures = [
      [
        "FRONDOSE_LEGACY_AUTH_PATH",
        join(retiredRoot, "auth.json"),
        '{"providers":{"retired":{"key":"env-auth-canary","baseUrl":"https://retired.invalid/v1","type":"openai"}}}',
      ],
      [
        "FRONDOSE_LEGACY_GITHUB_PATH",
        join(retiredRoot, "github.json"),
        '{"token":"env-github-canary","repo":"retired/repo"}',
      ],
      ["FRONDOSE_LEGACY_SEARCH_PATH", join(retiredRoot, "search.json"), '{"braveApiKey":"env-search-canary"}'],
    ] as const;
    for (const [name, path, raw] of fixtures) {
      writeFileSync(path, raw, "utf8");
      process.env[name] = path;
    }

    const result = readSecrets(secretsPath);

    assert.equal(containsCanary(result), false);
    if (existsSync(secretsPath)) assert.equal(readFileSync(secretsPath, "utf8").includes("canary"), false);
    for (const [, path, raw] of fixtures) assert.equal(readFileSync(path, "utf8"), raw);
  });
});

describe("current-field adapters never import their retired-shaped path", () => {
  function assertPackagedDefaultsAreEmpty(): void {
    assert.deepEqual(readDefaultCredentials(DEFAULT_CREDENTIALS_PATH()), {
      llmBaseUrl: null,
      llmModel: null,
      llmKey: null,
    });
  }

  it("T-NSLF.4a: auth adapter ignores auth.json", () => {
    // Given empty packaged defaults and a retired auth path, when read, then no current file is created and its canary is absent.
    const root = tempRoot("adapter-auth");
    const path = join(root, "auth.json");
    const secretsPath = join(root, "secrets.json");
    const raw =
      '{"providers":{"retired":{"key":"adapter-auth-canary","baseUrl":"https://retired.invalid/v1","type":"openai"}}}';
    writeFileSync(path, raw, "utf8");
    assertPackagedDefaultsAreEmpty();
    assert.equal(containsCanary(readAuth(path)), false);
    assert.equal(existsSync(secretsPath), false);
    assert.equal(readFileSync(path, "utf8"), raw);
  });

  it("T-NSLF.4b: GitHub adapter ignores github.json", () => {
    // Given a retired GitHub path, when read, then it returns no retired fields and preserves the retired bytes.
    const root = tempRoot("adapter-github");
    const path = join(root, "github.json");
    const secretsPath = join(root, "secrets.json");
    const raw = '{"token":"adapter-github-canary","repo":"retired/repo"}';
    writeFileSync(path, raw, "utf8");
    assertPackagedDefaultsAreEmpty();
    assert.deepEqual(readGithubConfig(path), {});
    assert.equal(existsSync(secretsPath), false);
    assert.equal(readFileSync(path, "utf8"), raw);
  });

  it("T-NSLF.4c: search adapter ignores search.json", () => {
    // Given a retired search path, when read, then it returns no retired fields and preserves the retired bytes.
    const root = tempRoot("adapter-search");
    const path = join(root, "search.json");
    const secretsPath = join(root, "secrets.json");
    const raw = '{"braveApiKey":"adapter-search-canary"}';
    writeFileSync(path, raw, "utf8");
    assertPackagedDefaultsAreEmpty();
    assert.deepEqual(readSearchConfig(path), {});
    assert.equal(existsSync(secretsPath), false);
    assert.equal(readFileSync(path, "utf8"), raw);
  });
});

describe("retained current secrets behavior survives fallback deletion", () => {
  it("T-NSLF.5: approved embedded defaults seed mode 0600 without importing hostile retired data", () => {
    // Given approved injected defaults and hostile co-located retired files, when read, then only the approved provider is persisted securely.
    const root = tempRoot("defaults");
    const secretsPath = join(root, "secrets.json");
    const defaultsPath = join(root, "defaults.json");
    const retiredPath = join(root, "auth.json");
    const retired =
      '{"providers":{"retired":{"key":"defaults-retired-canary","baseUrl":"https://retired.invalid/v1","type":"openai"}}}';
    writeFileSync(
      defaultsPath,
      '{"llmBaseUrl":"https://custom.test/v1","llmModel":"model-a","llmKey":"approved-test-key"}',
      "utf8",
    );
    writeFileSync(retiredPath, retired, "utf8");

    const result = readSecrets(secretsPath, { defaultCredentialsPath: defaultsPath });

    assert.equal(result.providers?.custom?.key, "approved-test-key");
    assert.equal(containsCanary(result), false);
    assert.equal(statSync(secretsPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(secretsPath, "utf8")), {
      schema_version: 1,
      default: "custom:model-a",
      providers: {
        custom: { key: "approved-test-key", baseUrl: "https://custom.test/v1", type: "openai" },
      },
    });
    assert.equal(readFileSync(retiredPath, "utf8"), retired);
  });

  it("T-NSLF.6: all three write adapters preserve current siblings and retired bytes", () => {
    // Given three independent full current fixtures, when one adapter writes each, then that adapter preserves every sibling and retired byte.
    const initial = {
      schema_version: 1,
      default: "custom:model-a",
      visionModel: "custom:vision-a",
      providers: { custom: { key: "current-key", baseUrl: "https://custom.test/v1", type: "openai" } },
      github: { token: "current-gh", repo: "current/repo" },
      search: { braveApiKey: "current-search" },
      server: { token: "current-server", webToken: "current-web" },
    };
    const cases = [
      {
        tag: "auth",
        write: (root: string) =>
          writeAuth(
            { default: "custom:model-b", visionModel: "custom:vision-b", providers: initial.providers },
            join(root, "auth.json"),
          ),
        expected: { ...initial, default: "custom:model-b", visionModel: "custom:vision-b" },
      },
      {
        tag: "github",
        write: (root: string) => writeGithubConfig({ token: "new-gh", repo: "new/repo" }, join(root, "github.json")),
        expected: { ...initial, github: { token: "new-gh", repo: "new/repo" } },
      },
      {
        tag: "search",
        write: (root: string) => writeSearchConfig({ braveApiKey: "new-search" }, join(root, "search.json")),
        expected: { ...initial, search: { braveApiKey: "new-search" } },
      },
    ];

    for (const entry of cases) {
      const root = tempRoot(`rmw-${entry.tag}`);
      const secretsPath = join(root, "secrets.json");
      writeFileSync(secretsPath, JSON.stringify(initial), "utf8");
      const retired = new Map([
        [join(root, "auth.json"), '{"providers":{"retired":{"key":"rmw-auth-canary"}}}'],
        [join(root, "github.json"), '{"token":"rmw-github-canary"}'],
        [join(root, "search.json"), '{"braveApiKey":"rmw-search-canary"}'],
      ]);
      for (const [path, raw] of retired) writeFileSync(path, raw, "utf8");
      entry.write(root);
      assert.deepEqual(JSON.parse(readFileSync(secretsPath, "utf8")), entry.expected);
      for (const [path, raw] of retired) assert.equal(readFileSync(path, "utf8"), raw);
    }
  });
});

describe("retired secrets fallback surface is deleted", () => {
  it("T-NSLF.7: all production source rejects fallback APIs and legacy environment variables", () => {
    // Given all maintained TypeScript production files, when scanned, then no retired fallback token remains anywhere.
    const retiredTokens = ["legacyMerged", "LegacyPathOverrides", ...legacyEnvNames];
    for (const path of sourceFiles(join(repoRoot, "src"))) {
      const source = readFileSync(path, "utf8");
      for (const token of retiredTokens) assert.equal(source.includes(token), false, `${path} still contains ${token}`);
    }
  });

  it("T-NSLF.8: credential migration tests are deleted while Telegram migration coverage is retained", () => {
    // Given the final test tree, when inspected, then the mixed migration suite is gone and the retained Telegram carrier remains.
    assert.equal(existsSync(join(repoRoot, "tests/persistence/migration.mock.test.ts")), false);
    assert.equal(existsSync(join(repoRoot, "tests/persistence/telegramMigration.mock.test.ts")), true);
  });
});
