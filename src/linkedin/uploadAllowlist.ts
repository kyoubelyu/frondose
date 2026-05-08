import os from "node:os";
import path from "node:path";

/**
 * Default upload allowlist (per guardian critic CONCERN-MR-1 path (a) — reverts plan §6.4
 * defaults `[~/Downloads, ~/Desktop, ~/Documents]` to scout's research recommendation
 * + dispatch instruction: a single quarantine dir under mai-agent's namespace, minimizing
 * blast radius if a path-traversal bug surfaces. Operator can override via
 * `MAI_UPLOAD_ALLOWLIST=/path1:/path2` for ad-hoc allowlists.
 */
const DEFAULTS = (): string[] => [path.join(os.homedir(), ".mai", "agent", "uploads")];

/** Resolve the upload allowlist from env (colon-separated) or defaults. */
export function resolveUploadAllowlist(): string[] {
  const env = process.env["MAI_UPLOAD_ALLOWLIST"];
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
        `Allowed: ${allowed.join(", ")}. Set MAI_UPLOAD_ALLOWLIST=path1:path2 to override.`,
    );
  }
}
