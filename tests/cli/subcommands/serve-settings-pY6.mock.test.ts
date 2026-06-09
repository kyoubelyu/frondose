/**
 * P-Y6 Step 4a — T-Get.1-3 + T-Post.1-8 + T-Reload.1-2 — SCAFFOLD (assertion bodies = TODO; intentionally RED).
 *
 * In-app settings serve module (plan §6.4-A): `readSettings()` (MASKED view — never the raw key), `parseSettingsPatch`
 * (validate-before-write, the Step-3b CONCERN-MR), `applySettings` (read-merge-write, write-only key, custom-URL-only
 * type:"openai"), `isFreshKey`, `reloadAgentDeps` (hot-reload deps.system/deps.model, atomic on resolveModel throw).
 * The LLM key lives in secrets.json (readAuth/writeAuth map to it via authPathToSecretsPath); fixtures + assertions
 * use readSecrets/writeSecrets directly. maskKey/readConfig/writeConfig are EXISTING (static import, loads now).
 *
 * LOAD: MIXED. `src/cli/subcommands/serve/settings.ts` is NEW (builder 4b B1) → GATE-ON-BUILDER (dynamic import of
 * readSettings/parseSettingsPatch/applySettings/isFreshKey/reloadAgentDeps). The persistence helpers + maskKey LOAD
 * NOW. T-Post.5 is STRUCTURAL (reads routes.ts source). Temp MAI_HOME_BASE per test. All bodies `assert.fail`.
 *
 * Gate coverage: G-PY6.1 (mask read), .2 (validate-before-write + write-only key + patch-merge), .3 (no SSE/audit
 *   leak — structural), .4 (hot-reload + atomic), .5 (custom-URL-only), .7 (schemas unchanged via 400-no-write).
 *
 * Run (mock): node --import tsx --test --test-force-exit --test-timeout=30000 \
 *   tests/cli/subcommands/serve-settings-pY6.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ServeDeps } from "../../../src/cli/subcommands/serve/context.js";
import { maskKey } from "../../../src/persistence/auth.js";
import { DEFAULT_CONFIG_PATH, readConfig, writeConfig } from "../../../src/persistence/config.js";
import { DEFAULT_SECRETS_PATH, readSecrets, writeSecrets } from "../../../src/persistence/secrets.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ROUTES_TS = readFileSync(join(REPO, "src", "cli", "subcommands", "serve", "routes.ts"), "utf8");
// P-72 slice 6: POST /settings handler moved to routes/settings.ts; widen T-Post.5 to check either location.
const ROUTES_SETTINGS_TS = readFileSync(join(REPO, "src", "cli", "subcommands", "serve", "routes", "settings.ts"), "utf8");

// gate-on-builder: serve/settings.ts is NEW (builder 4b B1)
// biome-ignore lint/suspicious/noExplicitAny: gate-on-builder dynamic import of a not-yet-existing module
type SettingsApi = any;
let S: SettingsApi | undefined;
before(async () => {
  try {
    const spec = "../../../src/cli/subcommands/serve/settings.js";
    S = await import(spec);
  } catch {
    // settings.ts not built yet (pre-4b)
  }
});

/** Run `fn` with MAI_HOME_BASE → a fresh temp dir (DEFAULT_*_PATH resolve under it). */
function withTempHome<T>(fn: (home: string) => T): T {
  const prev = process.env.MAI_HOME_BASE;
  const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pY6-"));
  process.env.MAI_HOME_BASE = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.MAI_HOME_BASE;
    else process.env.MAI_HOME_BASE = prev;
  }
}
/** Seed secrets.json (the LLM store) with a deepseek provider + default. */
function seedSecrets(key: string, opts: { baseUrl?: string; model?: string } = {}): void {
  writeSecrets(
    {
      schema_version: 1,
      default: `deepseek:${opts.model ?? "deepseek-chat"}`,
      providers: { deepseek: { key, baseUrl: opts.baseUrl ?? "https://api.deepseek.com/v1", type: "openai" } },
      // biome-ignore lint/suspicious/noExplicitAny: minimal SecretsJson fixture
    } as any,
    DEFAULT_SECRETS_PATH(),
  );
}
/** Seed config.json v2 with identity + soul. */
function seedConfig(over: Record<string, unknown> = {}): void {
  writeConfig(
    {
      schema_version: 2,
      identity: { fullName: "A", role: "X", icp: { targetRole: ["VP"] }, updatedAt: "OLD-TS" },
      soul: { override: "custom" },
      worker: { input_mode: "cdp" },
      ...over,
      // biome-ignore lint/suspicious/noExplicitAny: minimal ConfigJsonV2 fixture
    } as any,
    DEFAULT_CONFIG_PATH(),
  );
}
/** Deep-scan an object's JSON for a raw substring (the secret-leak guard). */
function jsonContains(obj: unknown, needle: string): boolean {
  return JSON.stringify(obj).includes(needle);
}
/** A reload-deps stub (turn.ts reads deps.system/deps.model per turn). Used by T-Reload at Step 5. */
function makeReloadDeps(): Pick<ServeDeps, "system" | "model"> {
  return { system: "OLD", model: { __old: true } as unknown as ServeDeps["model"] };
}
// readConfig/readSecrets verify writes in the Step-5 assertions; makeReloadDeps stubs T-Reload (referenced now
// so the gate-on-builder scaffold compiles cleanly while every body is still an assert.fail TODO).
void [readConfig, readSecrets, makeReloadDeps];

