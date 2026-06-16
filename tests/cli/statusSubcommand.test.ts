/**
 * P-11 Step 5 — T-CLI.status.1..T-CLI.status.5 (filled assertions)
 *
 * mai status — aggregate auth + chrome + linkedin + telegram + cron + memory
 * (src/cli/subcommands/status.ts — NEW at builder Step 4b).
 *
 * Gate coverage: G-P11.17 (T-CLI.status.1..5)
 *
 * NOTE: captureStdout replaces process.stdout.write globally. Node v24's spec
 * reporter writes "✔ <test>" in an event loop tick AFTER each t.test() resolves.
 * If the next captureStdout starts before that tick fires, the reporter's output
 * is swallowed and the test doesn't appear in the summary.
 * Fix: flush() — a 20ms gap between subtests — lets the reporter write before
 * the next captureStdout replaces process.stdout.write again.
 * All subtests run sequentially inside a { concurrency: 1 } parent.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runStatusSubcommand } from "../../src/cli/subcommands/status.js";
import { writeTelegramConfigFields } from "../../src/persistence/telegramConfig.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p11-status-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stdout as any).write = (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stdout as any).write = origWrite;
  }
  return chunks.join("");
}

/** Yield the event loop so Node's spec reporter can write "✔ <test>" to stdout
 *  before the next captureStdout call replaces process.stdout.write again. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

// Unreachable high CDP port — guarantees the Chrome ping will fail
const DEAD_CDP_PORT = 29999;

// ─── T-CLI.status: mai status output ─────────────────────────────────────────

test("runStatusSubcommand (G-P11.17)", { concurrency: 1 }, async (t) => {
  // Given: auth.json + identity.json + schedule.jsonl + telegram.json + memory.sqlite all exist; CDP port dead
  // When: runStatusSubcommand called; stdout captured
  // Then: output contains "auth:", "identity:", "chrome:", "telegram:", "cron:", "memory:" lines
  await t.test(
    "T-CLI.status.1: when all config files exist, stdout contains auth, identity, telegram, cron, memory sections each with detail line",
    async () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const authPath = join(dir, "auth.json");
        const identityPath = join(dir, "identity.json");
        const schedulePath = join(dir, "schedule.jsonl");
        const tcPath = join(dir, "telegram.json");
        const memoryDbPath = join(dir, "memory.sqlite");
        writeFileSync(
          authPath,
          JSON.stringify({ providers: { anthropic: { key: "x" } }, default: "anthropic" }),
          "utf-8",
        );
        writeFileSync(
          identityPath,
          JSON.stringify({ fullName: "Test User", role: "CEO", company: "Acme", updatedAt: new Date().toISOString() }),
          "utf-8",
        );
        writeFileSync(schedulePath, "", "utf-8");
        writeFileSync(
          tcPath,
          JSON.stringify({
            enabled: false,
            boundUserId: null,
            lastUpdateOffset: 0,
            stickyFallbackIp: null,
            pollTimeoutSec: 30,
            pollBackoffSec: 5,
          }),
          "utf-8",
        );
        writeFileSync(memoryDbPath, Buffer.alloc(4096), "binary");

        const output = await captureStdout(async () => {
          await runStatusSubcommand({
            authPath,
            identityPath,
            schedulePath,
            tcPath,
            memoryDbPath,
            cdpPort: DEAD_CDP_PORT,
          });
        });

        assert.ok(output.includes("auth:"), `output must contain "auth:"; got: "${output.slice(0, 400)}"`);
        assert.ok(output.includes("identity:"), `output must contain "identity:"; got: "${output.slice(0, 400)}"`);
        assert.ok(output.includes("chrome:"), `output must contain "chrome:"; got: "${output.slice(0, 400)}"`);
        assert.ok(output.includes("telegram:"), `output must contain "telegram:"; got: "${output.slice(0, 400)}"`);
        assert.ok(output.includes("cron:"), `output must contain "cron:"; got: "${output.slice(0, 400)}"`);
        assert.ok(output.includes("memory:"), `output must contain "memory:"; got: "${output.slice(0, 400)}"`);
      } finally {
        cleanup();
      }
    },
  );
  await flush();

  // Given: CDP port is dead (DEAD_CDP_PORT = 29999); no Chrome listening
  // When: runStatusSubcommand called with cdpPort:DEAD_CDP_PORT
  // Then: output contains "chrome: not running" (or "not running"/"unreachable"); no throw
  await t.test(
    "T-CLI.status.2: when Chrome is not running (CDP port unreachable), output contains 'chrome: not running'; does NOT throw",
    async () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const output = await captureStdout(async () => {
          await runStatusSubcommand({
            authPath: join(dir, "auth.json"),
            identityPath: join(dir, "identity.json"),
            schedulePath: join(dir, "schedule.jsonl"),
            tcPath: join(dir, "telegram.json"),
            memoryDbPath: join(dir, "memory.sqlite"),
            cdpPort: DEAD_CDP_PORT,
          });
        });
        assert.ok(
          output.includes("not running") || output.includes("unreachable"),
          `output must indicate Chrome is not running; got: "${output.slice(0, 400)}"`,
        );
      } finally {
        cleanup();
      }
    },
  );
  await flush();

  // Given: authPath points to non-existent file
  // When: runStatusSubcommand called
  // Then: output contains "not configured" or "(not configured)"; no throw
  await t.test(
    "T-CLI.status.3: when auth.json does NOT exist, output contains 'auth: (not configured)' or similar; does NOT throw",
    async () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const output = await captureStdout(async () => {
          await runStatusSubcommand({
            authPath: join(dir, "no-auth.json"),
            identityPath: join(dir, "identity.json"),
            schedulePath: join(dir, "schedule.jsonl"),
            tcPath: join(dir, "telegram.json"),
            memoryDbPath: join(dir, "memory.sqlite"),
            cdpPort: DEAD_CDP_PORT,
          });
        });
        assert.ok(
          output.includes("not configured") || output.includes("(not configured)"),
          `output must indicate auth not configured; got: "${output.slice(0, 400)}"`,
        );
      } finally {
        cleanup();
      }
    },
  );
  await flush();

  // Given: identityPath points to non-existent file
  // When: runStatusSubcommand called
  // Then: output contains "not initialized" or "(not initialized)"
  await t.test(
    "T-CLI.status.4: when identity.json does NOT exist, output contains 'identity: (not initialized)' or similar",
    async () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const output = await captureStdout(async () => {
          await runStatusSubcommand({
            authPath: join(dir, "auth.json"),
            identityPath: join(dir, "no-identity.json"),
            schedulePath: join(dir, "schedule.jsonl"),
            tcPath: join(dir, "telegram.json"),
            memoryDbPath: join(dir, "memory.sqlite"),
            cdpPort: DEAD_CDP_PORT,
          });
        });
        assert.ok(
          output.includes("not initialized") || output.includes("(not initialized)"),
          `output must indicate identity not initialized; got: "${output.slice(0, 400)}"`,
        );
      } finally {
        cleanup();
      }
    },
  );
  await flush();

  // Given: tcPath points to non-existent file (defaults to disabled)
  // When: runStatusSubcommand called
  // Then: output contains "telegram: enabled=false" or "telegram: enabled: false"
  await t.test(
    "T-CLI.status.5: when telegram.json does NOT exist, output shows 'telegram: enabled=false' (default; no throw)",
    async () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const output = await captureStdout(async () => {
          await runStatusSubcommand({
            authPath: join(dir, "auth.json"),
            identityPath: join(dir, "identity.json"),
            schedulePath: join(dir, "schedule.jsonl"),
            tcPath: join(dir, "no-telegram.json"),
            memoryDbPath: join(dir, "memory.sqlite"),
            cdpPort: DEAD_CDP_PORT,
          });
        });
        assert.ok(
          output.includes("telegram:") && output.includes("enabled=false"),
          `output must contain "telegram: enabled=false"; got: "${output.slice(0, 400)}"`,
        );
      } finally {
        cleanup();
      }
    },
  );
});

// ─── T-Status.2 — P-15 github + search + proxy lines ──────────────────────

test("T-Status.2: when github.json + search.json exist AND config.json has proxyUrl, output includes github/search/telegram proxy lines", async () => {
  // Given: secrets.json with github token+repo + search braveApiKey;
  //        config.json.telegram.proxyUrl = "http://p:7890" (P-24: proxyUrl lives in config.json, not telegram.json)
  // When:  runStatusSubcommand called with ghPath + searchPath + tcPath + configPath pointing to tmpDir
  // Then:  output includes "github:", "search:", and "telegram:" with proxy=http://p:7890

  const { dir, cleanup } = makeTmpDir();
  try {
    const authPath = join(dir, "auth.json");
    const identityPath = join(dir, "identity.json");
    const schedulePath = join(dir, "schedule.jsonl");
    const tcPath = join(dir, "telegram.json");
    const configPath = join(dir, "config.json");
    const memoryDbPath = join(dir, "memory.sqlite");
    const ghPath = join(dir, "github.json");
    const searchPath = join(dir, "search.json");

    // Write minimal config files
    writeFileSync(authPath, JSON.stringify({ providers: { anthropic: { key: "x" } }, default: "anthropic" }), "utf-8");
    writeFileSync(
      identityPath,
      JSON.stringify({ fullName: "Test", role: "Dev", company: "Acme", updatedAt: new Date().toISOString() }),
      "utf-8",
    );
    writeFileSync(schedulePath, "", "utf-8");
    writeFileSync(memoryDbPath, Buffer.alloc(4096), "binary");
    // telegram.json: runtime-only fields (P-24: no proxyUrl here)
    writeFileSync(
      tcPath,
      JSON.stringify({ lastUpdateOffset: 0, stickyFallbackIp: null, pollTimeoutSec: 30, pollBackoffSec: 5 }),
      "utf-8",
    );

    // P-15 files: write via shims so secrets.json gets populated
    writeFileSync(ghPath, JSON.stringify({ repo: "own/r", token: "ghp_test" }), "utf-8");
    writeFileSync(searchPath, JSON.stringify({ braveApiKey: "bsa-xxx" }), "utf-8");

    // P-24: proxyUrl now lives in config.json.telegram — use writeTelegramConfigFields for isolation
    writeTelegramConfigFields({ proxyUrl: "http://p:7890" }, configPath);

    const output = await captureStdout(async () => {
      await runStatusSubcommand({
        authPath,
        identityPath,
        schedulePath,
        tcPath,
        configPath,
        memoryDbPath,
        cdpPort: DEAD_CDP_PORT,
        ghPath,
        searchPath,
      });
    });

    assert.ok(output.includes("github:"), `output must contain "github:"; got: "${output.slice(0, 400)}"`);
    assert.ok(output.includes("search:"), `output must contain "search:"; got: "${output.slice(0, 400)}"`);
    assert.ok(
      output.includes("proxy=http://p:7890") || output.includes("proxy: http://p:7890"),
      `output must contain proxy URL; got: "${output.slice(0, 400)}"`,
    );
  } finally {
    cleanup();
  }
});
