/** P-29: `mai server web-token set/show/remove` — manages the web dashboard
 *  Basic-Auth secret in ~/.mai/server/secrets.json (server.webToken). */
import { randomBytes } from "node:crypto";
import { readSecrets, writeSecrets } from "../../persistence/secrets.js";
import { SERVER_SECRETS_PATH } from "../../persistence/serverPaths.js";

export interface ServerWebTokenOpts {
  /** Explicit token for `set`; omit to auto-generate hex(24 bytes). */
  token?: string;
  /** Path to secrets.json; DI for tests (defaults to SERVER_SECRETS_PATH()). */
  secretsPath?: string;
}

function mask(t: string): string {
  return t.length <= 6 ? "••••" : `${t.slice(0, 3)}…${t.slice(-3)}`;
}

export function runServerWebTokenSubcommand(action: "set" | "show" | "remove", opts: ServerWebTokenOpts = {}): void {
  const path = opts.secretsPath ?? SERVER_SECRETS_PATH();
  const secrets = readSecrets(path);

  if (action === "show") {
    const t = secrets.server?.webToken;
    process.stdout.write(
      t
        ? `web-token: ${mask(t)}\nauth: enabled (Basic-Auth on the web dashboard)\n`
        : "web-token: (unset)\nauth: disabled (Tailscale-only — no HTTP credentials)\n",
    );
    return;
  }

  if (action === "remove") {
    if (secrets.server) delete secrets.server.webToken;
    writeSecrets(secrets, path);
    process.stdout.write("[web-token] removed — dashboard reverts to no-auth (Tailscale-only)\n");
    return;
  }

  // action === "set"
  const trimmed = opts.token?.trim();
  const token = trimmed ? trimmed : randomBytes(24).toString("hex");
  secrets.server = { ...(secrets.server ?? {}), webToken: token };
  writeSecrets(secrets, path);
  // P-36 F-C: mask the token in the confirmation output (OQ-3).
  process.stdout.write(
    `[web-token] set. Token: ${mask(token)}\n` +
      "  The full token is in ~/.mai/server/secrets.json (chmod 600) if you need to copy it.\n",
  );
}
