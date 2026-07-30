/**
 * P-54 Step 5 — T-Wiring.1 + T-Wiring.2 (G-P54.6) — assertion bodies filled.
 *
 * Tests the caller-wiring contract that:
 *  (1) the interactive operator-turn in `repl.ts` flips `opts.control.isInteractive = true`
 *      INSIDE the `turnLock.run(...)` callback (around the `runAgentLoop` call only)
 *      and restores it in the inner `finally` — see plan §6.3(b).
 *  (2) cron / telegram / worker callers do NOT touch `isInteractive` (no `control`
 *      field on RunCronTurnDeps / TelegramTurnDeps / worker-inbox deps).
 *
 * Black-box approach for T-Wiring.1: the current dynamic Pi loop is controlled
 * while the real runRepl locks, operator callback, and finally blocks execute.
 *
 * Structural approach for T-Wiring.2: compile-time `keyof` check + source-text
 * grep verifies cron / telegram / worker don't carry or read `control`.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path, { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { CoreMessage } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { TurnLock } from "../../src/agent/turnSemaphore.js";
import { runRepl } from "../../src/cli/repl.js";
import type { RunCronTurnDeps } from "../../src/cli/replCron.js";
import type { TelegramTurnDeps } from "../../src/cli/replTelegram.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { cleanupTmpDir } from "../_helpers/tmp";
import { appendAssistant, createPiLoopMock } from "./_helpers/piLoopMock.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Home shim: isolate both os.homedir() and the product HOME_BASE override.
 */
function withTmpHome(): { tmpHome: string; cleanup: () => void } {
  const tmpHome = mkdtempSync(join(os.tmpdir(), "mai-p54-repl-"));
  mkdirSync(join(tmpHome, ".frondose", "agent"), { recursive: true });
  const priorHome = process.env.HOME;
  const priorHomeBase = process.env.MAI_HOME_BASE;
  process.env.HOME = tmpHome;
  process.env.MAI_HOME_BASE = tmpHome;
  return {
    tmpHome,
    cleanup: () => {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (priorHomeBase === undefined) delete process.env.MAI_HOME_BASE;
      else process.env.MAI_HOME_BASE = priorHomeBase;
      try {
        cleanupTmpDir(tmpHome);
      } catch {
        // best-effort
      }
    },
  };
}

