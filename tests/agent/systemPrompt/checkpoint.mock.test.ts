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

// ─── T-Checkpoint.3 — getMemory + remember substrings ────────────────────────

test("T-Checkpoint.3: CHECKPOINT contains both 'getMemory' AND 'remember' (both idempotency tools named by name in the discipline)", () => {
  // Given: CHECKPOINT constant post-Step-4b
  // When: CHECKPOINT.includes("getMemory") AND CHECKPOINT.includes("remember")
  // Then: both are true — the idempotency contract surfaces both tool names
  assert.ok(CHECKPOINT.includes("getMemory"), 'CHECKPOINT must contain "getMemory"');
  assert.ok(CHECKPOINT.includes("remember"), 'CHECKPOINT must contain "remember"');
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

// ─── T-Checkpoint.7 — character count budget ─────────────────────────────────

test("T-Checkpoint.7: CHECKPOINT.length is <= 1500 characters (rough proxy for ~250-token budget per OQ-7; regression guard)", () => {
  // Given: CHECKPOINT constant post-Step-4b; §6.4 content estimated ~1350 chars
  // When: CHECKPOINT.length
  // Then: <= 1500 — conservative ceiling preventing accidental bloat in future edits
  assert.ok(
    CHECKPOINT.length <= 1500,
    `CHECKPOINT.length=${CHECKPOINT.length} exceeds 1500-char budget (regression guard)`,
  );
});
