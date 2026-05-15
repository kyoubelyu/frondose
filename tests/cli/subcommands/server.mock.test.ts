/**
 * P-25 Step 5 — T-SRV.STATUS.1, T-SRV.BIND.1..2, T-SRV.IDENT.INIT.1..2
 *
 * Tests for mai server action dispatcher (runServerSubcommand).
 * Gate coverage: G-P25.9, G-P25.10, G-P25.11
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Prompter } from "../../../src/cli/subcommands/_prompts.js";
import { runServerSubcommand } from "../../../src/cli/subcommands/server.js";
import { serverPlistPath } from "../../../src/cli/subcommands/serverLaunchd.js";
import { readConfig } from "../../../src/persistence/config.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p25-srvsubcmd-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stdout as any).write = (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stdout as any).write = orig;
  }
  return chunks.join("");
}

async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stderr as any).write = (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stderr as any).write = orig;
  }
  return chunks.join("");
}

/** Returns a mutable `captured` object — safe to check after mock throws. */
function mockProcessExit(): { captured: { value: number | null }; restore: () => void } {
  const captured = { value: null as number | null };
  const orig = process.exit.bind(process);
  // biome-ignore lint/suspicious/noExplicitAny: test mock — throw to halt execution
  (process as any).exit = (code?: number) => {
    captured.value = code ?? 0;
    throw new Error(`process.exit(${code ?? 0})`);
  };
  return {
    captured,
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = orig;
    },
  };
}

function makeMockPrompterAcceptSuggestion(): Prompter {
  return {
    providerSelect: async () => "",
    apiKeyInput: async () => "mock-key",
    confirmDefault: async () => false,
    sessionsSelect: async () => "",
    schedulesSelect: async () => null,
    telegramUserSelect: async () => null,
    confirm: async () => false,
    axisSelect: async () => "",
    input: async () => "", // returns "" → falls back to suggestion
    checkboxSections: async () => [],
    modelSelect: async () => "",
  };
}

// ─── T-SRV.STATUS ─────────────────────────────────────────────────────────────

