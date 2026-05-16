/** P-27/P-28 worker side: `mai bootstrap-register --server-url <url> --invite-token <token>`.
 *  POSTs /api/register; folds the response into ONE config.json v2 write
 *  (server.url + identity + soul.override — D-9) plus a secrets.json write
 *  (server.token + the pushed LLM provider config). Prints a start-instruction
 *  and returns. Does NOT spawn a background process.
 *
 *  NO `child_process` import.
 *
 *  Error paths THROW (caller in main.ts maps to exit 1) so the function is
 *  unit-testable without killing the test runner. */
import os from "node:os";
import { DEFAULT_CONFIG_PATH, readConfig, writeConfig } from "../../persistence/config.js";
import type { IdentityRecord, writeIdentity } from "../../persistence/identity.js";
import { DEFAULT_SECRETS_PATH, readSecrets, writeSecrets } from "../../persistence/secrets.js";

export interface BootstrapRegisterDI {
  fetchImpl?: typeof globalThis.fetch;
  writeSecretsImpl?: typeof writeSecrets;
  writeConfigImpl?: typeof writeConfig;
  /** P-28 D-9: bootstrapRegister no longer writes legacy identity.json — config.json
   *  v2 is the sole source of truth for a provisioned worker. Retained as an
   *  optional (unused) field for DI-shape backward compatibility. */
  writeIdentityImpl?: typeof writeIdentity;
}

export async function runBootstrapRegister(
  opts: { serverUrl: string; inviteToken: string },
  di: BootstrapRegisterDI = {},
): Promise<void> {
  if (!opts.serverUrl || !opts.inviteToken) {
    throw new Error("[bootstrap-register] missing --server-url or --invite-token");
  }
  const fetchFn = di.fetchImpl ?? globalThis.fetch;
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
    llmProviderConfig?: { name: string; type: "anthropic" | "openai"; baseUrl?: string; key: string };
    googleAccountEmail?: string;
  };

  // ─── Write config.json v2 — ONE writeConfig folding server.url + identity + soul (D-9) ───
  const cfg = readConfig(DEFAULT_CONFIG_PATH());
  cfg.server.url = opts.serverUrl;
  cfg.identity = body.identity;
  cfg.soul = { override: body.soulBandOverride ?? null };
  writeCfg(cfg, DEFAULT_CONFIG_PATH());

  // ─── Write secrets.json — server.token + (P-28) LLM provider + default ───
  const secrets = readSecrets(DEFAULT_SECRETS_PATH());
  secrets.server = { ...(secrets.server ?? {}), token: body.permanentToken };
  if (body.llmProviderConfig) {
    const p = body.llmProviderConfig;
    secrets.providers = {
      ...(secrets.providers ?? {}),
      [p.name]: { key: p.key, baseUrl: p.baseUrl, type: p.type },
    };
    secrets.default = p.name;
  }
  writeSec(secrets, DEFAULT_SECRETS_PATH());

  // D-9: no writeIdentity, no soul_band_override.txt write — config.json v2 is the
  // single source of truth for a freshly-provisioned worker.
  process.stdout.write(
    `✓ Registered as worker_id=${body.workerId}, persona=${body.personaId}.\n` +
      (body.googleAccountEmail
        ? `  LinkedIn login: use Google account ${body.googleAccountEmail} ("Continue with Google" in Chrome).\n`
        : "") +
      (body.llmProviderConfig
        ? `  LLM provider configured: ${body.llmProviderConfig.name} — no \`mai auth set\` needed.\n`
        : "  No LLM key was pushed — run `mai auth set` before starting the worker.\n") +
      "\n" +
      "Next steps:\n" +
      "  • Run `mai telegram on` to install the persistent Telegram daemon (recommended for production).\n" +
      "  • Run `mai` for interactive REPL mode.\n",
  );
}
