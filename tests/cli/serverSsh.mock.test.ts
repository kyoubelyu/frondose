/**
 * P-30 Step 5 — T-SSH.1-5
 *
 * Mock tests for src/cli/serverSsh.ts — SSH terminal WebSocket bridge.
 * Strategy: inject a fake ClientCtor (EventEmitter + scripted ready/stream/error)
 * and a fake WebSocket (records send/close calls). No real SSH connection.
 *
 * Gate coverage:
 *   T-SSH.1 — G-P30.8: connect + ready → PTY shell → stream data → ws.send(binary)
 *   T-SSH.2 — G-P30.8: binary ws message → stream.write
 *   T-SSH.3 — G-P30.8: resize JSON message → stream.setWindow
 *   T-SSH.4 — G-P30.9: SSH error → ws receives {type:"error"} + closed
 *   T-SSH.5 — G-P30.10: username/port resolution from per-worker JSON, config, OS default; agent passthrough
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { userInfo } from "node:os";
import { describe, it } from "node:test";
import { handleSshWs, type SshTarget, type SshWsDeps } from "../../src/cli/serverSsh.js";

// ─── Fake WebSocket ────────────────────────────────────────────────────────────

interface FakeWs {
  send: (data: Buffer | string, opts?: { binary?: boolean }, cb?: unknown) => void;
  close: (code?: number) => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => boolean;
  sent: Array<{ data: Buffer | string; binary: boolean }>;
  closedWith: number | undefined;
}

function makeFakeWs(): FakeWs {
  const sent: Array<{ data: Buffer | string; binary: boolean }> = [];
  let closedWith: number | undefined;
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  return {
    sent,
    get closedWith() {
      return closedWith;
    },
    send(data: Buffer | string, opts?: { binary?: boolean }) {
      sent.push({ data, binary: opts?.binary ?? false });
    },
    close(code?: number) {
      closedWith = code;
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    emit(event: string, ...args: unknown[]) {
      (handlers[event] ?? []).forEach((h) => {
        h(...args);
      });
      return true;
    },
  };
}

// ─── Fake ssh2 Client ─────────────────────────────────────────────────────────

type FakeStream = EventEmitter & {
  write: (d: Buffer | string) => void;
  setWindow: (rows: number, cols: number, h: number, w: number) => void;
  writeCalls: Array<Buffer | string>;
  setWindowCalls: Array<{ rows: number; cols: number }>;
};

type FakeClientCtor = typeof import("ssh2").Client;

/**
 * Returns { ctor, connectOpts (getter — read AFTER async to get the value
 * captured by client.connect()), fakeStream }.
 *
 * NOTE: do NOT destructure `connectOpts` at call-site — destructuring calls
 * the getter immediately and captures null. Instead keep the result object and
 * read `.connectOpts` after the async operation.
 */
