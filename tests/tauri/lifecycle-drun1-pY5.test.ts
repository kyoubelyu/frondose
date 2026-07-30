/**
 * P-Y5 D-RUN-1 (app-close-must-stop-the-agent, HIGH/safety) — lifecycle tests — T-Life.*.
 *
 * Automates the two automatable arms of D-RUN-1 against the real app-owned loopback-TCP sidecar:
 *   (a) SIGTERM-shutdown — SIGTERM ⇒ the process exits AND its port-file is removed.
 *   (b) TCP SSE disconnect-abort — when the controlling SSE client disconnects and does NOT
 *       reconnect within the 3s grace, the in-flight turn is aborted (belt-and-suspenders so an orphaned
 *       sidecar can't keep acting on the page if the parent's kill failed); reconnect within grace ⇒ no abort.
 *
 * The turn-abort is made DETERMINISTIC (no real LLM, no tokens, no flake) with a FAKE OpenAI-compatible
 * LLM server that simply HOLDS the /chat/completions request open. The sidecar's turn hangs in that LLM
 * call; when the grace aborts the turn, the SDK aborts the fetch → the fake server observes the request
 * connection close at ~grace-time (vs the 30s hold). That close-time IS the abort signal.
 *
 * NOT automatable here (operator-confirmed): the native GUI red-button close → Tauri WindowEvent::
 * CloseRequested → kill sidecar child (src/tauri/src-tauri/src/main.rs). The Rust arm is wired; its kill
 * path lands on the sidecar as SIGTERM — which IS the (a) path proven below.
 *
 * Gate: G-PY5.1 (app-close / client-loss stops the agent).
 *
 * Run: node --import tsx --test --test-timeout=90000 tests/tauri/lifecycle-drun1-pY5.test.ts
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer, type IncomingMessage, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type AppSidecarFixture, startAppSidecar } from "../helpers/appSidecarFixture.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const APP_SIDECAR = join(REPO, "dist", "app", "sidecarMain.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface Sidecar {
  serve: ChildProcess;
  port: number;
  portFile: string;
  token: string;
  homeDir: string;
  rootDir: string;
}

// Spawn the real app-owned sidecar over loopback TCP with isolated state and a held fake Pi model.
async function spawnSidecar(fakePort: number): Promise<Sidecar> {
  assert.ok(existsSync(APP_SIDECAR), "dist/app/sidecarMain.js must be built (npm run build:tauri)");
  const rootDir = mkdtempSync(join(tmpdir(), "frondose-life-sidecar-"));
  const homeDir = join(rootDir, "home");
  const portFile = join(rootDir, "sidecar.port");
  const token = randomBytes(16).toString("hex");
  mkdirSync(join(homeDir, ".frondose", "agent"), { recursive: true });
  writeFileSync(
    join(homeDir, ".frondose", "agent", "secrets.json"),
    JSON.stringify({
      schema_version: 1,
      default: "deepseek:test-model",
      providers: {
        deepseek: { key: "fake-key", baseUrl: `http://127.0.0.1:${fakePort}/v1`, type: "openai" },
      },
    }),
  );
  const env: NodeJS.ProcessEnv = {
    HOME: homeDir,
    USER: process.env.USER ?? "",
    PATH: process.env.PATH ?? "",
    FRONDOSE_HOME_BASE: homeDir,
    FRONDOSE_AUTOUPDATE: "skip",
    FRONDOSE_DOTENV: "skip",
    FRONDOSE_MODEL: "deepseek:test-model",
  };
  const serve = spawn("node", [APP_SIDECAR, "--port-file", portFile, "--token", token], {
    env,
    stdio: "ignore",
  });
  const deadline = Date.now() + 12_000;
  let port = 0;
  while (Date.now() < deadline) {
    if (serve.exitCode !== null || serve.signalCode !== null) break;
    if (existsSync(portFile)) {
      const candidate = Number.parseInt(readFileSync(portFile, "utf8").trim(), 10);
      if (Number.isInteger(candidate) && candidate > 0) {
        try {
          const h = await tcpGet(candidate, token, "/health");
          if (h === 200) {
            port = candidate;
            break;
          }
        } catch {
          // Port-file publication can precede listener readiness by a few milliseconds.
        }
      }
    }
    await sleep(100);
  }
  if (port === 0) {
    await cleanupSidecar({ serve, port, portFile, token, homeDir, rootDir });
    throw new Error(`sidecar failed to become healthy; exitCode=${String(serve.exitCode)}`);
  }
  return { serve, port, portFile, token, homeDir, rootDir };
}

async function cleanupSidecar(s: Sidecar | undefined): Promise<void> {
  if (!s) return;
  if (s.serve.exitCode === null && s.serve.signalCode === null) {
    const exited = new Promise<void>((resolve) => s.serve.once("exit", () => resolve()));
    try {
      s.serve.kill("SIGKILL");
    } catch {}
    await withTimeout(exited, 5000, "sidecar did not exit within 5s of SIGKILL");
  }
  rmSync(s.rootDir, { recursive: true, force: true });
}

function tcpGet(port: number, token: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error(`GET ${path} timed out`)));
    req.on("error", reject);
    req.end();
  });
}

function tcpPost(port: number, token: string, path: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error(`POST ${path} timed out`)));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// Long-lived TCP SSE subscriber. .close() destroys the connection (→ server res 'close').
interface SseHandle {
  close(): void;
}
function openSse(port: number, token: string): Promise<SseHandle> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/agent/events",
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const timer = setTimeout(() => req.destroy(new Error("SSE connect timed out")), 5000);
    req.on("response", (res: IncomingMessage) => {
      clearTimeout(timer);
      if (res.statusCode !== 200 || !String(res.headers["content-type"] ?? "").startsWith("text/event-stream")) {
        res.resume();
        reject(new Error(`SSE connect failed: status=${String(res.statusCode)}`));
        return;
      }
      res.on("data", () => {}); // keep the stream flowing
      resolve({
        close: () => {
          req.destroy();
          res.destroy();
        },
      });
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}

// Fake OpenAI-compatible LLM: holds /chat/completions open ~30s; records receive + abort (connection close).
interface FakeLLM {
  server: Server;
  port: number;
  received(): boolean;
  abortedAt(): number | null;
}
function startFakeLLM(): Promise<FakeLLM> {
  let received = false;
  let abortedAt: number | null = null;
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }
    req.resume();
    received = true;
    const markAbort = () => {
      if (abortedAt === null && !res.writableEnded) abortedAt = Date.now();
    };
    req.on("aborted", markAbort);
    res.on("close", markAbort);
    // Hold the request open; if never aborted, answer minimally after 30s so nothing hangs forever.
    const t = setTimeout(() => {
      try {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "fake",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      } catch {}
    }, 30_000);
    res.on("close", () => clearTimeout(t));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port, received: () => received, abortedAt: () => abortedAt });
    });
  });
}

// ─────────────────────────── (a) SIGTERM-shutdown ───────────────────────────

describe("D-RUN-1 (a) SIGTERM-shutdown (G-PY5.1)", () => {
  let appSidecar: AppSidecarFixture;
  before(async () => {
    appSidecar = await startAppSidecar(APP_SIDECAR);
  });
  after(() => appSidecar.cleanup());

  it("T-Life.1: SIGTERM ⇒ the exact app-owned child exits AND production removes its port-file before cleanup", async () => {
    // Given: a healthy dedicated app sidecar with a published TCP port-file
    // When:  the process receives SIGTERM (the signal the Tauri shell's kill + the OS shutdown deliver)
    // Then:  that child exits within the bound and its own shutdown removes the port-file
    assert.equal((await appSidecar.request("GET", "/health")).status, 200, "precondition: sidecar healthy");
    assert.ok(existsSync(appSidecar.portFile), "precondition: production port-file exists");
    const signalled = appSidecar.child.kill("SIGTERM");
    assert.equal(signalled, true, "SIGTERM must target the exact spawned child");
    assert.equal(await appSidecar.waitForExit(8000), true, "exact app sidecar child must emit exit within 8s");
    assert.ok(
      appSidecar.child.exitCode !== null || appSidecar.child.signalCode !== null,
      "child exit event must carry an exitCode or signalCode",
    );
    assert.ok(
      !existsSync(appSidecar.portFile),
      "production shutdown must remove the port-file before helper/temp cleanup",
    );
  });
});

// ───────────────────── (b) TCP-SSE disconnect-abort (Fix 2) ─────────────────

describe("D-RUN-1 (b) TCP-SSE disconnect-abort — controlling client loss stops the in-flight turn (G-PY5.1)", () => {
  let fake: FakeLLM;
  let s: Sidecar;
  // Fresh fake-LLM + sidecar PER test — the fake's received/abortedAt state and the sidecar's currentTurn
  // must not bleed between T-Life.2 (which aborts) and T-Life.3 (which must NOT abort).
  beforeEach(async () => {
    fake = await startFakeLLM();
    s = await spawnSidecar(fake.port);
  });
  afterEach(async () => {
    await cleanupSidecar(s);
    await withTimeout(
      new Promise<void>((resolve) => fake.server.close(() => resolve())),
      5000,
      "fake LLM server must close within 5s after sidecar teardown",
    );
  });

  // Start a turn and wait until the sidecar's LLM call has reached the fake server (turn genuinely in-flight).
  async function startInFlightTurn(): Promise<void> {
    assert.equal(await tcpPost(s.port, s.token, "/agent/turn", { prompt: "hold please" }), 200, "turn must queue");
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (fake.received()) return;
      await sleep(150);
    }
    throw new Error("sidecar never called the (fake) LLM — turn did not reach an in-flight LLM call");
  }

  it("T-Life.2: SSE client disconnects (no reconnect) ⇒ the in-flight turn aborts after the 3s grace", async () => {
    // Given: an SSE subscriber connected + a turn in-flight (hung in the fake LLM call)
    // When:  the SSE client disconnects and does NOT reconnect
    // Then:  after the 3s grace the sidecar aborts the turn → the SDK aborts the LLM fetch → the fake
    //        server sees the request connection close (well before its 30s hold) = the agent was stopped
    const sse = await openSse(s.port, s.token);
    await startInFlightTurn();
    assert.equal(fake.abortedAt(), null, "precondition: LLM call still open before disconnect");
    const tDisconnect = Date.now();
    sse.close();
    // Poll up to grace + buffer for the abort to land.
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline && fake.abortedAt() === null) await sleep(150);
    const abortedAt = fake.abortedAt();
    assert.notEqual(abortedAt, null, "disconnect + no reconnect must abort the in-flight turn (LLM fetch closed)");
    const elapsed = (abortedAt as number) - tDisconnect;
    assert.ok(elapsed >= 2500, `abort must wait the 3s grace, not fire instantly; elapsed=${elapsed}ms`);
    assert.ok(elapsed < 6500, `abort must fire near the 3s grace, not at the 30s LLM hold; elapsed=${elapsed}ms`);
    assert.equal(await tcpGet(s.port, s.token, "/health"), 200, "abort evidence must not come from sidecar exit");
    assert.equal(s.serve.exitCode, null, "sidecar must remain alive after aborting only the turn");
  });

  it("T-Life.3: SSE client reconnects WITHIN the grace ⇒ the in-flight turn is NOT aborted", async () => {
    // Given: an SSE subscriber + a turn in-flight
    // When:  the client disconnects but a NEW SSE client reconnects within the 3s grace (the main.rs
    //        run_sse_subscriber's ~1s auto-reconnect blip)
    // Then:  the pending orphan-abort is cancelled — the turn keeps running (no LLM-fetch abort) past the grace
    const sseA = await openSse(s.port, s.token);
    await startInFlightTurn();
    sseA.close();
    await sleep(800); // well within the 3s grace
    const sseB = await openSse(s.port, s.token); // reconnect cancels the orphan-abort timer
    await sleep(4000); // past the original grace window
    assert.equal(fake.abortedAt(), null, "reconnect within grace must NOT abort the in-flight turn");
    assert.equal(await tcpGet(s.port, s.token, "/health"), 200, "non-abort evidence requires a live sidecar");
    assert.equal(s.serve.exitCode, null, "sidecar must remain alive past the original grace window");
    sseB.close();
  });
});
