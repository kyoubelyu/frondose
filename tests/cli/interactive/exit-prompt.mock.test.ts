/**
 * P-13 Step 4a — T-Exit.1 scaffold
 *
 * Tests: ExitPromptError caught at Commander action body → clean process.exit(0)
 * Gate coverage: G-P13.8
 *
 * NOTE: Imports @inquirer/core (NOT installed at Step 4a — added by builder Step 4b).
 * Test fails at import-resolution until Step 4b installs @inquirer/core.
 * Also imports _prompts.ts which does NOT exist at Step 4a.
 * Step 5 fills assertion body.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ExitPromptError } from "@inquirer/core";
import { runAuthSubcommand } from "../../../src/cli/subcommands/auth.js";
import { makeMockPrompter, stubInteractive, stubProcessExit } from "./_mockPrompter.js";

// ─── T-Exit.1 ────────────────────────────────────────────────────────────────

describe("ExitPromptError — clean exit via canonical D-2 catch pattern", () => {
  it("T-Exit.1: when prompter throws ExitPromptError and call is wrapped in D-2 try/catch, process.exit(0) is called", async () => {
    // Given: throwingPrompter.input throws new ExitPromptError on the first set prompt ("API base URL:")
    //        (P-21 — the URL set flow prompts input() first; providerSelect is no longer used in set)
    // When:  runAuthSubcommand("set", {}, throwingPrompter) wrapped in canonical try/catch
    // Then:  catch branch reached; process.exit(0) called (captured exit code === 0)

    const dir = mkdtempSync(join(tmpdir(), "mai-p13-exit-"));
    const authPath = join(dir, "auth.json");
    const restore = stubInteractive(true);
    const exitStub = stubProcessExit();

    // Throwing prompter: input (the first prompt in the URL set flow) throws ExitPromptError
    const throwingPrompter = makeMockPrompter({
      input: async () => {
        throw new ExitPromptError("User pressed Ctrl-C");
      },
    });

    try {
      // Apply the canonical D-2 try/catch pattern (same as what Commander action bodies do):
      // ExitPromptError from prompter → catch → process.exit(0)
      await assert.rejects(
        async () => {
          try {
            await runAuthSubcommand("set", { authPath }, throwingPrompter);
          } catch (e) {
            if (e instanceof ExitPromptError) {
              process.exit(0); // captured by stubProcessExit → throws "__mock_exit_0"
            }
            throw e;
          }
        },
        (err: Error) => err.message === "__mock_exit_0",
        "T-Exit.1: stubbed process.exit must be invoked (throws __mock_exit_0 sentinel)",
      );
      assert.equal(exitStub.exitCode, 0, "T-Exit.1: process.exit must be called with code 0 (clean cancel)");
    } finally {
      exitStub.restore();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
