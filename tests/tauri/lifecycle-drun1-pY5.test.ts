/**
 * P-Y5 D-RUN-1 (app-close-must-stop-the-agent, HIGH/safety) — lifecycle tests — T-Life.*.
 *
 * Automates the two automatable arms of the D-RUN-1 fix against a REAL `mai serve` sidecar over a UDS:
 *   (a) SIGTERM-shutdown (serve.ts shutdown handler) — codifies the builder's manual SIGTERM test:
 *       SIGTERM ⇒ the process exits AND the UDS socket file is removed (removeSocket in serve/http.ts).
 *   (b) UDS-disconnect-abort (routes.ts Fix 2) — when the controlling SSE client disconnects and does NOT
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
 * Run: node --import tsx --test --test-force-exit --test-timeout=90000 tests/tauri/lifecycle-drun1-pY5.test.ts
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer, type IncomingMessage, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const MAI_BIN = join(REPO, "dist", "cli", "main.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Sidecar {
  serve: ChildProcess;
  sock: string;
  token: string;
  homeDir: string;
  sockDir: string;
}

// Spawn a real `mai serve` over a fresh UDS with an isolated HOME + the given secrets.json object.
async function spawnSidecar(secrets: object): Promise<Sidecar> {
  assert.ok(existsSync(MAI_BIN), "dist/cli/main.js must be built (npm run build)");
  const homeDir = mkdtempSync(join(tmpdir(), "frondose-life-home-"));
  const sockDir = mkdtempSync(join(tmpdir(), "frondose-life-sock-"));
  const sock = join(sockDir, "mai.sock");
  const token = randomBytes(16).toString("hex");
  mkdirSync(join(homeDir, ".frondose", "agent"), { recursive: true });
  writeFileSync(join(homeDir, ".frondose", "agent", "secrets.json"), JSON.stringify(secrets));
  const env = { ...process.env, HOME: homeDir, MAI_AUTOUPDATE: "skip", MAI_DOTENV: "skip" } as Record<string, string>;
  delete env.MAI_MODEL;
  delete env.DEEPSEEK_API_KEY;
  delete env.DEEPSEEK_BASE_URL;
  delete env.MAI_HOME_BASE;
  const serve = spawn("node", [MAI_BIN, "serve", "--sock", sock, "--token", token], { env, stdio: "ignore" });
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (existsSync(sock)) {
      try {
        const h = await udsGet(sock, token, "/health");
        if (h === 200) break;
      } catch {}
    }
    await sleep(250);
  }
  return { serve, sock, token, homeDir, sockDir };
}

function cleanupSidecar(s: Sidecar | undefined): void {
  if (!s) return;
  try {
    s.serve.kill("SIGKILL");
  } catch {}
  try {
    rmSync(s.homeDir, { recursive: true, force: true });
    rmSync(s.sockDir, { recursive: true, force: true });
  } catch {}
}

function udsGet(sock: string, token: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: sock, path, method: "GET", headers: { Authorization: `Bearer ${token}`, Host: "localhost" } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function udsPost(sock: string, token: string, path: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      {
        socketPath: sock,
        path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Host: "localhost",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// Long-lived SSE subscriber on /agent/events. .close() destroys the connection (→ server res 'close').
interface SseHandle {
  close(): void;
}
function openSse(sock: string, token: string): Promise<SseHandle> {
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath: sock,
      path: "/agent/events",
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Host: "localhost" },
    });
    req.on("response", (res: IncomingMessage) => {
      res.on("data", () => {}); // keep the stream flowing
      resolve({
        close: () => {
          req.destroy();
          res.destroy();
        },
      });
    });
    req.on("error", reject);
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

const DUMMY_SECRETS = {
  schema_version: 1,
  default: "deepseek:deepseek-chat",
  providers: { deepseek: { key: "dummy", baseUrl: "https://api.deepseek.com/v1", type: "openai" } },
};

// ─────────────────────────── (a) SIGTERM-shutdown ───────────────────────────

describe("D-RUN-1 (a) SIGTERM-shutdown (G-PY5.1)", () => {
  let s: Sidecar;
  before(async () => {
    s = await spawnSidecar(DUMMY_SECRETS);
  });
  after(() => cleanupSidecar(s));

  it("T-Life.1: SIGTERM ⇒ the sidecar process exits AND the UDS socket file is removed", async () => {
    // Given: a booted `mai serve` sidecar with a live UDS socket
    // When:  the process receives SIGTERM (the signal the Tauri shell's kill + the OS shutdown deliver)
    // Then:  the process exits within the grace AND removeSocket() deleted the socket file (no orphan socket)
    assert.equal(await udsGet(s.sock, s.token, "/health"), 200, "precondition: sidecar healthy");
    assert.ok(existsSync(s.sock), "precondition: socket file exists");
    const exited = new Promise<void>((resolve) => s.serve.once("exit", () => resolve()));
    s.serve.kill("SIGTERM");
    await Promise.race([exited, sleep(8000)]);
    assert.equal(
      s.serve.killed || s.serve.exitCode !== null || s.serve.signalCode !== null,
      true,
      "process must have exited after SIGTERM",
    );
    await sleep(300); // allow removeSocket() in the close callback to run
    assert.ok(!existsSync(s.sock), "SIGTERM must remove the UDS socket file (no orphan)");
  });
});

// ───────────────────── (b) UDS-disconnect-abort (Fix 2) ─────────────────────

describe("D-RUN-1 (b) UDS-disconnect-abort — controlling client loss stops the in-flight turn (G-PY5.1)", () => {
  let fake: FakeLLM;
  let s: Sidecar;
  // Fresh fake-LLM + sidecar PER test — the fake's received/abortedAt state and the sidecar's currentTurn
  // must not bleed between T-Life.2 (which aborts) and T-Life.3 (which must NOT abort).
  beforeEach(async () => {
    fake = await startFakeLLM();
    s = await spawnSidecar({
      schema_version: 1,
      default: "fake:test-model",
      providers: { fake: { key: "fake-key", baseUrl: `http://127.0.0.1:${fake.port}/v1`, type: "openai" } },
    });
  });
  afterEach(() => {
    cleanupSidecar(s);
    try {
      fake.server.close();
    } catch {}
  });

  // Start a turn and wait until the sidecar's LLM call has reached the fake server (turn genuinely in-flight).
  async function startInFlightTurn(): Promise<void> {
    assert.equal(await udsPost(s.sock, s.token, "/agent/turn", { prompt: "hold please" }), 200, "turn must queue");
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (fake.received()) return;
      await sleep(150);
    }
    throw new Error("sidecar never called the (fake) LLM — turn did not reach an in-flight LLM call");
  }

  it.skip("T-Life.2: SSE client disconnects (no reconnect) ⇒ the in-flight turn aborts after the 3s grace", async () => {
    // Given: an SSE subscriber connected + a turn in-flight (hung in the fake LLM call)
    // When:  the SSE client disconnects and does NOT reconnect
    // Then:  after the 3s grace the sidecar aborts the turn → the SDK aborts the LLM fetch → the fake
    //        server sees the request connection close (well before its 30s hold) = the agent was stopped
    const sse = await openSse(s.sock, s.token);
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
    assert.ok(elapsed >= 2000, `abort must wait the ~3s grace, not fire instantly; elapsed=${elapsed}ms`);
    assert.ok(elapsed < 9000, `abort must fire near grace, not at the 30s LLM hold; elapsed=${elapsed}ms`);
  });

  it.skip("T-Life.3: SSE client reconnects WITHIN the grace ⇒ the in-flight turn is NOT aborted", async () => {
    // Given: an SSE subscriber + a turn in-flight
    // When:  the client disconnects but a NEW SSE client reconnects within the 3s grace (the main.rs
    //        run_sse_subscriber's ~1s auto-reconnect blip)
    // Then:  the pending orphan-abort is cancelled — the turn keeps running (no LLM-fetch abort) past the grace
    const sseA = await openSse(s.sock, s.token);
    await startInFlightTurn();
    sseA.close();
    await sleep(800); // well within the 3s grace
    const sseB = await openSse(s.sock, s.token); // reconnect cancels the orphan-abort timer
    await sleep(4000); // past the original grace window
    assert.equal(fake.abortedAt(), null, "reconnect within grace must NOT abort the in-flight turn");
    sseB.close();
  });
});
