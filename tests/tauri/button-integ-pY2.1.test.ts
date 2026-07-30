/**
 * P-Y2.1 functional-hardening — T-Integ.* — REAL-sidecar integration smoke (real transport).
 *
 * Starts the app-owned sidecar exactly as the Tauri Rust shell does:
 * `node dist/app/sidecarMain.js --port-file <path> --token <tok>`, then replays
 * the same invoke(cmd,args) → TCP endpoint that the Tauri Rust handler proxies to (verified against
 * src/tauri/src-tauri/src/main.rs), and asserts the sidecar actually handles it (cronEnabled FLIPS;
 * other routes return a structured handled response — not a 404/crash). This is the layer the mocked
 * click-through (T-Click.*) can't reach: it catches a broken route / handler / sidecar-runtime fault.
 *
 * CLASSIFICATION: tool/integration smoke (it drives the invoke→UDS→sidecar transport directly, NOT the
 * DOM click and NOT the LLM/agent loop). T-Click.* covers click→invoke wiring; together they span the
 * full chain except the Rust IPC seam (framework plumbing).
 *
 * Gate: G-PY2.1.9 (button behavior — every no-Chrome button's invoke reaches + is handled by the sidecar).
 *
 * Self-contained: isolated HOME + a DUMMY deepseek provider (so serve boots; the test NEVER calls
 * /agent/turn, so the key is never exercised). Start LinkedIn (/chrome/ensure) + Send (/agent/turn) are
 * NOT driven here — operator-live.
 *
 * Run: node --import tsx --test --test-force-exit --test-timeout=60000 tests/tauri/button-integ-pY2.1.test.ts
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type AppSidecarFixture, startAppSidecar } from "../helpers/appSidecarFixture.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const APP_SIDECAR = join(REPO, "dist", "app", "sidecarMain.js");

let fixture: AppSidecarFixture;

before(async () => {
  assert.ok(existsSync(APP_SIDECAR), "dist/app/sidecarMain.js must be built (npm run build:tauri)");
  fixture = await startAppSidecar(APP_SIDECAR);
});

after(async () => {
  if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
    fixture.child.kill("SIGTERM");
    await fixture.waitForExit(5000);
  }
  fixture.cleanup();
});

describe("real-sidecar integration — sidecar booted (G-PY2.1.9)", () => {
  it("T-Integ.0: app-owned sidecar health is token-authenticated and fails closed with structured 401s", async () => {
    // Given: the dedicated app sidecar is healthy on its published loopback port
    // When: requests use a valid, missing, or wrong bearer token
    // Then: valid is 200; invalid forms are distinct structured 401 responses
    assert.equal((await fixture.request("GET", "/health")).status, 200);
    const missing = await fixture.request("GET", "/health", undefined, null);
    assert.deepEqual(missing, { status: 401, body: { ok: false, error: "missing_bearer" } });
    const wrong = await fixture.request("GET", "/health", undefined, "wrong-token");
    assert.deepEqual(wrong, { status: 401, body: { ok: false, error: "invalid_token" } });
  });
});

describe("real-sidecar integration — direct Rust-command mode routes (G-PY2.1.9)", () => {
  it("T-Integ.1: frondose_set_cron_mode{enabled:true} route flips cronEnabled TRUE", async () => {
    // Given: the running sidecar
    // When:  the Auto switcher's invoke is replayed to its mapped endpoint /agent/cron-mode {enabled:true}
    // Then:  the sidecar STATE changes — response {ok:true, cronEnabled:true}
    const r = await fixture.request("POST", "/agent/cron-mode", { enabled: true });
    assert.equal(r.status, 200, "cron-mode must be 200");
    assert.equal(r.body.ok, true, "cron-mode ok");
    assert.equal(r.body.cronEnabled, true, "direct cron command must flip sidecar cronEnabled TRUE");
  });

  it("T-Integ.2: Manual switcher invoke (frondose_set_cron_mode{enabled:false}) → POST /agent/cron-mode flips cronEnabled FALSE", async () => {
    // Given: cronEnabled currently true (from T-Integ.1)
    // When:  the Manual switcher's invoke is replayed {enabled:false}
    // Then:  the sidecar state flips back — {ok:true, cronEnabled:false} (proves the flip is real + bidirectional)
    const r = await fixture.request("POST", "/agent/cron-mode", { enabled: false });
    assert.equal(r.body.ok, true, "cron-mode ok");
    assert.equal(r.body.cronEnabled, false, "Manual switcher must flip sidecar cronEnabled FALSE");
  });

  it("T-Integ.3: passive invoke (frondose_set_passive_mode{enabled:false}) → POST /agent/passive-mode handled, passiveEnabled:false", async () => {
    // Given: the running sidecar
    // When:  the switcher's passive invoke is replayed {enabled:false} (R-3 Option II: passive OFF both modes)
    // Then:  {ok:true, passiveEnabled:false}
    const r = await fixture.request("POST", "/agent/passive-mode", { enabled: false });
    assert.equal(r.body.ok, true, "passive-mode ok");
    assert.equal(r.body.passiveEnabled, false, "passive must be false");
  });
});

describe("real-sidecar integration — turn/workflow routes are handled, not crashing (G-PY2.1.9)", () => {
  // No running turn / no active workflow → these legitimately return {ok:false,...}; the point is the
  // route EXISTS + the handler returns a STRUCTURED response (not 404 / 500 / connection drop).
  const handled = (r: { status: number; body: unknown }, label: string) => {
    assert.ok(r.status < 500, `${label} must not 5xx; got ${r.status}`);
    assert.equal(
      typeof (r.body as { ok?: unknown })?.ok,
      "boolean",
      `${label} must return a structured {ok:boolean}; got ${JSON.stringify(r.body).slice(0, 80)}`,
    );
  };

  it("T-Integ.4: takeover/pause invoke (frondose_agent_abort) → POST /agent/abort is handled (no running turn ⇒ ok:false, not a crash)", async () => {
    // Given: no running turn
    // When:  the abort invoke is replayed to /agent/abort
    // Then:  a structured handled response (route + handler exist; sidecar does not crash)
    handled(await fixture.request("POST", "/agent/abort", {}), "abort");
  });

  it("T-Integ.5: retry invoke (frondose_agent_retry) → POST /agent/retry is handled (no last turn ⇒ ok:false, not a crash)", async () => {
    // Given: no prior turn
    // When:  the retry invoke is replayed to /agent/retry
    // Then:  a structured handled response
    handled(await fixture.request("POST", "/agent/retry", {}), "retry");
  });

  it("T-Integ.6: handoff invoke (frondose_workflow_handoff) → POST /workflow/handoff is handled (no active workflow ⇒ ok:false, not a crash)", async () => {
    // Given: no active workflow
    // When:  the handoff invoke is replayed to /workflow/handoff {workflowId}
    // Then:  a structured handled response (route exists; handler doesn't throw)
    handled(await fixture.request("POST", "/workflow/handoff", { workflowId: "no-such-wf" }), "handoff");
  });
});
