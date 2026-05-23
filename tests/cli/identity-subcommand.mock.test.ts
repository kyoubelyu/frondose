/**
 * P-7 mock tests — T-Identity1..T-Identity5: mai identity show + reset subcommand.
 * P-11 D-10 (T-Identity.1 replaces T-Identity4): modelFactory DI fixes the hung-test.
 *
 * Tests:
 *   T-Identity1 — runIdentitySubcommand("show") reads and pretty-prints identity.json
 *   T-Identity2 — runIdentitySubcommand("show") when identity.json absent → helpful message
 *   T-Identity.1 (D-10 replaces T-Identity4): with modelFactory injection, init --reset with "y" completes in ≤ 2000ms
 *   T-Identity.2 (D-10 new): without modelFactory (production path), detectAnyModelKey is called
 *   T-Identity5 — same with "N" → prints "[mai] Cancelled." and returns
 *
 * No Chrome required. T-Identity.1 uses MockLanguageModelV1 via modelFactory DI (D-10).
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { MockLanguageModelV1 } from "ai/test";
import { runIdentitySubcommand } from "../../src/cli/subcommands/identity.js";
import { writeIdentity } from "../../src/persistence/identity.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

// P-Z3: readIdentity/writeIdentity are P-28 shims over config.json.identity at
// DEFAULT_CONFIG_PATH() = getHomeBase()/.mai/agent/config.json (getHomeBase→os.homedir()→$HOME).
// runIdentitySubcommand reads/writes that DEFAULT config and accepts no configPath, so
// without per-test isolation T-Identity1's writeIdentity bleeds "Alice Validator" into
// T-Identity2's "missing-identity" read. Point HOME at each test's own tmp dir → config.json
// is per-test. Caller MUST invoke restoreHome() in finally.
function tmpDir(): { dir: string; idPath: string; wipPath: string; restoreHome: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p7-idcmd-"));
  const savedHome = process.env.HOME;
  process.env.HOME = dir;
  return {
    dir,
    idPath: join(dir, "identity.json"),
    wipPath: join(dir, ".identity-wip.json"),
    restoreHome: () => {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
    },
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
  const { dir, idPath, restoreHome } = tmpDir();
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
    restoreHome();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T-Identity2 — show when file absent ─────────────────────────────────────

test("T-Identity2: runIdentitySubcommand show with missing identity.json prints helpful message", async () => {
  const { dir, idPath, restoreHome } = tmpDir();
  try {
    // Do NOT write identity.json
    const output = await captureStdout(() => runIdentitySubcommand("show", { identityPath: idPath }));

    assert.ok(
      output.includes("No identity found") || output.includes("mai identity init"),
      `T-Identity2: must print helpful message when identity.json absent; got: "${output}"`,
    );
    console.log("T-Identity2: missing identity.json → helpful message ✓");
  } finally {
    restoreHome();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T-Identity.1 (D-10 — replaces T-Identity4): modelFactory injection ──────
//
// P-11 Step 4a scaffold: assertion body is TODO.
// The scaffold compiles (identity.ts + MockLanguageModelV1 exist) but fails at Step 4a
// because `runIdentitySubcommand` does NOT yet accept `modelFactory` in its opts
// (builder adds it at Step 4b). The test is expected to hang or fail until Step 4b.

test("T-Identity.1 (D-10): runIdentitySubcommand('init', {reset:true, modelFactory}) with injected mock model completes in ≤ 2000ms (hung-test fix)", async () => {
  // Given: MockLanguageModelV1 whose doStream immediately emits a finalize_identity tool call + finish
  // When: runIdentitySubcommand("init", {identityPath, reset:true, modelFactory: () => mockModel}) + "y" stdin
  // Then: completes within 2000ms; identity.json + WIP unlinked; NO real LLM network call
  // NOTE: Must use doStream (not doGenerate) because bootstrap-agent uses streamText, not generateText.
  const { dir, idPath, wipPath, restoreHome } = tmpDir();
  try {
    writeIdentity({ fullName: "Old Name", company: "Old Corp", updatedAt: new Date().toISOString() }, idPath);
    writeFileSync(wipPath, JSON.stringify({ fullName: "Partial" }), "utf-8");

    /** Build a ReadableStream<LanguageModelV1StreamPart> for a finalize_identity tool call. */
    function makeFinalizeStream() {
      return Readable.toWeb(
        Readable.from([
          {
            type: "tool-call" as const,
            toolCallType: "function" as const,
            toolCallId: "tc-1",
            toolName: "finalize_identity",
            args: "{}",
          },
          {
            type: "finish" as const,
            finishReason: "tool-calls" as const,
            usage: { promptTokens: 10, completionTokens: 5 },
          },
        ]),
      );
    }

    const mockModel = new MockLanguageModelV1({
      provider: "openai",
      modelId: "test-identity",
      doStream: async () => ({
        rawCall: { rawPrompt: null as unknown, rawSettings: {} as Record<string, unknown> },
        // biome-ignore lint/suspicious/noExplicitAny: cast required — Readable.toWeb returns ReadableStream<any>
        stream: makeFinalizeStream() as unknown as ReadableStream<any>,
      }),
    });

    const fakeStdin = new PassThrough();
    const origStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    const origExit = process.exit.bind(process);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process as any).exit = (_code: number) => {
      /* swallow */
    };

    const start = Date.now();
    try {
      fakeStdin.write("y\n");
      fakeStdin.end();
      // Run with modelFactory injection — bypasses real LLM call (D-10 fix)
      await runIdentitySubcommand("init", {
        identityPath: idPath,
        reset: true,
        modelFactory: () => mockModel,
      });
      const elapsed = Date.now() - start;
      assert.ok(
        elapsed <= 2000,
        `runIdentitySubcommand with modelFactory must complete in ≤ 2000ms; elapsed: ${elapsed}ms`,
      );
      // WIP must be gone (reset + bootstrap unlinkSync)
      assert.ok(!existsSync(wipPath), "WIP file must be deleted after --reset + bootstrap completes");
    } finally {
      Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = origExit;
    }
  } finally {
    restoreHome();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T-Identity.2 (D-10 new): production path calls detectAnyModelKey ─────────

test("T-Identity.2 (D-10): production no-modelFactory path calls detectAnyModelKey — verified via static grep of src/cli/identity-init.ts", () => {
  // Given: post-Step-4b state of src/cli/identity-init.ts (D-10 modelFactory seam added)
  // When: readFileSync('src/cli/identity-init.ts') and check for detectAnyModelKey guard
  // Then: source contains detectAnyModelKey call (production path) AND modelFactory branch (DI seam)
  // NOTE: Dynamic env-clearing approach is insufficient — auth.json may also have API keys.
  //       Static grep is the correct verification for production code structure.
  const src = readFileSync(join(process.cwd(), "src", "cli", "identity-init.ts"), "utf-8");

  assert.ok(
    src.includes("detectAnyModelKey"),
    "identity-init.ts must call detectAnyModelKey in the production (no-modelFactory) path",
  );
  assert.ok(
    src.includes("opts?.modelFactory"),
    "identity-init.ts must check opts?.modelFactory (D-10 DI seam condition)",
  );
  assert.ok(
    src.includes("process.exit"),
    "identity-init.ts must call process.exit when detectAnyModelKey returns false (no-key guard)",
  );
});

// ─── T-Identity5 — reset with "N" → Cancelled ────────────────────────────────

test("T-Identity5: runIdentitySubcommand init --reset with N stdin prints [mai] Cancelled. and keeps files", async () => {
  const { dir, idPath, wipPath, restoreHome } = tmpDir();
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
    restoreHome();
    rmSync(dir, { recursive: true, force: true });
  }
});
