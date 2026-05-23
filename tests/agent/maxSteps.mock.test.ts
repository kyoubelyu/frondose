/**
 * P-46 mock tests — T-MaxSteps.1–2: parseMaxSteps + resolveMaxSteps unit tests.
 *
 * T-MaxSteps.1 — resolver precedence: CLI flag > MAI_MAX_STEPS > DEFAULT_MAX_STEPS.
 * T-MaxSteps.2 — invalid inputs rejected: non-positive, non-integer, exponent-notation,
 *                leading-zero, plus-prefixed, whitespace, empty, negative, fraction.
 *                Also: parseMaxSteps accepts surrounding whitespace + "42" → 42.
 *                DEFAULT_MAX_STEPS === 200.
 *
 * Gate coverage: G-P46.5.
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DEFAULT_MAX_STEPS, parseMaxSteps, resolveMaxSteps } from "../../src/agent/maxSteps.js";

// ─── T-MaxSteps.1: resolver precedence ──────────────────────────────────────

describe("T-MaxSteps.1: resolveMaxSteps precedence — flag > MAI_MAX_STEPS env > default", () => {
  let prevEnv: string | undefined;

  before(() => {
    prevEnv = process.env.MAI_MAX_STEPS;
  });

  after(() => {
    if (prevEnv === undefined) delete process.env.MAI_MAX_STEPS;
    else process.env.MAI_MAX_STEPS = prevEnv;
  });

  it("when cliFlag='50' and MAI_MAX_STEPS='80', resolveMaxSteps returns 50 (flag wins)", () => {
    // Given: CLI flag "50" passed; MAI_MAX_STEPS env set to "80"
    // When:  resolveMaxSteps("50") is called
    // Then:  result is 50 (CLI flag takes precedence over env var)
    process.env.MAI_MAX_STEPS = "80";
    assert.equal(resolveMaxSteps("50"), 50, "CLI flag '50' must win over MAI_MAX_STEPS='80'");
  });

  it("when cliFlag=undefined and MAI_MAX_STEPS='80', resolveMaxSteps returns 80 (env wins)", () => {
    // Given: no CLI flag; MAI_MAX_STEPS env set to "80"
    // When:  resolveMaxSteps(undefined) is called
    // Then:  result is 80 (env var takes precedence over default)
    process.env.MAI_MAX_STEPS = "80";
    assert.equal(resolveMaxSteps(undefined), 80, "MAI_MAX_STEPS='80' must win when no CLI flag");
  });

  it("when cliFlag=undefined and MAI_MAX_STEPS unset, resolveMaxSteps returns DEFAULT_MAX_STEPS (200)", () => {
    // Given: no CLI flag; MAI_MAX_STEPS env not set
    // When:  resolveMaxSteps(undefined) is called
    // Then:  result is DEFAULT_MAX_STEPS = 200 (hardcoded default)
    delete process.env.MAI_MAX_STEPS;
    assert.equal(
      resolveMaxSteps(undefined),
      DEFAULT_MAX_STEPS,
      "DEFAULT_MAX_STEPS must be used when no flag and no env",
    );
    assert.equal(resolveMaxSteps(undefined), 200, "default must equal 200 (D-1 P-46 raise from 10)");
  });
});

// ─── T-MaxSteps.2: invalid inputs rejected; DEFAULT_MAX_STEPS === 200 ────────

describe("T-MaxSteps.2: parseMaxSteps rejects invalid inputs; accepts valid positive integers", () => {
  let prevEnv: string | undefined;

  before(() => {
    prevEnv = process.env.MAI_MAX_STEPS;
    delete process.env.MAI_MAX_STEPS;
  });

  after(() => {
    if (prevEnv === undefined) delete process.env.MAI_MAX_STEPS;
    else process.env.MAI_MAX_STEPS = prevEnv;
  });

  it("DEFAULT_MAX_STEPS constant equals 200 (D-1 hardcoded default)", () => {
    // Given: the maxSteps module is loaded
    // When:  DEFAULT_MAX_STEPS is read
    // Then:  it equals 200 (raised from 10 per P-46 D-1)
    assert.equal(DEFAULT_MAX_STEPS, 200, `DEFAULT_MAX_STEPS must equal 200 (P-46 D-1 raise); got ${DEFAULT_MAX_STEPS}`);
  });

  it("parseMaxSteps returns null for each invalid input", () => {
    // Given: a set of invalid input strings
    // When:  parseMaxSteps() is called on each
    // Then:  every call returns null (not a positive integer)
    const invalid = [
      "abc", // non-numeric
      "0", // zero — not positive
      "-5", // negative
      "3.5", // decimal
      "", // empty
      "1e3", // exponent notation — rejected by N-2 guard
      "007", // leading zero — rejected by /^[1-9]\d*$/ guard
      "+5", // plus-prefixed
      " ", // whitespace only
    ];
    for (const v of invalid) {
      assert.equal(parseMaxSteps(v), null, `parseMaxSteps('${v}') must return null (rejected input)`);
    }
  });

  it("parseMaxSteps('42') returns 42; parseMaxSteps(' 42 ') returns 42 (whitespace trimmed)", () => {
    // Given: '42' and ' 42 ' (with surrounding whitespace)
    // When:  parseMaxSteps() is called
    // Then:  both return 42 (trim before regex check; /^[1-9]\d*$/ matches '42')
    assert.equal(parseMaxSteps("42"), 42, "parseMaxSteps('42') must return 42");
    assert.equal(parseMaxSteps(" 42 "), 42, "parseMaxSteps(' 42 ') must return 42 (whitespace trimmed)");
  });

  it("resolveMaxSteps falls back to DEFAULT_MAX_STEPS for each invalid input when MAI_MAX_STEPS unset", () => {
    // Given: MAI_MAX_STEPS not set; cliFlag = invalid string
    // When:  resolveMaxSteps(invalidString) is called for each invalid input
    // Then:  result is DEFAULT_MAX_STEPS = 200 for all
    const invalids = ["abc", "0", "-5", "3.5", "", "1e3", "007", "+5", " "];
    for (const inv of invalids) {
      assert.equal(
        resolveMaxSteps(inv),
        DEFAULT_MAX_STEPS,
        `resolveMaxSteps('${inv}') must return DEFAULT_MAX_STEPS=200 when MAI_MAX_STEPS unset`,
      );
    }
  });
});
