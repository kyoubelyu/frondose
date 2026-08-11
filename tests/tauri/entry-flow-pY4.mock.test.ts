/**
 * P-Y4 Step 4a — T-Entry.1..4 + T-Rehome.4 — SCAFFOLD (assertion bodies = TODO; intentionally RED).
 *
 * Two test layers for the conversation-first entry redesign (no "Start LinkedIn" gate):
 *
 *  (A) DOM-harness (T-Entry.1, T-Entry.4) — loads the REAL src/tauri/ui/index.html + compiled app.js in a
 *      headless Chrome with a MOCKED window.__TAURI__.invoke spy (mirrors button-click-pY2.1.test.ts). It
 *      drives boot() with a chosen frondose_identity response and asserts the resulting appState / DOM visibility.
 *      These EXISTING surfaces compile + run NOW; they FAIL at Step 4a because the current app.js still lands
 *      identity-OK in "chrome-needed" (composer hidden) — they go GREEN after builder's 4b lands identity-OK
 *      directly in "idle".
 *
 *  (B) source-structural greps (T-Entry.2, T-Entry.3, T-Rehome.4) — read app.ts / index.html / routes.ts /
 *      serve.ts / session.ts as strings and assert the removed/added structural shape (no "chrome-needed",
 *      no #start, identity-gate present, ensureOverlaySubscription exported + wired). Compile + run NOW; FAIL
 *      now (the symbols are still present / absent); GREEN after 4b.
 *
 * Covers plan §6.1 (T-Entry.1, T-Entry.4) + §6.2 (T-Entry.2, T-Entry.3, T-Rehome.4).
 * Gate/ask coverage: ask a/b (i) — T-Entry.1, T-Entry.2; ask c (iii) — T-Entry.3; OQ-Y4.1 (vi) — T-Entry.4;
 *   ask d (route preserved + helper extracted) — T-Rehome.4.
 *
 * Run (mock): node --import tsx --test --test-force-exit --test-timeout=120000 tests/tauri/entry-flow-pY4.mock.test.ts
 */

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import CDP from "chrome-remote-interface";
import { type BrowserOwner, openOwnedChrome, runIndependentCleanups } from "../_helpers/ownedBrowser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const UI_DIR = join(REPO, "src", "tauri", "ui");
const APP_TS = readFileSync(join(UI_DIR, "app.ts"), "utf-8");
const INDEX_HTML = readFileSync(join(UI_DIR, "index.html"), "utf-8");
const ROUTES_TS = readFileSync(join(REPO, "src", "app", "backend", "routes.ts"), "utf-8");
const SERVE_TS = readFileSync(join(REPO, "src", "app", "backend", "index.ts"), "utf-8");
const SESSION_TS = readFileSync(join(REPO, "src", "linkedin", "session.ts"), "utf-8");
const PORT = 8782;

// Spy stub injected BEFORE app.js runs. frondose_identity returns `window.__frondose_identity_resp` when set by a
// per-boot init script (see bootWith), else a default identity-OK. Records every invoke so a test can assert
// frondose_chrome_ensure was NEVER called on the conversation-first boot path.
const SPY_STUB = `
  window.__mai_invokes = [];
  window.__mai_eventCb = null;
  window.__TAURI__ = {
    core: { invoke: (cmd, args) => {
      window.__mai_invokes.push({ cmd, args: args ?? null });
      let res = { ok: true };
      if (cmd === "frondose_identity") res = window.__frondose_identity_resp ?? { ok: true, fullName: "Test Operator" };
      else if (cmd === "frondose_set_cron_mode") res = { ok: true, cronEnabled: !!(args && args.enabled) };
      else if (cmd === "frondose_set_passive_mode") res = { ok: true, passiveEnabled: !!(args && args.enabled) };
      else if (cmd === "frondose_chrome_ensure") res = { ok: true, chromePort: 9222, overlayInstalled: true };
      else if (cmd === "frondose_agent_turn") res = { ok: true, turnId: "t1" };
      return Promise.resolve(res);
    }},
    event: { listen: (name, cb) => { if (name === "overlay-event") window.__mai_eventCb = cb; return Promise.resolve(() => {}); } },
  };
`;

