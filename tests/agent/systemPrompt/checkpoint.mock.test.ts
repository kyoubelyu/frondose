// P-10 mock tests — T-Checkpoint.1..7
//
// Tests for the filled CHECKPOINT constant in src/agent/systemPrompt/checkpoint.ts.
//
// T-Checkpoint.1 — CHECKPOINT is exported and is a non-empty string;
//                  CHECKPOINT_PLACEHOLDER is NOT exported (export-name swap verifies P-10 rewrite)
// T-Checkpoint.2 — CHECKPOINT contains literal "CRON_RUN_ID=" (LLM idempotency-key anchor)
// T-Checkpoint.3 — CHECKPOINT contains both "getMemory" AND "remember" (idempotency tools named)
// T-Checkpoint.4 — CHECKPOINT contains "telegram_notify" (cron task completion channel)
// T-Checkpoint.5 — CHECKPOINT contains "continueRecent" (NIT-2 fix: OR clause removed; literal pinned)
// T-Checkpoint.6 — composeSystemPrompt({..., checkpoint: CHECKPOINT}) result ends with
//                  BAND_SEPARATOR + CHECKPOINT (Boundary→Soul→Checkpoint order invariant)
// T-Checkpoint.7 — CHECKPOINT.length <= 1500 characters (~250-token budget proxy per OQ-7)
//
// Gate coverage: G-P10.13 (all T-Checkpoint.1..7)
//
// No Chrome, no LLM, no filesystem I/O.

import assert from "node:assert/strict";
import { test } from "node:test";

import { CHECKPOINT } from "../../../src/agent/systemPrompt/checkpoint.js";
import { BAND_SEPARATOR, composeSystemPrompt } from "../../../src/agent/systemPrompt/compose.js";

// ─── T-Checkpoint.1 — export shape ───────────────────────────────────────────

test("T-Checkpoint.1: CHECKPOINT is exported as a non-empty string; CHECKPOINT_PLACEHOLDER is NOT exported from the module", async () => {
  // Given: compiled module src/agent/systemPrompt/checkpoint.ts post-Step-4b
  // When: import { CHECKPOINT } from the module + dynamic import to check all exports
  // Then: CHECKPOINT is a non-empty string; no CHECKPOINT_PLACEHOLDER key exists in module exports
  assert.equal(typeof CHECKPOINT, "string", "CHECKPOINT must be a string");
  assert.ok(CHECKPOINT.length > 0, "CHECKPOINT must be non-empty");

  // Dynamic import returns the same cached module; check that CHECKPOINT_PLACEHOLDER is absent
  const mod = await import("../../../src/agent/systemPrompt/checkpoint.js");
  assert.ok(
    !Object.hasOwn(mod, "CHECKPOINT_PLACEHOLDER"),
    "CHECKPOINT_PLACEHOLDER must NOT be exported from checkpoint.ts (export-name swap must be complete)",
  );
});

// ─── T-Checkpoint.2 — CRON_RUN_ID= substring ─────────────────────────────────

test("T-Checkpoint.2: CHECKPOINT contains the literal substring 'CRON_RUN_ID=' (anchors the LLM idempotency-key extraction)", () => {
  // Given: CHECKPOINT constant post-Step-4b
  // When: CHECKPOINT.includes("CRON_RUN_ID=")
  // Then: true — the cron run ID header format is explicit in the band content
  assert.ok(
    CHECKPOINT.includes("CRON_RUN_ID="),
    `CHECKPOINT must contain "CRON_RUN_ID="; first 200 chars: "${CHECKPOINT.slice(0, 200)}"`,
  );
});

// ─── T-Checkpoint.3 — get_memory_note + set_memory_note substrings (P-39 update) ────────────────

test("T-Checkpoint.3: CHECKPOINT contains 'get_memory_note' AND 'set_memory_note' (P-39 rewrote within-cron directives to use the real tool names)", () => {
  // Given: CHECKPOINT constant (P-39 rewrote the within-cron idempotency directives:
  //        getMemory({ key }) and remember({ key, value }) → get_memory_note / set_memory_note)
  // When: CHECKPOINT.includes("get_memory_note") AND CHECKPOINT.includes("set_memory_note")
  // Then: both are true — the idempotency contract surfaces the real P-39 tool names
  assert.ok(
    CHECKPOINT.includes("get_memory_note"),
    `CHECKPOINT must contain "get_memory_note" (P-39 within-cron directive); len=${CHECKPOINT.length}`,
  );
  assert.ok(
    CHECKPOINT.includes("set_memory_note"),
    `CHECKPOINT must contain "set_memory_note" (P-39 within-cron directive); len=${CHECKPOINT.length}`,
  );
});

// ─── T-Checkpoint.4 — telegram_notify substring ──────────────────────────────

