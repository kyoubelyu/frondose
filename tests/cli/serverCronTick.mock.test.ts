/**
 * P-31 Step 4a — T-TICK.* scaffolds (server cron tick)
 *
 * Gate coverage:
 *   G-P31.9  — T-TICK.1 (SERVER_SCHEDULE_PATH resolves correctly)
 *   G-P31.10 — T-TICK.2 (drainDueJobs fires runCronTurn for a due job)
 *              T-TICK.3 (structural: serverRepl + serverDaemon contain tick machinery)
 *
 * DI surface (plan §11): drainDueJobs called directly with tmp schedule path
 * + mock RunCronTurnDeps. SERVER_SCHEDULE_PATH imported from persistence/serverPaths.
 *
 * NOTE (Step 4a):
 *   T-TICK.1: imports SERVER_SCHEDULE_PATH from stub → compiles; assertion is TODO.
 *   T-TICK.2: drainDueJobs + RunCronTurnDeps exist pre-P-31 → compiles; assertion TODO.
 *   T-TICK.3: structural grep on serverRepl.ts + serverDaemon.ts → fails at Step 4a
 *              because those strings don't exist yet (builder adds at Step 4b).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { CoreMessage, ToolSet } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { drainDueJobs, type RunCronTurnDeps } from "../../src/cli/replCron.js";
import type { ScheduleRecord } from "../../src/persistence/schedule.js";
import { readSchedule, writeSchedule } from "../../src/persistence/schedule.js";
import { SERVER_SCHEDULE_PATH } from "../../src/persistence/serverPaths.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p31-tick-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const SRC_ROOT = resolve(new URL(".", import.meta.url).pathname, "../../src");

// ─── T-TICK.1 ─────────────────────────────────────────────────────────────────

describe("SERVER_SCHEDULE_PATH resolves correctly (G-P31.9)", () => {
  it("T-TICK.1: SERVER_SCHEDULE_PATH() ends with '.mai/server/schedule.jsonl' (resolves under ~/.mai/server/)", () => {
    // Given:  SERVER_SCHEDULE_PATH exported from src/persistence/serverPaths.ts (P-31 stub)
    // When:   SERVER_SCHEDULE_PATH() called
    // Then:   result ends with '/.mai/server/schedule.jsonl' relative to homedir

    const p = SERVER_SCHEDULE_PATH();
    const expected = join(homedir(), ".mai", "server", "schedule.jsonl");
    assert.equal(p, expected, `SERVER_SCHEDULE_PATH() must equal '${expected}'; got '${p}'`);
  });
});

// ─── T-TICK.2 ─────────────────────────────────────────────────────────────────

describe.skip("drainDueJobs fires runCronTurn for a due job (G-P31.10)", () => {
  it("T-TICK.2: given a server schedule.jsonl with a due record + mock RunCronTurnDeps, drainDueJobs executes runCronTurn (appends [CRON_RUN_ID=…] turn) and advances nextRunAt for recurring record", async () => {
    // Given:  tmp schedule.jsonl with 1 recurring record whose nextRunAt is in the past
    //         + mock RunCronTurnDeps (MockLanguageModelV1, captured messages, capture stream)
    // When:   drainDueJobs(schedulePath, abortSignal, deps)
    // Then:   mock model was called ≥ 1 time; messages contains a [CRON_RUN_ID=…] user turn;
    //         readSchedule after drain shows updated nextRunAt (advance for recurring)

    const { dir, cleanup } = makeTmpDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");

      // Past date → job is due
      const pastDate = new Date(Date.now() - 120_000).toISOString();
      const dueRecord: ScheduleRecord = {
        id: "tick-test-1",
        task: "check fleet status",
        cronExpr: "* * * * *",
        type: "recurring",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastRunAt: null,
        nextRunAt: pastDate,
      };
      writeSchedule(schedulePath, [dueRecord]);

      const capturedMessages: CoreMessage[] = [];
      let modelCallCount = 0;

      const mockModel = new MockLanguageModelV1({
        doStream: async () => {
          modelCallCount++;
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "text-delta" as const, textDelta: "checked fleet" },
                {
                  type: "finish" as const,
                  finishReason: "stop" as const,
                  usage: { promptTokens: 10, completionTokens: 5 },
                },
              ],
            }),
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        },
      });

      const captureStream = {
        write: (_chunk: unknown) => true,
      };

      const mockDeps: RunCronTurnDeps = {
        model: mockModel,
        system: "test system",
        messages: capturedMessages,
        tools: {} as ToolSet,
        sessionFile: join(dir, "session.json"),
        abortSignal: undefined,
        onStepFinish: undefined,
        out: captureStream as unknown as NodeJS.WritableStream,
      };

      await drainDueJobs(schedulePath, undefined, mockDeps);

      // Mock model must have been called at least once (drainDueJobs fired runCronTurn)
      assert.ok(modelCallCount >= 1, `mock model must be called at least once; called ${modelCallCount} times`);

      // capturedMessages must contain a user turn with [CRON_RUN_ID=…] prefix
      // (runCronTurn pushes: "[TIME HH:MM]\n[CRON_RUN_ID=…]\n(scheduled task: ...)")
      const cronUserTurns = capturedMessages.filter(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("[CRON_RUN_ID="),
      );
      assert.ok(
        cronUserTurns.length >= 1,
        `capturedMessages must include at least one [CRON_RUN_ID=…] user turn; got ${JSON.stringify(capturedMessages.map((m) => m.role))}`,
      );

      // After drain: the recurring record must have a new nextRunAt (markRan was called)
      // drainDueJobs exits when findDueJobs returns empty, so nextRunAt > now at that point
      const updatedRecords = readSchedule(schedulePath);
      assert.equal(updatedRecords.length, 1, "recurring record must remain in schedule after drain (not removed)");
      const updatedRec = updatedRecords[0];
      assert.ok(updatedRec !== undefined, "updated record must exist");
      assert.notEqual(
        updatedRec.nextRunAt,
        dueRecord.nextRunAt,
        "nextRunAt must advance from the original past date (markRan called)",
      );
      assert.ok(updatedRec.lastRunAt !== null, "lastRunAt must be set after at least one successful firing");
    } finally {
      cleanup();
    }
  });
});

// ─── T-TICK.3 ─────────────────────────────────────────────────────────────────

describe("serverRepl + serverDaemon contain cron tick machinery (G-P31.10 structural)", () => {
  it("T-TICK.3: src/cli/serverRepl.ts and src/cli/serverDaemon.ts each contain a boot drainDueJobs call and a setInterval(…, 60_000).unref() wrapped in turnLock.run — builder adds at Step 4b", () => {
    // Given:  src/cli/serverRepl.ts + src/cli/serverDaemon.ts post-builder Step 4b
    // When:   reading file contents as strings
    // Then:   each file contains 'drainDueJobs', 'setInterval', '60_000', 'unref()',
    //         and 'turnLock.run' — the structural markers of the P-31 tick pattern

    const serverReplPath = join(SRC_ROOT, "cli", "serverRepl.ts");
    const serverDaemonPath = join(SRC_ROOT, "cli", "serverDaemon.ts");

    const replContent = readFileSync(serverReplPath, "utf-8");
    const daemonContent = readFileSync(serverDaemonPath, "utf-8");

    const requiredPatterns = ["drainDueJobs", "setInterval", "60_000", ".unref()", "turnLock.run"] as const;

    for (const pattern of requiredPatterns) {
      assert.ok(
        replContent.includes(pattern),
        `serverRepl.ts must contain '${pattern}' (P-31 cron tick machinery) — builder adds at Step 4b`,
      );
      assert.ok(
        daemonContent.includes(pattern),
        `serverDaemon.ts must contain '${pattern}' (P-31 cron tick machinery) — builder adds at Step 4b`,
      );
    }
  });
});
