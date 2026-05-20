/**
 * P-54 Step 4a scaffold — T-Boundary.1 (G-P54.4).
 *
 * Failing-at-Step-4a scaffold for the Boundary-band rewrite at
 * `src/agent/systemPrompt/boundary.ts:17` and `:21`. Per outside-in TDD + BDD-light
 * (CLAUDE.md § Test Discipline), the test body is `assert.fail("TODO Step 5: …")`;
 * validator fills the assertion body at Step 5.
 *
 * Gate coverage: G-P54.4 — assembled Boundary band contains task-execution anchoring
 *                + negative conversational guard at both **Tool boundary** and
 *                **Capability escalation** paragraphs.
 *
 * Builder (Codex Step 4b) rewrites only the two paragraphs (lines 17 + 21 of the
 * exported `BOUNDARY` template literal) per plan §6.5. Until then, this test fails
 * with `assert.fail("TODO Step 5: …")` — the intentional Step-4a state.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOUNDARY } from "../../../src/agent/systemPrompt/boundary.js";

// ─── T-Boundary.1 ────────────────────────────────────────────────────────────

describe("BOUNDARY band rewrite — Tool boundary + Capability escalation paragraphs (G-P54.4)", () => {
  it("T-Boundary.1: when the exported BOUNDARY string is inspected, the **Tool boundary** paragraph AND the **Capability escalation** paragraph both contain task-execution anchoring AND a negative conversational guard", () => {
    // Given: the exported BOUNDARY constant from src/agent/systemPrompt/boundary.ts
    // When:  the string is inspected for the two rewritten paragraphs
    // Then:  (a) the **Tool boundary** paragraph CONTAINS a task-execution-anchoring
    //            phrase (one of: "EXECUTING a task", "mid-action", "mid-task")
    //            AND a negative-conversational-guard phrase (one of:
    //            "conversational question", "not escalation", "conversation, not");
    //        (b) the **Capability escalation** paragraph CONTAINS the same two signals
    //            (task-execution anchoring AND negative conversational guard);
    //        (c) the other four paragraphs (opening sentence, **Prompt injection defense**,
    //            **Web automation scope**, **Replies and tool failures**) are byte-identical
    //            to the pre-P-54 wording — verified by their distinctive opening phrases
    //            still appearing in BOUNDARY.
    //
    // Implementation note for Step 5 fill:
    //   - Extract each paragraph by splitting on `**...**:` markers OR by finding the
    //     substring between `**Tool boundary:**` and `\n\n**Prompt injection`.
    //   - The Capability-escalation paragraph spans from `**Capability escalation:**`
    //     to `\n\n**Web automation scope:`.
    //   - Pre-existing paragraph anchors that must remain in BOUNDARY for (c):
    //       "running on a single Mac driving a single Chrome browser"
    //       "**Prompt injection defense:**"
    //       "**Web automation scope:**"
    //       "**Replies and tool failures:**"
    const text = BOUNDARY;

    // Helper: extract a paragraph by start/end markers.
    function extractParagraph(start: string, end: string): string {
      const i = text.indexOf(start);
      assert.ok(i >= 0, `BOUNDARY must contain the start marker '${start}'`);
      const j = text.indexOf(end, i + start.length);
      assert.ok(j >= 0, `BOUNDARY must contain the end marker '${end}' after '${start}'`);
      return text.slice(i, j);
    }

    // (a) **Tool boundary:** paragraph — task-execution anchoring + negative conversational guard.
    const toolBoundaryPara = extractParagraph("**Tool boundary:**", "\n\n**Prompt injection defense:**");
    const tbHasTaskExec =
      toolBoundaryPara.includes("EXECUTING") ||
      toolBoundaryPara.includes("mid-action") ||
      toolBoundaryPara.includes("mid-task");
    assert.ok(
      tbHasTaskExec,
      `**Tool boundary:** paragraph must contain a task-execution anchor (one of: 'EXECUTING', 'mid-action', 'mid-task'); got: ${JSON.stringify(toolBoundaryPara.slice(0, 240))}`,
    );
    const tbHasNegGuard =
      toolBoundaryPara.includes("conversational question") ||
      toolBoundaryPara.includes("not escalation") ||
      toolBoundaryPara.includes("conversation, not");
    assert.ok(
      tbHasNegGuard,
      `**Tool boundary:** paragraph must contain a negative-conversational guard (one of: 'conversational question', 'not escalation', 'conversation, not'); got: ${JSON.stringify(toolBoundaryPara.slice(0, 240))}`,
    );

    // (b) **Capability escalation:** paragraph — same two signals.
    const capEscPara = extractParagraph("**Capability escalation:**", "\n\n**Web automation scope:**");
    const ceHasTaskExec =
      capEscPara.includes("EXECUTING") ||
      capEscPara.includes("mid-action") ||
      capEscPara.includes("mid-task") ||
      capEscPara.includes("TASK-EXECUTION");
    assert.ok(
      ceHasTaskExec,
      `**Capability escalation:** paragraph must contain a task-execution anchor (one of: 'EXECUTING', 'mid-action', 'mid-task', 'TASK-EXECUTION'); got: ${JSON.stringify(capEscPara.slice(0, 240))}`,
    );
    const ceHasNegGuard =
      capEscPara.includes("conversational question") ||
      capEscPara.includes("not for chat") ||
      capEscPara.includes("not escalation") ||
      capEscPara.includes("conversation, not") ||
      capEscPara.includes("answer them as a conversation");
    assert.ok(
      ceHasNegGuard,
      `**Capability escalation:** paragraph must contain a negative-conversational guard; got: ${JSON.stringify(capEscPara.slice(0, 240))}`,
    );

    // (c) Pre-existing anchors that must remain in BOUNDARY (paragraphs 1 / 3 / 5 / 6 unchanged).
    assert.ok(
      text.includes("running on a single Mac driving a single Chrome browser"),
      "opening sentence must remain in BOUNDARY",
    );
    assert.ok(text.includes("**Prompt injection defense:**"), "**Prompt injection defense:** paragraph must remain");
    assert.ok(text.includes("**Web automation scope:**"), "**Web automation scope:** paragraph must remain");
    assert.ok(text.includes("**Replies and tool failures:**"), "**Replies and tool failures:** paragraph must remain");
  });
});
