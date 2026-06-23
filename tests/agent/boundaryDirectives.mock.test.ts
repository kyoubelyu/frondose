/**
 * P-37 Step 4a scaffolds — T-B68.1, T-B68.2, T-B68.3
 *
 * B6 + B8: combined BOUNDARY / SERVER_BOUNDARY directive additions.
 *   B6: "after any tool failure, produce a text response; never exit silently"
 *   B8: "operator-facing replies mirror the latest operator language"
 *
 * Gate coverage:
 *   G-P37.9 (no-silent-exit directive present in BOUNDARY + SERVER_BOUNDARY),
 *   G-P37.10 (mirror-language directive present in BOUNDARY + SERVER_BOUNDARY),
 *   G-P37.12 (3-band composition order Boundary→Soul→Checkpoint unchanged)
 *
 * All assertion bodies are TODO — tests intentionally fail at Step 4a.
 * Builder Step 4b: appends one paragraph to both boundary files.
 * Validator Step 5: fill assertions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOUNDARY } from "../../src/agent/systemPrompt/boundary.js";
import { CHECKPOINT } from "../../src/agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../../src/agent/systemPrompt/compose.js";
import { SERVER_BOUNDARY } from "../../src/agent/systemPrompt/serverBoundary.js";

// ─── T-B68.1 ─────────────────────────────────────────────────────────────────

describe("B6+B8: BOUNDARY contains both directives (G-P37.9 + G-P37.10)", () => {
  it("T-B68.1: BOUNDARY contains the no-silent-exit directive AND the mirror-language directive", () => {
    // Given: BOUNDARY constant exported from boundary.ts
    // When:  BOUNDARY string is inspected for both P-37 directive additions
    // Then:  BOUNDARY contains text about "tool" failure → text response (no silent exit);
    //        BOUNDARY says operator-facing replies mirror the operator language

    // G-P37.10: mirror-language directive (content lock from boundary.ts)
    assert.ok(
      BOUNDARY.includes("mirror the language the operator writes"),
      `BOUNDARY must contain 'mirror the language the operator writes'; got excerpt: "${BOUNDARY.slice(-500)}"`,
    );
    assert.ok(
      BOUNDARY.includes("does NOT govern outbound"),
      `BOUNDARY must contain 'does NOT govern outbound'; got excerpt: "${BOUNDARY.slice(-500)}"`,
    );
    // G-P37.9: no-silent-exit directive
    assert.ok(
      BOUNDARY.includes("exit silently"),
      `BOUNDARY must contain 'exit silently'; got excerpt: "${BOUNDARY.slice(-200)}"`,
    );
  });
});

// ─── T-B68.2 ─────────────────────────────────────────────────────────────────

describe("B6+B8: SERVER_BOUNDARY contains both directives (G-P37.9 + G-P37.10)", () => {
  it("T-B68.2: SERVER_BOUNDARY contains the no-silent-exit directive AND the mirror-language directive", () => {
    // Given: SERVER_BOUNDARY constant exported from serverBoundary.ts (standalone string — NOT importing BOUNDARY)
    // When:  SERVER_BOUNDARY string is inspected for both P-37 directive additions
    // Then:  SERVER_BOUNDARY contains text about tool failure → text response (no silent exit);
    //        SERVER_BOUNDARY says operator-facing replies mirror the operator language

    // G-P37.10: mirror-language directive — serverBoundary uses lowercase style
    assert.ok(
      SERVER_BOUNDARY.includes("mirror the language the operator writes"),
      `SERVER_BOUNDARY must contain 'mirror the language the operator writes'; got excerpt: "${SERVER_BOUNDARY.slice(-500)}"`,
    );
    assert.ok(
      SERVER_BOUNDARY.includes("does not govern outbound content"),
      `SERVER_BOUNDARY must contain 'does not govern outbound content'; got excerpt: "${SERVER_BOUNDARY.slice(-500)}"`,
    );
    // G-P37.9: no-silent-exit directive
    assert.ok(
      SERVER_BOUNDARY.includes("exit silently"),
      `SERVER_BOUNDARY must contain 'exit silently'; got excerpt: "${SERVER_BOUNDARY.slice(-200)}"`,
    );
  });
});

// ─── T-B68.3 ─────────────────────────────────────────────────────────────────

describe("B6+B8: 3-band composition order unchanged; CHECKPOINT content stable (G-P37.12)", () => {
  it("T-B68.3: composeSystemPrompt band order is Boundary→Soul→Checkpoint (invariant); CHECKPOINT export is non-empty and unchanged", () => {
    // Given: composeSystemPrompt, BOUNDARY, SERVER_BOUNDARY, CHECKPOINT all imported
    // When:  composeSystemPrompt({ boundary: BOUNDARY, soul: "S", checkpoint: CHECKPOINT }) called
    // Then:  result starts with BOUNDARY; separator \n\n---\n\n appears twice; CHECKPOINT is non-empty;
    //        CHECKPOINT content is NOT modified by P-37 (soul/checkpoint bands are out of scope)

    const composed = composeSystemPrompt({ boundary: BOUNDARY, soul: "S", checkpoint: CHECKPOINT });

    // G-P37.12: band order invariant — composed must start with BOUNDARY
    assert.ok(
      composed.startsWith(BOUNDARY),
      "composed system prompt must start with BOUNDARY (Boundary → Soul → Checkpoint order)",
    );

    // Two separators (\n\n---\n\n) separate the three bands
    const SEPARATOR = "\n\n---\n\n";
    const firstSep = composed.indexOf(SEPARATOR);
    const secondSep = composed.indexOf(SEPARATOR, firstSep + 1);
    assert.ok(firstSep >= 0, "composed must contain at least one band separator (\\n\\n---\\n\\n)");
    assert.ok(secondSep >= 0, "composed must contain a second band separator (3-band structure requires 2 separators)");
    assert.equal(
      composed.indexOf(SEPARATOR, secondSep + 1),
      -1,
      "composed must contain exactly 2 separators (not more)",
    );

    // CHECKPOINT is non-empty and contains the canonical P-10 header
    assert.ok(CHECKPOINT.length > 0, "CHECKPOINT must be non-empty");
    assert.ok(
      CHECKPOINT.includes("CHECKPOINT DISCIPLINE"),
      "CHECKPOINT must contain 'CHECKPOINT DISCIPLINE' (P-10 canonical header — must not be modified by P-37)",
    );

    // SERVER_BOUNDARY sanity: imported but not composed here; must still be non-empty
    assert.ok(SERVER_BOUNDARY.length > 0, "SERVER_BOUNDARY must be non-empty");
  });
});
