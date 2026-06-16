import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WIN_RM_OPTS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

/** Create a fresh unique temp dir under the OS temp root. */
export function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix.endsWith("-") ? prefix : `${prefix}-`));
}

/**
 * Recursively remove a temp dir, best-effort, with retry options for Windows
 * teardown races caused by short-lived sqlite/process handles.
 */
export function cleanupTmpDir(dir: string): void {
  try {
    rmSync(dir, WIN_RM_OPTS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY") return;
    throw err;
  }
}

/** Convenience for tests that need a unique file path under a unique temp dir. */
export function makeTmpFile(name: string): string {
  return join(makeTmpDir("frondose-test"), name);
}
