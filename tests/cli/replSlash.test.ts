/**
 * P-8 mock tests — T-Slash.1..T-Slash.8
 *
 * Tests for dispatchSlash() in src/cli/replSlash.ts.
 *
 * T-Slash.1  — /help: HELP_TEXT emitted; 3 commands listed; no /cost; no /sessions; handled:true
 * T-Slash.2  — /new: messages cleared, session rotated, tokenBudget reset, handled:true
 * T-Slash.3  — /compact (> 10 msgs): compaction fires, messages replaced, sidecar written; handled:true
 * T-Slash.3b — /compact (≤ 10 msgs): no-op "(already short)" message; session unchanged; handled:true
 * T-Slash.3c — /compact API failure: error message; messages unchanged; no session rewrite; handled:true
 * T-Slash.4  — /unknown: "unknown slash command" message; handled:true
 * T-Slash.5  — non-slash line: handled:false (no side effects)
 * T-Slash.6  — slash guard: /help body mentions status line (rev-3 D-18)
 * T-Slash.7  — /new DOES NOT delete original session file (prior JSONL preserved for `mai sessions list`)
 *
 * Gate coverage: G-P8.1 (/compact happy path), G-P8.2 (no-op), G-P8.3 (all commands intercept)
 *
 * Uses MockLanguageModelV1 with doGenerate for compaction call.
 * Requires filesystem for session file paths; uses mkdtempSync + cleanup.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CoreMessage } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { TokenBudget } from "../../src/agent/tokenBudget.js";
import { dispatchSlash, type SlashCtx } from "../../src/cli/replSlash.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeModel(summaryText = "Test summary of conversation."): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    provider: "openai",
    modelId: "deepseek-v4-flash",
    doGenerate: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      finishReason: "stop" as const,
      usage: { promptTokens: 100, completionTokens: 40 },
      text: summaryText,
    }),
  });
}

function makeMessages(count: number): CoreMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `turn-${i}`,
  }));
}

/** Simple out-stream capturer. */
function makeOut(): { lines: string[]; stream: NodeJS.WritableStream } {
  const lines: string[] = [];
  const stream = {
    write(chunk: string | Buffer): boolean {
      lines.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { lines, stream };
}

/** Create a temp dir for session files; returns cleanup fn. */
function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p8-slash-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Wrap process.env.HOME for session dir isolation.
 * Note: os.homedir() on macOS reads HOME env var, so this redirects
 * newSessionFile() to write under tmpHome.
 */
async function withTmpHomeAsync<T>(fn: (tmpHome: string) => Promise<T>): Promise<T> {
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-p8-home-"));
  const prevHome = process.env.HOME;
  try {
    process.env.HOME = tmpHome;
    return await fn(tmpHome);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

// ─── T-Slash.1: /help ────────────────────────────────────────────────────────

test("T-Slash.1: /help emits HELP_TEXT with 3 commands; no /cost; no /sessions; handled:true", async () => {
  const model = makeModel();
  const budget = new TokenBudget(model);
  const { lines, stream } = makeOut();

  const result = await dispatchSlash("/help", {
    messages: [],
    sessionFile: { path: "/fake/session.jsonl" },
    tokenBudget: budget,
    model,
    out: stream,
    cwd: "/fake/cwd",
  });

  assert.equal(result.handled, true, "/help must return handled:true");
  const output = lines.join("");

  // Three operator-locked commands present (rev-3 D-1)
  assert.ok(output.includes("/compact"), "HELP_TEXT must list /compact");
  assert.ok(output.includes("/new"), "HELP_TEXT must list /new");
  assert.ok(output.includes("/help"), "HELP_TEXT must list /help");

  // Removed commands must NOT appear
  assert.ok(!output.includes("/cost"), "HELP_TEXT must NOT list /cost (removed rev-3)");
  assert.ok(!output.includes("/sessions"), "HELP_TEXT must NOT list /sessions (rejected by operator)");
  assert.ok(!output.includes("/clear"), "HELP_TEXT must NOT list /clear (renamed to /new)");
});

// ─── T-Slash.6: /help mentions status line (rev-3) ───────────────────────────

test("T-Slash.6: HELP_TEXT mentions the always-on status line (rev-3 D-18 documentation)", async () => {
  const model = makeModel();
  const budget = new TokenBudget(model);
  const { lines, stream } = makeOut();

  await dispatchSlash("/help", {
    messages: [],
    sessionFile: { path: "/fake/session.jsonl" },
    tokenBudget: budget,
    model,
    out: stream,
    cwd: "/fake/cwd",
  });

  const output = lines.join("");
  // HELP_TEXT must document that the status line exists at terminal row 0
  assert.ok(
    output.includes("status line") || output.includes("top of terminal"),
    `HELP_TEXT must mention the status line; got: "${output.slice(0, 200)}"`,
  );
});

// ─── T-Slash.2: /new ─────────────────────────────────────────────────────────

test("T-Slash.2: /new clears messages, rotates session file, resets tokenBudget; handled:true", async () => {
  await withTmpHomeAsync(async (tmpHome) => {
    const model = makeModel();
    const budget = new TokenBudget(model);
    budget.add({ promptTokens: 5000, completionTokens: 200, totalTokens: 5200 });

    const messages: CoreMessage[] = makeMessages(5);
    const { lines, stream } = makeOut();
    const originalPath = join(tmpHome, "original-session.jsonl");
    const sessionFile = { path: originalPath };

    const result = await dispatchSlash("/new", {
      messages,
      sessionFile,
      tokenBudget: budget,
      model,
      out: stream,
      cwd: tmpHome,
    });

    assert.equal(result.handled, true, "/new must return handled:true");
    assert.equal(messages.length, 0, "/new must clear messages array in place");
    assert.equal(budget.lastPromptTokens, 0, "/new must reset tokenBudget");
    assert.equal(budget.cumulativeCompletion, 0, "/new must reset cumulativeCompletion");
    assert.notEqual(sessionFile.path, originalPath, "/new must rotate sessionFile.path");
    assert.ok(sessionFile.path.endsWith(".jsonl"), "new session file has .jsonl extension");

    const output = lines.join("");
    assert.ok(output.includes("(new session:"), "output must confirm new session");
  });
});

// ─── T-Slash.7: /new does NOT delete original session file ────────────────────

test("T-Slash.7: /new rotates path but leaves original session JSONL on disk untouched", async () => {
  await withTmpHomeAsync(async (tmpHome) => {
    const model = makeModel();
    const budget = new TokenBudget(model);
    const { stream } = makeOut();

    // Create a real session file
    const { dir, cleanup } = makeTempDir();
    try {
      const originalPath = join(dir, "original.jsonl");
      writeFileSync(originalPath, '{"role":"user","content":"hello"}\n', "utf-8");

      const messages: CoreMessage[] = makeMessages(3);
      const sessionFile = { path: originalPath };

      await dispatchSlash("/new", {
        messages,
        sessionFile,
        tokenBudget: budget,
        model,
        out: stream,
        cwd: tmpHome,
      });

      // Original file must still exist (not deleted)
      assert.ok(existsSync(originalPath), "original session JSONL must still exist after /new");
      const content = readFileSync(originalPath, "utf-8");
      assert.ok(content.includes("hello"), "original file content unchanged");
    } finally {
      cleanup();
    }
  });
});

// ─── T-Slash.3: /compact happy path ──────────────────────────────────────────

test("T-Slash.3: /compact with 15 messages → compaction fires; messages replaced; sidecar written; handled:true", async () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const model = makeModel("Summary of first 5 messages for testing.");
    const budget = new TokenBudget(model);
    const messages: CoreMessage[] = makeMessages(15); // > 10, triggers compaction
    const { lines, stream } = makeOut();

    // Create a real session file so rewriteSession can overwrite it
    const sessionPath = join(dir, "test-session.jsonl");
    writeFileSync(sessionPath, `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`, "utf-8");

    const budgetTokensBefore = budget.lastPromptTokens;
    const sessionFile = { path: sessionPath };

    const ctx: SlashCtx = {
      messages,
      sessionFile,
      tokenBudget: budget,
      model,
      out: stream,
      cwd: dir,
    };

    const result = await dispatchSlash("/compact", ctx);

    assert.equal(result.handled, true, "/compact must return handled:true");

    // Messages replaced: 1 summary head + 10 tail = 11
    assert.equal(messages.length, 11, `after compaction: 1 summary + 10 tail = 11; got ${messages.length}`);
    assert.equal(messages[0]?.role, "user", "summary head must be role:user");
    const headContent = messages[0]?.content as string;
    assert.ok(
      headContent.startsWith("[Previous conversation summary by /compact]"),
      `summary head must start with canonical prefix; got: "${headContent?.slice(0, 60)}"`,
    );

    // tokenBudget reset
    assert.equal(budget.lastPromptTokens, 0, "tokenBudget must be reset after /compact");
    void budgetTokensBefore;

    // Session file rewritten
    assert.ok(existsSync(sessionPath), "session file must exist after rewrite");
    const rewritten = readFileSync(sessionPath, "utf-8");
    assert.ok(rewritten.includes("[Previous conversation summary by /compact]"), "rewritten session has summary head");

    // Sidecar marker written
    const sidecarPath = `${sessionPath}.compact.json`;
    assert.ok(existsSync(sidecarPath), `sidecar ${sidecarPath} must exist`);
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8")) as {
      type: string;
      summarizedCount: number;
      keptCount: number;
    };
    assert.equal(sidecar.type, "compaction");
    assert.equal(sidecar.summarizedCount, 5);
    assert.equal(sidecar.keptCount, 10);

    // Output confirms compaction
    const output = lines.join("");
    assert.ok(output.includes("✓ compacted"), `output must confirm compaction; got: "${output.slice(0, 200)}"`);
  } finally {
    cleanup();
  }
});

// ─── T-Slash.3b: /compact no-op (≤ 10 messages) ──────────────────────────────

test("T-Slash.3b: /compact with ≤ 10 messages emits '(already short)' notice; session unchanged; handled:true", async () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const model = makeModel();
    const budget = new TokenBudget(model);
    const messages: CoreMessage[] = makeMessages(8); // ≤ 10 → no-op
    const { lines, stream } = makeOut();

    const sessionPath = join(dir, "short.jsonl");
    writeFileSync(sessionPath, `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`, "utf-8");
    const originalContent = readFileSync(sessionPath, "utf-8");

    const sessionFile = { path: sessionPath };
    const ctx: SlashCtx = {
      messages,
      sessionFile,
      tokenBudget: budget,
      model,
      out: stream,
      cwd: dir,
    };

    const result = await dispatchSlash("/compact", ctx);

    assert.equal(result.handled, true, "still handled:true");
    assert.equal(messages.length, 8, "messages unchanged (no compaction)");
    assert.equal(budget.lastPromptTokens, 0, "tokenBudget NOT reset (no-op)");

    // Session file NOT rewritten
    assert.equal(readFileSync(sessionPath, "utf-8"), originalContent, "session file content unchanged");

    // No sidecar written
    assert.ok(!existsSync(`${sessionPath}.compact.json`), "no sidecar on no-op");

    // Output mentions "(already short)"
    const output = lines.join("");
    assert.ok(
      output.includes("already short") || output.includes("nothing to compact"),
      `output must mention no-op; got: "${output.slice(0, 200)}"`,
    );
  } finally {
    cleanup();
  }
});

