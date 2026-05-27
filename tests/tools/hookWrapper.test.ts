/**
 * P-9 mock tests — T-HookWrapper.1..T-HookWrapper.7
 *
 * Tests for wrapWithHooks() in src/tools/hookWrapper.ts.
 *
 * T-HookWrapper.1 — PreToolUse blocked → fail envelope; execute NOT called
 * T-HookWrapper.2 — PreToolUse allowed → execute called → PostToolUse called (success path)
 * T-HookWrapper.3 — Execute throws → PostToolUse NOT called (D-2 success-only); error re-thrown
 * T-HookWrapper.4 — HookRunner with null hooksJson → all hooks no-op; execute runs normally
 * T-HookWrapper.5 — tool.description and tool.parameters preserved on wrapped tool
 * T-HookWrapper.6 — opts (including abortSignal) forwarded to inner execute
 * T-HookWrapper.7 — PostToolUse receives tool result as argument (correct payload)
 *
 * Gate coverage: G-P9.2 (PreToolUse BLOCK), G-P9.3 (PostToolUse success-only)
 *
 * No LLM, no Chrome. HookRunner instantiated with temporary hooks.json files
 * to test PreToolUse/PostToolUse semantics end-to-end.
 *
 * NOTE: This file imports hookWrapper from src/tools/hookWrapper.ts.
 * Biome lint ban on child_process applies only to src/tools/** at runtime —
 * tests are exempt. hookWrapper.ts itself has NO child_process import (verified G-P9.13).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CoreMessage, ToolExecutionOptions } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { HookRunner } from "../../src/agent/hooks.js";
import { wrapWithHooks } from "../../src/tools/hookWrapper.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

const FAKE_OPTS: ToolExecutionOptions = {
  toolCallId: "hw-test-1",
  messages: [] as CoreMessage[],
};

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p9-hw-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeHooksJson(dir: string, content: unknown): string {
  const p = join(dir, "hooks.json");
  writeFileSync(p, JSON.stringify(content), "utf-8");
  return p;
}

/** Build a minimal Vercel tool with a spy execute. */
function makeSpyTool(executeFn: (args: { msg: string }) => Promise<unknown>) {
  return tool({
    description: "test spy tool",
    parameters: z.object({ msg: z.string() }),
    execute: executeFn,
  });
}

// ─── T-HookWrapper.1: PreToolUse blocked → fail envelope; execute NOT called ──

test("T-HookWrapper.1: PreToolUse BLOCK → fail envelope returned; inner execute NOT called", async () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const p = writeHooksJson(dir, {
      hooks: {
        PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "cat >/dev/null; exit 2" }] }],
      },
    });

    let executeCalled = false;
    const base = makeSpyTool(async () => {
      executeCalled = true;
      return { ok: true, command: "test", data: {} };
    });

    const runner = new HookRunner(p);
    const wrapped = wrapWithHooks(base, runner, "test_tool");
    const result = (await wrapped.execute?.({ msg: "hi" }, FAKE_OPTS)) as {
      ok: boolean;
      error: { kind: string; message: string };
    };

    // Inner execute must NOT have been called
    assert.equal(executeCalled, false, "execute must NOT be called when PreToolUse blocks");

    // Result must be a fail envelope
    assert.equal(result.ok, false, "blocked result must be ok:false");
    assert.equal(result.error.kind, "runtime_error", "blocked result kind must be runtime_error");
    assert.ok(result.error.message.length > 0, "blocked result must have a message");
  } finally {
    cleanup();
  }
});

// ─── T-HookWrapper.2: PreToolUse allowed → execute + PostToolUse called ──────

test("T-HookWrapper.2: PreToolUse ALLOW → execute called; PostToolUse called on success", async () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const postOutput = join(dir, "post-fired.txt");
    const p = writeHooksJson(dir, {
      hooks: {
        PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "cat >/dev/null; exit 0" }] }],
        PostToolUse: [
          { matcher: ".*", hooks: [{ type: "command", command: `cat >/dev/null; echo "fired" > "${postOutput}"` }] },
        ],
      },
    });

    let executeCalled = false;
    const base = makeSpyTool(async () => {
      executeCalled = true;
      return { ok: true, command: "test", data: { value: "done" } };
    });

    const runner = new HookRunner(p);
    const wrapped = wrapWithHooks(base, runner, "test_tool");
    const result = (await wrapped.execute?.({ msg: "hi" }, FAKE_OPTS)) as { ok: boolean };

    assert.equal(executeCalled, true, "execute must be called when PreToolUse allows");
    assert.equal(result.ok, true, "result must be the tool's ok envelope");

    // PostToolUse hook must have fired (file exists)
    const { existsSync } = await import("node:fs");
    assert.ok(existsSync(postOutput), "PostToolUse hook must have fired (file exists)");
  } finally {
    cleanup();
  }
});

// ─── T-HookWrapper.3: Execute throws → PostToolUse NOT called (D-2) ──────────

