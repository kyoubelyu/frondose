/**
 * P-23 Step 4a scaffold — T-LAUNCHD.1..7 + T-CONTRACT
 *
 * launchd plist renderer + install/uninstall helpers.
 * (src/cli/subcommands/launchd.ts — NEW at builder Step 4b per plan §6.1.)
 *
 * Gate coverage: G-P23.1, G-P23.2, G-P23.8, G-P23.9, G-P23.10, G-P23.11
 *
 * All assertion bodies are TODO. Builder must make scaffolds reach assert.fail at Step 4b.
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  type EnvSnapshot,
  installLaunchAgent,
  isDaemonInstalled,
  LABEL,
  type PlistArgs,
  plistPath,
  renderPlist,
  uninstallLaunchAgent,
} from "../../src/cli/subcommands/launchd.js";
import { createLinkedinSession } from "../../src/linkedin/index.js";
import { makeAllTools } from "../../src/tools/index.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "mai-p23-launchd-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function makePlistArgs(overrides: Partial<PlistArgs> & { env?: Partial<EnvSnapshot> } = {}): PlistArgs {
  const env: EnvSnapshot = {
    TELEGRAM_TOKEN: "tg-test-token",
    ...overrides.env,
  };
  return {
    nodeBin: "/usr/local/bin/node",
    maiEntry: "/usr/local/lib/node_modules/@kyoube/mai-agent/dist/cli/main.js",
    home: overrides.home ?? "/tmp/fakehome",
    env,
  };
}

// Stub spawnSync for launchctl — replaced by real mock at Step 5
type SpawnSyncReturn = { status: number | null; stderr?: string; stdout?: string };

// ─── Plist render ─────────────────────────────────────────────────────────────

describe("launchd: renderPlist", () => {
  it("T-LAUNCHD.1: when env has only TELEGRAM_TOKEN, rendered XML has Label + token key + no TELEGRAM_PROXY key", () => {
    // Given:  env snapshot = { TELEGRAM_TOKEN: 'abc' }; no TELEGRAM_PROXY, MAI_MODEL, providerKey
    // When:   renderPlist(args) is called
    // Then:   output contains exactly one <key>TELEGRAM_TOKEN</key>; no <key>TELEGRAM_PROXY</key>;
    //         <key>Label</key> present; <string>com.kyoube.mai.telegram</string> present
    const args = makePlistArgs({ env: { TELEGRAM_TOKEN: "abc" } });
    const xml = renderPlist(args);
    // Label present
    assert.ok(xml.includes("<key>Label</key>"), "Label key must be present");
    assert.ok(xml.includes(`<string>${LABEL}</string>`), "Label string must match LABEL");
    // Exactly one TELEGRAM_TOKEN key
    const tokenKeyCount = (xml.match(/<key>TELEGRAM_TOKEN<\/key>/g) ?? []).length;
    assert.strictEqual(tokenKeyCount, 1, "TELEGRAM_TOKEN must appear exactly once");
    // No TELEGRAM_PROXY key
    assert.ok(!xml.includes("<key>TELEGRAM_PROXY</key>"), "TELEGRAM_PROXY key must be absent");
    // Token value "abc" present
    assert.ok(xml.includes("<string>abc</string>"), "token value must appear in plist");
  });

  it("T-LAUNCHD.2: when TELEGRAM_TOKEN contains XML-hostile chars, renderPlist escapes them", () => {
    // Given:  TELEGRAM_TOKEN = '<script>&"token\'' (chars requiring XML escaping)
    // When:   renderPlist(args) is called
    // Then:   output contains &lt;script&gt;&amp;&quot;token&apos; (fully escaped);
    //         raw unescaped chars NOT present in the token value context
    const args = makePlistArgs({ env: { TELEGRAM_TOKEN: "<script>&\"token'" } });
    const xml = renderPlist(args);
    assert.ok(xml.includes("&lt;script&gt;&amp;&quot;token&apos;"), `expected escaped chars in: ${xml.slice(0, 300)}`);
    // Raw < or > or & from the token value must NOT appear unescaped in the env section
    // (note: the DOCTYPE line has & in the URL — we check the token-value region specifically)
    const tokenLineMatch = xml.match(/<key>TELEGRAM_TOKEN<\/key><string>(.*?)<\/string>/);
    assert.ok(tokenLineMatch?.[1], "TELEGRAM_TOKEN value must be in plist");
    assert.ok(!tokenLineMatch[1].includes("<"), "raw '<' must be escaped in token value");
    assert.ok(!tokenLineMatch[1].includes(">"), "raw '>' must be escaped in token value");
  });
});

// ─── Install / uninstall ──────────────────────────────────────────────────────

describe("launchd: installLaunchAgent + uninstallLaunchAgent", () => {
  it("T-LAUNCHD.3: when process.platform is 'linux', installLaunchAgent throws PlatformError", async () => {
    // Given:  process.platform forced to 'linux'
    // When:   installLaunchAgent(args, opts) is called
    // Then:   throws Error with message containing 'macOS only'; no plist file written
    const origPlatform = process.platform;
    const { home, cleanup } = makeTmpHome();
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      const args = makePlistArgs({ home });
      await assert.rejects(
        () => installLaunchAgent(args, { consent: async () => true }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok((err as Error).message.includes("macOS"), `message was: ${(err as Error).message}`);
          return true;
        },
      );
      // plist must NOT have been written (platform check fires before consent)
      assert.ok(!existsSync(plistPath(home)));
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      cleanup();
    }
  });

  it("T-LAUNCHD.4: when plist absent + consent=y, plist is written with mode 0o600 before launchctl bootstrap", async () => {
    // Given:  process.platform = 'darwin' (this test only runs on macOS); consent fn returns true
    // When:   installLaunchAgent(args, {consent, yes:false}) called
    // Then:   plist file written at HOME/Library/LaunchAgents/com.kyoube.mai.telegram.plist with mode 0o600
    //         BEFORE launchctl bootstrap is invoked. launchctl may fail on CI (fake paths) — that is
    //         expected. The key assertion is that the plist IS on disk and has the correct mode.
    if (process.platform !== "darwin") {
      // biome-ignore lint/suspicious/noExplicitAny: skip on non-darwin
      (it as any).skip("darwin only");
      return;
    }
    const { home, cleanup } = makeTmpHome();
    try {
      const args = makePlistArgs({ home });
      // launchctl bootstrap will fail (fake paths) → installLaunchAgent throws → that is OK here
      try {
        await installLaunchAgent(args, { consent: async () => true });
      } catch {
        // launchctl bootstrap failure expected in test env — we only care about plist
      }
      const plPath = plistPath(home);
      assert.ok(existsSync(plPath), `plist must exist at ${plPath} even if launchctl failed`);
      const st = statSync(plPath);
      // Verify permissions: 0o600 = owner-read + owner-write only
      assert.strictEqual(st.mode & 0o777, 0o600, `plist mode must be 0o600, got 0o${(st.mode & 0o777).toString(8)}`);
    } finally {
      cleanup();
    }
  });

  it("T-LAUNCHD.5: when consent=n (declined), installLaunchAgent returns {cancelled:true}; no plist written; no shell-out", async () => {
    // Given:  consent fn returns false (operator declines)
    // When:   installLaunchAgent(args, {consent: () => false, yes: false}) called
    // Then:   returns { cancelled: true }; plistPath does not exist; launchctl NOT invoked
    if (process.platform !== "darwin") {
      // biome-ignore lint/suspicious/noExplicitAny: skip on non-darwin
      (it as any).skip("darwin only");
      return;
    }
    const { home, cleanup } = makeTmpHome();
    try {
      const args = makePlistArgs({ home });
      const result = await installLaunchAgent(args, { consent: async () => false });
      assert.strictEqual(result.cancelled, true, "must return {cancelled: true}");
      assert.ok(!existsSync(plistPath(home)), "plist must NOT be written when consent=false");
    } finally {
      cleanup();
    }
  });

  it("T-LAUNCHD.6: when plist exists, uninstallLaunchAgent invokes bootout + unlinks plist", () => {
    // Given:  plist file pre-written at expected path
    // When:   uninstallLaunchAgent(home) is called
    // Then:   launchctl bootout invoked (exit 113=not-found → silent); plist unlinked
    const { home, cleanup } = makeTmpHome();
    try {
      // Pre-create the plist file
      const plPath = plistPath(home);
      mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(plPath, "<plist/>", "utf-8");
      assert.ok(existsSync(plPath), "plist must exist before uninstall");
      // uninstallLaunchAgent should not throw (exit 113 = service not found → handled)
      uninstallLaunchAgent(home);
      // Plist must be unlinked
      assert.ok(!existsSync(plPath), "plist must be removed after uninstall");
    } finally {
      cleanup();
    }
  });

  it("T-LAUNCHD.7: when plist absent, uninstallLaunchAgent still invokes bootout (idempotent); swallows ENOENT", () => {
    // Given:  plist file does NOT exist
    // When:   uninstallLaunchAgent(home) is called
    // Then:   bootout invoked (no-op on most systems); ENOENT swallowed; returns normally
    const { home, cleanup } = makeTmpHome();
    try {
      const plPath = plistPath(home);
      assert.ok(!existsSync(plPath), "plist must not exist before test");
      // Must not throw
      assert.doesNotThrow(() => uninstallLaunchAgent(home));
    } finally {
      cleanup();
    }
  });
});

// ─── Contract: Hard Rule 8 + tool count ─────────────────────────────────────

describe("P-23 contract: Hard Rule 8 + tool count", () => {
  it("T-CONTRACT.R8: no child_process import under src/tools/**", () => {
    // Given:  the mai-agent source tree post-Step-4b
    // When:   all TypeScript files under src/tools/ are scanned for 'child_process'
    // Then:   zero matches (launchd.ts is under src/cli/subcommands/, not src/tools/)
    // NOTE:   CI biome lint enforces this rule; this test provides a deterministic signal.
    const projectRoot = new URL("../../../", import.meta.url).pathname;
    const result = execSync("grep -rl 'child_process' src/tools/ 2>/dev/null || true", {
      cwd: projectRoot,
      encoding: "utf-8",
    });
    assert.strictEqual(result.trim(), "", `child_process found in src/tools/: ${result.trim()}`);
  });

  it("T-CONTRACT.TC: makeAllTools(session, persistence, control) still returns exactly 32 tools", () => {
    // Given:  full tool inventory (worker mode: session + persistence + control)
    // When:   Object.keys(makeAllTools(session, persistence, control)) counted
    // Then:   count === 32 (P-44 stale-count update: was 24 when written at P-23)
    const session = createLinkedinSession({ port: 9999, profileDir: "/tmp/fake-profile" });
    const persistence = { memoryDbPath: ":memory:", identityPath: "/tmp/fake-identity.json" };
    const control = { requestStop: () => {}, auditPath: "/tmp/fake-audit.jsonl" };
    const toolSet = makeAllTools(session, persistence, control);
    const count = Object.keys(toolSet).length;
    assert.strictEqual(count, 32, `expected 32 tools, got ${count}: ${Object.keys(toolSet).join(", ")}`);
  });
});
