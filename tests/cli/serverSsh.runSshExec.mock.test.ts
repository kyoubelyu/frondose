/**
 * P-41 Step 5 — T-Exec.1-4 (G-P41.1)
 *
 * Tests for runSshExec: Promise-based SSH exec wrapper with fake ClientCtor DI.
 * No real SSH required — all driven by EventEmitter fakes.
 *
 * Gate covered: G-P41.1
 *
 * TIMING NOTE: runSshExec's Promise executor runs SYNCHRONOUSLY — new ClientCtor()
 * is called before runSshExec returns. connect() schedules setImmediate(emit_ready).
 * To avoid a race, set execHandler synchronously on instances[0] BEFORE the first
 * `await`, which is before any setImmediate fires.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { runSshExec, type SshExecResult, type SshTarget, type SshWsDeps } from "../../src/cli/serverSsh.js";

// ─── Fake ClientCtor factory ──────────────────────────────────────────────────

interface FakeChannel extends EventEmitter {
  stderr: EventEmitter;
  writtenData: string[];
  ended: boolean;
  end(data?: Buffer | string): void;
}

interface FakeClientInstance extends EventEmitter {
  execHandler?: (cmd: string, cb: (err: Error | null, channel: FakeChannel | null) => void) => void;
  exec(cmd: string, cb: (err: Error | null, channel: FakeChannel | null) => void): void;
  connect(opts: Record<string, unknown>): void;
  end(): void;
}

/** Build a FakeChannel that records `.end(data)` calls. */
function makeFakeChannel(): FakeChannel {
  const ch = new EventEmitter() as FakeChannel;
  ch.stderr = new EventEmitter();
  ch.writtenData = [];
  ch.ended = false;
  ch.end = (data?: Buffer | string) => {
    if (data !== undefined) ch.writtenData.push(typeof data === "string" ? data : data.toString("utf-8"));
    ch.ended = true;
  };
  return ch;
}

/**
 * Create a fake `ClientCtor`.
 * The instance is created SYNCHRONOUSLY inside runSshExec's Promise executor,
 * so instances[0] is available immediately after the runSshExec() call returns.
 * Set execHandler synchronously BEFORE any await to avoid the setImmediate race.
 */
function makeFakeClientCtor(): {
  ClientCtor: new () => FakeClientInstance;
  instances: FakeClientInstance[];
} {
  const instances: FakeClientInstance[] = [];

  class FakeClient extends EventEmitter implements FakeClientInstance {
    execHandler?: (cmd: string, cb: (err: Error | null, channel: FakeChannel | null) => void) => void;
    constructor() {
      super();
      instances.push(this);
    }
    exec(cmd: string, cb: (err: Error | null, channel: FakeChannel | null) => void): void {
      if (this.execHandler) {
        this.execHandler(cmd, cb);
      } else {
        cb(new Error("execHandler not configured"), null);
      }
    }
    connect(_opts: Record<string, unknown>): void {
      setImmediate(() => this.emit("ready"));
    }
    end(): void {
      /* no-op in fake */
    }
  }

  return { ClientCtor: FakeClient, instances };
}

const FAKE_TARGET: SshTarget = { workerId: "w1", host: "fake-host", user: "fake-user", port: 22 };

// ─── T-Exec.1 ─────────────────────────────────────────────────────────────────

describe("runSshExec — happy path (G-P41.1)", () => {
  it("T-Exec.1: when fake channel emits stdout 'hi' + close code 0, runSshExec resolves { stdout:'hi', stderr:'', code:0 }", async () => {
    // Given: fake ClientCtor whose channel emits data("hi") then exit(0) then close
    // When:  runSshExec(target, "echo hi", undefined, { ClientCtor })
    // Then:  resolves { stdout:"hi", stderr:"", code:0 }
    const { ClientCtor, instances } = makeFakeClientCtor();
    const deps: SshWsDeps = { ClientCtor: ClientCtor as unknown as typeof import("ssh2").Client };

    // runSshExec's Promise executor runs SYNCHRONOUSLY:
    // - new ClientCtor() pushes to instances immediately
    // - connect() schedules setImmediate(emit_ready)
    // Set execHandler BEFORE any await (before setImmediate fires).
    const promise = runSshExec(FAKE_TARGET, "echo hi", undefined, deps);

    const client = instances[0];
    assert.ok(client, "T-Exec.1: FakeClient instance must be created synchronously");

    let execHandlerInstalled = false;
    client.execHandler = (_cmd, cb) => {
      const channel = makeFakeChannel();
      execHandlerInstalled = true;
      cb(null, channel);
      setImmediate(() => {
        channel.emit("data", Buffer.from("hi"));
        channel.emit("exit", 0);
        channel.emit("close");
      });
    };

    const result: SshExecResult = await promise;

    assert.ok(execHandlerInstalled, "T-Exec.1: exec handler must have been called");
    assert.deepEqual(
      result,
      { stdout: "hi", stderr: "", code: 0 },
      "T-Exec.1: must resolve {stdout:'hi', stderr:'', code:0}",
    );
  });
});

