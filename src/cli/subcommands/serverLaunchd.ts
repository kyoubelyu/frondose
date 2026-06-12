/** P-25: launchd plist render + install/uninstall for the mai-server daemon.
 *  Mirrors src/cli/subcommands/launchd.ts (the worker telegram daemon installer).
 *  CLI-layer shell-out to `launchctl` permitted under amended Hard Rule 8.
 *  Added to CLAUDE.md §2 permitted-CLI-shell-out list at Step 7 by orchestrator.
 *  DO NOT import this from src/tools/** (Hard Rule 8: agent tool layer is bash-free). */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EnvSnapshot, InstallOpts, PlistArgs } from "./launchd.js";

export const SERVER_LABEL = "com.kyoube.mai.server";

export const serverPlistPath = (home = os.homedir()): string =>
  path.join(home, "Library", "LaunchAgents", `${SERVER_LABEL}.plist`);

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderServerPlist(args: PlistArgs): string {
  const e = args.env;
  const envEntries: string[] = [
    `    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>`,
    `    <key>HOME</key><string>${escapeXml(args.home)}</string>`,
    `    <key>TELEGRAM_TOKEN</key><string>${escapeXml(e.TELEGRAM_TOKEN)}</string>`,
  ];
  if (e.FRONDOSE_MODEL) {
    envEntries.push(`    <key>FRONDOSE_MODEL</key><string>${escapeXml(e.FRONDOSE_MODEL)}</string>`);
  }
  if (e.providerKeyName && e.providerKeyValue) {
    envEntries.push(`    <key>${e.providerKeyName}</key><string>${escapeXml(e.providerKeyValue)}</string>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(args.nodeBin)}</string>
    <string>${escapeXml(args.maiEntry)}</string>
    <string>server</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key><true/>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>WorkingDirectory</key><string>${escapeXml(args.home)}</string>
  <key>StandardOutPath</key><string>${escapeXml(path.join(args.home, ".mai/server/logs/server-daemon.out.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(args.home, ".mai/server/logs/server-daemon.err.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries.join("\n")}
  </dict>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

export async function installServerLaunchAgent(args: PlistArgs, opts: InstallOpts): Promise<{ cancelled: boolean }> {
  if (process.platform !== "darwin") {
    throw new Error("mai server launchd integration is macOS-only");
  }
  if (!opts.yes) {
    const ok = await opts.consent();
    if (!ok) return { cancelled: true };
  }
  const plPath = serverPlistPath(args.home);
  mkdirSync(path.dirname(plPath), { recursive: true });
  mkdirSync(path.join(args.home, ".mai/server/logs"), { recursive: true });
  const tmp = `${plPath}.tmp`;
  writeFileSync(tmp, renderServerPlist(args), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, plPath);
  chmodSync(plPath, 0o600);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("process.getuid unavailable");
  const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plPath], { encoding: "utf-8" });
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || "").trim();
    throw new Error(`launchctl bootstrap exit ${r.status}: ${detail}`);
  }
  return { cancelled: false };
}

export function uninstallServerLaunchAgent(home = os.homedir()): void {
  const plPath = serverPlistPath(home);
  const uid = process.getuid?.();
  if (uid !== undefined) {
    const r = spawnSync("launchctl", ["bootout", `gui/${uid}/${SERVER_LABEL}`], {
      encoding: "utf-8",
    });
    if (r.status !== 0 && r.status !== 113) {
      process.stderr.write(`[server uninstall] launchctl bootout exit ${r.status}: ${r.stderr ?? ""}\n`);
    }
  }
  try {
    unlinkSync(plPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw e;
  }
}

// Re-export types for callers
export type { EnvSnapshot, PlistArgs, InstallOpts };
