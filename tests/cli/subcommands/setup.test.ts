/**
 * P-52 Step 5 — T-Setup.1 (G-P52.6) — assertion body filled.
 *
 * Drives `runSetupSubcommand` (public API) with `sections=['soul']` selection
 * via a stubbed Prompter, against a fresh tmp `identityPath` that does NOT
 * exist. Asserts:
 *  - the soul section's axisSelect is NEVER called (BLOCKER-3 ordering fix —
 *    readIdentity guard runs BEFORE promptFreeAxesInteractive);
 *  - a visible stdout error is written containing both 'Soul section' and 'Identity';
 *  - the function returns cleanly (the wizard's other sections continue).
 *
 * Gate coverage: G-P52.6 (and the §6.9 BLOCKER-3 ordering fix).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runSetupSubcommand } from "../../../src/cli/subcommands/setup.js";
import type { Prompter } from "../../../src/cli/subcommands/_prompts.js";

/** Stubbed Prompter — only `checkboxSections` returns soul; axisSelect throws
 *  to make any accidental invocation visible to the test. */
function makeStubPrompter(): { prompter: Prompter; axisSelectCalls: () => number } {
  let axisSelectCount = 0;
  const prompter: Prompter = {
    providerSelect: async () => {
      throw new Error("unexpected providerSelect call — soul-section only");
    },
    apiKeyInput: async () => {
      throw new Error("unexpected apiKeyInput call");
    },
    confirmDefault: async () => false,
    sessionsSelect: async () => {
      throw new Error("unexpected sessionsSelect call");
    },
    schedulesSelect: async () => null,
    telegramUserSelect: async () => null,
    confirm: async () => false, // isSoulConfigured reconfig-prompt: caller passes false default for missing identity anyway
    axisSelect: async () => {
      axisSelectCount += 1;
      throw new Error("axisSelect must NOT be called when identity.json is absent (T-Setup.1 BLOCKER-3 ordering fix)");
    },
    input: async () => {
      throw new Error("unexpected input call");
    },
    checkboxSections: async () => ["soul"],
    modelSelect: async () => {
      throw new Error("unexpected modelSelect call");
    },
  };
  return { prompter, axisSelectCalls: () => axisSelectCount };
}

// ─── T-Setup.1 ───────────────────────────────────────────────────────────────

describe("runSoulSection — visible stdout error + axisSelect-not-called when identity absent (G-P52.6, BLOCKER-3)", () => {
  it("T-Setup.1: when runSetupSubcommand is invoked with sections=['soul'] AND opts.identityPath points to a nonexistent file, the soul section prints a visible stdout error containing both 'Soul section' AND 'Identity', the prompter.axisSelect is NEVER called (BLOCKER-3 ordering — readIdentity fails first), and the function returns cleanly so other selected sections continue in the same wizard run.", async () => {
    // Given: a stubbed Prompter that returns ['soul'] for checkboxSections
    //        AND throws on axisSelect; opts.identityPath = nonexistent tmp path;
    //        process.stdin.isTTY shimmed to true so isInteractive() returns true.
    //        Capture process.stdout.write to a buffer.
    // When:  runSetupSubcommand(opts, prompter) runs.
    // Then:  (a) axisSelectCalls === 0 (BLOCKER-3 ordering — readIdentity guard
    //            runs BEFORE promptFreeAxesInteractive);
    //        (b) captured stdout contains 'Soul section' AND 'Identity';
    //        (c) runSetupSubcommand resolves without throwing.
    const dir = mkdtempSync(join(tmpdir(), "mai-p52-setup-"));
    const identityPath = join(dir, "identity.json"); // intentionally NOT created — readIdentity returns null

    // Shim process.stdin.isTTY for isInteractive() and clear MAI_NO_INTERACTIVE.
    const origIsTty = process.stdin.isTTY;
    const origMNI = process.env.MAI_NO_INTERACTIVE;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    delete process.env.MAI_NO_INTERACTIVE;

    // Shim MAI_HOME_BASE so readIdentity's DEFAULT_CONFIG_PATH() fallback
    // resolves under the tmp dir (where no config.json/identity.json exists).
    // Without this, readIdentity would read the operator's real
    // ~/.mai/agent/config.json which DOES have an identity → the soul
    // section's `isSoulConfigured` would return true and the test path
    // would never reach the missing-identity guard at §6.9.
    const origHB = process.env.MAI_HOME_BASE;
    process.env.MAI_HOME_BASE = dir;

    // Capture stdout.
    const stdoutChunks: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    // biome-ignore lint/suspicious/noExplicitAny: monkey-patch stdout for capture
    (process.stdout as any).write = (chunk: any, ...rest: any[]): boolean => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return origStdoutWrite(chunk, ...rest);
    };

    try {
      const { prompter, axisSelectCalls } = makeStubPrompter();
      await runSetupSubcommand(
        {
          authPath: join(dir, "auth.json"),
          identityPath,
          tcPath: join(dir, "telegram.json"),
          schedulePath: join(dir, "schedule.jsonl"),
          memoryDbPath: join(dir, "memory.sqlite"),
          cdpPort: 9999,
        },
        prompter,
      );

      // (a) The axes prompt MUST NOT have been called.
      assert.equal(
        axisSelectCalls(),
        0,
        "axisSelect must NOT be called when identity.json is absent — BLOCKER-3 ordering fix (readIdentity guard runs BEFORE the axes prompt)",
      );

      // (b) Visible stdout error containing 'Soul section' AND 'Identity'.
      const stdoutText = stdoutChunks.join("");
      assert.ok(
        stdoutText.includes("Soul section"),
        `stdout must contain 'Soul section' (visible operator-facing error); got: ${JSON.stringify(stdoutText.slice(0, 400))}`,
      );
      assert.ok(
        stdoutText.includes("Identity"),
        `stdout must mention 'Identity' so the operator knows which section to complete first; got: ${JSON.stringify(stdoutText.slice(0, 400))}`,
      );
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore stdout
      (process.stdout as any).write = origStdoutWrite;
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTty, configurable: true });
      if (origMNI === undefined) delete process.env.MAI_NO_INTERACTIVE;
      else process.env.MAI_NO_INTERACTIVE = origMNI;
      if (origHB === undefined) delete process.env.MAI_HOME_BASE;
      else process.env.MAI_HOME_BASE = origHB;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
