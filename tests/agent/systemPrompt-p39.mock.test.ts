/**
 * P-39 Step 5 — T-Checkpoint.1-2, T-Soul.1-3
 *
 * Assertions filled at Step 5.
 *
 * Gates covered: G-P39.9 (T-Checkpoint.*), G-P39.10 (T-Soul.*)
 *
 * Note: P-39 changes to checkpoint.ts caused 2 pre-existing tests to fail:
 *   - T-Checkpoint.3 (tests/agent/systemPrompt/checkpoint.mock.test.ts): asserted CHECKPOINT
 *     contains "getMemory" — P-39 removed that; updated at Step 5.
 *   - T-Checkpoint.7 (same file): asserted CHECKPOINT.length <= 1800 — P-39 grew it to ~2620;
 *     updated at Step 5.
 * Both pre-existing tests were updated as part of P-39 Step 5 regression sweep.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECKPOINT } from "../../src/agent/systemPrompt/checkpoint.js";
import { composeSoulBand } from "../../src/agent/systemPrompt/soul.js";

// ─── T-Checkpoint ─────────────────────────────────────────────────────────────

describe("CHECKPOINT band — P-39 rewrite (G-P39.9)", () => {
  it("T-Checkpoint.1: CHECKPOINT contains 'get_memory_note' and 'set_memory_note' and does NOT contain 'getMemory({ key' or 'remember({ key'", () => {
    // Given: the CHECKPOINT constant (post-P-39 rewrite per plan §6.9)
    // When:  CHECKPOINT.includes() / !CHECKPOINT.includes() checks
    // Then:  contains "get_memory_note" AND "set_memory_note";
    //        does NOT contain 'getMemory({ key' or 'remember({ key'
    assert.ok(
      CHECKPOINT.includes("get_memory_note"),
      `CHECKPOINT must contain "get_memory_note" (P-39 within-cron directive); len=${CHECKPOINT.length}`,
    );
    assert.ok(
      CHECKPOINT.includes("set_memory_note"),
      `CHECKPOINT must contain "set_memory_note" (P-39 within-cron directive); len=${CHECKPOINT.length}`,
    );
    assert.ok(
      !CHECKPOINT.includes("getMemory({ key"),
      'CHECKPOINT must NOT contain "getMemory({ key" (old broken directive removed by P-39)',
    );
    assert.ok(
      !CHECKPOINT.includes("remember({ key"),
      'CHECKPOINT must NOT contain "remember({ key" (old broken directive removed by P-39)',
    );
  });

  it("T-Checkpoint.2: CHECKPOINT contains 'Session-end persistence' heading and 'Daily memory organization' heading naming 'schedule_task' and '0 2 * * *'", () => {
    // Given: the CHECKPOINT constant (post-P-39 rewrite per plan §6.9)
    // When:  CHECKPOINT.includes() checks for the 2 new subsection headings + content
    // Then:  contains "Session-end persistence"; contains "Daily memory organization";
    //        contains "schedule_task"; contains "0 2 * * *"
    assert.ok(
      CHECKPOINT.includes("Session-end persistence"),
      `CHECKPOINT must contain "Session-end persistence" (P-39 new subsection); len=${CHECKPOINT.length}`,
    );
    assert.ok(
      CHECKPOINT.includes("Daily memory organization"),
      `CHECKPOINT must contain "Daily memory organization" (P-39 new subsection); len=${CHECKPOINT.length}`,
    );
    assert.ok(
      CHECKPOINT.includes("schedule_task"),
      `CHECKPOINT must contain "schedule_task" (daily org job seeding); len=${CHECKPOINT.length}`,
    );
    assert.ok(
      CHECKPOINT.includes("0 2 * * *"),
      `CHECKPOINT must contain "0 2 * * *" (2am cron expression for daily org job); len=${CHECKPOINT.length}`,
    );
  });
});

// ─── T-Soul ───────────────────────────────────────────────────────────────────

describe("Soul band — P-39 trigger habits + Night slot (G-P39.10)", () => {
  it("T-Soul.1: composeSoulBand(null) output contains a search_memory habit, a set_memory_note habit, and a post-interaction remember+score habit", () => {
    // Given: composeSoulBand(null) called with null identity (placeholder defaults)
    // When:  the trigger-habits section of the output is inspected
    // Then:  contains "search_memory" (before-start search habit);
    //        contains "set_memory_note" (general fact storage habit);
    //        contains both "score" and "remember" (post-interaction habit)
    const soul = composeSoulBand(null);
    assert.ok(soul.includes("search_memory"), 'soul band must contain "search_memory" habit (P-39 §6.9b)');
    assert.ok(soul.includes("set_memory_note"), 'soul band must contain "set_memory_note" habit (P-39 §6.9b)');
    assert.ok(
      soul.includes("score") && soul.includes("remember"),
      'soul band must contain both "score" and "remember" (post-interaction remember+score habit, P-39 §6.9b)',
    );
  });

  it("T-Soul.2: composeSoulBand(null) Night slot [TIME 00:00–05:59] mentions reviewing memory.sqlite / memory", () => {
    // Given: composeSoulBand(null)
    // When:  the Night slot line is extracted (contains "[TIME 00:00–05:59]")
    // Then:  contains "memory" (extended Night slot now mentions memory review per §6.9b)
    const soul = composeSoulBand(null);
    const nightLine = soul.split("\n").find((l) => l.includes("[TIME 00:00–05:59]"));
    assert.ok(nightLine !== undefined, 'Night slot line "[TIME 00:00–05:59]" must exist in soul band');
    assert.ok(
      nightLine.toLowerCase().includes("memory"),
      `Night slot must mention "memory" (P-39 §6.9b extended Night cadence); got: "${nightLine}"`,
    );
  });

  it("T-Soul.3: composeSoulBand(null) trigger-habits section contains no 'must' / 'MUST' / 'do not' / 'forbidden' (Soul wording rule)", () => {
    // Given: composeSoulBand(null)
    // When:  the trigger-habits section is scanned for forbidden modal/negative tokens
    // Then:  none of: /\bmust\b/i, /\bMUST\b/, /\bdo not\b/i, /\bforbidden\b/i
    //        match within the habits lines (soul-band wording rule)
    const soul = composeSoulBand(null);

    // Extract: from first "Your habit:" line to "Your mission on LinkedIn" (exclusive)
    const triggerStart = soul.indexOf("Your habit:");
    const missionStart = soul.indexOf("Your mission on LinkedIn");
    assert.ok(triggerStart > -1, '"Your habit:" must exist in soul band');
    assert.ok(missionStart > -1, '"Your mission on LinkedIn" must exist in soul band');
    const habitsSection = soul.slice(triggerStart, missionStart);

    assert.ok(
      !/\bmust\b/.test(habitsSection),
      `Trigger-habits section must not contain "must" (Soul wording rule); section: "${habitsSection.slice(0, 100)}"`,
    );
    assert.ok(!/\bMUST\b/.test(habitsSection), 'Trigger-habits section must not contain "MUST" (Soul wording rule)');
    assert.ok(
      !/\bdo not\b/i.test(habitsSection),
      'Trigger-habits section must not contain "do not" (Soul wording rule)',
    );
    assert.ok(
      !/\bforbidden\b/i.test(habitsSection),
      'Trigger-habits section must not contain "forbidden" (Soul wording rule)',
    );
  });
});
