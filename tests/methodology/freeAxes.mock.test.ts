/**
 * P-5 mock tests — T-M_p5.16..T-M_p5.17: freeAxes schema + identity schema extension.
 *
 * Tests:
 *   T-M_p5.16 — freeAxesSchema accepts all 25 verbatim option keys; rejects invalid keys (G-P5.5)
 *   T-M_p5.17 — identityRecordSchema with optional freeAxes: pre-P-5 record validates; P-5 record validates; invalid freeAxes rejects (G-P5.1)
 *
 * No Chrome, no LLM, no SQLite required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { FREE_AXES, freeAxesSchema } from "../../src/methodology/freeAxes.js";
import { identityRecordSchema } from "../../src/persistence/identity.js";

// ─── T-M_p5.16 — freeAxesSchema accepts all 25 options ──────────────────────

test("T-M_p5.16: freeAxesSchema accepts all 25 verbatim option keys across 4 axes; rejects invalid keys", () => {
  // Gather all option keys from the FREE_AXES definitions
  const axisKeys = ["pain_chain_lean", "lead_role", "discovery_lean", "story_shape"] as const;

  // Count total options
  let totalOptions = 0;
  for (const axisKey of axisKeys) {
    const axis = FREE_AXES[axisKey];
    assert.ok(axis !== undefined, `T-M_p5.16: FREE_AXES.${axisKey} must exist`);
    totalOptions += axis.options.length;
  }
  assert.equal(totalOptions, 25, `T-M_p5.16: total option count across 4 axes must be 25; got ${totalOptions}`);

  // Verify each individual option key is accepted by freeAxesSchema in combination
  // Test each axis's options in a valid cross-product with defaults for other axes
  const defaults = {
    pain_chain_lean: "cause-confirmed-then-up",
    lead_role: "pain-owner first",
    discovery_lean: "ratio-disciplined",
    story_shape: "reference-story led",
  };

  for (const axisKey of axisKeys) {
    const axis = FREE_AXES[axisKey];
    for (const opt of axis.options) {
      const record = { ...defaults, [axisKey]: opt.key };
      const result = freeAxesSchema.safeParse(record);
      assert.ok(
        result.success,
        `T-M_p5.16: freeAxesSchema must accept ${axisKey}="${opt.key}"; error: ${result.success ? "" : result.error?.message}`,
      );
    }
  }

  // Verify invalid key is rejected
  const invalid = {
    pain_chain_lean: "not-a-valid-key",
    lead_role: "pain-owner first",
    discovery_lean: "ratio-disciplined",
    story_shape: "reference-story led",
  };
  const invalidResult = freeAxesSchema.safeParse(invalid);
  assert.ok(!invalidResult.success, "T-M_p5.16: freeAxesSchema must reject invalid pain_chain_lean key");

  console.log(`T-M_p5.16: all 25 option keys accepted; invalid key rejected ✓`);
});

// ─── T-M_p5.17 — identityRecordSchema freeAxes is optional ──────────────────

test("T-M_p5.17: identityRecordSchema: pre-P-5 record (no freeAxes) validates; P-5 record validates; invalid freeAxes value rejects", () => {
  // 1. Pre-P-5 record (no freeAxes field) — must parse cleanly
  const preP5Record = {
    fullName: "Alice",
    company: "Acme",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
  const preP5Result = identityRecordSchema.safeParse(preP5Record);
  assert.ok(
    preP5Result.success,
    `T-M_p5.17: pre-P-5 record (no freeAxes) must validate; error: ${preP5Result.success ? "" : preP5Result.error?.message}`,
  );
  assert.equal(preP5Result.data?.freeAxes, undefined, "T-M_p5.17: pre-P-5 record must have freeAxes=undefined");

  // 2. P-5 record with valid freeAxes — must parse cleanly
  const p5Record = {
    fullName: "Alice",
    company: "Acme",
    freeAxes: {
      pain_chain_lean: "cause-first",
      lead_role: "pain-owner first",
      discovery_lean: "ratio-disciplined",
      story_shape: "reference-story led",
    },
    updatedAt: "2026-05-08T00:00:00.000Z",
  };
  const p5Result = identityRecordSchema.safeParse(p5Record);
  assert.ok(
    p5Result.success,
    `T-M_p5.17: P-5 record with valid freeAxes must validate; error: ${p5Result.success ? "" : p5Result.error?.message}`,
  );
  assert.equal(
    p5Result.data?.freeAxes?.pain_chain_lean,
    "cause-first",
    "T-M_p5.17: P-5 record freeAxes.pain_chain_lean must be 'cause-first'",
  );

  // 3. Invalid freeAxes value — must reject
  const invalidRecord = {
    fullName: "Alice",
    company: "Acme",
    freeAxes: {
      pain_chain_lean: "totally-invalid-key",
      lead_role: "pain-owner first",
      discovery_lean: "ratio-disciplined",
      story_shape: "reference-story led",
    },
    updatedAt: "2026-05-08T00:00:00.000Z",
  };
  const invalidResult = identityRecordSchema.safeParse(invalidRecord);
  assert.ok(!invalidResult.success, "T-M_p5.17: record with invalid freeAxes key must be rejected by Zod");

  // 4. Full P-4 style record with all fields + icp + freeAxes — must parse cleanly
  const fullRecord = {
    fullName: "kyoube",
    company: "mastars",
    role: "BD",
    persona: "outbound sales",
    style: "direct, technical",
    icp: { targetRole: ["CTO", "VP Engineering"], industry: ["SaaS"] },
    freeAxes: {
      pain_chain_lean: "cause-confirmed-then-up",
      lead_role: "pain-owner first",
      discovery_lean: "ratio-disciplined",
      story_shape: "reference-story led",
    },
    updatedAt: "2026-05-08T00:00:00.000Z",
  };
  const fullResult = identityRecordSchema.safeParse(fullRecord);
  assert.ok(
    fullResult.success,
    `T-M_p5.17: full P-5 record must validate; error: ${fullResult.success ? "" : fullResult.error?.message}`,
  );

  console.log("T-M_p5.17: identityRecordSchema freeAxes optional/valid/invalid behavior ✓");
});
