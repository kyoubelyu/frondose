/**
 * P-5/P-6 mock tests — T-M_p5.1..T-M_p5.8 + NIT-r2-2 + T-M_p6.24..T-M_p6.25: Soul band composer.
 *
 * Tests:
 *   T-M_p5.1  — METHODOLOGY_DISTILLATION token budget ≤ 800 tok (G-P5.6)
 *   T-M_p5.2  — Boundary→Soul→Checkpoint compose order (invariant from P-1)
 *   T-M_p5.3  — composeSoulBand includes identity substrings (G-P5.1)
 *   T-M_p5.4  — composeSoulBand includes methodology substrings (G-P5.1)
 *   T-M_p5.5  — composeSoulBand includes freeAxes option meanings (G-P5.1, G-P5.5)
 *   T-M_p5.6  — composeSoulBand includes OQ-3 Option C memory-trigger verbatim (G-P5.7 mock-side)
 *   T-M_p5.7  — composeSoulBand(null) returns non-empty fallback (G-P5.1)
 *   T-M_p5.8  — composeSoulBand output has NO F-5 banned tokens (G-P5.1 negative; NIT-r2-1 scope)
 *   T-M_p5.8b — CJK typographic quotes U+201C/U+201D around '记住' are preserved in output (NIT-r2-2)
 *   T-M_p6.24 — escalate-habit directive present in Section 5 (F-8 line-372 verbatim fragments)
 *   T-M_p6.25 — extended Section 5 contains NO F-5 banned tokens (no regression from P-6 extension)
 *
 * No Chrome, no LLM, no SQLite required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { composeSystemPrompt } from "../../src/agent/systemPrompt/compose.js";
import { composeSoulBand } from "../../src/agent/systemPrompt/soul.js";
import { METHODOLOGY_DISTILLATION } from "../../src/methodology/distill.js";
import type { IdentityRecord } from "../../src/persistence/identity.js";

// ─── T-M_p5.1 — Token budget ─────────────────────────────────────────────────

test("T-M_p5.1: METHODOLOGY_DISTILLATION char-count within 800-tok budget (~4 char/token)", () => {
  const charCount = METHODOLOGY_DISTILLATION.length;
  const estimatedTok = charCount / 4;
  // ROADMAP gate G-P5.6: ≤ 800 tokens. The ~2,860-char constant clocks at ~715 tok.
  assert.ok(
    estimatedTok <= 800,
    `T-M_p5.1: METHODOLOGY_DISTILLATION is ~${Math.round(estimatedTok)} tok (${charCount} chars) — exceeds 800-tok gate.`,
  );
  // Verify it's not trivially empty
  assert.ok(charCount > 1000, `T-M_p5.1: METHODOLOGY_DISTILLATION must be > 1000 chars; got ${charCount}`);
  console.log(`T-M_p5.1: METHODOLOGY_DISTILLATION — ${charCount} chars / ~${Math.round(estimatedTok)} tok estimated`);
});

// ─── T-M_p5.2 — 3-band compose order ────────────────────────────────────────

test("T-M_p5.2: Boundary→Soul→Checkpoint composition order is preserved (P-1 contract)", () => {
  const identity: IdentityRecord = {
    fullName: "TestUser",
    company: "TestCo",
    updatedAt: new Date().toISOString(),
  };
  const soulBand = composeSoulBand(identity);
  const boundary = "[BOUNDARY-BAND]";
  const checkpoint = "[CHECKPOINT-BAND]";

  const composed = composeSystemPrompt({ boundary, soul: soulBand, checkpoint });
  const parts = composed.split("\n\n---\n\n");

  assert.equal(parts.length, 3, "T-M_p5.2: must have exactly 3 bands");
  assert.equal(parts[0], boundary, "T-M_p5.2: first band must be Boundary");
  assert.equal(parts[1], soulBand, "T-M_p5.2: second band must be Soul");
  assert.equal(parts[2], checkpoint, "T-M_p5.2: third band must be Checkpoint");
  assert.ok(composed.startsWith("[BOUNDARY-BAND]"), "T-M_p5.2: must start with Boundary");
  assert.ok(composed.endsWith("[CHECKPOINT-BAND]"), "T-M_p5.2: must end with Checkpoint");
});

// ─── T-M_p5.3 — Identity substrings in Soul output ──────────────────────────

test("T-M_p5.3: composeSoulBand includes operator name, company, and ICP role", () => {
  const identity: IdentityRecord = {
    fullName: "K",
    company: "M",
    icp: { targetRole: ["CTO"] },
    updatedAt: new Date().toISOString(),
  };
  const out = composeSoulBand(identity);

  assert.ok(out.includes("K"), `T-M_p5.3: Soul output must include fullName "K"; got:\n${out.slice(0, 200)}`);
  assert.ok(out.includes("M"), `T-M_p5.3: Soul output must include company "M"; got:\n${out.slice(0, 200)}`);
  assert.ok(out.includes("CTO"), `T-M_p5.3: Soul output must include ICP role "CTO"; got:\n${out.slice(0, 200)}`);
});

// ─── T-M_p5.4 — Methodology substrings ──────────────────────────────────────

test("T-M_p5.4: composeSoulBand includes key methodology vocabulary substrings", () => {
  const identity: IdentityRecord = {
    fullName: "TestUser",
    company: "TestCo",
    updatedAt: new Date().toISOString(),
  };
  const out = composeSoulBand(identity);

  const required = ["R1-open", "qualify_profile", "Pain Chain", "Value Cycle"];
  for (const token of required) {
    assert.ok(
      out.includes(token),
      `T-M_p5.4: Soul output must include "${token}"; not found in:\n${out.slice(0, 400)}`,
    );
  }
  console.log("T-M_p5.4: all 4 methodology substrings present in Soul output ✓");
});

// ─── T-M_p5.5 — Free axes option meanings in Soul output ─────────────────────

test("T-M_p5.5: composeSoulBand includes the 4 chosen axis-option meanings when freeAxes are set", () => {
  const identity: IdentityRecord = {
    fullName: "TestUser",
    company: "TestCo",
    freeAxes: {
      pain_chain_lean: "cause-first",
      lead_role: "economic-buyer first",
      discovery_lean: "I-lean",
      story_shape: "initial-value-prop led",
    },
    updatedAt: new Date().toISOString(),
  };
  const out = composeSoulBand(identity);

  // Each chosen option key must appear in the axes section
  assert.ok(out.includes("cause-first"), `T-M_p5.5: axis key "cause-first" must appear in Soul output`);
  assert.ok(
    out.includes("economic-buyer first"),
    `T-M_p5.5: axis key "economic-buyer first" must appear in Soul output`,
  );
  assert.ok(out.includes("I-lean"), `T-M_p5.5: axis key "I-lean" must appear in Soul output`);
  assert.ok(
    out.includes("initial-value-prop led"),
    `T-M_p5.5: axis key "initial-value-prop led" must appear in Soul output`,
  );

  // The meaning text for "cause-first" must appear
  const causeFirstMeaning = "Walk downstream (Step 4) to operational antecedent before any I2 probe";
  assert.ok(out.includes(causeFirstMeaning), `T-M_p5.5: "cause-first" meaning must appear in Soul output`);

  // The meaning text for "I-lean" must appear
  const iLeanMeaning = "Expand quickly to I2-controlled (stakeholder map) as soon as cause is admitted in R1";
  assert.ok(out.includes(iLeanMeaning), `T-M_p5.5: "I-lean" meaning must appear in Soul output`);
});

// ─── T-M_p5.6 — Memory trigger verbatim ──────────────────────────────────────

test("T-M_p5.6: composeSoulBand includes OQ-3 Option C memory-trigger phrasing verbatim", () => {
  const identity: IdentityRecord = {
    fullName: "TestUser",
    company: "TestCo",
    updatedAt: new Date().toISOString(),
  };
  const out = composeSoulBand(identity);

  // Core fragments of OQ-3 Option C memory trigger (from soul.ts §5)
  const fragments = ["你的习惯是", "operator 让你", "记住", "remember", "工具存下来才算"];
  for (const fragment of fragments) {
    assert.ok(out.includes(fragment), `T-M_p5.6: memory-trigger fragment "${fragment}" must be in Soul output`);
  }
  console.log("T-M_p5.6: all OQ-3 Option C memory-trigger fragments present ✓");
});

// ─── T-M_p5.7 — Null identity fallback ───────────────────────────────────────

test("T-M_p5.7: composeSoulBand(null) returns non-empty fallback with placeholder, methodology, and defaults", () => {
  const out = composeSoulBand(null);

  assert.ok(out.length > 500, `T-M_p5.7: Soul null-fallback must be > 500 chars; got ${out.length}`);

  // Must include placeholder identity
  assert.ok(
    out.includes("mai-agent operator"),
    `T-M_p5.7: null fallback must include "mai-agent operator" placeholder`,
  );

  // Must include methodology (distillation is always included)
  assert.ok(out.includes("R1-open"), `T-M_p5.7: null fallback must include methodology text "R1-open"`);

  // Must include default axis key (cause-confirmed-then-up is the pain_chain_lean default)
  assert.ok(
    out.includes("cause-confirmed-then-up"),
    `T-M_p5.7: null fallback must include default pain_chain_lean axis key "cause-confirmed-then-up"`,
  );

  // Must include memory trigger
  assert.ok(out.includes("工具存下来才算"), `T-M_p5.7: null fallback must include memory-trigger`);

  console.log("T-M_p5.7: composeSoulBand(null) returns valid non-empty fallback ✓");
});

// ─── T-M_p5.8 — No imperative leakage (F-5 full ban list; NIT-r2-1 scope) ───

test("T-M_p5.8: composeSoulBand output has NO F-5 banned imperative tokens (full 9-token list; default axes)", () => {
  const identity: IdentityRecord = {
    fullName: "TestUser",
    company: "TestCo",
    // Use defaults — no custom freeAxes that might contain "never" etc.
    updatedAt: new Date().toISOString(),
  };
  const out = composeSoulBand(identity);

  // Full F-5 ban list per docs/plan-0.3-autonomous-agent.md:284-291 + CONCERN-MR-1 rev-2 expansion.
  // These apply to BOTH the function-body sections AND the embedded METHODOLOGY_DISTILLATION.
  // Scope per NIT-r2-1: composed Soul output only (not static freeAxes.ts option pool).
  const bannedTokens = [
    "必须",
    "MUST",
    "SHALL",
    "禁止",
    "forbidden",
    "do not",
    "don't",
    "never",
    "应该",
    "should always",
  ];

  for (const token of bannedTokens) {
    const found = out.includes(token);
    if (found) {
      // Find context around the match
      const idx = out.indexOf(token);
      const context = out.slice(Math.max(0, idx - 40), Math.min(out.length, idx + 60));
      assert.fail(`T-M_p5.8: F-5 banned token "${token}" found in Soul output.\nContext: "...${context}..."`);
    }
  }
  console.log("T-M_p5.8: zero F-5 banned imperative tokens found in Soul output ✓");
});

// ─── T-M_p5.8b — CJK typographic quotes preserved (NIT-r2-2) ────────────────

test("T-M_p5.8b (NIT-r2-2): CJK typographic quotes U+201C/U+201D around '记住' preserved in Soul output", () => {
  const identity: IdentityRecord = {
    fullName: "TestUser",
    company: "TestCo",
    updatedAt: new Date().toISOString(),
  };
  const out = composeSoulBand(identity);

  // U+201C = “ (left double quotation mark = "
  // U+201D = ” (right double quotation mark = ")
  const leftQuote = "“"; // "
  const rightQuote = "”"; // "

  assert.ok(out.includes(leftQuote), `T-M_p5.8b: U+201C (") must be present in Soul output`);
  assert.ok(out.includes(rightQuote), `T-M_p5.8b: U+201D (") must be present in Soul output`);

  // The full quoted form '“记住”' must appear verbatim
  const quotedJizhu = `${leftQuote}记住${rightQuote}`;
  assert.ok(
    out.includes(quotedJizhu),
    `T-M_p5.8b: '“记住”' must appear verbatim in Soul output (CJK typographic quotes preserved)`,
  );

  // Also verify it's in the memory-trigger section specifically (not elsewhere)
  const memTriggerIdx = out.indexOf("工具存下来才算");
  const memTriggerSection = out.slice(Math.max(0, memTriggerIdx - 100), memTriggerIdx + 50);
  assert.ok(
    memTriggerSection.includes(quotedJizhu),
    `T-M_p5.8b: '“记住”' must appear in the memory-trigger section of Soul output`,
  );

  console.log(`T-M_p5.8b: CJK quotes '”记住”' preserved in Soul output ✓`);
});

// ─── T-M_p6.24 — escalate-habit directive present (F-8 line-372) ─────────────

test("T-M_p6.24: composeSoulBand Section 5 includes escalate-habit directive (F-8 line-372 verbatim fragments)", () => {
  const identity: IdentityRecord = {
    fullName: "TestUser",
    company: "TestCo",
    updatedAt: new Date().toISOString(),
  };
  const out = composeSoulBand(identity);

  // F-8 line-372 escalate-habit directive verbatim fragments (from soul.ts §5).
  const requiredFragments = ["telegram_notify", "gh_issue", "escalate_for_capability", "stop", "sleep", "工具能力之外"];

  for (const fragment of requiredFragments) {
    assert.ok(
      out.includes(fragment),
      `T-M_p6.24: escalate-habit directive fragment "${fragment}" must be in Soul output`,
    );
  }

  // Also verify the directive follows the memory-trigger in Section 5 (same paragraph block)
  const memTriggerIdx = out.indexOf("工具存下来才算");
  const escalateIdx = out.indexOf("escalate_for_capability");
  assert.ok(memTriggerIdx >= 0, "T-M_p6.24: memory-trigger sentence must be present");
  assert.ok(escalateIdx >= 0, "T-M_p6.24: escalate directive must be present");
  assert.ok(
    escalateIdx > memTriggerIdx,
    "T-M_p6.24: escalate directive must appear AFTER the memory-trigger sentence in Section 5",
  );

  // Total Soul output token budget check: Section 5 extension added ~100 tok;
  // full Soul with default identity should remain within 1200-tok gate (~4800 chars).
  const charCount = out.length;
  const estimatedTok = charCount / 4;
  assert.ok(
    estimatedTok <= 1200,
    `T-M_p6.24: full Soul output must be ≤ 1200 tok (G-P6.5); got ~${Math.round(estimatedTok)} tok (${charCount} chars)`,
  );

  console.log(
    `T-M_p6.24: escalate-habit directive present in Soul Section 5 (~${Math.round(estimatedTok)} tok total) ✓`,
  );
});

// ─── T-M_p6.25 — extended Section 5 has NO F-5 banned tokens ─────────

test("T-M_p6.25: composeSoulBand extended Section 5 (escalate directive) contains NO F-5 banned tokens", () => {
  const identity: IdentityRecord = {
    fullName: "TestUser",
    company: "TestCo",
    updatedAt: new Date().toISOString(),
  };
  const out = composeSoulBand(identity);

  // Extract only the Section 5 portion (from the trigger line to end of output).
  const section5Start = out.indexOf("你的习惯是：operator");
  assert.ok(section5Start >= 0, "T-M_p6.25: must find Section 5 start");
  const section5 = out.slice(section5Start);

  // Full F-5 ban list (same as T-M_p5.8) — must hold for extended Section 5 too.
  const bannedTokens = [
    "必须",
    "MUST",
    "SHALL",
    "禁止",
    "forbidden",
    "do not",
    "don't",
    "never",
    "应该",
    "should always",
  ];

  for (const token of bannedTokens) {
    const found = section5.includes(token);
    if (found) {
      const idx = section5.indexOf(token);
      const context = section5.slice(Math.max(0, idx - 40), Math.min(section5.length, idx + 60));
      assert.fail(
        `T-M_p6.25: F-5 banned token "${token}" found in Soul Section 5 (escalate directive).\nContext: "...${context}..."`,
      );
    }
  }

  console.log("T-M_p6.25: zero F-5 banned tokens in extended Section 5 ✓");
});

// ─── T-Soul.3 — Daily workflow cadence in Soul band (P-19 G-P19.4) ──────────

test("T-Soul.3: composed Soul band mission contains daily workflow cadence with all 4 time periods — Morning, Midday, Afternoon, Evening", () => {
  // Given: any identity record (mission is identity-independent)
  // When:  composeSoulBand() is called (with null identity for simplicity)
  // Then:  the output contains "Morning", "Midday", "Afternoon", "Evening"
  //        with role-appropriate verbs in each time block
  const out = composeSoulBand(null);

  // All 4 time periods must be present
  assert.ok(out.includes("Morning"), `Soul output must contain "Morning"`);
  assert.ok(out.includes("Midday"), `Soul output must contain "Midday"`);
  assert.ok(out.includes("Afternoon"), `Soul output must contain "Afternoon"`);
  assert.ok(out.includes("Evening"), `Soul output must contain "Evening"`);

  // Morning block: search + qualify
  assert.ok(out.includes("search"), `Soul output must contain "search"`);
  assert.ok(out.includes("qualify"), `Soul output must contain "qualify"`);

  // Midday block: feed
  assert.ok(out.includes("feed"), `Soul output must contain "feed"`);

  // Afternoon block: follow up
  assert.ok(out.includes("follow up"), `Soul output must contain "follow up"`);

  // Evening block: telegram_notify
  assert.ok(out.includes("telegram_notify"), `Soul output must contain "telegram_notify"`);

  // Verify the daily rhythm is in the mission section (not just mentioned incidentally)
  // The mission section ends with the daily rhythm text
  const dailyRhythmIdx = out.indexOf("Daily rhythm");
  assert.ok(dailyRhythmIdx >= 0, "Soul output must contain 'Daily rhythm' heading");
  const missionEnd = out.slice(dailyRhythmIdx, dailyRhythmIdx + 300);
  assert.ok(
    missionEnd.includes("Morning") && missionEnd.includes("telegram_notify"),
    "Daily rhythm section must span all 4 time periods with telegram_notify",
  );
});