// biome-ignore lint/suspicious/noExplicitAny: CDP client + chrome handle are untyped (no @types).
let browserOwner: BrowserOwner<any> | undefined;
// biome-ignore lint/suspicious/noExplicitAny: CDP client is untyped.
let client: any;
let httpUi: ChildProcess;
let respScriptId: string | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// biome-ignore lint/suspicious/noExplicitAny: returnByValue payloads are dynamic.
async function evalIn(expr: string): Promise<any> {
  const r = await client.Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
  return r.result.value;
}

// Boot the real app.js with a chosen frondose_identity response, fresh page each call.
// (Used at Step 5 to fill T-Entry.1 / T-Entry.4 assertion bodies.)
async function bootWith(identityResp: unknown): Promise<void> {
  if (respScriptId) await client.Page.removeScriptToEvaluateOnNewDocument({ identifier: respScriptId });
  const added = await client.Page.addScriptToEvaluateOnNewDocument({
    source: `window.__frondose_identity_resp = ${JSON.stringify(identityResp)};`,
  });
  respScriptId = added.identifier;
  await client.Page.navigate({ url: `http://127.0.0.1:${PORT}/index.html` });
  await client.Page.loadEventFired();
  await sleep(700); // boot(): event.listen + loadIdentity + applyMode("manual")
}

before(async () => {
  assert.ok(existsSync(join(UI_DIR, "app.js")), "app.js must be built (npm run build:tauri-ui)");
  httpUi = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
    cwd: UI_DIR,
    stdio: "ignore",
  });
  await sleep(800);
  try {
    browserOwner = await openOwnedChrome({
      chromeOptions: { chromeFlags: ["--headless=new", "--disable-gpu"] },
      connect: (browser) => CDP({ port: browser.handle.port }),
      setup: async (connected) => {
        await connected.Page.enable();
        await connected.Runtime.enable();
        await connected.Page.addScriptToEvaluateOnNewDocument({ source: SPY_STUB });
      },
      close: (connected) => connected.close(),
    });
    client = browserOwner.client;
  } catch (error) {
    await runIndependentCleanups("entry-flow setup cleanup failed", [() => httpUi?.kill("SIGKILL")], error);
  }
});

after(async () => {
  await runIndependentCleanups("entry-flow suite cleanup failed", [
    () => browserOwner?.finish(),
    () => httpUi?.kill("SIGKILL"),
  ]);
});

// ─── (A) DOM-harness: boot state machine (§6.1) ──────────────────────────────

