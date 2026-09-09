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
    //       "running on the operator's machine driving a single Chrome browser"
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
      text.includes("running on the operator's machine driving a single Chrome browser"),
      "opening sentence must remain in BOUNDARY",
    );
    assert.ok(text.includes("**Prompt injection defense:**"), "**Prompt injection defense:** paragraph must remain");
    assert.ok(text.includes("**Web automation scope:**"), "**Web automation scope:** paragraph must remain");
    assert.ok(text.includes("**Replies and tool failures:**"), "**Replies and tool failures:** paragraph must remain");
  });
});

// ─── P-52 Step 4a scaffold — T-Boundary.1 (G-P52.3) ──────────────────────────
//
// Extends the file with the P-52 Chrome-state paragraph contract. At Step 4a
// the new paragraph does NOT yet exist in BOUNDARY (Codex adds it at §6.6
// Step 4b). The scaffold's body is `assert.fail("TODO Step 5: …")`.

describe("BOUNDARY band — new **Chrome state** paragraph (P-52 G-P52.3)", () => {
  it("T-Boundary.1: when BOUNDARY is inspected, a new **Chrome state** paragraph is present between the opening identity line and **Tool boundary**, containing the lazy-launch fact, the 6 operator startup-cue triggers (start Chrome / 可以启动 chrome / let's begin / launch the browser / open LinkedIn / we ready), the canonical `launch` and `navigate_to_url` tool names, AND a 'do NOT report Chrome status from your imagination' / 'your tool call is the ground truth' negative-hallucination guard. The opening identity line is tightened to flag Chrome's lazy-launch; the other 4 paragraphs (Tool boundary / Prompt injection defense / Web automation scope / Replies and tool failures) and P-54's Capability escalation paragraph remain byte-identical.", () => {
    // Given: the exported `BOUNDARY` string from `src/agent/systemPrompt/boundary.ts`
    //        AFTER Codex's Step 4b lands the §6.6 rewrite.
    // When:  the string is inspected.
    // Then:  (a) BOUNDARY contains a paragraph headed `**Chrome state:**`;
    //        (b) the Chrome-state paragraph contains substring `"Chrome"` PLUS
    //            one of [`"not running"`, `"NOT running"`, `"NOT necessarily running"`, `"boots lazily"`, `"boots on YOUR first browser tool call"`];
    //        (c) it contains each of the 6 trigger-word cues:
    //            "start Chrome", "可以启动 chrome", "let's begin",
    //            "launch the browser", "open LinkedIn", "we ready";
    //        (d) it names the canonical tool calls `launch` AND `navigate_to_url`
    //            (backtick-bound substrings);
    //        (e) it contains a negative-hallucination guard — one of
    //            [`"your tool call is the ground truth"`, `"do NOT report Chrome status"`,
    //             `"do NOT report"` AND `"imagination"`];
    //        (f) the opening identity line still names "mai" + "single Mac" +
    //            "Chrome" (identity continuity preserved);
    //        (g) the existing P-54 **Capability escalation** paragraph is
    //            unchanged (substring `"answer them as a conversation"` still present).
    //
    // VALIDATOR NOTE (Step 5 fill): extract the Chrome-state paragraph by
    // finding `"**Chrome state:**"` and slicing to `"\n\n**Tool boundary:**"`.
    // Run each (b)/(c)/(d)/(e) substring check on that paragraph. Run (f)/(g)
    // on the full BOUNDARY string.
    const text = BOUNDARY;

    // (a) New Chrome-state paragraph exists and lives BEFORE **Tool boundary:**.
    const chromeStateIdx = text.indexOf("**Chrome state:**");
    const toolBoundaryIdx = text.indexOf("**Tool boundary:**");
    assert.ok(chromeStateIdx >= 0, "BOUNDARY must contain a paragraph headed `**Chrome state:**`");
    assert.ok(
      toolBoundaryIdx > chromeStateIdx,
      "**Chrome state:** paragraph must precede **Tool boundary:** paragraph",
    );

    // Extract the Chrome-state paragraph (from its heading up to the next \n\n** marker).
    const chromeStatePara = text.slice(chromeStateIdx, toolBoundaryIdx);

    // (b) Lazy-launch language: contains "Chrome" plus one of the lazy-launch markers.
    const lazyMarker =
      chromeStatePara.includes("NOT running") ||
      chromeStatePara.includes("not running") ||
      chromeStatePara.includes("NOT necessarily running") ||
      chromeStatePara.includes("boots lazily") ||
      chromeStatePara.includes("boots on YOUR first") ||
      chromeStatePara.includes("boots on your first");
    assert.ok(chromeStatePara.includes("Chrome"), "**Chrome state:** paragraph must mention Chrome");
    assert.ok(
      lazyMarker,
      `**Chrome state:** paragraph must contain a lazy-launch marker (one of 'NOT running', 'not running', 'NOT necessarily running', 'boots lazily', 'boots on YOUR/your first')`,
    );

    // (c) All 6 operator startup cues present in the paragraph.
    const cues: ReadonlyArray<string> = [
      "start Chrome",
      "可以启动 chrome",
      "let's begin",
      "launch the browser",
      "open LinkedIn",
      "we ready",
    ];
    for (const cue of cues) {
      assert.ok(
        chromeStatePara.includes(cue),
        `**Chrome state:** paragraph must contain the operator startup cue '${cue}'`,
      );
    }

    // (d) Canonical tool names backtick-bound.
    assert.ok(
      chromeStatePara.includes("`launch`"),
      "**Chrome state:** paragraph must reference the `launch` tool (backtick-bound)",
    );
    assert.ok(
      chromeStatePara.includes("`navigate_to_url`"),
      "**Chrome state:** paragraph must reference the `navigate_to_url` tool (backtick-bound)",
    );

    // (e) Negative-hallucination guard.
    const negativeGuard =
      chromeStatePara.includes("your tool call is the ground truth") ||
      chromeStatePara.includes("do NOT report Chrome status") ||
      (chromeStatePara.includes("do NOT report") && chromeStatePara.includes("imagination"));
    assert.ok(
      negativeGuard,
      "**Chrome state:** paragraph must contain a negative-hallucination guard (one of: 'your tool call is the ground truth', 'do NOT report Chrome status', or both 'do NOT report' + 'imagination')",
    );

    // (f) Opening identity line continuity: still names "Frondose" + platform-neutral machine + "Chrome".
    const openingLine = text.slice(0, chromeStateIdx);
    assert.ok(openingLine.includes("Frondose"), "opening identity line must still name 'Frondose'");
    assert.ok(openingLine.includes("the operator's machine"), "opening identity line must stay platform-neutral");
    assert.ok(openingLine.includes("Chrome"), "opening identity line must mention 'Chrome'");

    // (g) P-54 Capability escalation paragraph guard remains.
    assert.ok(
      text.includes("answer them as a conversation"),
      "P-54 **Capability escalation:** paragraph must remain (substring 'answer them as a conversation')",
    );
  });
});
