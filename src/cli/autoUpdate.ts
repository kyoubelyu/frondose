/** P-22: GitHub Releases tarball auto-update + re-exec (plan §6.1-§6.8).
 *
 * CLI-layer shell-out permitted per Hard Rule 8 amendment (operator approval
 * 2026-05-15). NEVER imported from src/tools/**. Single child_process import
 * site in src/cli/autoUpdate.ts.
 *
 * Flow: opt-out → token → lock → fetch latest → version compare → major guard
 *   → symlink derive + dev-link guard → download → extract → install → build
 *   → atomic symlink swap → GC old releases → re-exec (terminal exit).
 *
 * DI: fetchImpl, spawnSyncImpl, nowMs, argv1Override, force, source — all
 *   replaceable for tests.
 */
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { readUpdateChannel, type UpdateChannel } from "../persistence/channel.js";
import { readGithubConfig } from "../persistence/github.js";
import { getHomeBase } from "../persistence/paths.js";
import { compareVersions } from "./subcommands/update.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

const PKG_NAME = "@kyoube/mai-agent";
const REPO_PATH = "kyoubelyu/mai-agent";
const LATEST_URL = `https://api.github.com/repos/${REPO_PATH}/releases/latest`;
const RELEASES_LIST_URL = `https://api.github.com/repos/${REPO_PATH}/releases?per_page=30`;
const RELEASES_DIR = (): string => join(getHomeBase(), ".mai", "agent", "releases");
const UPDATE_LOCK = (): string => join(getHomeBase(), ".mai", "agent", "update.lock");
const UPDATE_LOG = (): string => join(getHomeBase(), ".mai", "agent", "logs", "update.log");
// Step-3b C3: 45 min provides ~24.5 min margin over worst-case 20-min cold-cache
// `npm install` + 15s build. Eliminates false-takeover-then-duplicate-build.
const LOCK_STALE_MS = 45 * 60 * 1000;

export type AutoUpdateAction = "skipped" | "updated" | "failed";

export interface AutoUpdateResult {
  action: AutoUpdateAction;
  reason?:
    | "opt_out"
    | "no_token"
    | "up_to_date"
    | "local_ahead"
    | "major_bump"
    | "dev_link"
    | "not_global_install"
    | "lock_busy"
    | "network"
    | "extract"
    | "install"
    | "build"
    | "swap";
  latestTag?: string;
}

export interface AutoUpdateDI {
  fetchImpl?: typeof globalThis.fetch;
  spawnSyncImpl?: typeof spawnSync;
  nowMs?: () => number;
  /** Allow tests to override the bin path used for symlink derivation. */
  argv1Override?: string;
  /** Forcibly bypass dev-link check (used by `mai update --bootstrap`). */
  force?: boolean;
  /** Tag the log line; default "startup". */
  source?: "startup" | "bootstrap";
  /** Override the update channel (tests). Default: readUpdateChannel(). */
  channel?: UpdateChannel;
}

