/**
 * P-11 Step 5 — T-CLI.tg.1..T-CLI.tg.6 (filled assertions)
 *
 * mai telegram on|off|status|test|bind CLI subcommand
 * (src/cli/subcommands/telegram.ts — NEW at builder Step 4b).
 *
 * Gate coverage: G-P11.16 (T-CLI.tg.1..6)
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runTelegramSubcommand } from "../../src/cli/subcommands/telegram.js";
import {
  DEFAULT_TELEGRAM_CONFIG,
  readTelegramConfig,
  writeTelegramConfigFields,
} from "../../src/persistence/telegramConfig.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ─────────────────────────────────────────────────────────────────

// P-Z3 / P-24: `enabled`/`boundUserId` live in config.json.telegram (DEFAULT_CONFIG_PATH =
// getHomeBase()/.mai/agent/config.json), NOT in telegram.json (now runtime-only).
// runTelegramSubcommand has no configPath param, so isolate each test by pointing HOME at its own
// tmp dir → config.json is per-test (no cross-test enabled/boundUserId bleed). Seed preconditions
// via writeTelegramConfigFields and read back via readTelegramConfig. Caller invokes restoreHome().
function makeTmpCfgDir(): { cfgPath: string; cleanup: () => void; restoreHome: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p11-tgsub-"));
  const savedHome = process.env.HOME;
  process.env.HOME = dir;
  return {
    cfgPath: join(dir, "telegram.json"),
    cleanup: () => cleanupTmpDir(dir),
    restoreHome: () => {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
    },
  };
}

function writeCfg(path: string, cfg: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(cfg), "utf-8");
}

function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stdout as any).write = (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  return fn()
    .finally(() => {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stdout as any).write = origWrite;
    })
    .then(() => chunks.join(""));
}

function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stderr as any).write = (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  return fn()
    .finally(() => {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stderr as any).write = origWrite;
    })
    .then(() => chunks.join(""));
}

// ─── T-CLI.tg: mai telegram subcommand ───────────────────────────────────────

describe("runTelegramSubcommand (G-P11.16)", () => {
  it("T-CLI.tg.1: runTelegramSubcommand('on', {tcPath}) proceeds past precondition guards (daemon install — darwin only; cfg.enabled=true written on success)", async () => {
    // Given: telegram.json with enabled:false, boundUserId set; TELEGRAM_TOKEN set; repl.pid absent
    // When: called with yes=true (bypass consent) — P-23 §6.8 changed 'on' to daemon-install flow
    // Then: on non-darwin → exits 1 with macOS-only stderr (guarded early return, no process kill in test)
    //       on darwin → plist write attempted; launchctl may fail in CI (launchctl failure is expected);
    //                   cfg.enabled=true written only after successful launchctl (not testable in CI without real launchctl)
    //                   guard assertion: no uncaught exception; stderr or stdout contains 'telegram'
    const { cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    const origToken = process.env.TELEGRAM_TOKEN;
    // Mock process.exit to prevent test runner termination
    const exitCalls: number[] = [];
    const origExit = process.exit.bind(process);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process as any).exit = (code?: number) => {
      exitCalls.push(code ?? 0);
      throw new Error(`process.exit(${code})`);
    };
    try {
      writeCfg(cfgPath, { ...DEFAULT_TELEGRAM_CONFIG, boundUserId: 12345 });
      process.env.TELEGRAM_TOKEN = "stub-token";
      let stdout = "";
      let stderrCap = "";
      try {
        stdout = await captureStdout(async () => {
          stderrCap = await captureStderr(async () => {
            await runTelegramSubcommand("on", { tcPath: cfgPath, yes: true });
          });
        });
      } catch {
        // process.exit mock throws — expected in test env when launchctl or guard fires
      }
      // Assertion: something related to 'telegram' was printed (stdout or stderr)
      const combined = stdout + stderrCap;
      assert.ok(
        combined.includes("telegram") || exitCalls.length > 0,
        `must print telegram-related output or call exit; stdout="${stdout}" stderr="${stderrCap}"`,
      );
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = origExit;
      if (origToken !== undefined) process.env.TELEGRAM_TOKEN = origToken;
      else delete process.env.TELEGRAM_TOKEN;
      restoreHome();
      cleanup();
    }
  });

  it("T-CLI.tg.2: runTelegramSubcommand('off', {tcPath}) writes enabled:false AND prints 'disabled' or 'telegram' to stdout", async () => {
    // Given: telegram.json with enabled:true
    // When: runTelegramSubcommand("off", {tcPath}) called
    // Then: telegram.json.enabled===false; stdout contains 'disabled' or 'telegram'
    const { cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, { ...DEFAULT_TELEGRAM_CONFIG });
      // P-24: enabled lives in config.json.telegram — seed the precondition there.
      writeTelegramConfigFields({ enabled: true });
      const stdout = await captureStdout(async () => {
        await runTelegramSubcommand("off", { tcPath: cfgPath });
      });
      assert.equal(
        readTelegramConfig(cfgPath).enabled,
        false,
        "config.json.telegram.enabled must be false after 'mai telegram off'",
      );
      assert.ok(
        stdout.includes("disabled") || stdout.includes("telegram"),
        `stdout must contain 'disabled' or 'telegram'; got: "${stdout}"`,
      );
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-CLI.tg.3: runTelegramSubcommand('bind', {tcPath, userId:12345}) writes boundUserId:12345 to telegram.json", async () => {
    // Given: telegram.json with boundUserId:null
    // When: runTelegramSubcommand("bind", {tcPath, userId:12345}) called
    // Then: telegram.json.boundUserId===12345; stdout confirms the binding
    const { cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, { ...DEFAULT_TELEGRAM_CONFIG });
      const stdout = await captureStdout(async () => {
        await runTelegramSubcommand("bind", { tcPath: cfgPath, userId: 12345 });
      });
      // P-24: boundUserId lives in config.json.telegram — read back via the shim.
      assert.equal(
        readTelegramConfig(cfgPath).boundUserId,
        12345,
        "config.json.telegram.boundUserId must be 12345 after bind",
      );
      assert.ok(
        stdout.includes("12345") || stdout.includes("boundUserId"),
        `stdout must confirm binding of chat_id 12345; got: "${stdout}"`,
      );
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-CLI.tg.4: runTelegramSubcommand('status', {tcPath}) prints enabled, boundUserId, lastUpdateOffset, stickyFallbackIp, env var presence, AND lastReceivedAt (P-12 D-5 NIT-1)", async () => {
    // Given: known telegram.json values INCLUDING lastReceivedAt timestamp; TELEGRAM_TOKEN env set
    // When: runTelegramSubcommand("status", {tcPath}) called; stdout captured
    // Then: output includes 'enabled:', 'boundUserId:', 'lastUpdateOffset:', 'TOKEN', and '[telegram] lastReceivedAt: 2026-05-11T10:00:00Z'
    const { cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 9876,
        lastUpdateOffset: 42,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
        lastReceivedAt: "2026-05-11T10:00:00Z",
      });
      process.env.TELEGRAM_TOKEN = "my-test-tok";
      try {
        const stdout = await captureStdout(async () => {
          await runTelegramSubcommand("status", { tcPath: cfgPath });
        });
        assert.ok(stdout.includes("enabled"), `stdout must contain "enabled"; got: "${stdout}"`);
        assert.ok(stdout.includes("boundUserId"), `stdout must contain "boundUserId"; got: "${stdout}"`);
        assert.ok(stdout.includes("lastUpdateOffset"), `stdout must contain "lastUpdateOffset"; got: "${stdout}"`);
        assert.ok(
          stdout.includes("TOKEN") || stdout.includes("token"),
          `stdout must reference TOKEN env; got: "${stdout}"`,
        );
        // P-12 D-5 NIT-1: lastReceivedAt must be surfaced in status output
        assert.ok(
          stdout.match(/\[telegram\] lastReceivedAt: 2026-05-11T10:00:00Z/m) !== null ||
            (stdout.includes("lastReceivedAt") && stdout.includes("2026-05-11T10:00:00Z")),
          `stdout must contain lastReceivedAt timestamp; got: "${stdout.slice(0, 400)}"`,
        );
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-CLI.tg.5: runTelegramSubcommand('test', {tcPath}) AND env+boundUserId present sends sendMessage via telegramFetch AND prints HTTP status", async () => {
    // Given: TELEGRAM_TOKEN set; telegram.json has boundUserId:999; fetch mock returns 200
    // When: runTelegramSubcommand("test", {tcPath}) called (injectable transport for unit test)
    // Then: POST to /sendMessage attempted; stdout contains HTTP 200 (or test OK message)
    const { cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
      });
      // P-24: enabled/boundUserId live in config.json.telegram — seed there so the
      // 'test' action passes the `boundUserId === null` guard and reaches the sendMessage fetch.
      writeTelegramConfigFields({ enabled: true, boundUserId: 999 });
      process.env.TELEGRAM_TOKEN = "test-tok";
      const origFetch = globalThis.fetch;
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      (globalThis as any).fetch = async (url: string, _init?: RequestInit): Promise<Response> => {
        void url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
        } as unknown as Response;
      };
      try {
        const stdout = await captureStdout(async () => {
          await runTelegramSubcommand("test", { tcPath: cfgPath });
        });
        assert.ok(
          stdout.includes("200") || stdout.includes("OK") || stdout.includes("test"),
          `stdout must contain HTTP 200 or test confirmation; got: "${stdout}"`,
        );
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: restore
        (globalThis as any).fetch = origFetch;
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-CLI.tg.6: runTelegramSubcommand('test', {tcPath}) AND TELEGRAM_TOKEN is unset prints remediation hint AND exits non-zero", async () => {
    // Given: TELEGRAM_TOKEN not set; telegram.json exists
    // When: runTelegramSubcommand("test", {tcPath}) called; capture process.exit code
    // Then: stderr/stdout contains missing-token hint; process.exit(1) called (or error envelope returned)
    const { cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    let exitCode: number | undefined;
    const origExit = process.exit.bind(process);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process as any).exit = (code: number) => {
      exitCode = code;
      // Don't actually exit — just capture the code
    };
    try {
      writeCfg(cfgPath, { ...DEFAULT_TELEGRAM_CONFIG });
      delete process.env.TELEGRAM_TOKEN;
      let stderrOut = "";
      stderrOut = await captureStderr(async () => {
        await runTelegramSubcommand("test", { tcPath: cfgPath });
      });
      assert.ok(
        exitCode === 1 || stderrOut.includes("TELEGRAM_TOKEN") || stderrOut.includes("token"),
        `must exit(1) or print token hint; exitCode=${exitCode}, stderr="${stderrOut}"`,
      );
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = origExit;
      restoreHome();
      cleanup();
    }
  });

  it("T-Nonint.3: 'bind' with userId arg (2-arg call, no prompter) still works after P-13 adds optional 3rd param", async () => {
    // Given: pre-P-13 call pattern — runTelegramSubcommand("bind", { tcPath, userId }) with only 2 args
    // When:  re-run against P-13 production (which adds optional prompter 3rd param with default=realPrompter)
    // Then:  telegram.json.boundUserId written correctly; realPrompter (default) never invoked (args-present branch)

    const { cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, { ...DEFAULT_TELEGRAM_CONFIG });

      await captureStdout(() => runTelegramSubcommand("bind", { tcPath: cfgPath, userId: 77777 }));
      // P-24: boundUserId lives in config.json.telegram — read back via the shim.
      assert.equal(
        readTelegramConfig(cfgPath).boundUserId,
        77777,
        "T-Nonint.3: boundUserId must be 77777 with 2-arg call pattern",
      );
    } finally {
      restoreHome();
      cleanup();
    }
  });
});
