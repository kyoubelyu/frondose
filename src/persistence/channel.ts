import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR_NAME, getHomeBase } from "./paths.js";

export type UpdateChannel = "stable" | "prerelease";

export const DEFAULT_CHANNEL_PATH = (): string => join(getHomeBase(), DATA_DIR_NAME, "agent", "channel");

/** Read the persisted update channel. Default "stable" (preserves today's
 *  /releases/latest behavior). Plain text "stable" | "prerelease" written by
 *  install.sh; tolerant of trailing whitespace/newline. Any other content -> stable. */
export function readUpdateChannel(path: string = DEFAULT_CHANNEL_PATH()): UpdateChannel {
  try {
    return readFileSync(path, "utf8").trim() === "prerelease" ? "prerelease" : "stable";
  } catch {
    return "stable";
  }
}

export function writeUpdateChannel(channel: UpdateChannel, path: string = DEFAULT_CHANNEL_PATH()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${channel}\n`);
  } catch {
    // best-effort
  }
}
