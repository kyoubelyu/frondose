import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEX_HTML = readFileSync(join(REPO, "src", "tauri", "ui", "index.html"), "utf8");
const SETTINGS_TS = readFileSync(join(REPO, "src", "tauri", "ui", "settings.ts"), "utf8");
const SETTINGS_JS = readFileSync(join(REPO, "src", "tauri", "ui", "settings.js"), "utf8");
const I18N_TS = readFileSync(join(REPO, "src", "tauri", "ui", "i18n.ts"), "utf8");
const I18N_JS = readFileSync(join(REPO, "src", "tauri", "ui", "i18n.js"), "utf8");

type SettingsPanelFactory = (deps: {
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  surfaceError: (label: string, error: unknown) => void;
}) => { open(): Promise<void> };

let createSettingsPanel: SettingsPanelFactory | undefined;
before(async () => {
  const mod = (await import("../../src/tauri/ui/settings.js")) as { createSettingsPanel?: SettingsPanelFactory };
  createSettingsPanel = mod.createSettingsPanel;
});

interface FakeEl {
  value: string;
  placeholder: string;
  textContent: string | null;
  listeners: Record<string, () => void>;
  classList: { add(value: string): void; remove(value: string): void };
  addEventListener(event: string, listener: () => void): void;
}

function installDomStub(): Record<string, FakeEl> {
  const ids = [
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
  const elements: Record<string, FakeEl> = {};
  for (const id of ids) {
    elements[id] = {
      value: "",
      placeholder: "",
      textContent: null,
      listeners: {},
      classList: { add() {}, remove() {} },
      addEventListener(event, listener) {
        elements[id].listeners[event] = listener;
      },
    };
  }
  (globalThis as unknown as { document: unknown }).document = {
    getElementById: (id: string) => elements[id] ?? null,
  };
  return elements;
}

const tick = (): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, 0));

describe("P-EXT-SEARCH Tauri Settings UI", () => {
  // Given shipped Settings markup/source, when scanned, then a masked Brave Search API key control exists and Tavily does not.
  it("T-PExtSearch.UI.7e: Settings carries a Brave Search API key control and no Tavily control", () => {
    for (const [label, source] of [
      ["index.html", INDEX_HTML],
      ["settings.ts", SETTINGS_TS],
      ["settings.js", SETTINGS_JS],
      ["i18n.ts", I18N_TS],
      ["i18n.js", I18N_JS],
    ]) {
      assert.match(
        source,
        /settings-brave-key|settings\.brave|Brave Search API key|braveApiKey/i,
        `${label} must carry the Brave Search API key control`,
      );
      assert.doesNotMatch(source, /settings-tavily|tavilyApiKey|Tavily Search API key/i, `${label} must not carry a Tavily control`);
    }
  });

  // Given a backend response carrying masked search state, when Settings opens and saves a fresh key, then the emitted patch carries search.brave.key.
  it("T-PExtSearch.UI.7f: open echoes the masked key; saving a fresh key emits search.brave.key; masked echo saves nothing", async () => {
    assert.ok(createSettingsPanel);
    const elements = installDomStub();
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ cmd, args });
      return (
        cmd === "frondose_get_settings"
          ? {
              ok: true,
              llm: {
                baseUrl: "https://llm.example/v1",
                model: "deepseek-chat",
                hasKey: true,
                maskedKey: "sk-***9999",
                provider: "deepseek",
              },
              identity: {},
              soul: { override: null },
              updateServerUrl: null,
              search: { brave: { hasKey: true, maskedKey: "bsa-***4567" } },
            }
          : { ok: true }
      ) as T;
    };
    await createSettingsPanel({ invoke, surfaceError: () => {} }).open();
    // Then: the Brave field placeholder echoes the masked key (no raw key leak in UI).
    assert.equal(elements["settings-brave-key"].placeholder, "bsa-***4567");
    assert.equal(elements["settings-brave-key"].value, "");
    // When: the operator types a fresh key and saves.
    calls.length = 0;
    elements["settings-brave-key"].value = "bsa_live_fresh_ui_key_000";
    elements["settings-save"].listeners.click();
    await tick();
    const saved = calls.find((call) => call.cmd === "frondose_set_settings");
    const settings = (saved?.args?.settings ?? {}) as Record<string, unknown>;
    assert.deepEqual(settings.search, { brave: { key: "bsa_live_fresh_ui_key_000" } });
    // When: the field holds only the masked echo and the operator saves again.
    calls.length = 0;
    elements["settings-brave-key"].value = "bsa-***4567";
    elements["settings-save"].listeners.click();
    await tick();
    const saved2 = calls.find((call) => call.cmd === "frondose_set_settings");
    const settings2 = (saved2?.args?.settings ?? {}) as Record<string, unknown>;
    assert.ok(!("search" in settings2), "masked echo must not emit a search patch");
  });
});