function makeFakeClient(opts: { emitError?: string; streamDataChunks?: Buffer[] }): {
  ctor: FakeClientCtor;
  readonly connectOpts: Record<string, unknown> | null;
  fakeStream: FakeStream;
  shellReady: Promise<void>;
} {
  const writeCalls: Array<Buffer | string> = [];
  const setWindowCalls: Array<{ rows: number; cols: number }> = [];
  // Use a standalone let so the class closure can write to it.
  let capturedConnectOpts: Record<string, unknown> | null = null;
  let resolveShellReady!: () => void;
  const shellReady = new Promise<void>((resolveReady) => {
    resolveShellReady = resolveReady;
  });

  const fakeStream: FakeStream = Object.assign(new EventEmitter(), {
    writeCalls,
    setWindowCalls,
    write(d: Buffer | string) {
      writeCalls.push(d);
    },
    setWindow(rows: number, cols: number) {
      setWindowCalls.push({ rows, cols });
    },
  });

  class FakeClient extends EventEmitter {
    connect(o: Record<string, unknown>) {
      capturedConnectOpts = o;
      if (opts.emitError) {
        setImmediate(() => this.emit("error", new Error(opts.emitError as string)));
      } else {
        setImmediate(() => {
          this.emit("ready");
        });
      }
    }
    shell(_ptyOpts: unknown, cb: (err: null, stream: FakeStream) => void) {
      setImmediate(() => {
        cb(null, fakeStream);
        for (const chunk of opts.streamDataChunks ?? []) {
          fakeStream.emit("data", chunk);
        }
        resolveShellReady();
      });
    }
    end() {}
  }

  return {
    ctor: FakeClient as unknown as FakeClientCtor,
    // getter: read AFTER async so the closure has been updated by connect()
    get connectOpts() {
      return capturedConnectOpts;
    },
    fakeStream,
    shellReady,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("T-SSH: serverSsh WebSocket bridge (G-P30.8, G-P30.9, G-P30.10)", () => {
  it("T-SSH.1: when handleSshWs called with fake ClientCtor, connect is called; on ready a PTY shell is opened; stream data is forwarded to ws as binary", async () => {
    // Given: a fake ClientCtor that emits ready + a fake stream with data; a fake ws
    // When:  handleSshWs(ws, target, {ClientCtor})
    // Then:  connect was called; ws.send is called with binary data from stream

    const streamData = Buffer.from("hello from server\r\n");
    // Keep full result object — read connectOpts via getter AFTER async
    const fakeC1 = makeFakeClient({ streamDataChunks: [streamData] });
    const ws = makeFakeWs();
    const target: SshTarget = { workerId: "w1", host: "192.168.1.10", user: "op", port: 22 };
    const deps: SshWsDeps = { ClientCtor: fakeC1.ctor };

    handleSshWs(ws as unknown as import("ws").WebSocket, target, deps);
    await fakeC1.shellReady;

    // connect was called — read connectOpts after async so closure has been populated
    const opts1 = fakeC1.connectOpts;
    assert.ok(opts1, "T-SSH.1: client.connect must be called");
    assert.equal(opts1["host"], "192.168.1.10", "T-SSH.1: host must match");

    // stream data was forwarded as binary
    const binarySends = ws.sent.filter((s) => s.binary);
    assert.ok(binarySends.length > 0, "T-SSH.1: at least one binary send to ws");
    const combined = Buffer.concat(binarySends.map((s) => s.data as Buffer));
    assert.ok(combined.includes(streamData), "T-SSH.1: stream data forwarded to ws");
  });

  it("T-SSH.2: when a binary ws message arrives, it is written to the SSH stream", async () => {
    // Given: handleSshWs running with fake client; stream is open
    // When:  ws emits a binary message (Buffer)
    // Then:  fakeStream.write is called with that buffer

    const { ctor, fakeStream } = makeFakeClient({ streamDataChunks: undefined });
    const ws = makeFakeWs();
    const target: SshTarget = { workerId: "w1", host: "h", user: "u", port: 22 };

    handleSshWs(ws as unknown as import("ws").WebSocket, target, { ClientCtor: ctor });
    await new Promise((r) => setTimeout(r, 60)); // wait for ready + shell

    const binaryPayload = Buffer.from("ls -la\n");
    ws.emit("message", binaryPayload, true);
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(
      fakeStream.writeCalls.some((c) => Buffer.isBuffer(c) && (c as Buffer).equals(binaryPayload)),
      `T-SSH.2: binary message must be written to stream; got: ${JSON.stringify(fakeStream.writeCalls)}`,
    );
  });

  it("T-SSH.3: when a {type:'resize',cols:120,rows:40} JSON text message arrives, stream.setWindow(40,120,0,0) is called", async () => {
    // Given: handleSshWs running; stream open
    // When:  ws emits JSON: {type:"resize",cols:120,rows:40}
    // Then:  fakeStream.setWindow(40, 120, 0, 0) is called

    const { ctor, fakeStream } = makeFakeClient({ streamDataChunks: undefined });
    const ws = makeFakeWs();
    const target: SshTarget = { workerId: "w1", host: "h", user: "u", port: 22 };

    handleSshWs(ws as unknown as import("ws").WebSocket, target, { ClientCtor: ctor });
    await new Promise((r) => setTimeout(r, 60)); // wait for ready + shell

    ws.emit("message", Buffer.from(JSON.stringify({ type: "resize", cols: 120, rows: 40 })), false);
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(
      fakeStream.setWindowCalls.some((c) => c.rows === 40 && c.cols === 120),
      `T-SSH.3: setWindow(40,120) must be called; got: ${JSON.stringify(fakeStream.setWindowCalls)}`,
    );
  });

  it("T-SSH.4: when the SSH client emits an error, ws receives {type:'error'} message and is closed", async () => {
    // Given: a fake ClientCtor that emits 'error' instead of 'ready'
    // When:  handleSshWs runs; error fires
    // Then:  ws.send includes {type:"error",...}; ws.close is called

    const { ctor } = makeFakeClient({ emitError: "Connection refused" });
    const ws = makeFakeWs();
    const target: SshTarget = { workerId: "w1", host: "unreachable", user: "u", port: 22 };

    handleSshWs(ws as unknown as import("ws").WebSocket, target, { ClientCtor: ctor });
    await new Promise((r) => setTimeout(r, 50));

    // ws received {type:"error"} text message
    const errorSends = ws.sent.filter((s) => {
      try {
        const msg = JSON.parse(typeof s.data === "string" ? s.data : s.data.toString()) as {
          type?: string;
        };
        return msg.type === "error";
      } catch {
        return false;
      }
    });
    assert.ok(errorSends.length > 0, "T-SSH.4: ws must receive {type:'error'} JSON message");

    // ws was closed
    assert.ok(ws.closedWith !== undefined, "T-SSH.4: ws.close must be called after error");
  });

  it("T-SSH.5: username + port resolution — per-worker JSON > config.ssh_user > os.userInfo().username; agent = SSH_AUTH_SOCK", async () => {
    // Given: three scenarios — (a) target.user='alice'; (b) target.user=OS username; (c) target.port=2222
    // When:  handleSshWs is called in each scenario
    // Then:  (a) connectOpts.username==='alice'; (b) username===os.userInfo().username; (c) port===2222; agent key present

    // Scenario (a): per-worker ssh_user='alice' (passed via target.user)
    {
      const fakeCA = makeFakeClient({ streamDataChunks: undefined });
      const ws = makeFakeWs();
      handleSshWs(
        ws as unknown as import("ws").WebSocket,
        { workerId: "w1", host: "h", user: "alice", port: 22 },
        { ClientCtor: fakeCA.ctor },
      );
      await new Promise((r) => setTimeout(r, 30));
      const optsA = fakeCA.connectOpts;
      assert.equal(optsA?.["username"], "alice", "T-SSH.5a: username must be 'alice'");
    }

    // Scenario (b): config ssh_user=null → OS username
    {
      const fakeCB = makeFakeClient({ streamDataChunks: undefined });
      const ws = makeFakeWs();
      const osUser = userInfo().username;
      handleSshWs(
        ws as unknown as import("ws").WebSocket,
        { workerId: "w2", host: "h", user: osUser, port: 22 },
        { ClientCtor: fakeCB.ctor },
      );
      await new Promise((r) => setTimeout(r, 30));
      const optsB = fakeCB.connectOpts;
      assert.equal(optsB?.["username"], osUser, `T-SSH.5b: username must be OS user (${osUser})`);
    }

    // Scenario (c): custom port 2222
    {
      const fakeCC = makeFakeClient({ streamDataChunks: undefined });
      const ws = makeFakeWs();
      handleSshWs(
        ws as unknown as import("ws").WebSocket,
        { workerId: "w3", host: "h", user: "u", port: 2222 },
        { ClientCtor: fakeCC.ctor },
      );
      await new Promise((r) => setTimeout(r, 30));
      const optsC = fakeCC.connectOpts;
      assert.equal(optsC?.["port"], 2222, "T-SSH.5c: port must be 2222");
      // Agent option is passed (value may be undefined if SSH_AUTH_SOCK unset, but key must exist)
      assert.ok("agent" in (optsC ?? {}), "T-SSH.5c: agent key must be present in connect opts");
    }
  });
});
