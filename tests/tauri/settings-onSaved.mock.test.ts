/**
 * P-FIX-ICP-STALE-CACHE mock tests — T-ICP-Stale.3/.4: `createSettingsPanel`'s optional
 * `onSaved` callback lets the caller (app.ts) refresh home-page identity/ICP state after a
 * successful Settings save, without a full app restart.
 *
 * describe/it + Given/When/Then per CLAUDE.md § Test Discipline.
 *
 * Mirrors the DOM-stub + mockInvoke pattern from tests/tauri/settings-brave-mcp.mock.test.ts.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

type SettingsPanelFactory = (deps: {
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  surfaceError: (label: string, e: unknown) => void;
  onSaved?: () => void;
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
  identity: { fullName: "A" },
  soul: { override: "s" },
  updateServerUrl: null,
};

function mockInvoke(getResp: Record<string, unknown>) {
  const invoke = async (cmd: string) => (cmd === "frondose_get_settings" ? getResp : { ok: true });
  return { invoke };
}

const tick = (): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, 0));

describe("settings panel — onSaved notifies the caller after a successful save (P-FIX-ICP-STALE-CACHE)", () => {
  it("T-ICP-Stale.3: given a panel constructed with onSaved, when save() resolves, then onSaved was called exactly once", async () => {
    assert.ok(createSettingsPanel, "settings.ts must export createSettingsPanel");
    const els = installDomStub();
    const m = mockInvoke(SAMPLE_GET);
    let onSavedCalls = 0;
    const panel = createSettingsPanel({
      invoke: m.invoke,
      surfaceError: () => {},
      onSaved: () => {
        onSavedCalls += 1;
      },
    });
    await panel.open();

    els["settings-save"].listeners.click();
    await tick();

    assert.equal(onSavedCalls, 1, "onSaved must fire exactly once after a successful save");
  });

  it("T-ICP-Stale.4: given a panel constructed WITHOUT onSaved (existing callers), when save() is called, then it does not throw", async () => {
    assert.ok(createSettingsPanel, "settings.ts must export createSettingsPanel");
    const els = installDomStub();
    const m = mockInvoke(SAMPLE_GET);
    const panel = createSettingsPanel({ invoke: m.invoke, surfaceError: () => {} }); // no onSaved
    await panel.open();

    els["settings-save"].listeners.click();
    await tick(); // must not throw / reject

    assert.ok(true, "save() completed without onSaved wired");
  });
});