// ─── 5.1 GET (readSettings) ─────────────────────────────────────────────────
describe("readSettings — masked key + hasKey, never raw (G-PY6.1)", () => {
  // Given: secrets.json deepseek key "sk-realkey1234". When: readSettings(). Then: maskedKey===maskKey(raw),
  //        hasKey true, provider/model/baseUrl surfaced, AND a deep scan finds NO occurrence of the raw key.
  it("T-Get.1: readSettings surfaces maskKey(key)+hasKey+provider/model/baseUrl AND a deep-scan finds NO raw key", () => {
    assert.ok(S, "builder 4b must export serve/settings.ts");
    withTempHome(() => {
      seedSecrets("sk-realkey1234");
      const v = S.readSettings();
      assert.equal(v.llm.hasKey, true);
      assert.equal(v.llm.maskedKey, maskKey("sk-realkey1234"));
      assert.equal(v.llm.provider, "deepseek");
      assert.equal(v.llm.model, "deepseek-chat");
      assert.equal(v.llm.baseUrl, "https://api.deepseek.com/v1");
      // ★ the security gate: a DEEP SCAN of the full view must contain NO occurrence of the raw key
      assert.ok(!jsonContains(v, "sk-realkey1234"), "DEEP SCAN: the raw key must NOT appear anywhere in the view");
    });
  });
});

describe("readSettings — no key → hasKey false (G-PY6.1)", () => {
  // Given: no providers. When: readSettings(). Then: hasKey false, maskedKey null, provider null.
  it("T-Get.2: no provider configured → hasKey false, maskedKey null, provider null", () => {
    assert.ok(S, "builder 4b must export serve/settings.ts");
    withTempHome(() => {
      const v = S.readSettings();
      assert.equal(v.llm.hasKey, false);
      assert.equal(v.llm.maskedKey, null);
      assert.equal(v.llm.provider, null);
    });
  });
});

describe("readSettings — identity + soul surfaced, no updatedAt leak (G-PY6.1)", () => {
  // Given: config.identity {fullName,role,icp,updatedAt} + soul.override. When: readSettings().
  // Then: identity fields surfaced, NO updatedAt in the identity view; soul.override surfaced.
  it("T-Get.3: identity (fullName/role/icp) + soul.override surfaced; identity has NO updatedAt", () => {
    assert.ok(S, "builder 4b must export serve/settings.ts");
    withTempHome(() => {
      seedConfig();
      const v = S.readSettings();
      assert.equal(v.identity.fullName, "A");
      assert.equal(v.identity.role, "X");
      assert.deepEqual(v.identity.icp.targetRole, ["VP"]);
      assert.ok(!("updatedAt" in v.identity), "identity view must not leak updatedAt");
      assert.equal(v.soul.override, "custom");
    });
  });
});

