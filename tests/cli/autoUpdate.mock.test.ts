/**
 * P-22 Step 4a scaffold — T-AUTO.1..15, T-BOOT.1..2, T-LINT.1, T-CONTRACT
 *
 * Mock tests for src/cli/autoUpdate.ts (created by builder Step 4b).
 *
 * Assertion bodies FILLED at Step 5.
 *
 * Gate coverage:
 *   G-P22.1  — T-AUTO.1
 *   G-P22.3  — T-AUTO.2
 *   G-P22.4  — T-AUTO.3
 *   G-P22.5  — T-AUTO.4
 *   G-P22.7  — T-AUTO.5
 *   G-P22.8  — T-AUTO.6, T-AUTO.15
 *   G-P22.6 + G-P22.13 — T-AUTO.7
 *   G-P22.10 — T-AUTO.8
 *   G-P22.11 — T-AUTO.9
 *   G-P22.12 — T-AUTO.10
 *   G-P22.17 — T-AUTO.11
 *   G-P22.15 — T-AUTO.12
 *   G-P22.16 — T-AUTO.13
 *   G-P22.18 — T-AUTO.14
 *   G-P22.9  — T-BOOT.1, T-BOOT.2
 *   G-P22.20 — T-LINT.1
 *   G-P22.19 (contract) — T-CONTRACT
 */

import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  type AutoUpdateDI,
  type AutoUpdateResult,
  gcOldReleases,
  runStartupAutoUpdate,
} from "../../src/cli/autoUpdate.js";

// P-Z2 (bucket 2): production autoUpdate.ts resolves lock/releases via getHomeBase()
// (= MAI_HOME_BASE ?? homedir()). Isolate each test under its OWN fresh MAI_HOME_BASE so
// (a) the clean-room shell-level MAI_HOME_BASE export does not share one home across all
// tests (cross-test update.lock contamination) and (b) the test helpers below resolve to
// the same dir production uses. The real ~/.mai is never touched.
let pZ2PrevHome: string | undefined;
let pZ2TmpHome: string;
beforeEach(() => {
  pZ2PrevHome = process.env.MAI_HOME_BASE;
  pZ2TmpHome = mkdtempSync(join(tmpdir(), "pZ2-autoupd-"));
  process.env.MAI_HOME_BASE = pZ2TmpHome;
});
afterEach(() => {
  if (pZ2PrevHome === undefined) delete process.env.MAI_HOME_BASE;
  else process.env.MAI_HOME_BASE = pZ2PrevHome;
  rmSync(pZ2TmpHome, { recursive: true, force: true });
});

// ─── version helpers ──────────────────────────────────────────────────────────

const _req = createRequire(import.meta.url);
const LOCAL_VER: string = (_req("../../package.json") as { version: string }).version;
const LOCAL_TAG = `v${LOCAL_VER}`;

// P-Z2: a release tag reliably NEWER than LOCAL but with the SAME major (so it triggers
// the normal update flow, not the major_bump short-circuit). Derived from LOCAL_VER so it
// never goes stale as the package version advances (the old hardcoded NEWER_TAG fell BELOW
// the bumped local 0.5.0-alpha.x → tests short-circuited as up_to_date).
const _localParts = LOCAL_VER.split(".");
const NEWER_TAG = `v${_localParts[0]}.${Number(_localParts[1]) + 1}.0`;

// ─── path helpers ─────────────────────────────────────────────────────────────

// P-Z2: mirror production getHomeBase() (MAI_HOME_BASE ?? homedir()) so the test's
// fixture paths match where autoUpdate.ts actually reads/writes.
function pZ2HomeBase(): string {
  return process.env.MAI_HOME_BASE ?? homedir();
}
function updateLockPath(): string {
  return join(pZ2HomeBase(), ".mai", "agent", "update.lock");
}
function releasesDirPath(): string {
  return join(pZ2HomeBase(), ".mai", "agent", "releases");
}

// ─── mock helpers ──────────────────────────────────────────────────────────────

/** Create a mock fetch that resolves a JSON release object for the given tag. */
function makeMockReleaseFetch(
  tagName: string,
  tarballUrl = `https://codeload.github.com/kyoubelyu/mai-agent/legacy.tar.gz/refs/tags/${tagName}`,
): AutoUpdateDI["fetchImpl"] {
  return async (_url, _opts) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ tag_name: tagName, tarball_url: tarballUrl }),
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
  };
}

/** Create a mock fetch that throws the given error. */
function makeErrorFetch(err: Error): AutoUpdateDI["fetchImpl"] {
  return async () => {
    throw err;
  };
}

/** Create a mock spawnSync that returns {status:0} for all calls. */
function makeSuccessSpawn(): {
  impl: AutoUpdateDI["spawnSyncImpl"];
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const impl: AutoUpdateDI["spawnSyncImpl"] = (cmd, args = [], _opts = {}) => {
    calls.push({ cmd: String(cmd), args: args as string[] });
    return {
      status: 0,
      signal: null,
      output: [],
      pid: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    } as SpawnSyncReturns<Buffer>;
  };
  return { impl, calls };
}

/** Create a mock spawnSync that returns the given status for the given command, 0 for others. */
function makePartialFailSpawn(
  failCmd: string,
  failArgs: string[],
  failStatus: number,
): {
  impl: AutoUpdateDI["spawnSyncImpl"];
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const impl: AutoUpdateDI["spawnSyncImpl"] = (cmd, args = [], _opts = {}) => {
    const cmdStr = String(cmd);
    const argsArr = args as string[];
    calls.push({ cmd: cmdStr, args: argsArr });
    const isFailTarget = cmdStr === failCmd && failArgs.every((fa) => argsArr.includes(fa));
    return {
      status: isFailTarget ? failStatus : 0,
      signal: null,
      output: [],
      pid: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    } as SpawnSyncReturns<Buffer>;
  };
  return { impl, calls };
}

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p22-auto-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Capture process.stderr.write output during fn().
 */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stderr as any).write = (chunk: string | Buffer): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stderr as any).write = origWrite;
  }
  return chunks.join("");
}

