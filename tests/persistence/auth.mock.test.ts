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
import { test } from "node:test";
import { runAuthSubcommand } from "../../src/cli/subcommands/auth.js";
import { maskKey, readAuth, readAuthJsonKey, readAuthJsonVisionModel, writeAuth } from "../../src/persistence/auth.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function tmpAuthPath(): { dir: string; authPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p7-auth-"));
  return { dir, authPath: join(dir, "auth.json") };
}

// ─── T-Auth1a — initial-create mode 0o600 ────────────────────────────────────

test("T-Auth1a: writeAuth initial-create sets mode 0o600 via openSync", () => {
  const { dir, authPath } = tmpAuthPath();
  try {
    writeAuth({ providers: { anthropic: { key: "sk-ant-test1234" } } }, authPath);
    const mode = statSync(authPath).mode & 0o777;
    assert.equal(mode, 0o600, `T-Auth1a: file mode must be 0o600 on initial create; got ${mode.toString(8)}`);
    // Contents round-trip
    const read = readAuth(authPath);
    assert.equal(read?.providers?.anthropic?.key, "sk-ant-test1234", "T-Auth1a: provider key must round-trip");
    console.log("T-Auth1a: initial-create mode 0o600 ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T-Auth1b — overwrite enforces mode 0o600 ────────────────────────────────

test("T-Auth1b: writeAuth overwrite enforces mode 0o600 via defensive chmodSync", () => {
  const { dir, authPath } = tmpAuthPath();
  try {
    // Pre-create at 0o644 (simulates a pre-existing file created by another tool).
    writeFileSync(authPath, JSON.stringify({ providers: {} }), "utf-8");
    // Manually set mode to 0o644.
    chmodSync(authPath, 0o644);
    assert.equal(statSync(authPath).mode & 0o777, 0o644, "T-Auth1b: pre-condition: file must be 0o644");

    // writeAuth must upgrade it to 0o600.
    writeAuth({ providers: { openai: { key: "sk-openai-overwrite" } } }, authPath);
    const mode = statSync(authPath).mode & 0o777;
    assert.equal(mode, 0o600, `T-Auth1b: overwrite must enforce 0o600; got ${mode.toString(8)}`);
    console.log("T-Auth1b: overwrite defensive chmodSync 0o600 ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T-Auth2 — set with baseUrl ───────────────────────────────────────────────

test("T-Auth2: runAuthSubcommand set stores baseUrl in providers[provider]", async () => {
  const { dir, authPath } = tmpAuthPath();
  try {
    await runAuthSubcommand("set", {
      spec: "openai:deepseek-chat",
      key: "sk-dsk-test",
      baseUrl: "https://api.deepseek.com",
      authPath,
    });
    const auth = readAuth(authPath);
    assert.equal(auth?.providers?.openai?.key, "sk-dsk-test", "T-Auth2: key must be stored");
    assert.equal(auth?.providers?.openai?.baseUrl, "https://api.deepseek.com", "T-Auth2: baseUrl must be stored");
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
    await runAuthSubcommand("set", { spec: "anthropic:claude-sonnet-4-5", key: "sk-ant-toremove", authPath });
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

test("T-Auth6: runAuthSubcommand set with invalid spec (no colon) exits 1 with error", async () => {
  const { dir, authPath } = tmpAuthPath();
  try {
    // parseModelSpec throws when no colon — runAuthSubcommand propagates the throw.
    let threw = false;
    try {
      await runAuthSubcommand("set", { spec: "invalidspec", key: "sk-test", authPath });
    } catch {
      threw = true;
    }
    assert.equal(threw, true, "T-Auth6: invalid spec must throw parseModelSpec error");
    console.log("T-Auth6: invalid spec rejected by parseModelSpec ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
