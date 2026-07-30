/**
 * P-25 Step 5 — T-SRV.LAUNCHD.1..5
 *
 * Tests for serverLaunchd helpers (plist render + install/uninstall).
 * Gate coverage: G-P25.7, G-P25.8
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { describe, it } from "node:test";
import {
  type EnvSnapshot,
  installServerLaunchAgent,
  type PlistArgs,
  renderServerPlist,
  SERVER_LABEL,
  serverPlistPath,
  uninstallServerLaunchAgent,
} from "../../../src/cli/subcommands/serverLaunchd.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "mai-p25-srvclaunchd-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function makePlistArgs(overrides: Partial<PlistArgs> & { env?: Partial<EnvSnapshot> } = {}): PlistArgs {
  const env: EnvSnapshot = {
    TELEGRAM_TOKEN: "server-test-token",
    ...overrides.env,
  };
  return {
    nodeBin: "/usr/local/bin/node",
    maiEntry: "/usr/local/lib/node_modules/@kyoube/mai-agent/dist/cli/main.js",
    home: overrides.home ?? "/tmp/fakehome",
    env,
  };
}

// ─── T-SRV.LAUNCHD ────────────────────────────────────────────────────────────

describe("serverLaunchd helpers (G-P25.7, G-P25.8)", () => {
  it("T-SRV.LAUNCHD.1: renderServerPlist includes Label=com.kyoube.frondose.server, ProgramArguments=[..., 'server', 'daemon'], log paths under ~/.frondose/server/logs/", () => {
    // Given: PlistArgs with TELEGRAM_TOKEN="abc", nodeBin+maiEntry+home set
    // When:  renderServerPlist(args) called
    // Then:  output contains Label=SERVER_LABEL; ProgramArguments has 'server'+'daemon';
    //        StandardOutPath + StandardErrorPath under .frondose/server/logs/
    const args = makePlistArgs({ home: "/tmp/testserver" });
    const xml = renderServerPlist(args);

    // Label
    assert.ok(xml.includes("<key>Label</key>"), "Label key must be present");
    assert.ok(xml.includes(`<string>${SERVER_LABEL}</string>`), `Label value must be '${SERVER_LABEL}'`);
    assert.equal(SERVER_LABEL, "com.kyoube.frondose.server", "SERVER_LABEL must be com.kyoube.frondose.server");

    // ProgramArguments includes 'server' and 'daemon'
    assert.ok(xml.includes("<string>server</string>"), "ProgramArguments must include 'server'");
    assert.ok(xml.includes("<string>daemon</string>"), "ProgramArguments must include 'daemon'");

    // Log paths under .frondose/server/logs/
    assert.ok(xml.includes("server-daemon.out.log"), "StandardOutPath must name server-daemon.out.log");
    assert.ok(xml.includes("server-daemon.err.log"), "StandardErrorPath must name server-daemon.err.log");
    assert.ok(xml.includes(".frondose/server/logs/"), "log paths must be under .frondose/server/logs/");

    // TELEGRAM_TOKEN in env
    assert.ok(xml.includes("<key>TELEGRAM_TOKEN</key>"), "TELEGRAM_TOKEN key must be present");
    assert.ok(xml.includes("<string>server-test-token</string>"), "TELEGRAM_TOKEN value must be present");
  });

  it("T-SRV.LAUNCHD.2: installServerLaunchAgent({...}, {yes:true}) writes plist at 0o600 before launchctl; macOS only", async () => {
    // Given: process.platform = "darwin" (test skipped on non-darwin); yes=true (bypass consent)
    // When:  installServerLaunchAgent(args, {yes:true, consent: () => true}) called
    // Then:  plist file written at serverPlistPath(home) with mode 0o600;
    //        launchctl bootstrap may fail in test env (fake paths) — that is expected
    if (process.platform !== "darwin") {
      return; // skip on non-darwin
    }
    const { home, cleanup } = makeTmpHome();
    try {
      const args = makePlistArgs({ home });
      // launchctl bootstrap may fail — we only care about plist written before that
      try {
        await installServerLaunchAgent(args, { yes: true, consent: async () => true });
      } catch {
        // launchctl bootstrap failure expected in test env (fake node/mai paths)
      }
      const plPath = serverPlistPath(home);
      assert.ok(existsSync(plPath), `plist must be written at ${plPath} even if launchctl fails`);
      const st = statSync(plPath);
      assert.strictEqual(st.mode & 0o777, 0o600, `plist mode must be 0o600 (got 0o${(st.mode & 0o777).toString(8)})`);
    } finally {
      cleanup();
    }
  });

  it("T-SRV.LAUNCHD.3: installServerLaunchAgent with process.platform='linux' throws 'mai server launchd integration is macOS-only'; no plist written", async () => {
    // Given: process.platform overridden to "linux"
    // When:  installServerLaunchAgent(args, {yes:true}) called
    // Then:  throws Error("mai server launchd integration is macOS-only");
    //        no plist file written under home
    const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const { home, cleanup } = makeTmpHome();
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      const args = makePlistArgs({ home });
      await assert.rejects(
        () => installServerLaunchAgent(args, { yes: true, consent: async () => true }),
        (err: unknown) => {
          assert.ok(err instanceof Error, `expected Error, got ${String(err)}`);
          assert.ok(
            (err as Error).message.includes("macOS-only"),
            `error must mention 'macOS-only'; got: ${(err as Error).message}`,
          );
          return true;
        },
      );
      // No plist written
      assert.ok(!existsSync(serverPlistPath(home)), "plist must NOT be written when platform check fails");
    } finally {
      if (savedPlatform) Object.defineProperty(process, "platform", savedPlatform);
      cleanup();
    }
  });

  it("T-SRV.LAUNCHD.4: uninstallServerLaunchAgent with plist present — bootout invoked (may fail); plist unlinked", () => {
    // Given: plist exists at serverPlistPath(home); spawnSync('launchctl bootout') runs (may return non-0)
    // When:  uninstallServerLaunchAgent(home) called
    // Then:  plist file no longer exists (always unlinked regardless of launchctl result)
    const { home, cleanup } = makeTmpHome();
    try {
      const plPath = serverPlistPath(home);
      mkdirSync(path.dirname(plPath), { recursive: true });
      writeFileSync(plPath, "<plist/>", "utf-8");
      assert.ok(existsSync(plPath), "plist must exist before uninstall");

      // uninstallServerLaunchAgent: bootout may return 113 (not loaded) — that is tolerated
      uninstallServerLaunchAgent(home);

      assert.ok(!existsSync(plPath), "plist must be removed by uninstall");
    } finally {
      cleanup();
    }
  });

  it("T-SRV.LAUNCHD.5: uninstallServerLaunchAgent with plist absent — bootout still invoked; ENOENT on unlink swallowed; no throw", () => {
    // Given: plist does NOT exist; spawnSync returns 113 (already unloaded)
    // When:  uninstallServerLaunchAgent(home) called
    // Then:  no throw; ENOENT on unlink silently ignored
    const { home, cleanup } = makeTmpHome();
    try {
      assert.ok(!existsSync(serverPlistPath(home)), "plist must not exist before test");
      // Must not throw even though plist is absent
      assert.doesNotThrow(() => uninstallServerLaunchAgent(home), "uninstall with absent plist must not throw");
    } finally {
      cleanup();
    }
  });
});
