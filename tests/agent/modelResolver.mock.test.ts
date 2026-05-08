import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_MODEL_SPEC, parseModelSpec, resolveModel, resolveModelSpec } from "../../src/agent/modelResolver.js";

// T-M1..T-M4: MAI_MODEL precedence chain + parseModelSpec contract

/**
 * Helpers: save/restore process.env properties in try/finally for test isolation.
 * Implements NIT-4 discipline from docs/phase-1-critics.md.
 */
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

// ─── T-M1: factory precedence ─────────────────────────────────────────────────

test("T-M1: factory takes precedence over cli/env/auth.json/default", () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-home-tm1-"));
  const saved = saveEnv("HOME", "MAI_MODEL");
  try {
    process.env.HOME = tmpHome;
    process.env.MAI_MODEL = "openai:gpt-4o";
    const spec = resolveModelSpec({ factory: "anthropic:claude-sonnet-4-5", cli: "openai:deepseek-chat" });
    assert.equal(spec, "anthropic:claude-sonnet-4-5", "factory must beat cli/env/auth.json/default");
  } finally {
    restoreEnv(saved);
    rmSync(tmpHome, { recursive: true });
  }
});

// ─── T-M2: cli precedence ─────────────────────────────────────────────────────

test("T-M2: cli takes precedence over env/auth.json/default when factory absent", () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-home-tm2-"));
  const saved = saveEnv("HOME", "MAI_MODEL");
  try {
    process.env.HOME = tmpHome;
    process.env.MAI_MODEL = "openai:gpt-4o";
    const spec = resolveModelSpec({ cli: "openai:deepseek-chat" });
    assert.equal(spec, "openai:deepseek-chat", "cli must beat env/auth.json/default");
  } finally {
    restoreEnv(saved);
    rmSync(tmpHome, { recursive: true });
  }
});

// ─── T-M3: exhaustive 5-case precedence chain (CONCERN-MR-1) ─────────────────

test("T-M3: resolveModelSpec precedence chain — all 5 levels (CONCERN-MR-1)", async (t) => {
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-home-tm3-"));
  const saved = saveEnv("HOME", "MAI_MODEL");

  try {
    // (a) factory wins over cli + env + auth.json + default
    await t.test("(a) factory wins", () => {
      process.env.HOME = tmpHome;
      process.env.MAI_MODEL = "openai:env-model";
      const result = resolveModelSpec({ factory: "anthropic:factory-model", cli: "openai:cli-model" });
      assert.equal(result, "anthropic:factory-model");
    });

    // (b) cli wins over env + auth.json + default (no factory)
    await t.test("(b) cli wins when factory absent", () => {
      process.env.HOME = tmpHome;
      process.env.MAI_MODEL = "openai:env-model";
      const result = resolveModelSpec({ cli: "openai:cli-model" });
      assert.equal(result, "openai:cli-model");
    });

    // (c) env wins over auth.json + default (no factory, no cli)
    await t.test("(c) env wins when factory and cli absent", () => {
      process.env.HOME = tmpHome; // no auth.json in tmpHome
      process.env.MAI_MODEL = "openai:env-model";
      const result = resolveModelSpec({});
      assert.equal(result, "openai:env-model");
    });

    // (d) auth.json default wins when factory/cli/env absent
    await t.test("(d) auth.json default wins when factory/cli/env absent", () => {
      process.env.HOME = tmpHome;
      delete process.env.MAI_MODEL;
      const maiDir = join(tmpHome, ".mai");
      mkdirSync(maiDir, { recursive: true });
      writeFileSync(join(maiDir, "auth.json"), '{"default":"openai:auth-model"}', "utf-8");
      const result = resolveModelSpec({});
      assert.equal(result, "openai:auth-model");
      // Remove auth.json so next sub-test (e) gets the hardcoded fallback
      rmSync(join(maiDir, "auth.json"));
    });

    // (e) hardcoded fallback when all sources absent
    await t.test("(e) hardcoded fallback anthropic:claude-sonnet-4-5 when all unset", () => {
      process.env.HOME = tmpHome; // no auth.json (removed in (d))
      delete process.env.MAI_MODEL;
      const result = resolveModelSpec({});
      assert.equal(result, DEFAULT_MODEL_SPEC);
      assert.equal(DEFAULT_MODEL_SPEC, "anthropic:claude-sonnet-4-5");
    });
  } finally {
    restoreEnv(saved);
    rmSync(tmpHome, { recursive: true });
  }
});

// ─── T-M4: parseModelSpec error cases + unknown-provider throw ────────────────

test("T-M4: parseModelSpec rejects malformed specs; resolveModel throws on unknown provider", async (t) => {
  await t.test("no colon throws", () => {
    assert.throws(
      () => parseModelSpec("invalid"),
      (err: Error) => err.message.includes("Invalid model spec"),
    );
  });

  await t.test("empty provider throws", () => {
    assert.throws(
      () => parseModelSpec(":foo"),
      (err: Error) => err.message.includes("empty provider"),
    );
  });

  await t.test("empty modelId throws", () => {
    assert.throws(
      () => parseModelSpec("foo:"),
      (err: Error) => err.message.includes("empty provider or modelId"),
    );
  });

  await t.test("valid anthropic spec parses correctly", () => {
    const { provider, modelId } = parseModelSpec("anthropic:claude-sonnet-4-5");
    assert.equal(provider, "anthropic");
    assert.equal(modelId, "claude-sonnet-4-5");
  });

  await t.test("valid openai spec parses correctly", () => {
    const { provider, modelId } = parseModelSpec("openai:deepseek-chat");
    assert.equal(provider, "openai");
    assert.equal(modelId, "deepseek-chat");
  });

  await t.test("unknown provider throws on resolveModel (before SDK call)", () => {
    const saved = saveEnv("HOME");
    const tmpHome = mkdtempSync(join(tmpdir(), "mai-home-tm4-"));
    try {
      process.env.HOME = tmpHome;
      assert.throws(
        () => resolveModel({ factory: "groq:llama-3" }),
        (err: Error) => err.message.includes("Unknown provider"),
      );
    } finally {
      restoreEnv(saved);
      rmSync(tmpHome, { recursive: true });
    }
  });
});
