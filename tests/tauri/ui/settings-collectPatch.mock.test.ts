/**
 * P-SETTINGS-SAVE-FIX — collectPatch() omits blank optional fields (regression for the shipped 0.5.0
 * save-400 bug). `frondose_set_settings`'s `settingsPatchSchema` is "omit=unchanged, if present must be
 * valid" (src/app/backend/settings.ts:51-75): `llm.baseUrl` needs `.url()`, `llm.model` and every
 * identity field need `.min(1)`. The old collectPatch() ALWAYS sent these keys, so a blank input produced
 * `""` and 400'd. The fix (src/tauri/ui/settings.ts collectPatch()) omits a field entirely when its input
 * is blank, letting the "omit=unchanged" schema semantics apply.
 *
 * Run (mock): node --import tsx --test --test-force-exit --test-timeout=30000 \
 *   tests/tauri/ui/settings-collectPatch.mock.test.ts
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { parseSettingsPatch } from "../../../src/app/backend/settings.js";

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
  "settings-fullname",
  "settings-company",
  "settings-role",
  "settings-headline",
  "settings-profileurl",
  "settings-persona",
  "settings-style",
  "settings-contact",
  "settings-icp-roles",
  "settings-icp-industry",
  "settings-icp-region",
  "settings-icp-keywords",
  "settings-axis-painchain",
  "settings-axis-leadrole",
  "settings-axis-discovery",
  "settings-axis-story",
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
      ? {
          ok: true,
          llm: { baseUrl: null, model: null, hasKey: false, maskedKey: null, provider: null },
          identity: {},
          soul: { override: null },
          updateServerUrl: null,
        }
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

/** A mock invoke whose frondose_get_settings returns the given (populated) identity. */
function mockInvokeWithIdentity(identity: Record<string, unknown>) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoke = async (cmd: string, _args?: Record<string, unknown>) => {
    calls.push({ cmd, args: _args });
    return cmd === "frondose_get_settings"
      ? {
          ok: true,
          llm: { baseUrl: null, model: null, hasKey: false, maskedKey: null, provider: null },
          identity,
          soul: { override: null },
          updateServerUrl: null,
        }
      : { ok: true };
  };
  return { invoke, calls };
}

