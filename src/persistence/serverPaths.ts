/** P-25: path constants for the server's independent directory tree.
 *  All constants are getter functions so getHomeBase() is evaluated lazily
 *  (important for test isolation: tests can set process.env.FRONDOSE_HOME_BASE before calling). */
import { join } from "node:path";
import { DATA_DIR_NAME, getHomeBase } from "./paths.js";

export const SERVER_ROOT = (): string => join(getHomeBase(), DATA_DIR_NAME, "server");
export const SERVER_MEMORY_DB_PATH = (): string => join(SERVER_ROOT(), "memory.sqlite");
export const SERVER_AUDIT_PATH = (): string => join(SERVER_ROOT(), "audit.jsonl");
export const SERVER_SESSIONS_ROOT = (): string => join(SERVER_ROOT(), "sessions");
export const SERVER_PID_PATH = (): string => join(SERVER_ROOT(), "server.pid");
export const SERVER_TELEGRAM_CONFIG_PATH = (): string => join(SERVER_ROOT(), "telegram.json");
export const SERVER_IDENTITY_PATH = (): string => join(SERVER_ROOT(), "identity.json");
export const SERVER_CONFIG_PATH = (): string => join(SERVER_ROOT(), "config.json");
export const SERVER_SECRETS_PATH = (): string => join(SERVER_ROOT(), "secrets.json");
export const SERVER_LOGS_DIR = (): string => join(SERVER_ROOT(), "logs");

// P-26: worker registry + server-side inbox.
export const SERVER_WORKERS_DB_PATH = (): string => join(SERVER_ROOT(), "workers.sqlite");
export const SERVER_INBOX_DB_PATH = (): string => join(SERVER_ROOT(), "inbox.sqlite");

// P-27: persona template library.
export const SERVER_PERSONAS_DIR = (): string => join(SERVER_ROOT(), "personas");

// P-28: credential library (LLM keys + Google accounts).
export const SERVER_CREDENTIALS_DB_PATH = (): string => join(SERVER_ROOT(), "credentials.sqlite");

// P-30: per-worker node config files (VNC port/password + SSH overrides).
export const SERVER_WORKERS_CONFIG_DIR = (): string => join(SERVER_ROOT(), "workers");

// P-31 Step 4a STUB: server agent's own cron schedule store. Builder wires at Step 4b.
export const SERVER_SCHEDULE_PATH = (): string => join(SERVER_ROOT(), "schedule.jsonl");
