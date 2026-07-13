/**
 * P-FIX-MAC-UPDATER-RELAUNCH Step 2 (scaffold) — T-UI-US.1–7
 *
 * FE mock suite for the new `update-status` Tauri event → Settings status line
 * (plan §3c/§6d). Harness mirrors updater-ui-p58d1.mock.test.ts (DOM stub +
 * injected invoke + gate-on-builder import of the compiled settings.js).
 *
 * FE↔BE contract under test (plan §3c, frozen):
 *   event "update-status", payload { stage: "downloading"|"installing"|"relaunching"|"error",
 *   version?, message? }; stable busy-rejection string "already_updating".
 *
 * Gate coverage:
 *   MR-4 ↦ T-UI-US.1 (one listener at construction, none per open()),
 *          T-UI-US.3 (invoke catch never erases an event error),
 *          T-UI-US.6 (no listen dep → safe construction; existing suites unchanged),
 *          T-UI-US.7 (malformed payloads ignored)
 *   MR-3 ↦ T-UI-US.4 (busy stages ignore repeat clicks), T-UI-US.5 (already_updating mapped, no surfaceError)
 *   stage rendering ↦ T-UI-US.2
 *
 * PRE-IMPL RED STATE: SettingsDeps has no `listen`; no update-status handler exists —
 * the fake listen is never called, so T-UI-US.1/2/3/4/5 fail loudly. T-UI-US.6 is an
 * already-green back-compat regression pin (declared in the test contract, T-Updater
 * precedent). T-UI-US.7 red (handler absent → no registration to feed payloads to).
 *
 * Run:
 *   node --import tsx --test --test-force-exit tests/tauri/update-status-ui.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_TS_SRC = readFileSync(join(REPO, "src", "tauri", "ui", "app.ts"), "utf-8");

// ── Gate-on-builder import of the compiled module (built by npm run build:tauri-ui) ──
// biome-ignore lint/suspicious/noExplicitAny: gate-on-builder dynamic import
let createSettingsPanel: ((deps: any) => { open(): Promise<void>; close(): void }) | undefined;
before(async () => {
  try {
    createSettingsPanel = (await import("../../src/tauri/ui/settings.js")).createSettingsPanel;
  } catch {
    // not built yet — gates fail with a clear message
  }
});

// ── DOM stub (same shape as updater-ui-p58d1) ─────────────────────────────────────────

interface FakeEl {
  id: string;
  value: string;
  placeholder: string;
  textContent: string | null;
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
  "settings-brave-key",
  "settings-fullname",
  "settings-company",
  "settings-role",
  "settings-headline",
  "settings-icp-roles",
  "settings-soul",
  "settings-language",
  "settings-update-url",
  "settings-check-update",
  "settings-update-status",
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
    };
    (els[id] as unknown as { addEventListener: (ev: string, fn: () => void) => void }).addEventListener = (ev, fn) => {
      els[id].listeners[ev] = fn;
    };
  }
  (globalThis as unknown as { document: unknown }).document = {
    getElementById: (id: string) => els[id] ?? null,
  };
  return els;
}

/** Fake injected listen: records registrations, exposes emit() to simulate BE events. */
function makeFakeListen() {
  const registrations: Array<{ event: string; handler: (e: { payload: unknown }) => void }> = [];
  const listen = (event: string, handler: (e: { payload: unknown }) => void): Promise<() => void> => {
    registrations.push({ event, handler });
    return Promise.resolve(() => {});
  };
  const emit = (event: string, payload: unknown): void => {
    for (const r of registrations) if (r.event === event) r.handler({ payload });
  };
  return { listen, emit, registrations };
}

