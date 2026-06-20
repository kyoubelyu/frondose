import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { frondoseEnv } from "../env.js";

export const DATA_DIR_NAME = ".frondose";

export function getHomeBase(): string {
  const raw = frondoseEnv("HOME_BASE");
  return raw && raw.trim() !== "" ? raw : homedir();
}

export function HEARTBEAT_PATH(): string {
  return join(getHomeBase(), DATA_DIR_NAME, "agent", "turn-heartbeat");
}

export function WATCHDOG_KILLS_PATH(): string {
  return join(getHomeBase(), DATA_DIR_NAME, "agent", "watchdog-kills.jsonl");
}

export function readWatchdogKillTimestamps(): number[] {
  try {
    const raw = fs.readFileSync(WATCHDOG_KILLS_PATH(), "utf8");
    const out: number[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ts = (JSON.parse(trimmed) as { ts?: unknown }).ts;
        if (typeof ts === "number" && Number.isFinite(ts)) out.push(ts);
      } catch {
        /* skip malformed marker lines */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function clearWatchdogKills(): void {
  try {
    fs.rmSync(WATCHDOG_KILLS_PATH(), { force: true });
  } catch {
    /* watchdog marker cleanup must never crash the reaper */
  }
}

const HEARTBEAT_THROTTLE_MS = 5_000;
let lastHeartbeatWriteAt = 0;

export function writeTurnHeartbeat(now = Date.now()): void {
  lastHeartbeatWriteAt = now;
  try {
    const heartbeatPath = HEARTBEAT_PATH();
    fs.mkdirSync(dirname(heartbeatPath), { recursive: true });
    fs.writeFileSync(heartbeatPath, String(now), "utf8");
    const beatDate = new Date(now);
    fs.utimesSync(heartbeatPath, beatDate, beatDate);
  } catch {
    /* heartbeat must never crash the turn */
  }
}

export function bumpTurnHeartbeat(now = Date.now()): void {
  if (now - lastHeartbeatWriteAt < HEARTBEAT_THROTTLE_MS) return;
  lastHeartbeatWriteAt = now;
  try {
    const heartbeatPath = HEARTBEAT_PATH();
    const beatDate = new Date(now);
    fs.utimesSync(heartbeatPath, beatDate, beatDate);
  } catch {
    try {
      const heartbeatPath = HEARTBEAT_PATH();
      fs.mkdirSync(dirname(heartbeatPath), { recursive: true });
      fs.writeFileSync(heartbeatPath, String(now), "utf8");
      const beatDate = new Date(now);
      fs.utimesSync(heartbeatPath, beatDate, beatDate);
    } catch {
      /* heartbeat must never crash the turn */
    }
  }
}

export function removeTurnHeartbeat(): void {
  lastHeartbeatWriteAt = 0;
  try {
    fs.rmSync(HEARTBEAT_PATH(), { force: true });
  } catch {
    /* heartbeat cleanup must never crash the turn */
  }
}