describe("entry-flow — boot state machine (conversation-first, no Start gate)", () => {
  it("T-Entry.1: when frondose_identity is OK, boot() lands appState='idle' with composer enabled and frondose_chrome_ensure NEVER invoked", async () => {
    // Given: a DOM harness whose frondose_identity returns { ok:true, fullName:"X" }
    // When:  boot() runs (loadIdentity → applyMode("manual"))
    // Then:  appState==="idle" (NOT "chrome-needed"), #composer/#command-input/#send-btn are visible+enabled,
    //        and the recorded invokes contain NO "frondose_chrome_ensure" (Chrome is agent-driven, not boot-driven)
    await bootWith({ ok: true, fullName: "Test Operator X" });
    const snap = await evalIn(`(() => {
      const g = (id) => document.getElementById(id);
      return {
        cmdHidden: g('command-input').classList.contains('hidden'),
        cmdDisabled: !!g('command-input').disabled,
        sendHidden: g('send-btn').classList.contains('hidden'),
        sendDisabled: !!g('send-btn').disabled,
        composerHidden: g('composer').classList.contains('hidden'),
        gateHidden: g('identity-gate').classList.contains('hidden'),
        name: g('name').textContent,
        invokes: (window.__mai_invokes || []).map((i) => i.cmd),
      };
    })()`);
    // composer surface visible + enabled in idle
    assert.equal(snap.composerHidden, false, "composer must be visible in idle");
    assert.equal(snap.cmdHidden, false, "command-input must be visible in idle");
    assert.equal(snap.cmdDisabled, false, "command-input must be ENABLED in idle");
    assert.equal(snap.sendHidden, false, "send-btn must be visible in idle");
    assert.equal(snap.sendDisabled, false, "send-btn must be ENABLED in idle");
    // identity-gate hidden once identity loaded OK
    assert.equal(snap.gateHidden, true, "identity-gate must be hidden in idle");
    assert.equal(snap.name, "Test Operator X", "#name shows the loaded fullName");
    // Chrome is AGENT-driven, never boot-driven: no frondose_chrome_ensure on the conversation-first path
    assert.ok(snap.invokes.includes("frondose_identity"), "frondose_identity must be invoked at boot");
    assert.ok(
      !snap.invokes.includes("frondose_chrome_ensure"),
      `frondose_chrome_ensure must NEVER be invoked at boot (agent-driven Chrome); invokes=${JSON.stringify(snap.invokes)}`,
    );
  });

  it("T-Onboard.FE.1 (was T-Entry.4): when frondose_identity fails, boot() lands appState='identity-missing' with the composer VISIBLE+ENABLED (conversational first-contact) and #identity-gate showing the reason", async () => {
    // Given: a DOM harness whose frondose_identity returns { ok:false, reason:"identity not set yet — say hello to get started (or set it in Frondose → Settings)" }
    // When:  boot() runs
    // Then:  appState==="identity-missing", #composer/#command-input/#send-btn are VISIBLE + ENABLED
    //        (P-ONBOARD-CONVERSATIONAL-IDENTITY: there must be something to talk INTO on first
    //        contact — this deliberately supersedes the pre-phase "composer hidden" behavior),
    //        #identity-gate is still visible (not .hidden), and #name textContent === the reason string
    // P-APP-11 b1 PINNED: health.ts:12 = "identity not set yet — say hello to get started (or set it in Frondose → Settings)"
    const reason = "identity not set yet — say hello to get started (or set it in Frondose → Settings)";
    await bootWith({ ok: false, reason });
    const snap = await evalIn(`(() => {
      const g = (id) => document.getElementById(id);
      return {
        cmdHidden: g('command-input').classList.contains('hidden'),
        cmdDisabled: !!g('command-input').disabled,
        sendHidden: g('send-btn').classList.contains('hidden'),
        sendDisabled: !!g('send-btn').disabled,
        composerHidden: g('composer').classList.contains('hidden'),
        gateHidden: g('identity-gate').classList.contains('hidden'),
        name: g('name').textContent,
      };
    })()`);
    // identity-gate stays visible (still informational); composer surface now VISIBLE + ENABLED
    // so the operator has something to talk into on first contact.
    assert.equal(snap.gateHidden, false, "identity-gate must be VISIBLE when identity missing");
    assert.equal(
      snap.composerHidden,
      false,
      "composer must be VISIBLE when identity missing (first-contact conversation)",
    );
    assert.equal(snap.cmdHidden, false, "command-input must be VISIBLE when identity missing");
    assert.equal(snap.cmdDisabled, false, "command-input must be ENABLED when identity missing");
    assert.equal(snap.sendHidden, false, "send-btn must be VISIBLE when identity missing");
    assert.equal(snap.sendDisabled, false, "send-btn must be ENABLED when identity missing");
    assert.equal(snap.name, reason, "#name must show the identity-missing reason");
  });

  it("T-Onboard.FE.2: when appState='identity-missing' and the operator types a prompt and clicks Send, frondose_agent_turn IS invoked (first-contact send is not blocked)", async () => {
    // Given: a DOM harness whose frondose_identity fails (appState lands 'identity-missing')
    // When:  the operator types into #command-input and clicks #send-btn
    // Then:  frondose_agent_turn appears in the recorded invokes (sendCommand()'s guard must
    //        permit dispatch from 'identity-missing', not only 'idle')
    await bootWith({
      ok: false,
      reason: "identity not set yet — say hello to get started (or set it in Frondose → Settings)",
    });
    await evalIn(`(() => {
      const cmd = document.getElementById('command-input');
      cmd.value = 'Hi Frondose';
      cmd.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('send-btn').click();
      return true;
    })()`);
    await sleep(300);
    const invokes = await evalIn(`(window.__mai_invokes || []).map((i) => i.cmd)`);
    assert.ok(
      invokes.includes("frondose_agent_turn"),
      `frondose_agent_turn must be invoked from identity-missing state; invokes=${JSON.stringify(invokes)}`,
    );
  });
});

