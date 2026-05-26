/**
 * P-58d.2 Step 4a — Scaffolds: T-UpdSrv.1–11
 *
 * Covers src/cli/subcommands/updateServer.ts — read-only static HTTP server for the
 * local Frondose download portal (~/.mai/site/: landing page + Tauri updater manifest
 * + signed universal artifacts).
 *
 * Strategy: startUpdateServer({ siteDir: <tmp>, port: 0, bindAddress: "127.0.0.1" }),
 * await "listening", request via node:http, assert status + headers + body,
 * then server.close(). Each test seeds a tmp site dir with fixture files.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * NOTE: updateServer.ts is not created until builder Step 4b.
 * The `before` hook catches the import error and sets startUpdateServer=undefined;
 * each test then fails with a clear guard message. After Step 4b the tests reach
 * their assertion-TODO branch and fail there.
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * Gate coverage:
 *   G-P58d2.1 ← T-UpdSrv.1–11 (+ S-Live.1 at Step 5)
 *
 * All assertion bodies are TODO — intentionally failing scaffolds (Step 4a).
 * Builder Step 4b creates updateServer.ts; validator Step 5 fills assertions.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit tests/cli/updateServer.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpReq, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

// ── Gate-on-builder: updateServer.ts not created until Step 4b ────────────────
// biome-ignore lint/suspicious/noExplicitAny: gate-on-builder dynamic import (module absent at Step 4a)
let startUpdateServer: ((opts: any) => Server) | undefined;
let UPDATE_SERVER_PORT: number | undefined;

before(async () => {
  try {
    const mod = await import("../../src/cli/subcommands/updateServer.js");
    startUpdateServer = mod.startUpdateServer;
    UPDATE_SERVER_PORT = mod.UPDATE_SERVER_PORT;
  } catch {
    // Module not yet created — builder Step 4b creates src/cli/subcommands/updateServer.ts
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

interface SiteDirs {
  /** The root served by the update server. */
  siteDir: string;
  /** The parent of siteDir — used by T-UpdSrv.8 to seed a sibling evil dir. */
  parentDir: string;
  cleanup: () => void;
}

/** Create a fresh tmp parent dir with a site/ subdirectory. */
function makeSiteDirs(): SiteDirs {
  const parentDir = mkdtempSync(join(tmpdir(), "mai-p58d2-site-"));
  const siteDir = join(parentDir, "site");
  mkdirSync(siteDir, { recursive: true });
  return { siteDir, parentDir, cleanup: () => rmSync(parentDir, { recursive: true, force: true }) };
}

/** Start the update server on a random port; resolve once listening. */
async function startAndWait(
  siteDir: string,
  port = 0,
  bindAddress = "127.0.0.1",
): Promise<{ server: Server; port: number }> {
  return new Promise<{ server: Server; port: number }>((resolve, reject) => {
    const srv = startUpdateServer!({ siteDir, port, bindAddress });
    srv.on("listening", () => {
      const addr = srv.address() as AddressInfo;
      resolve({ server: srv, port: addr.port });
    });
    srv.on("error", reject);
  });
}

/** Gracefully close the server. */
async function closeServer(srv: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
}

/** Raw HTTP request result — status + headers + body buffer. */
interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** Convenience: the Content-Type header value (empty string if absent). */
  contentType: string;
  /** Convenience: the Allow header value (empty string if absent). */
  allow: string;
}

/**
 * Make an HTTP request to 127.0.0.1:<port><urlPath> using the given method.
 * Returns the raw buffer body (safe for binary artifacts).
 */
async function httpReqRaw(port: number, urlPath: string, method = "GET"): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const r = httpReq({ host: "127.0.0.1", port, method, path: urlPath }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const hdrs = res.headers as Record<string, string | string[] | undefined>;
        resolve({
          status: res.statusCode ?? 0,
          headers: hdrs,
          body: Buffer.concat(chunks),
          contentType: (res.headers["content-type"] as string | undefined) ?? "",
          allow: (res.headers["allow"] as string | undefined) ?? "",
        });
      });
    });
    r.on("error", reject);
    r.end();
  });
}

// ── T-UpdSrv.1 ───────────────────────────────────────────────────────────────

