/**
 * P-Y2.1 functional-hardening — T-Integ.* — REAL-sidecar integration smoke (real transport).
 *
 * Starts a real `mai serve` sidecar over a Unix-domain socket (exactly as the Tauri Rust shell does:
 * `node dist/cli/main.js serve --sock <sock> --token <tok>`), then for each NO-CHROME button replays the
 * SAME invoke(cmd,args) → UDS endpoint that the Tauri Rust handler proxies to (verified against
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
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const MAI_BIN = join(REPO, "dist", "cli", "main.js");

let serve: ChildProcess;
let SOCK = "";
const TOKEN = randomBytes(16).toString("hex");
let homeDir = "";
let sockDir = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface UdsResp {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: endpoint JSON bodies are dynamic.
  body: any;
}

function uds(method: "GET" | "POST", path: string, payload?: unknown): Promise<UdsResp> {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    const req = request(
      {
        socketPath: SOCK,
        path,
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Host: "localhost",
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => {
          buf += c;
        });
        res.on("end", () => {
          let body: unknown = buf;
          try {
            body = JSON.parse(buf);
          } catch {}
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

before(async () => {
  assert.ok(existsSync(MAI_BIN), "dist/cli/main.js must be built (npm run build)");
  homeDir = mkdtempSync(join(tmpdir(), "frondose-integ-home-"));
  sockDir = mkdtempSync(join(tmpdir(), "frondose-integ-sock-"));
  SOCK = join(sockDir, "mai.sock");
  // Seed a DUMMY provider so serve boots (resolveModel needs a provider entry); never exercised.
  mkdirSync(join(homeDir, ".mai", "agent"), { recursive: true });
  writeFileSync(
    join(homeDir, ".mai", "agent", "secrets.json"),
    JSON.stringify({
      schema_version: 1,
      default: "deepseek:deepseek-chat",
      providers: {
        deepseek: { key: "dummy-integ-key-not-used", baseUrl: "https://api.deepseek.com/v1", type: "openai" },
      },
    }),
  );
  // Child env: isolated HOME + MAI_DOTENV=skip (do NOT read the repo .env → no real key / MAI_MODEL leak);
  // model spec resolves from the seeded secrets `default`, using the dummy provider key (never exercised).
  const env = { ...process.env, HOME: homeDir, MAI_AUTOUPDATE: "skip", MAI_DOTENV: "skip" } as Record<string, string>;
  delete env.MAI_MODEL;
  delete env.DEEPSEEK_API_KEY;
  delete env.MAI_HOME_BASE;
  serve = spawn("node", [MAI_BIN, "serve", "--sock", SOCK, "--token", TOKEN], { env, stdio: "ignore" });
  // Wait for the sidecar to come up (sock + /health 200), up to ~12s.
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (existsSync(SOCK)) {
      try {
        const h = await uds("GET", "/health");
        if (h.status === 200) break;
      } catch {}
    }
    await sleep(300);
  }
});

after(() => {
  try {
    serve?.kill("SIGTERM");
  } catch {}
  try {
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    if (sockDir) rmSync(sockDir, { recursive: true, force: true });
  } catch {}
});

describe("real-sidecar integration — sidecar booted (G-PY2.1.9)", () => {
  it("T-Integ.0: the spawned `mai serve` sidecar answers /health 200 over the UDS", async () => {
    // Given: `node dist/cli/main.js serve --sock --token` spawned with an isolated HOME + dummy provider
    // When:  GET /health over the Unix-domain socket with the bearer token
    // Then:  status 200 (the sidecar booted + the UDS+token transport works)
    const h = await uds("GET", "/health");
    assert.equal(h.status, 200, `/health must be 200; got ${h.status} (serve failed to boot?)`);
  });
});

describe("real-sidecar integration — switcher flips cronEnabled (G-PY2.1.9, G-PY2.1.3)", () => {
  it("T-Integ.1: Auto switcher invoke (frondose_set_cron_mode{enabled:true}) → POST /agent/cron-mode flips cronEnabled TRUE", async () => {
    // Given: the running sidecar
    // When:  the Auto switcher's invoke is replayed to its mapped endpoint /agent/cron-mode {enabled:true}
    // Then:  the sidecar STATE changes — response {ok:true, cronEnabled:true}
    const r = await uds("POST", "/agent/cron-mode", { enabled: true });
    assert.equal(r.status, 200, "cron-mode must be 200");
    assert.equal(r.body.ok, true, "cron-mode ok");
    assert.equal(r.body.cronEnabled, true, "Auto switcher must flip sidecar cronEnabled TRUE");
  });

  it("T-Integ.2: Manual switcher invoke (frondose_set_cron_mode{enabled:false}) → POST /agent/cron-mode flips cronEnabled FALSE", async () => {
    // Given: cronEnabled currently true (from T-Integ.1)
    // When:  the Manual switcher's invoke is replayed {enabled:false}
    // Then:  the sidecar state flips back — {ok:true, cronEnabled:false} (proves the flip is real + bidirectional)
    const r = await uds("POST", "/agent/cron-mode", { enabled: false });
    assert.equal(r.body.ok, true, "cron-mode ok");
    assert.equal(r.body.cronEnabled, false, "Manual switcher must flip sidecar cronEnabled FALSE");
  });

  it("T-Integ.3: passive invoke (frondose_set_passive_mode{enabled:false}) → POST /agent/passive-mode handled, passiveEnabled:false", async () => {
    // Given: the running sidecar
    // When:  the switcher's passive invoke is replayed {enabled:false} (R-3 Option II: passive OFF both modes)
    // Then:  {ok:true, passiveEnabled:false}
    const r = await uds("POST", "/agent/passive-mode", { enabled: false });
    assert.equal(r.body.ok, true, "passive-mode ok");
    assert.equal(r.body.passiveEnabled, false, "passive must be false");
  });
});

describe("real-sidecar integration — turn/workflow routes are handled, not crashing (G-PY2.1.9)", () => {
  // No running turn / no active workflow → these legitimately return {ok:false,...}; the point is the
  // route EXISTS + the handler returns a STRUCTURED response (not 404 / 500 / connection drop).
  const handled = (r: UdsResp, label: string) => {
    assert.ok(r.status < 500, `${label} must not 5xx; got ${r.status}`);
    assert.equal(
      typeof r.body?.ok,
      "boolean",
      `${label} must return a structured {ok:boolean}; got ${JSON.stringify(r.body).slice(0, 80)}`,
    );
  };

  it("T-Integ.4: takeover/pause invoke (frondose_agent_abort) → POST /agent/abort is handled (no running turn ⇒ ok:false, not a crash)", async () => {
    // Given: no running turn
    // When:  the abort invoke is replayed to /agent/abort
    // Then:  a structured handled response (route + handler exist; sidecar does not crash)
    handled(await uds("POST", "/agent/abort", {}), "abort");
  });

  it("T-Integ.5: retry invoke (frondose_agent_retry) → POST /agent/retry is handled (no last turn ⇒ ok:false, not a crash)", async () => {
    // Given: no prior turn
    // When:  the retry invoke is replayed to /agent/retry
    // Then:  a structured handled response
    handled(await uds("POST", "/agent/retry", {}), "retry");
  });

  it("T-Integ.6: handoff invoke (frondose_workflow_handoff) → POST /workflow/handoff is handled (no active workflow ⇒ ok:false, not a crash)", async () => {
    // Given: no active workflow
    // When:  the handoff invoke is replayed to /workflow/handoff {workflowId}
    // Then:  a structured handled response (route exists; handler doesn't throw)
    handled(await uds("POST", "/workflow/handoff", { workflowId: "no-such-wf" }), "handoff");
  });
});