/**
 * Build a symlink structure where argv[1] is a symlink whose target contains
 * `@kyoube/mai-agent`, allowing derivePackageSymlink to resolve pkgSymlink.
 *
 *   dir/bin/mai  →  ../lib/@kyoube/mai-agent/dist/cli/main.js  (dangling OK)
 *   dir/lib/@kyoube/mai-agent  →  ../releases/v0.4.15  (symlink to version dir)
 *   dir/lib/releases/v0.4.15/  (real dir; .git/ created when devLink=true)
 *
 * Returns { argv1, pkgSymlink }:
 *   argv1     = dir/bin/mai (the symlink process.argv[1] points to)
 *   pkgSymlink = dir/lib/@kyoube/mai-agent (the resolved package symlink)
 */
function makeSymlinkSetup(dir: string, devLink: boolean): { argv1: string; pkgSymlink: string } {
  const binDir = join(dir, "bin");
  const libDir = join(dir, "lib", "@kyoube");
  const versionDir = join(dir, "lib", "releases", "v0.4.15");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });
  mkdirSync(versionDir, { recursive: true });
  if (devLink) {
    mkdirSync(join(versionDir, ".git"), { recursive: true });
  }

  // lib/@kyoube/mai-agent → ../releases/v0.4.15
  const pkgSymlink = join(libDir, "mai-agent");
  symlinkSync(join("..", "releases", "v0.4.15"), pkgSymlink);

  // bin/mai → ../lib/@kyoube/mai-agent/dist/cli/main.js  (dangling — readlinkSync only reads link target)
  const argv1 = join(binDir, "mai");
  symlinkSync("../lib/@kyoube/mai-agent/dist/cli/main.js", argv1);

  return { argv1, pkgSymlink };
}

// ─── T-AUTO.1..6, T-AUTO.15: skip conditions ─────────────────────────────────

