/**
 * P-13 Step 4a — T-Prompts.1..4 scaffolds
 *
 * Covers G-P13.1: isInteractive() correctness across TTY × FRONDOSE_NO_INTERACTIVE
 * matrix + sanitizePasted strips markers.
 *
 * NOTE: Imports from src/cli/subcommands/_prompts.ts which does NOT exist at
 * Step 4a. All tests will fail at import-resolution until builder Step 4b creates
 * the file. This is the expected scaffold failure mode.
 *
 * Step 5 fills assertion bodies.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isInteractive, sanitizePasted } from "../../src/cli/subcommands/_prompts.js";

// ─── T-Prompts.1 ─────────────────────────────────────────────────────────────

describe("isInteractive() — TTY detection", () => {
  it("T-Prompts.1: when stdin.isTTY === true AND FRONDOSE_NO_INTERACTIVE unset, returns true", async () => {
    // Given: test stubs process.stdin.isTTY = true and FRONDOSE_NO_INTERACTIVE is unset
    // When:  isInteractive() is called
    // Then:  returns true (TTY + no override flag)

    const savedIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    const savedFlag = process.env.FRONDOSE_NO_INTERACTIVE;
    try {
      (process.stdin as { isTTY?: boolean }).isTTY = true;
      delete process.env.FRONDOSE_NO_INTERACTIVE;

      const result = isInteractive();
      assert.equal(result, true, "T-Prompts.1: isInteractive() must return true when TTY and flag unset");
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = savedIsTTY;
      if (savedFlag !== undefined) process.env.FRONDOSE_NO_INTERACTIVE = savedFlag;
      else delete process.env.FRONDOSE_NO_INTERACTIVE;
    }
  });

  it("T-Prompts.2: when stdin.isTTY === true AND FRONDOSE_NO_INTERACTIVE === '1', returns false", async () => {
    // Given: TTY is true but FRONDOSE_NO_INTERACTIVE flag is set to "1"
    // When:  isInteractive() is called
    // Then:  returns false (flag overrides TTY)

    const savedIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    const savedFlag = process.env.FRONDOSE_NO_INTERACTIVE;
    try {
      (process.stdin as { isTTY?: boolean }).isTTY = true;
      process.env.FRONDOSE_NO_INTERACTIVE = "1";

      const result = isInteractive();
      assert.equal(
        result,
        false,
        "T-Prompts.2: isInteractive() must return false when FRONDOSE_NO_INTERACTIVE=1 overrides TTY",
      );
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = savedIsTTY;
      if (savedFlag !== undefined) process.env.FRONDOSE_NO_INTERACTIVE = savedFlag;
      else delete process.env.FRONDOSE_NO_INTERACTIVE;
    }
  });

  it("T-Prompts.3: when stdin.isTTY is undefined (piped stdin), returns false regardless of FRONDOSE_NO_INTERACTIVE", async () => {
    // Given: process.stdin.isTTY is undefined (non-TTY/piped environment)
    // When:  isInteractive() is called
    // Then:  returns false (undefined !== true)

    const savedIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    const savedFlag = process.env.FRONDOSE_NO_INTERACTIVE;
    try {
      (process.stdin as { isTTY?: boolean }).isTTY = undefined;
      delete process.env.FRONDOSE_NO_INTERACTIVE;

      const result = isInteractive();
      assert.equal(
        result,
        false,
        "T-Prompts.3: isInteractive() must return false when stdin.isTTY is undefined (piped)",
      );
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = savedIsTTY;
      if (savedFlag !== undefined) process.env.FRONDOSE_NO_INTERACTIVE = savedFlag;
      else delete process.env.FRONDOSE_NO_INTERACTIVE;
    }
  });
});

// ─── T-Prompts.4 ─────────────────────────────────────────────────────────────

describe("sanitizePasted() — bracketed-paste marker stripping", () => {
  it("T-Prompts.4: strips \\x1b[200~ and \\x1b[201~ markers; leaves plain text unchanged", async () => {
    // Given: string with bracketed-paste markers AND a plain string with no markers
    // When:  sanitizePasted() is called on each
    // Then:  markers stripped from first; plain string unchanged (idempotent)

    assert.equal(
      sanitizePasted("hello\x1b[200~world\x1b[201~end"),
      "helloworldend",
      "T-Prompts.4: both paste markers must be stripped",
    );
    assert.equal(sanitizePasted("plain key"), "plain key", "T-Prompts.4: plain text must be unchanged (idempotent)");
    assert.equal(sanitizePasted(""), "", "T-Prompts.4: empty string must return empty");
    assert.equal(sanitizePasted("\x1b[200~\x1b[201~"), "", "T-Prompts.4: markers-only string must return empty");
  });
});
