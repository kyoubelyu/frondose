/**
 * P-30 Step 5 — T-UPG.1-6 + T-UPG.attachWebSockets
 *
 * Mock tests for src/cli/serverWeb.ts — attachWebSockets WS upgrade handler.
 * Strategy: fake EventEmitter server + fake Duplex socket; real wss.handleUpgrade
 * requires `socket.setTimeout` and `socket.setNoDelay` stubs (added at Step 5).
 *
 * D-7 (Step-3b B-1 Option A): WS auth = Basic-Auth Authorization header.
 * NO ?token= query parameter.
 *
 * Gate coverage:
 *   T-UPG.1 — G-P30.4: valid Authorization header → upgrade accepted (no 401)
 *   T-UPG.2 — G-P30.4: missing/wrong Authorization header → 401 + socket destroyed
 *   T-UPG.3 — G-P30.5: webToken undefined → upgrade accepted with no header
 *   T-UPG.4 — G-P30.6: /ws/ssh/<id> + /ws/vnc/<id> → 101 WS upgrade; /ws/other → socket destroyed
 *   T-UPG.5 — G-P30.7: unknown/inactive worker_id → socket destroyed, no HTTP response
 *   T-UPG.6 — G-P30.18: P-29 HTTP routes unchanged (regression)
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { attachWebSockets, checkBasicAuth, startWebHttp, type WebHttpDeps } from "../../src/cli/serverWeb.js";
import { addWorker, openWorkersDb } from "../../src/persistence/workersRegistry.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function base64Creds(user: string, pass: string): string {
  return Buffer.from(`${user}:${pass}`).toString("base64");
}

/**
 * Fake socket for ws upgrade tests. Extends EventEmitter with the minimal
 * net.Socket surface that ws.handleUpgrade needs:
 *   - write() — records chunks, does NOT echo back (avoids ws receiver corruption)
 *   - destroy() — sets destroyCalled flag + emits 'close'
 *   - resume() / setTimeout() / setNoDelay() — no-ops
 *   - readable / writable booleans (ws checks these)
 *
 * Using EventEmitter directly (not PassThrough) prevents the PassThrough
 * echo-back that caused `Invalid WebSocket frame: RSV1 must be clear`.
 */
interface FakeSocket extends EventEmitter {
  writtenChunks: Buffer[];
  destroyCalled: boolean;
  write(chunk: unknown): boolean;
  destroy(err?: Error): this;
  end(): this;
  resume(): this;
  setTimeout(ms: number): this;
  setNoDelay(noDelay?: boolean): this;
  readonly readable: boolean;
  readonly writable: boolean;
}

function makeFakeDuplex(): { socket: FakeSocket } {
  const writtenChunks: Buffer[] = [];
  let destroyCalled = false;

  const socket = new EventEmitter() as FakeSocket;
  Object.defineProperty(socket, "writtenChunks", { get: () => writtenChunks, enumerable: true });
  Object.defineProperty(socket, "destroyCalled", { get: () => destroyCalled, enumerable: true });
  Object.defineProperty(socket, "readable", { get: () => true, enumerable: true });
  Object.defineProperty(socket, "writable", { get: () => true, enumerable: true });

  socket.write = (chunk: unknown): boolean => {
    writtenChunks.push(Buffer.isBuffer(chunk) ? (chunk as Buffer) : Buffer.from(chunk as string));
    return true;
  };
  socket.destroy = (_err?: Error): FakeSocket => {
    destroyCalled = true;
    socket.emit("close");
    return socket;
  };
  socket.end = (): FakeSocket => {
    socket.emit("close");
    return socket;
  };
  socket.resume = (): FakeSocket => socket;
  socket.setTimeout = (_ms: number): FakeSocket => socket;
  socket.setNoDelay = (_nd?: boolean): FakeSocket => socket;

  return { socket };
}

/** Fake server: a plain EventEmitter that looks like an http.Server to attachWebSockets. */
function makeFakeServer(): EventEmitter {
  return new EventEmitter();
}

