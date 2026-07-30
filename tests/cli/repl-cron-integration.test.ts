// P-10 REPL/cron integration contracts: boot drain and after-operator-turn polling.
// Controlled Pi scripts make ordering, persistence, abort, and schedule state observable.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";
import type { CoreMessage } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { runRepl } from "../../src/cli/repl.js";
import { readSchedule, type ScheduleRecord, writeSchedule } from "../../src/persistence/schedule.js";
import { cleanupTmpDir } from "../_helpers/tmp";
import { appendAssistant, createPiLoopMock } from "./_helpers/piLoopMock.js";

const piLoop = createPiLoopMock();
before(() => piLoop.install());
beforeEach(() => piLoop.reset());
after(() => piLoop.restore());

function makeInertModel(): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    provider: "controlled-test",
    modelId: "unreachable",
    doStream: async () => {
      throw new Error("legacy Vercel model path must remain unreachable");
    },
  });
}

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "frondose-repl-cron-"));
  const prior = process.env.MAI_HOME_BASE;
  process.env.MAI_HOME_BASE = dir;
  mkdirSync(join(dir, ".frondose", "agent"), { recursive: true });
  return {
    dir,
    cleanup: () => {
      if (prior === undefined) delete process.env.MAI_HOME_BASE;
      else process.env.MAI_HOME_BASE = prior;
      cleanupTmpDir(dir);
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeObservedOut(): {
  lines: string[];
  stream: NodeJS.WritableStream;
  firstPrompt: Promise<void>;
  nextPrompt: Promise<void>;
  promptCount: () => number;
} {
  const lines: string[] = [];
  const initialPrompt = deferred();
  const secondPrompt = deferred();
  let prompts = 0;
  const stream = {
    write(chunk: string | Buffer): boolean {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      lines.push(text);
      prompts += text.split("> ").length - 1;
      if (prompts >= 1) initialPrompt.resolve();
      if (prompts >= 2) secondPrompt.resolve();
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return {
    lines,
    stream,
    firstPrompt: initialPrompt.promise,
    nextPrompt: secondPrompt.promise,
    promptCount: () => prompts,
  };
}

function parseSession(path: string): CoreMessage[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CoreMessage);
}

function makeDueRecord(id: string, createdAt: string, task: string): ScheduleRecord {
  return {
    id,
    task,
    cronExpr: "at:2020-01-01T00:00:00.000Z",
    type: "oneshot",
    enabled: true,
    createdAt,
    lastRunAt: null,
    nextRunAt: "2020-01-01T00:00:00.000Z",
  };
}

async function runOneOperatorTurn(opts: {
  schedulePath: string;
  sessionFile: string;
  input: PassThrough;
  output: ReturnType<typeof makeObservedOut>;
  abortController?: AbortController;
}): Promise<void> {
  const repl = runRepl({
    model: makeInertModel(),
    system: "test system",
    messages: [],
    tools: {},
    sessionFile: opts.sessionFile,
    schedulePath: opts.schedulePath,
    in_: opts.input,
    out: opts.output.stream,
    abortController: opts.abortController,
    abortSignal: opts.abortController?.signal,
  });
  await opts.output.firstPrompt;
  opts.input.write("hello\n");
  if (!opts.abortController) {
    await opts.output.nextPrompt;
    opts.input.end();
  }
  await repl;
}

describe("REPL boot-time drain", () => {
  it("T-Drain.1: given schedule.jsonl with 2 due oneshot records at REPL boot, runCronTurn is called exactly twice BEFORE first '> ' prompt, in createdAt-ascending order", async () => {
    // Given: reverse-written A/B due jobs; A succeeds and B aborts
    // When: boot drain runs
    // Then: A then B execute, A is removed, B is retained, and no greeting is written
    const { dir, cleanup } = makeTempDir();
    const input = new PassThrough();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const sessionFile = join(dir, "session.jsonl");
      const a = makeDueRecord("aaaa0001-0000-0000-0000-000000000000", "2026-05-10T08:00:00.000Z", "Task A");
      const b = makeDueRecord("bbbb0002-0000-0000-0000-000000000000", "2026-05-10T09:00:00.000Z", "Task B");
      writeSchedule(schedulePath, [b, a]);
      const abortController = new AbortController();
      const prompts: string[] = [];
      piLoop.queue(
        async (opts) => {
          prompts.push(String(opts.messages.at(-1)?.content));
          appendAssistant(opts, "A done");
        },
        async (opts) => {
          prompts.push(String(opts.messages.at(-1)?.content));
          appendAssistant(opts, "B partial");
          abortController.abort();
        },
      );
      const output = makeObservedOut();
      await runRepl({
        model: makeInertModel(),
        system: "test system",
        messages: [],
        tools: {},
        sessionFile,
        schedulePath,
        in_: input,
        out: output.stream,
        abortController,
        abortSignal: abortController.signal,
      });
      assert.deepEqual(
        prompts.map((text) => text.includes("Task A")),
        [true, false],
      );
      assert.deepEqual(
        prompts.map((text) => text.includes("Task B")),
        [false, true],
      );
      assert.deepEqual(readSchedule(schedulePath), [b], "A is removed while aborted B remains byte-for-byte");
      assert.equal(output.lines.join("").includes("frondose ready"), false);
      piLoop.assertDrained(2);
    } finally {
      input.end();
      cleanup();
    }
  });

  it("T-Drain.2: given schedule.jsonl with 0 records at REPL boot, runCronTurn is NOT called; standard greeting appears unchanged", async () => {
    // Given: an empty schedule and EOF input
    // When: the REPL boots
    // Then: the greeting appears and no Pi turn or cron frame occurs
    const { dir, cleanup } = makeTempDir();
    const input = new PassThrough();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      writeSchedule(schedulePath, []);
      const output = makeObservedOut();
      const repl = runRepl({
        model: makeInertModel(),
        system: "test system",
        messages: [],
        tools: {},
        sessionFile: join(dir, "session.jsonl"),
        schedulePath,
        in_: input,
        out: output.stream,
      });
      input.end();
      await repl;
      assert.match(output.lines.join(""), /frondose ready/);
      assert.doesNotMatch(output.lines.join(""), /\[cron-fired\]/);
      piLoop.assertDrained(0);
    } finally {
      input.end();
      cleanup();
    }
  });

  it("T-Drain.3: given 2 due records and abortController is aborted during cron turn 1, only 1 cron turn fires; REPL exits before 'frondose ready' (D-16 abort propagation)", async () => {
    // Given: two due records and an abort in A
    // When: boot drain begins
    // Then: only A starts, schedule bytes remain identical, and greeting/B are absent
    const { dir, cleanup } = makeTempDir();
    const input = new PassThrough();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const a = makeDueRecord("aaaa0001-0000-0000-0000-000000000000", "2026-05-10T08:00:00.000Z", "Task A");
      const b = makeDueRecord("bbbb0002-0000-0000-0000-000000000000", "2026-05-10T09:00:00.000Z", "Task B");
      writeSchedule(schedulePath, [a, b]);
      const before = readFileSync(schedulePath, "utf-8");
      const abortController = new AbortController();
      piLoop.queue(async (opts) => {
        appendAssistant(opts, "A partial");
        abortController.abort();
      });
      const output = makeObservedOut();
      await runRepl({
        model: makeInertModel(),
        system: "test system",
        messages: [],
        tools: {},
        sessionFile: join(dir, "session.jsonl"),
        schedulePath,
        in_: input,
        out: output.stream,
        abortController,
        abortSignal: abortController.signal,
      });
      const text = output.lines.join("");
      assert.equal((text.match(/\[cron-fired\]/g) ?? []).length, 1);
      assert.equal(text.includes("bbbb0002"), false);
      assert.equal(text.includes("frondose ready"), false);
      assert.equal(readFileSync(schedulePath, "utf-8"), before);
      piLoop.assertDrained(1);
    } finally {
      input.end();
      cleanup();
    }
  });

  it("T-Drain.4: given the schedulePath does not exist on disk, runRepl does NOT throw; drain proceeds as if schedule is empty", async () => {
    // Given: a missing schedule file and EOF input
    // When: the REPL boots
    // Then: it greets normally without a Pi or cron turn
    const { dir, cleanup } = makeTempDir();
    const input = new PassThrough();
    try {
      const schedulePath = join(dir, "missing.jsonl");
      const output = makeObservedOut();
      const repl = runRepl({
        model: makeInertModel(),
        system: "test system",
        messages: [],
        tools: {},
        sessionFile: join(dir, "session.jsonl"),
        schedulePath,
        in_: input,
        out: output.stream,
      });
      input.end();
      await repl;
      assert.equal(existsSync(schedulePath), false);
      assert.match(output.lines.join(""), /frondose ready/);
      assert.doesNotMatch(output.lines.join(""), /\[cron-fired\]/);
      piLoop.assertDrained(0);
    } finally {
      input.end();
      cleanup();
    }
  });
});

