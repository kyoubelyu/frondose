/**
 * WIN-1 — TCP transport scaffold (Step 3, outside-in TDD).
 *
 * All assertion bodies are TODO — these tests intentionally FAIL against the
 * current UDS codebase.  Step 4 (builder) makes them compile + reach the
 * assertion-TODO branch; Step 5 (validator) fills the assertion bodies.
 *
 * Gates covered:
 *   G-WIN1.Transport  — T-WIN1.Listen.1, T-WIN1.Listen.2
 *   G-WIN1.Handshake  — T-WIN1.PortFile.1
 *   G-WIN1.Args       — T-WIN1.Args.1, T-WIN1.Args.2
 *   G-WIN1.NoUDS      — T-WIN1.Cleanup.1
 *
 * Run (standalone):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/cli/subcommands/serve/tcp-transport.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// ─── §1  G-WIN1.Transport ─────────────────────────────────────────────────────

describe("G-WIN1.Transport — serve binds 127.0.0.1:0 and writes port-file", () => {

  it("T-WIN1.Listen.1: when runServeSubcommand binds, it calls server.listen(0, '127.0.0.1') and the resolved address.family is IPv4", async () => {
    // Given: a fresh ServeOpts with a portFile path and a bearerToken
    // When:  runServeSubcommand starts (or the listen call is inspected via a module mock of createServer)
    // Then:  the resolved address is { address: '127.0.0.1', family: 'IPv4' } and port > 0

    // serve.ts actually binds loopback:0 (source contract) ...
    const src = readFileSync(join(process.cwd(), "src/cli/subcommands/serve.ts"), "utf-8");
    assert.ok(
      /server\.listen\(\s*0\s*,\s*["']127\.0\.0\.1["']/.test(src),
      "serve.ts must call server.listen(0, '127.0.0.1') (loopback ephemeral port)",
    );
    // ... and a loopback :0 bind resolves to an IPv4 127.0.0.1 address with port > 0.
    const server = createServer();
    const addr = await new Promise<AddressInfo>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address() as AddressInfo));
    });
    assert.strictEqual(addr.address, "127.0.0.1", "bind address must be loopback");
    assert.strictEqual(addr.family, "IPv4", "address family must be IPv4");
    assert.ok(addr.port > 0 && addr.port < 65536, "OS must assign a valid ephemeral port");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("T-WIN1.Listen.2: when serve.ts binds the TCP server, chmodSync is NOT called for the socket/port file (chmod 0o600 gone)", async () => {
    // Given: serve.ts source at HEAD (current codebase still has chmodSync 0o600)
    // When:  the source text is scanned for chmodSync(opts.portFile …) or any 0o600 in the transport path
    // Then:  no chmodSync call referencing the transport socket/port-file remains after WIN-1

    const src = readFileSync(join(process.cwd(), "src/cli/subcommands/serve.ts"), "utf-8");
    assert.ok(
      !/chmodSync/.test(src),
      "serve.ts must not call chmodSync — the transport chmod (0o600/0o700) is removed (cross-platform; bearer token is the guard)",
    );
    assert.ok(!/0o600/.test(src), "no 0o600 mode must remain in the serve transport path");
  });

});

// ─── §2  G-WIN1.Handshake ─────────────────────────────────────────────────────

describe("G-WIN1.Handshake — port written atomically to port-file", () => {

  it("T-WIN1.PortFile.1: the port-file is written via a .tmp+rename atomic write and the content parses back to the OS-assigned port integer", async () => {
    // Given: a temp dir and a portFile path; a Node HTTP server that binds 0/'127.0.0.1'
    // When:  the sidecar's listen callback fires and writes opts.portFile atomically
    // Then:  portFile exists, its text content parseInt()s to the same port server.address().port

    // This test exercises the FILE-WRITE side only — it does not boot the full sidecar.
    // We replicate the atomic-write pattern directly so the scaffold compiles and runs.
    const dir = mkdtempSync(join(tmpdir(), "win1-portfile-"));
    const portFile = join(dir, "frondose.port");
    const portFileTmp = `${portFile}.tmp`;

    // Bind loopback:0 (as serve.ts does) and replicate its atomic port-file write.
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
    writeFileSync(portFileTmp, String(port), "utf-8");
    renameSync(portFileTmp, portFile);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Then: the port-file exists, round-trips to the OS-assigned port, and the .tmp is gone.
    assert.ok(existsSync(portFile), "port-file must exist after atomic write");
    assert.strictEqual(
      parseInt(readFileSync(portFile, "utf-8").trim(), 10),
      port,
      "port-file content must round-trip to the OS-assigned port",
    );
    assert.ok(!existsSync(portFileTmp), ".tmp file must be gone after rename (atomic)");

    // And serve.ts actually implements the atomic .tmp + rename write.
    const src = readFileSync(join(process.cwd(), "src/cli/subcommands/serve.ts"), "utf-8");
    assert.ok(/writeFileSync\(tmp,/.test(src), "serve.ts must write the port to a .tmp file first");
    assert.ok(
      /renameSync\(tmp, opts\.portFile\)/.test(src),
      "serve.ts must atomically rename the .tmp file → portFile",
    );
  });

});

// ─── §3  G-WIN1.Args ──────────────────────────────────────────────────────────

describe("G-WIN1.Args — sidecarMain.parseArgs accepts --port-file/--token", () => {

  // Helper: intercept process.exit + stderr so tests fail cleanly instead of crashing
  function withExitTrap<T>(fn: () => T): { result?: T; exitCode?: number; stderr: string } {
    const origExit  = process.exit;
    const origWrite = process.stderr.write.bind(process.stderr);
    let capturedCode: number | undefined;
    let stderrMsg = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrMsg += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number | string) => {
      capturedCode = typeof code === "number" ? code : 2;
      throw new Error(`__exit_${capturedCode}`);
    }) as typeof process.exit;
    try {
      const result = fn();
      return { result, stderr: stderrMsg };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("__exit_")) {
        return { exitCode: capturedCode, stderr: stderrMsg };
      }
      throw err;
    } finally {
      process.exit         = origExit;
      process.stderr.write = origWrite;
    }
  }

  it("T-WIN1.Args.1: parseArgs(['--port-file', '/x', '--token', 't']) returns { portFile: '/x', bearerToken: 't' }", async () => {
    // Given: sidecarMain.ts updated to accept --port-file (space form, matching Rust spawn)
    // When:  parseArgs is called with space-separated --port-file and --token
    // Then:  returns { portFile: '/x', bearerToken: 't' } (no sockPath field)

    const { parseArgs } = await import("../../../../src/app/sidecarMain.js");

    // Pre-impl: parseArgs does not recognize --port-file, sees no --sock, calls process.exit(2).
    // withExitTrap prevents process crash; after Step 4 the call will NOT exit and result is set.
    const outcome = withExitTrap(() => parseArgs(["--port-file", "/x", "--token", "t"]));

    // TODO (Step 5): after builder renames --sock→--port-file, outcome.exitCode must be undefined
    //   and outcome.result must deep-equal { portFile: '/x', bearerToken: 't' }.
    //   For the scaffold, assert the NEW contract shape; this FAILS pre-impl:
    assert.strictEqual(outcome.exitCode, undefined, "parseArgs must NOT exit when --port-file and --token are given (pre-impl this fails)");
    const result = outcome.result as Record<string, unknown>;
    assert.strictEqual(result["portFile"], "/x", "--port-file space form must set portFile='/x'");
    assert.strictEqual(result["bearerToken"], "t", "--token must set bearerToken='t'");
    assert.strictEqual(result["sockPath"], undefined, "portFile field must replace sockPath — sockPath must not be present");
  });

  it("T-WIN1.Args.2: parseArgs(['--port-file=/x', '--token=T']) returns { portFile: '/x', bearerToken: 'T' } (equals form)", async () => {
    // Given: sidecarMain.ts updated to accept --port-file= (equals form)
    // When:  parseArgs is called with equals-form args
    // Then:  returns { portFile: '/x', bearerToken: 'T' }

    const { parseArgs } = await import("../../../../src/app/sidecarMain.js");

    const outcome = withExitTrap(() => parseArgs(["--port-file=/x", "--token=T"]));

    // TODO (Step 5): fill after builder implements equals-form parsing
    assert.strictEqual(outcome.exitCode, undefined, "parseArgs must NOT exit when --port-file= and --token= are given");
    const result = outcome.result as Record<string, unknown>;
    assert.strictEqual(result["portFile"], "/x", "--port-file= equals form must set portFile='/x'");
    assert.strictEqual(result["bearerToken"], "T", "--token= equals form must set bearerToken='T'");
  });

  it("T-WIN1.Args.3: parseArgs([]) with no env calls process.exit(2) with fatal text '--port-file and --token required'", async () => {
    // Given: sidecarMain.ts updated; no argv and no FRONDOSE_PORT_FILE env set
    // When:  parseArgs([]) is called (all env cleared)
    // Then:  process.exit(2) is called and stderr contains '--port-file and --token required'

    const { parseArgs } = await import("../../../../src/app/sidecarMain.js");

    const prevPortFile = process.env["FRONDOSE_PORT_FILE"];
    const prevToken    = process.env["FRONDOSE_TOKEN"];
    const prevSock     = process.env["FRONDOSE_SOCK"];
    const prevMaiSock  = process.env["MAI_SOCK"];
    delete process.env["FRONDOSE_PORT_FILE"];
    delete process.env["FRONDOSE_TOKEN"];
    delete process.env["FRONDOSE_SOCK"];
    delete process.env["MAI_SOCK"];

    try {
      const outcome = withExitTrap(() => parseArgs([]));
      // Must exit(2) — whether pre-impl (because --sock missing) or post-impl (--port-file missing)
      assert.strictEqual(outcome.exitCode, 2, "parseArgs with no args/env must call process.exit(2)");
      // TODO (Step 5): the fatal text must change from '--sock and --token required'
      //   to '--port-file and --token required'; this assertion FAILS pre-impl:
      assert.ok(
        outcome.stderr.includes("--port-file and --token required"),
        `stderr must include '--port-file and --token required'; got: ${outcome.stderr}`,
      );
    } finally {
      if (prevPortFile !== undefined) process.env["FRONDOSE_PORT_FILE"] = prevPortFile;
      if (prevToken    !== undefined) process.env["FRONDOSE_TOKEN"]     = prevToken;
      if (prevSock     !== undefined) process.env["FRONDOSE_SOCK"]      = prevSock;
      if (prevMaiSock  !== undefined) process.env["MAI_SOCK"]           = prevMaiSock;
    }
  });

});

// ─── §4  G-WIN1.NoUDS ─────────────────────────────────────────────────────────

describe("G-WIN1.NoUDS — cleanup removes port-file (not a socket), via removeFile", () => {

  it("T-WIN1.Cleanup.1: http.ts exports removeFile (not removeSocket) and it removes the given path", async () => {
    // Given: serve/http.ts renamed removeSocket(sockPath) → removeFile(path) at Step 4
    // When:  removeFile is imported and called on a temp file path
    // Then:  the file is removed (rmSync force); removeSocket export is gone

    const httpModule = await import("../../../../src/cli/subcommands/serve/http.js") as Record<string, unknown>;

    // After Step 4: removeFile must exist; removeSocket must be absent
    assert.strictEqual(
      typeof httpModule["removeFile"],
      "function",
      "http.ts must export removeFile (renamed from removeSocket)",
    );
    assert.strictEqual(
      httpModule["removeSocket"],
      undefined,
      "removeSocket must no longer be exported after WIN-1 rename",
    );

    // Functional check: removeFile actually removes a file
    const dir  = mkdtempSync(join(tmpdir(), "win1-cleanup-"));
    const file = join(dir, "frondose.port");
    writeFileSync(file, "12345", "utf-8");
    assert.ok(existsSync(file), "pre-condition: file must exist before removeFile");

    const removeFile = httpModule["removeFile"] as (path: string) => void;
    removeFile(file);
    assert.ok(!existsSync(file), "removeFile must delete the file");
  });

});
