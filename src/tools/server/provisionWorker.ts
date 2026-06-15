/** P-41: provision_worker server tool. SSH-driven worker provisioning — the
 *  server SSHes into the worker, runs install.sh over the channel, then writes
 *  config.json + secrets.json over further SSH exec calls. Replaces the retired
 *  invite-token / curl-bootstrap machinery.
 *  `runSshProvision` is the shared core (Vercel tool + `mai server worker
 *  provision` CLI + POST /api/web/provision — single code path, no drift). */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tool } from "ai";
import type { Database as DB } from "better-sqlite3";
import { z } from "zod";
import { runSshExec, type SshTarget } from "../../cli/serverSsh.js";
import { configJsonSchemaV2 } from "../../persistence/config.js";
import { getGoogleAccount, getLlmKey, incrementLlmKeyAssignedCount } from "../../persistence/credentialLibrary.js";
import { readPersonaTemplate } from "../../persistence/personaLibrary.js";
import type { SecretsJson } from "../../persistence/secrets.js";
import { readWorkerNodeConfig } from "../../persistence/workerNodeConfig.js";
import { addWorker, listWorkers, removeWorker } from "../../persistence/workersRegistry.js";

export interface ProvisionContext {
  workersDb: DB | null;
  credentialsDb: DB | null;
  personasDir: string;
  serverUrl: string;
  sshUser: string | null;
  sshPort: number;
  workersConfigDir: string;
}
export interface ProvisionInput {
  personaId: string;
  hostname?: string;
  workerId?: string;
}
export type ProvisionResult =
  | { ok: true; workerId: string; personaId: string; hostname: string; nextSteps: string[] }
  | { ok: false; error: string };
export interface ProvisionDeps {
  execImpl?: typeof runSshExec;
  installShPath?: string;
  /** P-42: test-only sandbox-prefix DI. When set, the install.sh exec gets
   *  `FRONDOSE_PREFIX=<prefix>` and config/secrets are written under `<prefix>/.frondose/agent`
   *  instead of `~/.frondose/agent`. NOT on the provision_worker Zod schema — undefined
   *  for every real operator provision (zero production behavior change). */
  maiPrefix?: string;
}

/** P-42: validate the test-only `maiPrefix` DI value — it is interpolated UNQUOTED
 *  into `FRONDOSE_PREFIX=<value> bash -s`, so an ALLOWLIST is used (a denylist would miss
 *  `;|&><()` etc. and let `/tmp/x;echo INJECTED` through). Only `a-z A-Z 0-9 . _ - /`
 *  are permitted — that subsumes every shell-injection vector. Never operator-facing
 *  → a hard throw is sufficient; plain `/tmp/mai-p42-XXXX` paths pass cleanly. */
function simplePathEscape(p: string): string {
  if (!/^[a-zA-Z0-9._\-/]+$/.test(p)) {
    throw new Error(`maiPrefix contains shell-unsafe characters (only a-z, A-Z, 0-9, ., _, -, / allowed): ${p}`);
  }
  return p;
}

/** P-41: SSH-driven worker provisioning. Shared core for the provision_worker
 *  tool + `mai server worker provision` CLI + POST /api/web/provision. */
