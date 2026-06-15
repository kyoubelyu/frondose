/**
 * P-46 mock tests — T-MaxSteps.1–2: parseMaxSteps + resolveMaxSteps unit tests.
 *
 * T-MaxSteps.1 — resolver precedence: CLI flag > FRONDOSE_MAX_STEPS > DEFAULT_MAX_STEPS.
 * T-MaxSteps.2 — invalid inputs rejected: non-positive, non-integer, exponent-notation,
 *                leading-zero, plus-prefixed, whitespace, empty, negative, fraction.
 *                Also: parseMaxSteps accepts surrounding whitespace + "42" → 42.
 *                DEFAULT_MAX_STEPS === 200.
 *
 * P-AUTO-12 extension — T-CronMaxSteps resolver unit tests (G-A12.3, G-A12.4) +
 *                       T-CronNoProgress resolver unit tests (G-A12.22):
 * T-CronMaxSteps.3 — MAI_CRON_MAX_STEPS=25 NOT honored when FRONDOSE_ unset (shim removed F-REN-4e).
 * T-CronMaxSteps.4 — invalid FRONDOSE_CRON_MAX_STEPS falls through to default 40.
 * T-CronNoProgress.17 — invalid FRONDOSE_CRON_NOPROGRESS_LIMIT falls through to default 10.
 *
 * Gate coverage: G-P46.5, G-A12.3, G-A12.4, G-A12.22.
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DEFAULT_MAX_STEPS, parseMaxSteps, resolveMaxSteps } from "../../src/agent/maxSteps.js";

// P-AUTO-12: dynamic import of the new cron resolvers (not yet shipped by builder at Step 3).
// The `|| null` fallback allows the scaffold to COMPILE and run; the resolver tests then FAIL
// at runtime when the functions are null — intentional: these are Step-3 TODO assertions.
// biome-ignore lint/suspicious/noExplicitAny: pre-builder dynamic import fallback
let resolveCronMaxSteps: (() => number) | null = null;
// biome-ignore lint/suspicious/noExplicitAny: pre-builder dynamic import fallback
let resolveCronNoProgressLimit: (() => number) | null = null;
// biome-ignore lint/suspicious/noExplicitAny: pre-builder dynamic import fallback
let DEFAULT_CRON_MAX_STEPS: number | null = null;
// biome-ignore lint/suspicious/noExplicitAny: pre-builder dynamic import fallback
let DEFAULT_CRON_NOPROGRESS_LIMIT: number | null = null;

before(async () => {
  try {
    const mod = await import("../../src/agent/maxSteps.js");
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import
    const m = mod as any;
    resolveCronMaxSteps = m.resolveCronMaxSteps ?? null;
    resolveCronNoProgressLimit = m.resolveCronNoProgressLimit ?? null;
    DEFAULT_CRON_MAX_STEPS = m.DEFAULT_CRON_MAX_STEPS ?? null;
    DEFAULT_CRON_NOPROGRESS_LIMIT = m.DEFAULT_CRON_NOPROGRESS_LIMIT ?? null;
  } catch {
    // Not yet shipped — scaffolds will fail at assertion time
  }
});

// ─── T-MaxSteps.1: resolver precedence ──────────────────────────────────────

describe("T-MaxSteps.1: resolveMaxSteps precedence — flag > FRONDOSE_MAX_STEPS env > default", () => {
  let prevEnv: string | undefined;

  before(() => {
    prevEnv = process.env.FRONDOSE_MAX_STEPS;
  });

  after(() => {
    if (prevEnv === undefined) delete process.env.FRONDOSE_MAX_STEPS;
    else process.env.FRONDOSE_MAX_STEPS = prevEnv;
  });

  it("when cliFlag='50' and FRONDOSE_MAX_STEPS='80', resolveMaxSteps returns 50 (flag wins)", () => {
    // Given: CLI flag "50" passed; FRONDOSE_MAX_STEPS env set to "80"
    // When:  resolveMaxSteps("50") is called
    // Then:  result is 50 (CLI flag takes precedence over env var)
    process.env.FRONDOSE_MAX_STEPS = "80";
    assert.equal(resolveMaxSteps("50"), 50, "CLI flag '50' must win over FRONDOSE_MAX_STEPS='80'");
  });

  it("when cliFlag=undefined and FRONDOSE_MAX_STEPS='80', resolveMaxSteps returns 80 (env wins)", () => {
    // Given: no CLI flag; FRONDOSE_MAX_STEPS env set to "80"
    // When:  resolveMaxSteps(undefined) is called
    // Then:  result is 80 (env var takes precedence over default)
    process.env.FRONDOSE_MAX_STEPS = "80";
    assert.equal(resolveMaxSteps(undefined), 80, "FRONDOSE_MAX_STEPS='80' must win when no CLI flag");
  });

  it("when cliFlag=undefined and FRONDOSE_MAX_STEPS unset, resolveMaxSteps returns DEFAULT_MAX_STEPS (200)", () => {
    // Given: no CLI flag; FRONDOSE_MAX_STEPS env not set
    // When:  resolveMaxSteps(undefined) is called
    // Then:  result is DEFAULT_MAX_STEPS = 200 (hardcoded default)
    delete process.env.FRONDOSE_MAX_STEPS;
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
    prevEnv = process.env.FRONDOSE_MAX_STEPS;
    delete process.env.FRONDOSE_MAX_STEPS;
  });

  after(() => {
    if (prevEnv === undefined) delete process.env.FRONDOSE_MAX_STEPS;
    else process.env.FRONDOSE_MAX_STEPS = prevEnv;
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

  it("resolveMaxSteps falls back to DEFAULT_MAX_STEPS for each invalid input when FRONDOSE_MAX_STEPS unset", () => {
    // Given: FRONDOSE_MAX_STEPS not set; cliFlag = invalid string
    // When:  resolveMaxSteps(invalidString) is called for each invalid input
    // Then:  result is DEFAULT_MAX_STEPS = 200 for all
    const invalids = ["abc", "0", "-5", "3.5", "", "1e3", "007", "+5", " "];
    for (const inv of invalids) {
      assert.equal(
        resolveMaxSteps(inv),
        DEFAULT_MAX_STEPS,
        `resolveMaxSteps('${inv}') must return DEFAULT_MAX_STEPS=200 when FRONDOSE_MAX_STEPS unset`,
      );
    }
  });
});

// ─── P-AUTO-12: T-CronMaxSteps.3 — MAI_ shim REMOVED (F-REN-4e) (G-A12.3) ─────

describe("T-CronMaxSteps.3: MAI_CRON_MAX_STEPS=25 is NOT honored when FRONDOSE_CRON_MAX_STEPS unset (shim removed F-REN-4e)", () => {
  let savedFrondose: string | undefined;
  let savedMai: string | undefined;

  before(() => {
    savedFrondose = process.env.FRONDOSE_CRON_MAX_STEPS;
    savedMai = process.env.MAI_CRON_MAX_STEPS;
    delete process.env.FRONDOSE_CRON_MAX_STEPS;
    process.env.MAI_CRON_MAX_STEPS = "25";
  });

  after(() => {
    if (savedFrondose === undefined) delete process.env.FRONDOSE_CRON_MAX_STEPS;
    else process.env.FRONDOSE_CRON_MAX_STEPS = savedFrondose;
    if (savedMai === undefined) delete process.env.MAI_CRON_MAX_STEPS;
    else process.env.MAI_CRON_MAX_STEPS = savedMai;
  });

  it("resolveCronMaxSteps() returns DEFAULT_CRON_MAX_STEPS=40 when MAI_CRON_MAX_STEPS='25' and FRONDOSE_CRON_MAX_STEPS unset (shim removed)", () => {
    // Given: FRONDOSE_CRON_MAX_STEPS not set; MAI_CRON_MAX_STEPS='25' (shim was removed in F-REN-4e)
    // When:  resolveCronMaxSteps() is called
    // Then:  result is DEFAULT_CRON_MAX_STEPS=40 (MAI_ prefix is not read; shim gone)
    assert.ok(resolveCronMaxSteps !== null, "resolveCronMaxSteps must be exported from maxSteps.ts");
    assert.equal(resolveCronMaxSteps!(), 40, "resolveCronMaxSteps() must return DEFAULT=40 when MAI_CRON_MAX_STEPS='25' only (shim removed)");
  });
});

// ─── P-AUTO-12: T-CronMaxSteps.4 — invalid env falls through (G-A12.4) ────────

describe("T-CronMaxSteps.4: invalid FRONDOSE_CRON_MAX_STEPS falls through to DEFAULT_CRON_MAX_STEPS=40", () => {
  before(() => {
    delete process.env.MAI_CRON_MAX_STEPS;
  });

  after(() => {
    delete process.env.FRONDOSE_CRON_MAX_STEPS;
  });

  it("resolveCronMaxSteps() returns 40 for each invalid FRONDOSE_CRON_MAX_STEPS value", () => {
    // Given: FRONDOSE_CRON_MAX_STEPS set to invalid values ("0", "-5", "abc", "1.5", "")
    // When:  resolveCronMaxSteps() is called for each
    // Then:  result is DEFAULT_CRON_MAX_STEPS=40 for all (parseMaxSteps rejects invalid input)
    assert.ok(resolveCronMaxSteps !== null, "resolveCronMaxSteps must be exported (not yet at Step 3)");
    assert.ok(DEFAULT_CRON_MAX_STEPS !== null, "DEFAULT_CRON_MAX_STEPS must be exported (not yet at Step 3)");
    const invalids = ["0", "-5", "abc", "1.5", "", "1e3", "007", "+5", " "];
    for (const v of invalids) {
      process.env.FRONDOSE_CRON_MAX_STEPS = v;
      assert.equal(
        resolveCronMaxSteps!(),
        40,
        `resolveCronMaxSteps() must return 40 (DEFAULT_CRON_MAX_STEPS) when FRONDOSE_CRON_MAX_STEPS='${v}'`,
      );
    }
    delete process.env.FRONDOSE_CRON_MAX_STEPS;
    assert.equal(resolveCronMaxSteps!(), 40, "resolveCronMaxSteps() must return 40 when env unset");
    assert.equal(DEFAULT_CRON_MAX_STEPS, 40, "DEFAULT_CRON_MAX_STEPS constant must equal 40");
  });
});

// ─── P-AUTO-12: T-CronNoProgress.17 — invalid threshold env (G-A12.22) ────────

describe("T-CronNoProgress.17: invalid FRONDOSE_CRON_NOPROGRESS_LIMIT falls through to DEFAULT_CRON_NOPROGRESS_LIMIT=10", () => {
  before(() => {
    delete process.env.MAI_CRON_NOPROGRESS_LIMIT;
  });

  after(() => {
    delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
  });

  it("resolveCronNoProgressLimit() returns 10 for each invalid FRONDOSE_CRON_NOPROGRESS_LIMIT value", () => {
    // Given: FRONDOSE_CRON_NOPROGRESS_LIMIT set to invalid values ("0", "-1", "abc", "")
    // When:  resolveCronNoProgressLimit() is called for each
    // Then:  result is DEFAULT_CRON_NOPROGRESS_LIMIT=10 for all
    assert.ok(resolveCronNoProgressLimit !== null, "resolveCronNoProgressLimit must be exported (not yet at Step 3)");
    assert.ok(DEFAULT_CRON_NOPROGRESS_LIMIT !== null, "DEFAULT_CRON_NOPROGRESS_LIMIT must be exported (not yet at Step 3)");
    const invalids = ["0", "-1", "abc", "", "1.5", "007", "1e3"];
    for (const v of invalids) {
      process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT = v;
      assert.equal(
        resolveCronNoProgressLimit!(),
        10,
        `resolveCronNoProgressLimit() must return 10 (DEFAULT) when FRONDOSE_CRON_NOPROGRESS_LIMIT='${v}'`,
      );
    }
    delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    assert.equal(resolveCronNoProgressLimit!(), 10, "resolveCronNoProgressLimit() must return 10 when env unset");
    assert.equal(DEFAULT_CRON_NOPROGRESS_LIMIT, 10, "DEFAULT_CRON_NOPROGRESS_LIMIT constant must equal 10");
  });
});
