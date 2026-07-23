/** P-30: per-worker node config at ~/.frondose/server/workers/<id>.json — VNC port/
 *  password + optional SSH overrides. Operator-authored, chmod 600 (holds
 *  vnc_password). Reader returns null on missing/malformed (never throws). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readJsonFileSync } from "./jsonFile.js";

export const workerNodeConfigSchema = z.object({
  vnc_host: z.string().min(1).optional(),
  vnc_port: z.number().int().min(1).max(65535).optional(),
  vnc_password: z.string().min(1).optional(),
  ssh_user: z.string().min(1).optional(),
  ssh_port: z.number().int().min(1).max(65535).optional(),
});
export type WorkerNodeConfig = z.infer<typeof workerNodeConfigSchema>;

/** Returns the parsed config, or null on missing/malformed/schema-fail (never throws). */
export function readWorkerNodeConfig(dir: string, workerId: string): WorkerNodeConfig | null {
  const path = join(dir, `${workerId}.json`);
  if (!existsSync(path)) return null;
  try {
    return workerNodeConfigSchema.parse(readJsonFileSync(path));
  } catch (e) {
    process.stderr.write(
      `[frondose] worker node config ${workerId}.json invalid: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  }
}