// ─── T-Exec.2 ─────────────────────────────────────────────────────────────────

describe("runSshExec — non-zero exit RESOLVES (G-P41.1)", () => {
  it("T-Exec.2: when fake channel emits exit(7) + close, runSshExec resolves with code:7 (does NOT reject)", async () => {
    // Given: fake ClientCtor whose channel emits exit(7) then close (no stdout/stderr)
    // When:  runSshExec(target, "false", undefined, { ClientCtor })
    // Then:  resolves { stdout:"", stderr:"", code:7 } — non-zero code must RESOLVE not reject
    const { ClientCtor, instances } = makeFakeClientCtor();
    const deps: SshWsDeps = { ClientCtor: ClientCtor as unknown as typeof import("ssh2").Client };

    const promise = runSshExec(FAKE_TARGET, "false", undefined, deps);

    // Set execHandler synchronously before ready fires.
    const client = instances[0];
    client.execHandler = (_cmd, cb) => {
      const ch = makeFakeChannel();
      cb(null, ch);
      setImmediate(() => {
        ch.emit("exit", 7);
        ch.emit("close");
      });
    };

    let result: SshExecResult;
    try {
      result = await promise;
    } catch (e) {
      assert.fail(`T-Exec.2: runSshExec must RESOLVE with code:7, not reject; error: ${e}`);
      return;
    }

    assert.equal(result.code, 7, "T-Exec.2: code must be 7");
    assert.equal(result.stdout, "", "T-Exec.2: stdout must be empty");
    assert.equal(result.stderr, "", "T-Exec.2: stderr must be empty");
  });
});

// ─── T-Exec.3 ─────────────────────────────────────────────────────────────────

describe("runSshExec — connect error REJECTS (G-P41.1)", () => {
  it("T-Exec.3: when fake client emits 'error' event before ready, runSshExec rejects with that error", async () => {
    // Given: fake ClientCtor whose client emits error("ECONNREFUSED") immediately
    // When:  runSshExec(target, "ls", undefined, { ClientCtor })
    // Then:  the returned promise REJECTS with the emitted error
    const instances: FakeClientInstance[] = [];

    class ErrorClient extends EventEmitter implements FakeClientInstance {
      constructor() {
        super();
        instances.push(this);
      }
      exec(_cmd: string, _cb: (err: Error | null, ch: FakeChannel | null) => void): void {
        /* never called */
      }
      connect(_opts: Record<string, unknown>): void {
        setImmediate(() => this.emit("error", new Error("ECONNREFUSED")));
      }
      end(): void {
        /* no-op */
      }
    }

    const deps: SshWsDeps = {
      ClientCtor: ErrorClient as unknown as typeof import("ssh2").Client,
    };

    try {
      await runSshExec(FAKE_TARGET, "ls", undefined, deps);
      assert.fail("T-Exec.3: runSshExec must REJECT when the client emits an error event");
    } catch (e) {
      assert.ok(e instanceof Error, "T-Exec.3: rejected value must be an Error");
      assert.ok(
        (e as Error).message.includes("ECONNREFUSED"),
        `T-Exec.3: error message must include 'ECONNREFUSED'; got: ${(e as Error).message}`,
      );
    }
  });
});

// ─── T-Exec.4 ─────────────────────────────────────────────────────────────────

describe("runSshExec — stdinData written + channel EOF (G-P41.1)", () => {
  it("T-Exec.4: when stdinData='#!/bin/bash\\necho done', the fake channel's writtenData includes it and ended===true", async () => {
    // Given: fake ClientCtor with recording channel; stdinData = "#!/bin/bash\necho done"
    // When:  runSshExec(target, "bash -s", "#!/bin/bash\necho done", { ClientCtor })
    // Then:  channel.writtenData includes "#!/bin/bash\necho done"; channel.ended === true
    const { ClientCtor, instances } = makeFakeClientCtor();
    const deps: SshWsDeps = { ClientCtor: ClientCtor as unknown as typeof import("ssh2").Client };

    const stdinData = "#!/bin/bash\necho done";
    let capturedChannel: FakeChannel | null = null;

    const promise = runSshExec(FAKE_TARGET, "bash -s", stdinData, deps);

    // Set execHandler synchronously before ready fires.
    const client = instances[0];
    client.execHandler = (_cmd, cb) => {
      const ch = makeFakeChannel();
      capturedChannel = ch;
      cb(null, ch);
      setImmediate(() => {
        ch.emit("exit", 0);
        ch.emit("close");
      });
    };

    await promise;

    assert.ok(capturedChannel !== null, "T-Exec.4: channel must have been created");
    const ch = capturedChannel as FakeChannel;
    assert.ok(ch.ended, "T-Exec.4: channel.ended must be true (write-side closed = EOF)");
    assert.ok(
      ch.writtenData.some((d) => d === stdinData),
      `T-Exec.4: channel.writtenData must include the stdinData; got: ${JSON.stringify(ch.writtenData)}`,
    );
  });
});

// re-export helpers for any future use
export { makeFakeChannel, makeFakeClientCtor };
export type { FakeChannel, FakeClientInstance };