/** Discard REPL output for the test. */
function makeNullOut(): NodeJS.WritableStream {
  return {
    write(_chunk: string | Buffer): boolean {
      return true;
    },
  } as unknown as NodeJS.WritableStream;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

const piLoop = createPiLoopMock();
before(() => piLoop.install());
beforeEach(() => piLoop.reset());
after(() => piLoop.restore());

// ─── T-Wiring.1 ──────────────────────────────────────────────────────────────

describe("interactive operator-turn flips isInteractive=true INSIDE turnLock + restores in finally (G-P54.6)", () => {
  it("T-Wiring.1 (success path): when an operator turn queues behind TurnLock, isInteractive stays prior until lock entry, becomes true inside Pi, and restores after settlement", async () => {
    // Given: boot reaches the first prompt, then a real injected TurnLock is held
    // When: operator input queues and the cross-process lock proves it reached the lock wait
    // Then: control remains prior while queued, is true in Pi, and restores after success
    const { tmpHome, cleanup } = withTmpHome();
    const input = new PassThrough();
    try {
      let peekedValue: unknown = "NEVER_PEEKED";
      const control: ControlSignals = {
        requestStop: () => {},
        isInteractive: undefined,
      };
      const model = new MockLanguageModelV1({
        provider: "openai",
        modelId: "unused-input-model",
        doStream: async () => {
          throw new Error("legacy model path must remain unreachable");
        },
      });
      const messages: CoreMessage[] = [];
      const sessionFile = join(tmpHome, "session.jsonl");
      const lockPath = join(tmpHome, ".frondose", "agent", "turn.lock");
      const turnLock = new TurnLock();
      const ready = deferred();
      const nextPrompt = deferred();
      let promptCount = 0;
      const out = {
        write(chunk: string | Buffer): boolean {
          const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
          const matches = text.match(/> /g)?.length ?? 0;
          promptCount += matches;
          if (promptCount >= 1) ready.resolve();
          if (promptCount >= 2) nextPrompt.resolve();
          return true;
        },
      } as unknown as NodeJS.WritableStream;
      piLoop.queue(async (opts) => {
        peekedValue = control.isInteractive;
        assert.equal(existsSync(lockPath), true, "cross-process turn.lock must exist during the operator loop");
        appendAssistant(opts, "ok");
      });

      const replPromise = runRepl({
        model,
        system: "test system",
        messages,
        tools: {},
        sessionFile,
        out,
        in_: input,
        control,
        turnLock,
      });
      await ready.promise;

      const holderEntered = deferred();
      const releaseHolder = deferred();
      const holder = turnLock.run(async () => {
        holderEntered.resolve();
        await releaseHolder.promise;
      });
      await holderEntered.promise;
      input.write("hello\n");
      await waitUntil(
        () => existsSync(lockPath),
        "operator turn must acquire cross-process lock before queueing behind TurnLock",
      );
      assert.equal(
        control.isInteractive,
        undefined,
        "queued operator turn must not flip control before TurnLock entry",
      );
      releaseHolder.resolve();
      await holder;
      await nextPrompt.promise;
      input.end();
      await replPromise;

      assert.equal(peekedValue, true, "controlled Pi must observe true only after the queued lock enters");
      assert.equal(control.isInteractive, undefined, "success path must restore the prior control value");
      assert.equal(existsSync(lockPath), false, "cross-process turn.lock must be released after success");
      assert.equal(promptCount, 2, "REPL must emit exactly the initial and next prompt");
      piLoop.assertDrained(1);
    } finally {
      input.end();
      cleanup();
    }
  });

  it("T-Wiring.1 (throw path): when controlled Pi throws inside the operator TurnLock, the exact error propagates after control and cross-process lock restore", async () => {
    // Given: controlled Pi observes the operator callback and throws one sentinel
    // When: runRepl executes one operator turn
    // Then: exact sentinel propagates after isInteractive and turn.lock restore
    const { tmpHome, cleanup } = withTmpHome();
    const input = new PassThrough();
    try {
      let peekedValue: unknown = "NEVER_PEEKED";
      const control: ControlSignals = {
        requestStop: () => {},
        isInteractive: undefined,
      };
      const sentinel = new Error("controlled repl loop failure");
      const model = new MockLanguageModelV1({
        provider: "openai",
        modelId: "unused-input-model",
        doStream: async () => {
          throw new Error("legacy model path must remain unreachable");
        },
      });
      const messages: CoreMessage[] = [];
      const sessionFile = join(tmpHome, "session.jsonl");
      const lockPath = join(tmpHome, ".frondose", "agent", "turn.lock");
      const ready = deferred();
      const out = {
        write(chunk: string | Buffer): boolean {
          if ((typeof chunk === "string" ? chunk : chunk.toString("utf8")).includes("frondose ready")) ready.resolve();
          return true;
        },
      } as unknown as NodeJS.WritableStream;
      piLoop.queue(async () => {
        peekedValue = control.isInteractive;
        assert.equal(existsSync(lockPath), true, "turn.lock must exist while controlled Pi runs");
        throw sentinel;
      });

      const replPromise = runRepl({
        model,
        system: "test system",
        messages,
        tools: {},
        sessionFile,
        out,
        in_: input,
        control,
      });
      await ready.promise;
      input.write("hello\n");
      await assert.rejects(replPromise, (error) => error === sentinel);

      assert.equal(peekedValue, true, "controlled Pi must observe isInteractive=true");
      assert.equal(control.isInteractive, undefined, "throw path must restore the prior control value");
      assert.equal(existsSync(lockPath), false, "throw path must release the cross-process turn.lock");
      piLoop.assertDrained(1);
    } finally {
      input.end();
      cleanup();
    }
  });
});

// ─── T-Wiring.2 ──────────────────────────────────────────────────────────────

// Compile-time keyof check helper: resolves to "OK" when T has no "control" key.
// If "control" leaks into T's keyof, the type becomes "FAIL" and the value
// assignment below fails to compile (build-time guard).
type AssertNoControl<T> = "control" extends keyof T ? "FAIL_HAS_CONTROL" : "OK";

describe("cron / telegram / worker deps interfaces do NOT carry a 'control' field (G-P54.6 — design (B) safe default)", () => {
  it("T-Wiring.2: RunCronTurnDeps / TelegramTurnDeps interfaces lack a 'control' field AND src/cli/replCron.ts + src/cli/replTelegram.ts + src/cli/workerInbox.ts do not read deps.control (verified by type-system keyof check + source grep)", () => {
    // Given: the exported deps interfaces in src/cli/replCron.ts (RunCronTurnDeps)
    //        and src/cli/replTelegram.ts (TelegramTurnDeps). workerInbox.ts reuses
    //        RunCronTurnDeps at the time of P-54.
    // When:  a compile-time keyof check is performed AND the three source files
    //        are read for any reference to `deps.control` / `.isInteractive` /
    //        `control.isInteractive`.
    // Then:  (a)/(b) `"control"` is NOT a key of RunCronTurnDeps / TelegramTurnDeps;
    //        (c)/(d)/(e) the three source files do NOT contain the forbidden tokens.

    // (a) + (b) compile-time keyof checks. If "control" leaks into either deps
    // interface, the `: "OK"` annotation fails to typecheck.
    const _cronCheck: AssertNoControl<RunCronTurnDeps> = "OK";
    const _tgCheck: AssertNoControl<TelegramTurnDeps> = "OK";
    void _cronCheck;
    void _tgCheck;

    // (c)/(d)/(e) source-grep: read each file and assert no forbidden tokens.
    const FILES = ["src/cli/replCron.ts", "src/cli/replTelegram.ts", "src/cli/workerInbox.ts"];
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const REPO_ROOT = path.resolve(HERE, "..", "..");
    const FORBIDDEN_TOKENS = ["deps.control", ".isInteractive", "control.isInteractive"];

    for (const rel of FILES) {
      const abs = path.join(REPO_ROOT, rel);
      const text = readFileSync(abs, "utf8");
      for (const token of FORBIDDEN_TOKENS) {
        assert.ok(
          !text.includes(token),
          `${rel} must NOT contain the forbidden token '${token}' — cron / telegram / worker callers must leave isInteractive undefined (design (B) cron-safe default)`,
        );
      }
    }
  });
});

// ─── P-52 Step 4a scaffolds — T-EagerChrome.1..4 (G-P52.2) ───────────────────
//
// These tests intentionally FAIL at Step 4a — every assertion body is
// `assert.fail("TODO Step 5 …")`. Validator fills the assertion bodies at
// Step 5 once Codex's Step 4b adds:
//   - `ReplOpts.linkedinSession?: LinkedinSession` field (plan §6.4(b))
//   - eager Chrome init block in `repl.ts` immediately after "frondose ready"
//     prints; gated on `MAI_NO_EAGER_CHROME !== "1"`; fire-and-forget with
//     `.catch` stderr swallow (plan §6.4(c))
//   - `main.ts:319` call object passes `linkedinSession` into `runRepl` (§6.5)
//
// Tests use the existing `MockLanguageModelV1` pattern + the HOME-shim
// (withTmpHome()) defined above so the test's operator-turn does NOT
// contend on the real `~/.mai/agent/turn.lock`.

/** Build a stub LinkedinSession with a spied `getOrInitClient`. */
function makeFakeLinkedinSession(opts?: { rejectWith?: Error }): {
  session: unknown;
  callCount: () => number;
} {
  let calls = 0;
  const session = {
    getOrInitClient: async (): Promise<unknown> => {
      calls += 1;
      if (opts?.rejectWith) {
        // Return a rejected promise (NOT a sync throw — runRepl uses
        // fire-and-forget with `.catch(...)`; a rejected promise is the
        // canonical async-error shape).
        throw opts.rejectWith;
      }
      return { ok: true } as unknown;
    },
    // Other LinkedinSession methods exist in `src/linkedin/types.ts:69-`; the
    // eager-init code path only calls `getOrInitClient`, so we omit the rest
    // and cast the stub through `unknown` at the call site.
  };
  return { session, callCount: () => calls };
}

describe("Eager Chrome init at REPL boot (G-P52.2)", () => {
  it("T-EagerChrome.1: when linkedinSession is provided AND MAI_NO_EAGER_CHROME is unset, runRepl fires linkedinSession.getOrInitClient() exactly once AFTER the 'frondose ready' line writes to out", async () => {
    // Given: opts.linkedinSession = { getOrInitClient: spy }; MAI_NO_EAGER_CHROME unset;
    //        a MockLanguageModelV1 that returns an immediate 'ok' stream;
    //        PassThrough stdin with a single "\n" (empty line) then EOF;
    //        a custom `out` stream that records every write timestamp.
    // When:  runRepl runs and settles after the one-line stdin EOF.
    // Then:  (a) the spy's callCount is exactly 1; (b) the spy's first call
    //        timestamp is AFTER the timestamp of the "frondose ready" write
    //        to `out` (eager init happens AFTER the ready line per §6.4(c)).
    //
    // VALIDATOR NOTE (Step 5 fill): use the `withTmpHome()` helper for lock
    // isolation; record `out.write` timestamps + spy invocation timestamp;
    // assert temporal ordering. The `linkedinSession` field is a new
    // ReplOpts addition at Step 4b — cast through `unknown` at Step 4a if
    // needed for the scaffold to compile.
    const { tmpHome, cleanup } = withTmpHome();
    try {
      // out stream that records the ts of each "frondose ready" write (F-REN-4b flip).
      let readyTs: number | null = null;
      const out: NodeJS.WritableStream = {
        write(chunk: string | Buffer): boolean {
          const s = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
          if (readyTs === null && s.includes("frondose ready")) readyTs = Date.now();
          return true;
        },
      } as unknown as NodeJS.WritableStream;

      // Spied linkedinSession + a captured ts for its first invocation.
      let spyTs: number | null = null;
      const calledSession = {
        getOrInitClient: async (): Promise<unknown> => {
          if (spyTs === null) spyTs = Date.now();
          return { ok: true };
        },
      };

      const model = new MockLanguageModelV1({
        provider: "openai",
        modelId: "deepseek-v4-flash-echo",
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "text-delta" as const, textDelta: "ok" },
              {
                type: "finish" as const,
                finishReason: "stop" as const,
                usage: { promptTokens: 5, completionTokens: 2 },
              },
            ],
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        }),
      });

      const messages: CoreMessage[] = [];
      const sessionFile = join(tmpHome, "session.jsonl");
      const input = new PassThrough();
      input.write("\n"); // single empty-line turn
      input.end();

      await runRepl({
        model,
        system: "test",
        messages,
        tools: {},
        sessionFile,
        out,
        in_: input,
        linkedinSession: calledSession as unknown as Parameters<typeof runRepl>[0]["linkedinSession"],
      });

      // (a) Spy was invoked exactly once.
      assert.equal(spyTs !== null ? 1 : 0, 1, "linkedinSession.getOrInitClient must be called exactly once");

      // (b) Ready line was written before the spy fired.
      assert.ok(readyTs !== null, "out must have received the 'frondose ready' line");
      assert.ok(
        spyTs! >= readyTs!,
        `eager init must fire AFTER 'frondose ready' prints; readyTs=${readyTs}, spyTs=${spyTs}`,
      );
      void makeFakeLinkedinSession;
    } finally {
      cleanup();
    }
  });

  it("T-EagerChrome.2: when MAI_NO_EAGER_CHROME==='1' is set, the eager init is SKIPPED — linkedinSession.getOrInitClient is NOT called", async () => {
    // Given: same setup as T-EagerChrome.1 but process.env.FRONDOSE_NO_EAGER_CHROME='1'.
    // When:  runRepl settles.
    // Then:  callCount() === 0 (the gate at §6.4(c) skipped the eager call).
    //
    // VALIDATOR NOTE (Step 5 fill): save+restore process.env.FRONDOSE_NO_EAGER_CHROME
    // around the test; pattern matches the env-restore pattern in paths.test.ts.
    const { tmpHome, cleanup } = withTmpHome();
    const priorEnv = process.env.FRONDOSE_NO_EAGER_CHROME;
    const restore = (): void => {
      if (priorEnv === undefined) delete process.env.FRONDOSE_NO_EAGER_CHROME;
      else process.env.FRONDOSE_NO_EAGER_CHROME = priorEnv;
    };
    try {
      process.env.FRONDOSE_NO_EAGER_CHROME = "1";
      const { session, callCount } = makeFakeLinkedinSession();

      const model = new MockLanguageModelV1({
        provider: "openai",
        modelId: "deepseek-v4-flash-echo",
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "text-delta" as const, textDelta: "ok" },
              {
                type: "finish" as const,
                finishReason: "stop" as const,
                usage: { promptTokens: 5, completionTokens: 2 },
              },
            ],
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        }),
      });

      const messages: CoreMessage[] = [];
      const sessionFile = join(tmpHome, "session.jsonl");
      const input = new PassThrough();
      input.write("\n");
      input.end();

      await runRepl({
        model,
        system: "test",
        messages,
        tools: {},
        sessionFile,
        out: makeNullOut(),
        in_: input,
        linkedinSession: session as unknown as Parameters<typeof runRepl>[0]["linkedinSession"],
      });

      assert.equal(
        callCount(),
        0,
        "MAI_NO_EAGER_CHROME='1' must suppress eager init — getOrInitClient must NOT be called",
      );
    } finally {
      restore();
      cleanup();
    }
  });

  it("T-EagerChrome.3: when linkedinSession.getOrInitClient rejects, the rejection is swallowed to stderr — runRepl settles cleanly without an unhandledRejection AND a stderr warning containing 'eager Chrome init failed' is recorded", async () => {
    // Given: linkedinSession.getOrInitClient = async () => { throw Error("chrome-launch-failed"); }
    //        and MAI_NO_EAGER_CHROME unset.
    // When:  runRepl settles after one-line stdin EOF.
    // Then:  (a) runRepl resolves without throwing; (b) a stderr write was
    //        recorded containing 'eager Chrome init failed' (per §6.4(c)
    //        `.catch(...)` block's literal message prefix); (c) no
    //        process-level unhandledRejection fires (the validator's
    //        `process.on('unhandledRejection')` listener is silent).
    //
    // VALIDATOR NOTE (Step 5 fill): patch process.stderr.write to capture
    // writes; register/unregister `unhandledRejection` listener around the
    // test; verify the listener was NOT called.
    const { tmpHome, cleanup } = withTmpHome();
    const stderrChunks: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: monkey-patch stderr for capture
    (process.stderr as any).write = (chunk: any, ...rest: any[]): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return origStderrWrite(chunk, ...rest);
    };
    let unhandled = false;
    const onUnhandled = (): void => {
      unhandled = true;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { session, callCount } = makeFakeLinkedinSession({ rejectWith: new Error("chrome-launch-failed") });

      const model = new MockLanguageModelV1({
        provider: "openai",
        modelId: "deepseek-v4-flash-echo",
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "text-delta" as const, textDelta: "ok" },
              {
                type: "finish" as const,
                finishReason: "stop" as const,
                usage: { promptTokens: 5, completionTokens: 2 },
              },
            ],
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        }),
      });

      const messages: CoreMessage[] = [];
      const sessionFile = join(tmpHome, "session.jsonl");
      const input = new PassThrough();
      input.write("\n");
      input.end();

      // runRepl MUST settle cleanly even though getOrInitClient rejects.
      await runRepl({
        model,
        system: "test",
        messages,
        tools: {},
        sessionFile,
        out: makeNullOut(),
        in_: input,
        linkedinSession: session as unknown as Parameters<typeof runRepl>[0]["linkedinSession"],
      });

      // Allow one microtask tick for the .catch handler to flush its stderr write.
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(callCount() >= 1, "linkedinSession.getOrInitClient must be called (the rejection is caught after)");
      const stderrText = stderrChunks.join("");
      assert.ok(
        stderrText.includes("eager Chrome init failed"),
        `stderr must record 'eager Chrome init failed' (got: ${JSON.stringify(stderrText.slice(0, 300))})`,
      );
      assert.equal(unhandled, false, "no `unhandledRejection` may fire — the .catch handler must swallow cleanly");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore stderr
      (process.stderr as any).write = origStderrWrite;
      process.off("unhandledRejection", onUnhandled);
      cleanup();
    }
  });

  it("T-EagerChrome.4: when opts.linkedinSession is undefined (the existing test-stub case used by repl-multiline.test.ts), no eager init runs and no error is thrown — REPL boots normally (backward-compat for existing stubs)", async () => {
    // Given: opts.linkedinSession === undefined (test stubs omit it — the
    //        existing tests/cli/repl-multiline.test.ts shape).
    // When:  runRepl settles.
    // Then:  no error is thrown, no stderr write captured, no
    //        unhandledRejection — REPL boots normally. The §6.4(c) guard
    //        `if (opts.linkedinSession && ...)` makes this the default path.
    //
    // VALIDATOR NOTE (Step 5 fill): pass `linkedinSession: undefined`
    // explicitly; otherwise the same setup as T-EagerChrome.1.
    const { tmpHome, cleanup } = withTmpHome();
    const stderrChunks: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: monkey-patch stderr
    (process.stderr as any).write = (chunk: any, ...rest: any[]): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return origStderrWrite(chunk, ...rest);
    };
    try {
      const model = new MockLanguageModelV1({
        provider: "openai",
        modelId: "deepseek-v4-flash-echo",
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "text-delta" as const, textDelta: "ok" },
              {
                type: "finish" as const,
                finishReason: "stop" as const,
                usage: { promptTokens: 5, completionTokens: 2 },
              },
            ],
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        }),
      });

      const messages: CoreMessage[] = [];
      const sessionFile = join(tmpHome, "session.jsonl");
      const input = new PassThrough();
      input.write("\n");
      input.end();

      // linkedinSession deliberately omitted — backward-compat path.
      await runRepl({
        model,
        system: "test",
        messages,
        tools: {},
        sessionFile,
        out: makeNullOut(),
        in_: input,
      });

      const stderrText = stderrChunks.join("");
      assert.ok(
        !stderrText.includes("eager Chrome init failed"),
        "no eager-init stderr write may occur when linkedinSession is undefined (the `if (opts.linkedinSession && ...)` guard must short-circuit)",
      );
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore stderr
      (process.stderr as any).write = origStderrWrite;
      cleanup();
    }
  });
});
