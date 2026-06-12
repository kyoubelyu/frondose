/**
 * P-6 mock tests — T-M_p6.17..T-M_p6.20 + T-M_p6.20b: makeAuditWriter + writeAuditRow.
 *
 * Tests:
 *   T-M_p6.17 — one JSONL line per tool call: step with 2 toolResults → 2 appended lines
 *   T-M_p6.18 — truncation at 2000 chars: output > 2000 chars → truncated string in JSON
 *   T-M_p6.19 — failure non-fatal: bad audit path → no throw; stderr warning emitted
 *   T-M_p6.20 — AuditEntry schema fields: ts, toolCallId, toolName, input, output, error, stepFinishReason
 *               (NOTE: no sessionId field — actual implementation does NOT include it)
 *   T-M_p6.20b — writeAuditRow direct-emit: appends correct JSONL line with expected schema
 *                (P-6 Step 5a r3: stop tool uses direct emit to bypass onStepFinish skip-on-abort)
 *
 * Uses tmp files under /tmp. No Chrome, no LLM, no SQLite.
 */

import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { test } from "node:test";
import type { AuditEntry } from "../../src/persistence/audit.js";
import { makeAuditWriter, writeAuditRow } from "../../src/persistence/audit.js";

// ─── step mock helper ─────────────────────────────────────────────────────────

function makeStep(
  toolResults: Array<{ toolCallId: string; toolName: string; args: unknown; result: unknown }>,
  finishReason = "tool-calls",
) {
  return {
    toolResults,
    finishReason,
    // Other StepResult fields we don't use in the audit writer.
  } as unknown as Parameters<ReturnType<typeof makeAuditWriter>>[0];
}

// ─── T-M_p6.17 — one line per tool result ────────────────────────────────────

test("T-M_p6.17: makeAuditWriter writes one JSONL line per toolResult", async () => {
  const auditPath = `/tmp/mai-test-audit-p6-17-${Date.now()}.jsonl`;
  try {
    const writer = makeAuditWriter(auditPath);

    const step = makeStep([
      { toolCallId: "tc-1", toolName: "remember", args: { key: "Alice", value: "Acme" }, result: { ok: true } },
      { toolCallId: "tc-2", toolName: "echo", args: { text: "hello" }, result: { ok: true, text: "hello" } },
    ]);

    await writer(step);

    const raw = readFileSync(auditPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 2, `T-M_p6.17: must write 2 JSONL lines; got ${lines.length}: ${raw}`);

    const entry1 = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(entry1.toolCallId, "tc-1", "T-M_p6.17: first line toolCallId must be 'tc-1'");
    assert.equal(entry1.toolName, "remember", "T-M_p6.17: first line toolName must be 'remember'");

    const entry2 = JSON.parse(lines[1]!) as Record<string, unknown>;
    assert.equal(entry2.toolCallId, "tc-2", "T-M_p6.17: second line toolCallId must be 'tc-2'");
    assert.equal(entry2.toolName, "echo", "T-M_p6.17: second line toolName must be 'echo'");

    console.log("T-M_p6.17: 2 toolResults → 2 JSONL lines ✓");
  } finally {
    try {
      unlinkSync(auditPath);
    } catch {
      /* ignore */
    }
  }
});

// ─── T-M_p6.18 — output truncated at 2000 chars ──────────────────────────────