function mockInvoke(
  getResp: Record<string, unknown>,
  opts?: { rejectCheckUpdateWith?: string; checkUpdateNeverResolves?: boolean; deferCheckUpdate?: boolean },
) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  // deferCheckUpdate: the test controls WHEN the invoke settles (critic r2: causally
  // controlled event-before-rejection ordering for T-UI-US.3).
  let deferredReject: ((e: Error) => void) | undefined;
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "frondose_get_settings") return getResp;
    if (cmd === "frondose_check_update") {
      if (opts?.checkUpdateNeverResolves) return new Promise(() => {}); // process-exits mid-invoke shape
      if (opts?.deferCheckUpdate)
        return new Promise((_res, rej) => {
          deferredReject = rej as (e: Error) => void;
        });
      if (opts?.rejectCheckUpdateWith) throw new Error(opts.rejectCheckUpdateWith);
    }
    return { ok: true };
  };
  const rejectDeferred = (msg: string): void => {
    if (!deferredReject) assert.fail("no deferred frondose_check_update invoke in flight to reject");
    deferredReject(new Error(msg));
  };
  return { invoke, calls, rejectDeferred };
}

const SAMPLE_GET = {
  ok: true,
  llm: { baseUrl: "https://x/v1", model: "m", hasKey: true, maskedKey: "sk-***1", provider: "deepseek" },
  identity: { fullName: "A" },
  soul: { override: null },
  updateServerUrl: "http://192.0.2.105:4875",
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// Expected en strings (node has no zh navigator; detectLocale → en). Pins the new i18n keys' content.
const EXPECT_DOWNLOADING = "Downloading update 0.5.7…";
const EXPECT_INSTALLING = "Installing update…";
const EXPECT_RELAUNCHING = "Update installed — relaunching…";
const EXPECT_ERROR = "Update failed: boom";

// ─── T-UI-US.1 ──────────────────────────────────────────────────────────────

describe("update-status listener — registered exactly once at construction (MR-4)", () => {
  // Given: createSettingsPanel with an injected fake listen
  // When:  the panel is constructed and then open()ed twice
  // Then:  exactly ONE "update-status" registration exists (repeat opens never stack listeners)
  it("T-UI-US.1: one update-status registration across construction + two open() calls", async () => {
    if (!createSettingsPanel) assert.fail("createSettingsPanel not loaded — run npm run build:tauri-ui first");
    installDomStub();
    const fake = makeFakeListen();
    const m = mockInvoke(SAMPLE_GET);
    const panel = createSettingsPanel({ invoke: m.invoke, surfaceError: () => {}, listen: fake.listen });
    await tick();
    await panel.open();
    await panel.open();
    const updateRegs = fake.registrations.filter((r) => r.event === "update-status");
    assert.equal(updateRegs.length, 1, `expected exactly 1 update-status registration; got ${updateRegs.length}`);
  });
});

// ─── T-UI-US.2 ──────────────────────────────────────────────────────────────

describe("update-status stages — each stage drives the localized status line (plan §3c)", () => {
  // Given: a constructed panel with fake listen
  // When:  each stage payload is emitted
  // Then:  #settings-update-status.textContent shows the localized text (downloading carries
  //        {version}; error carries {msg})
  it("T-UI-US.2: downloading/installing/relaunching/error payloads render their i18n texts", async () => {
    if (!createSettingsPanel) assert.fail("createSettingsPanel not loaded — run npm run build:tauri-ui first");
    const els = installDomStub();
    const fake = makeFakeListen();
    const m = mockInvoke(SAMPLE_GET);
    createSettingsPanel({ invoke: m.invoke, surfaceError: () => {}, listen: fake.listen });
    await tick();

    fake.emit("update-status", { stage: "downloading", version: "0.5.7" });
    assert.equal(els["settings-update-status"].textContent, EXPECT_DOWNLOADING);

    fake.emit("update-status", { stage: "installing" });
    assert.equal(els["settings-update-status"].textContent, EXPECT_INSTALLING);

    fake.emit("update-status", { stage: "relaunching" });
    assert.equal(els["settings-update-status"].textContent, EXPECT_RELAUNCHING);

    fake.emit("update-status", { stage: "error", message: "boom" });
    assert.equal(els["settings-update-status"].textContent, EXPECT_ERROR);
  });
});

// ─── T-UI-US.3 ──────────────────────────────────────────────────────────────

describe("invoke rejection never erases a backend error event (MR-4 non-erasure)", () => {
  // Given: checkUpdate whose invoke is DEFERRED (the test owns settlement); a BE "error" event
  //        is emitted FIRST, then the test rejects the still-pending invoke (critic r2:
  //        causally-controlled event-before-rejection ordering — not microtask luck)
  // When:  the catch branch runs after the error event has already rendered
  // Then:  the event's error text SURVIVES on the status line; surfaceError is still called
  it("T-UI-US.3: error event first, THEN invoke rejection — catch must not clear the status text", async () => {
    if (!createSettingsPanel) assert.fail("createSettingsPanel not loaded — run npm run build:tauri-ui first");
    const els = installDomStub();
    const fake = makeFakeListen();
    const m = mockInvoke(SAMPLE_GET, { deferCheckUpdate: true });
    let surfaced = 0;
    createSettingsPanel({
      invoke: m.invoke,
      surfaceError: () => {
        surfaced += 1;
      },
      listen: fake.listen,
    });
    await tick();
    els["settings-check-update"].listeners.click();
    await tick(); // invoke now pending (deferred)
    // Step 1 (controlled): BE error event arrives and renders while the invoke is pending.
    fake.emit("update-status", { stage: "error", message: "boom" });
    assert.equal(
      els["settings-update-status"].textContent,
      EXPECT_ERROR,
      "precondition: error event rendered before rejection",
    );
    // Step 2 (controlled): only NOW does the invoke reject.
    m.rejectDeferred("update download failed: net::down");
    await tick();
    assert.equal(
      els["settings-update-status"].textContent,
      EXPECT_ERROR,
      "the event-driven error text must survive the invoke catch (MR-4: no '' clobber)",
    );
    assert.equal(surfaced, 1, "surfaceError must still fire for the banner");
  });
});

// ─── T-UI-US.4 ──────────────────────────────────────────────────────────────

describe("busy stages ignore repeat clicks (MR-3 FE half)", () => {
  // Given: an update in flight (stage=downloading; the first invoke never resolves — process may exit)
  // When:  the check-update button is clicked again
  // Then:  NO second frondose_check_update invoke is issued
  it("T-UI-US.4: while stage=downloading, a second click issues no second frondose_check_update", async () => {
    if (!createSettingsPanel) assert.fail("createSettingsPanel not loaded — run npm run build:tauri-ui first");
    const els = installDomStub();
    const fake = makeFakeListen();
    const m = mockInvoke(SAMPLE_GET, { checkUpdateNeverResolves: true });
    createSettingsPanel({ invoke: m.invoke, surfaceError: () => {}, listen: fake.listen });
    await tick();
    els["settings-check-update"].listeners.click();
    await tick();
    fake.emit("update-status", { stage: "downloading", version: "0.5.7" });
    els["settings-check-update"].listeners.click();
    await tick();
    const checkCalls = m.calls.filter((c) => c.cmd === "frondose_check_update");
    assert.equal(checkCalls.length, 1, `busy repeat click must be ignored; got ${checkCalls.length} invokes`);
  });
});

// ─── T-UI-US.5 ──────────────────────────────────────────────────────────────

describe("already_updating rejection maps to the updating text, not an error banner (MR-3)", () => {
  // Given: the BE guard rejects the manual invoke with the stable "already_updating" string
  // When:  checkUpdate's catch runs
  // Then:  status shows the updating text and surfaceError is NOT called
  it("T-UI-US.5: 'already_updating' rejection → updating text, no surfaceError", async () => {
    if (!createSettingsPanel) assert.fail("createSettingsPanel not loaded — run npm run build:tauri-ui first");
    const els = installDomStub();
    const fake = makeFakeListen();
    const m = mockInvoke(SAMPLE_GET, { rejectCheckUpdateWith: "already_updating" });
    let surfaced = 0;
    createSettingsPanel({
      invoke: m.invoke,
      surfaceError: () => {
        surfaced += 1;
      },
      listen: fake.listen,
    });
    await tick();
    els["settings-check-update"].listeners.click();
    await tick();
    assert.equal(els["settings-update-status"].textContent, "Updating…", "busy rejection shows settings.updating");
    assert.equal(surfaced, 0, "already_updating is an expected busy state — not an error banner");
  });
});

// ─── T-UI-US.6 ──────────────────────────────────────────────────────────────

describe("back-compat — construction without listen stays safe (MR-4; already-green pin)", () => {
  // Given: the pre-existing dep shape {invoke, surfaceError} (every existing settings suite)
  // When:  the panel is constructed and checkUpdate clicked
  // Then:  nothing throws; the classic checking→upToDate flow still works
  it("T-UI-US.6: no listen dep → no throw; checkUpdate still reaches upToDate", async () => {
    if (!createSettingsPanel) assert.fail("createSettingsPanel not loaded — run npm run build:tauri-ui first");
    const els = installDomStub();
    const m = mockInvoke(SAMPLE_GET);
    const panel = createSettingsPanel({ invoke: m.invoke, surfaceError: () => {} });
    await panel.open();
    els["settings-check-update"].listeners.click();
    await tick();
    assert.equal(els["settings-update-status"].textContent, "Up to date");
  });
});

// ─── T-UI-US.7 ──────────────────────────────────────────────────────────────

describe("malformed update-status payloads are ignored (MR-4 payload validation)", () => {
  // Given: a constructed panel with fake listen and a known-good status text
  // When:  null / {} / unknown-stage payloads are emitted
  // Then:  no throw; the status text is unchanged
  it("T-UI-US.7: null, stageless, and bogus-stage payloads neither throw nor change the line", async () => {
    if (!createSettingsPanel) assert.fail("createSettingsPanel not loaded — run npm run build:tauri-ui first");
    const els = installDomStub();
    const fake = makeFakeListen();
    const m = mockInvoke(SAMPLE_GET);
    createSettingsPanel({ invoke: m.invoke, surfaceError: () => {}, listen: fake.listen });
    await tick();
    fake.emit("update-status", { stage: "installing" });
    assert.equal(els["settings-update-status"].textContent, EXPECT_INSTALLING, "precondition: a valid stage rendered");
    fake.emit("update-status", null);
    fake.emit("update-status", {});
    fake.emit("update-status", { stage: "bogus" });
    fake.emit("update-status", 42);
    assert.equal(
      els["settings-update-status"].textContent,
      EXPECT_INSTALLING,
      "malformed payloads must be ignored (no clobber, no crash)",
    );
  });
});

// ─── T-UI-US.8 ──────────────────────────────────────────────────────────────

describe("app.ts wires the injected listen for real (critic r2; T-UI.9b structural precedent)", () => {
  // Given: the app.ts source
  // When:  the createSettingsPanel({...}) call region is inspected
  // Then:  it passes a `listen:` closure that guards on windowRef.__TAURI__ and delegates to
  //        __TAURI__.event.listen — so the mock-proven behavior is actually reachable in the app.
  it("T-UI-US.8: createSettingsPanel call passes a __TAURI__-guarded listen closure [structural]", () => {
    const iCall = APP_TS_SRC.indexOf("createSettingsPanel({");
    assert.ok(iCall >= 0, "app.ts must construct the settings panel via createSettingsPanel({...})");
    const region = APP_TS_SRC.slice(iCall, iCall + 600);
    assert.ok(
      region.includes("listen:"),
      "the createSettingsPanel deps must include a listen: closure (MR-4 injected dep)",
    );
    assert.ok(
      region.includes("windowRef.__TAURI__") || region.includes("window.__TAURI__"),
      "the listen closure must guard on the __TAURI__ global (non-Tauri construction stays safe)",
    );
    assert.ok(region.includes(".event.listen"), "the listen closure must delegate to __TAURI__.event.listen");
  });
});
