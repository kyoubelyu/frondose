/**
 * WIN-2 Step 3 (scaffold) — T-WIN2.1a, T-WIN2.2a, T-WIN2.2b
 *
 * Mock + lightweight fixture tests for `scripts/chmod-dist.mjs`.
 *
 * Gate coverage:
 *   G-WIN2.1  — T-WIN2.1a (no-op on win32: spy proves fs.chmodSync NEVER called)
 *   G-WIN2.2  — T-WIN2.2a (chmods exactly 3 paths on POSIX: spy proves call count + args)
 *               T-WIN2.2b (real mode bits via script exec — POSIX-only integration smoke)
 *
 * CONCERN-MR 1 update (Step 3a targeted revision):
 *   T-WIN2.1a now uses a mock.fn() spy on fs.chmodSync to assert 0 calls on win32.
 *   T-WIN2.2a now uses the same spy to assert EXACTLY 3 calls with the 3 correct paths
 *   and mode 0o755 — not just inferred from file mode bits.
 *
 * Spy setup: mock.module('node:fs', { namedExports: { chmodSync: spy } }) is called at
 * module level BEFORE the before() dynamic import of scripts/chmod-dist.mjs. This ensures
 * the helper's own `import fs from "node:fs"` resolves to the mocked version.
 * The test file's own static `import { chmodSync, ... }` is UNAFFECTED (statically bound
 * before mock intercepts — per Node.js docs: "previously imported values hold refs to
 * originals"). So makeTmpRoot() uses the REAL chmodSync; the spy only captures calls
 * originating from the helper itself. (V-confirmed: see spy probe above.)
 *
 * Spy reset: beforeEach calls spy.mock.resetCalls() so T-WIN2.1a and T-WIN2.2a don't
 * see each other's call counts. (makeTmpRoot's real chmodSync calls are invisible to spy.)
 *
 * Design note (§6.4-A, R-3): the helper exports `chmodDistEntrypoints({ platform, root })`
 * — parameter injection avoids having to mock `process.platform` globally.
 *
 * Run (mock): node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *   tests/build/chmod-dist.mock.test.ts
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanupTmpDir } from "../_helpers/tmp";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(REPO, "scripts", "chmod-dist.mjs");

// The 3 dist entrypoints relative to a fixture root (mirrors §6.4-A ENTRYPOINTS)
const ENTRYPOINTS = ["dist/cli/main.js", "dist/app/sidecarMain.js", "dist/app/updateServerMain.js"];

// ─── CONCERN-MR 1: spy on fs.chmodSync ───────────────────────────────────────
//
// Set up the spy BEFORE the before() dynamic import so that scripts/chmod-dist.mjs
// gets the mocked node:fs when it is first loaded.
//
// The spy is a no-op (returns undefined, does NOT actually chmod files). T-WIN2.1a
// asserts 0 calls; T-WIN2.2a asserts exactly 3 calls with the correct paths + mode.
// T-WIN2.2b (the real-exec integration smoke) is NOT affected by the spy because it
// runs scripts/chmod-dist.mjs in a subprocess via spawnSync (its own Node process,
// not subject to this test file's mock.module).

const chmodSyncSpy = mock.fn((_path: string, _mode: number) => {});

mock.module("node:fs", {
  namedExports: {
    // Spy intercepts chmodSync calls from the helper
    chmodSync: chmodSyncSpy,
    // All other node:fs exports are passed through via the real module.
    // We only need to spy on chmodSync; keep everything else real so the helper
    // (and any fixture helpers using the mocked fs) still sees real existsSync etc.
    // (Note: mock.module namedExports is a MERGE — unspecified exports fall back to real.)
  },
});

// ─── Lazy import of the helper ────────────────────────────────────────────────

type ChmodFn = (opts?: { platform?: string; root?: string }) => void;
let chmodDistEntrypoints: ChmodFn | undefined;

before(async () => {
  try {
    const mod = await import(pathToFileURL(SCRIPT).href);
    chmodDistEntrypoints = mod.chmodDistEntrypoints;
  } catch {
    // scripts/chmod-dist.mjs not yet created (pre-impl Step 4) — tests will hit assert.fail
  }
});

// Per-test fixture dirs — created/cleaned per test that needs them
let tmpDir: string | undefined;

beforeEach(() => {
  // Reset spy call log before every test so counts are isolated
  chmodSyncSpy.mock.resetCalls();
});

afterEach(() => {
  if (tmpDir) {
    cleanupTmpDir(tmpDir);
    tmpDir = undefined;
  }
});

/** Create a fixture root with the 3 dist entrypoints as empty files, chmod'd 0o644. */
function makeTmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "win2-chmod-"));
  for (const rel of ENTRYPOINTS) {
    const full = join(root, rel);
    mkdirSync(join(root, ...rel.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(full, "");
    // Uses the TEST FILE'S statically-imported chmodSync (REAL — not the spy).
    // So this call is invisible to chmodSyncSpy.
    chmodSync(full, 0o644); // start non-executable
  }
  return root;
}

// ─── G-WIN2.1: no-op on win32 ────────────────────────────────────────────────

describe("G-WIN2.1 — chmod-dist: no-op when platform is win32", () => {
  it("T-WIN2.1a: when platform=win32, chmodDistEntrypoints() does not call fs.chmodSync", () => {
    // Given: the helper is imported; platform injected as "win32"; spy on fs.chmodSync is clean
    // When:  chmodDistEntrypoints({ platform: "win32", root: tmpDir }) is called
    // Then:  chmodSyncSpy.mock.calls.length === 0 (fs.chmodSync was NEVER called)

    if (!chmodDistEntrypoints) {
      assert.fail("TODO Step 5: scripts/chmod-dist.mjs not yet created (pre-impl)");
    }

    tmpDir = makeTmpRoot();

    // beforeEach already reset the spy; call count is 0 entering this test
    chmodDistEntrypoints({ platform: "win32", root: tmpDir });

    // Primary assertion (CONCERN-MR 1): spy proves chmodSync was NEVER called
    assert.equal(
      chmodSyncSpy.mock.calls.length,
      0,
      "T-WIN2.1a: fs.chmodSync must NEVER be called when platform=win32 (got " +
        chmodSyncSpy.mock.calls.length +
        " calls)",
    );
  });
});

// ─── G-WIN2.2: chmods 3 entrypoints on POSIX ────────────────────────────────

describe("G-WIN2.2 — chmod-dist: chmods 3 entrypoints to 0o755 on POSIX", () => {
  it("T-WIN2.2a: when platform=darwin, chmodDistEntrypoints() calls chmodSync EXACTLY 3 times with mode 0o755 and the 3 correct paths", () => {
    // Given: the helper is imported; platform injected as "darwin"; spy on fs.chmodSync is clean
    // When:  chmodDistEntrypoints({ platform: "darwin", root: tmpDir }) is called
    // Then:  chmodSyncSpy.mock.calls.length === 3; each call's mode arg is 0o755;
    //        each call's path arg ends in dist/cli/main.js, dist/app/sidecarMain.js,
    //        dist/app/updateServerMain.js (any order acceptable)

    if (!chmodDistEntrypoints) {
      assert.fail("TODO Step 5: scripts/chmod-dist.mjs not yet created (pre-impl)");
    }

    tmpDir = makeTmpRoot();

    // beforeEach already reset the spy; call count is 0 entering this test
    chmodDistEntrypoints({ platform: "darwin", root: tmpDir });

    // Primary assertion (CONCERN-MR 1): spy proves EXACTLY 3 chmodSync calls
    assert.equal(
      chmodSyncSpy.mock.calls.length,
      3,
      "T-WIN2.2a: fs.chmodSync must be called EXACTLY 3 times (got " + chmodSyncSpy.mock.calls.length + ")",
    );

    // Assert: every call used mode 0o755
    for (const call of chmodSyncSpy.mock.calls) {
      const [calledPath, calledMode] = call.arguments as [string, number];
      assert.equal(
        calledMode,
        0o755,
        `T-WIN2.2a: each chmodSync call must use mode 0o755 (0d755=${0o755}); ` +
          `got 0o${calledMode.toString(8)} for path ${calledPath}`,
      );
    }

    // Assert: the 3 expected path SUFFIXES are present (order-independent)
    const calledPaths = chmodSyncSpy.mock.calls.map((c) => (c.arguments as [string, number])[0].replace(/\\/g, "/"));

    for (const expected of ENTRYPOINTS) {
      assert.ok(
        calledPaths.some((p) => p.endsWith(expected)),
        `T-WIN2.2a: a chmodSync call with path ending '${expected}' must exist; got: ${JSON.stringify(calledPaths)}`,
      );
    }
  });

  it("T-WIN2.2b: when run as a script via node scripts/chmod-dist.mjs, exit code is 0 and files are 0o100755 (POSIX-only)", () => {
    // Given: a real post-build tree with dist/cli/main.js + dist/app/sidecarMain.js + dist/app/updateServerMain.js
    // When:  `node scripts/chmod-dist.mjs` is executed (via spawnSync — subprocess, NOT affected by spy)
    // Then:  exit code 0; each of the 3 files has mode 0o100755 (-rwxr-xr-x)
    // NOTE:  skipped when process.platform === "win32" — mode bits irrelevant on Windows

    if (process.platform === "win32") {
      // skip on Windows — POSIX mode bits not applicable
      return;
    }

    // Precondition: the 3 dist entrypoints must exist (built). Reset them to 0o644 so we
    // can prove the script actually applied the chmod (not just that they happened to be 0o755).
    const distEntrypoints = ENTRYPOINTS.map((rel) => join(REPO, rel));
    for (const fullPath of distEntrypoints) {
      // Uses the TEST FILE'S statically-imported chmodSync (REAL — NOT intercepted by spy).
      chmodSync(fullPath, 0o644);
    }

    // When: run the script as a real subprocess (subprocess is outside this test's mock.module)
    const result = spawnSync(process.execPath, [join(REPO, "scripts", "chmod-dist.mjs")], {
      cwd: REPO,
      encoding: "utf8",
    });

    // Then: exit code 0
    assert.equal(
      result.status,
      0,
      "T-WIN2.2b: node scripts/chmod-dist.mjs must exit 0 (stderr: " + (result.stderr ?? "") + ")",
    );

    // Then: all 3 entrypoints have mode 0o100755 (-rwxr-xr-x)
    for (const fullPath of distEntrypoints) {
      const mode = statSync(fullPath).mode;
      assert.equal(
        mode,
        0o100755,
        `T-WIN2.2b: ${fullPath} must have mode 0o100755 after script run; got 0o${mode.toString(8)}`,
      );
    }
  });
});