describe("autoUpdate — skip conditions", () => {
  it("T-AUTO.1: when MAI_AUTOUPDATE='skip', runStartupAutoUpdate → {action:'skipped',reason:'opt_out'}; no fetch, no spawn", async () => {
    // Given: process.env.MAI_AUTOUPDATE === 'skip'; DI provides tracked fetchImpl + spawnSyncImpl
    // When:  runStartupAutoUpdate({ fetchImpl, spawnSyncImpl, nowMs }) called
    // Then:  returns {action:'skipped',reason:'opt_out'}; fetchImpl call count = 0; spawnSyncImpl call count = 0
    const origMai = process.env.MAI_AUTOUPDATE;
    process.env.MAI_AUTOUPDATE = "skip";
    let fetchCallCount = 0;
    const trackingFetch: AutoUpdateDI["fetchImpl"] = async () => {
      fetchCallCount++;
      throw new Error("unexpected fetch call");
    };
    const { impl: spawnFn, calls: spawnCalls } = makeSuccessSpawn();
    try {
      const result = await runStartupAutoUpdate({ fetchImpl: trackingFetch, spawnSyncImpl: spawnFn });
      assert.equal(result.action, "skipped", "action must be skipped");
      assert.equal(result.reason, "opt_out", "reason must be opt_out");
      assert.equal(fetchCallCount, 0, "fetchImpl must not be called when MAI_AUTOUPDATE=skip");
      assert.equal(spawnCalls.length, 0, "spawnSyncImpl must not be called when MAI_AUTOUPDATE=skip");
    } finally {
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
    }
  });

  it("T-AUTO.2: when GH_TOKEN unset and github.json absent, runStartupAutoUpdate → {action:'skipped',reason:'no_token'}; no fetch", async () => {
    // Given: process.env.GH_TOKEN unset; HOME overridden to empty tmpDir (no secrets.json, no github.json)
    // When:  runStartupAutoUpdate({ fetchImpl: trackedFetch, ... }) called
    // Then:  returns {action:'skipped',reason:'no_token'}; fetchImpl never called
    //
    // NOTE (P-24 fix): readGithubConfig() now routes through readSecrets() with P-24 legacy fallback.
    // Without HOME isolation, the fallback reads real ~/.mai/agent/secrets.json which may contain
    // a real GitHub token, causing 'network' instead of 'no_token'. We override HOME to an empty
    // tmpDir so readGithubConfig() finds no token anywhere in the fallback chain.
    const origMai = process.env.MAI_AUTOUPDATE;
    const origToken = process.env.GH_TOKEN;
    const origHome = process.env.HOME;
    const tmpHome = mkdtempSync(join(tmpdir(), "mai-p22-t2-home-"));
    delete process.env.MAI_AUTOUPDATE; // ensure opt_out doesn't fire first
    delete process.env.GH_TOKEN;
    process.env.HOME = tmpHome;
    let fetchCallCount = 0;
    const trackingFetch: AutoUpdateDI["fetchImpl"] = async () => {
      fetchCallCount++;
      throw new Error("unexpected fetch call");
    };
    try {
      const result = await runStartupAutoUpdate({ fetchImpl: trackingFetch });
      assert.equal(result.action, "skipped", "action must be skipped");
      assert.equal(result.reason, "no_token", "reason must be no_token");
      assert.equal(fetchCallCount, 0, "fetchImpl must not be called when no token");
    } finally {
      process.env.HOME = origHome;
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
      try {
        rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("T-AUTO.3: when latest tag equals local version, runStartupAutoUpdate → {action:'skipped',reason:'up_to_date'}", async () => {
    // Given: GH_TOKEN set; fetchImpl returns { tag_name: LOCAL_TAG }; local pkg.version == LOCAL_VER
    // When:  runStartupAutoUpdate({ fetchImpl }) called
    // Then:  returns {action:'skipped',reason:'up_to_date'}; no spawnSync calls; no fs writes
    const origMai = process.env.MAI_AUTOUPDATE;
    const origToken = process.env.GH_TOKEN;
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p22-3";
    const { impl: spawnFn, calls: spawnCalls } = makeSuccessSpawn();
    try {
      const result = await runStartupAutoUpdate({
        fetchImpl: makeMockReleaseFetch(LOCAL_TAG),
        spawnSyncImpl: spawnFn,
      });
      assert.equal(result.action, "skipped", "action must be skipped");
      assert.equal(result.reason, "up_to_date", "reason must be up_to_date when latest === local");
      assert.equal(spawnCalls.length, 0, "spawnSyncImpl must not be called for up_to_date");
    } finally {
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
      // lock is released by runStartupAutoUpdate's finally block
    }
  });

  it("T-AUTO.4: when local version is ahead of latest, runStartupAutoUpdate → {action:'skipped',reason:'local_ahead'}", async () => {
    // Given: fetchImpl returns { tag_name: 'v0.4.0' }; local version is newer
    // When:  runStartupAutoUpdate called
    // Then:  returns {action:'skipped',reason:'local_ahead'}
    const origMai = process.env.MAI_AUTOUPDATE;
    const origToken = process.env.GH_TOKEN;
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p22-4";
    try {
      const result = await runStartupAutoUpdate({
        fetchImpl: makeMockReleaseFetch("v0.4.0"), // older than LOCAL_VER (0.4.15+)
      });
      assert.equal(result.action, "skipped", "action must be skipped");
      assert.equal(result.reason, "local_ahead", "reason must be local_ahead when local > latest");
    } finally {
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
    }
  });

  it("T-AUTO.5: when latest major > local major, runStartupAutoUpdate → {action:'skipped',reason:'major_bump'} + stderr notice", async () => {
    // Given: fetchImpl returns { tag_name: 'v1.0.0' }; local version is '0.4.15'
    // When:  runStartupAutoUpdate called; stderr captured
    // Then:  returns {action:'skipped',reason:'major_bump',latestTag:'v1.0.0'};
    //        process.stderr received "[mai] Major version available..." one-liner
    const origMai = process.env.MAI_AUTOUPDATE;
    const origToken = process.env.GH_TOKEN;
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p22-5";
    let result: AutoUpdateResult | undefined;
    let stderr = "";
    try {
      stderr = await captureStderr(async () => {
        result = await runStartupAutoUpdate({
          fetchImpl: makeMockReleaseFetch("v1.0.0"),
        });
      });
    } finally {
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
    }
    assert.ok(result !== undefined, "result must be defined");
    assert.equal(result.action, "skipped", "action must be skipped");
    assert.equal(result.reason, "major_bump", "reason must be major_bump for major version bump");
    assert.equal(result.latestTag, "v1.0.0", "latestTag must be v1.0.0");
    assert.ok(
      stderr.includes("[mai] Major version available"),
      `stderr must contain major-bump advisory; got: "${stderr}"`,
    );
  });

  it("T-AUTO.6: when dev-link detected and force=false, runStartupAutoUpdate → {action:'skipped',reason:'dev_link'} + advisory stderr", async () => {
    // Given: fetchImpl returns latest > local; argv1Override points to a path that resolves as dev-link
    //        (.git/ present in realpath of pkgSymlink); force=false (default)
    // When:  runStartupAutoUpdate({ fetchImpl, argv1Override, nowMs }) called; stderr captured
    // Then:  returns {action:'skipped',reason:'dev_link'};
    //        process.stderr contains "dev source (npm link)" advisory message
    const { dir, cleanup } = makeTmpDir();
    const origMai = process.env.MAI_AUTOUPDATE;
    const origToken = process.env.GH_TOKEN;
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p22-6";
    let result: AutoUpdateResult | undefined;
    let stderr = "";
    try {
      const { argv1 } = makeSymlinkSetup(dir, true /* devLink */);
      stderr = await captureStderr(async () => {
        result = await runStartupAutoUpdate({
          fetchImpl: makeMockReleaseFetch(NEWER_TAG), // newer than local
          argv1Override: argv1,
          force: false,
        });
      });
    } finally {
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
      cleanup();
    }
    assert.ok(result !== undefined, "result must be defined");
    assert.equal(result.action, "skipped", "action must be skipped");
    assert.equal(result.reason, "dev_link", "reason must be dev_link for npm-link checkout");
    assert.ok(stderr.includes("dev source (npm link)"), `stderr must contain dev-link advisory; got: "${stderr}"`);
  });

  it("T-AUTO.15: when derivePackageSymlink returns null (argv[1] not a symlink), runStartupAutoUpdate → {action:'skipped',reason:'not_global_install'}", async () => {
    // Given: fetchImpl returns latest > local; argv1Override = real non-symlink file path
    // When:  runStartupAutoUpdate({ fetchImpl, argv1Override }) called
    // Then:  returns {action:'skipped',reason:'not_global_install'}; no spawnSync
    const { dir, cleanup } = makeTmpDir();
    const origMai = process.env.MAI_AUTOUPDATE;
    const origToken = process.env.GH_TOKEN;
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p22-15";
    // Create a real (non-symlink) file
    const realFilePath = join(dir, "mai-not-symlink");
    writeFileSync(realFilePath, "#!/usr/bin/env node\n");
    const { impl: spawnFn, calls: spawnCalls } = makeSuccessSpawn();
    try {
      const result = await runStartupAutoUpdate({
        fetchImpl: makeMockReleaseFetch(NEWER_TAG),
        argv1Override: realFilePath,
        spawnSyncImpl: spawnFn,
      });
      assert.equal(result.action, "skipped", "action must be skipped");
      assert.equal(
        result.reason,
        "not_global_install",
        "reason must be not_global_install when argv1 is not a symlink",
      );
      assert.equal(spawnCalls.length, 0, "spawnSyncImpl must not be called for not_global_install");
    } finally {
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
      cleanup();
    }
  });
});

// ─── T-AUTO.7: full success path ─────────────────────────────────────────────

describe("autoUpdate — full update flow", () => {
  it("T-AUTO.7: when latest > local + release-dir install + all steps succeed, runStartupAutoUpdate performs download/extract/install/build/swap/re-exec", async () => {
    // Given: GH_TOKEN set; fetchImpl returns {tag_name:'v0.4.99'}; local='0.4.15';
    //        argv1Override points to a tmp symlink (not dev-link);
    //        spawnSyncImpl returns {status:0} for tar, npm install, npm run build, re-exec;
    //        downloadTarball succeeds (fetchImpl returns arrayBuffer)
    // When:  runStartupAutoUpdate({ fetchImpl, spawnSyncImpl, nowMs, argv1Override }) called
    // Then:  returns {action:'updated',latestTag:'v0.4.99'};
    //        spawnSyncImpl calls include: tar -xzf, npm install --prefer-offline, npm run build, re-exec;
    //        process.exit called with child.status (0)
    const { dir, cleanup } = makeTmpDir();
    const origMai = process.env.MAI_AUTOUPDATE;
    const origToken = process.env.GH_TOKEN;
    const origExit = process.exit.bind(process);
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p22-7";
    let exitCode: number | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process as any).exit = (code?: number) => {
      exitCode = code;
    };
    const { impl: spawnFn, calls: spawnCalls } = makeSuccessSpawn();
    try {
      const { argv1 } = makeSymlinkSetup(dir, false /* non-dev-link */);
      const result = await runStartupAutoUpdate({
        fetchImpl: makeMockReleaseFetch(NEWER_TAG),
        spawnSyncImpl: spawnFn,
        argv1Override: argv1,
      });
      assert.equal(result.action, "updated", "action must be updated");
      assert.equal(result.latestTag, NEWER_TAG, "latestTag must match fetched tag");
      assert.equal(exitCode, 0, "process.exit(0) must have been called for re-exec");
      // Verify all build steps were invoked
      assert.ok(
        spawnCalls.some((c) => c.cmd === "tar" && c.args.includes("-xzf")),
        "tar -xzf must be called",
      );
      assert.ok(
        spawnCalls.some((c) => c.cmd === "npm" && c.args.includes("install") && c.args.includes("--prefer-offline")),
        "npm install --prefer-offline must be called",
      );
      assert.ok(
        spawnCalls.some((c) => c.cmd === "npm" && c.args.includes("run") && c.args.includes("build")),
        "npm run build must be called",
      );
      // Re-exec: spawns process.execPath with argv1 as first arg
      assert.ok(
        spawnCalls.some((c) => c.cmd === process.execPath),
        "re-exec with process.execPath must be called",
      );
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = origExit;
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
      // Clean up release dir created in real homedir
      try {
        rmSync(join(releasesDirPath(), NEWER_TAG), { recursive: true, force: true });
      } catch {}
      try {
        unlinkSync(join(releasesDirPath(), `${NEWER_TAG}.tar.gz`));
      } catch {}
      cleanup();
    }
  });

  it("T-AUTO.8: when tar extract exits non-zero, runStartupAutoUpdate → {action:'failed',reason:'extract'}; partial dir removed; no re-exec", async () => {
    // Given: spawnSyncImpl returns {status:1} for 'tar' command; {status:0} for others
    // When:  runStartupAutoUpdate called with full setup except broken tar
    // Then:  returns {action:'failed',reason:'extract'};
    //        releaseDir removed (cleanupPartial called); spawnSyncImpl NOT called for npm or re-exec
    const { dir, cleanup } = makeTmpDir();
    const origMai = process.env.MAI_AUTOUPDATE;
    const origToken = process.env.GH_TOKEN;
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p22-8";
    const { impl: spawnFn, calls: spawnCalls } = makePartialFailSpawn("tar", ["-xzf"], 1);
    try {
      const { argv1 } = makeSymlinkSetup(dir, false);
      const result = await runStartupAutoUpdate({
        fetchImpl: makeMockReleaseFetch(NEWER_TAG),
        spawnSyncImpl: spawnFn,
        argv1Override: argv1,
      });
      assert.equal(result.action, "failed", "action must be failed");
      assert.equal(result.reason, "extract", "reason must be extract when tar exits non-zero");
      // npm and re-exec must NOT be called after extract failure
      assert.ok(!spawnCalls.some((c) => c.cmd === "npm"), "npm must not be called after extract failure");
      assert.ok(!spawnCalls.some((c) => c.cmd === process.execPath), "re-exec must not happen after extract failure");
      // Release dir must be cleaned up by cleanupPartial
      const releaseDir = join(releasesDirPath(), NEWER_TAG);
      assert.ok(!existsSync(releaseDir), "release dir must be removed after extract failure");
    } finally {
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
      try {
        rmSync(join(releasesDirPath(), NEWER_TAG), { recursive: true, force: true });
      } catch {}
      try {
        unlinkSync(join(releasesDirPath(), `${NEWER_TAG}.tar.gz`));
      } catch {}
      cleanup();
    }
  });

  it("T-AUTO.9: when npm install exits 137 (OOM), runStartupAutoUpdate → {action:'failed',reason:'install'}; release dir removed", async () => {
    // Given: tar returns {status:0}; 'npm install' returns {status:137}
    // When:  runStartupAutoUpdate called
    // Then:  returns {action:'failed',reason:'install'}; release dir cleaned up
    const { dir, cleanup } = makeTmpDir();
    const origMai = process.env.MAI_AUTOUPDATE;
    const origToken = process.env.GH_TOKEN;
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p22-9";
    // Fail npm install (status 137, OOM); tar and npm run build pass
    const { impl: spawnFn, calls: spawnCalls } = makePartialFailSpawn("npm", ["install", "--prefer-offline"], 137);
    try {
      const { argv1 } = makeSymlinkSetup(dir, false);
      const result = await runStartupAutoUpdate({
        fetchImpl: makeMockReleaseFetch(NEWER_TAG),
        spawnSyncImpl: spawnFn,
        argv1Override: argv1,
      });
      assert.equal(result.action, "failed", "action must be failed");
      assert.equal(result.reason, "install", "reason must be install when npm install exits 137");
      // tar must have been called
      assert.ok(
        spawnCalls.some((c) => c.cmd === "tar"),
        "tar must have been called before install",
      );
      // npm run build must NOT be called after install failure
      assert.ok(
        !spawnCalls.some((c) => c.cmd === "npm" && c.args.includes("run") && c.args.includes("build")),
        "npm run build must not be called after install failure",
      );
      // Release dir must be cleaned up
      const releaseDir = join(releasesDirPath(), NEWER_TAG);
      assert.ok(!existsSync(releaseDir), "release dir must be removed after install failure");
    } finally {
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
      try {
        rmSync(join(releasesDirPath(), NEWER_TAG), { recursive: true, force: true });
      } catch {}
      try {
        unlinkSync(join(releasesDirPath(), `${NEWER_TAG}.tar.gz`));
      } catch {}
      cleanup();
    }
  });

  it("T-AUTO.10: when npm run build exits 2 (TypeScript error), runStartupAutoUpdate → {action:'failed',reason:'build'}; release dir removed", async () => {
    // Given: tar returns {status:0}; npm install returns {status:0}; 'npm run build' returns {status:2}
    // When:  runStartupAutoUpdate called
    // Then:  returns {action:'failed',reason:'build'}; release dir cleaned up; no re-exec
    const { dir, cleanup } = makeTmpDir();
    const origMai = process.env.MAI_AUTOUPDATE;
    const origToken = process.env.GH_TOKEN;
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p22-10";
    // Fail npm run build (status 2); tar and npm install pass
    const { impl: spawnFn, calls: spawnCalls } = makePartialFailSpawn("npm", ["run", "build"], 2);
    try {
      const { argv1 } = makeSymlinkSetup(dir, false);
      const result = await runStartupAutoUpdate({
        fetchImpl: makeMockReleaseFetch(NEWER_TAG),
        spawnSyncImpl: spawnFn,
        argv1Override: argv1,
      });
      assert.equal(result.action, "failed", "action must be failed");
      assert.equal(result.reason, "build", "reason must be build when npm run build exits non-zero");
      // tar and npm install must have been called
      assert.ok(
        spawnCalls.some((c) => c.cmd === "tar"),
        "tar must have been called",
      );
      assert.ok(
        spawnCalls.some((c) => c.cmd === "npm" && c.args.includes("install")),
        "npm install must have been called before build",
      );
      // Re-exec must NOT be called after build failure
      assert.ok(!spawnCalls.some((c) => c.cmd === process.execPath), "re-exec must not happen after build failure");
      // Release dir must be cleaned up
      const releaseDir = join(releasesDirPath(), NEWER_TAG);
      assert.ok(!existsSync(releaseDir), "release dir must be removed after build failure");
    } finally {
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
      try {
        rmSync(join(releasesDirPath(), NEWER_TAG), { recursive: true, force: true });
      } catch {}
      try {
        unlinkSync(join(releasesDirPath(), `${NEWER_TAG}.tar.gz`));
      } catch {}
      cleanup();
    }
  });

  it("T-AUTO.11: when fetchLatestTag throws AbortError, runStartupAutoUpdate → {action:'skipped',reason:'network'}; logged to update.log", async () => {
    // Given: fetchImpl throws network error (AbortError / timeout)
    // When:  runStartupAutoUpdate called with GH_TOKEN set
    // Then:  returns {action:'skipped',reason:'network'}; no spawnSync calls
    const origMai = process.env.MAI_AUTOUPDATE;
    const origToken = process.env.GH_TOKEN;
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p22-11";
    const networkError = Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" });
    const { impl: spawnFn, calls: spawnCalls } = makeSuccessSpawn();
    try {
      const result = await runStartupAutoUpdate({
        fetchImpl: makeErrorFetch(networkError),
        spawnSyncImpl: spawnFn,
      });
      assert.equal(result.action, "skipped", "action must be skipped for network error");
      assert.equal(result.reason, "network", "reason must be network for AbortError");
      assert.equal(spawnCalls.length, 0, "spawnSyncImpl must not be called when fetch fails");
    } finally {
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
    }
  });
});

// ─── T-AUTO.12..13: lock handling ────────────────────────────────────────────

describe("autoUpdate — lock handling", () => {
  it("T-AUTO.12: when update.lock exists with mtime < 45 min ago, runStartupAutoUpdate → {action:'skipped',reason:'lock_busy'}; no fetch, no spawn", async () => {
    // Given: update.lock file exists at the lock path; mtime is just now (NOT stale < 45min);
    //        LOCK_STALE_MS = 45*60*1000 so it is NOT stale; we did not acquire it
    // When:  runStartupAutoUpdate({ nowMs: () => Date.now() }) called
    // Then:  returns {action:'skipped',reason:'lock_busy'}; fetchImpl NOT called; spawnSyncImpl NOT called
    const origMai = process.env.MAI_AUTOUPDATE;
    const origToken = process.env.GH_TOKEN;
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p22-12";
    // Pre-create the lock file so acquireUpdateLock sees EEXIST
    mkdirSync(dirname(updateLockPath()), { recursive: true });
    writeFileSync(updateLockPath(), "held");
    let fetchCallCount = 0;
    const trackingFetch: AutoUpdateDI["fetchImpl"] = async () => {
      fetchCallCount++;
      throw new Error("unexpected fetch call");
    };
    const { impl: spawnFn, calls: spawnCalls } = makeSuccessSpawn();
    try {
      const result = await runStartupAutoUpdate({
        fetchImpl: trackingFetch,
        spawnSyncImpl: spawnFn,
        nowMs: () => Date.now(), // fresh time — lock is NOT stale
      });
      assert.equal(result.action, "skipped", "action must be skipped");
      assert.equal(result.reason, "lock_busy", "reason must be lock_busy when lock exists and is fresh");
      assert.equal(fetchCallCount, 0, "fetchImpl must not be called when lock_busy");
      assert.equal(spawnCalls.length, 0, "spawnSyncImpl must not be called when lock_busy");
    } finally {
      // The function never acquired the lock (threw EEXIST), so WE must clean it up
      try {
        unlinkSync(updateLockPath());
      } catch {}
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
    }
  });

  it("T-AUTO.13: when update.lock exists with mtime > 45 min ago (stale), runStartupAutoUpdate reaps stale lock, acquires fresh lock, proceeds", async () => {
    // Given: update.lock file exists; mtime is 50 min ago (stale > LOCK_STALE_MS=45min);
    //        fetchImpl returns up_to_date so flow terminates at version check
    // When:  runStartupAutoUpdate({ nowMs: () => Date.now() + 50min }) called
    // Then:  stale lock unlinked; new lock created; returns non-lock_busy result (up_to_date)
    const origMai = process.env.MAI_AUTOUPDATE;
    const origToken = process.env.GH_TOKEN;
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p22-13";
    mkdirSync(dirname(updateLockPath()), { recursive: true });
    writeFileSync(updateLockPath(), "stale");
    try {
      // nowMs returns 50 min in the future — so the lock's current mtime looks 50 min old
      const result = await runStartupAutoUpdate({
        fetchImpl: makeMockReleaseFetch(LOCAL_TAG), // up_to_date → early return
        nowMs: () => Date.now() + 50 * 60 * 1000,
      });
      // Key: must NOT return lock_busy (stale lock was reaped)
      assert.notEqual(result.reason, "lock_busy", "must NOT return lock_busy for stale lock");
      assert.equal(result.action, "skipped", "action must be skipped (up_to_date after stale lock reaped)");
      assert.equal(result.reason, "up_to_date", "reason must be up_to_date after stale lock reaped");
    } finally {
      // The new lock is released + unlinked by the function's finally block; best-effort cleanup
      try {
        unlinkSync(updateLockPath());
      } catch {}
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
    }
  });
});

// ─── T-AUTO.14: GC behavior ──────────────────────────────────────────────────

describe("autoUpdate — GC", () => {
  it("T-AUTO.14: when successful update completes, GC retains newest 2 versioned release dirs; older dirs purged", async () => {
    // Given: releases dir contains v0.4.13/, v0.4.14/, v0.4.15/ (3 dirs) + v0.4.16/ (new update dir)
    // When:  gcOldReleases(releasesDir, 2) called (same function called by runStartupAutoUpdate)
    // Then:  v0.4.15/ and v0.4.16/ retained; v0.4.13/ and v0.4.14/ removed
    // NOTE:  gcOldReleases is exported — tested directly with a temp dir to avoid real-homedir side effects.
    const { dir, cleanup } = makeTmpDir();
    try {
      const releasesDir = join(dir, "releases");
      // Pre-populate: 3 existing + 1 new (as would exist after update download)
      for (const v of ["v0.4.13", "v0.4.14", "v0.4.15", "v0.4.16"]) {
        mkdirSync(join(releasesDir, v), { recursive: true });
      }
      // Run GC with keepLastN=2 (same arguments as autoUpdate.ts line 202)
      gcOldReleases(releasesDir, 2);
      // Older two must be purged
      assert.ok(!existsSync(join(releasesDir, "v0.4.13")), "v0.4.13/ must be purged by GC");
      assert.ok(!existsSync(join(releasesDir, "v0.4.14")), "v0.4.14/ must be purged by GC");
      // Newer two must be retained
      assert.ok(existsSync(join(releasesDir, "v0.4.15")), "v0.4.15/ must be retained by GC");
      assert.ok(existsSync(join(releasesDir, "v0.4.16")), "v0.4.16/ must be retained by GC");
    } finally {
      cleanup();
    }
  });
});

// ─── T-BOOT.1..2: bootstrap (--bootstrap flag) ───────────────────────────────

describe("autoUpdate — bootstrap (--bootstrap flag)", () => {
  it("T-BOOT.1: when dev-link mode + force=true (--bootstrap), runStartupAutoUpdate bypasses dev-link guard and runs full flow", async () => {
    // Given: argv1Override points to a path that resolves as dev-link (.git/ inside version dir);
    //        force=true; source='bootstrap'; fetchImpl returns latest > local;
    //        spawnSyncImpl returns {status:0} for all steps
    // When:  runStartupAutoUpdate({ force: true, source: 'bootstrap', fetchImpl, spawnSyncImpl, argv1Override }) called
    // Then:  returns {action:'updated',latestTag:'v0.4.99'};
    //        dev_link reason NOT returned (isDevLink check skipped by force=true);
    //        all spawn steps (tar, npm install, npm run build, re-exec) invoked
    const { dir, cleanup } = makeTmpDir();
    const origMai = process.env.MAI_AUTOUPDATE;
    const origToken = process.env.GH_TOKEN;
    const origExit = process.exit.bind(process);
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p22-boot1";
    let exitCode: number | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process as any).exit = (code?: number) => {
      exitCode = code;
    };
    const { impl: spawnFn, calls: spawnCalls } = makeSuccessSpawn();
    try {
      const { argv1 } = makeSymlinkSetup(dir, true /* devLink */);
      const result = await runStartupAutoUpdate({
        fetchImpl: makeMockReleaseFetch(NEWER_TAG),
        spawnSyncImpl: spawnFn,
        argv1Override: argv1,
        force: true,
        source: "bootstrap",
      });
      // Must NOT return dev_link (force bypasses that check)
      assert.notEqual(result.reason, "dev_link", "dev_link guard must be bypassed when force=true");
      assert.equal(result.action, "updated", "action must be updated (dev_link bypass ran full flow)");
      assert.equal(result.latestTag, NEWER_TAG, "latestTag must match fetched tag");
      assert.equal(exitCode, 0, "process.exit(0) must have been called for re-exec");
      // All build steps must be called
      assert.ok(
        spawnCalls.some((c) => c.cmd === "tar"),
        "tar must be called",
      );
      assert.ok(
        spawnCalls.some((c) => c.cmd === "npm" && c.args.includes("install")),
        "npm install must be called",
      );
      assert.ok(
        spawnCalls.some((c) => c.cmd === "npm" && c.args.includes("build")),
        "npm run build must be called",
      );
      assert.ok(
        spawnCalls.some((c) => c.cmd === process.execPath),
        "re-exec must be called",
      );
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = origExit;
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
      try {
        rmSync(join(releasesDirPath(), NEWER_TAG), { recursive: true, force: true });
      } catch {}
      try {
        unlinkSync(join(releasesDirPath(), `${NEWER_TAG}.tar.gz`));
      } catch {}
      cleanup();
    }
  });

  it("T-BOOT.2: when NOT dev-link + force=true (--bootstrap, idempotent), runStartupAutoUpdate treats as regular update", async () => {
    // Given: argv1Override points to a non-dev-link path (no .git/ sibling);
    //        force=true; fetchImpl returns latest > local; spawnSyncImpl all {status:0}
    // When:  runStartupAutoUpdate({ force: true, source: 'bootstrap', fetchImpl, spawnSyncImpl, argv1Override }) called
    // Then:  returns {action:'updated',...}; same as T-AUTO.7 — idempotent behavior
    const { dir, cleanup } = makeTmpDir();
    const origMai = process.env.MAI_AUTOUPDATE;
    const origToken = process.env.GH_TOKEN;
    const origExit = process.exit.bind(process);
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p22-boot2";
    let exitCode: number | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process as any).exit = (code?: number) => {
      exitCode = code;
    };
    const { impl: spawnFn } = makeSuccessSpawn();
    try {
      const { argv1 } = makeSymlinkSetup(dir, false /* non-dev-link */);
      const result = await runStartupAutoUpdate({
        fetchImpl: makeMockReleaseFetch(NEWER_TAG),
        spawnSyncImpl: spawnFn,
        argv1Override: argv1,
        force: true,
        source: "bootstrap",
      });
      assert.equal(result.action, "updated", "action must be updated (bootstrap + non-dev-link = regular update)");
      assert.equal(result.latestTag, NEWER_TAG, "latestTag must match fetched tag");
      assert.equal(exitCode, 0, "process.exit(0) must have been called for re-exec (idempotent)");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = origExit;
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
      try {
        rmSync(join(releasesDirPath(), NEWER_TAG), { recursive: true, force: true });
      } catch {}
      try {
        unlinkSync(join(releasesDirPath(), `${NEWER_TAG}.tar.gz`));
      } catch {}
      cleanup();
    }
  });
});

// ─── T-LINT.1: biome lint boundary + T-CONTRACT: tool count ──────────────────

describe("autoUpdate — lint boundary + contract checks", () => {
  it("T-LINT.1: after P-22 changes, biome lint on src/tools/** passes; no child_process import in src/tools/", async () => {
    // Given: src/cli/autoUpdate.ts exists with child_process import; biome.json lint scope is src/tools/**
    // When:  biome check runs on src/tools/; grep child_process in src/tools/
    // Then:  biome check exits 0 for src/tools/; no child_process import found in src/tools/
    const toolsResult = execSync("npx biome check src/tools/ 2>&1", {
      encoding: "utf-8",
      cwd: process.cwd(),
    });
    assert.ok(!toolsResult.includes("Found"), `src/tools/ has biome lint issues:\n${toolsResult}`);

    const cpCheck = execSync(
      'grep -rE "from [\'\\"]node:child_process[\'\\"]|require\\(.*child_process" src/tools/ 2>/dev/null || echo CLEAN',
      { encoding: "utf-8" },
    );
    assert.ok(
      cpCheck.includes("CLEAN"),
      `child_process import found in src/tools/ (Hard Rule 8 violation):\n${cpCheck}`,
    );
  });

  it("T-CONTRACT: tool() count in src/tools/ (P-SP-A rebaseline → 53; autoUpdate is NOT a Vercel tool)", async () => {
    // Given: P-22 adds src/cli/autoUpdate.ts (CLI layer, not a Vercel tool definition)
    // When:  grep tool() in src/tools/**
    // Then:  53 tool() calls — P-SP-A rebaseline adds 12 sales kernel tool definitions.
    //        mai auto-update is a startup hook, not a Vercel tool.
    const out = execSync('grep -r "tool(" src/tools/ --include="*.ts" | wc -l', { encoding: "utf-8" });
    const count = Number.parseInt(out.trim(), 10);
    assert.strictEqual(count, 53, `Expected exactly 53 tool() calls in src/tools/, got ${count}.`);
  });
});

// ─── P-58b T-AutoChannel.1..4: channel-aware release resolution ───────────────
//
// Step 4a scaffold (validator). Assertion bodies are `assert.fail("TODO Step 5")`
// — they intentionally FAIL until Step 5 fill. These exercise the NEW `channel?`
// DI field on AutoUpdateDI (added by builder at 4b). At 4a the unmodified
// runStartupAutoUpdate ignores `di.channel`; under tsx (no type-check) passing an
// extra property is harmless at runtime, so these load + run + hit assert.fail.
//
// Plan §5 coverage (Deliverable 4 — interim opt-in prerelease channel):
//   T-AutoChannel.1 — default/stable channel hits /releases/latest (LOAD-BEARING, R1)
//   T-AutoChannel.2 — prerelease channel hits the list endpoint
//   T-AutoChannel.3 — prerelease loop-guard: local === newest-prerelease → up_to_date (LOAD-BEARING, R1)
//   T-AutoChannel.4 — prerelease channel proceeds past the version guard when newer

type PrereleaseListItem = {
  tag_name: string;
  tarball_url: string;
  prerelease: boolean;
  draft: boolean;
  published_at: string;
};

/**
 * URL-aware tracking fetch. Records every requested URL in order and answers:
 *   - `/releases/latest`  → a single release object { tag_name: stableTag }
 *   - `/releases?...`     → the supplied prerelease list array
 *   - anything else (tarball) → an empty arrayBuffer (download path)
 * The recorded `urls` lets a test assert WHICH endpoint the channel selected.
 */
function makeTrackingFetch(opts: { stableTag?: string; prereleaseList?: PrereleaseListItem[] }): {
  impl: AutoUpdateDI["fetchImpl"];
  urls: string[];
} {
  const urls: string[] = [];
  const impl: AutoUpdateDI["fetchImpl"] = async (url, _opts) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/releases/latest")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: opts.stableTag ?? "v0.4.49",
          tarball_url: "https://codeload.github.com/kyoubelyu/mai-agent/legacy.tar.gz/refs/tags/stable",
        }),
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }
    if (u.includes("/releases?")) {
      return {
        ok: true,
        status: 200,
        json: async () => opts.prereleaseList ?? [],
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }
    // tarball download
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
  };
  return { impl, urls };
}