describe("runServerSubcommand: status (G-P25.9)", () => {
  it("T-SRV.STATUS.1: when server.pid present with live PID + plist installed + telegram bound, stdout contains pid/alive/plist/bound_user_id fields", async () => {
    // Given: server.pid with live PID (process.pid); plist at serverPlistPath(home);
    //        config.json with telegram.boundUserId=42; server-daemon.err.log with one line
    // When:  runServerSubcommand("status", {pidPath, serverConfigPath})
    // Then:  stdout contains "pid:" AND "alive=true" AND "plist: installed" AND "bound_user_id: 42"
    const { dir, cleanup } = makeTmpDir();
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = dir;

      // Create server.pid
      const maiServerDir = join(dir, ".mai", "server");
      mkdirSync(maiServerDir, { recursive: true });
      const pidPath = join(maiServerDir, "server.pid");
      writeFileSync(pidPath, String(process.pid), "utf-8");

      // Create plist (at HOME-relative path; serverPlistPath() uses os.homedir() = dir)
      const plPath = serverPlistPath(); // uses os.homedir() which = dir since HOME overridden
      mkdirSync(join(dir, "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(plPath, "<plist/>", "utf-8");

      // Create config.json with boundUserId=42
      const cfgPath = join(maiServerDir, "config.json");
      writeFileSync(cfgPath, JSON.stringify({ schema_version: 1, telegram: { boundUserId: 42 } }), "utf-8");

      // Create err.log
      const logsDir = join(maiServerDir, "logs");
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(join(logsDir, "server-daemon.err.log"), "test error line\n", "utf-8");

      const stdout = await captureStdout(() => runServerSubcommand("status", { pidPath, serverConfigPath: cfgPath }));

      assert.ok(stdout.includes(`pid: ${process.pid}`), `stdout must contain pid; got: ${stdout}`);
      assert.ok(stdout.includes("alive=true"), `stdout must contain alive=true; got: ${stdout}`);
      assert.ok(stdout.includes("plist: installed"), `stdout must contain plist: installed; got: ${stdout}`);
      assert.ok(stdout.includes("bound_user_id: 42"), `stdout must contain bound_user_id: 42; got: ${stdout}`);
      assert.ok(stdout.includes("last_error_log: test error line"), `stdout must contain err.log tail; got: ${stdout}`);
    } finally {
      process.env.HOME = savedHome;
      cleanup();
    }
  });
});

// ─── T-SRV.BIND ───────────────────────────────────────────────────────────────

describe("runServerSubcommand: bind (G-P25.10)", () => {
  it("T-SRV.BIND.1: with MAI_SERVER_TELEGRAM_TOKEN set and userId=42 arg, writes boundUserId=42 to server config.json", async () => {
    // Given: MAI_SERVER_TELEGRAM_TOKEN="bot1" set in env; userId=42 passed as opt
    // When:  runServerSubcommand("bind", {userId:42, serverConfigPath})
    // Then:  config.json.telegram.boundUserId === 42
    const { dir, cleanup } = makeTmpDir();
    const savedToken = process.env.MAI_SERVER_TELEGRAM_TOKEN;
    try {
      process.env.MAI_SERVER_TELEGRAM_TOKEN = "bot1";
      const cfgPath = join(dir, "config.json");

      await runServerSubcommand("bind", { userId: 42, serverConfigPath: cfgPath });

      const cfg = readConfig(cfgPath);
      assert.equal(cfg.telegram.boundUserId, 42, "boundUserId must be 42 after bind");
    } finally {
      if (savedToken !== undefined) process.env.MAI_SERVER_TELEGRAM_TOKEN = savedToken;
      else delete process.env.MAI_SERVER_TELEGRAM_TOKEN;
      cleanup();
    }
  });

  it("T-SRV.BIND.2: when MAI_SERVER_TELEGRAM_TOKEN is unset, exits 1 with stderr naming MAI_SERVER_TELEGRAM_TOKEN", async () => {
    // Given: MAI_SERVER_TELEGRAM_TOKEN unset
    // When:  runServerSubcommand("bind", {userId:42, ...})
    // Then:  process.exit(1) called; stderr mentions "MAI_SERVER_TELEGRAM_TOKEN"
    const { dir, cleanup } = makeTmpDir();
    const savedToken = process.env.MAI_SERVER_TELEGRAM_TOKEN;
    const { captured, restore } = mockProcessExit();
    let stderr = "";
    try {
      delete process.env.MAI_SERVER_TELEGRAM_TOKEN;
      const cfgPath = join(dir, "config.json");
      stderr = await captureStderr(() =>
        runServerSubcommand("bind", { userId: 42, serverConfigPath: cfgPath }).catch(() => {}),
      );
      assert.equal(captured.value, 1, "process.exit(1) must be called");
      assert.ok(
        stderr.includes("MAI_SERVER_TELEGRAM_TOKEN"),
        `stderr must mention MAI_SERVER_TELEGRAM_TOKEN; got: ${stderr}`,
      );
    } finally {
      restore();
      if (savedToken !== undefined) process.env.MAI_SERVER_TELEGRAM_TOKEN = savedToken;
      cleanup();
    }
  });
});

// ─── T-SRV.IDENT.INIT ─────────────────────────────────────────────────────────

describe("runServerSubcommand: identity-init (G-P25.11)", () => {
  it("T-SRV.IDENT.INIT.1: when worker identity.json has fullName='Alice' + server identity absent, identity init writes operatorName='Alice' after prompter confirms", async () => {
    // Given: worker identity.json with fullName="Alice"; server identity.json absent;
    //        mock prompter whose input() returns "" (accept suggestion)
    // When:  runServerSubcommand("identity-init", {serverIdentityPath, workerIdentityPath, prompter, reset:false})
    // Then:  server identity.json written; operatorName === "Alice"
    const { dir, cleanup } = makeTmpDir();
    try {
      const workerIdentPath = join(dir, "worker-identity.json");
      const serverIdentPath = join(dir, "server-identity.json");
      writeFileSync(
        workerIdentPath,
        JSON.stringify({ fullName: "Alice", role: "CEO", company: "Acme", updatedAt: new Date().toISOString() }),
        "utf-8",
      );

      // Mock prompter: input() returns "" → falls back to suggestion ("Alice")
      const prompter = makeMockPrompterAcceptSuggestion();

      await runServerSubcommand("identity-init", {
        serverIdentityPath: serverIdentPath,
        workerIdentityPath: workerIdentPath,
        prompter,
        reset: false,
      });

      assert.ok(existsSync(serverIdentPath), "server identity.json must be written");
      const written = JSON.parse(readFileSync(serverIdentPath, "utf-8"));
      assert.equal(written.operatorName, "Alice", "operatorName must be auto-suggested from worker identity");
    } finally {
      cleanup();
    }
  });

  it("T-SRV.IDENT.INIT.2: when server identity already exists and reset=false, prints 'already exists' message; exits 0 without modifying file", async () => {
    // Given: server identity.json exists
    // When:  runServerSubcommand("identity-init", {reset:false})
    // Then:  stdout contains "already exists" OR "Use --reset"; file unchanged; no throw
    const { dir, cleanup } = makeTmpDir();
    try {
      const serverIdentPath = join(dir, "server-identity.json");
      const originalContent = JSON.stringify({
        operatorName: "Original",
        orchestratorName: "mai-server",
        orchestratorRole: "Operator's chief-of-staff agent",
        priorities: [],
        traits: [],
        updatedAt: new Date().toISOString(),
      });
      writeFileSync(serverIdentPath, originalContent, "utf-8");

      const stdout = await captureStdout(() =>
        runServerSubcommand("identity-init", {
          serverIdentityPath: serverIdentPath,
          workerIdentityPath: join(dir, "nonexistent-worker.json"),
          reset: false,
        }),
      );

      // Must print "already exists" message
      const hasMessage = stdout.includes("already exists") || stdout.includes("Use --reset");
      assert.ok(hasMessage, `stdout must mention 'already exists' or 'Use --reset'; got: ${stdout}`);

      // File must be unchanged
      const afterContent = readFileSync(serverIdentPath, "utf-8");
      assert.equal(afterContent, originalContent, "file must not be modified when reset=false");
    } finally {
      cleanup();
    }
  });
});
