/**
 * P-25 Step 5 — T-SRV.SOUL.1..4
 *
 * Tests for composeServerSoulBand().
 * Gate coverage: G-P25.12
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeServerSoulBand } from "../../../src/agent/systemPrompt/serverSoul.js";
import type { ServerIdentity } from "../../../src/persistence/serverIdentity.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeMinimalIdentity(overrides?: Partial<ServerIdentity>): ServerIdentity {
  return {
    operatorName: "Alice",
    orchestratorName: "mai-server",
    orchestratorRole: "Operator's chief-of-staff agent",
    priorities: [],
    traits: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── T-SRV.SOUL ───────────────────────────────────────────────────────────────

describe("composeServerSoulBand (G-P25.12)", () => {
  it("T-SRV.SOUL.1: output contains operator name, orchestratorName, and 'chief-of-staff'", () => {
    // Given: minimal ServerIdentity with operatorName="Alice", orchestratorName="mai-server"
    // When:  composeServerSoulBand(identity) called
    // Then:  returned string contains "Alice" AND "mai-server" AND "chief-of-staff"
    const identity = makeMinimalIdentity();
    const output = composeServerSoulBand(identity);
    assert.ok(output.includes("Alice"), "output must contain operator name 'Alice'");
    assert.ok(output.includes("mai-server"), "output must contain orchestrator name 'mai-server'");
    assert.ok(output.includes("chief-of-staff"), "output must contain 'chief-of-staff'");
  });

  it("T-SRV.SOUL.2: output does NOT contain 'LinkedIn', 'ICP', or 'Pain Chain'", () => {
    // Given: minimal ServerIdentity
    // When:  composeServerSoulBand(identity) called
    // Then:  output does NOT contain "LinkedIn" OR "ICP" OR "Pain Chain"
    const identity = makeMinimalIdentity();
    const output = composeServerSoulBand(identity);
    assert.ok(!output.includes("LinkedIn"), "server soul must NOT mention LinkedIn");
    assert.ok(!output.includes("ICP"), "server soul must NOT mention ICP");
    assert.ok(!output.includes("Pain Chain"), "server soul must NOT mention Pain Chain");
  });

  it("T-SRV.SOUL.3: when priorities is ['protect operator time', 'surface anomalies'], both strings appear in output", () => {
    // Given: identity with priorities = ["protect operator time", "surface anomalies"]
    // When:  composeServerSoulBand(identity) called
    // Then:  output contains both "protect operator time" and "surface anomalies"
    const identity = makeMinimalIdentity({
      priorities: ["protect operator time", "surface anomalies"],
    });
    const output = composeServerSoulBand(identity);
    assert.ok(output.includes("protect operator time"), "priority 1 must appear in output");
    assert.ok(output.includes("surface anomalies"), "priority 2 must appear in output");
  });

  it("T-SRV.SOUL.4: output contains server-specific day-rhythm marker (e.g. '[TIME HH:MM]' or 'Day rhythm')", () => {
    // Given: minimal ServerIdentity
    // When:  composeServerSoulBand(identity) called
    // Then:  output contains "Day rhythm" or "[TIME " (server-specific cron cadence reference)
    const identity = makeMinimalIdentity();
    const output = composeServerSoulBand(identity);
    const hasDayRhythm = output.includes("Day rhythm") || output.includes("[TIME ");
    assert.ok(hasDayRhythm, `output must contain day-rhythm marker; got: ${output.slice(0, 200)}`);
  });

  it("T-SRV.SOUL.5: C-5 fix — section separator is \\n\\n (paragraph breaks preserved between non-null sections)", () => {
    // Given: identity with both traits and priorities (3 sections: idLine, traits, prios, role, rhythm)
    // When:  composeServerSoulBand(identity) called
    // Then:  output contains "\n\n" separator (paragraph breaks); no collapsed wall-of-text
    const identity = makeMinimalIdentity({
      traits: ["direct", "attentive"],
      priorities: ["protect operator time"],
    });
    const output = composeServerSoulBand(identity);
    assert.ok(output.includes("\n\n"), "output must contain \\n\\n paragraph separators (C-5 fix)");
  });
});
