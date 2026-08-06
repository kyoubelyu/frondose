import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createCronDriver } from "../../../../src/app/backend/cron.js";
import { readSchedule, type ScheduleRecord } from "../../../../src/persistence/schedule.js";

type MockRecord = Record<string, unknown>;

interface ErrorFrame {
  type: "error";
  message?: string;
  retryable?: boolean;
}

function isErrorFrame(frame: unknown): frame is ErrorFrame {
  return typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "error";
}

function writeMalformedDueSchedule(schedulePath: string): { fireDateIso: string; jobId: string } {
  const jobId = randomUUID();
  const fireDateIso = new Date(Date.now() - 1000).toISOString();
  const record: ScheduleRecord = {
    id: jobId,
    task: "[AUTO_CONNECTS=0] [AUTO_DURATION=1] malformed mark-ran safety test",
    cronExpr: "0 9 * * 1-5",
    type: "recurring",
    nextRunAt: fireDateIso,
    lastRunAt: null,
    createdAt: new Date(Date.now() - 60000).toISOString(),
    enabled: true,
  };
  writeFileSync(schedulePath, `${JSON.stringify(record)}\n`);
  return { fireDateIso, jobId };
}

function makeMockState(extra: Partial<MockRecord> = {}): MockRecord {
  return {
    cronEnabled: true,
    currentTurn: null,
    overlayContextId: undefined,
    unsubscribeContextId: undefined,
    unsubscribeOverlayEvents: undefined,
    passiveEnabled: false,
    lastTurnUserPrompt: null,
    lastFailedTurnPrompt: null,
    retryAttempts: 0,
    messages: [],
    passiveProfileCache: new Map(),
    passiveLimiter: { check: () => ({ allowed: true }) },
    sseClients: new Set(),
    autoRunId: null,
    lastEmittedAutoCounters: null,
    cronNoProgressRunId: null,
    cronNoProgressTurns: 0,
    ...extra,
  };
}

function makeMockDeps(schedulePath: string, salesDbPath: string, emittedFrames: unknown[]): MockRecord {
  return {
    model: null,
    system: "test-system",
    systemResume: "test-resume",
    tools: {},
    maxSteps: 200,
    auditWriter: { write: () => {} },
    session: { getClient: () => null, getOrInitClient: async () => ({ ok: false }) },
    schedulePath,
    salesDbPath,
    auditPath: "/dev/null",
    expectedToken: Buffer.from("test"),
    workflow: { handleEndpoint: () => ({ status: 200, response: { ok: true } }) },
    emitFrame: (frame: unknown) => {
      emittedFrames.push(frame);
    },
    emitOverlayEvent: () => {},
  };
}

describe("cron mark-ran fail-safe — malformed schedules fire at most once", () => {
  it("T-CronOneShot.11: when markRan throws after a successful cron turn, tick disables the job and emits a non-retryable error", async () => {
    // Given/When/Then: a due recurring job with an unsupported cron token runs once, then the fail-safe writes enabled=false.
    const salesDbPath = join(tmpdir(), `cron-markran-failsafe-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-markran-failsafe-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();
    const { fireDateIso, jobId } = writeMalformedDueSchedule(schedulePath);
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
    const turn = { runOneTurn: async () => {} };

    const driver = createCronDriver(
      state as Parameters<typeof createCronDriver>[0],
      deps as Parameters<typeof createCronDriver>[1],
      turn as Parameters<typeof createCronDriver>[2],
    );
    await driver.tick();

    const records = readSchedule(schedulePath);
    assert.equal(records.length, 1, "failed mark-ran job must remain present but disabled");
    assert.equal(records[0]?.id, jobId);
    assert.equal(records[0]?.enabled, false);
    assert.equal(records[0]?.lastRunAt, fireDateIso);

    const errorFrames = emittedFrames.filter(isErrorFrame);
    assert.equal(errorFrames.length, 1, "must emit exactly one mark-ran fail-safe error frame");
    assert.equal(errorFrames[0]?.retryable, false);
    assert.ok(errorFrames[0]?.message?.includes(`cron mark-ran failed; job ${jobId} disabled:`));
  });
});
