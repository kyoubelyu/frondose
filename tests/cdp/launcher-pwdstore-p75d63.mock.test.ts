/**
 * P-75.D6.3 mock test scaffold — T-PWD.1–6
 *
 * Pins the chromeFlags contract after the P-15 filter+push block is removed
 * from src/cdp/launcher.ts (Step 4 — Codex). The root-cause: ad-hoc-signed
 * Frondose cannot read the macOS Keychain "Chrome Safe Storage" ACL
 * (errSecInteractionNotAllowed -25308), so --password-store=default (the P-15
 * push) causes every cookie write to fail and the LinkedIn session is lost on
 * every restart. The fix: remove the P-15 block so chrome-launcher's
 * DEFAULT_FLAGS flow through unmodified — this restores --use-mock-keychain
 * (the macOS cookie-persistence load-bearing flag, empirically proven
 * docs/phase-75-d6-3-plan.md §1.4: 3/3 stable cookie round-trips).
 *
 * Harness: mirrors tests/cdp/launcher.mock.test.ts T-M2 — uses __setLaunchFn
 * DI seam (src/cdp/launcher.ts:28-33) to inject a fake launch fn that captures
 * opts.chromeFlags without spawning real Chrome. try/finally restores the real
 * chromeLaunch after each test so state does not leak.
 *
 * Step 3a scaffolds: REAL assertions written now. Tests intentionally fail at
 * HEAD because the P-15 block is still present (filters --use-mock-keychain out
 * and pushes --password-store=default). They pass after Codex Step 4 lands the
 * bare-removal fix.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { launch as chromeLaunch } from "chrome-launcher";
import { __setLaunchFn, ensureChrome } from "../../src/cdp/launcher.js";

// ─── Shared harness ───────────────────────────────────────────────────────────

/** Allocate a port in the ephemeral range very unlikely to be in use. */
function probeFailPort(): number {
  return 49200 + Math.floor(Math.random() * 500);
}

/**
 * Set up a fake launchFn, call ensureChrome, capture opts, then restore the
 * real launchFn in the finally block. Returns the captured opts.
 */
async function captureChromeFlagsOpts(port: number, profileDir: string): Promise<Record<string, unknown>> {
  let capturedOpts: Record<string, unknown> = {};
  // biome-ignore lint/suspicious/noExplicitAny: test mock requires type cast to match LaunchFn signature
  __setLaunchFn(async (opts: any) => {
    capturedOpts = { ...opts };
    return {
      pid: 12345,
      port: opts?.port ?? port,
      kill: () => {},
      process: null as unknown as import("child_process").ChildProcess,
      remoteDebuggingPipes: null,
    };
  });
  try {
    await ensureChrome({ port, profileDir });
  } finally {
    __setLaunchFn(chromeLaunch);
  }
  return capturedOpts;
}

// ─── T-PWD describe block ─────────────────────────────────────────────────────

