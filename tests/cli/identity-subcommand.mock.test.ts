/**
 * P-7 mock tests — T-Identity1..T-Identity5: mai identity show + reset subcommand.
 *
 * Tests:
 *   T-Identity1 — runIdentitySubcommand("show") reads and pretty-prints identity.json
 *   T-Identity2 — runIdentitySubcommand("show") when identity.json absent → helpful message
 *   T-Identity4 — runIdentitySubcommand("init", {reset:true}) with mocked "y" stdin → unlinks WIP + calls init
 *   T-Identity5 — same with "N" → prints "[mai] Cancelled." and returns
 *
 * No Chrome, no LLM required.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runIdentitySubcommand } from "../../src/cli/subcommands/identity.js";
import { writeIdentity } from "../../src/persistence/identity.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function tmpDir(): { dir: string; idPath: string; wipPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p7-idcmd-"));
  return {
    dir,
    idPath: join(dir, "identity.json"),
    wipPath: join(dir, ".identity-wip.json"),
  };
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

// ─── T-Identity1 — show pretty-prints identity.json ──────────────────────────

test("T-Identity1: runIdentitySubcommand show reads identity.json and pretty-prints to stdout", async () => {
  const { dir, idPath } = tmpDir();
  try {
    writeIdentity(
      {
        fullName: "Alice Validator",
        company: "Test Corp",
        role: "CTO",
        updatedAt: new Date().toISOString(),
      },
      idPath,
    );

    const output = await captureStdout(() => runIdentitySubcommand("show", { identityPath: idPath }));

    assert.ok(
      output.includes("Alice Validator"),
      `T-Identity1: output must include fullName; got: "${output.slice(0, 200)}"`,
    );
    assert.ok(output.includes("Test Corp"), "T-Identity1: output must include company");
    assert.ok(output.includes("CTO"), "T-Identity1: output must include role");
    // Must be pretty-printed JSON (has newlines and spaces for indentation).
    assert.ok(output.includes("\n"), "T-Identity1: output must be multi-line (pretty-printed)");
    console.log("T-Identity1: show pretty-prints identity.json ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T-Identity2 — show when file absent ─────────────────────────────────────

test("T-Identity2: runIdentitySubcommand show with missing identity.json prints helpful message", async () => {
  const { dir, idPath } = tmpDir();
  try {
    // Do NOT write identity.json
    const output = await captureStdout(() => runIdentitySubcommand("show", { identityPath: idPath }));

    assert.ok(
      output.includes("No identity found") || output.includes("mai identity init"),
      `T-Identity2: must print helpful message when identity.json absent; got: "${output}"`,
    );
    console.log("T-Identity2: missing identity.json → helpful message ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T-Identity4 — reset with "y" confirmation ───────────────────────────────

test("T-Identity4: runIdentitySubcommand init --reset with y stdin unlinks WIP and identity.json", async () => {
  const { dir, idPath, wipPath } = tmpDir();
  try {
    // Pre-create both identity.json and WIP so reset has something to unlink.
    writeIdentity({ fullName: "Old Name", company: "Old Corp", updatedAt: new Date().toISOString() }, idPath);
    writeFileSync(wipPath, JSON.stringify({ fullName: "Partial" }), "utf-8");

    assert.ok(existsSync(idPath), "T-Identity4: pre-condition: identity.json must exist");
    assert.ok(existsSync(wipPath), "T-Identity4: pre-condition: WIP must exist");

    // Swap stdin with a PassThrough that feeds "y\n" for the confirmation prompt.
    const fakeStdin = new PassThrough();
    const origStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });

    // Override process.exit so we can catch it (runIdentityBootstrap would call process.exit after chicken-and-egg check).
    let _exitCalled = false;
    const origExit = process.exit.bind(process);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process as any).exit = (_code: number) => {
      _exitCalled = true;
      // Don't throw — just record it.
      // The bootstrap will fail with no LLM key, which is expected in tests.
    };

    try {
      fakeStdin.write("y\n");
      fakeStdin.end();
      // runIdentitySubcommand("init", {reset: true}) will:
      //   1. Read "y" from stdin → delete WIP + identity.json
      //   2. Call runIdentityBootstrap → detectAnyModelKey → may exit(1) or try to bootstrap
      //      (In test env, if DEEPSEEK_API_KEY is set, it will try to run bootstrap and then
      //       fail at streamText(messages: []) — BLOCKER-1. But we've already tested deletion.)
      try {
        await runIdentitySubcommand("init", { identityPath: idPath, reset: true });
      } catch {
        // Expected: bootstrap fails (no TTY or BLOCKER-1). The key assertion is deletion.
      }
    } finally {
      Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = origExit;
    }

    // Both files must be deleted after "y" confirmation.
    assert.ok(!existsSync(wipPath), "T-Identity4: WIP must be unlinked after y confirmation");
    assert.ok(!existsSync(idPath), "T-Identity4: identity.json must be unlinked after y confirmation");
    console.log("T-Identity4: --reset with y → both files deleted ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T-Identity5 — reset with "N" → Cancelled ────────────────────────────────

test("T-Identity5: runIdentitySubcommand init --reset with N stdin prints [mai] Cancelled. and keeps files", async () => {
  const { dir, idPath, wipPath } = tmpDir();
  try {
    writeIdentity({ fullName: "Keep Name", company: "Keep Corp", updatedAt: new Date().toISOString() }, idPath);
    writeFileSync(wipPath, JSON.stringify({ company: "partial" }), "utf-8");

    // Feed "N\n" for the confirmation.
    const fakeStdin = new PassThrough();
    const origStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });

    const chunks: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process.stdout as any).write = (chunk: string | Buffer) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    try {
      fakeStdin.write("N\n");
      fakeStdin.end();
      await runIdentitySubcommand("init", { identityPath: idPath, reset: true });
    } finally {
      Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stdout as any).write = origStdoutWrite;
    }

    const output = chunks.join("");
    assert.ok(output.includes("[mai] Cancelled"), `T-Identity5: must print "[mai] Cancelled." on N; got: "${output}"`);
    // Files must NOT be deleted.
    assert.ok(existsSync(idPath), "T-Identity5: identity.json must NOT be deleted after N");
    assert.ok(existsSync(wipPath), "T-Identity5: WIP must NOT be deleted after N");
    console.log("T-Identity5: --reset with N → [mai] Cancelled. + files preserved ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
