/**
 * P-SETTINGS-SAVE-FIX — collectPatch() omits blank optional fields (regression for the shipped 0.5.0
 * save-400 bug). `frondose_set_settings`'s `settingsPatchSchema` is "omit=unchanged, if present must be
 * valid" (src/cli/subcommands/serve/settings.ts:51-75): `llm.baseUrl` needs `.url()`, `llm.model` and every
 * identity field need `.min(1)`. The old collectPatch() ALWAYS sent these keys, so a blank input produced
 * `""` and 400'd. The fix (src/tauri/ui/settings.ts collectPatch()) omits a field entirely when its input
 * is blank, letting the "omit=unchanged" schema semantics apply.
 *
 * Run (mock): node --import tsx --test --test-force-exit --test-timeout=30000 \
 *   tests/tauri/ui/settings-collectPatch.mock.test.ts
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { parseSettingsPatch } from "../../../src/cli/subcommands/serve/settings.js";

// biome-ignore lint/suspicious/noExplicitAny: dynamic import of the fixed settings.ts
let createSettingsPanel: ((deps: any) => { open(): Promise<void>; close(): void }) | undefined;
before(async () => {
  createSettingsPanel = (await import("../../../src/tauri/ui/settings.js")).createSettingsPanel;
});

interface FakeEl {
  id: string;
  value: string;
  placeholder: string;
  listeners: Record<string, () => void>;
  classList: { add(c: string): void; remove(c: string): void };
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
  "settings-language",
];
function installDomStub(): Record<string, FakeEl> {
  const els: Record<string, FakeEl> = {};
  for (const id of SETTINGS_IDS) {
    els[id] = {
      id,
      value: "",
      placeholder: "",
      listeners: {},
      classList: { add: () => {}, remove: () => {} },
    };
    (els[id] as unknown as { addEventListener: (ev: string, fn: () => void) => void }).addEventListener = (ev, fn) => {
      els[id].listeners[ev] = fn;
    };
  }
  (globalThis as unknown as { document: unknown }).document = { getElementById: (id: string) => els[id] ?? null };
  return els;
}
/** A mock invoke that records every frondose_set_settings body; frondose_get_settings returns a minimal ok resp. */
function mockInvoke() {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    return cmd === "frondose_get_settings"
      ? { ok: true, llm: { baseUrl: null, model: null, hasKey: false, maskedKey: null, provider: null }, identity: {}, soul: { override: null }, updateServerUrl: null }
      : { ok: true };
  };
  return { invoke, calls };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
// biome-ignore lint/suspicious/noExplicitAny: test reaches into the captured DOM-stub listener
type Els = Record<string, any>;

async function fireSaveAndGetPatch(els: Els): Promise<Record<string, unknown>> {
  assert.ok(createSettingsPanel, "settings.ts must export createSettingsPanel");
  const m = mockInvoke();
  createSettingsPanel({ invoke: m.invoke, surfaceError: () => {} });
  els["settings-save"].listeners.click();
  await tick();
  const last = m.calls.filter((c) => c.cmd === "frondose_set_settings").pop();
  return (last?.args?.settings ?? {}) as Record<string, unknown>;
}

describe("collectPatch() — blank llm fields are omitted, not sent as empty strings (regression for the 400)", () => {
  // Given: blank settings-baseurl + settings-model inputs. When: save() fires. Then: the patch's llm has
  //        neither baseUrl nor model keys (omitted, not "").
  it("T-Patch.1: blank baseUrl/model → patch.llm omits baseUrl and model", async () => {
    const els = installDomStub();
    const patch = await fireSaveAndGetPatch(els);
    const llm = patch.llm as Record<string, unknown>;
    assert.ok(!("baseUrl" in llm), "baseUrl omitted when blank");
    assert.ok(!("model" in llm), "model omitted when blank");
  });
});

describe("collectPatch() — blank identity fields are omitted, not sent as empty strings (regression for the 400)", () => {
  // Given: blank identity inputs (fullName/company/role/headline). When: save() fires. Then: the patch's
  //        identity object omits all four keys.
  it("T-Patch.2: blank identity inputs → patch.identity omits fullName/company/role/headline", async () => {
    const els = installDomStub();
    const patch = await fireSaveAndGetPatch(els);
    const identity = patch.identity as Record<string, unknown>;
    for (const f of ["fullName", "company", "role", "headline"]) {
      assert.ok(!(f in identity), `identity.${f} omitted when blank`);
    }
  });
});

describe("collectPatch() — filled fields are included with their values", () => {
  // Given: baseUrl/model/identity inputs filled in. When: save() fires. Then: the patch carries each
  //        filled value verbatim.
  it("T-Patch.3: filled baseUrl/model/identity fields are included with their values", async () => {
    const els = installDomStub();
    els["settings-baseurl"].value = "https://api.example.com/v1";
    els["settings-model"].value = "deepseek-chat";
    els["settings-fullname"].value = "Kyoube Lyu";
    els["settings-company"].value = "Mastars Industries";
    els["settings-role"].value = "Founder";
    els["settings-headline"].value = "Building Frondose";
    const patch = await fireSaveAndGetPatch(els);
    const llm = patch.llm as Record<string, unknown>;
    const identity = patch.identity as Record<string, unknown>;
    assert.equal(llm.baseUrl, "https://api.example.com/v1");
    assert.equal(llm.model, "deepseek-chat");
    assert.equal(identity.fullName, "Kyoube Lyu");
    assert.equal(identity.company, "Mastars Industries");
    assert.equal(identity.role, "Founder");
    assert.equal(identity.headline, "Building Frondose");
  });
});

describe("collectPatch() output passes the serve settingsPatchSchema (the actual regression assertion)", () => {
  // Given: every input left blank (the box-with-no-auth.json trigger). When: collectPatch()'s patch is
  //        validated via the real serve-side parseSettingsPatch (the actual route validator). Then: it's
  //        ok:true (the pre-fix "" patch was ok:false — the shipped 400).
  it("T-Patch.4: all-blank patch passes parseSettingsPatch with ok:true", async () => {
    const els = installDomStub();
    const patch = await fireSaveAndGetPatch(els);
    const result = parseSettingsPatch(patch);
    assert.equal(result.ok, true, `expected ok:true; got ${JSON.stringify(!result.ok && result.error)}`);
  });

  // Given: a realistic mixed save (some fields filled, some left blank — e.g. LLM unconfigured but
  //        identity fully set). When: validated via parseSettingsPatch. Then: ok:true.
  it("T-Patch.5: a mixed filled/blank patch passes parseSettingsPatch with ok:true", async () => {
    const els = installDomStub();
    els["settings-fullname"].value = "Kyoube Lyu";
    els["settings-company"].value = "Mastars Industries";
    // baseUrl/model/role/headline left blank
    const patch = await fireSaveAndGetPatch(els);
    const result = parseSettingsPatch(patch);
    assert.equal(result.ok, true, `expected ok:true; got ${JSON.stringify(!result.ok && result.error)}`);
  });
});