test("T-Checkpoint.4: CHECKPOINT contains 'telegram_notify' (cron task completion delivery channel)", () => {
  // Given: CHECKPOINT constant post-Step-4b
  // When: CHECKPOINT.includes("telegram_notify")
  // Then: true — Checkpoint band instructs the LLM to call telegram_notify after cron task
  assert.ok(CHECKPOINT.includes("telegram_notify"), 'CHECKPOINT must contain "telegram_notify"');
});

// ─── T-Checkpoint.5 — continueRecent substring (NIT-2 fix) ──────────────────

test("T-Checkpoint.5: CHECKPOINT contains the literal substring 'continueRecent' (NIT-2 fix: OR clause removed; cross-session resume contract pinned to exact token)", () => {
  // Given: CHECKPOINT constant post-Step-4b (§6.4 locked content contains "continueRecent" verbatim)
  // When: CHECKPOINT.includes("continueRecent")
  // Then: true — pinning the literal prevents future edits from silently removing the resume signal
  assert.ok(CHECKPOINT.includes("continueRecent"), 'CHECKPOINT must contain "continueRecent"');
});

// ─── T-Checkpoint.6 — 3-band composition order invariant ─────────────────────

test("T-Checkpoint.6: composeSystemPrompt with CHECKPOINT as checkpoint band ends with BAND_SEPARATOR + CHECKPOINT (Boundary→Soul→Checkpoint order invariant)", () => {
  // Given: CHECKPOINT + composeSystemPrompt function + BAND_SEPARATOR constant
  // When: composeSystemPrompt({ boundary: "B", soul: "S", checkpoint: CHECKPOINT })
  // Then: result ends with BAND_SEPARATOR + CHECKPOINT (Checkpoint is the third/last band)
  const result = composeSystemPrompt({ boundary: "B", soul: "S", checkpoint: CHECKPOINT });
  assert.ok(
    result.endsWith(BAND_SEPARATOR + CHECKPOINT),
    "composeSystemPrompt result must end with BAND_SEPARATOR + CHECKPOINT (3-band order invariant)",
  );
});

// ─── T-Checkpoint.7 — character count budget (P-39 update) ──────────────────

test("T-Checkpoint.7: CHECKPOINT.length is <= 4200 characters (P-49 raised the budget: 'Task-start context lookup' subsection added; regression guard updated)", () => {
  // Given: CHECKPOINT constant (P-39 added 'Session-end persistence' + 'Daily memory organization'
  //        subsections → grew from ~1786 chars to ~2620; P-49 added 'Task-start context lookup'
  //        subsection → grew from ~2620 chars to ~3626)
  // When: CHECKPOINT.length measured
  // Then: <= 4200 — generous ceiling preserving meaningful regression guard while allowing P-49 growth
  assert.ok(
    CHECKPOINT.length <= 4200,
    `CHECKPOINT.length=${CHECKPOINT.length} exceeds 4200-char budget (P-49 regression guard)`,
  );
});

// ─── T-Checkpoint.8 — bidirectional Telegram subsection content (P-12 D-3) ────

test("T-Checkpoint.8: CHECKPOINT contains all 5 bidirectional-Telegram anchor substrings (P-12 D-3 — B-2 fix Step 3b: uppercase D in 'Do NOT include')", () => {
  // Given: compiled CHECKPOINT string (post-builder Step 4b — D-3 appends the 4th subsection)
  // When: String.includes() (case-sensitive) for each of the 5 locked §6.2 substrings
  // Then: all 5 present — subsection title, TG_FROM header, TG_PHOTO media tag, auto-reply semantic, don't-echo instruction
  assert.ok(
    CHECKPOINT.includes("Bidirectional Telegram"),
    `CHECKPOINT must contain "Bidirectional Telegram" (D-3 subsection title); len=${CHECKPOINT.length}`,
  );
  assert.ok(
    CHECKPOINT.includes("[TG_FROM="),
    `CHECKPOINT must contain "[TG_FROM=" (inbound DM header format); len=${CHECKPOINT.length}`,
  );
  assert.ok(
    CHECKPOINT.includes("[TG_PHOTO="),
    `CHECKPOINT must contain "[TG_PHOTO=" (media tag format); len=${CHECKPOINT.length}`,
  );
  assert.ok(
    CHECKPOINT.includes("auto-pushed"),
    `CHECKPOINT must contain "auto-pushed" (auto-reply semantic); len=${CHECKPOINT.length}`,
  );
  assert.ok(
    CHECKPOINT.includes("Do NOT include"),
    `CHECKPOINT must contain "Do NOT include" (uppercase D — don't-echo instruction, B-2 fix); len=${CHECKPOINT.length}`,
  );
});
