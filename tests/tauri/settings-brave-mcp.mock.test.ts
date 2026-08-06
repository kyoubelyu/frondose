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
const OVERLAY_BUNDLE = readFileSync(join(REPO, "src", "overlay", "sharedRenderBundle.generated.ts"), "utf8");

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

describe("P-WEB-SEARCH-MCP-SCOPE Tauri Settings UI", () => {
  // Given shipped Settings markup/source, when scanned, then neither Brave nor Tavily controls or patch keys exist.
  it("T-MCP-SCOPE.7e: Settings has no search-provider control", () => {
    for (const [label, source] of [
      ["index.html", INDEX_HTML],
      ["settings.ts", SETTINGS_TS],
      ["settings.js", SETTINGS_JS],
      ["i18n.ts", I18N_TS],
      ["i18n.js", I18N_JS],
      ["sharedRenderBundle.generated.ts", OVERLAY_BUNDLE],
    ]) {
      assert.doesNotMatch(
        source,
        /settings-brave-key|settings-tavily|settings\.braveKey|settings\.groupSearch|Brave Search API key|braveApiKey|tavilyApiKey/i,
        `${label} must not retain a generated or source search-provider control`,
      );
    }
  });

  // Given a backend response containing no search state, when Settings opens and saves, then the emitted patch has no search field.
  it("T-MCP-SCOPE.7f: open/save emits no search patch", async () => {
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
            }
          : { ok: true }
      ) as T;
    };
    await createSettingsPanel({ invoke, surfaceError: () => {} }).open();
    calls.length = 0;
    elements["settings-save"].listeners.click();
    await tick();
    const saved = calls.find((call) => call.cmd === "frondose_set_settings");
    const settings = (saved?.args?.settings ?? {}) as Record<string, unknown>;
    assert.ok(!("search" in settings));
  });
});
