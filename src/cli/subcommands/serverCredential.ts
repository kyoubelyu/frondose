/** P-28: `mai server llm-key …` + `mai server google-account …` action dispatcher.
 *  Credentials live in ~/.mai/server/credentials.sqlite (chmod 600).
 *  Error conditions THROW (caller maps to exit 1) — unit-testable.
 *
 *  CREDENTIAL PLACEHOLDER POLICY (C-5): All test fixtures containing credentials
 *  MUST use obvious placeholder values ONLY. */
import type { Database as DB } from "better-sqlite3";
import {
  addGoogleAccount,
  addLlmKey,
  getGoogleAccount,
  getLlmKey,
  listGoogleAccounts,
  listLlmKeys,
  openCredentialsDb,
  removeGoogleAccount,
  removeLlmKey,
} from "../../persistence/credentialLibrary.js";
import { SERVER_CREDENTIALS_DB_PATH } from "../../persistence/serverPaths.js";
import { isInteractive, realPrompter } from "./_prompts.js";

export interface ServerCredentialOpts {
  id?: string;
  json?: boolean;
  // llm-key fields:
  type?: "anthropic" | "openai";
  baseUrl?: string;
  key?: string;
  // google-account fields:
  email?: string;
  password?: string;
  recoveryEmail?: string;
  phone?: string;
  smsLink?: string;
  twofaLink?: string;
  label?: string;
}

function maskSecret(s: string): string {
  return s.length <= 4 ? "••••" : `${s.slice(0, 3)}…${s.slice(-4)}`;
}

/** Dispatch `mai server llm-key <action>` or `mai server google-account <action>`.
 *
 *  B-2 DI: `_openDb` defaults to `openCredentialsDb`. Mock tests inject a closure
 *  returning ONE shared `:memory:` handle so pre-state survives across calls. */
export async function runServerCredentialSubcommand(
  kind: "llm-key" | "google-account",
  action: "add" | "list" | "remove",
  opts: ServerCredentialOpts,
  _openDb?: (path: string) => DB,
): Promise<void> {
  const openDb = _openDb ?? openCredentialsDb;
  const db = openDb(SERVER_CREDENTIALS_DB_PATH());

  if (action === "list") {
    if (kind === "llm-key") {
      const rows = listLlmKeys(db);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(rows.map((r) => ({ ...r, api_key: maskSecret(r.api_key) })))}\n`);
        return;
      }
      if (rows.length === 0) {
        process.stdout.write("(no llm keys configured)\n");
        return;
      }
      process.stdout.write("ID              TYPE        KEY            ASSIGNED\n");
      for (const r of rows) {
        process.stdout.write(
          `${r.id.padEnd(16)}${r.provider_type.padEnd(12)}${maskSecret(r.api_key).padEnd(15)}${r.assigned_count}\n`,
        );
      }
      return;
    }
    const rows = listGoogleAccounts(db);
    if (opts.json) {
      // Mask the access-granting secrets; recovery_email/phone shown (ID aids).
      process.stdout.write(
        `${JSON.stringify(
          rows.map((r) => ({
            ...r,
            password: "••••••",
            sms_link: r.sms_link ? "••••••" : null,
            twofa_link: r.twofa_link ? "••••••" : null,
          })),
        )}\n`,
      );
      return;
    }
    if (rows.length === 0) {
      process.stdout.write("(no google accounts configured)\n");
      return;
    }
    process.stdout.write("ID              EMAIL                       ASSIGNED\n");
    for (const r of rows) {
      process.stdout.write(`${r.id.padEnd(16)}${r.email.padEnd(28)}${r.assigned_count}\n`);
    }
    return;
  }

  if (!opts.id) throw new Error(`[server ${kind} ${action}] missing <id>`);

  if (action === "remove") {
    const ok = kind === "llm-key" ? removeLlmKey(db, opts.id) : removeGoogleAccount(db, opts.id);
    if (!ok) throw new Error(`[server ${kind} remove] ${opts.id} not found`);
    process.stdout.write(`[${kind} remove] ${opts.id} deleted\n`);
    return;
  }

  // action === "add"
  if (kind === "llm-key") {
    if (getLlmKey(db, opts.id)) throw new Error(`[server llm-key add] ${opts.id} already exists`);
    let type = opts.type;
    let baseUrl = opts.baseUrl;
    let key = opts.key;
    if ((!type || !key) && !isInteractive()) {
      throw new Error("[server llm-key add] requires --type and --key (or a TTY for prompts)");
    }
    if (!type) {
      const t = (await realPrompter.input("provider type (anthropic|openai): ")).trim();
      type = t === "openai" ? "openai" : "anthropic";
    }
    if (!baseUrl && type === "openai") {
      baseUrl = (await realPrompter.input("base URL (optional): ")).trim() || undefined;
    }
    if (!key) key = await realPrompter.apiKeyInput("llm-key");
    addLlmKey(db, {
      id: opts.id,
      provider_type: type,
      base_url: baseUrl ?? null,
      api_key: key,
      label: opts.label ?? null,
    });
    process.stdout.write(`[llm-key add] ${opts.id} stored. Bind via \`mai server persona add\`.\n`);
    return;
  }

  // kind === "google-account"
  if (getGoogleAccount(db, opts.id)) {
    throw new Error(`[server google-account add] ${opts.id} already exists`);
  }
  let email = opts.email;
  let password = opts.password;
  if ((!email || !password) && !isInteractive()) {
    throw new Error("[server google-account add] requires --email and --password (or a TTY)");
  }
  if (!email) email = (await realPrompter.input("Google account email: ")).trim();
  if (!password) password = await realPrompter.apiKeyInput("google-account password");
  // P-28.5 fields — optional; blank prompt → null. Only prompted interactively;
  // a non-interactive `add` stores whatever flags were passed (or null).
  const askOpt = async (flag: string | undefined, label: string): Promise<string | null> => {
    if (flag !== undefined) return flag.trim() || null;
    if (!isInteractive()) return null;
    return (await realPrompter.input(`${label} (optional): `)).trim() || null;
  };
  const recovery_email = await askOpt(opts.recoveryEmail, "recovery email");
  const phone = await askOpt(opts.phone, "phone");
  const sms_link = await askOpt(opts.smsLink, "SMS-receive link");
  const twofa_link = await askOpt(opts.twofaLink, "2FA/TOTP link");
  addGoogleAccount(db, {
    id: opts.id,
    email,
    password,
    recovery_email,
    phone,
    sms_link,
    twofa_link,
    label: opts.label ?? null,
  });
  process.stdout.write(`[google-account add] ${opts.id} stored.\n`);
}
