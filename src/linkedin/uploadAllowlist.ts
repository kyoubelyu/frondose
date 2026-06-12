import os from "node:os";
import path from "node:path";
import { frondoseEnv } from "../env.js";
import { getHomeBase } from "../persistence/paths.js";

/**
 * Default upload allowlist (per guardian critic CONCERN-MR-1 path (a) — reverts plan §6.4
 * defaults `[~/Downloads, ~/Desktop, ~/Documents]` to scout's research recommendation
 * + dispatch instruction: a single quarantine dir under mai-agent's namespace, minimizing
 * blast radius if a path-traversal bug surfaces. Operator can override via
 * `FRONDOSE_UPLOAD_ALLOWLIST=/path1:/path2` for ad-hoc allowlists.
 */
const DEFAULTS = (): string[] => [path.join(getHomeBase(), ".mai", "agent", "uploads")];

/** Resolve the upload allowlist from env (colon-separated) or defaults. */
export function resolveUploadAllowlist(): string[] {
  const env = frondoseEnv("UPLOAD_ALLOWLIST");
  if (env && env.length > 0) {
    return env
      .split(":")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => path.resolve(d));
  }
  return DEFAULTS();
}

/** Throw if the path is not within an allowed directory after canonicalization. */
export function assertUploadPathAllowed(filePath: string): void {
  const canonical = path.resolve(filePath);
  const allowed = resolveUploadAllowlist();
  const ok = allowed.some((dir) => canonical === dir || canonical.startsWith(dir + path.sep));
  if (!ok) {
    throw new Error(
      `Upload path '${canonical}' is outside the allowed directories. ` +
        `Allowed: ${allowed.join(", ")}. Set FRONDOSE_UPLOAD_ALLOWLIST=path1:path2 to override (legacy MAI_UPLOAD_ALLOWLIST still accepted).`,
    );
  }
}

/**
 * P-9 D-7: read-side file sandbox. Allowed sources:
 *   (a) FRONDOSE_UPLOAD_ALLOWLIST dirs (operator-controlled)
 *   (b) os.tmpdir() subtree (where screenshot tool writes)
 *   (c) ~/.mai/agent/** subtree (own state files)
 *   (d) <cwd>/tests/fixtures/** subtree (validator's mock fixtures; only when
 *       cwd is the repo root — best-effort, fails closed if not)
 *
 * Called by analyze_screenshot before readFileSync. Other tools either don't
 * read operator-supplied paths or have their own gate (upload uses
 * assertUploadPathAllowed for writes).
 */
export function assertFileReadable(filePath: string): void {
  const canonical = path.resolve(filePath);
  const allowed = [
    ...resolveUploadAllowlist(),
    path.resolve(os.tmpdir()),
    path.join(getHomeBase(), ".mai", "agent"),
    path.join(process.cwd(), "tests", "fixtures"),
  ];
  const ok = allowed.some((dir) => canonical === dir || canonical.startsWith(dir + path.sep));
  if (!ok) {
    throw new Error(
      `File read denied: '${canonical}' is outside the allowed directories. ` + `Allowed: ${allowed.join(", ")}.`,
    );
  }
}
