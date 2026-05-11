/** P-11 D-9: `mai status` — aggregate auth + chrome + identity + telegram + cron + memory. */
import { existsSync, statSync } from "node:fs";
// @ts-expect-error chrome-remote-interface ships no types; any-bleed contained per src/cdp/types.ts precedent
import CDP from "chrome-remote-interface";
import { readAuth } from "../../persistence/auth.js";
import { readIdentity } from "../../persistence/identity.js";
import { readSchedule } from "../../persistence/schedule.js";
import { readTelegramConfig } from "../../persistence/telegramConfig.js";

export interface StatusOpts {
  authPath: string;
  identityPath: string;
  schedulePath: string;
  tcPath: string;
  memoryDbPath: string;
  cdpPort: number;
}

export async function runStatusSubcommand(opts: StatusOpts): Promise<void> {
  // auth
  const auth = readAuth(opts.authPath);
  if (auth) {
    const providerCount = auth.providers ? Object.keys(auth.providers).length : 0;
    process.stdout.write(`auth: ${providerCount} provider(s) configured (default: ${auth.default ?? "none"})\n`);
  } else {
    process.stdout.write("auth: (not configured)\n");
  }

  // identity
  const id = readIdentity(opts.identityPath);
  if (id) {
    const role = id.role ?? "(no role)";
    const company = id.company ?? "(no company)";
    const fullName = id.fullName ?? "(no name)";
    process.stdout.write(`identity: ${fullName} (${role} @ ${company})\n`);
  } else {
    process.stdout.write("identity: (not initialized)\n");
  }

  // chrome (best-effort 2s ping)
  try {
    const v = await Promise.race<{ Browser: string }>([
      CDP.Version({ port: opts.cdpPort }) as Promise<{ Browser: string }>,
      new Promise<{ Browser: string }>((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000)),
    ]);
    process.stdout.write(`chrome: running (CDP port ${opts.cdpPort}, browser=${v.Browser})\n`);
  } catch {
    process.stdout.write(`chrome: not running (CDP port ${opts.cdpPort} unreachable)\n`);
  }

  // telegram
  const tg = readTelegramConfig(opts.tcPath);
  process.stdout.write(
    `telegram: enabled=${tg.enabled}, boundChatId=${tg.boundChatId ?? "(unset)"}, offset=${tg.lastUpdateOffset}\n`,
  );

  // cron
  const records = readSchedule(opts.schedulePath);
  process.stdout.write(`cron: ${records.length} scheduled job(s)\n`);

  // memory
  if (existsSync(opts.memoryDbPath)) {
    const sz = statSync(opts.memoryDbPath).size;
    process.stdout.write(`memory: ${(sz / 1024).toFixed(1)} KB at ${opts.memoryDbPath}\n`);
  } else {
    process.stdout.write("memory: (not yet created)\n");
  }
}