describe("P-75.D6.3 chromeFlags contract — DEFAULT_FLAGS flow-through (bare removal of P-15 block)", () => {
  // ─── T-PWD.1 ────────────────────────────────────────────────────────────────

  it(
    "T-PWD.1: when ensureChrome launches, chromeFlags MUST include --use-mock-keychain",
    async () => {
      // Given: a free port (probe fails), a temp profileDir, fake launchFn via __setLaunchFn
      // When:  ensureChrome runs → probe fails → launchFn is called → opts.chromeFlags captured
      // Then:  captured chromeFlags includes "--use-mock-keychain" (the macOS ACL-bypass flag)
      const port = probeFailPort();
      const profileDir = mkdtempSync(join(tmpdir(), "mai-t-pwd1-"));
      try {
        const capturedOpts = await captureChromeFlagsOpts(port, profileDir);
        const flags = capturedOpts.chromeFlags as string[];
        assert.ok(
          Array.isArray(flags),
          "chromeFlags must be an array",
        );
        assert.ok(
          flags.includes("--use-mock-keychain"),
          `chromeFlags must include "--use-mock-keychain" (macOS Keychain-bypass; empirically proven §1.4); got: ${JSON.stringify(flags)}`,
        );
      } finally {
        rmSync(profileDir, { recursive: true, force: true });
      }
    },
  );

  // ─── T-PWD.2 ────────────────────────────────────────────────────────────────

  it(
    "T-PWD.2: when ensureChrome launches, chromeFlags MUST NOT include --password-store=default",
    async () => {
      // Given: a free port (probe fails), a temp profileDir, fake launchFn via __setLaunchFn
      // When:  ensureChrome runs → probe fails → launchFn is called → opts.chromeFlags captured
      // Then:  captured chromeFlags does NOT contain "--password-store=default"
      //        (that flag forces the macOS Keychain path; ad-hoc binary cannot pass ACL)
      const port = probeFailPort();
      const profileDir = mkdtempSync(join(tmpdir(), "mai-t-pwd2-"));
      try {
        const capturedOpts = await captureChromeFlagsOpts(port, profileDir);
        const flags = capturedOpts.chromeFlags as string[];
        assert.ok(
          Array.isArray(flags),
          "chromeFlags must be an array",
        );
        assert.ok(
          !flags.includes("--password-store=default"),
          `chromeFlags must NOT include "--password-store=default" (triggers Keychain ACL rejection); got: ${JSON.stringify(flags)}`,
        );
      } finally {
        rmSync(profileDir, { recursive: true, force: true });
      }
    },
  );

  // ─── T-PWD.3 ────────────────────────────────────────────────────────────────

  it(
    "T-PWD.3: chromeFlags MAY include --password-store=basic — explicit NON-pin (no assertion)",
    async () => {
      // Given: same setup as T-PWD.1
      // When:  ensureChrome launches and opts are captured
      // Then:  NO assertion on --password-store=basic — it is a Linux-side flag
      //        (GNOME/KDE Wallet) with no effect on macOS os_crypt; DEFAULT_FLAGS
      //        ships it; we deliberately do NOT pin its presence or absence.
      //        This test exists purely as a contract comment proving the omission is intentional.
      const port = probeFailPort();
      const profileDir = mkdtempSync(join(tmpdir(), "mai-t-pwd3-"));
      try {
        const capturedOpts = await captureChromeFlagsOpts(port, profileDir);
        const flags = capturedOpts.chromeFlags as string[];
        assert.ok(Array.isArray(flags), "chromeFlags must be an array (sanity)");
        // Deliberately no assertion on --password-store=basic.
        // Probe §1.4 proved it is irrelevant on macOS os_crypt; we don't care.
      } finally {
        rmSync(profileDir, { recursive: true, force: true });
      }
    },
  );

  // ─── T-PWD.4 ────────────────────────────────────────────────────────────────

  it(
    "T-PWD.4: ensureChrome still passes ignoreDefaultFlags:true to launchFn (regression guard)",
    async () => {
      // Given: same setup as T-PWD.1
      // When:  ensureChrome launches, opts captured
      // Then:  capturedOpts.ignoreDefaultFlags === true
      //        (without this chrome-launcher would re-apply defaults on top, doubling entries)
      const port = probeFailPort();
      const profileDir = mkdtempSync(join(tmpdir(), "mai-t-pwd4-"));
      try {
        const capturedOpts = await captureChromeFlagsOpts(port, profileDir);
        assert.strictEqual(
          capturedOpts.ignoreDefaultFlags,
          true,
          "ignoreDefaultFlags must be true (prevents chrome-launcher doubling DEFAULT_FLAGS on top of our explicit spread)",
        );
      } finally {
        rmSync(profileDir, { recursive: true, force: true });
      }
    },
  );

  // ─── T-PWD.5 ────────────────────────────────────────────────────────────────

  it(
    "T-PWD.5: --use-mock-keychain MUST appear exactly once in chromeFlags",
    async () => {
      // Given: same setup as T-PWD.1
      // When:  ensureChrome launches, opts captured
      // Then:  exactly one occurrence of "--use-mock-keychain" in chromeFlags
      //        (guards against accidental duplication if a future edit reintroduces a push)
      const port = probeFailPort();
      const profileDir = mkdtempSync(join(tmpdir(), "mai-t-pwd5-"));
      try {
        const capturedOpts = await captureChromeFlagsOpts(port, profileDir);
        const flags = capturedOpts.chromeFlags as string[];
        const occurrences = flags.filter((f) => f === "--use-mock-keychain").length;
        assert.strictEqual(
          occurrences,
          1,
          `"--use-mock-keychain" must appear exactly once in chromeFlags; found ${occurrences} occurrence(s). Full flags: ${JSON.stringify(flags)}`,
        );
      } finally {
        rmSync(profileDir, { recursive: true, force: true });
      }
    },
  );

  // ─── T-PWD.6 ────────────────────────────────────────────────────────────────

  it(
    "T-PWD.6: T-M2 contract preserved — handle shape, port, userDataDir, handleSIGINT, Array.isArray(chromeFlags)",
    async () => {
      // Given: same setup as T-PWD.1
      // When:  ensureChrome launches
      // Then:  handle.launched===true, handle.port===port, typeof handle.kill==="function",
      //        capturedOpts.userDataDir===profileDir, capturedOpts.handleSIGINT===true,
      //        Array.isArray(capturedOpts.chromeFlags) — identical asserts to T-M2;
      //        explicit non-regression pin against the bare-removal edit
      const port = probeFailPort();
      const profileDir = mkdtempSync(join(tmpdir(), "mai-t-pwd6-"));
      let capturedOpts: Record<string, unknown> = {};
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires type cast to match LaunchFn signature
      __setLaunchFn(async (opts: any) => {
        capturedOpts = { ...opts };
        return {
          pid: 12346,
          port: opts?.port ?? port,
          kill: () => {},
          process: null as unknown as import("child_process").ChildProcess,
          remoteDebuggingPipes: null,
        };
      });
      try {
        const handle = await ensureChrome({ port, profileDir });

        assert.strictEqual(handle.launched, true, "handle.launched must be true on launch path");
        assert.strictEqual(handle.port, port, "handle.port must match the requested port");
        assert.strictEqual(typeof handle.kill, "function", "handle.kill must be a function on launch path");

        assert.strictEqual(capturedOpts.userDataDir, profileDir, "capturedOpts.userDataDir must equal profileDir");
        assert.strictEqual(capturedOpts.handleSIGINT, true, "capturedOpts.handleSIGINT must be true");
        assert.ok(Array.isArray(capturedOpts.chromeFlags), "capturedOpts.chromeFlags must be an array");
      } finally {
        __setLaunchFn(chromeLaunch);
        rmSync(profileDir, { recursive: true, force: true });
      }
    },
  );
});
