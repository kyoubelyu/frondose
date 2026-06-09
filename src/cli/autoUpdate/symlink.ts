import { existsSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PKG_NAME = "@kyoube/mai-agent";

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