function makeWebHttpDeps(withWorker?: { id: string; hostname: string }): {
  deps: WebHttpDeps;
  assetDir: string;
  cleanup: () => void;
} {
  const assetDir = mkdtempSync(join(tmpdir(), "mai-p30-upgrade-"));
  writeFileSync(join(assetDir, "index.html"), "<html>mai</html>", "utf-8");

  const workersDb = openWorkersDb(":memory:");
  if (withWorker) {
    addWorker(workersDb, withWorker.id, "tok-" + withWorker.id, withWorker.hostname);
  }

  const deps: WebHttpDeps = {
    workersDb,
    memoryDb: null,
    invitesDb: null,
    personasDir: assetDir,
    serverUrl: "http://127.0.0.1:3031",
    assetRoot: assetDir,
    sshUser: null,
    sshPort: 22,
    workersConfigDir: assetDir, // empty dir → no per-worker JSON
  };

  return {
    deps,
    assetDir,
    cleanup: () => {
      workersDb.close();
      rmSync(assetDir, { recursive: true, force: true });
    },
  };
}

/** Build a fake IncomingMessage with valid WebSocket upgrade headers.
 *  ws.handleUpgrade requires Upgrade: websocket, Sec-WebSocket-Key, version 13. */
function makeWsUpgradeReq(url: string, authHeader?: string): IncomingMessage {
  return {
    method: "GET",
    url,
    httpVersion: "1.1",
    headers: {
      ...(authHeader ? { authorization: authHeader } : {}),
      upgrade: "websocket",
      connection: "upgrade",
      "sec-websocket-key": Buffer.alloc(16).toString("base64"),
      "sec-websocket-version": "13",
      host: "127.0.0.1",
    },
  } as unknown as IncomingMessage;
}

// ─── T-UPG.1 ─────────────────────────────────────────────────────────────────