describe("update server — serves index.html at root with HTML content-type (G-P58d2.1)", () => {
  it("T-UpdSrv.1: when GET /, then 200, text/html; charset=utf-8, body equals fixture", async () => {
    // Given: tmp site dir containing index.html with body "<h1>Frondose</h1>"
    // When:  GET /
    // Then:  status 200; Content-Type: text/html; charset=utf-8; body === fixture content
    if (!startUpdateServer) assert.fail("updateServer.ts not yet created — builder Step 4b required");
    const { siteDir, cleanup } = makeSiteDirs();
    let server: Server | null = null;
    try {
      const fixture = "<h1>Frondose</h1>";
      writeFileSync(join(siteDir, "index.html"), fixture, "utf-8");
      const { server: srv, port } = await startAndWait(siteDir);
      server = srv;
      const result = await httpReqRaw(port, "/");
      assert.equal(result.status, 200);
      assert.equal(result.contentType, "text/html; charset=utf-8");
      assert.equal(result.body.toString("utf-8"), fixture);
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});

// ── T-UpdSrv.2 ───────────────────────────────────────────────────────────────

describe("update server — serves latest.json at server root with JSON content-type (G-P58d2.1)", () => {
  it("T-UpdSrv.2: when GET /latest.json, then 200, application/json; charset=utf-8, body parses as JSON", async () => {
    // Given: site root contains latest.json with valid JSON content
    // When:  GET /latest.json
    // Then:  status 200; Content-Type: application/json; charset=utf-8; body JSON-parseable
    if (!startUpdateServer) assert.fail("updateServer.ts not yet created — builder Step 4b required");
    const { siteDir, cleanup } = makeSiteDirs();
    let server: Server | null = null;
    try {
      writeFileSync(join(siteDir, "latest.json"), '{"version":"0.5.0-alpha.29"}', "utf-8");
      const { server: srv, port } = await startAndWait(siteDir);
      server = srv;
      const result = await httpReqRaw(port, "/latest.json");
      assert.equal(result.status, 200);
      assert.equal(result.contentType, "application/json; charset=utf-8");
      assert.doesNotThrow(() => JSON.parse(result.body.toString("utf-8")));
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});

// ── T-UpdSrv.3 ───────────────────────────────────────────────────────────────

describe("update server — serves .app.tar.gz as application/gzip (binary-safe) (G-P58d2.1)", () => {
  it("T-UpdSrv.3: when GET /downloads/Frondose.app.tar.gz, then 200, application/gzip, bytes match fixture", async () => {
    // Given: downloads/Frondose.app.tar.gz with known bytes (gzip magic header)
    // When:  GET /downloads/Frondose.app.tar.gz
    // Then:  status 200; Content-Type: application/gzip; body bytes equal the fixture (binary-safe)
    if (!startUpdateServer) assert.fail("updateServer.ts not yet created — builder Step 4b required");
    const { siteDir, cleanup } = makeSiteDirs();
    let server: Server | null = null;
    try {
      const downloadsDir = join(siteDir, "downloads");
      mkdirSync(downloadsDir, { recursive: true });
      const fakeGz = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]);
      writeFileSync(join(downloadsDir, "Frondose.app.tar.gz"), fakeGz);
      const { server: srv, port } = await startAndWait(siteDir);
      server = srv;
      const result = await httpReqRaw(port, "/downloads/Frondose.app.tar.gz");
      assert.equal(result.status, 200);
      assert.equal(result.contentType, "application/gzip");
      assert.ok(result.body.equals(fakeGz), "body bytes must equal the gzip fixture (binary-safe)");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});

// ── T-UpdSrv.4 ───────────────────────────────────────────────────────────────

describe("update server — serves .sig as text/plain; charset=utf-8 (G-P58d2.1)", () => {
  it("T-UpdSrv.4: when GET /downloads/Frondose.app.tar.gz.sig, then 200, text/plain; charset=utf-8", async () => {
    // Given: downloads/Frondose.app.tar.gz.sig with known content
    // When:  GET /downloads/Frondose.app.tar.gz.sig
    // Then:  status 200; Content-Type: text/plain; charset=utf-8
    if (!startUpdateServer) assert.fail("updateServer.ts not yet created — builder Step 4b required");
    const { siteDir, cleanup } = makeSiteDirs();
    let server: Server | null = null;
    try {
      const downloadsDir = join(siteDir, "downloads");
      mkdirSync(downloadsDir, { recursive: true });
      writeFileSync(join(downloadsDir, "Frondose.app.tar.gz.sig"), "SIGBLOB_TEST_123\n", "utf-8");
      const { server: srv, port } = await startAndWait(siteDir);
      server = srv;
      const result = await httpReqRaw(port, "/downloads/Frondose.app.tar.gz.sig");
      assert.equal(result.status, 200);
      assert.equal(result.contentType, "text/plain; charset=utf-8");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});

// ── T-UpdSrv.5 ───────────────────────────────────────────────────────────────

describe("update server — serves .dmg as application/x-apple-diskimage (G-P58d2.1)", () => {
  it("T-UpdSrv.5: when GET /downloads/Frondose-universal.dmg, then 200, application/x-apple-diskimage", async () => {
    // Given: downloads/Frondose-universal.dmg fixture (small buffer, not a real DMG)
    // When:  GET /downloads/Frondose-universal.dmg
    // Then:  status 200; Content-Type: application/x-apple-diskimage
    if (!startUpdateServer) assert.fail("updateServer.ts not yet created — builder Step 4b required");
    const { siteDir, cleanup } = makeSiteDirs();
    let server: Server | null = null;
    try {
      const downloadsDir = join(siteDir, "downloads");
      mkdirSync(downloadsDir, { recursive: true });
      writeFileSync(join(downloadsDir, "Frondose-universal.dmg"), Buffer.alloc(16, 0xde));
      const { server: srv, port } = await startAndWait(siteDir);
      server = srv;
      const result = await httpReqRaw(port, "/downloads/Frondose-universal.dmg");
      assert.equal(result.status, 200);
      assert.equal(result.contentType, "application/x-apple-diskimage");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});

// ── T-UpdSrv.6 ───────────────────────────────────────────────────────────────

describe("update server — unknown extension → application/octet-stream fallback (G-P58d2.1)", () => {
  it("T-UpdSrv.6: when GET /downloads/blob.bin, then 200, Content-Type: application/octet-stream", async () => {
    // Given: downloads/blob.bin with an unknown file extension
    // When:  GET /downloads/blob.bin
    // Then:  status 200; Content-Type: application/octet-stream (octet-stream fallback)
    if (!startUpdateServer) assert.fail("updateServer.ts not yet created — builder Step 4b required");
    const { siteDir, cleanup } = makeSiteDirs();
    let server: Server | null = null;
    try {
      const downloadsDir = join(siteDir, "downloads");
      mkdirSync(downloadsDir, { recursive: true });
      writeFileSync(join(downloadsDir, "blob.bin"), Buffer.alloc(8, 0xab));
      const { server: srv, port } = await startAndWait(siteDir);
      server = srv;
      const result = await httpReqRaw(port, "/downloads/blob.bin");
      assert.equal(result.status, 200);
      assert.equal(result.contentType, "application/octet-stream");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});

// ── T-UpdSrv.7 ───────────────────────────────────────────────────────────────

describe("update server — missing file → 404 (G-P58d2.1)", () => {
  it("T-UpdSrv.7: when GET /downloads/missing.dmg (absent), then 404", async () => {
    // Given: downloads/missing.dmg does not exist in the site dir (absence is the fixture)
    // When:  GET /downloads/missing.dmg
    // Then:  status 404
    if (!startUpdateServer) assert.fail("updateServer.ts not yet created — builder Step 4b required");
    const { siteDir, cleanup } = makeSiteDirs();
    let server: Server | null = null;
    try {
      // Intentionally do NOT create the file — absence is the test fixture
      const { server: srv, port } = await startAndWait(siteDir);
      server = srv;
      const result = await httpReqRaw(port, "/downloads/missing.dmg");
      assert.equal(result.status, 404);
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});

// ── T-UpdSrv.8 ───────────────────────────────────────────────────────────────

describe("update server — path traversal / injection blocked; TOPSECRET never leaked [3b CLR-1 expanded] (G-P58d2.1)", () => {
  it("T-UpdSrv.8: traversal + injection attacks all fail (not 200) and never return TOPSECRET body", async () => {
    // Given: siteDir = <tmp>/site/; sibling dir <tmp>/site-evil/ contains secret.txt with "TOPSECRET"
    // When:  each of the following request paths is sent:
    //   (i)   GET /../../site-evil/secret.txt       (plain dot-dot)
    //   (ii)  GET /%2e%2e/%2e%2e/site-evil/secret.txt  (encoded dot-dot)
    //   (iii) GET /../site-evil/secret.txt           (sibling-prefix)
    //   (iv)  GET /%2e%2e/site-evil/secret.txt       (encoded sibling-prefix)
    //   (v-a) GET //etc/hosts                        (absolute-path injection)
    //   (v-b) GET /%2Fetc%2Fhosts                    (encoded absolute-path)
    //   (vi)  GET /%00                               (null byte)
    // Then: NONE returns status 200; NONE has body containing "TOPSECRET"
    if (!startUpdateServer) assert.fail("updateServer.ts not yet created — builder Step 4b required");
    const { siteDir, parentDir, cleanup } = makeSiteDirs();
    let server: Server | null = null;
    try {
      // Seed the sibling evil dir OUTSIDE the site root
      const evilDir = join(parentDir, "site-evil");
      mkdirSync(evilDir, { recursive: true });
      writeFileSync(join(evilDir, "secret.txt"), "TOPSECRET", "utf-8");
      const { server: srv, port } = await startAndWait(siteDir);
      server = srv;

      const attackPaths: string[] = [
        "/../../site-evil/secret.txt", // (i)   plain dot-dot
        "/%2e%2e/%2e%2e/site-evil/secret.txt", // (ii)  encoded dot-dot
        "/../site-evil/secret.txt", // (iii) sibling-prefix
        "/%2e%2e/site-evil/secret.txt", // (iv)  encoded sibling-prefix
        "//etc/hosts", // (v-a) absolute-path injection
        "/%2Fetc%2Fhosts", // (v-b) encoded absolute-path
        "/%00", // (vi)  null byte
      ];

      for (const attackPath of attackPaths) {
        const result = await httpReqRaw(port, attackPath);
        assert.notEqual(result.status, 200, `attack path "${attackPath}" must not return 200`);
        assert.ok(
          !result.body.toString("binary").includes("TOPSECRET"),
          `attack path "${attackPath}" must not leak TOPSECRET in body`,
        );
      }
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});

// ── T-UpdSrv.9 ───────────────────────────────────────────────────────────────

describe("update server — directory request → 404 (no listing) (G-P58d2.1)", () => {
  it("T-UpdSrv.9: when GET /downloads/ (resolves to a directory), then 404", async () => {
    // Given: siteDir with a downloads/ subdirectory (directory, not a file)
    // When:  GET /downloads/
    // Then:  status 404 (no directory listing emitted)
    if (!startUpdateServer) assert.fail("updateServer.ts not yet created — builder Step 4b required");
    const { siteDir, cleanup } = makeSiteDirs();
    let server: Server | null = null;
    try {
      mkdirSync(join(siteDir, "downloads"), { recursive: true });
      const { server: srv, port } = await startAndWait(siteDir);
      server = srv;
      const result = await httpReqRaw(port, "/downloads/");
      assert.equal(result.status, 404);
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});

// ── T-UpdSrv.10 ──────────────────────────────────────────────────────────────

describe("update server — non-GET method → 405 + Allow: GET header [3b NIT-1] (G-P58d2.1)", () => {
  it("T-UpdSrv.10: POST / and DELETE /latest.json both return 405 + Allow: GET header", async () => {
    // Given: site dir with index.html and latest.json present
    // When:  POST / (and DELETE /latest.json)
    // Then:  status 405 AND response carries an Allow: GET header for each
    if (!startUpdateServer) assert.fail("updateServer.ts not yet created — builder Step 4b required");
    const { siteDir, cleanup } = makeSiteDirs();
    let server: Server | null = null;
    try {
      writeFileSync(join(siteDir, "index.html"), "<h1>F</h1>", "utf-8");
      writeFileSync(join(siteDir, "latest.json"), "{}", "utf-8");
      const { server: srv, port } = await startAndWait(siteDir);
      server = srv;
      const postResult = await httpReqRaw(port, "/", "POST");
      assert.equal(postResult.status, 405);
      assert.equal(postResult.allow, "GET");
      const deleteResult = await httpReqRaw(port, "/latest.json", "DELETE");
      assert.equal(deleteResult.status, 405);
      assert.equal(deleteResult.allow, "GET");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});

// ── T-UpdSrv.11 ──────────────────────────────────────────────────────────────

describe("update server — default port constant = 4875; no-bindAddress defaults to 0.0.0.0 (G-P58d2.1)", () => {
  it("T-UpdSrv.11: UPDATE_SERVER_PORT === 4875; startUpdateServer({siteDir, port:0}) binds 0.0.0.0", async () => {
    // Given: the module's exported UPDATE_SERVER_PORT constant
    // Then:  UPDATE_SERVER_PORT === 4875
    // AND:   startUpdateServer({ siteDir, port: 0 }) with no bindAddress →
    //        server.address().address === "0.0.0.0" (the operator's LAN bind default)
    if (!startUpdateServer) assert.fail("updateServer.ts not yet created — builder Step 4b required");
    if (UPDATE_SERVER_PORT === undefined) assert.fail("UPDATE_SERVER_PORT not exported — builder Step 4b required");
    const { siteDir, cleanup } = makeSiteDirs();
    let server: Server | null = null;
    try {
      // Call with no bindAddress → should default to "0.0.0.0"
      const srv = startUpdateServer!({ siteDir, port: 0 });
      server = srv;
      await new Promise<void>((resolve, reject) => {
        srv.on("listening", resolve);
        srv.on("error", reject);
      });
      assert.equal(UPDATE_SERVER_PORT, 4875);
      const addr = srv.address() as AddressInfo;
      assert.equal(addr.address, "0.0.0.0");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});