test("T-HookWrapper.3: execute throws → PostToolUse SKIPPED; error re-thrown to Vercel SDK (D-2)", async () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const postOutput = join(dir, "post-fired.txt");
    const p = writeHooksJson(dir, {
      hooks: {
        PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "cat >/dev/null; exit 0" }] }],
        PostToolUse: [
          { matcher: ".*", hooks: [{ type: "command", command: `cat >/dev/null; echo "fired" > "${postOutput}"` }] },
        ],
      },
    });

    const base = makeSpyTool(async () => {
      throw new Error("tool execute threw");
    });

    const runner = new HookRunner(p);
    const wrapped = wrapWithHooks(base, runner, "test_tool");

    await assert.rejects(
      () => wrapped.execute?.({ msg: "hi" }, FAKE_OPTS) as Promise<unknown>,
      /tool execute threw/,
      "error must propagate to caller (Vercel SDK)",
    );

    // PostToolUse hook must NOT have fired (file must NOT exist)
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync(postOutput), "PostToolUse must NOT fire when execute throws (D-2 success-only)");
  } finally {
    cleanup();
  }
});

// ─── T-HookWrapper.4: null-hooksJson HookRunner → no-op; execute runs ─────────

test("T-HookWrapper.4: HookRunner with ENOENT hooks.json → no-op; execute runs normally", async () => {
  const { dir, cleanup } = makeTempDir();
  try {
    // HookRunner with non-existent hooks.json → hooksJson = null
    const runner = new HookRunner(join(dir, "nonexistent.json"));

    let executeCalled = false;
    const base = makeSpyTool(async () => {
      executeCalled = true;
      return { ok: true, command: "test", data: {} };
    });

    const wrapped = wrapWithHooks(base, runner, "test_tool");
    const result = (await wrapped.execute?.({ msg: "hi" }, FAKE_OPTS)) as { ok: boolean };

    assert.equal(executeCalled, true, "execute must run when hookRunner is a no-op");
    assert.equal(result.ok, true, "tool result must be returned as-is");
  } finally {
    cleanup();
  }
});

// ─── T-HookWrapper.5: description and parameters preserved ───────────────────

test("T-HookWrapper.5: wrapWithHooks preserves tool.description and tool.parameters", () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const runner = new HookRunner(join(dir, "nonexistent.json"));
    const base = makeSpyTool(async () => ({}));
    const wrapped = wrapWithHooks(base, runner, "test_tool");

    assert.equal(wrapped.description, base.description, "description must be preserved");
    assert.equal(wrapped.parameters, base.parameters, "parameters Zod schema must be preserved (same ref)");
    assert.notEqual(wrapped.execute, base.execute, "execute must be replaced by the hook wrapper");
  } finally {
    cleanup();
  }
});

// ─── T-HookWrapper.6: opts forwarded to inner execute ────────────────────────

test("T-HookWrapper.6: opts (including abortSignal) forwarded to inner execute verbatim", async () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const runner = new HookRunner(join(dir, "nonexistent.json"));

    let capturedOpts: ToolExecutionOptions | undefined;
    const base = tool({
      description: "opts spy",
      parameters: z.object({ msg: z.string() }),
      execute: async (_args, opts) => {
        capturedOpts = opts;
        return { ok: true, command: "test", data: {} };
      },
    });

    const wrapped = wrapWithHooks(base, runner, "test_tool");
    const ac = new AbortController();
    const opts: ToolExecutionOptions = { toolCallId: "my-call-id", messages: [], abortSignal: ac.signal };
    await wrapped.execute?.({ msg: "hi" }, opts);

    assert.ok(capturedOpts !== undefined, "execute must receive opts");
    assert.equal(capturedOpts?.toolCallId, "my-call-id", "toolCallId forwarded");
    assert.equal(capturedOpts?.abortSignal, ac.signal, "abortSignal forwarded to inner execute");
  } finally {
    cleanup();
  }
});

// ─── T-HookWrapper.7: PostToolUse receives correct result payload ─────────────

test("T-HookWrapper.7: PostToolUse hook receives tool result in stdin payload", async () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const payloadFile = join(dir, "post-payload.json");
    const p = writeHooksJson(dir, {
      hooks: {
        PostToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: `cat > "${payloadFile}"` }] }],
      },
    });

    const expectedResult = { ok: true, command: "test", data: { foo: "bar" } };
    const base = makeSpyTool(async () => expectedResult);

    const runner = new HookRunner(p);
    const wrapped = wrapWithHooks(base, runner, "test_tool");
    await wrapped.execute?.({ msg: "hello" }, FAKE_OPTS);

    const { existsSync, readFileSync } = await import("node:fs");
    assert.ok(existsSync(payloadFile), "PostToolUse payload file must exist");

    const payload = JSON.parse(readFileSync(payloadFile, "utf-8")) as {
      toolName: string;
      result: typeof expectedResult;
    };
    assert.equal(payload.toolName, "test_tool", "PostToolUse payload must include toolName");
    assert.deepEqual(payload.result, expectedResult, "PostToolUse payload must include the tool result");
  } finally {
    cleanup();
  }
});
