/**
 * P-57e rev-2 Step 5 — T-Issue.1 — FILLED
 * (G-P57e.8)
 *
 * Per source grep at Step 5 baseline (post-Step 4b):
 *   - boundary.ts L32 "## Self-report + fallback protocol (P-57e rev-2)"
 *   - L36 dedupKey format `failure:<toolName>:<error.kind>`
 *   - L39 all 6 non-transient kinds
 *   - L43 "## Memory-first passive-observation responses (P-57e rev-2)"
 *   - L44 "Routine engagement clicks (Like / Comment / Connect / Send / Follow)"
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/agent/systemPrompt/boundary-p57e.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOUNDARY } from "../../../src/agent/systemPrompt/boundary.js";
import { composeSoulBand } from "../../../src/agent/systemPrompt/soul.js";

const SOUL = composeSoulBand(null);

// ─── T-Issue.1 — Boundary Self-report+fallback + Memory-first paragraphs ─────

describe("BOUNDARY constant — Self-report+fallback protocol + Memory-first paragraphs present; Soul UNCHANGED (G-P57e.8)", () => {
  it("T-Issue.1: given BOUNDARY import, WHEN substring searches applied, THEN contains 'Self-report + fallback protocol (P-57e rev-2)' + 'failure:<toolName>:<error.kind>' dedupKey format + all 6 non-transient kinds + 'Memory-first passive-observation responses (P-57e rev-2)' + 'Routine engagement clicks (Like / Comment / Connect / Send / Follow)'; AND Soul band does NOT contain any P-57e marker (UNCHANGED per §5.6)", () => {
    assert.ok(typeof BOUNDARY === "string" && BOUNDARY.length > 0, "BOUNDARY must be non-empty exported string");

    // (a) Self-report paragraph header
    assert.ok(
      BOUNDARY.includes("Self-report + fallback protocol (P-57e rev-2)"),
      "(a) BOUNDARY must contain 'Self-report + fallback protocol (P-57e rev-2)' header",
    );
    // (b) dedupKey format
    assert.ok(
      BOUNDARY.includes("failure:<toolName>:<error.kind>"),
      "(b) BOUNDARY must contain 'failure:<toolName>:<error.kind>' dedupKey format",
    );
    // (c) all 6 non-transient error kinds
    for (const kind of [
      "runtime_error",
      "vision_unavailable",
      "scope_disabled",
      "ambiguous_target",
      "invalid_input",
      "not_found",
    ]) {
      assert.ok(BOUNDARY.includes(kind), `(c) BOUNDARY must enumerate non-transient kind '${kind}'`);
    }
    // (d) Memory-first paragraph header
    assert.ok(
      BOUNDARY.includes("Memory-first passive-observation responses (P-57e rev-2)"),
      "(d) BOUNDARY must contain 'Memory-first passive-observation responses (P-57e rev-2)' header",
    );
    // (e) routine-engagement directive
    assert.ok(
      BOUNDARY.includes("Routine engagement clicks (Like / Comment / Connect / Send / Follow)"),
      "(e) BOUNDARY must contain 'Routine engagement clicks (Like / Comment / Connect / Send / Follow)'",
    );

    // Soul UNCHANGED — no P-57e markers leaked into Soul band
    assert.ok(typeof SOUL === "string" && SOUL.length > 0, "SOUL must be non-empty");
    assert.ok(
      !SOUL.includes("Self-report + fallback protocol (P-57e rev-2)"),
      "Soul must NOT contain P-57e Self-report header (Boundary's job per §5.6)",
    );
    assert.ok(
      !SOUL.includes("Memory-first passive-observation responses (P-57e rev-2)"),
      "Soul must NOT contain P-57e Memory-first header (Boundary's job per §5.6)",
    );
  });
});
