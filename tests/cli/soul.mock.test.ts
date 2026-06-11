/**
 * P-5 mock tests — T-M_p5.20: `mai soul` subcommand.
 *
 * P-APP-11 stage (b1): T-M_p5.19 (soul show) deleted — 'show' action removed from soul.ts.
 * T-M_p5.20 — soul reset core persist path: applyIdentityPatch(freeAxes) + writeIdentity + re-read (G-P5.4, OQ-7)
 *
 * T-M_p5.20 tests the persist business logic directly (applyIdentityPatch + writeIdentity).
 * The interactive readline flow is integration-tested by live test L-p5.4 (mai soul reset).
 * Note: promptFreeAxes uses rl.once("close",...) which fires on pipe EOF — the interactive
 * flow cannot be driven by piped stdin in a subprocess; this is a known TTY-only design.
 *
 * No Chrome, no LLM required.
 */

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  applyIdentityPatch,
  identityRecordSchema,
  readIdentity,
  writeIdentity,
} from "../../src/persistence/identity.js";

// ─── T-M_p5.20 — soul reset business logic (applyIdentityPatch + writeIdentity) ─

// Note on test approach: `promptFreeAxes` uses `rl.once("close", onClose)` which fires
// on pipe EOF — the function is designed for interactive TTY and cannot be driven by
// piped stdin in a subprocess (pipe EOF fires "close" before the second question is read).
// The interactive end-to-end is covered by live test L-p5.4 (mai soul reset with piped stdin).
//
// T-M_p5.20 tests the CORE PERSIST PATH: applyIdentityPatch + writeIdentity + freeAxesSchema
// — the exact sequence runSoulReset calls after promptFreeAxes returns axes.
// This proves the reset mechanism persists correctly given any axes collection outcome.

test("T-M_p5.20: soul reset core persist path — applyIdentityPatch(freeAxes) + writeIdentity + re-read validates", () => {
  const identityPath = path.resolve(process.cwd(), `tests/_tmp_soul_identity_${process.pid}.json`);
  try {
    // 1. Write initial identity with OLD axes (fixed past timestamp to ensure updatedAt changes)
    const initial = identityRecordSchema.parse({
      fullName: "ResetTestUser",
      company: "ResetTestCo",
      freeAxes: {
        pain_chain_lean: "cause-confirmed-then-up",
        lead_role: "pain-owner first",
        discovery_lean: "ratio-disciplined",
        story_shape: "reference-story led",
      },
      updatedAt: "2026-01-01T00:00:00.000Z", // fixed past ts so merged.updatedAt differs
    });
    writeIdentity(initial, identityPath);

    // 2. Simulate axis re-pick (as promptFreeAxes would return)
    const newAxes = {
      pain_chain_lean: "cause-first",
      lead_role: "economic-buyer first",
      discovery_lean: "R-lean",
      story_shape: "initial-value-prop led",
    };

    // 3. Apply patch + persist (exact sequence runSoulReset uses)
    const patched = applyIdentityPatch(initial, { freeAxes: newAxes });
    const merged = identityRecordSchema.parse({
      ...patched,
      updatedAt: new Date().toISOString(),
    });
    writeIdentity(merged, identityPath);

    // 4. Re-read and verify
    const updated = readIdentity(identityPath);
    assert.ok(updated !== null, "T-M_p5.20: identity.json must be readable after reset persist");
    assert.equal(
      updated.freeAxes?.pain_chain_lean,
      "cause-first",
      `T-M_p5.20: pain_chain_lean must be "cause-first" after reset`,
    );
    assert.equal(
      updated.freeAxes?.lead_role,
      "economic-buyer first",
      `T-M_p5.20: lead_role must be "economic-buyer first" after reset`,
    );
    assert.equal(updated.freeAxes?.discovery_lean, "R-lean", `T-M_p5.20: discovery_lean must be "R-lean" after reset`);
    assert.equal(
      updated.freeAxes?.story_shape,
      "initial-value-prop led",
      `T-M_p5.20: story_shape must be "initial-value-prop led" after reset`,
    );
    // updatedAt must be updated
    assert.notEqual(updated.updatedAt, initial.updatedAt, "T-M_p5.20: updatedAt must change after reset");

    console.log("T-M_p5.20: soul reset core persist path verified — new freeAxes persisted + re-read correctly ✓");
  } finally {
    try {
      rmSync(identityPath, { force: true });
    } catch {
      // best-effort
    }
  }
});
