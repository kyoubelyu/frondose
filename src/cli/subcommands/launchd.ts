/** P-23: launchd plist render + install/uninstall (plan §6.1).
 *
 * CLI-layer shell-out to `launchctl` permitted per Hard Rule 8 amendment
 * (operator approval 2026-05-14). DO NOT import this from src/tools/**.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface EnvSnapshot {
  TELEGRAM_TOKEN: string; // required
  TELEGRAM_PROXY?: string;
  MAI_MODEL?: string;
  providerKeyName?: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "DEEPSEEK_API_KEY";
  providerKeyValue?: string;
}

export interface PlistArgs {
  nodeBin: string; // process.execPath
  maiEntry: string; // fs.realpathSync(process.argv[1])
  home: string; // os.homedir()
  env: EnvSnapshot;
}

export interface InstallOpts {
  consent: () => Promise<boolean>; // returns true to proceed; false cancels
  yes?: boolean; // bypass consent
}

export const LABEL = "com.kyoube.mai.telegram";

export const plistPath = (home = os.homedir()): string => path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderPlist(args: PlistArgs): string {
  const e = args.env;
  const envEntries: string[] = [
    `    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>`,
    `    <key>HOME</key><string>${escapeXml(args.home)}</string>`,
    `    <key>TELEGRAM_TOKEN</key><string>${escapeXml(e.TELEGRAM_TOKEN)}</string>`,
  ];
  if (e.TELEGRAM_PROXY) {
    envEntries.push(`    <key>TELEGRAM_PROXY</key><string>${escapeXml(e.TELEGRAM_PROXY)}</string>`);
  }
  if (e.MAI_MODEL) {
    envEntries.push(`    <key>MAI_MODEL</key><string>${escapeXml(e.MAI_MODEL)}</string>`);
  }
  if (e.providerKeyName && e.providerKeyValue) {
    envEntries.push(`    <key>${e.providerKeyName}</key><string>${escapeXml(e.providerKeyValue)}</string>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(args.nodeBin)}</string>
    <string>${escapeXml(args.maiEntry)}</string>
    <string>telegram</string>
    <string>poll</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key><true/>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>WorkingDirectory</key><string>${escapeXml(args.home)}</string>
  <key>StandardOutPath</key><string>${escapeXml(path.join(args.home, ".mai/agent/logs/telegram-daemon.out.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(args.home, ".mai/agent/logs/telegram-daemon.err.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries.join("\n")}
  </dict>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

export async function installLaunchAgent(args: PlistArgs, opts: InstallOpts): Promise<{ cancelled: boolean }> {
  if (process.platform !== "darwin") {
    throw new Error("mai telegram launchd integration is macOS-only");
  }
  if (!opts.yes) {
    const ok = await opts.consent();
    if (!ok) return { cancelled: true };
  }
  const plPath = plistPath(args.home);
  mkdirSync(path.dirname(plPath), { recursive: true });
  mkdirSync(path.join(args.home, ".mai/agent/logs"), { recursive: true });
  const tmp = `${plPath}.tmp`;
  writeFileSync(tmp, renderPlist(args), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, plPath);
  chmodSync(plPath, 0o600); // defensive — rename may not preserve mode on some FS
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("process.getuid unavailable; cannot launchctl bootstrap");
  const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plPath], { encoding: "utf-8" });
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || "").trim();
    throw new Error(`launchctl bootstrap exit ${r.status}: ${detail}`);
  }
  return { cancelled: false };
}

export function uninstallLaunchAgent(home = os.homedir()): void {
  const plPath = plistPath(home);
  const uid = process.getuid?.();
  if (uid !== undefined) {
    const r = spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { encoding: "utf-8" });
    // exit 113 = service not found; treat as success.
    if (r.status !== 0 && r.status !== 113) {
      process.stderr.write(`[telegram off] launchctl bootout exit ${r.status}: ${r.stderr ?? ""}\n`);
    }
  }
  try {
    unlinkSync(plPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw e;
  }
}

export function isDaemonInstalled(home = os.homedir()): boolean {
  return existsSync(plistPath(home));
}