test("T-M_p6.18: makeAuditWriter truncates output > 2000 chars", async () => {
  const auditPath = `/tmp/mai-test-audit-p6-18-${Date.now()}.jsonl`;
  try {
    const writer = makeAuditWriter(auditPath);

    // Output over 2000 chars: JSON.stringify of the object will be long.
    const longOutput = { data: "x".repeat(3000) };

    const step = makeStep([
      { toolCallId: "tc-trunc", toolName: "inspect", args: { url: "https://example.com" }, result: longOutput },
    ]);

    await writer(step);

    const raw = readFileSync(auditPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "T-M_p6.18: must write 1 line");

    const entry = JSON.parse(lines[0]!) as { output: unknown };
    const outputStr = typeof entry.output === "string" ? entry.output : JSON.stringify(entry.output);

    // The truncated representation ends with "…[truncated]"
    assert.ok(
      outputStr.includes("[truncated]"),
      `T-M_p6.18: output must contain '[truncated]' marker; got: "${outputStr.slice(0, 200)}"`,
    );
    // The raw string should not exceed ~2100 chars (2000 + marker overhead)
    assert.ok(outputStr.length <= 2100, `T-M_p6.18: truncated output must be ≤ 2100 chars; got ${outputStr.length}`);

    console.log(`T-M_p6.18: truncation at 2000 chars verified (output len: ${outputStr.length}) ✓`);
  } finally {
    try {
      unlinkSync(auditPath);
    } catch {
      /* ignore */
    }
  }
});

// ─── T-M_p6.19 — failure non-fatal ───────────────────────────────────────────

test("T-M_p6.19: makeAuditWriter with bad path logs stderr warning and does NOT throw", async () => {
  // Use a path in a non-existent nested directory that we cannot create.
  const badPath = "/nonexistent/deep/nested/path/audit.jsonl";

  // Intercept stderr to capture the warning.
  const stderrChunks: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stderr as any).write = (chunk: string | Buffer) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
    return true;
  };

  let threw = false;
  try {
    const writer = makeAuditWriter(badPath);
    const step = makeStep([{ toolCallId: "tc-bad", toolName: "echo", args: {}, result: {} }]);
    await writer(step);
  } catch {
    threw = true;
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stderr as any).write = origWrite;
  }

  assert.equal(threw, false, "T-M_p6.19: makeAuditWriter must NOT throw on write failure");

  const captured = stderrChunks.join("");
  // Must emit some kind of warning (either dir creation failure OR append failure)
  assert.ok(
    captured.includes("[frondose]") || captured.includes("audit") || captured.includes("failed"),
    `T-M_p6.19: stderr must contain a warning about audit failure; got: "${captured.slice(0, 300)}"`,
  );

  console.log("T-M_p6.19: bad audit path → no throw + stderr warning ✓");
});

// ─── T-M_p6.20 — AuditEntry schema fields ────────────────────────────────────

test("T-M_p6.20: AuditEntry fields: ts, toolCallId, toolName, input, output, error, stepFinishReason (no sessionId)", async () => {
  const auditPath = `/tmp/mai-test-audit-p6-20-${Date.now()}.jsonl`;
  try {
    const writer = makeAuditWriter(auditPath);

    const toolArgs = { key: "Bob", value: "Zenith Corp" };
    const toolResult = { ok: true, command: "remember", data: { stored: true } };

    const step = makeStep(
      [{ toolCallId: "tc-schema", toolName: "remember", args: toolArgs, result: toolResult }],
      "stop",
    );

    await writer(step);

    const raw = readFileSync(auditPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "T-M_p6.20: must write exactly 1 line");

    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;

    // Required fields per AuditEntry interface in src/persistence/audit.ts
    assert.ok("ts" in entry, "T-M_p6.20: entry must have 'ts' field");
    assert.ok("toolCallId" in entry, "T-M_p6.20: entry must have 'toolCallId' field");
    assert.ok("toolName" in entry, "T-M_p6.20: entry must have 'toolName' field");
    assert.ok("input" in entry, "T-M_p6.20: entry must have 'input' field");
    assert.ok("output" in entry, "T-M_p6.20: entry must have 'output' field");
    assert.ok("error" in entry, "T-M_p6.20: entry must have 'error' field");
    assert.ok("stepFinishReason" in entry, "T-M_p6.20: entry must have 'stepFinishReason' field");

    // sessionId is NOT in the actual implementation
    assert.ok(
      !("sessionId" in entry),
      "T-M_p6.20: entry must NOT have 'sessionId' field (not in AuditEntry interface)",
    );

    // Value spot-checks
    assert.ok(typeof entry.ts === "string" && entry.ts.includes("T"), "T-M_p6.20: ts must be ISO-8601");
    assert.equal(entry.toolCallId, "tc-schema", "T-M_p6.20: toolCallId must match");
    assert.equal(entry.toolName, "remember", "T-M_p6.20: toolName must match");
    assert.equal(entry.error, null, "T-M_p6.20: error must be null on success");
    assert.equal(entry.stepFinishReason, "stop", "T-M_p6.20: stepFinishReason must match");

    // input must contain the original args
    const inputObj = entry.input as Record<string, unknown>;
    assert.equal(inputObj.key, "Bob", "T-M_p6.20: input.key must be 'Bob'");
    assert.equal(inputObj.value, "Zenith Corp", "T-M_p6.20: input.value must be 'Zenith Corp'");

    console.log("T-M_p6.20: AuditEntry schema correct — 7 fields, no sessionId ✓");
  } finally {
    try {
      unlinkSync(auditPath);
    } catch {
      /* ignore */
    }
  }
});