export async function runStartupAutoUpdate(di: AutoUpdateDI = {}): Promise<AutoUpdateResult> {
  const fetchFn = di.fetchImpl ?? globalThis.fetch;
  const spawn = di.spawnSyncImpl ?? spawnSync;
  const now = di.nowMs ?? Date.now;
  const force = di.force === true;
  const source = di.source ?? "startup";

  // (1) Opt-out
  if (!force && process.env.MAI_AUTOUPDATE === "skip") {
    return { action: "skipped", reason: "opt_out" };
  }

  // (2) Token
  const token = process.env.GH_TOKEN ?? readGithubConfig().token;
  if (!token) {
    logAttempt(source, "skip:no_token");
    return { action: "skipped", reason: "no_token" };
  }

  // (3) Lock
  let lockFd: number;
  try {
    lockFd = acquireUpdateLock(now());
  } catch (e) {
    logAttempt(source, `skip:lock_busy ${(e as Error).message}`);
    return { action: "skipped", reason: "lock_busy" };
  }

  try {
    // (4) Latest release — channel-aware. Default "stable" = /releases/latest
    //     (unchanged from P-22). "prerelease" = newest prerelease from the list
    //     endpoint (opt-in via ~/.mai/agent/channel, written by install.sh).
    const channel = di.channel ?? readUpdateChannel();
    let release: { tag_name: string; tarball_url: string };
    try {
      release =
        channel === "prerelease" ? await fetchLatestPrerelease(fetchFn, token) : await fetchLatestTag(fetchFn, token);
    } catch (e) {
      logAttempt(source, `skip:network ${(e as Error).message}`);
      return { action: "skipped", reason: "network" };
    }

    const localVersion = pkg.version;
    const latestVersion = release.tag_name.replace(/^v/, "");
    const cmp = compareVersions(localVersion, latestVersion);
    if (cmp === 0) return { action: "skipped", reason: "up_to_date" };
    if (cmp === 1) return { action: "skipped", reason: "local_ahead" };

    // (5) Major bump guard
    const localMajor = parseInt(localVersion.split(".")[0] ?? "0", 10);
    const latestMajor = parseInt(latestVersion.split(".")[0] ?? "0", 10);
    if (latestMajor > localMajor) {
      process.stderr.write(`[mai] Major version available: v${latestVersion} — review with \`mai update\`.\n`);
      logAttempt(source, `skip:major_bump v${latestVersion}`);
      return { action: "skipped", reason: "major_bump", latestTag: release.tag_name };
    }

    // (6) Symlink derivation + dev-link guard
    const argv1 = di.argv1Override ?? process.argv[1] ?? "";
    const pkgSymlink = derivePackageSymlink(argv1);
    if (pkgSymlink === null) {
      process.stderr.write("[mai] running from a non-global install; skipping auto-update.\n");
      logAttempt(source, "skip:not_global_install");
      return { action: "skipped", reason: "not_global_install" };
    }
    if (!force && isDevLink(pkgSymlink)) {
      process.stderr.write(
        "[mai] Currently running from dev source (npm link); auto-update disabled. " +
          "Run `mai update --bootstrap` to switch to auto-update mode.\n",
      );
      logAttempt(source, "skip:dev_link");
      return { action: "skipped", reason: "dev_link" };
    }

    // (7) Download → extract → install → build
    process.stderr.write(`[mai] downloading v${latestVersion}...\n`);
    const releaseDir = join(RELEASES_DIR(), `v${latestVersion}`);
    const tgzPath = `${releaseDir}.tar.gz`;
    mkdirSync(RELEASES_DIR(), { recursive: true });
    mkdirSync(releaseDir, { recursive: true });

    try {
      await downloadTarball(release.tarball_url, tgzPath, fetchFn, token);
      process.stderr.write("[mai] extracting...\n");
      const xr = extractTarball(tgzPath, releaseDir, spawn);
      if (xr.status !== 0) {
        cleanupPartial(releaseDir, tgzPath);
        logAttempt(source, `fail:extract status=${xr.status} ${xr.stderr?.toString() ?? ""}`);
        process.stderr.write("[mai] update failed (extract). Continuing with current version.\n");
        return { action: "failed", reason: "extract", latestTag: release.tag_name };
      }
      process.stderr.write("[mai] installing dependencies (may take a moment)...\n");
      const ir = buildRelease(releaseDir, spawn, "install");
      if (ir.status !== 0) {
        cleanupPartial(releaseDir, tgzPath);
        logAttempt(source, `fail:install status=${ir.status}`);
        process.stderr.write("[mai] update failed (install). Continuing with current version.\n");
        return { action: "failed", reason: "install", latestTag: release.tag_name };
      }
      process.stderr.write("[mai] building...\n");
      const br = buildRelease(releaseDir, spawn, "build");
      if (br.status !== 0) {
        cleanupPartial(releaseDir, tgzPath);
        logAttempt(source, `fail:build status=${br.status}`);
        process.stderr.write("[mai] update failed (build). Continuing with current version.\n");
        return { action: "failed", reason: "build", latestTag: release.tag_name };
      }

      // (8) Atomic symlink swap
      process.stderr.write(`[mai] installing v${latestVersion}...\n`);
      try {
        swapPackageSymlink(pkgSymlink, releaseDir);
      } catch (e) {
        cleanupPartial(releaseDir, tgzPath);
        logAttempt(source, `fail:swap ${(e as Error).message}`);
        return { action: "failed", reason: "swap", latestTag: release.tag_name };
      }

      // (9) GC + tarball cleanup
      try {
        unlinkSync(tgzPath);
      } catch {
        // tarball may already have been GC'd; best-effort
      }
      gcOldReleases(RELEASES_DIR(), 2);

      // (10) Re-exec — never returns on success path
      process.stderr.write("[mai] restarting.\n\n");
      releaseUpdateLock(lockFd);
      const child = spawn(process.execPath, [argv1, ...process.argv.slice(2)], {
        stdio: "inherit",
        env: process.env,
      });
      process.exit(child.status ?? 0); // intentional terminal exit
      // Unreachable; satisfies TS control-flow analysis (process.exit is `never`
      // in stdlib but CFA inside async try/finally can't always narrow it).
      return { action: "updated", latestTag: release.tag_name };
    } catch (e) {
      cleanupPartial(releaseDir, tgzPath);
      logAttempt(source, `fail:unexpected ${(e as Error).message}`);
      return { action: "failed", reason: "network", latestTag: release.tag_name };
    }
  } finally {
    // Release lock on every non-re-exec exit path. On the re-exec path
    // releaseUpdateLock has already been called and process.exit terminates
    // before this `finally` runs; the second close is a best-effort no-op.
    try {
      releaseUpdateLock(lockFd);
    } catch {
      // Lock already released by re-exec path or stale; ignore.
    }
  }
}

