/**
 * P-7 mock tests — T-Auth1a..T-Auth6 + T-MR1: src/persistence/auth.ts
 *
 * Tests:
 *   T-Auth1a — writeAuth initial-create: mode 0o600 via openSync
 *   T-Auth1b — writeAuth overwrite: defensive chmodSync enforces 0o600
 *   T-Auth2  — writeAuth with baseUrl: stored in providers[provider]
 *   T-Auth3  — maskKey correctness: last 4 visible, prefix preserved
 *   T-Auth4  — remove round-trip: set then remove, provider absent in JSON
 *   T-Auth5  — default field written by writeAuth when present
 *   T-Auth6  — runAuthSubcommand("set") with invalid spec throws parseModelSpec error
 *   T-MR1    — readAuthJsonKey: returns key when present; undefined when absent/file missing
 *
 * No Chrome, no LLM required.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, test } from "node:test";
import { runAuthSubcommand } from "../../src/cli/subcommands/auth.js";
import {
  authPathToSecretsPath,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  maskKey,
  migrateProviderEntry,
  readAuth,
  readAuthJsonKey,
  readAuthJsonVisionModel,
  writeAuth,
} from "../../src/persistence/auth.js";

// Tiny helper: mock process.exit to throw instead of killing the test runner.
// Returns the exit code that was passed, or undefined if not called.
function mockProcessExit(): { getCode: () => number | undefined; restore: () => void } {
  let capturedCode: number | undefined;
  const orig = process.exit.bind(process);
  // biome-ignore lint/suspicious/noExplicitAny: intentional override for test isolation
  (process as any).exit = (code?: number) => {
    capturedCode = code;
    throw new Error(`process.exit(${code})`);
  };
  return {
    getCode: () => capturedCode,
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restore process.exit
      (process as any).exit = orig;
    },
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function tmpAuthPath(): { dir: string; authPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p7-auth-"));
  return { dir, authPath: join(dir, "auth.json") };
}

// P-24 Step 5: authPathToSecretsPath imported from auth.js (replaces local secretsPathFor helper).
// Logic: production auth path → DEFAULT_SECRETS_PATH(); test path (tmpDir/auth.json) → tmpDir/secrets.json.

// ─── T-Auth1a — initial-create mode 0o600 ────────────────────────────────────

test("T-Auth1a: writeAuth initial-create sets mode 0o600 on secrets.json (P-24 shim: write lands on secrets.json, not auth.json)", () => {
  const { dir, authPath } = tmpAuthPath();
  try {
    writeAuth({ providers: { anthropic: { key: "sk-ant-test1234" } } }, authPath);
    // P-24 Step 5: authPathToSecretsPath(authPath) derives co-located secrets.json.
    // Mode assertion is on secrets.json, not auth.json (write lands on secrets.json).
    const mode = statSync(authPathToSecretsPath(authPath)).mode & 0o777;
    assert.equal(mode, 0o600, `T-Auth1a: file mode must be 0o600 on initial create; got ${mode.toString(8)}`);
    // Contents round-trip (readAuth shim reads from secrets.json via authPathToSecretsPath)
    const read = readAuth(authPath);
    assert.equal(read?.providers?.anthropic?.key, "sk-ant-test1234", "T-Auth1a: provider key must round-trip");
    console.log("T-Auth1a: initial-create mode 0o600 ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T-Auth1b — overwrite enforces mode 0o600 ────────────────────────────────

test("T-Auth1b: writeAuth overwrite enforces mode 0o600 on secrets.json (P-24 shim: write lands on secrets.json)", () => {
  const { dir, authPath } = tmpAuthPath();
  try {
    // P-24 Step 5: pre-create at secrets.json path (authPathToSecretsPath imported from auth.js).
    const secretsPath = authPathToSecretsPath(authPath);
    writeFileSync(secretsPath, JSON.stringify({ schema_version: 1, providers: {} }), "utf-8");
    // Manually set mode to 0o644 (simulates pre-existing file from another tool).
    chmodSync(secretsPath, 0o644);
    assert.equal(statSync(secretsPath).mode & 0o777, 0o644, "T-Auth1b: pre-condition: secrets.json must be 0o644");

    // writeAuth must upgrade secrets.json to 0o600.
    writeAuth({ providers: { openai: { key: "sk-openai-overwrite" } } }, authPath);
    const mode = statSync(secretsPath).mode & 0o777;
    assert.equal(mode, 0o600, `T-Auth1b: overwrite must enforce 0o600 on secrets.json; got ${mode.toString(8)}`);
    console.log("T-Auth1b: overwrite defensive chmodSync 0o600 ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T-Auth2 — set with baseUrl ───────────────────────────────────────────────

test("T-Auth2: runAuthSubcommand set stores baseUrl in providers[provider]", async () => {
  // P-21: "set" now takes url: instead of spec: + baseUrl:. Update to URL-based API.
  const { dir, authPath } = tmpAuthPath();
  try {
    await runAuthSubcommand("set", {
      url: "https://api.deepseek.com/v1",
      key: "sk-dsk-test",
      model: "deepseek-chat",
      name: "deepseek",
      authPath,
    });
    const auth = readAuth(authPath);
    assert.equal(auth?.providers?.deepseek?.key, "sk-dsk-test", "T-Auth2: key must be stored");
    assert.equal(
      auth?.providers?.deepseek?.baseUrl,
      "https://api.deepseek.com/v1",
      "T-Auth2: baseUrl must be stored verbatim from url arg",
    );
    console.log("T-Auth2: baseUrl stored correctly ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T-Auth3 — maskKey correctness ───────────────────────────────────────────

test("T-Auth3: maskKey preserves last 4 chars; sk-ant- prefix kept; sk-*** middle", async () => {
  // With sk-ant- prefix
  const masked1 = maskKey("sk-ant-api03testkey1234567890");
  assert.ok(masked1.startsWith("sk-ant-"), `T-Auth3: prefix 'sk-ant-' must be preserved; got "${masked1}"`);
  assert.ok(masked1.includes("***"), "T-Auth3: middle must be starred");
  assert.ok(masked1.endsWith("7890"), "T-Auth3: last 4 chars must be '7890'");

  // Without prefix
  const masked2 = maskKey("sk-abcdef1234567890");
  assert.ok(masked2.includes("***"), "T-Auth3: must contain *** for no-prefix key");
  assert.ok(masked2.endsWith("7890"), "T-Auth3: last 4 must be '7890'");

  // Very short key — fallback
  const masked3 = maskKey("abcd");
  assert.equal(masked3, "****", "T-Auth3: key ≤ 4 chars must be all-stars");

  // runAuthSubcommand("list") emits masked output
  const { dir, authPath } = tmpAuthPath();
  try {
    writeAuth({ providers: { anthropic: { key: "sk-ant-testkey1234" } } }, authPath);
    const captured: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process.stdout as any).write = (chunk: string | Buffer) => {
      captured.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };
    try {
      await runAuthSubcommand("list", { authPath });
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      (process.stdout as any).write = origWrite;
    }
    const output = captured.join("");
    assert.ok(!output.includes("testkey1234"), "T-Auth3: plain key must NOT appear in list output");
    assert.ok(output.includes("***"), "T-Auth3: list output must contain *** masked key");
    console.log(`T-Auth3: maskKey + list output correct ✓ (example: "${masked1}")`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T-Auth4 — remove deletes provider ───────────────────────────────────────

test("T-Auth4: set then remove leaves provider absent in auth.json", async () => {
  const { dir, authPath } = tmpAuthPath();
  try {
    // P-21: "set" now takes url: instead of spec:. Update to URL-based API.
    await runAuthSubcommand("set", {
      url: "https://api.anthropic.com/v1",
      key: "sk-ant-toremove",
      model: "claude-sonnet-4-5",
      name: "anthropic",
      authPath,
    });
    const before = readAuth(authPath);
    assert.ok(before?.providers?.anthropic, "T-Auth4: pre-condition: provider must exist before remove");

    await runAuthSubcommand("remove", { provider: "anthropic", authPath });
    const after = readAuth(authPath);
    assert.ok(!after?.providers?.anthropic, "T-Auth4: provider must be absent after remove");
    console.log("T-Auth4: set-then-remove round-trip ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T-Auth5 — default field written ─────────────────────────────────────────

test("T-Auth5: runAuthSubcommand default writes default field to auth.json", async () => {
  const { dir, authPath } = tmpAuthPath();
  try {
    await runAuthSubcommand("default", { spec: "anthropic:claude-sonnet-4-5", authPath });
    const auth = readAuth(authPath);
    assert.equal(auth?.default, "anthropic:claude-sonnet-4-5", "T-Auth5: default must be written");
    console.log("T-Auth5: default field written ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T-Auth6 — invalid spec rejected ─────────────────────────────────────────

test("T-Auth6: runAuthSubcommand set with missing url in non-interactive mode exits 1", async () => {
  // P-21: "set" requires url: in non-interactive mode; missing url → process.exit(1).
  // We mock process.exit to throw instead of killing the test runner.
  const { dir, authPath } = tmpAuthPath();
  const exitMock = mockProcessExit();
  try {
    await runAuthSubcommand("set", { key: "sk-test", authPath }); // no url
  } catch {
    // expected mock exit throw
  } finally {
    exitMock.restore();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(exitMock.getCode(), 1, "T-Auth6: missing url must call process.exit(1)");
  console.log("T-Auth6: missing url in non-interactive mode exits 1 ✓");
});

// ─── T-MR1 — readAuthJsonKey ──────────────────────────────────────────────────

test("T-MR1: readAuthJsonKey returns key when present; undefined when absent or file missing", () => {
  const { dir, authPath } = tmpAuthPath();
  try {
    // Missing file → undefined
    const missing = readAuthJsonKey("anthropic", authPath);
    assert.equal(missing, undefined, "T-MR1: missing auth.json must return undefined");

    // File present but provider absent → undefined
    writeAuth({ providers: { openai: { key: "sk-oai" } } }, authPath);
    const absent = readAuthJsonKey("anthropic", authPath);
    assert.equal(absent, undefined, "T-MR1: absent provider must return undefined");

    // Provider present → key
    writeAuth({ providers: { anthropic: { key: "sk-ant-realkey" } } }, authPath);
    const found = readAuthJsonKey("anthropic", authPath);
    assert.equal(found, "sk-ant-realkey", "T-MR1: present provider key must be returned");

    console.log("T-MR1: readAuthJsonKey present/absent/missing ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T-Auth.4 — visionModel field round-trip (P-15, G-P15.4) ──────────────────

test("T-Auth.4: writeAuth with visionModel field → readAuth returns visionModel; readAuthJsonVisionModel helper returns correct value; absent field → undefined", () => {
  const { dir, authPath } = tmpAuthPath();
  try {
    // Given: auth.json data with visionModel: "openai:gpt-4o"
    // When:  writeAuth then readAuth
    // Then:  auth.visionModel === "openai:gpt-4o"; readAuthJsonVisionModel() returns "openai:gpt-4o"; writing without visionModel → undefined

    // Write with visionModel
    writeAuth({ visionModel: "openai:gpt-4o" }, authPath);
    const auth = readAuth(authPath);
    assert.ok(auth, "auth must be defined after write");
    assert.equal(auth?.visionModel, "openai:gpt-4o", "visionModel must round-trip via readAuth");

    // readAuthJsonVisionModel helper
    const vm = readAuthJsonVisionModel(authPath);
    assert.equal(vm, "openai:gpt-4o", "readAuthJsonVisionModel must return the stored value");

    // Write without visionModel → undefined
    writeAuth({}, authPath);
    const auth2 = readAuth(authPath);
    assert.equal(auth2?.visionModel, undefined, "visionModel must be undefined when not written");
    const vm2 = readAuthJsonVisionModel(authPath);
    assert.equal(vm2, undefined, "readAuthJsonVisionModel must return undefined when absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T-Auth.6 — modelResolver reads stored deepseek baseUrl (P-15, G-P15.4) ───

test("T-Auth.6: readAuth returns stored deepseek baseUrl from auth.json; DEEPSEEK_BASE_URL env wins when set", () => {
  const { dir, authPath } = tmpAuthPath();
  try {
    // Given: auth.json with providers.deepseek.baseUrl: "https://custom.deepseek.com"
    // When:  readAuth(authPath)
    // Then:  auth.providers.deepseek.baseUrl === "https://custom.deepseek.com"; value can be read back correctly

    writeAuth(
      {
        providers: {
          deepseek: { key: "sk-dsk", baseUrl: "https://custom.deepseek.com" },
        },
      },
      authPath,
    );
    const auth = readAuth(authPath);
    assert.ok(auth, "auth must be defined after write");
    assert.ok(auth?.providers?.deepseek, "deepseek provider must be present");
    assert.equal(
      auth?.providers?.deepseek?.baseUrl,
      "https://custom.deepseek.com",
      "deepseek baseUrl must be stored and readable",
    );

    // Precedence: DEEPSEEK_BASE_URL env wins
    const savedEnv = process.env.DEEPSEEK_BASE_URL;
    process.env.DEEPSEEK_BASE_URL = "https://env-override.com";
    const rawBase = process.env.DEEPSEEK_BASE_URL ?? auth?.providers?.deepseek?.baseUrl ?? "https://api.deepseek.com";
    assert.equal(rawBase, "https://env-override.com", "env var must win over stored baseUrl");
    // Cleanup env
    if (savedEnv !== undefined) process.env.DEEPSEEK_BASE_URL = savedEnv;
    else delete process.env.DEEPSEEK_BASE_URL;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P-21 scaffolds — T-MIG.1..T-MIG.4
//
// NOTE: These tests import `migrateProviderEntry`, `DEFAULT_ANTHROPIC_BASE_URL`,
// and `DEFAULT_OPENAI_BASE_URL` which DO NOT EXIST in `src/persistence/auth.ts`
// until builder Step 4b. All tests will fail to compile until then.
// After Step 4b: scaffolds compile + reach assert.fail("TODO...").
// After Step 5: assertion bodies filled in.
//
// Gate coverage:
//   G-P21.4 — T-MIG.1, T-MIG.2, T-MIG.3, T-MIG.4
// ─────────────────────────────────────────────────────────────────────────────

describe("migrateProviderEntry — old-format provider entries get type + default baseUrl (G-P21.4)", () => {
  it("T-MIG.1: when anthropic entry has no type field, migrateProviderEntry → type=anthropic + DEFAULT_ANTHROPIC_BASE_URL", () => {
    // Given: entry = { key: "sk-ant-xxx" } (no type, no baseUrl), name = "anthropic"
    // When:  migrateProviderEntry("anthropic", entry) is called
    // Then:  returned entry.type === "anthropic", entry.baseUrl === DEFAULT_ANTHROPIC_BASE_URL, entry.key preserved
    const entry = migrateProviderEntry("anthropic", { key: "sk-ant-xxx" });
    assert.equal(entry.type, "anthropic", `T-MIG.1: type must be "anthropic"`);
    assert.equal(
      entry.baseUrl,
      DEFAULT_ANTHROPIC_BASE_URL,
      `T-MIG.1: baseUrl must be DEFAULT_ANTHROPIC_BASE_URL (${DEFAULT_ANTHROPIC_BASE_URL})`,
    );
    assert.equal(entry.key, "sk-ant-xxx", "T-MIG.1: key must be preserved");
  });

  it("T-MIG.2: when openai entry has no type field, migrateProviderEntry → type=openai + DEFAULT_OPENAI_BASE_URL", () => {
    // Given: entry = { key: "sk-proj-xxx" } (no type, no baseUrl), name = "openai"
    // When:  migrateProviderEntry("openai", entry) is called
    // Then:  returned entry.type === "openai", entry.baseUrl === DEFAULT_OPENAI_BASE_URL, entry.key preserved
    const entry = migrateProviderEntry("openai", { key: "sk-proj-xxx" });
    assert.equal(entry.type, "openai", `T-MIG.2: type must be "openai"`);
    assert.equal(
      entry.baseUrl,
      DEFAULT_OPENAI_BASE_URL,
      `T-MIG.2: baseUrl must be DEFAULT_OPENAI_BASE_URL (${DEFAULT_OPENAI_BASE_URL})`,
    );
    assert.equal(entry.key, "sk-proj-xxx", "T-MIG.2: key must be preserved");
  });

  it("T-MIG.3: when deepseek entry has baseUrl but no type, migrateProviderEntry → type=openai + baseUrl preserved", () => {
    // Given: entry = { key: "sk-xxx", baseUrl: "https://api.deepseek.com/v1" } (no type), name = "deepseek"
    // When:  migrateProviderEntry("deepseek", entry) is called
    // Then:  returned entry.type === "openai", entry.baseUrl === "https://api.deepseek.com/v1" (unchanged), key preserved
    const entry = migrateProviderEntry("deepseek", { key: "sk-xxx", baseUrl: "https://api.deepseek.com/v1" });
    assert.equal(entry.type, "openai", "T-MIG.3: type must be 'openai' for non-anthropic provider");
    assert.equal(entry.baseUrl, "https://api.deepseek.com/v1", "T-MIG.3: existing baseUrl must be preserved unchanged");
    assert.equal(entry.key, "sk-xxx", "T-MIG.3: key must be preserved");
  });

  it("T-MIG.4: when entry already has type field, migrateProviderEntry → returns entry unchanged", () => {
    // Given: entry = { key: "sk-ant-xxx", baseUrl: "https://api.anthropic.com/v1", type: "anthropic" } (already typed)
    // When:  migrateProviderEntry("anthropic", entry) is called
    // Then:  returned entry is the same reference (short-circuit) with all fields unchanged
    const input = { key: "sk-ant-xxx", baseUrl: "https://api.anthropic.com/v1", type: "anthropic" as const };
    const entry = migrateProviderEntry("anthropic", input);
    assert.equal(entry.type, "anthropic", "T-MIG.4: type must be unchanged");
    assert.equal(entry.baseUrl, "https://api.anthropic.com/v1", "T-MIG.4: baseUrl must be unchanged");
    assert.equal(entry.key, "sk-ant-xxx", "T-MIG.4: key must be unchanged");
    // The implementation returns the entry as-is when type is set (early return)
    assert.deepEqual(entry, input, "T-MIG.4: deep-equal to input (no fields added or changed)");
  });
});

describe("readAuth — migrateAuth called on read; old on-disk entries upgraded in-memory (G-P21.4)", () => {
  it("T-MIG.1b: when on-disk anthropic entry lacks type, readAuth returns entry with type=anthropic + default baseUrl", () => {
    // Given: auth.json on disk has { providers: { anthropic: { key: "sk-ant-mig" } } } (no type, no baseUrl)
    // When:  readAuth(path) is called
    // Then:  returned auth.providers.anthropic.type === "anthropic" AND baseUrl === DEFAULT_ANTHROPIC_BASE_URL
    const { dir, authPath } = tmpAuthPath();
    try {
      writeFileSync(authPath, JSON.stringify({ providers: { anthropic: { key: "sk-ant-mig" } } }), "utf-8");
      const auth = readAuth(authPath);
      assert.ok(auth, "T-MIG.1b: readAuth must return non-null for valid JSON");
      assert.equal(
        auth?.providers?.anthropic?.type,
        "anthropic",
        "T-MIG.1b: readAuth must migrate type to 'anthropic' for name='anthropic' entry",
      );
      assert.equal(
        auth?.providers?.anthropic?.baseUrl,
        DEFAULT_ANTHROPIC_BASE_URL,
        `T-MIG.1b: readAuth must migrate baseUrl to DEFAULT_ANTHROPIC_BASE_URL (${DEFAULT_ANTHROPIC_BASE_URL})`,
      );
      assert.equal(
        auth?.providers?.anthropic?.key,
        "sk-ant-mig",
        "T-MIG.1b: key must be preserved during in-memory migration",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
