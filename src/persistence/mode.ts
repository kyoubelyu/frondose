import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR_NAME, getHomeBase } from "./paths.js";

export type AgentMode = "manual" | "auto";

export const DEFAULT_MODE_PATH = (): string => join(getHomeBase(), DATA_DIR_NAME, "agent", "mode.json");

export function readMode(path: string = DEFAULT_MODE_PATH()): AgentMode {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { mode?: unknown };
    return raw.mode === "auto" ? "auto" : "manual";
  } catch {
    return "manual";
  }
}

export function writeMode(mode: AgentMode, path: string = DEFAULT_MODE_PATH()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ mode }));
  } catch {
    // best-effort
  }
}

export function setCronMode(state: { cronEnabled: boolean }, enabled: boolean): void {
  state.cronEnabled = enabled;
  writeMode(enabled ? "auto" : "manual");
}