// §6.2: fetchLatestTag + downloadTarball ─────────────────────────────────────

export async function fetchLatestTag(
  fetchFn: typeof globalThis.fetch,
  token: string,
): Promise<{ tag_name: string; tarball_url: string }> {
  const resp = await fetchFn(LATEST_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json() as Promise<{ tag_name: string; tarball_url: string }>;
}

export async function fetchLatestPrerelease(
  fetchFn: typeof globalThis.fetch,
  token: string,
): Promise<{ tag_name: string; tarball_url: string }> {
  const resp = await fetchFn(RELEASES_LIST_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const all = (await resp.json()) as Array<{
    tag_name: string;
    tarball_url: string;
    prerelease: boolean;
    draft: boolean;
    published_at: string;
  }>;
  const pres = all
    .filter((r) => r.prerelease && !r.draft)
    .sort((x, y) => (x.published_at < y.published_at ? 1 : x.published_at > y.published_at ? -1 : 0));
  const latest = pres[0];
  if (latest === undefined) throw new Error("no prerelease found");
  return { tag_name: latest.tag_name, tarball_url: latest.tarball_url };
}

export async function downloadTarball(
  tarballUrl: string,
  destPath: string,
  fetchFn: typeof globalThis.fetch,
  token: string,
): Promise<void> {
  // GitHub redirects to codeload / S3; per WHATWG Fetch §4.3.12 auth headers
  // are stripped on cross-origin redirect (Node 24 undici complies).
  const resp = await fetchFn(tarballUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(60_000),
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`tarball HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(destPath, buf);
}

// §6.3: extractTarball + buildRelease ────────────────────────────────────────

export function extractTarball(tgzPath: string, destDir: string, spawn: typeof spawnSync): SpawnSyncReturns<Buffer> {
  return spawn("tar", ["-xzf", tgzPath, "-C", destDir, "--strip-components=1"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function buildRelease(
  releaseDir: string,
  spawn: typeof spawnSync,
  step: "install" | "build",
): SpawnSyncReturns<Buffer> {
  const args = step === "install" ? ["install", "--prefer-offline"] : ["run", "build"];
  return spawn("npm", args, {
    cwd: releaseDir,
    stdio: ["ignore", "inherit", "inherit"], // operator sees progress
    env: process.env,
  });
}

// §4 + §6.4: symlink swap helpers ─────────────────────────────────────────────

/** Derive the npm-global package-symlink path from the running bin path.
 *  Returns null if process.argv[1] is not a symlink (not a global install). */
export function derivePackageSymlink(argv1: string): string | null {
  let target: string;
  try {
    target = readlinkSync(argv1);
  } catch {
    return null;
  }
  const idx = target.indexOf(PKG_NAME);
  if (idx === -1) return null;
  // target example: '../lib/node_modules/@kyoube/mai-agent/dist/cli/main.js'
  // pkg slice end:   '../lib/node_modules/@kyoube/mai-agent'
  return resolve(dirname(argv1), target.slice(0, idx + PKG_NAME.length));
}

/** Is the current install a dev-link (npm-link from a git checkout)? */
export function isDevLink(pkgSymlink: string): boolean {
  let realDir: string;
  try {
    realDir = realpathSync(pkgSymlink);
  } catch {
    return false;
  }
  return existsSync(join(realDir, ".git"));
}

/** Atomic symlink swap. NEVER leaves the symlink in a broken state. */
export function swapPackageSymlink(pkgSymlink: string, newReleaseDir: string): void {
  const tmp = `${pkgSymlink}.updating`;
  // Step-3b C1 fix: synchronous cleanup of stale .updating from prior crash.
  // The previous revision used `import("node:fs").then(...)` which scheduled
  // the unlink as a microtask AFTER symlinkSync(tmp) already ran — i.e. the
  // stale-tmp cleanup was a no-op on the very call it was supposed to protect.
  try {
    unlinkSync(tmp);
  } catch {
    // best-effort sync cleanup; ENOENT is the common case (no stale tmp).
  }
  symlinkSync(newReleaseDir, tmp);
  renameSync(tmp, pkgSymlink); // POSIX rename(2): atomic on macOS HFS+/APFS
}

// §6.5: GC ───────────────────────────────────────────────────────────────────

export function gcOldReleases(releasesDir: string, keepLastN: number): void {
  if (!existsSync(releasesDir)) return;
  const entries = readdirSync(releasesDir)
    .filter((d) => d.startsWith("v") && existsSync(join(releasesDir, d)))
    .filter((d) => {
      try {
        return statSync(join(releasesDir, d)).isDirectory();
      } catch {
        return false;
      }
    });
  if (entries.length <= keepLastN) return;
  // Semver-aware sort (handles v0.4.9 vs v0.4.10 correctly).
  const sorted = entries.slice().sort((a, b) => compareVersions(a, b));
  const toRemove = sorted.slice(0, sorted.length - keepLastN);
  for (const d of toRemove) {
    try {
      rmSync(join(releasesDir, d), { recursive: true, force: true });
    } catch {
      // GC is best-effort; ignore permission errors etc.
    }
  }
}

// §6.6: file lock ────────────────────────────────────────────────────────────

export function acquireUpdateLock(nowMs: number): number {
  const lockPath = UPDATE_LOCK();
  mkdirSync(dirname(lockPath), { recursive: true });
  // Stale-lock reaper: if existing lock is older than LOCK_STALE_MS, drop it.
  if (existsSync(lockPath)) {
    try {
      const st = statSync(lockPath);
      if (nowMs - st.mtimeMs > LOCK_STALE_MS) {
        unlinkSync(lockPath);
      }
    } catch {
      // stat/unlink race — let openSync resolve atomically below.
    }
  }
  // O_EXCL | O_CREAT | O_WRONLY: atomic. EEXIST = lock held.
  return openSync(lockPath, "wx");
}

export function releaseUpdateLock(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // fd already closed (e.g. re-exec path) — ignore.
  }
  try {
    unlinkSync(UPDATE_LOCK());
  } catch {
    // lock already unlinked — ignore.
  }
}

// §6.8: cleanup + log helpers ────────────────────────────────────────────────

function cleanupPartial(releaseDir: string, tgzPath: string): void {
  try {
    rmSync(releaseDir, { recursive: true, force: true });
  } catch {
    // partial dir already removed — ignore.
  }
  try {
    unlinkSync(tgzPath);
  } catch {
    // tarball already removed — ignore.
  }
}

function logAttempt(source: string, line: string): void {
  try {
    const logPath = UPDATE_LOG();
    mkdirSync(dirname(logPath), { recursive: true });
    const stamp = new Date().toISOString();
    writeFileSync(logPath, `${stamp} [${source}] ${line}\n`, { flag: "a" });
  } catch {
    // logging is best-effort
  }
}
