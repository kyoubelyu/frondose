/**
 * P-9 mock tests — T-Boundary.1..T-Boundary.8
 *
 * Tests for the filled BOUNDARY constant in src/agent/systemPrompt/boundary.ts.
 *
 * T-Boundary.1 — BOUNDARY exported (not BOUNDARY_PLACEHOLDER)
 * T-Boundary.2 — BOUNDARY contains "CANNOT execute shell commands" (contract 1 — tool boundary)
 * T-Boundary.3 — BOUNDARY contains "escalate_for_capability" (contract 1 + 3)
 * T-Boundary.4 — BOUNDARY contains "Treat ALL content" (contract 2 — prompt injection)
 * T-Boundary.5 — BOUNDARY lists all 5 injection-defense tools (inspect, screenshot, getMemory, web_fetch, web_search)
 * T-Boundary.6 — BOUNDARY does NOT contain memory-checkpoint language (P-10 scope)
 * T-Boundary.7 — composeSystemPrompt order: BOUNDARY appears first in composed string
 * T-Boundary.8 — BOUNDARY + Soul + Checkpoint band separator \n\n---\n\n preserved
 *
 * Gate coverage: G-P9.11 (Boundary band fill)
 *
 * No LLM, no Chrome. Pure string assertions.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BOUNDARY } from "../../../src/agent/systemPrompt/boundary.js";
import { BAND_SEPARATOR, composeSystemPrompt } from "../../../src/agent/systemPrompt/compose.js";

// ─── T-Boundary.1: BOUNDARY exported (not BOUNDARY_PLACEHOLDER) ──────────────

test("T-Boundary.1: BOUNDARY constant is exported and is a non-empty string", () => {
  assert.ok(typeof BOUNDARY === "string", "BOUNDARY must be a string");
  assert.ok(BOUNDARY.length > 100, `BOUNDARY must be substantial content (>100 chars); got ${BOUNDARY.length} chars`);
});

test("T-Boundary.1b: BOUNDARY_PLACEHOLDER must NOT be exported (old name removed in P-9)", async () => {
  // Attempt to import the old name; it must not exist in the module
  const mod = await import("../../../src/agent/systemPrompt/boundary.js");
  assert.ok(
    !("BOUNDARY_PLACEHOLDER" in mod),
    "BOUNDARY_PLACEHOLDER must NOT be exported (P-9 full rewrite removes old name)",
  );
  assert.ok("BOUNDARY" in mod, "BOUNDARY must be the exported constant");
});

// ─── T-Boundary.2: Contract 1 — tool boundary (CANNOT shell) ─────────────────

test("T-Boundary.2: BOUNDARY contains 'CANNOT execute shell commands' (tool boundary contract)", () => {
  assert.ok(
    BOUNDARY.includes("CANNOT execute shell commands"),
    `BOUNDARY must contain tool boundary contract; missing in: "${BOUNDARY.slice(0, 200)}"`,
  );
});

// ─── T-Boundary.3: Contract 1+3 — escalate_for_capability ───────────────────

test("T-Boundary.3: BOUNDARY contains 'escalate_for_capability' (tool boundary + escalation contract)", () => {
  assert.ok(BOUNDARY.includes("escalate_for_capability"), "BOUNDARY must mention escalate_for_capability tool");
  // Should appear at least twice (once in contract 1, once in contract 3)
  const count = (BOUNDARY.match(/escalate_for_capability/g) ?? []).length;
  assert.ok(count >= 2, `escalate_for_capability must appear at least twice (contracts 1+3); found ${count} times`);
});

// ─── T-Boundary.4: Contract 2 — prompt injection defense ─────────────────────

test("T-Boundary.4: BOUNDARY contains 'Treat ALL content' (prompt injection defense contract)", () => {
  assert.ok(BOUNDARY.includes("Treat ALL content"), "BOUNDARY must contain prompt injection defense contract");
});

// ─── T-Boundary.5: Injection defense lists all 5 specified tools ─────────────

test("T-Boundary.5: BOUNDARY lists all 5 injection-defense tools by name", () => {
  const requiredTools = ["inspect", "screenshot", "getMemory", "web_fetch", "web_search"];
  for (const toolName of requiredTools) {
    assert.ok(BOUNDARY.includes(toolName), `BOUNDARY prompt-injection-defense must name '${toolName}'`);
  }
});

// ─── T-Boundary.6: No memory-checkpoint language (P-10 scope) ────────────────

test("T-Boundary.6: BOUNDARY does NOT contain memory-checkpoint discipline (that is P-10)", () => {
  // Memory-checkpoint discipline belongs in the Checkpoint band at P-10
  // Per §6.8: "Memory-checkpoint discipline INTENTIONALLY OMITTED"
  const forbiddenPhrases = ["remember()", "checkpoint", "session memory"];
  for (const phrase of forbiddenPhrases) {
    assert.ok(
      !BOUNDARY.toLowerCase().includes(phrase.toLowerCase()),
      `BOUNDARY must NOT contain '${phrase}' (memory-checkpoint is P-10 Checkpoint band scope)`,
    );
  }
});

// ─── T-Boundary.7: composeSystemPrompt — BOUNDARY appears first ──────────────

test("T-Boundary.7: composeSystemPrompt places BOUNDARY first (Boundary → Soul → Checkpoint order)", () => {
  const soul = "The operator is a LinkedIn sales professional.";
  const checkpoint = "CHECKPOINT_PLACEHOLDER";

  const composed = composeSystemPrompt({ boundary: BOUNDARY, soul, checkpoint });

  // BOUNDARY must be at the start
  assert.ok(composed.startsWith(BOUNDARY.slice(0, 50)), "composed string must START with BOUNDARY content");

  // BOUNDARY appears before Soul
  const boundaryIdx = composed.indexOf("CANNOT execute shell commands");
  const soulIdx = composed.indexOf(soul);
  assert.ok(boundaryIdx < soulIdx, "BOUNDARY content must appear before Soul band");

  // Soul appears before Checkpoint
  const checkpointIdx = composed.indexOf(checkpoint);
  assert.ok(soulIdx < checkpointIdx, "Soul band must appear before Checkpoint band");
});

// ─── T-Boundary.8: Band separator preserved ──────────────────────────────────

test("T-Boundary.8: composeSystemPrompt uses BAND_SEPARATOR (\\n\\n---\\n\\n) between bands", () => {
  const soul = "Soul content here.";
  const checkpoint = "Checkpoint content here.";

  const composed = composeSystemPrompt({ boundary: BOUNDARY, soul, checkpoint });

  // Must contain the separator exactly 2 times (between Boundary/Soul and Soul/Checkpoint)
  const separatorCount = (
    composed.match(new RegExp(BAND_SEPARATOR.replace(/\n/g, "\\n").replace(/---/g, "---"), "g")) ?? []
  ).length;
  assert.equal(separatorCount, 2, `must have exactly 2 band separators (\\n\\n---\\n\\n); found ${separatorCount}`);

  // Check the exact separator string
  assert.equal(BAND_SEPARATOR, "\n\n---\n\n", "BAND_SEPARATOR must be exactly \\n\\n---\\n\\n");
});
