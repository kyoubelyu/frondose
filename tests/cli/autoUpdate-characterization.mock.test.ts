/**
 * P-72 slice 9 — Step 3a characterization scaffolds (GREEN pre-split)
 *
 * Five characterization tests pinning load-bearing per-stage behavior in
 * src/cli/autoUpdate.ts (pre-split) before the barrel split happens.
 * These tests MUST stay GREEN both before AND after the split (G-P72s9.1).
 *
 * Test-file plan §5.A targets:
 *   T-autoUpdate.Lock.1    — acquireUpdateLock + releaseUpdateLock round-trip
 *   T-autoUpdate.Lock.2    — stale lock (>45 min) is reclaimed
 *   T-autoUpdate.Symlink.1 — derivePackageSymlink resolves npm-global path
 *   T-autoUpdate.Symlink.2 — isDevLink distinguishes dev-link from release-link
 *   T-autoUpdate.Gc.1      — gcOldReleases keeps last N, deletes older
 *
 * Covers gate: G-P72s9.1
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  acquireUpdateLock,
  derivePackageSymlink,
  gcOldReleases,
  isDevLink,
  releaseUpdateLock,
} from "../../src/cli/autoUpdate.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── isolation: each test gets its own FRONDOSE_HOME_BASE tmpdir ──────────────────
// Mirrors the pZ2 pattern from autoUpdate.mock.test.ts — lock/releases paths
// resolve via getHomeBase() = FRONDOSE_HOME_BASE ?? homedir(), so we override it
// per-test to avoid cross-test update.lock contamination and real ~/.mai touches.

let prevHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  prevHome = process.env.FRONDOSE_HOME_BASE;
  tmpHome = mkdtempSync(join(tmpdir(), "p72s9-char-"));
  process.env.FRONDOSE_HOME_BASE = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.FRONDOSE_HOME_BASE;
  else process.env.FRONDOSE_HOME_BASE = prevHome;
  cleanupTmpDir(tmpHome);
});

// Helper: resolve the update.lock path the same way production code does.
function updateLockPath(): string {
  return join(process.env.FRONDOSE_HOME_BASE!, ".frondose", "agent", "update.lock");
}

// ─── T-autoUpdate.Lock.1 ─────────────────────────────────────────────────────

describe("autoUpdate — lock primitives", () => {
  it("T-autoUpdate.Lock.1: when acquireUpdateLock is called on a fresh dir, returns positive fd; releaseUpdateLock removes the lock; a second acquire succeeds", () => {
    // Given: fresh FRONDOSE_HOME_BASE tmpdir (no pre-existing update.lock)
    // When:  acquireUpdateLock(nowMs) called → fd returned; releaseUpdateLock; second acquire
    // Then:  first fd > 0; lock file exists after first acquire; gone after release; second acquire succeeds

    const nowMs = Date.now();

    // First acquire
    const fd1 = acquireUpdateLock(nowMs);
    assert.ok(typeof fd1 === "number" && fd1 > 0, "fd1 should be a positive integer");
    assert.ok(existsSync(updateLockPath()), "lock file should exist after first acquire");

    // Release
    releaseUpdateLock(fd1);
    assert.ok(!existsSync(updateLockPath()), "lock file should be gone after releaseUpdateLock");

    // Second acquire on the same (now-released) lock path
    const fd2 = acquireUpdateLock(nowMs);
    assert.ok(typeof fd2 === "number" && fd2 > 0, "second acquire should succeed with positive fd");

    // Idempotent double-release must not throw
    releaseUpdateLock(fd2);
    releaseUpdateLock(fd2); // second call — fd already closed; must not throw

    assert.ok(true, "idempotent double-release did not throw");
  });

  // ─── T-autoUpdate.Lock.2 ─────────────────────────────────────────────────────

  it("T-autoUpdate.Lock.2: when an existing lock file is older than LOCK_STALE_MS (45 min), acquireUpdateLock reclaims it; a fresh lock older than 44 min is NOT reclaimed (EEXIST)", () => {
    // Given: pre-created stale lock file; nowMs = Date.now() + 50*60*1000 (50 min in future)
    // When:  acquireUpdateLock(nowMs) is called
    // Then:  stale lock is unlinked + replaced; lock file exists; fd > 0
    // Edge:  44 min (< 45 min LOCK_STALE_MS) must throw EEXIST

    const lockPath = updateLockPath();
    mkdirSync(join(process.env.FRONDOSE_HOME_BASE!, ".frondose", "agent"), { recursive: true });

    // Create the stale lock file (its mtime is "now" but nowMs will be 50 min in the future)
    writeFileSync(lockPath, "stale-marker");
    assert.ok(existsSync(lockPath), "precondition: lock file should exist");

    // nowMs is 50 min in the future → mtimeMs is ~50 min in the past → stale
    const nowMsStale = Date.now() + 50 * 60 * 1000;
    const fd = acquireUpdateLock(nowMsStale);
    assert.ok(typeof fd === "number" && fd > 0, "stale lock should be reclaimed: fd > 0");
    assert.ok(existsSync(lockPath), "new lock file should exist after reclaim");

    // Cleanup the fd from the reclaim
    releaseUpdateLock(fd);

    // Edge case: near-miss — 44 min old (< LOCK_STALE_MS of 45 min) should NOT be reclaimed
    writeFileSync(lockPath, "fresh-marker");
    const nowMsFresh = Date.now() + 44 * 60 * 1000;
    assert.throws(
      () => acquireUpdateLock(nowMsFresh),
      (err: NodeJS.ErrnoException) => {
        return err.code === "EEXIST";
      },
      "lock NOT older than 45 min should throw EEXIST",
    );

    // Cleanup manually (no fd to release since acquire threw)
    try {
      rmSync(lockPath, { force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // best-effort
    }
  });
});

// ─── T-autoUpdate.Symlink.1 + T-autoUpdate.Symlink.2 ────────────────────────

const skipOnWindows = process.platform === "win32" ? { skip: "POSIX symlink install layout" } : {};

describe("autoUpdate — symlink helpers", skipOnWindows, () => {
  it("T-autoUpdate.Symlink.1: derivePackageSymlink resolves the npm-global @kyoube/frondose symlink path from argv1; returns null for non-symlinks and non-package targets (F-REN-4b flip from @kyoube/mai-agent)", () => {
    // Given: tmpdir layout: bin/mai → ../lib/@kyoube/frondose/dist/cli/main.js; lib/@kyoube/frondose → ../releases/v0.4.15; lib/releases/v0.4.15/
    // When:  derivePackageSymlink(argv1) called with different argv1 values
    // Then:  returns the @kyoube/frondose symlink path for a valid global install; null otherwise

    const tmp = mkdtempSync(join(tmpdir(), "p72s9-symlink1-"));
    try {
      // Build the layout that mirrors a real npm-global install.
      // IMPORTANT: create real dirs first, then place symlinks ON TOP — never
      // mkdirSync a path that will become a symlink target or the symlink itself.
      mkdirSync(join(tmp, "bin"), { recursive: true });
      // Parent of the @kyoube/frondose symlink: lib/@kyoube/
      mkdirSync(join(tmp, "lib", "@kyoube"), { recursive: true });
      // Real release dir that the package-symlink points to
      mkdirSync(join(tmp, "lib", "releases", "v0.4.15"), { recursive: true });

      // bin/mai → ../lib/@kyoube/frondose/dist/cli/main.js
      // (dangling into the dist path is fine — readlink reads the target string, not the resolved file)
      const binMai = join(tmp, "bin", "mai");
      symlinkSync("../lib/@kyoube/frondose/dist/cli/main.js", binMai);

      // lib/@kyoube/frondose → ../../lib/releases/v0.4.15 (relative to the symlink's location)
      // The symlink lives at lib/@kyoube/frondose; its target must be resolvable from there.
      const pkgSymlinkPath = join(tmp, "lib", "@kyoube", "frondose");
      symlinkSync("../../releases/v0.4.15", pkgSymlinkPath);

      // Expected: the resolved path to lib/@kyoube/frondose (the npm-global package symlink)
      const result = derivePackageSymlink(binMai);
      assert.ok(result !== null, "result should not be null for a valid @kyoube/frondose global-install bin path");
      // The result should point to lib/@kyoube/frondose (may be a trailing slash variant — check without trailing slash)
      assert.ok(result.includes("@kyoube/frondose"), `result should contain '@kyoube/frondose'; got: ${result}`);

      // Edge case 1: non-symlink real file → null
      const realFile = join(tmp, "bin", "mai-not-symlink");
      writeFileSync(realFile, "#!/usr/bin/env node");
      assert.strictEqual(derivePackageSymlink(realFile), null, "non-symlink argv1 should return null");

      // Edge case 2: symlink target does NOT contain @kyoube/frondose (PKG_NAME) → null
      const wrongBin = join(tmp, "bin", "wrong");
      symlinkSync("/usr/local/bin/some-other-tool", wrongBin);
      assert.strictEqual(
        derivePackageSymlink(wrongBin),
        null,
        "symlink not pointing to @kyoube/frondose (or any recognized PKG_NAME) should return null",
      );
    } finally {
      cleanupTmpDir(tmp);
    }
  });

  it("T-autoUpdate.Symlink.2: isDevLink returns true when realpath contains .git; false when no .git; false when symlink is broken/missing", () => {
    // Given: two tmpdir layouts — one with .git under realpath, one without
    // When:  isDevLink(pkgSymlink) called on each
    // Then:  dev-link case → true; release-link → false; broken symlink → false

    const tmp = mkdtempSync(join(tmpdir(), "p72s9-symlink2-"));
    try {
      // Dev-link case: symlink → real dir that HAS a .git subdir
      const devRealDir = join(tmp, "dev-release");
      mkdirSync(join(devRealDir, ".git"), { recursive: true });
      const devSymlink = join(tmp, "dev-pkg");
      symlinkSync(devRealDir, devSymlink);

      assert.strictEqual(isDevLink(devSymlink), true, "symlink pointing to a dir with .git should return true");

      // Release-link case: symlink → real dir WITHOUT .git
      const releaseRealDir = join(tmp, "release-dir");
      mkdirSync(releaseRealDir, { recursive: true });
      const releaseSymlink = join(tmp, "release-pkg");
      symlinkSync(releaseRealDir, releaseSymlink);

      assert.strictEqual(
        isDevLink(releaseSymlink),
        false,
        "symlink pointing to a dir without .git should return false",
      );

      // Edge case: broken / missing symlink → false (realpathSync throws → catch → return false)
      const brokenSymlink = join(tmp, "broken-pkg");
      symlinkSync(join(tmp, "nonexistent-target"), brokenSymlink);

      assert.strictEqual(isDevLink(brokenSymlink), false, "broken/dangling symlink should return false");
    } finally {
      cleanupTmpDir(tmp);
    }
  });
});

// ─── T-autoUpdate.Gc.1 ───────────────────────────────────────────────────────

describe("autoUpdate — GC", () => {
  it("T-autoUpdate.Gc.1: gcOldReleases(releasesDir, 2) keeps the 2 newest versions and removes older; semver-aware; no-op when count <= keepLastN; silent when dir missing", () => {
    // Given: tmpdir/releases/ with 4 semver-named subdirs: v0.4.13, v0.4.14, v0.4.15, v0.4.16
    // When:  gcOldReleases(releasesDir, 2) is called
    // Then:  v0.4.13 + v0.4.14 deleted; v0.4.15 + v0.4.16 kept

    const tmp = mkdtempSync(join(tmpdir(), "p72s9-gc-"));
    try {
      const releasesDir = join(tmp, "releases");

      // Main case: 4 versions; keepLastN=2 → removes the 2 oldest
      mkdirSync(join(releasesDir, "v0.4.13"), { recursive: true });
      mkdirSync(join(releasesDir, "v0.4.14"), { recursive: true });
      mkdirSync(join(releasesDir, "v0.4.15"), { recursive: true });
      mkdirSync(join(releasesDir, "v0.4.16"), { recursive: true });

      gcOldReleases(releasesDir, 2);

      assert.ok(!existsSync(join(releasesDir, "v0.4.13")), "v0.4.13 should be removed");
      assert.ok(!existsSync(join(releasesDir, "v0.4.14")), "v0.4.14 should be removed");
      assert.ok(existsSync(join(releasesDir, "v0.4.15")), "v0.4.15 should be kept");
      assert.ok(existsSync(join(releasesDir, "v0.4.16")), "v0.4.16 should be kept");

      // Edge case 1: only 2 entries → no-op (count <= keepLastN)
      const noopDir = join(tmp, "noop-releases");
      mkdirSync(join(noopDir, "v0.4.15"), { recursive: true });
      mkdirSync(join(noopDir, "v0.4.16"), { recursive: true });

      gcOldReleases(noopDir, 2);

      assert.ok(existsSync(join(noopDir, "v0.4.15")), "v0.4.15 kept (noop case)");
      assert.ok(existsSync(join(noopDir, "v0.4.16")), "v0.4.16 kept (noop case)");

      // Edge case 2: non-existent releasesDir → returns silently
      assert.doesNotThrow(
        () => gcOldReleases(join(tmp, "nonexistent"), 2),
        "missing releasesDir should be a silent no-op",
      );

      // Edge case 3: semver-aware sort — v0.4.9, v0.4.10, v0.4.11, v0.4.12
      // Lexical sort would wrongly keep v0.4.9 + v0.4.10; semver sort must keep v0.4.11 + v0.4.12
      const semverDir = join(tmp, "semver-releases");
      mkdirSync(join(semverDir, "v0.4.9"), { recursive: true });
      mkdirSync(join(semverDir, "v0.4.10"), { recursive: true });
      mkdirSync(join(semverDir, "v0.4.11"), { recursive: true });
      mkdirSync(join(semverDir, "v0.4.12"), { recursive: true });

      gcOldReleases(semverDir, 2);

      assert.ok(!existsSync(join(semverDir, "v0.4.9")), "v0.4.9 should be removed (semver-aware)");
      assert.ok(!existsSync(join(semverDir, "v0.4.10")), "v0.4.10 should be removed (semver-aware)");
      assert.ok(existsSync(join(semverDir, "v0.4.11")), "v0.4.11 should be kept (semver-aware)");
      assert.ok(existsSync(join(semverDir, "v0.4.12")), "v0.4.12 should be kept (semver-aware)");
    } finally {
      cleanupTmpDir(tmp);
    }
  });
});