export async function runSshProvision(
  ctx: ProvisionContext,
  input: ProvisionInput,
  deps: ProvisionDeps = {},
): Promise<ProvisionResult> {
  if (!ctx.workersDb) return { ok: false, error: "workers.sqlite not initialized" };
  if (!ctx.serverUrl) return { ok: false, error: "server URL not configured; set config.json.server.url" };
  if (!input.hostname) {
    return {
      ok: false,
      error: "SSH provisioning requires a hostname — pass `hostname` (the worker's SSH-reachable host).",
    };
  }
  const persona = readPersonaTemplate(ctx.personasDir, input.personaId);
  if (!persona) {
    return { ok: false, error: `Persona not found: ${input.personaId}. Run list_personas to see available personas.` };
  }
  const workerId = input.workerId ?? randomBytes(4).toString("hex");
  if (listWorkers(ctx.workersDb).some((w) => w.worker_id === workerId)) {
    return {
      ok: false,
      error: `worker_id ${workerId} already exists; pass a different workerId or revoke the existing worker.`,
    };
  }
  // P-42: validate the test-only maiPrefix BEFORE any side effect (addWorker) so a
  // bad prefix throws clean — no leaked workers.sqlite row outside the SSH try/catch.
  const safePrefix = deps.maiPrefix !== undefined ? simplePathEscape(deps.maiPrefix) : null;
  const installShPath = deps.installShPath ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../install.sh");
  if (!existsSync(installShPath)) {
    return { ok: false, error: `install.sh not found at ${installShPath}` };
  }
  const installSh = readFileSync(installShPath, "utf-8");

  // Build config.json v2 + secrets.json payloads (server-side; no worker callback).
  const identity = {
    fullName: persona.fullName,
    role: persona.role,
    company: persona.company,
    profileUrl: persona.linkedInUrl,
    email: persona.email,
    persona: input.personaId,
    updatedAt: new Date().toISOString(),
  };
  const config = configJsonSchemaV2.parse({
    schema_version: 2,
    server: { url: ctx.serverUrl },
    identity,
    soul: { override: persona.soulBandOverride ?? null },
  });

  // Mint the permanent token + register the worker BEFORE SSH so the row exists
  // for heartbeat/poll; roll back (removeWorker) on any SSH failure.
  const permanentToken = randomBytes(32).toString("hex");
  addWorker(ctx.workersDb, workerId, permanentToken, input.hostname, input.personaId);

  const secrets: SecretsJson = { schema_version: 1, server: { token: permanentToken } };
  let llmName: string | null = null;
  if (ctx.credentialsDb && persona.llmKeyRef) {
    const k = getLlmKey(ctx.credentialsDb, persona.llmKeyRef);
    if (k) {
      secrets.providers = { [k.id]: { key: k.api_key, baseUrl: k.base_url ?? undefined, type: k.provider_type } };
      secrets.default = k.id;
      llmName = k.id;
      // CONCERN-MR-1: do NOT increment assigned_count here — a later SSH failure
      // would leak the count (the catch removeWorker()s but cannot un-increment).
      // The increment runs ONLY on the success path below, after the SSH try.
    }
  }
  let googleEmail: string | null = null;
  if (ctx.credentialsDb && persona.googleAccountRef) {
    const g = getGoogleAccount(ctx.credentialsDb, persona.googleAccountRef);
    if (g) googleEmail = g.email; // password NEVER pushed
  }

  // SSH target. A brand-new worker has no <id>.json yet → nodeCfg is usually null
  // → fall back to config.server.ssh_user/ssh_port, then the server's OS user.
  const nodeCfg = readWorkerNodeConfig(ctx.workersConfigDir, workerId);
  const target: SshTarget = {
    workerId,
    host: input.hostname,
    user: nodeCfg?.ssh_user ?? ctx.sshUser ?? userInfo().username,
    port: nodeCfg?.ssh_port ?? ctx.sshPort,
  };

  const exec = deps.execImpl ?? runSshExec;
  // P-42: when maiPrefix is set, redirect BOTH the install.sh prefix env var AND the
  // config/secrets target dir into the sandbox — otherwise a localhost provision test
  // clobbers the operator's real ~/.frondose. safePrefix is validated up-front (early guard).
  const installCmd = safePrefix !== null ? `FRONDOSE_PREFIX=${safePrefix} bash -s` : "bash -s";
  const maiHome = safePrefix !== null ? `${safePrefix}/.frondose/agent` : "~/.frondose/agent";
  try {
    const r1 = await exec(target, installCmd, installSh);
    if (r1.code !== 0) throw new Error(`install.sh failed (exit ${r1.code}): ${r1.stderr.slice(-500)}`);
    const r2 = await exec(
      target,
      `mkdir -p ${maiHome} && cat > ${maiHome}/config.json`,
      JSON.stringify(config, null, 2),
    );
    if (r2.code !== 0) throw new Error(`config.json write failed (exit ${r2.code}): ${r2.stderr.slice(-300)}`);
    const r3 = await exec(
      target,
      `cat > ${maiHome}/secrets.json && chmod 600 ${maiHome}/secrets.json`,
      JSON.stringify(secrets, null, 2),
    );
    if (r3.code !== 0) throw new Error(`secrets.json write failed (exit ${r3.code}): ${r3.stderr.slice(-300)}`);
  } catch (e) {
    removeWorker(ctx.workersDb, workerId); // rollback — the worker row must not outlive a failed provision
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // CONCERN-MR-1: increment ONLY now — past the SSH try-block, sharing the
  // success boundary with addWorker. A failed provision (caught above) returns
  // before reaching here, so assigned_count is never leaked.
  if (llmName !== null && ctx.credentialsDb && persona.llmKeyRef) {
    incrementLlmKeyAssignedCount(ctx.credentialsDb, persona.llmKeyRef);
  }

  return {
    ok: true,
    workerId,
    personaId: input.personaId,
    hostname: input.hostname,
    nextSteps: [
      llmName
        ? `LLM provider '${llmName}' configured from Frondose Settings — no key entry needed on the worker.`
        : "No LLM key was pushed — configure the worker's provider key in Frondose → Settings.",
      googleEmail
        ? `LinkedIn login: use Google account ${googleEmail} ("Continue with Google" in Chrome).`
        : "Configure the worker's LinkedIn login.",
      "SSH into the worker and run `mai` (or `mai telegram on` for the persistent daemon).",
    ],
  };
}

export function makeProvisionWorkerTool(ctx: ProvisionContext) {
  return tool({
    description:
      "Provision a new worker over SSH: runs install.sh on the host, then writes its " +
      "config + credentials. Requires `hostname` (the worker's SSH-reachable host) — the " +
      "server connects via your ssh-agent. Takes ~2 minutes (installs + builds mai on the " +
      "worker). Run list_personas first to confirm the persona_id.",
    parameters: z.object({
      personaId: z.string().min(1),
      hostname: z.string().optional(), // OQ-1: stays optional; runSshProvision errors clearly if absent
      workerId: z.string().min(1).max(64).optional(),
    }),
    execute: async (input) => runSshProvision(ctx, input),
  });
}
