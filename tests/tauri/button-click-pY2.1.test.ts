/**
 * P-Y2.1 functional-hardening — T-Click.* — REAL button click-through (mocked transport).
 *
 * Loads the REAL src/tauri/ui/index.html + compiled app.js in a headless Chrome (jsdom is NOT a project
 * dep; chrome-launcher + chrome-remote-interface ARE) with a MOCKED window.__TAURI__.invoke spy. It then
 * simulates an actual click on each wired button and asserts the correct invoke(cmd, args) fired. This is
 * the layer the source-grep "button" tests never had ("mock没有button test的吗"): it catches
 *   (1) an UNWIRED listener (click → no invoke), and
 *   (2) a BOOT-THROW (if app.js boot() throws, no listeners attach → every click is a no-op → tests fail).
 * It MOCKS the transport, so it does NOT catch sidecar/CDP runtime failures — that is T-Integ.* (2b).
 *
 * Gate: G-PY2.1.9 (button behavior — every wired button fires its mapped invoke).
 *
 * P-Y4 removed the "Start LinkedIn" gate (no #start button, no mai_chrome_ensure boot path) — identity-OK
 * boot now lands directly in 'idle'. gotoIdle() reaches 'idle' via boot, NOT a Start click. The real turn
 * execution of Send (needs LLM + live LinkedIn) stays OPERATOR-LIVE: Send's *listener wiring* is asserted
 * here against the mock spy (harmless), but the real turn is never run.
 *
 * Run: node --import tsx --test --test-force-exit --test-timeout=120000 tests/tauri/button-click-pY2.1.test.ts
 */

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { launch } from "chrome-launcher";
import CDP from "chrome-remote-interface";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "..", "src", "tauri", "ui");
const PORT = 8781;

// Spy stub injected BEFORE app.js runs: records every invoke + captures the SSE callback.
const SPY_STUB = `
  window.__mai_invokes = [];
  window.__mai_eventCb = null;
  window.__TAURI__ = {
    core: { invoke: (cmd, args) => {
      window.__mai_invokes.push({ cmd, args: args ?? null });
      let res = { ok: true };
      if (cmd === "mai_identity") res = { ok: true, fullName: "Test Operator" };
      else if (cmd === "mai_set_cron_mode") res = { ok: true, cronEnabled: !!(args && args.enabled) };
      else if (cmd === "mai_set_passive_mode") res = { ok: true, passiveEnabled: !!(args && args.enabled) };
      else if (cmd === "mai_chrome_ensure") res = { ok: true, connected: true };
      else if (cmd === "mai_agent_turn") res = { ok: true, turnId: "t1" };
      else if (cmd === "mai_agent_retry") res = { ok: true, turnId: "t2" };
      return Promise.resolve(res);
    }},
    event: { listen: (name, cb) => { if (name === "overlay-event") window.__mai_eventCb = cb; return Promise.resolve(() => {}); } },
  };
`;

// biome-ignore lint/suspicious/noExplicitAny: CDP client + chrome handle are untyped (no @types).
let chrome: any;
// biome-ignore lint/suspicious/noExplicitAny: CDP client is untyped.
let client: any;
let httpUi: ChildProcess;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// biome-ignore lint/suspicious/noExplicitAny: returnByValue payloads are dynamic.
async function evalIn(expr: string): Promise<any> {
  const r = await client.Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
  return r.result.value;
}

async function resetInvokes(): Promise<void> {
  await evalIn("window.__mai_invokes = []; 'ok'");
}
// Returns the recorded invokes after clicking #id (+ optional pre-click setup expression).
async function clickAndRecord(id: string, setupExpr = ""): Promise<Array<{ cmd: string; args: unknown }>> {
  await resetInvokes();
  if (setupExpr) await evalIn(setupExpr);
  await evalIn(`document.getElementById(${JSON.stringify(id)}).click(); 'ok'`);
  await sleep(180);
  return evalIn("window.__mai_invokes");
}
// Precondition helper: reach appState='idle'. P-Y4 removed the "Start LinkedIn" gate — identity-OK boot now
// lands directly in 'idle' (composer live, no Chrome dependency, no mai_chrome_ensure). So gotoIdle no longer
// clicks #start (it no longer exists); it just waits until the composer input is interactive (idle reached
// via boot → loadIdentity → transition('idle')), so the next Send opens a fresh turn.
async function gotoIdle(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const ready = await evalIn("!document.getElementById('command-input').disabled");
    if (ready) return;
    await sleep(50);
  }
}