// ─── T-M_p6.20b — writeAuditRow direct-emit ──────────────────────────────────

test("T-M_p6.20b: writeAuditRow appends correct JSONL line with same 7-field schema (P-6 Step 5a r3 stop-tool path)", () => {
  const auditPath = `/tmp/mai-test-audit-p6-20b-${Date.now()}.jsonl`;
  try {
    const row: AuditEntry = {
      ts: "2026-05-08T15:00:00.000Z",
      toolCallId: "stop-uuid-mock-test",
      toolName: "stop",
      input: { reason: "task complete" },
      output: { ok: true, command: "stop", data: { stopped: true, reason: "task complete" } },
      error: null,
      stepFinishReason: "stop-tool",
    };

    // writeAuditRow is synchronous (void return)
    writeAuditRow(auditPath, row);

    const raw = readFileSync(auditPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "T-M_p6.20b: must write exactly 1 JSONL line");

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;

    // Schema must match AuditEntry (same fields as onStepFinish-emitted rows)
    assert.equal(parsed.ts, row.ts, "T-M_p6.20b: ts must match");
    assert.equal(parsed.toolCallId, row.toolCallId, "T-M_p6.20b: toolCallId must match");
    assert.equal(parsed.toolName, "stop", "T-M_p6.20b: toolName must be 'stop'");
    assert.equal(parsed.error, null, "T-M_p6.20b: error must be null");

    // stepFinishReason must be "stop-tool" (distinguishes from onStepFinish rows "tool-calls" / "stop")
    assert.equal(
      parsed.stepFinishReason,
      "stop-tool",
      `T-M_p6.20b: stepFinishReason must be "stop-tool" for direct-emit rows; got "${parsed.stepFinishReason}"`,
    );

    // Input must contain the tool args
    const inputObj = parsed.input as Record<string, unknown>;
    assert.equal(inputObj.reason, "task complete", "T-M_p6.20b: input.reason must match");

    // Output must be the ok envelope (not truncated — within 2000 chars)
    const outputStr = typeof parsed.output === "string" ? parsed.output : JSON.stringify(parsed.output);
    assert.ok(!outputStr.includes("[truncated]"), "T-M_p6.20b: output must not be truncated (small payload)");
    assert.ok(outputStr.includes('"ok":true') || outputStr.includes("ok"), "T-M_p6.20b: output must contain ok:true");

    // Multiple calls must append (not overwrite)
    const row2: AuditEntry = { ...row, toolCallId: "stop-uuid-mock-test-2", ts: "2026-05-08T15:00:01.000Z" };
    writeAuditRow(auditPath, row2);
    const raw2 = readFileSync(auditPath, "utf-8");
    const lines2 = raw2.trim().split("\n").filter(Boolean);
    assert.equal(lines2.length, 2, "T-M_p6.20b: second writeAuditRow must append (total 2 lines)");

    console.log("T-M_p6.20b: writeAuditRow direct-emit — correct schema, stop-tool stepFinishReason, append ✓");
  } finally {
    try {
      unlinkSync(auditPath);
    } catch {
      /* ignore */
    }
  }
});
