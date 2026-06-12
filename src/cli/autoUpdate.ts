import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { frondoseEnv } from "../env.js";
import { readUpdateChannel, type UpdateChannel } from "../persistence/channel.js";
import { readGithubConfig } from "../persistence/github.js";
import { getHomeBase } from "../persistence/paths.js";
import { buildRelease, extractTarball } from "./autoUpdate/extract.js";
import { downloadTarball, fetchLatestPrerelease, fetchLatestTag } from "./autoUpdate/fetch.js";
import { gcOldReleases } from "./autoUpdate/gc.js";
import { acquireUpdateLock, releaseUpdateLock } from "./autoUpdate/lock.js";
import { derivePackageSymlink, isDevLink, swapPackageSymlink } from "./autoUpdate/symlink.js";
import { compareVersions } from "./subcommands/update.js";

export * from "./autoUpdate/extract.js";
export * from "./autoUpdate/fetch.js";
export * from "./autoUpdate/gc.js";
export * from "./autoUpdate/lock.js";
export * from "./autoUpdate/symlink.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };
const RELEASES_DIR = (): string => join(getHomeBase(), ".mai", "agent", "releases");
const UPDATE_LOG = (): string => join(getHomeBase(), ".mai", "agent", "logs", "update.log");

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

  if (!force && frondoseEnv("AUTOUPDATE") === "skip") {
    return { action: "skipped", reason: "opt_out" };
  }

  const token = process.env.GH_TOKEN ?? readGithubConfig().token;
  if (!token) {
    logAttempt(source, "skip:no_token");
    return { action: "skipped", reason: "no_token" };
  }

  let lockFd: number;
  try {
    lockFd = acquireUpdateLock(now());
  } catch (e) {
    logAttempt(source, `skip:lock_busy ${(e as Error).message}`);
    return { action: "skipped", reason: "lock_busy" };
  }

  try {
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

    const localMajor = parseInt(localVersion.split(".")[0] ?? "0", 10);
    const latestMajor = parseInt(latestVersion.split(".")[0] ?? "0", 10);
    if (latestMajor > localMajor) {
      process.stderr.write(`[frondose] Major version available: v${latestVersion} — review with \`mai update\`.\n`);
      logAttempt(source, `skip:major_bump v${latestVersion}`);
      return { action: "skipped", reason: "major_bump", latestTag: release.tag_name };
    }

    const argv1 = di.argv1Override ?? process.argv[1] ?? "";
    const pkgSymlink = derivePackageSymlink(argv1);
    if (pkgSymlink === null) {
      process.stderr.write("[frondose] running from a non-global install; skipping auto-update.\n");
      logAttempt(source, "skip:not_global_install");
      return { action: "skipped", reason: "not_global_install" };
    }
    if (!force && isDevLink(pkgSymlink)) {
      process.stderr.write(
        "[frondose] Currently running from dev source (npm link); auto-update disabled. " +
          "Run `mai update --bootstrap` to switch to auto-update mode.\n",
      );
      logAttempt(source, "skip:dev_link");
      return { action: "skipped", reason: "dev_link" };
    }

    process.stderr.write(`[frondose] downloading v${latestVersion}...\n`);
    const releaseDir = join(RELEASES_DIR(), `v${latestVersion}`);
    const tgzPath = `${releaseDir}.tar.gz`;
    mkdirSync(RELEASES_DIR(), { recursive: true });
    mkdirSync(releaseDir, { recursive: true });

    try {
      await downloadTarball(release.tarball_url, tgzPath, fetchFn, token);
      process.stderr.write("[frondose] extracting...\n");
      const xr = extractTarball(tgzPath, releaseDir, spawn);
      if (xr.status !== 0) {
        cleanupPartial(releaseDir, tgzPath);
        logAttempt(source, `fail:extract status=${xr.status} ${xr.stderr?.toString() ?? ""}`);
        process.stderr.write("[frondose] update failed (extract). Continuing with current version.\n");
        return { action: "failed", reason: "extract", latestTag: release.tag_name };
      }
      process.stderr.write("[frondose] installing dependencies (may take a moment)...\n");
      const ir = buildRelease(releaseDir, spawn, "install");
      if (ir.status !== 0) {
        cleanupPartial(releaseDir, tgzPath);
        logAttempt(source, `fail:install status=${ir.status}`);
        process.stderr.write("[frondose] update failed (install). Continuing with current version.\n");
        return { action: "failed", reason: "install", latestTag: release.tag_name };
      }
      process.stderr.write("[frondose] building...\n");
      const br = buildRelease(releaseDir, spawn, "build");
      if (br.status !== 0) {
        cleanupPartial(releaseDir, tgzPath);
        logAttempt(source, `fail:build status=${br.status}`);
        process.stderr.write("[frondose] update failed (build). Continuing with current version.\n");
        return { action: "failed", reason: "build", latestTag: release.tag_name };
      }

      process.stderr.write(`[frondose] installing v${latestVersion}...\n`);
      try {
        swapPackageSymlink(pkgSymlink, releaseDir);
      } catch (e) {
        cleanupPartial(releaseDir, tgzPath);
        logAttempt(source, `fail:swap ${(e as Error).message}`);
        return { action: "failed", reason: "swap", latestTag: release.tag_name };
      }

      try {
        unlinkSync(tgzPath);
      } catch {
        // tarball may already have been GC'd; best-effort
      }
      gcOldReleases(RELEASES_DIR(), 2);

      process.stderr.write("[frondose] restarting.\n\n");
      releaseUpdateLock(lockFd);
      const child = spawn(process.execPath, [argv1, ...process.argv.slice(2)], {
        stdio: "inherit",
        env: process.env,
      });
      process.exit(child.status ?? 0);
      return { action: "updated", latestTag: release.tag_name };
    } catch (e) {
      cleanupPartial(releaseDir, tgzPath);
      logAttempt(source, `fail:unexpected ${(e as Error).message}`);
      return { action: "failed", reason: "network", latestTag: release.tag_name };
    }
  } finally {
    try {
      releaseUpdateLock(lockFd);
    } catch {
      // Lock already released by re-exec path or stale; ignore.
    }
  }
}

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