before(async () => {
  assert.ok(existsSync(join(UI_DIR, "app.js")), "app.js must be built (npm run build:tauri-ui)");
  httpUi = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
    cwd: UI_DIR,
    stdio: "ignore",
  });
  await sleep(800);
  chrome = await launch({ chromeFlags: ["--headless=new", "--disable-gpu"] });
  client = await CDP({ port: chrome.port });
  await client.Page.enable();
  await client.Runtime.enable();
  await client.Page.addScriptToEvaluateOnNewDocument({ source: SPY_STUB });
  await client.Page.navigate({ url: `http://127.0.0.1:${PORT}/index.html` });
  await client.Page.loadEventFired();
  await sleep(700); // let boot() run: event.listen + loadIdentity + applyMode("manual")
});

after(async () => {
  try {
    await client?.close();
  } catch {}
  try {
    await chrome?.kill();
  } catch {}
  httpUi?.kill();
});

describe("button click-through — boot wiring (G-PY2.1.9)", () => {
  it("T-Click.0: boot() ran without throwing — fired mai_identity + UI-only syncModeUi (NO force-POST cron-mode, P-58a)", async () => {
    // Given: the app booted in headless Chrome with the spy stub
    // When:  reading the invokes recorded during boot()
    // Then:  mai_identity was called (a boot-throw would attach no listeners AND skip it → catches that bug class).
    //        P-58a RECONCILE: boot() now does syncModeUi("manual") (UI-only) instead of applyMode("manual") — it
    //        must NOT force-POST mai_set_cron_mode (that would overwrite serve's PERSISTED mode; the persisted mode
    //        now arrives via the initial cron-mode SSE frame). So boot fires mai_identity but NO mai_set_cron_mode.
    const boot = await evalIn("window.__mai_invokes");
    const cmds = boot.map((i: { cmd: string }) => i.cmd);
    assert.ok(cmds.includes("mai_identity"), "boot must call mai_identity");
    assert.ok(
      !cmds.includes("mai_set_cron_mode"),
      "boot must NOT force-POST mai_set_cron_mode (P-58a: UI-only syncModeUi; persisted mode arrives via SSE)",
    );
  });
});

describe("button click-through — switcher tabs (G-PY2.1.9, G-PY2.1.3)", () => {
  it("T-Click.1: clicking #mode-auto-tab fires mai_set_cron_mode{enabled:true} + mai_set_passive_mode{enabled:false}", async () => {
    // Given: booted app in Manual
    // When:  the Auto switcher tab is clicked
    // Then:  applyMode('auto') fires cron-mode enabled:true (Auto ⇒ cron ON) + passive enabled:false
    const inv = await clickAndRecord("mode-auto-tab");
    const cron = inv.find((i) => i.cmd === "mai_set_cron_mode");
    const passive = inv.find((i) => i.cmd === "mai_set_passive_mode");
    assert.ok(cron, "Auto tab must fire mai_set_cron_mode");
    assert.deepEqual(cron.args, { enabled: true }, "Auto ⇒ cron enabled:true");
    assert.deepEqual(passive?.args, { enabled: false }, "Auto ⇒ passive enabled:false");
  });

  it("T-Click.2: clicking #mode-manual-tab fires mai_set_cron_mode{enabled:false} + mai_set_passive_mode{enabled:false}", async () => {
    // Given: booted app (now in Auto from T-Click.1)
    // When:  the Manual switcher tab is clicked
    // Then:  applyMode('manual') fires cron-mode enabled:false (Manual ⇒ cron OFF) + passive enabled:false
    const inv = await clickAndRecord("mode-manual-tab");
    const cron = inv.find((i) => i.cmd === "mai_set_cron_mode");
    assert.ok(cron, "Manual tab must fire mai_set_cron_mode");
    assert.deepEqual(cron.args, { enabled: false }, "Manual ⇒ cron enabled:false");
  });
});

