/** P-25: server identity persistence — orchestrator persona schema + read/write helpers. */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { readJsonFileSync } from "./jsonFile.js";

export const serverIdentitySchema = z.object({
  /** Operator's real name — required; auto-suggested from worker identity on first init. */
  operatorName: z.string().trim().min(1),
  /** Operator's role title (optional). */
  operatorRole: z.string().trim().min(1).optional(),
  /** Operator's company (optional). */
  operatorCompany: z.string().trim().min(1).optional(),
  /** Orchestrator's own name. Default: "mai-server". */
  orchestratorName: z.string().trim().min(1).default("mai-server"),
  /** Orchestrator's role descriptor. */
  orchestratorRole: z.string().trim().min(1).default("Operator's chief-of-staff agent"),
  /** Standing priorities inlined into the soul band (max 8). */
  priorities: z.array(z.string().trim().min(1).max(160)).max(8).default([]),
  /** Character traits inlined into the soul band (max 8). */
  traits: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
  /** ISO-8601 timestamp of last write. */
  updatedAt: z.string().datetime(),
});

export type ServerIdentity = z.infer<typeof serverIdentitySchema>;

/** Read and validate server identity. Returns null if absent or invalid. */
export function readServerIdentity(path: string): ServerIdentity | null {
  if (!existsSync(path)) return null;
  try {
    return serverIdentitySchema.parse(readJsonFileSync(path));
  } catch (e) {
    process.stderr.write(
      `[frondose] server identity.json corrupt or invalid: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  }
}

/** Write server identity atomically via tmp+rename. NOT chmod 600 — no credentials stored here. */
export function writeServerIdentity(identity: ServerIdentity, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(identity, null, 2), "utf-8");
  renameSync(tmp, path);
}