// ─── T-Slash.3c: /compact API failure ────────────────────────────────────────

test("T-Slash.3c: /compact API failure → error message printed; messages unchanged; no session rewrite; handled:true", async () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const errorModel = new MockLanguageModelV1({
      provider: "openai",
      modelId: "deepseek-v4-flash",
      doGenerate: async () => {
        throw new Error("API rate limit exceeded");
      },
    });

    const budget = new TokenBudget(errorModel);
    const messages: CoreMessage[] = makeMessages(15); // > 10 → would compact
    const messagesBefore = messages.map((m) => ({ ...m })); // shallow copy for comparison
    const { lines, stream } = makeOut();

    const sessionPath = join(dir, "error-test.jsonl");
    writeFileSync(sessionPath, `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`, "utf-8");
    const originalContent = readFileSync(sessionPath, "utf-8");

    const sessionFile = { path: sessionPath };

    const result = await dispatchSlash("/compact", {
      messages,
      sessionFile,
      tokenBudget: budget,
      model: errorModel,
      out: stream,
      cwd: dir,
    });

    // Must still return handled:true (slash was intercepted)
    assert.equal(result.handled, true, "handled:true even on failure");

    // Messages must NOT be mutated (D-16: failure = no-op)
    assert.equal(messages.length, 15, "messages.length unchanged on failure");
    assert.deepEqual(
      messages.map((m) => m.content),
      messagesBefore.map((m) => m.content),
      "message content unchanged on failure",
    );

    // Session file must NOT be rewritten
    assert.equal(readFileSync(sessionPath, "utf-8"), originalContent, "session file unchanged on failure");

    // No sidecar
    assert.ok(!existsSync(`${sessionPath}.compact.json`), "no sidecar on failure");

    // tokenBudget NOT reset
    assert.equal(budget.lastPromptTokens, 0, "tokenBudget not reset (it was 0 before; still 0 after failure)");

    // Output mentions failure
    const output = lines.join("");
    assert.ok(
      output.includes("⚠") || output.includes("compaction failed"),
      `output must include failure notice; got: "${output.slice(0, 200)}"`,
    );
    assert.ok(output.includes("session unchanged"), `output must mention 'session unchanged'; got: "${output}"`);
  } finally {
    cleanup();
  }
});