/** Build a one-entry prerelease list whose newest item carries `tag`. */
function prereleaseListWith(tag: string): PrereleaseListItem[] {
  return [
    {
      tag_name: tag,
      tarball_url: `https://codeload.github.com/kyoubelyu/mai-agent/legacy.tar.gz/refs/tags/${tag}`,
      prerelease: true,
      draft: false,
      published_at: "2026-05-24T00:00:00Z",
    },
  ];
}

describe("autoUpdate — P-58b channel selection (T-AutoChannel)", () => {
  it("T-AutoChannel.1: default/stable channel hits /releases/latest (preserves today — LOAD-BEARING R1)", async () => {
    // Given: di.channel:"stable" (or unset), GH_TOKEN set, a URL-tracking fetch
    //        whose /releases/latest returns LOCAL_TAG (→ up_to_date, no download)
    // When:  runStartupAutoUpdate({ channel:"stable", fetchImpl }) is called
    // Then:  the FIRST fetched URL is …/releases/latest (NOT …/releases?…)
    const origToken = process.env.GH_TOKEN;
    const origMai = process.env.MAI_AUTOUPDATE;
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p58b-1";
    const { impl: fetchImpl, urls } = makeTrackingFetch({ stableTag: LOCAL_TAG });
    try {
      const result = await runStartupAutoUpdate({ channel: "stable", fetchImpl } as AutoUpdateDI);
      assert.ok(urls.length >= 1, `expected at least one fetch (got ${JSON.stringify(urls)})`);
      assert.match(urls[0] ?? "", /\/releases\/latest/, "stable channel must hit /releases/latest");
      assert.doesNotMatch(urls[0] ?? "", /\/releases\?/, "stable channel must NOT hit the list endpoint");
      assert.equal(result.reason, "up_to_date", "latest === LOCAL_TAG → up_to_date (no download)");
    } finally {
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
    }
  });

  it("T-AutoChannel.2: prerelease channel hits the list endpoint (/releases?per_page=)", async () => {
    // Given: di.channel:"prerelease", GH_TOKEN set, tracking fetch whose list's
    //        newest prerelease is LOCAL_TAG (→ up_to_date, no download)
    // When:  runStartupAutoUpdate({ channel:"prerelease", fetchImpl }) is called
    // Then:  the FIRST fetched URL contains "/releases?per_page=" (NOT /releases/latest)
    const origToken = process.env.GH_TOKEN;
    const origMai = process.env.MAI_AUTOUPDATE;
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p58b-2";
    const { impl: fetchImpl, urls } = makeTrackingFetch({ prereleaseList: prereleaseListWith(LOCAL_TAG) });
    try {
      const result = await runStartupAutoUpdate({ channel: "prerelease", fetchImpl } as AutoUpdateDI);
      assert.ok(urls.length >= 1, `expected at least one fetch (got ${JSON.stringify(urls)})`);
      assert.match(urls[0] ?? "", /\/releases\?per_page=/, "prerelease channel must hit the list endpoint");
      assert.doesNotMatch(urls[0] ?? "", /\/releases\/latest/, "prerelease channel must NOT hit /releases/latest");
      assert.equal(result.reason, "up_to_date", "newest prerelease === LOCAL_TAG → up_to_date (no download)");
    } finally {
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
    }
  });

  it("T-AutoChannel.3: prerelease loop-guard — local === newest-prerelease → {skipped,up_to_date}, no spawn (LOAD-BEARING R1)", async () => {
    // Given: di.channel:"prerelease", local pkg.version == LOCAL_VER, the list's
    //        newest prerelease tag === LOCAL_TAG, a tracked spawnSyncImpl
    // When:  runStartupAutoUpdate({ channel:"prerelease", fetchImpl, spawnSyncImpl })
    // Then:  result == {action:"skipped",reason:"up_to_date"} AND spawn NEVER called
    const origToken = process.env.GH_TOKEN;
    const origMai = process.env.MAI_AUTOUPDATE;
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p58b-3";
    const { impl: fetchImpl } = makeTrackingFetch({ prereleaseList: prereleaseListWith(LOCAL_TAG) });
    const { impl: spawnFn, calls: spawnCalls } = makeSuccessSpawn();
    try {
      const result = await runStartupAutoUpdate({
        channel: "prerelease",
        fetchImpl,
        spawnSyncImpl: spawnFn,
      } as AutoUpdateDI);
      assert.equal(result.action, "skipped", "loop-guard: local === newest prerelease → skipped");
      assert.equal(result.reason, "up_to_date", "loop-guard reason must be up_to_date");
      assert.equal(spawnCalls.length, 0, "loop-guard: spawn must NEVER be called (no download, no re-exec)");
    } finally {
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
    }
  });

  it("T-AutoChannel.4: prerelease channel passes the version guard when a newer prerelease exists", async () => {
    // Given: di.channel:"prerelease", local LOCAL_VER, the list's newest prerelease
    //        is NEWER_TAG (newer, same major), a non-dev-link argv1 symlink, success
    //        spawn + a mocked process.exit (download/re-exec path)
    // When:  runStartupAutoUpdate({ channel:"prerelease", fetchImpl, spawnSyncImpl, argv1Override })
    // Then:  it does NOT short-circuit — result.reason ∉ {"up_to_date","local_ahead"}
    const { dir, cleanup } = makeTmpDir();
    const origToken = process.env.GH_TOKEN;
    const origMai = process.env.MAI_AUTOUPDATE;
    const origExit = process.exit.bind(process);
    delete process.env.MAI_AUTOUPDATE;
    process.env.GH_TOKEN = "test-gh-token-p58b-4";
    let exitCode: number | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process as any).exit = (code?: number) => {
      exitCode = code;
    };
    // stableTag below LOCAL keeps the 4a (channel-ignored) path safe (local_ahead,
    // no download); at 4b the honoured prerelease channel uses NEWER_TAG and proceeds.
    const { impl: fetchImpl } = makeTrackingFetch({
      stableTag: "v0.4.0",
      prereleaseList: prereleaseListWith(NEWER_TAG),
    });
    const { impl: spawnFn } = makeSuccessSpawn();
    try {
      const { argv1 } = makeSymlinkSetup(dir, false /* non-dev-link */);
      const result = await runStartupAutoUpdate({
        channel: "prerelease",
        fetchImpl,
        spawnSyncImpl: spawnFn,
        argv1Override: argv1,
      } as AutoUpdateDI);
      assert.notEqual(result.reason, "up_to_date", "newer prerelease must NOT short-circuit to up_to_date");
      assert.notEqual(result.reason, "local_ahead", "newer prerelease must NOT short-circuit to local_ahead");
      assert.equal(result.action, "updated", "newer prerelease proceeds through download/build/re-exec");
      assert.equal(result.latestTag, NEWER_TAG, "latestTag must be the newest prerelease from the list");
      assert.equal(exitCode, 0, "re-exec process.exit(0) must have been called");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = origExit;
      if (origToken !== undefined) process.env.GH_TOKEN = origToken;
      else delete process.env.GH_TOKEN;
      if (origMai !== undefined) process.env.MAI_AUTOUPDATE = origMai;
      else delete process.env.MAI_AUTOUPDATE;
      try {
        rmSync(join(releasesDirPath(), NEWER_TAG), { recursive: true, force: true });
      } catch {}
      try {
        unlinkSync(join(releasesDirPath(), `${NEWER_TAG}.tar.gz`));
      } catch {}
      cleanup();
    }
  });
});