describe("REPL after-turn cron poll", () => {
  it("T-Poll.1: given a due oneshot record is written to schedule.jsonl during the operator turn, after the turn completes, poll fires runCronTurn AND [cron-fired] appears before the next '> ' prompt", async () => {
    // Given: the operator turn creates one due job
    // When: after-turn polling runs
    // Then: operator state is persisted before cron, final tail is exact, and schedule empties
    const { dir, cleanup } = makeTempDir();
    const input = new PassThrough();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const sessionFile = join(dir, "session.jsonl");
      writeSchedule(schedulePath, []);
      const due = makeDueRecord("poll1111-0000-0000-0000-000000000000", "2026-05-10T08:00:00.000Z", "Poll task");
      piLoop.queue(
        async (opts) => {
          writeSchedule(schedulePath, [due]);
          appendAssistant(opts, "operator done");
        },
        async (opts) => {
          assert.deepEqual(parseSession(sessionFile), [
            { role: "user", content: "hello" },
            { role: "assistant", content: "operator done" },
          ]);
          appendAssistant(opts, "cron done");
        },
      );
      const output = makeObservedOut();
      await runOneOperatorTurn({ schedulePath, sessionFile, input, output });
      const final = parseSession(sessionFile);
      assert.deepEqual(final.slice(0, 2), [
        { role: "user", content: "hello" },
        { role: "assistant", content: "operator done" },
      ]);
      assert.equal(final.length, 4);
      assert.match(String(final[2]?.content), /CRON_RUN_ID=.*Poll task/s);
      assert.deepEqual(final[3], { role: "assistant", content: "cron done" });
      assert.deepEqual(readSchedule(schedulePath), []);
      assert.equal((output.lines.join("").match(/poll1111/g) ?? []).length, 1);
      piLoop.assertDrained(2);
    } finally {
      input.end();
      cleanup();
    }
  });

  it("T-Poll.2: given schedule.jsonl is empty and no mutation occurs during the turn, after-turn poll does NOT call runCronTurn; next prompt appears normally", async () => {
    // Given: an empty schedule
    // When: one operator turn completes
    // Then: exactly one Pi call and two prompts occur with no cron output
    const { dir, cleanup } = makeTempDir();
    const input = new PassThrough();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      writeSchedule(schedulePath, []);
      piLoop.queue(async (opts) => appendAssistant(opts, "operator done"));
      const output = makeObservedOut();
      await runOneOperatorTurn({ schedulePath, sessionFile: join(dir, "session.jsonl"), input, output });
      assert.equal(output.promptCount(), 2);
      assert.doesNotMatch(output.lines.join(""), /\[cron-fired\]|CRON_RUN_ID/);
      piLoop.assertDrained(1);
    } finally {
      input.end();
      cleanup();
    }
  });

  it("T-Poll.3: given 2 due oneshot records appear mid-turn and abortController is aborted during cron turn 1 in poll, poll exits early and REPL breaks for-await loop (D-16)", async () => {
    // Given: the operator creates A/B and A aborts during polling
    // When: after-turn polling runs
    // Then: operator tail persists, both schedule records remain byte-identical, and B never starts
    const { dir, cleanup } = makeTempDir();
    const input = new PassThrough();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      const sessionFile = join(dir, "session.jsonl");
      writeSchedule(schedulePath, []);
      const a = makeDueRecord("poll3aaa-0000-0000-0000-000000000000", "2026-05-10T08:00:00.000Z", "Poll3 A");
      const b = makeDueRecord("poll3bbb-0000-0000-0000-000000000000", "2026-05-10T09:00:00.000Z", "Poll3 B");
      const abortController = new AbortController();
      let dueBytes = "";
      piLoop.queue(
        async (opts) => {
          writeSchedule(schedulePath, [a, b]);
          dueBytes = readFileSync(schedulePath, "utf-8");
          appendAssistant(opts, "operator done");
        },
        async (opts) => {
          assert.deepEqual(parseSession(sessionFile), [
            { role: "user", content: "hello" },
            { role: "assistant", content: "operator done" },
          ]);
          appendAssistant(opts, "A partial");
          abortController.abort();
        },
      );
      const output = makeObservedOut();
      const repl = runRepl({
        model: makeInertModel(),
        system: "test system",
        messages: [],
        tools: {},
        sessionFile,
        schedulePath,
        in_: input,
        out: output.stream,
        abortController,
        abortSignal: abortController.signal,
      });
      await output.firstPrompt;
      input.write("hello\n");
      await repl;
      assert.deepEqual(parseSession(sessionFile), [
        { role: "user", content: "hello" },
        { role: "assistant", content: "operator done" },
      ]);
      assert.equal(readFileSync(schedulePath, "utf-8"), dueBytes);
      assert.equal((output.lines.join("").match(/\[cron-fired\]/g) ?? []).length, 1);
      assert.equal(output.lines.join("").includes("poll3bbb"), false);
      piLoop.assertDrained(2);
    } finally {
      input.end();
      cleanup();
    }
  });

  it("T-Poll.4: given a due oneshot record is written during operator turn, after-turn poll fires it exactly once; schedule.jsonl empty after (record removed, writeSchedule called)", async () => {
    // Given: the operator creates one overdue one-shot job
    // When: after-turn polling completes
    // Then: exactly one target cron frame fires, exactly two Pi calls occur, and schedule empties
    const { dir, cleanup } = makeTempDir();
    const input = new PassThrough();
    try {
      const schedulePath = join(dir, "schedule.jsonl");
      writeSchedule(schedulePath, []);
      const due = makeDueRecord("poll4444-0000-0000-0000-000000000000", "2020-01-01T00:00:00.000Z", "Poll4 task");
      piLoop.queue(
        async (opts) => {
          writeSchedule(schedulePath, [due]);
          appendAssistant(opts, "operator done");
        },
        async (opts) => appendAssistant(opts, "cron done"),
      );
      const output = makeObservedOut();
      await runOneOperatorTurn({ schedulePath, sessionFile: join(dir, "session.jsonl"), input, output });
      assert.equal((output.lines.join("").match(/poll4444/g) ?? []).length, 1);
      assert.equal((output.lines.join("").match(/\[cron-fired\]/g) ?? []).length, 1);
      assert.deepEqual(readSchedule(schedulePath), []);
      piLoop.assertDrained(2);
    } finally {
      input.end();
      cleanup();
    }
  });
});