// ─── (B) source-structural greps (§6.2) ──────────────────────────────────────

describe("entry-flow — app.ts state machine collapse (§6.2)", () => {
  it("T-Entry.2: app.ts has NO 'chrome-needed' token; AppState union is the 4-state set; loadIdentity success → transition('idle')", () => {
    // Given: src/tauri/ui/app.ts as a string
    // When:  grepped for the removed "chrome-needed" arm + the collapsed AppState union + the success transition
    // Then:  no "chrome-needed" anywhere; AppState === "identity-missing"|"idle"|"running"|"error";
    //        loadIdentity's success path calls transition("idle")
    assert.ok(!APP_TS.includes("chrome-needed"), 'app.ts must NOT contain the removed "chrome-needed" state');
    assert.ok(
      APP_TS.includes('type AppState = "identity-missing" | "idle" | "running" | "error"'),
      "AppState union must be the collapsed 4-state set (no chrome-needed)",
    );
    // initial state is identity-missing (was chrome-needed)
    assert.ok(
      APP_TS.includes('let appState: AppState = "identity-missing"'),
      "initial appState must be identity-missing",
    );
    // loadIdentity success path transitions straight to idle (Chrome no longer gated on a boot step)
    assert.ok(APP_TS.includes('transition("idle")'), 'loadIdentity success path must call transition("idle")');
  });

  it("T-Entry.3: index.html has no #start / #start-card / welcome bubble, has the composer + identity-gate + Listening status; app.ts has no startLinkedIn / startEl / frondose_chrome_ensure / Chrome* types", () => {
    // Given: index.html + app.ts as strings
    // When:  grepped for removed start/welcome surfaces and retained composer/identity-gate surfaces
    // Then:  index.html: NO id="start", NO id="start-card", NO "Hi — I'm Frondose"; HAS id="composer",
    //        id="command-input", id="send-btn", id="identity-gate", id="name", id="status" (Listening).
    //        app.ts: NO startLinkedIn, NO startEl, NO frondose_chrome_ensure, NO ChromeResp/ChromeOk/ChromeErr.
    // index.html: removed start gate + welcome bubble (note: class="start-card" is RETAINED on #identity-gate,
    // so we assert on the id= forms, not the class).
    assert.ok(!INDEX_HTML.includes('id="start"'), 'index.html must NOT contain the removed Start button id="start"');
    assert.ok(!INDEX_HTML.includes('id="start-card"'), 'index.html must NOT contain the removed id="start-card"');
    assert.ok(!INDEX_HTML.includes("Hi — I'm Frondose"), "index.html must NOT contain the removed welcome bubble");
    for (const id of ["composer", "command-input", "send-btn", "identity-gate", "name", "status"]) {
      assert.ok(INDEX_HTML.includes(`id="${id}"`), `index.html must retain id="${id}"`);
    }
    assert.ok(INDEX_HTML.includes(">Listening<"), 'index.html status line must show "Listening"');
    // app.ts: removed the Start machinery + Chrome-ensure types entirely
    for (const sym of ["startLinkedIn", "startEl", "frondose_chrome_ensure", "ChromeResp", "ChromeOk", "ChromeErr"]) {
      assert.ok(!APP_TS.includes(sym), `app.ts must NOT contain removed symbol ${sym}`);
    }
  });
});

