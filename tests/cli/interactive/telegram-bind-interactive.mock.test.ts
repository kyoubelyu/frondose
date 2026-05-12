/**
 * P-13 Step 4a — T-TgI.1..4 scaffolds
 *
 * Tests: runTelegramSubcommand('bind') interactive paths (D-7 5-step flow)
 * Gate coverage: G-P13.4 + G-P13.7
 *
 * Mocking strategy for telegramFetch:
 *   telegramFetch is called INSIDE runTelegramSubcommand (not via prompter DI).
 *   At Step 5, the validator will implement mocking via node:test mock.module()
 *   OR by intercepting at the fetch level (undici intercepts / nock-style).
 *   The scaffold marks all telegramFetch-dependent assertions as TODO.
 *
 * NOTE: Imports _prompts.ts (does NOT exist at Step 4a). All tests fail at
 * import-resolution until builder Step 4b. Step 5 fills assertion bodies.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runTelegramSubcommand } from "../../../src/cli/subcommands/telegram.js";
import { captureStdout, makeMockPrompter, stubInteractive } from "./_mockPrompter.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpTgDir(): { tcPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p13-tg-"));
  return {
    tcPath: join(dir, "telegram.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function readTcJson(tcPath: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(tcPath, "utf-8"));
  } catch {
    return {};
  }
}

// ─── T-TgI.1 ─────────────────────────────────────────────────────────────────

describe("runTelegramSubcommand('bind') — userId arg present (non-interactive regression)", () => {
  it("T-TgI.1: when userId arg present, writes telegram.json directly AND prompter is NOT invoked", async () => {
    // Given: opts.userId = 12345 (positional arg present); tcPath is a tmp file
    // When:  runTelegramSubcommand("bind", { tcPath, userId: 12345 }, mockPrompter)
    // Then:  telegram.json.boundUserId === 12345; no prompter method called

    const { tcPath, cleanup } = makeTmpTgDir();
    const mp = makeMockPrompter();
    try {
      await captureStdout(() => runTelegramSubcommand("bind", { tcPath, userId: 12345 }, mp));
      const cfg = readTcJson(tcPath);
      assert.equal(cfg.boundUserId, 12345, "T-TgI.1: boundUserId must be 12345");
      assert.equal(mp.calls.telegramUserSelect.length, 0, "T-TgI.1: telegramUserSelect MUST NOT be called");
      assert.equal(mp.calls.input.length, 0, "T-TgI.1: input MUST NOT be called");
    } finally {
      cleanup();
    }
  });
});

// ─── T-TgI.2 ─────────────────────────────────────────────────────────────────

describe("runTelegramSubcommand('bind') — interactive path (getUpdates succeeds, senders found)", () => {
  it("T-TgI.2: when no userId AND isInteractive()=true AND getUpdates ok=true with senders, calls telegramUserSelect and writes boundUserId", async () => {
    // Given: no userId; TELEGRAM_TOKEN set; stdin.isTTY=true; mocked telegramFetch returns {ok:true, result:[sender 999@alice]}
    // When:  runTelegramSubcommand("bind", { tcPath }, mockPrompter) with telegramUserSelect→999
    // Then:  telegram.json.boundUserId===999; telegramUserSelect received Map with entry keyed by 999
    //
    // NOTE: telegramFetch mock strategy TBD at Step 5. Scaffold marks fetch-dependent steps TODO.
    // Approach options: (a) node:test mock.module() to override transport; (b) env-based fetch intercept.

    const { tcPath, cleanup } = makeTmpTgDir();
    const restore = stubInteractive(true);
    const savedToken = process.env.TELEGRAM_TOKEN;
    process.env.TELEGRAM_TOKEN = "test-token-mock";
    const mp = makeMockPrompter({
      telegramUserSelect: async (senders: Map<number, string>) => {
        // Return first sender if any
        const first = [...senders.entries()][0];
        return first ? first[0] : null;
      },
    });
    // Mock globalThis.fetch to return getUpdates response with one sender
    const origFetch = globalThis.fetch;
    // biome-ignore lint/suspicious/noExplicitAny: test mock for telegramFetch transport
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ ok: true, result: [{ message: { from: { id: 999, username: "alice" } } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    try {
      await captureStdout(() => runTelegramSubcommand("bind", { tcPath }, mp));
      const cfg = readTcJson(tcPath);
      assert.equal(cfg.boundUserId, 999, "T-TgI.2: boundUserId must be 999");
      assert.equal(mp.calls.telegramUserSelect.length, 1, "T-TgI.2: telegramUserSelect must be called once");
      const senderMap = mp.calls.telegramUserSelect[0][0] as Map<number, string>;
      assert.ok(senderMap instanceof Map && senderMap.has(999), "T-TgI.2: senderMap must have entry for 999");
    } finally {
      globalThis.fetch = origFetch;
      restore();
      if (savedToken !== undefined) process.env.TELEGRAM_TOKEN = savedToken;
      else delete process.env.TELEGRAM_TOKEN;
      cleanup();
    }
  });
});

// ─── T-TgI.3 ─────────────────────────────────────────────────────────────────

describe("runTelegramSubcommand('bind') — interactive path (getUpdates fails → manual fallback)", () => {
  it("T-TgI.3: when getUpdates returns ok=false (409-style), falls back to prompter.input and writes parsed userId", async () => {
    // Given: no userId; TELEGRAM_TOKEN set; stdin.isTTY=true; mocked telegramFetch returns {ok:false, description:"Conflict"}
    // When:  runTelegramSubcommand("bind", { tcPath }, mockPrompter) with input→"42424242"
    // Then:  telegram.json.boundUserId===42424242; telegramUserSelect MUST NOT be called; input called once

    const { tcPath, cleanup } = makeTmpTgDir();
    const restore = stubInteractive(true);
    const savedToken = process.env.TELEGRAM_TOKEN;
    process.env.TELEGRAM_TOKEN = "test-token-mock";
    const mp = makeMockPrompter({
      input: async () => "42424242",
    });
    // Mock globalThis.fetch to return ok=false (Conflict)
    const origFetch = globalThis.fetch;
    // biome-ignore lint/suspicious/noExplicitAny: test mock for telegramFetch transport
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ ok: false, description: "Conflict: another getUpdates request is active" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    try {
      await captureStdout(() => runTelegramSubcommand("bind", { tcPath }, mp));
      const cfg = readTcJson(tcPath);
      assert.equal(cfg.boundUserId, 42424242, "T-TgI.3: boundUserId must be parsed from input");
      assert.equal(
        mp.calls.telegramUserSelect.length,
        0,
        "T-TgI.3: telegramUserSelect MUST NOT be called on ok=false response",
      );
      assert.equal(mp.calls.input.length, 1, "T-TgI.3: input fallback must be called once");
    } finally {
      globalThis.fetch = origFetch;
      restore();
      if (savedToken !== undefined) process.env.TELEGRAM_TOKEN = savedToken;
      else delete process.env.TELEGRAM_TOKEN;
      cleanup();
    }
  });
});

// ─── T-TgI.4 ─────────────────────────────────────────────────────────────────

describe("runTelegramSubcommand('bind') — interactive path (empty senders)", () => {
  it("T-TgI.4: when getUpdates returns ok=true but result=[] (empty senders), prints informational message and returns WITHOUT calling prompts", async () => {
    // Given: no userId; TELEGRAM_TOKEN set; stdin.isTTY=true; mocked telegramFetch returns {ok:true, result:[]}
    // When:  runTelegramSubcommand("bind", { tcPath }, mockPrompter)
    // Then:  stdout contains "No recent senders found"; neither telegramUserSelect NOR input is called

    const { tcPath, cleanup } = makeTmpTgDir();
    const restore = stubInteractive(true);
    const savedToken = process.env.TELEGRAM_TOKEN;
    process.env.TELEGRAM_TOKEN = "test-token-mock";
    const mp = makeMockPrompter();
    // Mock globalThis.fetch to return ok=true with empty result
    const origFetch = globalThis.fetch;
    // biome-ignore lint/suspicious/noExplicitAny: test mock for telegramFetch transport
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    try {
      const stdout = await captureStdout(() => runTelegramSubcommand("bind", { tcPath }, mp));
      assert.ok(stdout.includes("No recent senders found"), `T-TgI.4: must print no-senders message; got: "${stdout}"`);
      assert.equal(mp.calls.telegramUserSelect.length, 0, "T-TgI.4: telegramUserSelect MUST NOT be called");
      assert.equal(mp.calls.input.length, 0, "T-TgI.4: input MUST NOT be called");
    } finally {
      globalThis.fetch = origFetch;
      restore();
      if (savedToken !== undefined) process.env.TELEGRAM_TOKEN = savedToken;
      else delete process.env.TELEGRAM_TOKEN;
      cleanup();
    }
  });
});
