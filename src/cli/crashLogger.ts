// P-18 D-1: crash logger — appends uncaughtException, unhandledRejection, SIGABRT to crash log
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getHomeBase } from "../persistence/paths.js";

const DEFAULT_LOG_PATH = (): string => join(getHomeBase(), ".mai", "agent", "logs", "crash.log");

let registered = false;

/** Register crash handlers. Idempotent — second call is a no-op. */
export function registerCrashHandlers(logPath = DEFAULT_LOG_PATH()): void {
  if (registered) return;
  registered = true;

  // Ensure log directory exists
  mkdirSync(dirname(logPath), { recursive: true });

  const writeLine = (prefix: string, body: string): void => {
    const ts = new Date().toISOString();
    appendFileSync(logPath, `${ts} ${prefix} ${body}\n`, "utf-8");
  };

  process.on("uncaughtException", (err) => {
    writeLine("[UNCAUGHT]", err?.stack ?? String(err));
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    writeLine("[UNHANDLED_REJECTION]", String(reason));
  });

  process.on("SIGABRT", () => {
    writeLine("[SIGABRT]", "aborted");
    process.exit(134);
  });
}
