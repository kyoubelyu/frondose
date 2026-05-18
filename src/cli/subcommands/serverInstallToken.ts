/** P-34: `mai server install-token set/show/remove` — manages the fine-grained
 *  GitHub PAT (contents:read) that the bootstrap script embeds for the tarball
 *  install. Stored in ~/.mai/server/secrets.json (server.installToken). */
import { readSecrets, writeSecrets } from "../../persistence/secrets.js";
import { SERVER_SECRETS_PATH } from "../../persistence/serverPaths.js";
import { realPrompter } from "./_prompts.js";

export interface ServerInstallTokenOpts {
  /** Explicit PAT for `set`; omit → masked prompt via prompter.apiKeyInput. */
  token?: string;
  /** Path to secrets.json; DI for tests (defaults to SERVER_SECRETS_PATH()). */
  secretsPath?: string;
  /** Optional DI prompter for tests (avoids real TTY prompt). */
  prompter?: { apiKeyInput(provider: string): Promise<string> };
}

function mask(t: string): string {
  return t.length <= 8 ? "••••" : `${t.slice(0, 4)}…${t.slice(-4)}`;
}

export async function runServerInstallTokenSubcommand(
  action: "set" | "show" | "remove",
  opts: ServerInstallTokenOpts = {},
): Promise<void> {
  const path = opts.secretsPath ?? SERVER_SECRETS_PATH();
  const secrets = readSecrets(path);

  if (action === "show") {
    const t = secrets.server?.installToken;
    process.stdout.write(
      t
        ? `install-token: ${mask(t)}\nstatus: set (embedded into rendered /bootstrap scripts)\n`
        : "install-token: (unset)\nstatus: NOT set — `curl /bootstrap/...` will return an error\n",
    );
    return;
  }

  if (action === "remove") {
    if (secrets.server) delete secrets.server.installToken;
    writeSecrets(secrets, path);
    process.stdout.write("[install-token] removed\n");
    return;
  }

  // action === "set" — explicit arg, else masked prompt (a PAT cannot be generated).
  let token = opts.token?.trim();
  if (!token) {
    const prompter = opts.prompter ?? realPrompter;
    token = (await prompter.apiKeyInput("GitHub install-token (contents:read)")).trim();
  }
  if (!token) {
    process.stderr.write("[install-token] no token provided\n");
    process.exit(1);
  }
  secrets.server = { ...(secrets.server ?? {}), installToken: token };
  writeSecrets(secrets, path);
  process.stdout.write(`[install-token] set (${mask(token)}).\n`);
}
