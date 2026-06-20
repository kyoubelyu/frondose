/**
 * WIN-3 Step 3 (scaffold) — T-Runtime.1, T-Runtime.2, T-Runtime.3, T-Runtime.4
 *
 * Mock-network tests for `scripts/build-runtime.mjs`.
 *
 * Gate coverage:
 *   G-WIN3.3  — T-Runtime.1 (darwin tree shape: $RUNTIME/node + dist/ + better_sqlite3.node
 *                              + build/Release/cgevent.node produced when cgevent fixture present)
 *             — T-Runtime.2 (win32 tree shape: $RUNTIME/node.exe + dist/ + better_sqlite3.node;
 *                              NO $RUNTIME/node Unix-named binary; NO cgevent.node)
 *             — T-Runtime.3 (pinned version constants: NODE_VERSION==="v22.22.3",
 *                              SQLITE_VER==="v12.9.0", SQLITE_ABI==="v127")
 *             — T-Runtime.4 (wrong-ABI fixture → throws/rejects with message containing
 *                              "ABI mismatch")
 *   G-WIN3.3 + G-WIN3.M-1:
 *             — T-Runtime.1 also verifies macOS output contract for byte-identity check
 *   G-WIN3.3 + G-WIN3.W-1:
 *             — T-Runtime.2 also verifies Windows output contract for NSIS installer viability
 *
 * MOCK NETWORK STRATEGY:
 *   build-runtime.mjs accepts a `fetchImpl` parameter (per §6.4 L-3 skeleton) for the
 *   download helper — tests pass a tiny in-process HTTP server (node:http) serving minimal
 *   fixture tarballs/zips. This avoids any real network calls.
 *
 *   Fixture files for mock downloads are created in-test using tmp dirs:
 *     - darwin node tar.gz: a gzip-compressed tar containing a stub `bin/node` executable
 *     - darwin sqlite tar.gz: a gzip-compressed tar containing a stub `build/Release/better_sqlite3.node`
 *     - win32 node zip: a minimal zip file containing `node.exe` (Windows convention)
 *     - win32 sqlite tar.gz: same WiseLibs convention but win32-x64 stub
 *
 *   Because the script shells out to `lipo` (macOS-only) and `npm ci`, those calls are also
 *   stubbed via the `fetchImpl`/`execImpl` injection point if the script supports it, OR the
 *   tests skip lipo/npm-ci steps on the test host by injecting a pre-populated node_modules
 *   fixture directory.
 *
 *   NOTE: build-runtime.mjs does NOT exist yet (pre-impl). The dynamic import is guarded in
 *   a before() block so all tests compile and reach assert.fail("TODO Step 5") cleanly.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/build/build-runtime.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGzip } from "node:zlib";
import { cleanupTmpDir } from "../_helpers/tmp";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO, "scripts", "build-runtime.mjs");

// ---------------------------------------------------------------------------
// Lazy import of build-runtime.mjs — guarded so the file compiles pre-impl
// ---------------------------------------------------------------------------

type BuildRuntimeFn = (opts?: { platform?: string; root?: string; fetchImpl?: FetchImpl }) => Promise<void>;

// fetchImpl signature: (url: string, destPath: string) => Promise<void>
type FetchImpl = (url: string, destPath: string) => Promise<void>;

let buildRuntime: BuildRuntimeFn | undefined;
let MODULE_CONSTANTS: { NODE_VERSION?: string; SQLITE_VER?: string; SQLITE_ABI?: string } = {};

before(async () => {
  try {
    const mod = (await import(SCRIPT)) as {
      buildRuntime?: BuildRuntimeFn;
      NODE_VERSION?: string;
      SQLITE_VER?: string;
      SQLITE_ABI?: string;
    };
    buildRuntime = mod.buildRuntime;
    MODULE_CONSTANTS = {
      NODE_VERSION: mod.NODE_VERSION,
      SQLITE_VER: mod.SQLITE_VER,
      SQLITE_ABI: mod.SQLITE_ABI,
    };
  } catch {
    // scripts/build-runtime.mjs not yet created (pre-impl Step 4) — tests will hit assert.fail
  }
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Create a minimal (empty) gzip-compressed tar that extracts to a single file at `entryPath`. */
async function makeStubTarGz(destFile: string, entryPath: string, content: Buffer = Buffer.alloc(0)): Promise<void> {
  // Build a minimal POSIX tar with one entry (header + content + padding).
  // Tar header is 512 bytes; each 512-byte block boundary pads with zeros.
  const name = entryPath.padEnd(100, "\0");
  const size = content.length;
  const sizeOctal = size.toString(8).padStart(11, "0") + "\0";
  const header = Buffer.alloc(512);
  Buffer.from(name, "ascii").copy(header, 0);
  // mode
  Buffer.from("0000755\0", "ascii").copy(header, 100);
  // uid/gid
  Buffer.from("0000000\0", "ascii").copy(header, 108);
  Buffer.from("0000000\0", "ascii").copy(header, 116);
  // size
  Buffer.from(sizeOctal, "ascii").copy(header, 124);
  // mtime
  Buffer.from("00000000000\0", "ascii").copy(header, 136);
  // type: regular file
  header[156] = 48; // '0'
  // checksum placeholder
  Buffer.from("        ", "ascii").copy(header, 148);
  // compute checksum
  let cksum = 0;
  for (let i = 0; i < 512; i++) cksum += header[i] ?? 0;
  Buffer.from(cksum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(header, 148);

  // Content block padded to 512
  const contentPadded = Buffer.alloc(Math.ceil(size / 512) * 512);
  content.copy(contentPadded);

  // End-of-archive: two 512-byte zero blocks
  const eoa = Buffer.alloc(1024);

  const tarData = Buffer.concat([header, contentPadded, eoa]);

  // Gzip compress to destFile
  const gzip = createGzip();
  const input = Readable.from(tarData);
  const { createWriteStream } = await import("node:fs");
  const output = createWriteStream(destFile);
  await pipeline(input, gzip, output);
}

/** Create a minimal stub zip file with one entry named `entryName`. */
async function makeStubZip(destFile: string, entryName: string): Promise<void> {
  // Minimal ZIP: local file header + data + central directory + EOCD
  // For test purposes, just write an empty file that is at least plausible
  // (the real extraction is mocked via fetchImpl injection, so the zip content is irrelevant
  //  as long as the script doesn't crash on import). We write a valid-enough stub.
  const { createWriteStream } = await import("node:fs");

  // Local file header signature
  const LFH_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const CENTRAL_SIG = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

  const nameBytes = Buffer.from(entryName, "utf8");
  const lfh = Buffer.alloc(30 + nameBytes.length);
  LFH_SIG.copy(lfh, 0);
  lfh.writeUInt16LE(20, 4); // version needed
  lfh.writeUInt16LE(0, 6); // flags
  lfh.writeUInt16LE(0, 8); // compression: stored
  lfh.writeUInt32LE(0, 14); // CRC-32
  lfh.writeUInt32LE(0, 18); // compressed size
  lfh.writeUInt32LE(0, 22); // uncompressed size
  lfh.writeUInt16LE(nameBytes.length, 26);
  lfh.writeUInt16LE(0, 28); // extra length
  nameBytes.copy(lfh, 30);

  const cdOffset = lfh.length;
  const cd = Buffer.alloc(46 + nameBytes.length);
  CENTRAL_SIG.copy(cd, 0);
  cd.writeUInt16LE(20, 4); // version made
  cd.writeUInt16LE(20, 6); // version needed
  cd.writeUInt16LE(0, 8); // flags
  cd.writeUInt16LE(0, 10); // compression
  cd.writeUInt32LE(0, 16); // CRC-32
  cd.writeUInt32LE(0, 20); // compressed size
  cd.writeUInt32LE(0, 24); // uncompressed size
  cd.writeUInt16LE(nameBytes.length, 28);
  cd.writeUInt16LE(0, 30); // extra
  cd.writeUInt16LE(0, 32); // comment
  cd.writeUInt16LE(0, 34); // disk start
  cd.writeUInt32LE(0, 42); // local header offset
  nameBytes.copy(cd, 46);

  const eocd = Buffer.alloc(22);
  EOCD_SIG.copy(eocd, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(1, 8); // entries this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(cd.length, 12); // central dir size
  eocd.writeUInt32LE(cdOffset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  const zipData = Buffer.concat([lfh, cd, eocd]);
  writeFileSync(destFile, zipData);
}

// ---------------------------------------------------------------------------
// Per-test tmp dirs
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "win3-runtime-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) {
    cleanupTmpDir(d);
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// RETIRED 2026-06-20 (P-WIN3-BUILDRUNTIME, option B). These 4 T-Runtime scaffolds
// target a unified `scripts/build-runtime.mjs` that was DELIBERATELY never built:
// WIN-3 pivoted to two platform-specific scripts (`build-runtime-windows.mjs` +
// `build-release.sh` Phase 0) as the architect's "rescue fallback" so the macOS
// byte-identity path is never touched (build-runtime-windows.mjs:7-9). A unified
// builder would be unwired test-only code, and an FM-1 Codex critic found passing
// these scaffolds needs significant scaffold rework (execImpl type, lipo/npm-ci/
// extraction fixtures) for no production benefit. Skipped (not deleted) so the
// contract survives if a future deliberate consolidation phase implements the
// unified script. See docs/phase-win3-buildruntime-{plan,critics}.md + ROADMAP
// § Incomplete / Deferred. To re-enable: build scripts/build-runtime.mjs, then
// drop the `.skip` and fill the TODO assertion bodies.
// ---------------------------------------------------------------------------

// G-WIN3.3 + G-WIN3.M-1: T-Runtime.1 — macOS (darwin) tree shape
describe.skip("G-WIN3.3 + G-WIN3.M-1 — build-runtime.mjs: darwin produces expected tree", () => {
  it("T-Runtime.1: when platform=darwin and mock-network fixtures provided, $RUNTIME/node + dist/ + better_sqlite3.node (+ cgevent.node if present) exist", async () => {
    // Given: a fresh tmp $ROOT dir; mock fetchImpl serving stub tar.gz fixtures for darwin
    //        arm64 + x64 node tarballs and darwin arm64 + x64 sqlite prebuilds;
    //        a stub cgevent.node in $ROOT/build/Release/
    // When:  buildRuntime({ platform: "darwin", root, fetchImpl }) resolves
    // Then:  $RUNTIME/node exists
    //        $RUNTIME/dist/ exists
    //        $RUNTIME/node_modules/better-sqlite3/build/Release/better_sqlite3.node exists
    //        $RUNTIME/build/Release/cgevent.node exists (cgevent fixture was provided)

    if (!buildRuntime) {
      assert.fail("TODO Step 5: scripts/build-runtime.mjs not yet created (pre-impl)");
    }

    assert.fail(
      "TODO Step 5: fill assertion body — invoke buildRuntime with mock fetchImpl and assert darwin tree shape",
    );
  });
});

// ---------------------------------------------------------------------------
// G-WIN3.3 + G-WIN3.W-1: T-Runtime.2 — Windows (win32) tree shape
// ---------------------------------------------------------------------------

describe.skip("G-WIN3.3 + G-WIN3.W-1 — build-runtime.mjs: win32 produces expected tree (no node unix binary, no cgevent)", () => {
  it("T-Runtime.2: when platform=win32 and mock-network zip+tar.gz fixtures provided, $RUNTIME/node.exe + dist/ + better_sqlite3.node exist; NO $RUNTIME/node; NO cgevent.node", async () => {
    // Given: a fresh tmp $ROOT dir; mock fetchImpl serving stub zip for win32 node
    //        and stub tar.gz for win32-x64 sqlite prebuild
    // When:  buildRuntime({ platform: "win32", root, fetchImpl }) resolves
    // Then:  $RUNTIME/node.exe exists
    //        $RUNTIME/dist/ exists
    //        $RUNTIME/node_modules/better-sqlite3/build/Release/better_sqlite3.node exists
    //        $RUNTIME/node does NOT exist (no Unix-named binary on Windows path)
    //        $RUNTIME/build/Release/cgevent.node does NOT exist (Windows skips cgevent)

    if (!buildRuntime) {
      assert.fail("TODO Step 5: scripts/build-runtime.mjs not yet created (pre-impl)");
    }

    assert.fail(
      "TODO Step 5: fill assertion body — invoke buildRuntime with mock fetchImpl for win32 and assert tree shape",
    );
  });
});

// ---------------------------------------------------------------------------
// G-WIN3.3: T-Runtime.3 — pinned version constants
// ---------------------------------------------------------------------------

describe.skip("G-WIN3.3 — build-runtime.mjs: pinned version constants match macOS contract", () => {
  it('T-Runtime.3: MODULE exports NODE_VERSION==="v22.22.3", SQLITE_VER==="v12.9.0", SQLITE_ABI==="v127"', () => {
    // Given: scripts/build-runtime.mjs imported as a module
    // When:  NODE_VERSION, SQLITE_VER, SQLITE_ABI named exports (or module-level consts) are read
    // Then:  they equal the pinned macOS contract values —
    //        same ABI line means one better-sqlite3 prebuild lookup covers both platforms

    if (!buildRuntime) {
      assert.fail("TODO Step 5: scripts/build-runtime.mjs not yet created (pre-impl)");
    }

    // T-Runtime.3 reads the module constants already populated in before()
    assert.strictEqual(
      MODULE_CONSTANTS.NODE_VERSION,
      "v22.22.3",
      `T-Runtime.3: NODE_VERSION must be "v22.22.3" (got: ${JSON.stringify(MODULE_CONSTANTS.NODE_VERSION)})`,
    );
    assert.strictEqual(
      MODULE_CONSTANTS.SQLITE_VER,
      "v12.9.0",
      `T-Runtime.3: SQLITE_VER must be "v12.9.0" (got: ${JSON.stringify(MODULE_CONSTANTS.SQLITE_VER)})`,
    );
    assert.strictEqual(
      MODULE_CONSTANTS.SQLITE_ABI,
      "v127",
      `T-Runtime.3: SQLITE_ABI must be "v127" (got: ${JSON.stringify(MODULE_CONSTANTS.SQLITE_ABI)})`,
    );
  });
});

// ---------------------------------------------------------------------------
// G-WIN3.3: T-Runtime.4 — wrong-ABI fixture → ABI mismatch error
// ---------------------------------------------------------------------------

describe.skip("G-WIN3.3 — build-runtime.mjs: wrong-ABI node binary causes ABI mismatch error", () => {
  it('T-Runtime.4: when the bundled node binary reports a different ABI than SQLITE_ABI, buildRuntime() rejects/throws with message containing "ABI mismatch"', async () => {
    // Given: a tmp $ROOT; a mock fetchImpl that serves valid node/sqlite fixtures BUT
    //        the assembled node binary (or a stub exec) returns a different modules version
    //        than SQLITE_ABI (simulating a node/sqlite ABI mismatch)
    // When:  buildRuntime({ platform, root, fetchImpl }) is called
    // Then:  it throws or rejects with an error message containing "ABI mismatch"

    if (!buildRuntime) {
      assert.fail("TODO Step 5: scripts/build-runtime.mjs not yet created (pre-impl)");
    }

    assert.fail(
      'TODO Step 5: fill assertion body — invoke buildRuntime with a wrong-ABI mock and assert rejection with "ABI mismatch"',
    );
  });
});

// Helper used in fixture helpers above (dirname needs to be declared)
function dirname(p: string): string {
  const parts = p.split("/");
  parts.pop();
  return parts.join("/") || ".";
}