describe("entry-flow — overlay re-home structural wiring (§6.2)", () => {
  it("T-Rehome.4: routes.ts re-exports ensureOverlaySubscription from barrel; routes/cdp.ts defines + calls it; serve.ts passes onClientBooted; session.ts's CreateLinkedinSessionOpts declares onClientBooted?", () => {
    // Given: routes.ts (barrel) + routes/cdp.ts + serve.ts + session.ts as strings (post-P-72-slice-6 layout:
    //        definition + /chrome/ensure call live in routes/cdp.ts; routes.ts re-exports via barrel)
    // When:  grepped for the barrel re-export in routes.ts, the definition + call in cdp.ts, the factory wiring
    //        in serve.ts, and the opt declaration in session.ts
    // Then:  routes.ts re-exports ensureOverlaySubscription from "./routes/cdp.js";
    //        routes/cdp.ts defines "export async function ensureOverlaySubscription" AND calls it from the
    //        /chrome/ensure handler (no inline subscribe/attach block left behind);
    //        serve.ts passes onClientBooted: to createLinkedinSession delegating to ensureOverlaySubscription;
    //        session.ts's CreateLinkedinSessionOpts declares onClientBooted?
    const ROUTES_CDP_TS = readFileSync(join(REPO, "src", "app", "backend", "routes", "cdp.ts"), "utf-8");
    // barrel re-exports the helper (semantic contract: symbol is publicly accessible via routes.ts)
    assert.ok(
      ROUTES_TS.includes("ensureOverlaySubscription") && ROUTES_TS.includes("routes/cdp"),
      'routes.ts (barrel) must re-export ensureOverlaySubscription from "./routes/cdp.js"',
    );
    // definition lives in routes/cdp.ts
    assert.ok(
      ROUTES_CDP_TS.includes("export async function ensureOverlaySubscription"),
      "routes/cdp.ts must define export async function ensureOverlaySubscription",
    );
    // /chrome/ensure handler in cdp.ts calls the shared helper (no inline subscribe/attach block left behind)
    assert.ok(
      ROUTES_CDP_TS.includes("await ensureOverlaySubscription("),
      "routes/cdp.ts handleChromeEnsure must call await ensureOverlaySubscription(...)",
    );
    // definition PLUS the call = ≥2 refs in cdp.ts
    const ensureRefsInCdp = ROUTES_CDP_TS.split("ensureOverlaySubscription").length - 1;
    assert.ok(
      ensureRefsInCdp >= 2,
      `routes/cdp.ts must both define AND call ensureOverlaySubscription (found ${ensureRefsInCdp} refs; expected ≥2)`,
    );
    // serve.ts wires the lazy-boot hook to the same helper
    assert.ok(SERVE_TS.includes("createLinkedinSession"), "serve.ts must call createLinkedinSession");
    assert.ok(SERVE_TS.includes("onClientBooted:"), "serve.ts must pass onClientBooted to createLinkedinSession");
    assert.ok(
      SERVE_TS.includes("ensureOverlaySubscription"),
      "serve.ts onClientBooted must delegate to ensureOverlaySubscription",
    );
    // session.ts declares the opt
    assert.ok(SESSION_TS.includes("CreateLinkedinSessionOpts"), "session.ts must define CreateLinkedinSessionOpts");
    assert.ok(SESSION_TS.includes("onClientBooted?"), "CreateLinkedinSessionOpts must declare onClientBooted?");
  });
});

// Step 4a: source strings + harness helpers are consumed at Step 5 when assertion bodies are filled.
void [APP_TS, INDEX_HTML, ROUTES_TS, SERVE_TS, SESSION_TS, evalIn, bootWith];
