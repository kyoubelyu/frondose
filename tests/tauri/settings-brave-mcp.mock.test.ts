import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEX_HTML = readFileSync(join(REPO, "src", "tauri", "ui", "index.html"), "utf8");
const SETTINGS_TS = readFileSync(join(REPO, "src", "tauri", "ui", "settings.ts"), "utf8");

type SettingsPanelFactory = (deps: {
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  surfaceError: (label: string, e: unknown) => void;
}) => { open(): Promise<void>; close(): void };

let createSettingsPanel: SettingsPanelFactory | undefined;
before(async () => {
  const mod = (await import("../../src/tauri/ui/settings.js")) as { createSettingsPanel?: SettingsPanelFactory };
  createSettingsPanel = mod.createSettingsPanel;
});

interface FakeEl {
  id: string;
  value: string;
  placeholder: string;
  textContent: string | null;
  listeners: Record<string, () => void>;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
  addEventListener(ev: string, fn: () => void): void;
}

const SETTINGS_IDS = [
  "settings-panel",
  "settings-save",
  "settings-close",
  "settings-baseurl",
  "settings-model",
  "settings-key",
  "settings-brave-key",
  "settings-fullname",
  "settings-company",
  "settings-role",
  "settings-headline",
  "settings-icp-roles",
  "settings-soul",
  "settings-update-url",
  "settings-update-status",
  "settings-check-update",
];

function installDomStub(): Record<string, FakeEl> {
  const els: Record<string, FakeEl> = {};
  for (const id of SETTINGS_IDS) {
    const cls = new Set<string>();
    els[id] = {
      id,
      value: "",
      placeholder: "",
      textContent: null,
      listeners: {},
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
      addEventListener(ev, fn) {
        els[id].listeners[ev] = fn;
      },
    };
  }
  (globalThis as unknown as { document: unknown }).document = { getElementById: (id: string) => els[id] ?? null };
  return els;
}

const SAMPLE_GET = {
  ok: true,
  llm: {
    baseUrl: "https://llm.example/v1",
    model: "deepseek-chat",
    hasKey: true,
    maskedKey: "sk-***9999",
    provider: "deepseek",
  },
  search: { brave: { hasKey: true, maskedKey: "bsa-***7890" } },
  identity: { fullName: "A" },
  soul: { override: "s" },
  updateServerUrl: null,
};

function mockInvoke(getResp: Record<string, unknown>) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    return cmd === "mai_get_settings" ? getResp : { ok: true };
  };
  return { invoke, calls };
}

const tick = (): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, 0));

describe("P-BRAVE-MCP Tauri Settings UI", () => {
  it("T-PBrave.UI.1: index.html contains a password Brave key input and no Tavily control", () => {
    // Given: the Tauri Settings HTML.
    // When: the settings markup is inspected.
    // Then: it contains the Brave MCP key input and no Tavily settings control.
    assert.match(INDEX_HTML, /id="settings-brave-key"/);
    assert.match(INDEX_HTML, /id="settings-brave-key"[^>]*type="password"|type="password"[^>]*id="settings-brave-key"/);
    assert.match(INDEX_HTML, /id="settings-brave-key"[^>]*autocomplete="off"|autocomplete="off"[^>]*id="settings-brave-key"/);
    assert.doesNotMatch(`${INDEX_HTML}\n${SETTINGS_TS}`, /settings-tavily|Tavily Search API key/i);
  });

  it("T-PBrave.UI.2: open() loads the Brave mask as placeholder and keeps the password value empty", async () => {
    assert.ok(createSettingsPanel, "settings.ts must export createSettingsPanel");
    const els = installDomStub();
    const m = mockInvoke(SAMPLE_GET);

    // Given: mai_get_settings returns search.brave.maskedKey.
    // When: the Settings panel opens.
    // Then: settings-brave-key.value is empty and placeholder is the mask.
    await createSettingsPanel({ invoke: m.invoke, surfaceError: () => {} }).open();

    assert.equal(els["settings-brave-key"].value, "", "Brave key input must never show the raw key");
    assert.equal(els["settings-brave-key"].placeholder, "bsa-***7890");
    assert.equal(els["settings-key"].placeholder, "sk-***9999", "existing LLM key placeholder behavior remains");
  });

  it("T-PBrave.UI.3: save sends search.brave.key only when the operator typed a Brave key", async () => {
    assert.ok(createSettingsPanel, "settings.ts must export createSettingsPanel");
    const els = installDomStub();
    const m = mockInvoke(SAMPLE_GET);
    const panel = createSettingsPanel({ invoke: m.invoke, surfaceError: () => {} });
    await panel.open();
    m.calls.length = 0;

    // Given: the Brave key input is empty.
    // When: save is clicked.
    // Then: the settings patch omits search.brave.key.
    els["settings-save"].listeners.click();
    await tick();
    const firstSet = m.calls.find((call) => call.cmd === "mai_set_settings") as {
      args?: { settings?: { search?: { brave?: { key?: string } } } };
    };
    assert.ok(!firstSet.args?.settings?.search?.brave?.key, "empty Brave key input must not send a key");

    // Given: the operator typed a Brave key.
    // When: save is clicked again.
    // Then: the patch contains search.brave.key with the typed value.
    m.calls.length = 0;
    els["settings-brave-key"].value = "typed-brave-key";
    els["settings-save"].listeners.click();
    await tick();
    const secondSet = m.calls.find((call) => call.cmd === "mai_set_settings") as {
      args?: { settings?: { search?: { brave?: { key?: string } } } };
    };
    assert.equal(secondSet.args?.settings?.search?.brave?.key, "typed-brave-key");
  });
});
