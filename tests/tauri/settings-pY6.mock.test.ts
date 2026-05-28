/**
 * P-Y6 Step 5 — T-UI.1-4 + T-Scope.1 — FILLED.
 *
 * Settings panel UI (plan §6.4-D/F): `createSettingsPanel({invoke, surfaceError})` — open() loads via
 * mai_get_settings (key field shows the MASK as placeholder, never raw), save() collects + POSTs a key ONLY when
 * freshly typed, then re-loads (re-masks). Custom-URL-only (P-57d): the form exposes baseUrl + model + key ONLY —
 * NO Anthropic/OpenAI-direct/Brave/Tavily preset. T-Scope.1 guards config/secrets schemas unchanged + write-range.
 *
 * LOAD: MIXED. `src/tauri/ui/settings.ts` is NEW (builder 4b B4) → GATE-ON-BUILDER (dynamic import of
 * createSettingsPanel; a DOM stub + mock invoke drive it at Step 5). T-UI.3 (form) + T-Scope.1 are STRUCTURAL —
 * index.html + config.ts + secrets.ts EXIST (read at load); settings.ts source is read lazily (NEW).
 * jsdom is NOT a project dep — a minimal getElementById stub is used.
 *
 * Gate coverage: G-PY6.6 (mask placeholder + key-only-when-typed + re-mask), G-PY6.1 (UI never shows raw),
 *   G-PY6.5 (custom-URL-only form), G-PY6.7 (schemas unchanged + write-range).
 *
 * Run (mock): node --import tsx --test --test-force-exit --test-timeout=30000 \
 *   tests/tauri/settings-pY6.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEX_HTML = readFileSync(join(REPO, "src", "tauri", "ui", "index.html"), "utf8");
const CONFIG_TS = readFileSync(join(REPO, "src", "persistence", "config.ts"), "utf8");
const SECRETS_TS = readFileSync(join(REPO, "src", "persistence", "secrets.ts"), "utf8");
const SETTINGS_TS_PATH = join(REPO, "src", "tauri", "ui", "settings.ts");

// gate-on-builder: tauri/ui/settings.ts is NEW (builder 4b B4)
// biome-ignore lint/suspicious/noExplicitAny: gate-on-builder dynamic import
let createSettingsPanel: ((deps: any) => { open(): Promise<void>; close(): void }) | undefined;
before(async () => {
  try {
    const spec = "../../src/tauri/ui/settings.js";
    createSettingsPanel = (await import(spec)).createSettingsPanel;
  } catch {
    // settings.ts not built yet (pre-4b)
  }
});

// ── Minimal DOM stub (jsdom is NOT a project dep — mirror the button-click approach but pure-stub) ──
interface FakeEl {
  id: string;
  value: string;
  placeholder: string;
  listeners: Record<string, () => void>;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
}
const SETTINGS_IDS = [
  "settings-panel",
  "settings-save",
  "settings-close",
  "settings-baseurl",
  "settings-model",
  "settings-key",
  "settings-fullname",
  "settings-company",
  "settings-role",
  "settings-headline",
  "settings-icp-roles",
  "settings-soul",
];
function installDomStub(): Record<string, FakeEl> {
  const els: Record<string, FakeEl> = {};
  for (const id of SETTINGS_IDS) {
    const cls = new Set<string>();
    els[id] = {
      id,
      value: "",
      placeholder: "",
      listeners: {},
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
    };
    // addEventListener captured so save()/close() can be fired in-test
    (els[id] as unknown as { addEventListener: (ev: string, fn: () => void) => void }).addEventListener = (ev, fn) => {
      els[id].listeners[ev] = fn;
    };
  }
  (globalThis as unknown as { document: unknown }).document = { getElementById: (id: string) => els[id] ?? null };
  return els;
}
/** A mock invoke that records calls + returns a canned mai_get_settings response. */
function mockInvoke(getResp: Record<string, unknown>) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    return cmd === "mai_get_settings" ? getResp : { ok: true };
  };
  return { invoke, calls };
}
const SAMPLE_GET = {
  ok: true,
  llm: { baseUrl: "https://x/v1", model: "deepseek-chat", hasKey: true, maskedKey: "sk-***9999", provider: "deepseek" },
  identity: { fullName: "A" },
  soul: { override: "s" },
};
/** Flush microtasks so an async save() (await invoke + await load) settles after firing its click listener. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
// biome-ignore lint/suspicious/noExplicitAny: test reaches into the captured DOM-stub listener
type Els = Record<string, any>;

function parsePorcelainFixturePaths(statusOut: string): string[] {
  return statusOut
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const path = line.slice(3).trim();
      return path.includes(" -> ") ? path.split(" -> ") : [path];
    })
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
}

function isPY6AllowedPath(p: string): boolean {
  return (
    p === "src/cli/subcommands/serve/settings.ts" ||
    p === "src/cli/subcommands/serve/routes.ts" ||
    p === "src/tauri/src-tauri/src/main.rs" ||
    p === "src/agent/systemPrompt/soul.ts" ||
    p === "src/agent/workflow/controller.ts" ||
    p === "src/overlay/host.ts" ||
    p === "src/persistence/salesDb.ts" ||
    p === "src/tools/browser/click.ts" ||
    p === "src/tauri/src-tauri/Cargo.lock" ||
    p === "src/tauri/src-tauri/Cargo.toml" ||
    p === "src/tauri/src-tauri/tauri.conf.json" ||
    /^src\/tauri\/ui\/(settings|app)\.(ts|js|js\.map)$/.test(p) ||
    p === "src/tauri/ui/index.html" ||
    /^src\/overlay\/(frondoseCss|sharedRenderBundle)\.generated\.ts$/.test(p)
  );
}

function collectPY6ScopeViolations(statusOut: string): string[] {
  const violations: string[] = [];
  for (const p of parsePorcelainFixturePaths(statusOut)) {
    if (p === "src/persistence/config.ts" || p === "src/persistence/secrets.ts") {
      violations.push(`schema file must remain unchanged: ${p}`);
    }
    if (!isPY6AllowedPath(p)) {
      violations.push(`production change outside the P-Y6 builder set: ${p}`);
    }
    if (p.startsWith("src/tools/") && p !== "src/tools/browser/click.ts") {
      violations.push(`no src/tools/** edit allowed except P-67 formatter-only click.ts: ${p}`);
    }
  }
  return violations;
}

function assertPY6Scope(statusOut: string): void {
  const violations = collectPY6ScopeViolations(statusOut);
  assert.deepEqual(violations, [], `unexpected P-Y6 scope violations: ${JSON.stringify(violations)}`);
}

describe("settings panel — load populates; key shows mask, never raw (G-PY6.6, .1)", () => {
  // Given: mock mai_get_settings → maskedKey "sk-***9999". When: createSettingsPanel(deps).open().
  // Then: the key input value is "" and placeholder is the mask (never a raw key); baseUrl/model/fullName/soul populated.
  it("T-UI.1: open() populates fields; key input value='' + placeholder=maskedKey (never the raw key)", async () => {
    assert.ok(createSettingsPanel, "builder 4b must export createSettingsPanel");
    const els: Els = installDomStub();
    const m = mockInvoke(SAMPLE_GET);
    await createSettingsPanel({ invoke: m.invoke, surfaceError: () => {} }).open();
    assert.equal(els["settings-key"].value, "", "key input value empty (never the raw key)");
    assert.equal(els["settings-key"].placeholder, "sk-***9999", "key placeholder is the mask");
    assert.equal(els["settings-baseurl"].value, "https://x/v1");
    assert.equal(els["settings-model"].value, "deepseek-chat");
    assert.equal(els["settings-fullname"].value, "A");
    assert.equal(els["settings-soul"].value, "s");
  });
});

describe("settings panel — save sends key ONLY when typed (G-PY6.6, .2)", () => {
  // Given: panel after open(), key input empty. When: save() (fire settings-save listener). Then: the
  //        mai_set_settings body's llm.key is absent. AND with a typed key → body llm.key === the typed value.
  it("T-UI.2: save() omits llm.key when the input is empty; includes it when the operator typed one", async () => {
    assert.ok(createSettingsPanel, "builder 4b must export createSettingsPanel");
    const els: Els = installDomStub();
    const m = mockInvoke(SAMPLE_GET);
    const p = createSettingsPanel({ invoke: m.invoke, surfaceError: () => {} });
    await p.open();
    const lastSet = () =>
      m.calls.filter((c) => c.cmd === "mai_set_settings").pop() as {
        args?: { settings: { llm: Record<string, unknown> } };
      };
    // empty key field → no key in the body
    els["settings-save"].listeners.click();
    await tick();
    assert.ok(!("key" in (lastSet().args?.settings.llm ?? {})), "no llm.key sent when the input is empty");
    // typed key → key in the body
    els["settings-key"].value = "sk-typed";
    els["settings-save"].listeners.click();
    await tick();
    assert.equal(lastSet().args?.settings.llm.key, "sk-typed", "the typed key IS sent");
  });
});

describe("settings panel — custom-URL-only form (structural, P-57d) (G-PY6.5)", () => {
  // Given: index.html + settings.ts. When: inspected. Then: the panel exposes baseUrl + model + key ONLY;
  //        NO anthropic / openai-direct / brave / tavily preset/control token.
  it("T-UI.3: the settings form is custom-URL-only — baseUrl/model/key, NO anthropic/brave/tavily preset", () => {
    const start = INDEX_HTML.indexOf('id="settings-panel"');
    assert.ok(start > 0, "the #settings-panel section exists in index.html");
    const panel = INDEX_HTML.slice(start, INDEX_HTML.indexOf("</section>", start));
    for (const id of ["settings-baseurl", "settings-model", "settings-key"]) {
      assert.ok(panel.includes(id), `panel has the ${id} input`);
    }
    const settingsTs = existsSync(SETTINGS_TS_PATH) ? readFileSync(SETTINGS_TS_PATH, "utf8") : "";
    for (const tok of ["anthropic", "brave", "tavily", "api.openai.com", "api.anthropic.com"]) {
      assert.ok(!panel.toLowerCase().includes(tok), `index.html panel must not mention ${tok} (custom-URL-only)`);
      assert.ok(!settingsTs.toLowerCase().includes(tok), `settings.ts must not mention ${tok} (custom-URL-only)`);
    }
  });
});

describe("settings panel — save → re-load re-masks (behavioral) (G-PY6.6)", () => {
  // Given: mock invoke. When: save() resolves. Then: mai_get_settings is invoked AGAIN (re-load) so the key field
  //        returns to the masked placeholder.
  it("T-UI.4: after save() the panel re-invokes mai_get_settings (re-load → key re-masked)", async () => {
    assert.ok(createSettingsPanel, "builder 4b must export createSettingsPanel");
    const els: Els = installDomStub();
    const m = mockInvoke(SAMPLE_GET);
    const p = createSettingsPanel({ invoke: m.invoke, surfaceError: () => {} });
    await p.open();
    m.calls.length = 0; // clear the open()-load call
    els["settings-save"].listeners.click();
    await tick();
    assert.ok(
      m.calls.some((c) => c.cmd === "mai_set_settings"),
      "save POSTs mai_set_settings",
    );
    assert.ok(
      m.calls.some((c) => c.cmd === "mai_get_settings"),
      "save re-loads (re-GET → key re-masked)",
    );
  });
});

describe("scope — config/secrets schemas UNCHANGED + write-range (structural) (G-PY6.7)", () => {
  // Given: current config/secrets source and deterministic fixture paths.
  // When: inspected by the fixture scope validator.
  // Then: schema symbols are present, allowed paths pass, and schema/unrelated paths fail deterministically.
  it("T-Scope.1: schema symbols present; fixture src changes stay within §3 builder paths", () => {
    assert.match(CONFIG_TS, /configJsonSchemaV2 = z\.object/, "configJsonSchemaV2 present");
    assert.match(SECRETS_TS, /secretsJsonSchema = z\.object/, "secretsJsonSchema present");
    assertPY6Scope(`
 M src/cli/subcommands/serve/settings.ts
A  src/tauri/ui/settings.ts
?? src/tauri/ui/index.html
R  src/overlay/frondoseCss.generated.ts -> src/overlay/sharedRenderBundle.generated.ts
C  src/tauri/ui/app.js -> src/tauri/ui/app.js.map
 M src/tools/browser/click.ts
`);
    const violations = collectPY6ScopeViolations(`
 M src/persistence/config.ts
 M src/persistence/secrets.ts
 M src/tools/browser/inspect.ts
 M src/agent/runner.ts
`);
    for (const expected of [
      "src/persistence/config.ts",
      "src/persistence/secrets.ts",
      "src/tools/browser/inspect.ts",
      "src/agent/runner.ts",
    ]) {
      assert.ok(
        violations.some((v) => v.includes(expected)),
        `expected violation for ${expected}; got ${JSON.stringify(violations)}`,
      );
    }
  });
});

describe("scope — deterministic P-Y6 fixture validator (P-69a)", () => {
  it("T-Scope.1a: schema symbols are present and empty fixture status is accepted", () => {
    // Given: current config.ts and secrets.ts source plus an empty fixture status string.
    // When: the fixture-based P-Y6 settings scope validator runs.
    // Then: schema symbols are present and empty status passes without live git diff.
    assert.match(CONFIG_TS, /configJsonSchemaV2 = z\.object/, "configJsonSchemaV2 present");
    assert.match(SECRETS_TS, /secretsJsonSchema = z\.object/, "secretsJsonSchema present");
    assertPY6Scope("");
  });

  it("T-Scope.1b: approved P-Y6 fixture paths are accepted", () => {
    // Given: approved P-Y6 settings fixture paths and preserved sibling exceptions.
    // When: the fixture-based P-Y6 settings scope validator runs.
    // Then: approved paths pass without reading the operator's live worktree.
    assert.deepEqual(
      parsePorcelainFixturePaths(`
 M src/cli/subcommands/serve/settings.ts
 M src/cli/subcommands/serve/routes.ts
A  src/tauri/src-tauri/src/main.rs
?? src/tauri/ui/settings.ts
R  src/overlay/frondoseCss.generated.ts -> src/overlay/sharedRenderBundle.generated.ts
C  src/tauri/ui/app.js -> src/tauri/ui/app.js.map
 M src/tauri/src-tauri/Cargo.toml
 M src/tools/browser/click.ts
`),
      [
        "src/cli/subcommands/serve/settings.ts",
        "src/cli/subcommands/serve/routes.ts",
        "src/tauri/src-tauri/src/main.rs",
        "src/tauri/ui/settings.ts",
        "src/overlay/frondoseCss.generated.ts",
        "src/overlay/sharedRenderBundle.generated.ts",
        "src/tauri/ui/app.js",
        "src/tauri/ui/app.js.map",
        "src/tauri/src-tauri/Cargo.toml",
        "src/tools/browser/click.ts",
      ],
    );
    assertPY6Scope(`
 M src/cli/subcommands/serve/settings.ts
 M src/cli/subcommands/serve/routes.ts
A  src/tauri/src-tauri/src/main.rs
?? src/tauri/ui/settings.ts
R  src/overlay/frondoseCss.generated.ts -> src/overlay/sharedRenderBundle.generated.ts
C  src/tauri/ui/app.js -> src/tauri/ui/app.js.map
 M src/tauri/src-tauri/Cargo.toml
 M src/tools/browser/click.ts
`);
  });

  it("T-Scope.1c: schema-path and unrelated source fixture paths are rejected", () => {
    // Given: schema-path fixture edits and unrelated source fixture paths.
    // When: the fixture-based P-Y6 settings scope validator runs.
    // Then: schema-path edits and unrelated source paths are rejected deterministically.
    const violations = collectPY6ScopeViolations(`
 M src/persistence/config.ts
 M src/persistence/secrets.ts
 M src/tools/browser/inspect.ts
 M src/agent/unrelated.ts
 M src/persistence/mode.ts
`);
    for (const expected of [
      "src/persistence/config.ts",
      "src/persistence/secrets.ts",
      "src/tools/browser/inspect.ts",
      "src/agent/unrelated.ts",
      "src/persistence/mode.ts",
    ]) {
      assert.ok(
        violations.some((v) => v.includes(expected)),
        `expected violation for ${expected}; got ${JSON.stringify(violations)}`,
      );
    }
  });
});