describe("button click-through — turn controls (G-PY2.1.9)", () => {
  it("T-Click.3: with a non-empty command, clicking #send-btn fires mai_agent_turn{prompt} (wiring only; real turn is operator-live)", async () => {
    // Given: the command input holds a prompt
    // When:  Send is clicked
    // Then:  mai_agent_turn fires with that prompt (this asserts LISTENER WIRING against the mock — the
    //        real LLM/LinkedIn turn is NOT executed; that path stays operator-live)
    await gotoIdle(); // sendCommand's fresh-turn path requires appState==='idle' (Chrome connected, mocked)
    const inv = await clickAndRecord("send-btn", `document.getElementById('command-input').value = 'hello world';`);
    const turn = inv.find((i) => i.cmd === "mai_agent_turn");
    assert.ok(turn, "Send must fire mai_agent_turn");
    assert.deepEqual(turn.args, { prompt: "hello world" }, "Send must pass the typed prompt");
  });

  it("T-Click.4: clicking #retry-btn fires mai_agent_retry", async () => {
    // Given: booted app
    // When:  Retry is clicked
    // Then:  mai_agent_retry fires (no args)
    const inv = await clickAndRecord("retry-btn");
    assert.ok(
      inv.some((i) => i.cmd === "mai_agent_retry"),
      "Retry must fire mai_agent_retry",
    );
  });

  it("T-Click.5: #workflow-pause-btn fires mai_agent_abort once a turn is running (send → running → pause)", async () => {
    // Given: a running turn (clicking Send transitions appState→running + sets currentTurnId)
    // When:  the workflow Pause button is clicked
    // Then:  abortTurn fires mai_agent_abort (the guard appState==='running' && currentTurnId!==null is satisfied)
    await gotoIdle(); // idle (mocked Chrome) → so the next Send opens a fresh turn → running
    await clickAndRecord("send-btn", `document.getElementById('command-input').value = 'start a turn';`);
    const inv = await clickAndRecord("workflow-pause-btn");
    assert.ok(
      inv.some((i) => i.cmd === "mai_agent_abort"),
      "Pause must fire mai_agent_abort while running",
    );
  });
});

describe("button click-through — workflow approval controls (G-PY2.1.9, G-PY2.1.4)", () => {
  // Drives the REAL SSE path to seed a pending workflow, then clicks the approval buttons.
  const SEED_PENDING = `
    window.__mai_eventCb({ payload: { type: "workflow-proposed", workflowId: "wf1", title: "Engage lead",
      approvalMode: "manual", steps: [{ id: "s1", title: "Send connection", state: "in_progress", requiresApproval: true }] } });
    window.__mai_eventCb({ payload: { type: "workflow-approval-pending", workflowId: "wf1", stepId: "s1", stepTitle: "Send connection" } });
  `;

  it("T-Click.6: with a pending step, clicking #workflow-approve-btn fires mai_workflow_approve{workflowId,stepId}", async () => {
    // Given: a workflow proposed + a pending approval step (seeded via the real overlay-event SSE path)
    // When:  Approve is clicked
    // Then:  mai_workflow_approve fires with {workflowId:'wf1', stepId:'s1'}
    const inv = await clickAndRecord("workflow-approve-btn", SEED_PENDING);
    const ap = inv.find((i) => i.cmd === "mai_workflow_approve");
    assert.ok(ap, "Approve must fire mai_workflow_approve");
    assert.deepEqual(ap.args, { workflowId: "wf1", stepId: "s1" }, "approve args must carry workflow + step");
  });

  it("T-Click.7: with a pending step, clicking #workflow-decline-btn fires mai_workflow_decline{workflowId,stepId,reason}", async () => {
    // Given: a pending approval step
    // When:  Decline is clicked
    // Then:  mai_workflow_decline fires with {workflowId, stepId, reason:'operator_declined'}
    const inv = await clickAndRecord("workflow-decline-btn", SEED_PENDING);
    const dc = inv.find((i) => i.cmd === "mai_workflow_decline");
    assert.ok(dc, "Decline must fire mai_workflow_decline");
    assert.deepEqual(dc.args, { workflowId: "wf1", stepId: "s1", reason: "operator_declined" }, "decline args");
  });

  it("T-Click.8: with a proposed workflow, clicking #workflow-handoff-btn fires mai_workflow_handoff{workflowId}", async () => {
    // Given: a proposed workflow (no pending step needed)
    // When:  Hand off to Auto is clicked
    // Then:  mai_workflow_handoff fires with {workflowId:'wf1'}
    const SEED = `window.__mai_eventCb({ payload: { type: "workflow-proposed", workflowId: "wf1", title: "Engage lead", approvalMode: "manual", steps: [] } });`;
    const inv = await clickAndRecord("workflow-handoff-btn", SEED);
    const ho = inv.find((i) => i.cmd === "mai_workflow_handoff");
    assert.ok(ho, "Hand off must fire mai_workflow_handoff");
    assert.deepEqual(ho.args, { workflowId: "wf1" }, "handoff args must carry workflowId");
  });
});
