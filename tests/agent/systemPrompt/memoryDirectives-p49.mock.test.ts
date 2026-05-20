/**
 * P-49 Step 5 — T-CkMem.1..T-CkMem.8 (G-P49.1..G-P49.5)
 *
 * Pure string-content assertions for the P-49 prompt-tune phase:
 *   1. `src/agent/systemPrompt/checkpoint.ts` — new `**Task-start context lookup:**`
 *      subsection inserted as the FIRST body block (plan §5.1 LOCKED).
 *   2. `src/agent/systemPrompt/soul.ts:84` — H-4 narrowed from "person or topic" to
 *      "specific person" only (plan §5.2 LOCKED).
 *
 * Gate coverage:
 *   G-P49.1 — task-start `search_memory` directive present in CHECKPOINT (T-CkMem.1, T-CkMem.2)
 *   G-P49.2 — cron-wake `[TIME HH:MM]` covered by the same directive (T-CkMem.3)
 *   G-P49.3 — conversational-turn carve-out (T-CkMem.4)
 *   G-P49.4 — Soul H-4 narrowed to person-context (T-CkMem.5)
 *   G-P49.5 — band-ordering invariant: directive ONLY in CHECKPOINT (T-CkMem.6)
 *   (G-P49.6 — empirical compliance at P-50/P-51 live phases; NOT in P-49 scope)
 *
 * T-CkMem.7 + T-CkMem.8 are CONCERN-LR-1 fold-ins from docs/phase-49-critics.md:
 *   T-CkMem.7 — OQ-2 silent-0-results clause locked
 *   T-CkMem.8 — once-per-turn anti-refire clause locked
 *
 * No LLM, no async, no fixtures, no filesystem I/O.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOUNDARY } from "../../../src/agent/systemPrompt/boundary.js";
import { CHECKPOINT } from "../../../src/agent/systemPrompt/checkpoint.js";
import { composeSoulBand } from "../../../src/agent/systemPrompt/soul.js";

// ─── G-P49.1: task-start subsection header + first-tool-call imperative ──────

describe("Checkpoint task-start directive — subsection header + search_memory imperative (G-P49.1)", () => {
  it("T-CkMem.1: when CHECKPOINT constant is imported, THEN it contains the literal '**Task-start context lookup:**' subsection header (verbatim with asterisks)", () => {
    // Given: CHECKPOINT constant imported from src/agent/systemPrompt/checkpoint.ts
    //        (post-Step 4b: §5.1 locked subsection inserted between header and Within-cron block)
    // When:  CHECKPOINT.includes("**Task-start context lookup:**") evaluated
    // Then:  true — the subsection header landed in the Checkpoint band with the exact locked text
    assert.ok(
      CHECKPOINT.includes("**Task-start context lookup:**"),
      "T-CkMem.1: CHECKPOINT must contain '**Task-start context lookup:**' (verbatim, with asterisks)",
    );
  });

  it("T-CkMem.2: when CHECKPOINT constant is imported, THEN it contains 'your FIRST tool call MUST be `search_memory`' (imperative MUST + explicit tool name, OQ-3 + OQ-5)", () => {
    // Given: CHECKPOINT constant (post-Step 4b)
    // When:  CHECKPOINT.includes("your FIRST tool call MUST be `search_memory`") — backticks are
    //        literal chars in the resolved string value (template-literal \` escapes are resolved)
    // Then:  true — imperative MUST register + OQ-3 specific-tool-name + task-execution framing
    assert.ok(
      CHECKPOINT.includes("your FIRST tool call MUST be `search_memory`"),
      "T-CkMem.2: CHECKPOINT must contain 'your FIRST tool call MUST be `search_memory`'",
    );
  });
});

// ─── G-P49.2: cron-wake [TIME HH:MM] coverage ─────────────────────────────────

describe("Checkpoint task-start directive — cron-wake [TIME HH:MM] coverage (G-P49.2)", () => {
  it("T-CkMem.3: when CHECKPOINT constant is imported, THEN it contains literal '[TIME HH:MM]' (OQ-1 every-tick cron coverage)", () => {
    // Given: CHECKPOINT constant (post-Step 4b)
    // When:  CHECKPOINT.includes("[TIME HH:MM]") evaluated
    // Then:  true — same-rule clause for cron tick present; ties to Day Rhythm canonical marker
    assert.ok(
      CHECKPOINT.includes("[TIME HH:MM]"),
      "T-CkMem.3: CHECKPOINT must contain '[TIME HH:MM]' cron-wake marker",
    );
  });
});

// ─── G-P49.3: conversational-turn carve-out (OQ-5) ───────────────────────────

describe("Checkpoint task-start directive — conversational carve-out (G-P49.3)", () => {
  it("T-CkMem.4: when CHECKPOINT is imported, THEN it contains BOTH the question-anchor phrase AND the negative carve-out directive (OQ-5 conversational guard)", () => {
    // Given: CHECKPOINT constant (post-Step 4b §5.1 locked text)
    // When:  substring checks for (1) "question, a meta-discussion, or chat"
    //        AND (2) "do NOT call `search_memory` for conversation"
    // Then:  both are true — RISK-1 over-prompting mitigated; directive will not fire on chat turns
    assert.ok(
      CHECKPOINT.includes("question, a meta-discussion, or chat"),
      "T-CkMem.4a: CHECKPOINT must contain conversational question-anchor phrase",
    );
    assert.ok(
      CHECKPOINT.includes("do NOT call `search_memory` for conversation"),
      "T-CkMem.4b: CHECKPOINT must contain negative carve-out 'do NOT call `search_memory` for conversation'",
    );
  });
});

// ─── G-P49.4: Soul H-4 narrowed to person-context (OQ-4) ─────────────────────

describe("Soul H-4 narrow — old 'person or topic' removed + new 'specific person' present (G-P49.4)", () => {
  it("T-CkMem.5: when composeSoulBand(null) is called, THEN 'before you start on a person or topic' is ABSENT (old H-4 removed) AND 'before you act on a specific person' is PRESENT (new H-4)", () => {
    // Given: composeSoulBand(null) rendered (post-Step 4b §5.2 H-4 narrow)
    // When:  substring checks on the rendered Soul band:
    //        (1) includes("before you start on a person or topic") — must be FALSE (old removed)
    //        (2) includes("before you act on a specific person") — must be TRUE (new present)
    // Then:  both conditions hold — H-4 is now reactive person-context, not broad task-start
    const soul = composeSoulBand(null);
    assert.ok(
      !soul.includes("before you start on a person or topic"),
      "T-CkMem.5a: old H-4 'before you start on a person or topic' must be ABSENT from Soul band",
    );
    assert.ok(
      soul.includes("before you act on a specific person"),
      "T-CkMem.5b: new H-4 'before you act on a specific person' must be PRESENT in Soul band",
    );
  });
});

// ─── G-P49.5: band-ordering invariant (directive ONLY in CHECKPOINT) ──────────

describe("Band-ordering invariant — 'Task-start context lookup' in CHECKPOINT only (G-P49.5)", () => {
  it("T-CkMem.6: when BOUNDARY + composeSoulBand(null) + CHECKPOINT are all inspected, THEN 'Task-start context lookup' is ABSENT from BOUNDARY AND Soul, PRESENT in CHECKPOINT", () => {
    // Given: BOUNDARY constant, composeSoulBand(null) rendered, CHECKPOINT constant (post-Step 4b)
    // When:  substring check "Task-start context lookup" in each of the 3 band outputs
    // Then:  BOUNDARY.includes(…) === false (boundary.ts unchanged — CLAUDE.md Product Contract)
    //        composeSoulBand(null).includes(…) === false (Soul band not touched for this directive)
    //        CHECKPOINT.includes(…) === true (directive landed in the correct band only)
    const soul = composeSoulBand(null);
    assert.ok(
      !BOUNDARY.includes("Task-start context lookup"),
      "T-CkMem.6a: 'Task-start context lookup' must be ABSENT from BOUNDARY band",
    );
    assert.ok(
      !soul.includes("Task-start context lookup"),
      "T-CkMem.6b: 'Task-start context lookup' must be ABSENT from Soul band",
    );
    assert.ok(
      CHECKPOINT.includes("Task-start context lookup"),
      "T-CkMem.6c: 'Task-start context lookup' must be PRESENT in CHECKPOINT band",
    );
  });
});

// ─── CONCERN-LR-1 fold: OQ-2 silent-0-results + once-per-turn anti-refire ────
// (Not in plan §6; added per docs/phase-49-critics.md CONCERN-LR-1 recommendation.)

describe("Checkpoint locked-phrase guards — silent 0-results + once-per-turn anti-refire (CONCERN-LR-1 fold)", () => {
  it("T-CkMem.7: when CHECKPOINT is imported, THEN it contains 'Zero results means no prior context; proceed silently' (OQ-2 silent-on-zero-results locked)", () => {
    // Given: CHECKPOINT constant (post-Step 4b §5.1 locked text)
    // When:  CHECKPOINT.includes("Zero results means no prior context; proceed silently")
    // Then:  true — OQ-2 decision (silent vs narrate) is locked in the prompt string;
    //        guards against accidental deletion of the silent-behavior clause
    assert.ok(
      CHECKPOINT.includes("Zero results means no prior context; proceed silently"),
      "T-CkMem.7: CHECKPOINT must contain 'Zero results means no prior context; proceed silently'",
    );
  });

  it("T-CkMem.8: when CHECKPOINT is imported, THEN it contains 'This fires ONCE per task-turn or cron-turn, never mid-task' (once-per-turn anti-refire guard locked)", () => {
    // Given: CHECKPOINT constant (post-Step 4b §5.1 locked text)
    // When:  CHECKPOINT.includes("This fires ONCE per task-turn or cron-turn, never mid-task")
    // Then:  true — RISK-1 anti-refire clause is locked; guards against accidental deletion
    //        of the once-per-turn semantics that prevent excessive search_memory calls
    assert.ok(
      CHECKPOINT.includes("This fires ONCE per task-turn or cron-turn, never mid-task"),
      "T-CkMem.8: CHECKPOINT must contain 'This fires ONCE per task-turn or cron-turn, never mid-task'",
    );
  });
});
