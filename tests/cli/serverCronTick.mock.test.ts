/**
 * Server cron tick behavioral coverage (T-TICK.*)
 *
 * Gate coverage:
 *   G-P31.9  — T-TICK.1 (SERVER_SCHEDULE_PATH resolves correctly)
 *   G-P31.10 — T-TICK.2 (drainDueJobs fires runCronTurn for a due job)
 *              T-TICK.3 (structural: serverRepl + serverDaemon contain tick machinery)
 *
 * `drainDueJobs` is called directly with a temporary schedule path and
 * controlled Pi-backed `RunCronTurnDeps`.
 *
 * P-BACKGROUND-SKIP-CLOSURE replaces the retired Vercel model scaffold with
 * a fail-closed controlled Pi seam before activating T-TICK.2.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { drainDueJobs, type RunCronTurnDeps } from "../../src/cli/replCron.js";
import type { ScheduleRecord } from "../../src/persistence/schedule.js";
import { computeCronRunId, readSchedule, writeSchedule } from "../../src/persistence/schedule.js";
import { SERVER_SCHEDULE_PATH } from "../../src/persistence/serverPaths.js";
import { loadMessages } from "../../src/persistence/session.js";
import { cleanupTmpDir } from "../_helpers/tmp";
import { appendAssistant, createPiLoopMock } from "./_helpers/piLoopMock.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p31-tick-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

const SRC_ROOT = fileURLToPath(new URL("../../src", import.meta.url));
const piLoop = createPiLoopMock();
before(() => piLoop.install());
beforeEach(() => piLoop.reset());
after(() => piLoop.restore());

// ─── T-TICK.1 ─────────────────────────────────────────────────────────────────

describe("SERVER_SCHEDULE_PATH resolves correctly (G-P31.9)", () => {
  it("T-TICK.1: SERVER_SCHEDULE_PATH() resolves to '~/.frondose/server/schedule.jsonl'", () => {
    // Given:  current SERVER_SCHEDULE_PATH from src/persistence/serverPaths.ts
    // When:   SERVER_SCHEDULE_PATH() called
    // Then:   result equals '~/.frondose/server/schedule.jsonl'

    const p = SERVER_SCHEDULE_PATH();
    const expected = join(homedir(), ".frondose", "server", "schedule.jsonl");
    assert.equal(p, expected, `SERVER_SCHEDULE_PATH() must equal '${expected}'; got '${p}'`);
  });
});

// ─── T-TICK.2 ─────────────────────────────────────────────────────────────────

describe("drainDueJobs fires runCronTurn for a due job (G-P31.10)", () => {
  it("T-TICK.2: a due recurring server job runs exactly once through Pi, persists the exact turn delta, and advances its schedule", async () => {
    // Given:  tmp schedule.jsonl with 1 recurring record whose nextRunAt is in the past
    //         + controlled Pi script and captured messages/session
    // When:   drainDueJobs(schedulePath, abortSignal, deps)
    // Then:   exactly one Pi call sees the exact prompt; user+assistant persist in order;
    //         readSchedule shows exact lastRunAt and a future nextRunAt

    const { dir, cleanup } = makeTmpDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");

      // Pick a day exactly 14 days away (within 1..28), so the prior monthly
      // occurrence is due and the next one has a stable two-week margin.
      const now = new Date();
      const targetDay = now.getDate() <= 14 ? now.getDate() + 14 : now.getDate() - 14;
      const futureTarget =
        now.getDate() <= 14
          ? new Date(now.getFullYear(), now.getMonth(), targetDay, 0, 0, 0, 0)
          : new Date(now.getFullYear(), now.getMonth() + 1, targetDay, 0, 0, 0, 0);
      const fireDate = new Date(futureTarget.getFullYear(), futureTarget.getMonth() - 1, targetDay, 0, 0, 0, 0);
      const pastDate = fireDate.toISOString();
      const dueRecord: ScheduleRecord = {
        id: "tick-test-1",
        task: "check fleet status",
        cronExpr: `0 0 ${targetDay} * *`,
        type: "recurring",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastRunAt: null,
        nextRunAt: pastDate,
      };
      writeSchedule(schedulePath, [dueRecord]);

      const captureStream = {
        write: (_chunk: unknown) => true,
      };

      const mockDeps: RunCronTurnDeps = {
        model: {} as RunCronTurnDeps["model"],
        system: "test system",
        messages: [],
        tools: {},
        sessionFile: join(dir, "session.jsonl"),
        abortSignal: undefined,
        onStepFinish: undefined,
        out: captureStream as unknown as NodeJS.WritableStream,
      };
      const expectedPrompt = `[TIME 00:00]\n[CRON_RUN_ID=${computeCronRunId(dueRecord, fireDate)}]\n(scheduled task: "check fleet status")`;
      piLoop.queue(async (opts) => {
        const userMessages = opts.messages.filter((message) => message.role === "user");
        assert.equal(userMessages.length, 1, "cron loop must receive exactly one user message");
        assert.equal(userMessages[0]?.content, expectedPrompt, "cron prompt must be deterministic from fireDate + id");
        appendAssistant(opts, "checked fleet");
      });

      await drainDueJobs(schedulePath, undefined, mockDeps);
      piLoop.assertDrained(1);

      // mockDeps.messages must contain exactly the controlled cron user turn.
      const cronUserTurns = mockDeps.messages.filter(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("[CRON_RUN_ID="),
      );
      assert.equal(cronUserTurns.length, 1, "messages must include exactly one cron user turn");
      assert.equal(mockDeps.messages.filter((message) => message.role === "assistant").length, 1);
      assert.deepEqual(loadMessages(mockDeps.sessionFile), [
        { role: "user", content: expectedPrompt },
        { role: "assistant", content: "checked fleet" },
      ]);

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
      assert.equal(updatedRec.lastRunAt, pastDate, "lastRunAt must equal the scheduled fire time");
      assert.ok(new Date(updatedRec.nextRunAt).getTime() > fireDate.getTime(), "nextRunAt must move beyond fireDate");
      assert.equal(updatedRec.nextRunAt, futureTarget.toISOString(), "nextRunAt must equal the two-week-away target");
    } finally {
      cleanup();
    }
  });
});

// ─── T-TICK.3 ─────────────────────────────────────────────────────────────────

describe("serverRepl + serverDaemon contain cron tick machinery (G-P31.10 structural)", () => {
  it("T-TICK.3: serverRepl and serverDaemon retain boot drain plus a 60-second unref cron tick inside turnLock", () => {
    // Given:  current src/cli/serverRepl.ts + src/cli/serverDaemon.ts
    // When:   reading file contents as strings
    // Then:   each file contains 'drainDueJobs', 'setInterval', '60_000', 'unref()',
    //         and 'turnLock.run' — the structural markers of the P-31 tick pattern

    const serverReplPath = join(SRC_ROOT, "cli", "serverRepl.ts");
    const serverDaemonPath = join(SRC_ROOT, "cli", "serverDaemon.ts");

    const replContent = readFileSync(serverReplPath, "utf-8");
    const daemonContent = readFileSync(serverDaemonPath, "utf-8");

    const requiredPatterns = ["drainDueJobs", "setInterval", "60_000", ".unref()", "turnLock.run"] as const;

    for (const pattern of requiredPatterns) {
      assert.ok(replContent.includes(pattern), `serverRepl.ts must retain '${pattern}' (P-31 cron tick machinery)`);
      assert.ok(daemonContent.includes(pattern), `serverDaemon.ts must retain '${pattern}' (P-31 cron tick machinery)`);
    }
  });
});