/** Opens the panel (which calls load()) against a populated identity and returns every field's .value. */
async function fireOpenAndGetFieldValues(els: Els, identity: Record<string, unknown>): Promise<Record<string, string>> {
  assert.ok(createSettingsPanel, "settings.ts must export createSettingsPanel");
  const m = mockInvokeWithIdentity(identity);
  const panel = createSettingsPanel({ invoke: m.invoke, surfaceError: () => {} });
  await panel.open();
  const values: Record<string, string> = {};
  for (const id of Object.keys(els)) values[id] = els[id].value;
  return values;
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

// ─── P-ONBOARD-CONVERSATIONAL-IDENTITY: Settings-form backfill (identity fields the form ──
// previously lacked — operator had to hand-edit config.json for these) ───────────────────

describe("collectPatch() — backfilled identity fields (profileUrl/persona/style/contact) follow the same blank-omit / filled-include contract as the existing fields", () => {
  it("T-Onboard.Patch.1: blank profileUrl/persona/style/contact → patch.identity omits all four keys", async () => {
    const els = installDomStub();
    const patch = await fireSaveAndGetPatch(els);
    const identity = patch.identity as Record<string, unknown>;
    for (const f of ["profileUrl", "persona", "style", "contact"]) {
      assert.ok(!(f in identity), `identity.${f} omitted when blank`);
    }
  });

  it("T-Onboard.Patch.2: filled profileUrl/persona/style/contact are included with their values", async () => {
    const els = installDomStub();
    els["settings-profileurl"].value = "https://www.linkedin.com/in/kyoube/";
    els["settings-persona"].value = "Direct, outcome-focused founder-seller";
    els["settings-style"].value = "Short sentences, no fluff";
    els["settings-contact"].value = "kyoube@example.com";
    const patch = await fireSaveAndGetPatch(els);
    const identity = patch.identity as Record<string, unknown>;
    assert.equal(identity.profileUrl, "https://www.linkedin.com/in/kyoube/");
    assert.equal(identity.persona, "Direct, outcome-focused founder-seller");
    assert.equal(identity.style, "Short sentences, no fluff");
    assert.equal(identity.contact, "kyoube@example.com");
  });
});

describe("collectPatch() — backfilled ICP sub-fields (industry/region/companyNameKeywords)", () => {
  it("T-Onboard.Patch.3: with targetRole filled, industry/region/companyNameKeywords are included alongside it (comma-split, trimmed)", async () => {
    const els = installDomStub();
    els["settings-icp-roles"].value = "VP Sales, Head of Growth";
    els["settings-icp-industry"].value = "SaaS, Fintech";
    els["settings-icp-region"].value = "US, EMEA";
    els["settings-icp-keywords"].value = "payments";
    const patch = await fireSaveAndGetPatch(els);
    const identity = patch.identity as {
      icp?: { targetRole: string[]; industry?: string[]; region?: string[]; companyNameKeywords?: string[] };
    };
    assert.deepEqual(identity.icp?.targetRole, ["VP Sales", "Head of Growth"]);
    assert.deepEqual(identity.icp?.industry, ["SaaS", "Fintech"]);
    assert.deepEqual(identity.icp?.region, ["US", "EMEA"]);
    assert.deepEqual(identity.icp?.companyNameKeywords, ["payments"]);
  });

  it("T-Onboard.Patch.4: with targetRole BLANK, icp is omitted entirely even if industry is filled (icpSchema requires targetRole whenever icp is present — regression pin for the documented constraint)", async () => {
    const els = installDomStub();
    els["settings-icp-industry"].value = "SaaS";
    const patch = await fireSaveAndGetPatch(els);
    const identity = patch.identity as Record<string, unknown>;
    assert.ok(!("icp" in identity), "icp must be omitted entirely when targetRole is blank, even with industry filled");
  });
});

describe("collectPatch() — freeAxes (methodology habits) always included as a complete 4-key object", () => {
  it("T-Onboard.Patch.5: with the axis selects untouched, freeAxes carries the documented defaults (freeAxesSchema requires all 4 keys together — never partial)", async () => {
    const els = installDomStub();
    const patch = await fireSaveAndGetPatch(els);
    const identity = patch.identity as { freeAxes?: Record<string, string> };
    assert.deepEqual(identity.freeAxes, {
      pain_chain_lean: "cause-confirmed-then-up",
      lead_role: "pain-owner first",
      discovery_lean: "ratio-disciplined",
      story_shape: "reference-story led",
    });
  });

  it("T-Onboard.Patch.6: with the axis selects set, freeAxes carries the operator-chosen values", async () => {
    const els = installDomStub();
    els["settings-axis-painchain"].value = "economic-buyer-first";
    els["settings-axis-leadrole"].value = "champion-led";
    els["settings-axis-discovery"].value = "R-lean";
    els["settings-axis-story"].value = "number-anchored opener";
    const patch = await fireSaveAndGetPatch(els);
    const identity = patch.identity as { freeAxes?: Record<string, string> };
    assert.deepEqual(identity.freeAxes, {
      pain_chain_lean: "economic-buyer-first",
      lead_role: "champion-led",
      discovery_lean: "R-lean",
      story_shape: "number-anchored opener",
    });
  });
});

describe("collectPatch() output (expanded fields) passes the serve settingsPatchSchema", () => {
  // Given: every backfilled field filled in (the full new form surface). When: validated via the
  //        real serve-side parseSettingsPatch. Then: ok:true — settingsPatchSchema.identity is
  //        already the full identityPatchSchema (verified at Step 1: src/app/backend/settings.ts
  //        settingsPatchSchema — no server-side widening was needed for this phase).
  it("T-Onboard.Patch.7: a fully-filled expanded patch (all backfilled fields) passes parseSettingsPatch with ok:true", async () => {
    const els = installDomStub();
    els["settings-fullname"].value = "Kyoube Lyu";
    els["settings-profileurl"].value = "https://www.linkedin.com/in/kyoube/";
    els["settings-persona"].value = "Direct, outcome-focused";
    els["settings-style"].value = "Short sentences";
    els["settings-contact"].value = "kyoube@example.com";
    els["settings-icp-roles"].value = "VP Sales";
    els["settings-icp-industry"].value = "SaaS";
    els["settings-icp-region"].value = "US";
    els["settings-icp-keywords"].value = "payments";
    els["settings-axis-painchain"].value = "economic-buyer-first";
    els["settings-axis-leadrole"].value = "champion-led";
    els["settings-axis-discovery"].value = "R-lean";
    els["settings-axis-story"].value = "number-anchored opener";
    const patch = await fireSaveAndGetPatch(els);
    const result = parseSettingsPatch(patch);
    assert.equal(result.ok, true, `expected ok:true; got ${JSON.stringify(!result.ok && result.error)}`);
  });
});

// ─── P-ONBOARD-CONVERSATIONAL-IDENTITY (Step-3 Codex critic round-2 CONCERN): the load() half ──
// of the round trip was untested — mockInvoke() always returned identity:{}, so a populated
// GET response backfilling the new fields into the DOM was never exercised. ────────────────────

describe("load() — a populated GET response backfills every new identity/ICP/axis field into the DOM", () => {
  it("T-Onboard.Load.1: open() against a fully-populated identity (incl. icp sub-fields + freeAxes) writes every new field's .value correctly", async () => {
    const els = installDomStub();
    const identity = {
      fullName: "Kyoube Lyu",
      profileUrl: "https://www.linkedin.com/in/kyoube/",
      persona: "Direct, outcome-focused",
      style: "Short sentences",
      contact: "kyoube@example.com",
      icp: {
        targetRole: ["VP Sales", "Head of Growth"],
        industry: ["SaaS", "Fintech"],
        region: ["US", "EMEA"],
        companyNameKeywords: ["payments"],
      },
      freeAxes: {
        pain_chain_lean: "economic-buyer-first",
        lead_role: "champion-led",
        discovery_lean: "R-lean",
        story_shape: "number-anchored opener",
      },
    };
    const values = await fireOpenAndGetFieldValues(els, identity);
    assert.equal(values["settings-profileurl"], "https://www.linkedin.com/in/kyoube/");
    assert.equal(values["settings-persona"], "Direct, outcome-focused");
    assert.equal(values["settings-style"], "Short sentences");
    assert.equal(values["settings-contact"], "kyoube@example.com");
    assert.equal(values["settings-icp-roles"], "VP Sales, Head of Growth");
    assert.equal(values["settings-icp-industry"], "SaaS, Fintech");
    assert.equal(values["settings-icp-region"], "US, EMEA");
    assert.equal(values["settings-icp-keywords"], "payments");
    assert.equal(values["settings-axis-painchain"], "economic-buyer-first");
    assert.equal(values["settings-axis-leadrole"], "champion-led");
    assert.equal(values["settings-axis-discovery"], "R-lean");
    assert.equal(values["settings-axis-story"], "number-anchored opener");
  });

  it("T-Onboard.Load.2: open() against an identity with NO freeAxes falls back to the documented axis defaults (not blank)", async () => {
    // Given: an identity record with no icp/freeAxes at all (e.g. a brand-new operator who has
    //        only conversed fullName so far). When: open() runs. Then: the 4 axis selects show
    //        the documented defaults, not an empty string (a blank <select> would silently pick
    //        the FIRST <option> in index.html, which is NOT the same as AXIS_DEFAULTS).
    const els = installDomStub();
    const values = await fireOpenAndGetFieldValues(els, { fullName: "Kyoube Lyu" });
    assert.equal(values["settings-axis-painchain"], "cause-confirmed-then-up");
    assert.equal(values["settings-axis-leadrole"], "pain-owner first");
    assert.equal(values["settings-axis-discovery"], "ratio-disciplined");
    assert.equal(values["settings-axis-story"], "reference-story led");
  });
});