// ─── 5.2 POST (applySettings) ────────────────────────────────────────────────
describe("applySettings — fresh key writes (chmod 600, custom-URL-only) (G-PY6.2, .5)", () => {
  // Given: existing key K_OLD. When: applySettings({llm:{provider,baseUrl,model,key:'sk-newkey9999'}}).
  // Then: secrets key === new, type 'openai', baseUrl/model/default updated, file mode 0o600.
  it("T-Post.1: a fresh non-mask key is written (type:'openai', baseUrl/model/default), secrets.json mode 0o600", () => {
    assert.ok(S, "builder 4b must export serve/settings.ts");
    withTempHome(() => {
      seedSecrets("K_OLD");
      S.applySettings({
        llm: { provider: "deepseek", baseUrl: "https://x/v1", model: "deepseek-chat", key: "sk-newkey9999" },
      });
      const s = readSecrets(DEFAULT_SECRETS_PATH());
      assert.equal(s.providers?.deepseek.key, "sk-newkey9999");
      assert.equal(s.providers?.deepseek.type, "openai");
      assert.equal(s.providers?.deepseek.baseUrl, "https://x/v1");
      assert.equal(s.default, "deepseek:deepseek-chat");
      assert.equal(statSync(DEFAULT_SECRETS_PATH()).mode & 0o777, 0o600, "secrets.json must be chmod 600");
    });
  });
});

describe("applySettings — mask/empty/omitted key keeps existing (G-PY6.2)", () => {
  // Given: existing key K_OLD. When: applySettings with key=maskKey(K_OLD) | "" | omitted.
  // Then: in ALL three, secrets key stays K_OLD; baseUrl/model/default still update.
  it("T-Post.2: a masked / empty / omitted key value KEEPS the existing key (write-only)", () => {
    assert.ok(S, "builder 4b must export serve/settings.ts");
    for (const keyVal of [maskKey("K_OLD"), "", undefined]) {
      withTempHome(() => {
        seedSecrets("K_OLD");
        S.applySettings({
          llm: { provider: "deepseek", model: "deepseek-chat", ...(keyVal !== undefined ? { key: keyVal } : {}) },
        });
        const s = readSecrets(DEFAULT_SECRETS_PATH());
        assert.equal(s.providers?.deepseek.key, "K_OLD", `key kept for keyVal=${JSON.stringify(keyVal)} (write-only)`);
        assert.equal(s.default, "deepseek:deepseek-chat", "default/model still update");
      });
    }
  });
});

describe("applySettings — identity patch-merge + fresh updatedAt (G-PY6.2)", () => {
  // Given: identity {fullName:'A',role:'X',updatedAt:'OLD-TS'}. When: applySettings({identity:{role:'Y'}}).
  // Then: fullName preserved, role patched, updatedAt refreshed (!== OLD-TS).
  it("T-Post.3: identity patch merges (fullName preserved, role patched) + stamps a fresh updatedAt", () => {
    assert.ok(S, "builder 4b must export serve/settings.ts");
    withTempHome(() => {
      seedConfig();
      S.applySettings({ identity: { role: "Y" } });
      const c = readConfig(DEFAULT_CONFIG_PATH());
      assert.equal(c.identity?.fullName, "A", "fullName preserved (patch-merge)");
      assert.equal(c.identity?.role, "Y", "role patched");
      assert.notEqual(c.identity?.updatedAt, "OLD-TS", "updatedAt refreshed");
    });
  });
});

describe("applySettings — soul override round-trip (G-PY6.2)", () => {
  // When: applySettings({soul:{override:'custom soul'}}) → override set; ({soul:{override:null}}) → null.
  it("T-Post.4: soul.override round-trips a string then null", () => {
    assert.ok(S, "builder 4b must export serve/settings.ts");
    withTempHome(() => {
      seedConfig();
      S.applySettings({ soul: { override: "custom soul" } });
      assert.equal(readConfig(DEFAULT_CONFIG_PATH()).soul.override, "custom soul");
      S.applySettings({ soul: { override: null } });
      assert.equal(readConfig(DEFAULT_CONFIG_PATH()).soul.override, null);
    });
  });
});

