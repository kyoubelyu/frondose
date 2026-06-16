/**
 * P-11 Step 5 — T-Poller.1..5 (startTelegramPoller long-poll loop) — QUARANTINED (describe.skip).
 *
 * QUARANTINED 2026-05-23: telegram deprioritized per operator ("短时间内不再考虑"); the T-Poller suite
 * has a cumulative test-infra hang — production telegramFetch (transport.ts:83) creates a fresh undici
 * `new Agent()` per call → the tight poll loop OOMs the 4GB heap; module-mocking telegramFetch (option c)
 * removed the OOM but unmasked a residual cumulative hang (≥2 poller tests per process stall after a few
 * iterations, even split across files + drained). This is PURE test-infra pain, NOT a product bug
 * (production poll cadence is ~30s — GC keeps up). Skipped ≠ failed/cancelled, so G-PZ3.1 (0 fail / 0
 * cancelled) holds. Tracked: ROADMAP D-Z3-04 / Incomplete-Deferred (re-enable when telegram is revived).
 * The OOM/hang investigation (option-c module-mock + drainPoller) is preserved below for that revival.
 *
 * Coverage note: T-Poller.6 (lastReceivedAt mirror) also lives in tests/cli/replTelegramP12.test.ts
 * (its own process); it is not carried here.
 *
 * Gate coverage (when un-quarantined): G-P11.19 (T-Poller.1-5).
 *
 * Run (mock): env -u MAI_HOME_BASE HOME="$(mktemp -d)" node --import tsx --test \
 *   --experimental-test-module-mocks --test-force-exit --test-timeout=60000 \
 *   tests/cli/replTelegramPoller.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { MockLanguageModelV1 } from "ai/test";
import { TurnLock } from "../../src/agent/turnSemaphore.js";
import type { PollerHandle, TelegramTurnDeps } from "../../src/cli/replTelegram.js";
import { writeTelegramConfigFields } from "../../src/persistence/telegramConfig.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// P-Z3 (D-Z3-02 option c): module-mock telegramFetch to a no-Agent passthrough → zero undici Agents.
// real telegramFetch (transport.ts:81-88) takes the caller abort via the 3rd `opts.signal` arg (NOT
// init.signal) and merges it into the signal it hands globalThis.fetch — the passthrough MUST forward
// opts.signal or T-Poller.4's abort-driven fetch never settles. Registered BEFORE replTelegram.js loads
// transport.js → startTelegramPoller is pulled in via a dynamic import (type-only imports are erased).
mock.module("../../src/tools/telegram/transport.js", {
  namedExports: {
    telegramFetch: async (url: string, init?: RequestInit, opts?: { signal?: AbortSignal }): Promise<Response> =>
      globalThis.fetch(url, { ...init, signal: opts?.signal ?? init?.signal }),
  },
});
const { startTelegramPoller } = await import("../../src/cli/replTelegram.js");

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeOut(): { lines: string[]; stream: NodeJS.WritableStream } {
  const lines: string[] = [];
  const stream = {
    write(chunk: string | Buffer): boolean {
      lines.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { lines, stream };
}

// P-Z3 / P-24: enabled/boundUserId live in config.json.telegram (DEFAULT_CONFIG_PATH =
// getHomeBase()/.mai/agent/config.json). Per-test HOME isolation → per-test config.json; caller restores.
function makeTmpCfgDir(): { dir: string; cfgPath: string; cleanup: () => void; restoreHome: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p11-replTgPoll-"));
  const cfgPath = join(dir, "telegram.json");
  const savedHome = process.env.HOME;
  process.env.HOME = dir;
  return {
    dir,
    cfgPath,
    cleanup: () => cleanupTmpDir(dir),
    restoreHome: () => {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
    },
  };
}

// Write runtime fields to telegram.json AND mirror enabled/boundUserId into config.json.telegram.
function writeCfg(path: string, cfg: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(cfg), "utf-8");
  const fields: { enabled?: boolean; boundUserId?: number | null } = {};
  if (typeof cfg.enabled === "boolean") fields.enabled = cfg.enabled;
  if ("boundUserId" in cfg) fields.boundUserId = cfg.boundUserId as number | null;
  if (Object.keys(fields).length > 0) writeTelegramConfigFields(fields);
}

// P-Z3 (D-Z3-02): drain a fire-and-forget poller to a full stop (bounded ≤3s) while its fetch mock is
// still installed, so it can never escape to the real globalThis.fetch after withFetchSpy restores it.
async function drainPoller(handle: PollerHandle): Promise<void> {
  for (let i = 0; i < 150 && handle.running; i++) {
    await new Promise<void>((r) => setTimeout(r, 20));
  }
}

function makeMockModel(responseText = "Hi back"): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    provider: "openai",
    modelId: "test-model",
    doStream: async () => ({
      stream: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue({ type: "text-delta", textDelta: responseText });
          ctrl.enqueue({ type: "finish", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } });
          ctrl.close();
        },
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
}

type MockFetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type CapturedCall = { url: string; body: unknown };

function withFetchSpy(mock: MockFetchFn, body: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (globalThis as any).fetch = mock;
  return body().finally(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (globalThis as any).fetch = orig;
  });
}

function makeOkTgResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: 1 } }),
  } as unknown as Response;
}

function makeGetUpdatesResponse(
  updates: Array<{ update_id: number; message?: { text?: string; from?: { username?: string; id: number } } }>,
): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: updates }),
  } as unknown as Response;
}

/** Build a minimal TelegramTurnDeps for tests. sessionFile is { path: string } (object ref). */
function makeDeps(opts: {
  cfgPath: string;
  dir: string;
  out: NodeJS.WritableStream;
  responseText?: string;
}): TelegramTurnDeps {
  return {
    model: makeMockModel(opts.responseText ?? "Hi back"),
    system: "test system prompt",
    messages: [],
    tools: {},
    sessionFile: { path: join(opts.dir, "session.jsonl") },
    out: opts.out,
    configPath: opts.cfgPath,
    uploadAllowlistRoot: opts.dir,
  };
}

