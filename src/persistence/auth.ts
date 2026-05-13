import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const DEFAULT_AUTH_PATH = (): string => join(homedir(), ".mai", "auth.json");

const providerEntrySchema = z.object({
  key: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

export const authJsonSchema = z.object({
  default: z.string().min(1).optional(),
  visionModel: z.string().min(1).optional(),
  providers: z.record(z.string().min(1), providerEntrySchema).optional(),
});
export type AuthJson = z.infer<typeof authJsonSchema>;

/** Read auth.json. Missing file → null. Corrupt JSON → null + stderr log. */
export function readAuth(path: string = DEFAULT_AUTH_PATH()): AuthJson | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return authJsonSchema.parse(parsed);
  } catch (e) {
    process.stderr.write(`[mai] auth.json corrupt or invalid: ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
}

/**
 * Write auth.json with mode 0600 from the first syscall (no race window).
 *
 * `openSync(path, "w", 0o600)` opens for write with O_CREAT | O_WRONLY | O_TRUNC
 * and applies the mode to a NEWLY-created file atomically. For overwrites of an
 * existing file, the open-for-write flag truncates but does NOT change the file's
 * existing mode — so we retain a defensive `chmodSync(path, 0o600)` as a
 * belt-and-suspenders for the overwrite path.
 *
 * No-op on Windows (which is not a target platform per scout OQ-3).
 */
export function writeAuth(auth: AuthJson, path: string = DEFAULT_AUTH_PATH()): void {
  mkdirSync(dirname(path), { recursive: true });
  const data = JSON.stringify(auth, null, 2);
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, data, 0, "utf-8");
  } finally {
    closeSync(fd);
  }
  // Defensive: enforce 0o600 on overwrites where openSync 'w' did not change mode.
  chmodSync(path, 0o600);
}

/**
 * Read a provider's API key from auth.json.
 * Returns undefined if file missing OR provider not configured.
 *
 * Used by modelResolver.buildModel as fallback when env var absent.
 */
export function readAuthJsonKey(provider: string, path: string = DEFAULT_AUTH_PATH()): string | undefined {
  const auth = readAuth(path);
  return auth?.providers?.[provider]?.key;
}

export function readAuthJsonVisionModel(path: string = DEFAULT_AUTH_PATH()): string | undefined {
  const auth = readAuth(path);
  return auth?.visionModel;
}

/** Mask an API key for `mai auth list` output: keep last 4 chars; replace middle with stars. */
export function maskKey(key: string): string {
  if (key.length <= 4) return "****";
  const last4 = key.slice(-4);
  // Preserve `sk-ant-` style prefix if present.
  const dashIdx = key.indexOf("-", 3);
  if (dashIdx !== -1 && dashIdx < 8) {
    const prefix = key.slice(0, dashIdx + 1);
    return `${prefix}***${last4}`;
  }
  return `***${last4}`;
}