describe("/settings handler — sendJson only, NO SSE/audit leak (structural) (G-PY6.3)", () => {
  // Given: routes.ts. When: the /settings handler block is inspected. Then: it sendJsons the response and does
  //        NOT pass the body/key to deps.emitFrame / deps.auditWriter (the key never reaches SSE/audit/log).
  it("T-Post.5: the /settings handler uses sendJson and never emitFrame/auditWriter the body", () => {
    // P-72 slice 6: POST /settings handler moved to routes/settings.ts. Widen to check EITHER location.
    // Prefer routes/settings.ts (the new home); fall back to routes.ts dispatcher block.
    const useSplit = ROUTES_SETTINGS_TS.includes("sendJson(");
    const src = useSplit ? ROUTES_SETTINGS_TS : ROUTES_TS;
    let block: string;
    if (useSplit) {
      // The whole routes/settings.ts IS the handler — use the full file as the block.
      block = ROUTES_SETTINGS_TS;
    } else {
      // Legacy monolithic scan: extract the POST "/settings" handler block.
      const start = ROUTES_TS.indexOf('if (method === "POST" && url === "/settings")');
      assert.ok(start > 0, "the POST /settings handler exists in routes.ts");
      const rest = ROUTES_TS.slice(start + 10);
      const end = rest.indexOf("if (method ===");
      block = rest.slice(0, end > 0 ? end : 600);
    }
    void src; // used via block
    assert.match(block, /sendJson\(/, "the /settings handler responds via sendJson (routes.ts or routes/settings.ts after P-72 slice 6)");
    assert.ok(!block.includes("emitFrame"), "the /settings handler must NEVER emitFrame the body (no SSE key leak)");
    assert.ok(
      !block.includes("auditWriter"),
      "the /settings handler must NEVER auditWriter the body (no audit key leak)",
    );
  });
});

describe("applySettings — custom-URL-only write (P-57d) (G-PY6.5)", () => {
  // Given: any llm patch with a fresh key. When: read back. Then: type==='openai' always (never 'anthropic').
  it("T-Post.6: a written provider entry is ALWAYS type:'openai' (never anthropic), regardless of the patch", () => {
    assert.ok(S, "builder 4b must export serve/settings.ts");
    withTempHome(() => {
      seedSecrets("K_OLD");
      // even if a caller smuggled a type, applySettings hardcodes openai (P-57d)
      S.applySettings({
        llm: { provider: "deepseek", model: "deepseek-chat", key: "sk-fresh0001", type: "anthropic" },
      });
      assert.equal(
        readSecrets(DEFAULT_SECRETS_PATH()).providers?.deepseek.type,
        "openai",
        "always openai (custom-URL-only)",
      );
    });
  });
});

describe("applySettings — LLM write skipped when no key at all (G-PY6.2)", () => {
  // Given: no existing key + a patch with no key. When: applySettings. Then: no provider entry written (no crash),
  //        readSettings().llm.hasKey false (providerEntrySchema requires key.min(1) — never write an invalid entry).
  it("T-Post.7: no existing key + no submitted key → no provider entry written (no invalid keyless entry)", () => {
    assert.ok(S, "builder 4b must export serve/settings.ts");
    withTempHome(() => {
      assert.doesNotThrow(() => S.applySettings({ llm: { provider: "deepseek", model: "deepseek-chat" } }));
      assert.equal(S.readSettings().llm.hasKey, false, "no keyless provider entry written");
    });
  });
});

describe("parseSettingsPatch — malformed → 400 + config/secrets UNCHANGED (Step-3b) (G-PY6.2, .7)", () => {
  // Given: valid existing config + secrets. When: parseSettingsPatch(malformed). Then: {ok:false} for each of
  //        (a) oversized soul >3000, (b) bad identity profileUrl + empty ICP targetRole, (c) bad llm baseUrl;
  //        AND applySettings is NEVER reached → readConfig/readSecrets stay UNCHANGED. A well-formed body → {ok:true}.
  it("T-Post.8: malformed bodies → parseSettingsPatch {ok:false} (no write); well-formed → {ok:true,patch}", () => {
    assert.ok(S, "builder 4b must export serve/settings.ts");
    withTempHome(() => {
      seedConfig();
      seedSecrets("K_OLD");
      const malformed = [
        { soul: { override: "x".repeat(3001) } }, // exceeds ≤3000
        { identity: { profileUrl: "notaurl" } }, // bad URL
        { identity: { icp: { targetRole: [] } } }, // empty required array
        { llm: { baseUrl: "not a url" } }, // bad provider baseUrl
      ];
      for (const bad of malformed) {
        assert.equal(S.parseSettingsPatch(bad).ok, false, `must reject ${JSON.stringify(bad)}`);
      }
      // ★ validate-before-write: parse rejects BEFORE applySettings → config/secrets UNCHANGED
      assert.equal(readConfig(DEFAULT_CONFIG_PATH()).soul.override, "custom", "config UNCHANGED after malformed parse");
      assert.equal(readSecrets(DEFAULT_SECRETS_PATH()).providers?.deepseek.key, "K_OLD", "secrets UNCHANGED");
      // a well-formed body parses ok
      const good = S.parseSettingsPatch({ identity: { role: "Z" } });
      assert.equal(good.ok, true, "well-formed body → {ok:true}");
    });
  });
});

// ─── 5.3 Hot-reload (reloadAgentDeps) ────────────────────────────────────────
describe("reloadAgentDeps — deps mutated; next turn would use new (G-PY6.4)", () => {
  // Given: deps {system:'OLD', model:<old>} + a temp HOME whose config/secrets resolve a valid model.
  // When: reloadAgentDeps(deps). Then: deps.system !== 'OLD' (recomposed), deps.model fresh; {restartRequired:false}.
  it("T-Reload.1: reloadAgentDeps recomposes deps.system + re-resolves deps.model; restartRequired:false", () => {
    assert.ok(S, "builder 4b must export serve/settings.ts");
    const prevEnv = process.env.DEEPSEEK_API_KEY;
    withTempHome(() => {
      seedConfig();
      seedSecrets("sk-key");
      process.env.DEEPSEEK_API_KEY = "sk-key"; // resolveModel needs a key for the deepseek default
      const deps = makeReloadDeps();
      const r = S.reloadAgentDeps(deps);
      assert.equal(r.restartRequired, false, "valid config → hot-reload succeeds");
      assert.notEqual(deps.system, "OLD", "deps.system recomposed");
      assert.notDeepEqual(deps.model, { __old: true }, "deps.model re-resolved");
    });
    if (prevEnv === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevEnv;
  });
});

describe("reloadAgentDeps — resolveModel throw → restartRequired, old deps intact (atomic) (G-PY6.4)", () => {
  // Given: deps + a temp HOME whose `default` names an unconfigured provider (resolveModel throws).
  // When: reloadAgentDeps(deps). Then: {restartRequired:true} AND deps.system + deps.model UNCHANGED.
  it("T-Reload.2: a resolveModel throw → restartRequired:true AND deps.system + deps.model left intact", () => {
    assert.ok(S, "builder 4b must export serve/settings.ts");
    const prevEnv = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY; // ensure no env key → resolveModel cannot resolve the deepseek default
    withTempHome(() => {
      // config names a deepseek default but NO secrets provider + no env key → resolveModel throws
      seedConfig();
      const deps = makeReloadDeps();
      const oldModel = deps.model;
      const r = S.reloadAgentDeps(deps);
      assert.equal(r.restartRequired, true, "resolveModel throw → restartRequired");
      assert.equal(deps.system, "OLD", "deps.system left intact (atomic — computed into locals before assign)");
      assert.equal(deps.model, oldModel, "deps.model left intact");
    });
    if (prevEnv === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevEnv;
  });
});
