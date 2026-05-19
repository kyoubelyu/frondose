/**
 * P-25 Step 5 — T-SRV.BOUND.1..3
 *
 * Tests for SERVER_BOUNDARY constant.
 * Gate coverage: G-P25.13
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SERVER_BOUNDARY } from "../../../src/agent/systemPrompt/serverBoundary.js";

// ─── T-SRV.BOUND ──────────────────────────────────────────────────────────────

describe("SERVER_BOUNDARY constant (G-P25.13)", () => {
  it("T-SRV.BOUND.1: SERVER_BOUNDARY does NOT contain the literal string 'LinkedIn' (case-sensitive)", () => {
    // Given: SERVER_BOUNDARY constant
    // When:  read
    // Then:  does not contain "LinkedIn" (server agent is not LinkedIn-specific)
    assert.ok(!SERVER_BOUNDARY.includes("LinkedIn"), "SERVER_BOUNDARY must NOT mention LinkedIn");
  });

  it("T-SRV.BOUND.2: SERVER_BOUNDARY contains 'mai-server', 'chief-of-staff', and 'tool boundary'", () => {
    // Given: SERVER_BOUNDARY constant
    // When:  read
    // Then:  contains all three expected framing strings
    assert.ok(SERVER_BOUNDARY.includes("mai-server"), "must contain 'mai-server'");
    assert.ok(SERVER_BOUNDARY.includes("chief-of-staff"), "must contain 'chief-of-staff'");
    assert.ok(
      SERVER_BOUNDARY.includes("tool boundary") || SERVER_BOUNDARY.includes("Tool boundary"),
      "must contain 'tool boundary'",
    );
  });

  it("T-SRV.BOUND.3: SERVER_BOUNDARY contains 'escalate_for_capability' (standard escape-hatch reference)", () => {
    // Given: SERVER_BOUNDARY constant
    // When:  read
    // Then:  contains "escalate_for_capability" tool name
    assert.ok(SERVER_BOUNDARY.includes("escalate_for_capability"), "must contain 'escalate_for_capability'");
  });
});
