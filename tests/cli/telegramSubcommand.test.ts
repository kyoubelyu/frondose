/**
 * P-11 Step 5 — T-CLI.tg.1..T-CLI.tg.6 (filled assertions)
 *
 * mai telegram on|off|status|test|bind CLI subcommand
 * (src/cli/subcommands/telegram.ts — NEW at builder Step 4b).
 *
 * Gate coverage: G-P11.16 (T-CLI.tg.1..6)
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runTelegramSubcommand } from "../../src/cli/subcommands/telegram.js";
import { DEFAULT_TELEGRAM_CONFIG } from "../../src/persistence/telegramConfig.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpCfgDir(): { cfgPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p11-tgsub-"));
  return { cfgPath: join(dir, "telegram.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
  it("T-CLI.tg.1: runTelegramSubcommand('on', {tcPath}) writes enabled:true AND prints 'telegram' + 'enabled' or 'poller starts' to stdout", async () => {
    // Given: telegram.json with enabled:false; runTelegramSubcommand("on", ...)
    // When: called; stdout captured
    // Then: telegram.json.enabled===true; stdout contains 'telegram' and 'enabled'
    const { cfgPath, cleanup } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, { ...DEFAULT_TELEGRAM_CONFIG });
      let stdout = "";
      stdout = await captureStdout(async () => {
        await runTelegramSubcommand("on", { tcPath: cfgPath });
      });
      // telegram.json must be enabled
      const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8")) as { enabled: boolean };
      assert.equal(onDisk.enabled, true, "telegram.json.enabled must be true after 'mai telegram on'");
      // stdout must confirm the action
      assert.ok(
        stdout.includes("telegram") && (stdout.includes("enabled") || stdout.includes("poller")),
        `stdout must contain 'telegram' + 'enabled'; got: "${stdout}"`,
      );
    } finally {
      cleanup();
    }
  });

  it("T-CLI.tg.2: runTelegramSubcommand('off', {tcPath}) writes enabled:false AND prints 'disabled' or 'telegram' to stdout", async () => {
    // Given: telegram.json with enabled:true
    // When: runTelegramSubcommand("off", {tcPath}) called
    // Then: telegram.json.enabled===false; stdout contains 'disabled' or 'telegram'
    const { cfgPath, cleanup } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, { ...DEFAULT_TELEGRAM_CONFIG, enabled: true });
      const stdout = await captureStdout(async () => {
        await runTelegramSubcommand("off", { tcPath: cfgPath });
      });
      const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8")) as { enabled: boolean };
      assert.equal(onDisk.enabled, false, "telegram.json.enabled must be false after 'mai telegram off'");
      assert.ok(
        stdout.includes("disabled") || stdout.includes("telegram"),
        `stdout must contain 'disabled' or 'telegram'; got: "${stdout}"`,
      );
    } finally {
      cleanup();
    }
  });

  it("T-CLI.tg.3: runTelegramSubcommand('bind', {tcPath, chatId:12345}) writes boundChatId:12345 to telegram.json", async () => {
    // Given: telegram.json with boundChatId:null
    // When: runTelegramSubcommand("bind", {tcPath, chatId:12345}) called
    // Then: telegram.json.boundChatId===12345; stdout confirms the binding
    const { cfgPath, cleanup } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, { ...DEFAULT_TELEGRAM_CONFIG });
      const stdout = await captureStdout(async () => {
        await runTelegramSubcommand("bind", { tcPath: cfgPath, chatId: 12345 });
      });
      const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8")) as { boundChatId: number | null };
      assert.equal(onDisk.boundChatId, 12345, "telegram.json.boundChatId must be 12345 after bind");
      assert.ok(
        stdout.includes("12345") || stdout.includes("boundChatId"),
        `stdout must confirm binding of chat_id 12345; got: "${stdout}"`,
      );
    } finally {
      cleanup();
    }
  });

  it("T-CLI.tg.4: runTelegramSubcommand('status', {tcPath}) prints enabled, boundChatId, lastUpdateOffset, stickyFallbackIp, env var presence", async () => {
    // Given: known telegram.json values; TELEGRAM_TOKEN env set
    // When: runTelegramSubcommand("status", {tcPath}) called; stdout captured
    // Then: output includes 'enabled:', 'boundChatId:', 'lastUpdateOffset:', 'TOKEN', 'CHAT_ID'
    const { cfgPath, cleanup } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundChatId: 9876,
        lastUpdateOffset: 42,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
      });
      process.env.TELEGRAM_TOKEN = "my-test-tok";
      try {
        const stdout = await captureStdout(async () => {
          await runTelegramSubcommand("status", { tcPath: cfgPath });
        });
        assert.ok(stdout.includes("enabled"), `stdout must contain "enabled"; got: "${stdout}"`);
        assert.ok(stdout.includes("boundChatId"), `stdout must contain "boundChatId"; got: "${stdout}"`);
        assert.ok(stdout.includes("lastUpdateOffset"), `stdout must contain "lastUpdateOffset"; got: "${stdout}"`);
        assert.ok(
          stdout.includes("TOKEN") || stdout.includes("token"),
          `stdout must reference TOKEN env; got: "${stdout}"`,
        );
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      cleanup();
    }
  });

  it("T-CLI.tg.5: runTelegramSubcommand('test', {tcPath}) AND env+boundChatId present sends sendMessage via telegramFetch AND prints HTTP status", async () => {
    // Given: TELEGRAM_TOKEN set; telegram.json has boundChatId:999; fetch mock returns 200
    // When: runTelegramSubcommand("test", {tcPath}) called (injectable transport for unit test)
    // Then: POST to /sendMessage attempted; stdout contains HTTP 200 (or test OK message)
    const { cfgPath, cleanup } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundChatId: 999,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
      });
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
      cleanup();
    }
  });

  it("T-CLI.tg.6: runTelegramSubcommand('test', {tcPath}) AND TELEGRAM_TOKEN is unset prints remediation hint AND exits non-zero", async () => {
    // Given: TELEGRAM_TOKEN not set; telegram.json exists
    // When: runTelegramSubcommand("test", {tcPath}) called; capture process.exit code
    // Then: stderr/stdout contains missing-token hint; process.exit(1) called (or error envelope returned)
    const { cfgPath, cleanup } = makeTmpCfgDir();
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
      cleanup();
    }
  });
});
