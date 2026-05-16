/** P-26: `mai server worker add/rotate/remove/list` action dispatcher.
 *
 *  Token mint: `crypto.randomBytes(32).toString("hex")`. Plaintext printed in
 *  a clear boxed advisory ONCE — operator captures via terminal. SHA-256 hash
 *  stored in `~/.mai/server/workers.sqlite`. */
import { createHash, randomBytes } from "node:crypto";
import { readConfig } from "../../persistence/config.js";
import { insertInvite, openInvitesDb } from "../../persistence/invitesRegistry.js";
import { readPersonaTemplate } from "../../persistence/personaLibrary.js";
import {
  SERVER_CONFIG_PATH,
  SERVER_INVITES_DB_PATH,
  SERVER_PERSONAS_DIR,
  SERVER_WORKERS_DB_PATH,
} from "../../persistence/serverPaths.js";
import {
  addWorker,
  listWorkers,
  openWorkersDb,
  removeWorker,
  rotateWorkerToken,
} from "../../persistence/workersRegistry.js";

export async function runServerWorkerSubcommand(
  action: "add" | "rotate" | "remove" | "list" | "provision" | "revoke",
  opts: {
    workerId?: string;
    hostname?: string;
    persona?: string;
    personaId?: string;
    ttlMin?: number;
    json?: boolean;
  },
): Promise<void> {
  const db = openWorkersDb(SERVER_WORKERS_DB_PATH());

  if (action === "add") {
    if (!opts.workerId) {
      process.stderr.write("[server worker add] missing <worker_id>\n");
      process.exit(1);
    }
    if (listWorkers(db).some((w) => w.worker_id === opts.workerId)) {
      process.stderr.write(
        `[server worker add] worker_id ${opts.workerId} already exists; use \`rotate\` to mint a new token\n`,
      );
      process.exit(1);
    }
    const token = randomBytes(32).toString("hex");
    addWorker(db, opts.workerId, token, opts.hostname, opts.persona);
    printBoxedToken(opts.workerId, token, false);
    return;
  }

  if (action === "rotate") {
    if (!opts.workerId) {
      process.stderr.write("[server worker rotate] missing <worker_id>\n");
      process.exit(1);
    }
    const token = randomBytes(32).toString("hex");
    const ok = rotateWorkerToken(db, opts.workerId, token);
    if (!ok) {
      process.stderr.write(`[server worker rotate] worker_id ${opts.workerId} not found\n`);
      process.exit(1);
    }
    printBoxedToken(opts.workerId, token, true);
    return;
  }

  if (action === "remove") {
    if (!opts.workerId) {
      process.stderr.write("[server worker remove] missing <worker_id>\n");
      process.exit(1);
    }
    const ok = removeWorker(db, opts.workerId);
    if (!ok) {
      process.stderr.write(`[server worker remove] worker_id ${opts.workerId} not found\n`);
      process.exit(1);
    }
    process.stdout.write(
      `[worker remove] ${opts.workerId} purged from registry; outstanding inbox messages discarded.\n`,
    );
    return;
  }

  if (action === "provision") {
    if (!opts.personaId) {
      process.stderr.write("[server worker provision] missing <persona_id>\n");
      process.exit(1);
    }
    const persona = readPersonaTemplate(SERVER_PERSONAS_DIR(), opts.personaId);
    if (!persona) {
      process.stderr.write(`[server worker provision] persona ${opts.personaId} not found\n`);
      process.exit(1);
    }
    const invitesDb = openInvitesDb(SERVER_INVITES_DB_PATH());
    const inviteToken = randomBytes(32).toString("hex");
    const tokenSha256 = createHash("sha256").update(inviteToken).digest("hex");
    const expiresAt = Date.now() + (opts.ttlMin ?? 30) * 60_000;
    insertInvite(invitesDb, tokenSha256, opts.personaId, opts.hostname ?? null, expiresAt);
    const serverUrl = readConfig(SERVER_CONFIG_PATH()).server.url ?? "<set config.json.server.url first>";
    const curl = `curl -sf ${serverUrl}/bootstrap/${inviteToken}.sh | bash`;
    process.stdout.write(`\nRun on worker VM:\n\n  ${curl}\n\n`);
    process.stdout.write(`Expires: ${new Date(expiresAt).toISOString()}\n`);
    return;
  }

  if (action === "revoke") {
    if (!opts.workerId) {
      process.stderr.write("[server worker revoke] missing <worker_id>\n");
      process.exit(1);
    }
    const ok = removeWorker(db, opts.workerId);
    if (!ok) {
      process.stderr.write(`[server worker revoke] worker_id ${opts.workerId} not found\n`);
      process.exit(1);
    }
    process.stdout.write(`[worker revoke] ${opts.workerId} revoked; next heartbeat/poll will 401.\n`);
    return;
  }

  if (action === "list") {
    const rows = listWorkers(db);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(rows)}\n`);
      return;
    }
    if (rows.length === 0) {
      process.stdout.write("(no workers registered)\n");
      return;
    }
    process.stdout.write("WORKER_ID     HOSTNAME      PERSONA       STATUS    LAST_HEARTBEAT\n");
    for (const w of rows) {
      const hb = w.last_heartbeat ? new Date(w.last_heartbeat).toISOString() : "(never)";
      process.stdout.write(
        `${w.worker_id.padEnd(14)}${(w.hostname ?? "").padEnd(14)}${(w.persona ?? "").padEnd(14)}${w.status.padEnd(10)}${hb}\n`,
      );
    }
  }
}

function printBoxedToken(workerId: string, token: string, rotated: boolean): void {
  const w = process.stdout.write.bind(process.stdout);
  w("\n═══ SAVE THIS TOKEN NOW (cannot recover) ═══\n");
  if (rotated) w("OLD TOKEN REVOKED — REDISTRIBUTE THIS NEW ONE\n");
  w(`worker_id: ${workerId}\n`);
  w(`token:     ${token}\n`);
  w("═════════════════════════════════════════════\n\n");
  w("Distribute via SSH to the worker VM. Edit ~/.mai/agent/secrets.json:\n");
  w(`  "server": { "token": "${token}" }\n\n`);
  w("And set the server URL in ~/.mai/agent/config.json:\n");
  w('  "server": { "url": "http://<tailscale-server-address>:3031" }\n');
}