describe("T-UPG: attachWebSockets upgrade handler (G-P30.4, G-P30.5, G-P30.6, G-P30.7, G-P30.18)", () => {
  it("T-UPG.1: given webToken set, an upgrade with valid Authorization: Basic header → upgrade accepted (no 401)", async () => {
    // Given: a fake server; webToken='s'; worker 'w1' active; upgrade req with valid Authorization
    // When:  attachWebSockets registers upgrade listener; server emits upgrade event
    // Then:  socket gets 101 Switching Protocols (NOT 401 Unauthorized)

    const { deps, cleanup } = makeWebHttpDeps({ id: "w1", hostname: "192.168.1.5" });
    const server = makeFakeServer();
    try {
      attachWebSockets(server as unknown as import("node:http").Server, deps, "s");

      const { socket } = makeFakeDuplex();
      const fakeReq = makeWsUpgradeReq("/ws/ssh/w1", `Basic ${base64Creds("op", "s")}`);
      server.emit("upgrade", fakeReq, socket, Buffer.alloc(0));
      await new Promise((r) => setTimeout(r, 40));

      const writes = Buffer.concat(socket.writtenChunks).toString("binary");
      assert.ok(
        !writes.includes("401"),
        `T-UPG.1: valid auth must NOT produce HTTP 401; got writes: ${writes.slice(0, 200)}`,
      );
      assert.ok(
        writes.includes("101 Switching Protocols"),
        `T-UPG.1: valid auth must produce 101 Switching Protocols; got: ${writes.slice(0, 200)}`,
      );
    } finally {
      cleanup();
    }
  });

  it("T-UPG.2: given webToken set, an upgrade with no/wrong Authorization header → socket gets HTTP/1.1 401 + WWW-Authenticate, then destroyed", async () => {
    // Given: fake server; webToken='s'; upgrade req with NO Authorization header
    // When:  upgrade fires
    // Then:  socket.write contains 'HTTP/1.1 401' and 'WWW-Authenticate'; socket.destroy() called

    const { deps, cleanup } = makeWebHttpDeps({ id: "w1", hostname: "h" });
    const server = makeFakeServer();
    try {
      attachWebSockets(server as unknown as import("node:http").Server, deps, "s");

      const { socket } = makeFakeDuplex();
      const fakeReq = {
        method: "GET",
        url: "/ws/ssh/w1",
        headers: {}, // no Authorization
      } as unknown as IncomingMessage;
      server.emit("upgrade", fakeReq, socket, Buffer.alloc(0));
      await new Promise((r) => setTimeout(r, 30));

      const writes = Buffer.concat(socket.writtenChunks).toString("binary");
      assert.ok(writes.includes("401"), `T-UPG.2: missing auth must produce HTTP 401; got: ${writes.slice(0, 200)}`);
      assert.ok(
        writes.toLowerCase().includes("www-authenticate"),
        "T-UPG.2: 401 response must include WWW-Authenticate header",
      );
      assert.ok(socket.destroyCalled, "T-UPG.2: socket must be destroyed after 401");
    } finally {
      cleanup();
    }
  });

  it("T-UPG.3: given webToken undefined, upgrade request with no Authorization header → upgrade accepted (no-auth mode)", async () => {
    // Given: checkBasicAuth(req, undefined) returns true; no-auth mode
    // When:  upgrade with no Authorization header, webToken=undefined
    // Then:  checkBasicAuth returns true; socket NOT sent 401

    // Direct unit assertion on checkBasicAuth:
    const fakeReq0 = { headers: {} } as unknown as IncomingMessage;
    const result = checkBasicAuth(fakeReq0, undefined);
    assert.equal(result, true, "T-UPG.3: checkBasicAuth(req, undefined) must return true (no-auth mode)");

    const { deps, cleanup } = makeWebHttpDeps({ id: "w1", hostname: "h" });
    const server = makeFakeServer();
    try {
      attachWebSockets(server as unknown as import("node:http").Server, deps, undefined);

      const { socket } = makeFakeDuplex();
      const fakeReq = {
        method: "GET",
        url: "/ws/ssh/w1",
        headers: {}, // no Authorization — should still pass in no-auth mode
      } as unknown as IncomingMessage;
      server.emit("upgrade", fakeReq, socket, Buffer.alloc(0));
      await new Promise((r) => setTimeout(r, 30));

      const writes = Buffer.concat(socket.writtenChunks).toString("binary");
      assert.ok(!writes.includes("401"), `T-UPG.3: no-auth mode must NOT produce 401; got: ${writes.slice(0, 200)}`);
    } finally {
      cleanup();
    }
  });

  it("T-UPG.4: /ws/ssh/<id> → 101 WS upgrade; /ws/vnc/<id> → 101 WS upgrade; /ws/other/<id> → socket destroyed immediately with no response", async () => {
    // Given: fake server + no-auth; worker 'w1' active
    // When:  three upgrade events: /ws/ssh/w1, /ws/vnc/w1, /ws/other/w1
    // Then:  SSH/VNC → 101 Switching Protocols; other → socket.destroyCalled=true, writtenChunks empty

    const { deps, cleanup } = makeWebHttpDeps({ id: "w1", hostname: "h" });
    const server = makeFakeServer();
    try {
      attachWebSockets(server as unknown as import("node:http").Server, deps, undefined);

      // /ws/ssh/w1 — should get 101
      const { socket: sshSocket } = makeFakeDuplex();
      server.emit("upgrade", makeWsUpgradeReq("/ws/ssh/w1"), sshSocket, Buffer.alloc(0));
      await new Promise((r) => setTimeout(r, 40));
      const sshWrites = Buffer.concat(sshSocket.writtenChunks).toString("binary");
      assert.ok(
        sshWrites.includes("101 Switching Protocols"),
        `T-UPG.4: /ws/ssh must get 101; got: ${sshWrites.slice(0, 200)}`,
      );

      // /ws/vnc/w1 — should get 101 (handleVncWs called and may close immediately,
      //               but the 101 is already written by wss.handleUpgrade before the callback)
      const { socket: vncSocket } = makeFakeDuplex();
      server.emit("upgrade", makeWsUpgradeReq("/ws/vnc/w1"), vncSocket, Buffer.alloc(0));
      await new Promise((r) => setTimeout(r, 40));
      const vncWrites = Buffer.concat(vncSocket.writtenChunks).toString("binary");
      assert.ok(
        vncWrites.includes("101 Switching Protocols"),
        `T-UPG.4: /ws/vnc must get 101; got: ${vncWrites.slice(0, 200)}`,
      );

      // /ws/other/w1 — unknown path → socket.destroy() immediately, no write
      const { socket: otherSocket } = makeFakeDuplex();
      const otherReq = {
        method: "GET",
        url: "/ws/other/w1",
        headers: {},
      } as unknown as IncomingMessage;
      server.emit("upgrade", otherReq, otherSocket, Buffer.alloc(0));
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(otherSocket.destroyCalled, "T-UPG.4: /ws/other must destroy socket");
      assert.equal(otherSocket.writtenChunks.length, 0, "T-UPG.4: /ws/other must write nothing before destroy");
    } finally {
      cleanup();
    }
  });

  it("T-UPG.5: given /ws/ssh/ghost where 'ghost' is not an active worker, socket is destroyed without dispatching handleSshWs", async () => {
    // Given: fake server + no-auth; workersDb has NO worker 'ghost'
    // When:  upgrade for /ws/ssh/ghost
    // Then:  socket.destroy() called with no HTTP response written

    const { deps, cleanup } = makeWebHttpDeps(); // no worker registered
    const server = makeFakeServer();
    try {
      attachWebSockets(server as unknown as import("node:http").Server, deps, undefined);

      const { socket } = makeFakeDuplex();
      const fakeReq = {
        method: "GET",
        url: "/ws/ssh/ghost",
        headers: {},
      } as unknown as IncomingMessage;
      server.emit("upgrade", fakeReq, socket, Buffer.alloc(0));
      await new Promise((r) => setTimeout(r, 30));

      assert.ok(socket.destroyCalled, "T-UPG.5: unknown worker must destroy socket");
      assert.equal(
        socket.writtenChunks.length,
        0,
        "T-UPG.5: unknown worker must write nothing before destroy (not 401)",
      );
    } finally {
      cleanup();
    }
  });

  it("T-UPG.6 (regression): GET /api/web/workers still returns 200 + workers array after attachWebSockets is wired up", async () => {
    // Given: startWebHttp with attachWebSockets wired (P-30 builder wires it in startWebHttp)
    // When:  normal GET /api/web/workers request (not a WS upgrade)
    // Then:  200 JSON {workers:[...]} — P-29 behavior unchanged

    const { deps, cleanup: depsCleanup } = makeWebHttpDeps({ id: "w1", hostname: "h" });
    const server = startWebHttp(deps, 0, "127.0.0.1", undefined);
    server.unref();

    const port = await new Promise<number>((resolve) => {
      server.once("listening", () => {
        resolve((server.address() as { port: number }).port);
      });
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/web/workers`);
      assert.equal(res.status, 200, "T-UPG.6: GET /api/web/workers must return 200");
      const body = (await res.json()) as { workers: unknown[] };
      assert.ok(Array.isArray(body.workers), "T-UPG.6: response must have workers array");
      assert.equal(body.workers.length, 1, "T-UPG.6: workers array must contain 1 worker (w1)");
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      depsCleanup();
    }
  });
});

// ─── attachWebSockets direct unit test ────────────────────────────────────────

describe("T-UPG.attachWebSockets: direct stub behavior (G-P30.4)", () => {
  it("T-UPG.attachWebSockets: attachWebSockets is exported and callable without throwing", () => {
    // Given: a fake server EventEmitter; deps; webToken
    // When:  attachWebSockets(server, deps, webToken) is called
    // Then:  typeof === 'function'; call does not throw (upgrade listener registered)

    assert.equal(typeof attachWebSockets, "function", "T-UPG.attachWebSockets: must be exported as function");

    const { deps, cleanup } = makeWebHttpDeps();
    const fakeServer = new EventEmitter() as unknown as import("node:http").Server;
    try {
      assert.doesNotThrow(
        () => attachWebSockets(fakeServer, deps, undefined),
        "T-UPG.attachWebSockets: must not throw when registering upgrade handler",
      );
      // verify the upgrade listener was registered
      assert.ok(
        (fakeServer as unknown as EventEmitter).listenerCount("upgrade") > 0,
        "T-UPG.attachWebSockets: must register an 'upgrade' listener on the server",
      );
    } finally {
      cleanup();
    }
  });
});
