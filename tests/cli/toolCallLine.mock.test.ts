/**
 * P-48 Step 4a scaffold — T-Tool.1..T-Tool.11 (G-P48.1..G-P48.4)
 *
 * Pure-function unit tests for `src/cli/toolCallLine.ts` helpers:
 *   formatToolCallLine, formatArgs, classifyResult
 *
 * Gates covered:
 *   G-P48.1 — T-Tool.1 (tool-call line rendered per tool call)
 *   G-P48.2 — T-Tool.2..T-Tool.6 (args formatting — truncated, empty, circular)
 *   G-P48.3 — T-Tool.1, T-Tool.7..T-Tool.10 (success ✓ / failure ✗ classification)
 *   G-P48.4 — T-Tool.11 (NO_COLOR stripping via explicit COLOR_ENABLED gate)
 *
 * All assertion bodies are TODO (assert.fail) — validator fills at Step 5.
 *
 * T-Tool.11 technique choice (§5.1 plan, "validator owns the technique"):
 *   Sub-process spawn (`node:child_process.spawnSync`) is used in preference
 *   to a dynamic-import cache-buster. Rationale: the COLOR_ENABLED constant is
 *   computed at module-load time from `process.env.NO_COLOR`; a sub-process
 *   with NO_COLOR=1 set in its environment before the module loads is the
 *   only reliable cross-platform way to test this gate. Dynamic import with a
 *   query-param cache-buster (e.g. `?cb=2`) would require URL-based ESM imports
 *   and does not guarantee the module re-evaluates COLOR_ENABLED (Node may de-dupe
 *   by resolved path). Sub-process avoids these risks at the cost of a short
 *   child invocation (~100 ms on macOS).
 *
 * Source file (created by builder at Step 4b): src/cli/toolCallLine.ts
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyResult, formatArgs, formatToolCallLine } from "../../src/cli/toolCallLine.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

// ─── G-P48.1 + G-P48.3: formatToolCallLine output shape ─────────────────────

describe("formatToolCallLine — full line rendering (G-P48.1 / G-P48.3)", () => {
  it("T-Tool.1: when toolResult has empty args + ok:true result, THEN returns one formatted ⚙ <tool>() → ✓ line (cyan name, green ✓ or plain when no-color)", () => {
    // Given: toolResult {toolName:"launch", args:{}, result:{ok:true, profileDir:"/tmp/x"}}
    // When:  formatToolCallLine(tr) called
    // Then:  string matches ⚙ launch() → ✓ pattern (with or without ANSI codes depending on COLOR_ENABLED)
    const tr = { toolName: "launch", args: {}, result: { ok: true, profileDir: "/tmp/x" } };
    const line = formatToolCallLine(tr);
    // Strip ANSI codes for comparison — chalk may or may not emit in test env
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC needed to strip ANSI sequences
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal(stripped, "⚙ launch() → ✓", `T-Tool.1: expected plain '⚙ launch() → ✓', got '${stripped}'`);
  });

  it("T-Tool.7: when toolResult has {ok:false, error:'DNS_PROBE_FINISHED_NXDOMAIN'}, THEN formatToolCallLine returns ✗ with error text (after ANSI strip)", () => {
    // Given: toolResult {toolName:"navigate_to_url", args:{url:"x"}, result:{ok:false, error:"DNS_PROBE_FINISHED_NXDOMAIN"}}
    // When:  formatToolCallLine(tr) called; ANSI stripped from output
    // Then:  output contains ✗ DNS_PROBE_FINISHED_NXDOMAIN (classifyResult correctly identifies ok:false+error)
    const tr = {
      toolName: "navigate_to_url",
      args: { url: "x" },
      result: { ok: false, error: "DNS_PROBE_FINISHED_NXDOMAIN" },
    };
    // classifyResult side-check
    const cr = classifyResult(tr.result);
    assert.equal(cr.ok, false, "T-Tool.7: classifyResult ok must be false");
    assert.equal(cr.errMsg, "DNS_PROBE_FINISHED_NXDOMAIN", "T-Tool.7: classifyResult errMsg must be the error string");
    // full line check (ANSI-stripped)
    const line = formatToolCallLine(tr);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC needed to strip ANSI sequences
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(
      stripped.includes("✗ DNS_PROBE_FINISHED_NXDOMAIN"),
      `T-Tool.7: line must contain '✗ DNS_PROBE_FINISHED_NXDOMAIN', got '${stripped}'`,
    );
  });
});

// ─── G-P48.2: formatArgs behavior ────────────────────────────────────────────

describe("formatArgs — args formatting (G-P48.2)", () => {
  it("T-Tool.2: when args is non-empty object, THEN returns compact JSON in parens (no spaces)", () => {
    // Given: args = {key:"k", summary:"s"}
    // When:  formatArgs({key:"k", summary:"s"}) called
    // Then:  returns '({"key":"k","summary":"s"})' — compact, no extra spaces, single parens
    const args = { key: "k", summary: "s" };
    const result = formatArgs(args);
    assert.equal(result, '({"key":"k","summary":"s"})', `T-Tool.2: expected compact JSON in parens, got '${result}'`);
  });

  it("T-Tool.3: when args is empty object {}, THEN returns exactly '()' (not '({})')", () => {
    // Given: args = {}
    // When:  formatArgs({}) called
    // Then:  returns '()' — the §5.1 ARGS_TRUNCATE branch special-cases '{}' to '()'
    assert.equal(formatArgs({}), "()", "T-Tool.3: empty object args must return exactly '()'");
  });

  it("T-Tool.4: when args is undefined, THEN returns '()' via the args ?? {} fallback", () => {
    // Given: args = undefined
    // When:  formatArgs(undefined) called
    // Then:  returns '()' — args ?? {} → {} → JSON.stringify({}) === '{}' → mapped to '()'
    assert.equal(formatArgs(undefined), "()", "T-Tool.4: undefined args must return '()' via args ?? {} fallback");
  });

  it("T-Tool.5: when args JSON is longer than 40 chars, THEN result starts with '(' + 40 chars + '…)'", () => {
    // Given: args = {url:"https://www.linkedin.com/in/john-doe-12345/details"} (JSON length 58)
    // When:  formatArgs(args) called
    // Then:  returned string total length === 43 ('(' + 40 chars + '…' + ')') and ends with '…)'
    const args = { url: "https://www.linkedin.com/in/john-doe-12345/details" };
    const s = formatArgs(args);
    // JSON is > 40 chars → truncated: '(' + 40-char slice + '…' + ')' = 43 total
    assert.equal(s.length, 43, `T-Tool.5: expected length 43, got ${s.length}: '${s}'`);
    assert.ok(s.startsWith("("), `T-Tool.5: must start with '(', got '${s}'`);
    assert.ok(s.endsWith("…)"), `T-Tool.5: must end with '…)', got '${s}'`);
  });

  it("T-Tool.6: when args has a circular reference, THEN formatArgs returns '(…)' without throwing", () => {
    // Given: args with cycle — const a: any = {n:1}; a.self = a
    // When:  formatArgs(a) called
    // Then:  returns exactly '(…)' — JSON.stringify catch branch fires; no exception escapes
    // biome-ignore lint/suspicious/noExplicitAny: intentional circular-ref test fixture
    const a: any = { n: 1 };
    a.self = a;
    let thrown = false;
    let result = "";
    try {
      result = formatArgs(a);
    } catch {
      thrown = true;
    }
    assert.equal(thrown, false, "T-Tool.6: formatArgs must not throw on circular reference");
    assert.equal(result, "(…)", `T-Tool.6: circular ref must return '(…)', got '${result}'`);
  });
});

// ─── G-P48.3: classifyResult behavior ────────────────────────────────────────

describe("classifyResult — success/failure classification (G-P48.3)", () => {
  it("T-Tool.8: when result is {ok:false, message:'Connection refused'} (no error field), THEN classifyResult returns {ok:false, errMsg:'Connection refused'}", () => {
    // Given: result = {ok:false, message:"Connection refused"} — message fallback branch
    // When:  classifyResult(result) called
    // Then:  returns {ok:false, errMsg:"Connection refused"} — message field used when error absent
    const result = { ok: false, message: "Connection refused" };
    const cr = classifyResult(result);
    assert.equal(cr.ok, false, "T-Tool.8: ok must be false");
    assert.equal(cr.errMsg, "Connection refused", "T-Tool.8: message field used as errMsg when error is absent");
  });

  it("T-Tool.9: when result is {ok:false} with no error or message, THEN classifyResult returns {ok:false, errMsg:'failed'}", () => {
    // Given: result = {ok:false} — no error, no message field
    // When:  classifyResult({ok:false}) called
    // Then:  returns {ok:false, errMsg:"failed"} — hardcoded fallback
    const cr = classifyResult({ ok: false });
    assert.equal(cr.ok, false, "T-Tool.9: ok must be false");
    assert.equal(cr.errMsg, "failed", "T-Tool.9: hardcoded 'failed' fallback when no error/message field");
  });

  it("T-Tool.10: when result {ok:false, error:'x'.repeat(100)}, THEN errMsg is exactly 81 chars (80 + '…')", () => {
    // Given: result = {ok:false, error:"x".repeat(100)} — 100-char error string
    // When:  classifyResult(result) called
    // Then:  errMsg.length === 81 (80 from ERROR_TRUNCATE + 1 for '…') AND errMsg.endsWith('…')
    const result = { ok: false, error: "x".repeat(100) };
    const cr = classifyResult(result);
    assert.equal(cr.ok, false, "T-Tool.10: ok must be false");
    assert.equal(cr.errMsg.length, 81, `T-Tool.10: errMsg length must be 81 (80 chars + '…'), got ${cr.errMsg.length}`);
    assert.ok(cr.errMsg.endsWith("…"), `T-Tool.10: errMsg must end with '…', got '${cr.errMsg}'`);
  });
});

// ─── G-P48.4: COLOR_ENABLED gate (NO_COLOR=1 strips ANSI) ────────────────────

describe("COLOR_ENABLED gate — NO_COLOR=1 strips ANSI codes (G-P48.4)", () => {
  it("T-Tool.11: when NO_COLOR=1 is set BEFORE module load, THEN formatToolCallLine returns plain string with no ANSI escape sequences", () => {
    // Given: a sub-process is spawned with NO_COLOR=1 in its environment, so
    //        toolCallLine.ts's COLOR_ENABLED is false at module-load time
    // When:  the subprocess calls formatToolCallLine({toolName:"launch",args:{},result:{ok:true}})
    //        and prints the result to stdout
    // Then:  the captured stdout contains NO ANSI escape sequences (/\x1b\[/ does not match)
    //        AND equals exactly "⚙ launch() → ✓\n"
    //
    // Technique: spawnSync('node', ['--input-type=module', '--eval', ...inline script...])
    // with env = { ...process.env, NO_COLOR: '1' }. The inline script dynamically imports
    // toolCallLine.js (already built dist/cli/toolCallLine.js) and calls formatToolCallLine.
    // This ensures the module is loaded fresh with NO_COLOR in its env.
    //
    // Builder cue at Step 4b: build dist/cli/toolCallLine.js so this subprocess can import it.
    const toolCallLineUrl = pathToFileURL(path.join(REPO_ROOT, "dist", "cli", "toolCallLine.js")).href;
    const inlineScript = `
import { formatToolCallLine } from ${JSON.stringify(toolCallLineUrl)};
process.stdout.write(formatToolCallLine({toolName:"launch",args:{},result:{ok:true}}) + "\\n");
`;
    const result = spawnSync(process.execPath, ["--input-type=module"], {
      input: inlineScript,
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf-8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, `T-Tool.11: subprocess must exit 0; stderr: ${result.stderr}`);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (0x1B) needed to detect ANSI
    const hasAnsi = /\x1b\[/.test(result.stdout);
    assert.ok(!hasAnsi, `T-Tool.11: stdout must have no ANSI escape sequences; got: ${JSON.stringify(result.stdout)}`);
    assert.equal(
      result.stdout,
      "⚙ launch() → ✓\n",
      `T-Tool.11: expected plain '⚙ launch() → ✓\\n'; got: ${JSON.stringify(result.stdout)}`,
    );
  });
});
