/** P-27 worker side: `mai bootstrap-register --server-url <url> --invite-token <token>`.
 *  POSTs /api/register; writes config + secrets + identity atomically; prints a
 *  start-instruction and returns. Does NOT spawn a background process — the
 *  operator starts the worker explicitly (`mai telegram on` / `mai`).
 *
 *  NO `child_process` import (Step-3b B-1 revision).
 *
 *  Error paths THROW (caller in main.ts maps to exit 1) so the function is
 *  unit-testable without killing the test runner. */
import { writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG_PATH, readConfig, writeConfig } from "../../persistence/config.js";
import { type IdentityRecord, writeIdentity } from "../../persistence/identity.js";
import { DEFAULT_SECRETS_PATH, readSecrets, writeSecrets } from "../../persistence/secrets.js";

export interface BootstrapRegisterDI {
  fetchImpl?: typeof globalThis.fetch;
  writeIdentityImpl?: typeof writeIdentity;
  writeSecretsImpl?: typeof writeSecrets;
  writeConfigImpl?: typeof writeConfig;
}

export async function runBootstrapRegister(
  opts: { serverUrl: string; inviteToken: string },
  di: BootstrapRegisterDI = {},
): Promise<void> {
  if (!opts.serverUrl || !opts.inviteToken) {
    throw new Error("[bootstrap-register] missing --server-url or --invite-token");
  }
  const fetchFn = di.fetchImpl ?? globalThis.fetch;
  const writeId = di.writeIdentityImpl ?? writeIdentity;
  const writeSec = di.writeSecretsImpl ?? writeSecrets;
  const writeCfg = di.writeConfigImpl ?? writeConfig;

  let res: Response;
  try {
    res = await fetchFn(`${opts.serverUrl}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteToken: opts.inviteToken, hostname: os.hostname() }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Error(`[bootstrap-register] server unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      // response had no JSON body — detail stays empty
    }
    throw new Error(`[bootstrap-register] HTTP ${res.status}: ${detail}`);
  }
  const body = (await res.json()) as {
    ok: true;
    workerId: string;
    permanentToken: string;
    personaId: string;
    identity: IdentityRecord;
    soulBandOverride?: string | null;
  };

  // Write config.server.url (bootstrap script is the canonical config-write step).
  const cfg = readConfig(DEFAULT_CONFIG_PATH());
  cfg.server.url = opts.serverUrl;
  writeCfg(cfg, DEFAULT_CONFIG_PATH());

  // Write permanent token into secrets.json.server.token (read-modify-write).
  const secrets = readSecrets(DEFAULT_SECRETS_PATH());
  secrets.server = { ...(secrets.server ?? {}), token: body.permanentToken };
  writeSec(secrets, DEFAULT_SECRETS_PATH());

  // Write identity.json from persona-derived record.
  writeId(body.identity, undefined /* default path */);

  // Optional: write soul band override.
  if (body.soulBandOverride) {
    writeFileSync(join(os.homedir(), ".mai", "agent", "soul_band_override.txt"), body.soulBandOverride, "utf-8");
  }

  // Step-3b B-1 revision: no background spawn. Print explicit operator next-steps.
  process.stdout.write(
    `✓ Registered as worker_id=${body.workerId}, persona=${body.personaId}.\n` +
      "\n" +
      "Next steps:\n" +
      "  • Run `mai telegram on` to install the persistent Telegram daemon (recommended for production).\n" +
      "  • Run `mai` for interactive REPL mode.\n",
  );
}
