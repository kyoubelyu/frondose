/**
 * P-18 mock tests — T-CL.1..T-CL.4: crash logger module.
 *
 * Tests registerCrashHandlers() behavior for uncaughtException,
 * unhandledRejection, SIGABRT, and idempotent re-registration.
 *
 * Uses child processes for T-CL.1/T-CL.2/T-CL.3 because node:test's own
 * uncaughtException/unhandledRejection handlers intercept manual process.emit()
 * calls and mark the current test as failed, preventing assertion verification.
 * Child processes run via spawnSync + tsx, which provides a clean environment.
 *
 * T-CL.4 (idempotency) is tested directly since no event emission is needed.
 *
 * No Chrome, no LLM, no SQLite required.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { registerCrashHandlers } from "../../src/cli/crashLogger.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ─────────────────────────────────────────────────────────────────

const LOG_DIR = join(tmpdir(), `mai-p18-cl-${process.pid}`);
const LOG_PATH = join(LOG_DIR, "crash.log");
const SRC_PATH = join(process.cwd(), "src", "cli", "crashLogger.ts");
const SRC_URL = pathToFileURL(SRC_PATH).href;

function makeHelperScript(eventLine: string, extraLines = ""): string {
  // Use an IIFE with dynamic import so tsx resolves the path correctly
  return `
import { registerCrashHandlers } from ${JSON.stringify(SRC_URL)};
const logPath = ${JSON.stringify(LOG_PATH)};
registerCrashHandlers(logPath);
${eventLine}
${extraLines}
`.trim();
}

function runInChild(script: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("node", ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    timeout: 10_000,
    env: { ...process.env, MAI_SKIP_LIVE: "1" },
  });
  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    status: result.status,
  };
}

function readLog(): string {
  try {
    return readFileSync(LOG_PATH, "utf-8");
  } catch {
    return "";
  }
}

function countListeners(eventName: string): number {
  return (process.listeners as unknown as (name: string) => ((...args: never) => unknown)[])(eventName).length;
}

describe("Crash logger — T-CL.1..4", () => {
  before(() => {
    // Clean up any previous test's leftover log file
    try {
      cleanupTmpDir(LOG_DIR);
    } catch {
      // best-effort
    }
  });

  after(() => {
    try {
      cleanupTmpDir(LOG_DIR);
    } catch {
      // best-effort
    }
  });

  // ─── T-CL.1 ───────────────────────────────────────────────────────────────

  it("T-CL.1: uncaughtException handler appends ISO-timestamped error stack to crash log", () => {
    // Given: registerCrashHandlers() registered on a temp log path in a child process
    // When:  child process emits "uncaughtException" with new Error("boom")
    // Then:  the crash log contains "[UNCAUGHT]" and "boom" and an ISO timestamp;
    //        process exits with code 1 (from handler's process.exit(1))
    const script = makeHelperScript(`process.emit("uncaughtException", new Error("boom"));`);

    const result = runInChild(script);

    assert.equal(result.status, 1, "handler must call process.exit(1) for uncaughtException");

    const log = readLog();
    assert.ok(log.includes("[UNCAUGHT]"), "log must contain [UNCAUGHT] marker");
    assert.ok(log.includes("Error: boom"), "log must contain error message text");
    assert.ok(log.includes("at "), "log must contain stack trace lines");
    assert.ok(/20\d{2}-/.test(log), "log must contain ISO-8601 timestamp");
  });

  // ─── T-CL.2 ───────────────────────────────────────────────────────────────

  it("T-CL.2: unhandledRejection handler appends reason string to crash log", () => {
    // Given: registerCrashHandlers() registered on a temp log path in a child process
    // When:  child process emits "unhandledRejection" with "something broke"
    // Then:  the crash log contains "[UNHANDLED_REJECTION] something broke";
    //        process exits with code 0 (handler does NOT call process.exit)
    const script = makeHelperScript(`process.emit("unhandledRejection", "something broke");`);

    const result = runInChild(script);

    assert.equal(result.status, 0, "handler must NOT call process.exit for unhandledRejection");

    const log = readLog();
    assert.ok(log.includes("[UNHANDLED_REJECTION]"), "log must contain [UNHANDLED_REJECTION] marker");
    assert.ok(log.includes("something broke"), "log must contain the rejection reason");
  });

  // ─── T-CL.3 ───────────────────────────────────────────────────────────────

  it("T-CL.3: SIGABRT handler logs abort then calls process.exit(134)", () => {
    // Given: registerCrashHandlers() registered on a temp log path in a child process
    // When:  child process emits "SIGABRT"
    // Then:  the crash log contains "[SIGABRT] aborted";
    //        child process exits with code 134
    const script = makeHelperScript(`process.emit("SIGABRT");`);

    const result = runInChild(script);

    assert.equal(result.status, 134, "handler must call process.exit(134) for SIGABRT");

    const log = readLog();
    assert.ok(log.includes("[SIGABRT]"), "log must contain [SIGABRT] marker");
    assert.ok(log.includes("aborted"), "log must contain 'aborted' text");
  });

  // ─── T-CL.4 ───────────────────────────────────────────────────────────────

  it("T-CL.4: registerCrashHandlers() is idempotent — second call does not add duplicate listeners", () => {
    // Given: registerCrashHandlers() has been called once
    // When:  it is called a second time
    // Then:  the listener count for "uncaughtException" equals 1 (original) + pre-existing
    // Note: this test runs directly (no child process) because it only checks
    // listener counts. If there are pre-existing uncaughtException listeners
    // (e.g. from the test runner), the delta check still works.
    const countBefore = countListeners("uncaughtException");

    registerCrashHandlers(LOG_PATH);
    const countAfterFirst = countListeners("uncaughtException");
    assert.ok(countAfterFirst > countBefore, "first call must add an uncaughtException listener");

    registerCrashHandlers(LOG_PATH);
    const countAfterSecond = countListeners("uncaughtException");
    assert.equal(countAfterSecond, countAfterFirst, "second call must NOT increase listener count");
  });
});