// ─── T-Slash.4: unknown slash command ────────────────────────────────────────

test("T-Slash.4: unknown slash command emits 'unknown slash command' message; handled:true", async () => {
  const model = makeModel();
  const budget = new TokenBudget(model);
  const { lines, stream } = makeOut();

  const result = await dispatchSlash("/nonexistent", {
    messages: [],
    sessionFile: { path: "/fake/session.jsonl" },
    tokenBudget: budget,
    model,
    out: stream,
    cwd: "/fake/cwd",
  });

  assert.equal(result.handled, true, "unknown slash must return handled:true");
  const output = lines.join("");
  assert.ok(
    output.includes("unknown slash command") || output.includes("unknown"),
    `must emit unknown-command notice; got: "${output}"`,
  );
});

// ─── T-Slash.5: non-slash line ────────────────────────────────────────────────

test("T-Slash.5: non-slash line returns handled:false; no side effects", async () => {
  const model = makeModel();
  const budget = new TokenBudget(model);
  const { lines, stream } = makeOut();
  const messages: CoreMessage[] = makeMessages(3);
  const messagesBefore = messages.length;

  const result = await dispatchSlash("hello LLM", {
    messages,
    sessionFile: { path: "/fake/session.jsonl" },
    tokenBudget: budget,
    model,
    out: stream,
    cwd: "/fake/cwd",
  });

  assert.equal(result.handled, false, "non-slash must return handled:false");
  assert.equal(lines.length, 0, "non-slash must produce no output");
  assert.equal(messages.length, messagesBefore, "non-slash must not mutate messages");
});

// ─── T-Slash.8: /cost is NOT a valid command (rev-3 removal) ──────────────────

test("T-Slash.8: /cost is not a slash command in rev-3; returns 'unknown' notice", async () => {
  const model = makeModel();
  const budget = new TokenBudget(model);
  const { lines, stream } = makeOut();

  const result = await dispatchSlash("/cost", {
    messages: [],
    sessionFile: { path: "/fake/session.jsonl" },
    tokenBudget: budget,
    model,
    out: stream,
    cwd: "/fake/cwd",
  });

  // /cost was removed in rev-3; it should fall through to the unknown-command branch
  assert.equal(result.handled, true, "/cost (unknown) must still return handled:true");
  const output = lines.join("");
  // Must NOT silently succeed as if it were a valid cost command
  assert.ok(
    !output.includes("totalTokens") && !output.includes("cumulative"),
    "/cost must not produce cost output (it's been removed)",
  );
  assert.ok(
    output.includes("unknown") || output.includes("/help"),
    `/cost must produce an unknown-command notice; got: "${output}"`,
  );
});
