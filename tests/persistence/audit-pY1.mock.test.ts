/**
 * P-Y1 Step 5 — T-Audit.1 — FILLED
 * (G-PY1.3)
 *
 * writeWorkflowAudit(auditPath, event) appends {ts, type:"workflow_event", event} to the SAME
 * audit.jsonl; backward-compat with tool rows (AuditEntry has no `type` field).
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 tests/persistence/audit-pY1.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writeWorkflowAudit } from "../../src/persistence/audit.js";

// ─── T-Audit.1 — workflow audit row backward-compat ─────────────────────────

describe("writeWorkflowAudit — appends type:'workflow_event' row; coexists with tool rows (G-PY1.3)", () => {
  // Given: a tmp audit.jsonl path.
  // When:  writeWorkflowAudit(path, {kind:"proposed", ...}) then a tool-row append (no type field).
  // Then:  the workflow line parses to {ts, type:"workflow_event", event:{kind:"proposed",...}};
  //        a reader filtering type==="workflow_event" selects ONLY the workflow rows.
  it("T-Audit.1: given a tmp audit path, WHEN writeWorkflowAudit({kind:'proposed', ...}) + writeWorkflowAudit({kind:'always_ask'/'commit_warning'}) then a raw tool-row append (no type field), THEN the workflow lines parse to {ts, type:'workflow_event', event}; a type==='workflow_event' filter selects exactly the workflow rows (backward-compat)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pY1-audit-"));
    const auditPath = join(dir, "audit.jsonl");

    writeWorkflowAudit(auditPath, {
      kind: "proposed",
      workflowId: "wf_x",
      title: "T",
      approvalMode: "manual",
      stepCount: 3,
    });
    writeWorkflowAudit(auditPath, {
      kind: "always_ask",
      workflowId: "wf_x",
      toolName: "telegram_notify",
      turnId: "t1",
    });
    writeWorkflowAudit(auditPath, {
      kind: "commit_warning",
      workflowId: "wf_x",
      detectedLabel: "Send",
      stepId: "step_1",
    });
    // A raw tool-style row (no `type` field — mirrors AuditEntry shape) appended directly.
    writeFileSync(
      auditPath,
      `${JSON.stringify({ ts: new Date().toISOString(), command: "click", output: { ok: true } })}\n`,
      { flag: "a" },
    );

    const lines = readFileSync(auditPath, "utf-8").split("\n").filter(Boolean);
    assert.equal(lines.length, 4, "4 rows total (3 workflow + 1 tool)");

    const first = JSON.parse(lines[0]);
    assert.equal(first.type, "workflow_event", "first row type=workflow_event");
    assert.equal(first.event.kind, "proposed", "first row event.kind=proposed");
    assert.ok(typeof first.ts === "string" && first.ts.length > 0, "ts present");

    // Backward-compat: a reader filtering type === "workflow_event" selects only the 3 workflow rows.
    const workflowRows = lines.map((l) => JSON.parse(l)).filter((r) => r.type === "workflow_event");
    assert.equal(workflowRows.length, 3, "exactly 3 workflow_event rows (tool row excluded)");
    const kinds = workflowRows.map((r) => r.event.kind).sort();
    assert.deepEqual(
      kinds,
      ["always_ask", "commit_warning", "proposed"],
      "all 3 kinds incl always_ask + commit_warning",
    );

    // The tool row has NO type field (backward-compat — old readers ignore it as non-workflow).
    const toolRow = lines.map((l) => JSON.parse(l)).find((r) => r.command === "click");
    assert.ok(toolRow && toolRow.type === undefined, "tool row has no `type` field (coexists)");
  });
});