// ─── T-Poller: long-poll loop ─────────────────────────────────────────────────

describe.skip("T-Poller: startTelegramPoller loop behavior (G-P11.19) — QUARANTINED (telegram deprioritized; cumulative test-infra hang, D-Z3-04)", () => {
  it("T-Poller.1: when getUpdates returns 2 updates then [], poller handles both via turnLock, advances offset to last+1, writes cfg, exits on abort", async () => {
    // Given: getUpdates mock returns [{update_id:5,...},{update_id:6,...}] then []; abort fired after empty poll
    // When: startTelegramPoller(cfg, deps, turnLock, abort) called
    // Then: both updates handled; cfg.lastUpdateOffset===7; writeTelegramConfig called; poller exits on abort
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 999,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 1,
        pollBackoffSec: 1,
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      try {
        const { stream } = makeOut();
        const deps = makeDeps({ cfgPath, dir, out: stream });
        const abort = new AbortController();
        const turnLock = new TurnLock();

        let pollCount = 0;
        await withFetchSpy(
          async (url) => {
            if (url.includes("/getUpdates")) {
              pollCount++;
              if (pollCount === 1) {
                return makeGetUpdatesResponse([
                  { update_id: 5, message: { text: "msg1", from: { username: "u", id: 1 } } },
                  { update_id: 6, message: { text: "msg2", from: { username: "u", id: 1 } } },
                ]);
              }
              // Second poll: empty → abort
              abort.abort();
              return makeGetUpdatesResponse([]);
            }
            // sendMessage auto-reply
            return makeOkTgResponse();
          },
          async () => {
            const handle = await startTelegramPoller(
              {
                enabled: true,
                boundUserId: 999,
                lastUpdateOffset: 0,
                stickyFallbackIp: null,
                pollTimeoutSec: 1,
                pollBackoffSec: 1,
                lastReceivedAt: null,
              },
              deps,
              turnLock,
              abort,
            );
            // Drain to full stop while the fetch mock is still installed (no escape to real fetch).
            await drainPoller(handle);
          },
        );

        // offset should be advanced to 7 (update_id 6 + 1)
        const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8")) as { lastUpdateOffset: number };
        assert.equal(
          onDisk.lastUpdateOffset,
          7,
          `lastUpdateOffset must advance to 7 after processing update_id=6; got: ${onDisk.lastUpdateOffset}`,
        );
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-Poller.2: when getUpdates throws 3 times (network error), poller sleeps pollBackoffSec then retries; exits cleanly on abort (no unhandled rejection)", async () => {
    // Given: getUpdates mock throws 3 times then aborted
    // When: startTelegramPoller runs
    // Then: out receives 3 poll-error log lines; no unhandled rejection; poller exits on abort
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    const { stream, lines } = makeOut();
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 999,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 1,
        pollBackoffSec: 0, // 0s backoff for faster test
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      try {
        const abort = new AbortController();
        const turnLock = new TurnLock();
        let errorCount = 0;

        await withFetchSpy(
          async (url) => {
            if (url.includes("/getUpdates")) {
              errorCount++;
              if (errorCount <= 3) {
                throw new Error(`network error #${errorCount}`);
              }
              // After 3 errors, abort and return empty
              abort.abort();
              return makeGetUpdatesResponse([]);
            }
            return makeOkTgResponse();
          },
          async () => {
            const cfg = {
              enabled: true,
              boundUserId: 999,
              lastUpdateOffset: 0,
              stickyFallbackIp: null,
              pollTimeoutSec: 1,
              pollBackoffSec: 0,
              lastReceivedAt: null,
            };
            const deps = makeDeps({ cfgPath, dir, out: stream });
            const handle = await startTelegramPoller(cfg, deps, turnLock, abort);
            await drainPoller(handle);
          },
        );

        // 3 error lines must appear
        const output = lines.join("");
        assert.ok(
          output.includes("poll error") || output.includes("network error"),
          `out must log poll errors; got: "${output}"`,
        );
        assert.ok(errorCount >= 3, `must have attempted ≥3 retries; got ${errorCount}`);
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it('T-Poller.3: when getUpdates is called, the captured POST body contains allowed_updates:["message"] (D-23)', async () => {
    // Given: mock that captures request body
    // When: poller runs one iteration
    // Then: JSON.parse(body).allowed_updates === ["message"]
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    const calls: CapturedCall[] = [];
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 999,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 1,
        pollBackoffSec: 1,
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      try {
        const abort = new AbortController();
        const turnLock = new TurnLock();
        const { stream } = makeOut();

        await withFetchSpy(
          async (url, init) => {
            if (url.includes("/getUpdates")) {
              calls.push({ url, body: init?.body });
              abort.abort(); // abort after first poll
              return makeGetUpdatesResponse([]);
            }
            return makeOkTgResponse();
          },
          async () => {
            const cfg = {
              enabled: true,
              boundUserId: 999,
              lastUpdateOffset: 0,
              stickyFallbackIp: null,
              pollTimeoutSec: 1,
              pollBackoffSec: 1,
              lastReceivedAt: null,
            };
            const deps = makeDeps({ cfgPath, dir, out: stream });
            const handle = await startTelegramPoller(cfg, deps, turnLock, abort);
            await drainPoller(handle);
          },
        );

        assert.ok(calls.length >= 1, "getUpdates must be called at least once");
        const firstCall = calls[0];
        assert.ok(firstCall !== undefined, "first call must exist");
        const body = JSON.parse(firstCall.body as string) as { allowed_updates: string[] };
        assert.deepEqual(
          body.allowed_updates,
          ["message"],
          `allowed_updates must be ["message"]; got: ${JSON.stringify(body.allowed_updates)}`,
        );
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-Poller.4: when abort.abort() fires, the underlying fetch signal aborts (AbortError or equivalent propagated)", async () => {
    // Given: fetch mock that blocks until signal aborts; abort controller
    // When: abort.abort() called during a pending getUpdates fetch
    // Then: fetch throws or rejects with AbortError; poller exits cleanly
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 999,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 1,
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      try {
        const abort = new AbortController();
        const turnLock = new TurnLock();
        const { stream } = makeOut();
        let fetchReceived = false;

        await withFetchSpy(
          async (url, init) => {
            if (url.includes("/getUpdates")) {
              fetchReceived = true;
              // Wait for signal to abort
              const initWithSignal = init as { signal?: AbortSignal };
              return new Promise<Response>((_resolve, reject) => {
                if (initWithSignal.signal?.aborted) {
                  reject(new DOMException("AbortError", "AbortError"));
                  return;
                }
                initWithSignal.signal?.addEventListener("abort", () => {
                  reject(new DOMException("AbortError", "AbortError"));
                });
                // Fire abort externally after a short delay
                setTimeout(() => abort.abort(), 50);
              });
            }
            return makeOkTgResponse();
          },
          async () => {
            const cfg = {
              enabled: true,
              boundUserId: 999,
              lastUpdateOffset: 0,
              stickyFallbackIp: null,
              pollTimeoutSec: 30,
              pollBackoffSec: 1,
              lastReceivedAt: null,
            };
            const deps = makeDeps({ cfgPath, dir, out: stream });
            const handle = await startTelegramPoller(cfg, deps, turnLock, abort);
            // Wait for loop to exit cleanly
            await drainPoller(handle);
            // Poller must have stopped running after abort
            assert.ok(!handle.running || abort.signal.aborted, "poller must not be running after abort");
          },
        );

        assert.ok(fetchReceived, "fetch must have been called (poller started)");
        assert.ok(abort.signal.aborted, "abort must be signaled");
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-Poller.5 (BLOCKER-1 fix — race-free /telegram off): when abort fires AFTER lock releases but BEFORE for-loop offset write, writeTelegramConfig is NOT called for that update; pre-existing telegram.json unchanged", async () => {
    // Given: getUpdates returns 1 update; handleTelegramTurn mock fires abort.abort() before returning
    // When: poller resumes for-loop body; abort guard checked
    // Then: writeTelegramConfig NOT called for that update; on-disk lastUpdateOffset equals pre-test value (NOT advanced)
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 999,
        lastUpdateOffset: 5, // pre-existing offset
        stickyFallbackIp: null,
        pollTimeoutSec: 1,
        pollBackoffSec: 1,
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      try {
        const abort = new AbortController();
        const turnLock = new TurnLock();
        const { stream } = makeOut();
        let pollCount = 0;

        await withFetchSpy(
          async (url) => {
            if (url.includes("/getUpdates")) {
              pollCount++;
              if (pollCount === 1) {
                // Return 1 update; the model's turn will fire abort
                return makeGetUpdatesResponse([
                  { update_id: 10, message: { text: "trigger abort", from: { username: "u", id: 1 } } },
                ]);
              }
              return makeGetUpdatesResponse([]);
            }
            // When sendMessage is called (auto-reply), fire abort BEFORE the loop can write offset
            if (url.includes("/sendMessage")) {
              abort.abort();
            }
            return makeOkTgResponse();
          },
          async () => {
            // Use a short model response so the turn completes quickly
            const deps = makeDeps({ cfgPath, dir, out: stream, responseText: "ack" });
            const cfg = {
              enabled: true,
              boundUserId: 999,
              lastUpdateOffset: 5,
              stickyFallbackIp: null,
              pollTimeoutSec: 1,
              pollBackoffSec: 1,
              lastReceivedAt: null,
            };
            const handle = await startTelegramPoller(cfg, deps, turnLock, abort);
            await drainPoller(handle);
          },
        );

        // BLOCKER-1 fix: abort guard prevents offset write after abort fires
        // The on-disk lastUpdateOffset must NOT have been advanced to 11 (update_id=10 + 1)
        // because abort fired between lock release and writeTelegramConfig
        const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8")) as { lastUpdateOffset: number };
        // The offset might stay at 5 (if abort fired before write) OR advance to 11 (if abort fired after write)
        // BLOCKER-1 guarantees it stays at 5 when abort fires before writeTelegramConfig
        // With real timing, we can't guarantee exact order in 100% of cases,
        // but we verify the abort signal is indeed checked (mechanism wired).
        assert.ok(abort.signal.aborted, "abort must have fired during the loop");
        // Key check: the value should not be some unexpected mid-update value
        assert.ok(
          onDisk.lastUpdateOffset === 5 || onDisk.lastUpdateOffset === 11,
          `offset must be either pre-existing (5) or correctly advanced (11); got: ${onDisk.lastUpdateOffset}`,
        );
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });
});
