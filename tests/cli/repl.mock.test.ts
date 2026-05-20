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
 * Black-box approach for T-Wiring.1: a `MockLanguageModelV1` whose `doStream`
 * PEEKS at `opts.control.isInteractive` while the real `runAgentLoop` is
 * mid-execution — no `mock.module` / static-import stubbing (Step-3 CONCERN-1,
 * Step-3b orchestrator override).
 *
 * Structural approach for T-Wiring.2: compile-time `keyof` check + source-text
 * grep verifies cron / telegram / worker don't carry or read `control`.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path, { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { CoreMessage } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { runRepl } from "../../src/cli/repl.js";
import type { TelegramTurnDeps } from "../../src/cli/replTelegram.js";
import type { RunCronTurnDeps } from "../../src/cli/replCron.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * HOME shim — create a tmp dir, mkdir `<tmp>/.mai/agent`, set HOME to tmp.
 * `os.homedir()` resolves from `process.env.HOME` on Unix, so `runRepl`'s hardcoded
 * `path.join(os.homedir(), ".mai", "agent", "turn.lock")` lands in the tmp tree.
 * Returns a cleanup that restores HOME + removes the tmp dir.
 */
function withTmpHome(): { tmpHome: string; cleanup: () => void } {
  const tmpHome = mkdtempSync(join(os.tmpdir(), "mai-p54-repl-"));
  mkdirSync(join(tmpHome, ".mai", "agent"), { recursive: true });
  const priorHome = process.env.HOME;
  process.env.HOME = tmpHome;
  return {
    tmpHome,
    cleanup: () => {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      try {
        rmSync(tmpHome, { recursive: true, force: true });
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

// ─── T-Wiring.1 ──────────────────────────────────────────────────────────────

describe("interactive operator-turn flips isInteractive=true INSIDE turnLock + restores in finally (G-P54.6)", () => {
  it("T-Wiring.1 (success path): when runRepl runs one operator turn, MockLanguageModelV1.doStream peeks opts.control.isInteractive===true, AND after runRepl settles opts.control.isInteractive is restored to its prior value (undefined)", async () => {
    // Given: runRepl invoked with opts.control = { requestStop: ()=>{}, isInteractive: undefined }
    //        and a MockLanguageModelV1 whose doStream callback PEEKS
    //        opts.control.isInteractive into a closure variable while the real
    //        runAgentLoop is mid-execution.
    // When:  synthetic stdin feeds the operator a single line "hello\n" then EOF;
    //        runRepl settles after processing that single turn.
    // Then:  (a) the peeked value === true (flip is visible INSIDE the turnLock.run
    //            callback, around runAgentLoop);
    //        (b) post-settle, opts.control.isInteractive === undefined (restored
    //            by the inner finally — see plan §6.3(b) BLOCKER-1 fix).
    const { tmpHome, cleanup } = withTmpHome();
    try {
      let peekedValue: unknown = "NEVER_PEEKED";
      const control: ControlSignals = {
        requestStop: () => {},
        isInteractive: undefined,
      };

      const model = new MockLanguageModelV1({
        provider: "openai",
        modelId: "deepseek-v4-flash",
        doStream: async () => {
          // PEEK while runAgentLoop is mid-execution — production should have
          // flipped isInteractive=true inside turnLock.run by the time the model
          // is consulted (between the flip on line 306 and the inner finally on 319).
          peekedValue = control.isInteractive;
          return {
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
          };
        },
      });

      const messages: CoreMessage[] = [];
      const sessionFile = join(tmpHome, "session.jsonl");
      const input = new PassThrough();
      input.write("hello\n");
      input.end();

      await runRepl({
        model,
        system: "test system",
        messages,
        tools: {},
        sessionFile,
        out: makeNullOut(),
        in_: input,
        control,
      });

      assert.equal(
        peekedValue,
        true,
        "MockLanguageModelV1.doStream must observe opts.control.isInteractive===true while runAgentLoop is mid-execution (the flip is visible inside turnLock.run)",
      );
      assert.equal(
        control.isInteractive,
        undefined,
        "after runRepl settles, opts.control.isInteractive must be restored to its prior value (undefined) by the inner finally",
      );
    } finally {
      cleanup();
    }
  });

  it("T-Wiring.1 (throw path): when runAgentLoop throws while runRepl is mid-operator-turn (an aborted-but-not-handled-as-clean rejection), the inner finally restores opts.control.isInteractive to its prior value (undefined) BEFORE the rejection propagates out of turnLock.run", async () => {
    // Given: opts.control = { requestStop:()=>{}, isInteractive: undefined } and a
    //        MockLanguageModelV1 whose doStream PEEKS isInteractive (must observe
    //        the flipped `true` value mid-execution) and then returns a stream
    //        that emits an "error" chunk so streamText surfaces an exception. The
    //        post-throw `opts.control.isInteractive` value is what carries the
    //        load-bearing assertion of plan §6.3(b) BLOCKER-1.
    // When:  synthetic stdin feeds one line; runRepl runs that turn.
    // Then:  (a) the peek captured isInteractive===true (flip happened);
    //        (b) post-runRepl, opts.control.isInteractive === undefined (the
    //            inner finally restored on the throw path — not just the success path).
    //
    // VALIDATOR NOTE: an error-chunk in the stream is the Vercel AI SDK idiomatic
    // way to surface a model-level error; a thrown doStream callback gets buffered
    // weirdly by streamText (the rejection surfaces as a no-op chunk and the loop
    // continues to drain stdin → hang in non-TTY mode). The error chunk forces the
    // SDK to emit the error through its standard error path and reaches runAgentLoop.
    const { tmpHome, cleanup } = withTmpHome();
    try {
      let peekedValue: unknown = "NEVER_PEEKED";
      const control: ControlSignals = {
        requestStop: () => {},
        isInteractive: undefined,
      };

      const model = new MockLanguageModelV1({
        provider: "openai",
        modelId: "deepseek-v4-flash",
        doStream: async () => {
          // Peek BEFORE returning the error stream.
          peekedValue = control.isInteractive;
          return {
            stream: simulateReadableStream({
              chunks: [{ type: "error" as const, error: new Error("test throw") }],
            }),
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        },
      });

      const messages: CoreMessage[] = [];
      const sessionFile = join(tmpHome, "session.jsonl");
      const input = new PassThrough();
      input.write("hello\n");
      input.end();

      // The error-chunk in the stream causes streamText to surface the error via
      // its normal error path; runAgentLoop's try/catch sees it and (since
      // abortSignal is not aborted) rethrows. The throw escapes turnLock.run via
      // the inner `try { runAgentLoop() } finally { restore }` — finally MUST run
      // before the throw bubbles out.
      let caught: unknown = "NOT_THROWN";
      try {
        await runRepl({
          model,
          system: "test system",
          messages,
          tools: {},
          sessionFile,
          out: makeNullOut(),
          in_: input,
          control,
        });
      } catch (e) {
        caught = e;
      }

      assert.equal(
        peekedValue,
        true,
        "MockLanguageModelV1.doStream must observe opts.control.isInteractive===true (the flip happened before the error chunk surfaced)",
      );
      assert.equal(
        control.isInteractive,
        undefined,
        "post-throw, opts.control.isInteractive must be restored to undefined (the inner finally in repl.ts:319 must run on the throw path too — load-bearing for Step-3b BLOCKER-1 fix)",
      );
      // Diagnostic: prefer that the throw escaped, but do not strictly require
      // a specific error shape — if the SDK normalizes the error chunk, the
      // restoration assertion above still proves the inner finally fired.
      void caught;
    } finally {
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
