/**
 * P-Y5 Step 4a scaffold — T-Pace.1..8 (D-RUN-2: env-tunable inter-tool pacing).
 *
 * REPLACES the pre-P-Y5 T-M45 test, which hardcoded the OLD 400-800ms contract
 * (waitedMs>=400, <=800, jitterMs<400, waitedMs===400+jitterMs). The R4 change
 * (docs/phase-Y5-drun24-plan.md §6.4-R4) moves the default band to 800-2500ms and
 * makes it env-tunable (MAI_PACE_MIN_MS / MAI_PACE_MAX_MS, "0" disables), so the old
 * assertions are intentionally GONE (guardian CONCERN-MR-1).
 *
 * Outside-in TDD (CLAUDE.md § Test Discipline):
 *   - Behavior-named tests (describe/it) + a one-line Given/When/Then intent comment.
 *   - All assertion bodies are `assert.fail("TODO Step 5: …")` — validator fills at Step 5.
 *   - These reference the NEW pacing exports (resolvePaceBand / parsePaceMs /
 *     DEFAULT_PACE_MIN_MS / DEFAULT_PACE_MAX_MS) which DO NOT exist until the builder
 *     lands R4 at Step 4b. Until then this whole file fails to load (named-export
 *     missing) — that is the intended Step-4a state; we do NOT stub the exports.
 *
 * NIT-1 (guardian): T-Pace.5 must be DETERMINISTIC — at Step 5 it stubs Math.random to
 *   a known sequence for the boundary/jitter assertions, with at most one non-strict
 *   smoke for real jitter. It does NOT rely on N≥20 random calls producing distinct values.
 *
 * Gate coverage: D-RUN-2 / R4 (T-Pace.1-7), D-RUN-2 / R5 exclusion (T-Pace.8).
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 tests/linkedin/pacing.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyPacing,
  DEFAULT_PACE_MAX_MS,
  DEFAULT_PACE_MIN_MS,
  parsePaceMs,
  resolvePaceBand,
} from "../../src/linkedin/pacing.js";

// ─── Env snapshot/restore helper (used to fill bodies at Step 5) ─────────────
/**
 * Run `fn` with MAI_PACE_* set to the given values, restoring the prior env after.
 * Step 5 uses this so each T-Pace case is hermetic (resolvePaceBand reads env per call).
 */
function withPaceEnv(vars: { min?: string; max?: string }, fn: () => void | Promise<void>): void | Promise<void> {
  const prevMin = process.env.MAI_PACE_MIN_MS;
  const prevMax = process.env.MAI_PACE_MAX_MS;
  const restore = () => {
    if (prevMin === undefined) delete process.env.MAI_PACE_MIN_MS;
    else process.env.MAI_PACE_MIN_MS = prevMin;
    if (prevMax === undefined) delete process.env.MAI_PACE_MAX_MS;
    else process.env.MAI_PACE_MAX_MS = prevMax;
  };
  if (vars.min === undefined) delete process.env.MAI_PACE_MIN_MS;
  else process.env.MAI_PACE_MIN_MS = vars.min;
  if (vars.max === undefined) delete process.env.MAI_PACE_MAX_MS;
  else process.env.MAI_PACE_MAX_MS = vars.max;
  try {
    const r = fn();
    if (r instanceof Promise) return r.finally(restore);
    restore();
  } catch (e) {
    restore();
    throw e;
  }
}

// ─── T-Pace.1 — default band when env unset ──────────────────────────────────

describe("resolvePaceBand — default band (D-RUN-2 / R4)", () => {
  // Given: neither MAI_PACE_MIN_MS nor MAI_PACE_MAX_MS is set.
  // When:  resolvePaceBand() is called.
  // Then:  returns { minMs: 800, maxMs: 2500, disabled: false } (DEFAULT_PACE_* consts).
  it("T-Pace.1: when MAI_PACE_MIN_MS and MAI_PACE_MAX_MS are both unset, resolvePaceBand() returns { minMs: 800, maxMs: 2500, disabled: false }", () => {
    // Default consts are the documented band (D-RUN-2 / OQ-D2.1).
    assert.equal(DEFAULT_PACE_MIN_MS, 800);
    assert.equal(DEFAULT_PACE_MAX_MS, 2500);
    withPaceEnv({}, () => {
      assert.deepEqual(resolvePaceBand(), {
        minMs: DEFAULT_PACE_MIN_MS,
        maxMs: DEFAULT_PACE_MAX_MS,
        disabled: false,
      });
    });
  });
});

// ─── T-Pace.2 — env override honored (precedence env > default) ───────────────

describe("resolvePaceBand — env override precedence (D-RUN-2 / R4)", () => {
  // Given: MAI_PACE_MIN_MS="1000", MAI_PACE_MAX_MS="1200".
  // When:  resolvePaceBand() is called.
  // Then:  returns { minMs: 1000, maxMs: 1200, disabled: false } (env beats default).
  it("T-Pace.2: when MAI_PACE_MIN_MS='1000' and MAI_PACE_MAX_MS='1200', resolvePaceBand() returns { minMs: 1000, maxMs: 1200, disabled: false }", () => {
    withPaceEnv({ min: "1000", max: "1200" }, () => {
      assert.deepEqual(resolvePaceBand(), { minMs: 1000, maxMs: 1200, disabled: false });
    });
  });
});

// ─── T-Pace.3 — invalid env falls back to default per-var ─────────────────────

describe("resolvePaceBand — invalid env falls through to default (D-RUN-2 / R4)", () => {
  // Given: MAI_PACE_MIN_MS ∈ {"abc","-5","3.5","1e3","","  "} (each in turn), MAI_PACE_MAX_MS unset.
  // When:  resolvePaceBand() is called.
  // Then:  minMs === 800 (that var fell through to default) AND maxMs === 2500.
  it("T-Pace.3: when MAI_PACE_MIN_MS is invalid ('abc'|'-5'|'3.5'|'1e3'|''|'  ') and MAI_PACE_MAX_MS unset, resolvePaceBand() yields minMs===800 (default) and maxMs===2500", () => {
    for (const badMin of ["abc", "-5", "3.5", "1e3", "", "  "]) {
      withPaceEnv({ min: badMin }, () => {
        const band = resolvePaceBand();
        assert.deepEqual(
          band,
          { minMs: DEFAULT_PACE_MIN_MS, maxMs: DEFAULT_PACE_MAX_MS, disabled: false },
          `bad MIN ${JSON.stringify(badMin)} should fall through to default band`,
        );
      });
    }
  });
});

// ─── T-Pace.4 — `=0` disables pacing (no sleep) ──────────────────────────────

describe("resolvePaceBand + applyPacing — '0' disables pacing (D-RUN-2 / R4)", () => {
  // Given: MAI_PACE_MIN_MS="0" (and, separately, MAI_PACE_MAX_MS="0").
  // When:  resolvePaceBand() then applyPacing().
  // Then:  resolvePaceBand().disabled === true; applyPacing() resolves to
  //        { waitedMs: 0, jitterMs: 0, serial: true } WITHOUT sleeping (elapsed < ~50ms).
  it("T-Pace.4: when MAI_PACE_MIN_MS='0' (or MAI_PACE_MAX_MS='0'), resolvePaceBand().disabled===true and applyPacing() resolves { waitedMs:0, jitterMs:0, serial:true } without sleeping (elapsed < ~50ms)", async () => {
    // Both disable forms: MIN=0 and (separately) MAX=0.
    for (const vars of [{ min: "0" }, { max: "0" }] as const) {
      await withPaceEnv(vars, async () => {
        assert.equal(resolvePaceBand().disabled, true, `${JSON.stringify(vars)} should disable pacing`);
        const start = Date.now();
        const result = await applyPacing();
        const elapsed = Date.now() - start;
        assert.deepEqual(result, { waitedMs: 0, jitterMs: 0, serial: true });
        assert.ok(elapsed < 50, `disabled applyPacing must not sleep (elapsed ${elapsed}ms < 50ms)`);
      });
    }
  });
});

// ─── T-Pace.5 — applyPacing delay ∈ [min,max] + jitter present (DETERMINISTIC) ─

describe("applyPacing — delay ∈ [min,max] with jitter (deterministic, NIT-1) (D-RUN-2 / R4)", () => {
  // Given: a small fast band (MAI_PACE_MIN_MS="10", MAI_PACE_MAX_MS="14") + Math.random stubbed
  //        to a known sequence (NIT-1: deterministic, no flake).
  // When:  applyPacing() is called for each stubbed random value.
  // Then:  waitedMs ∈ [10,14] AND waitedMs === jitterMs + 10 (min) for every call,
  //        AND the stubbed sequence yields >1 distinct waitedMs (proves jitter, not constant).
  it("T-Pace.5: when band is [10,14] and Math.random is stubbed to a known sequence, every applyPacing() result has waitedMs∈[10,14], waitedMs===jitterMs+10, and the sequence produces more than one distinct waitedMs", async () => {
    // NIT-1: deterministic — stub Math.random to a fixed sequence.
    // jitterMs = floor(random * (14 - 10 + 1)) = floor(random * 5):
    //   0     → jitter 0 → waited 10
    //   0.5   → jitter 2 → waited 12  (floor(2.5))
    //   0.999 → jitter 4 → waited 14  (floor(4.995))
    const seq = [0, 0.5, 0.999];
    const expectedWaited = [10, 12, 14];
    const realRandom = Math.random;
    const waitedSet = new Set<number>();
    try {
      await withPaceEnv({ min: "10", max: "14" }, async () => {
        for (let i = 0; i < seq.length; i++) {
          const stubbed = seq[i] as number;
          Math.random = () => stubbed;
          const r = await applyPacing();
          assert.ok(r.waitedMs >= 10 && r.waitedMs <= 14, `waitedMs ${r.waitedMs} ∈ [10,14]`);
          assert.equal(r.waitedMs, r.jitterMs + 10, "waitedMs === jitterMs + min(10)");
          assert.equal(r.waitedMs, expectedWaited[i], `random ${seq[i]} → waited ${expectedWaited[i]}`);
          assert.equal(r.serial, true);
          waitedSet.add(r.waitedMs);
        }
      });
    } finally {
      Math.random = realRandom;
    }
    assert.ok(waitedSet.size > 1, "jitter present: the sequence yields >1 distinct waitedMs (not a constant)");

    // Non-strict real-jitter smoke (no stub): waitedMs stays within the band over N calls.
    await withPaceEnv({ min: "10", max: "14" }, async () => {
      for (let i = 0; i < 5; i++) {
        const r = await applyPacing();
        assert.ok(r.waitedMs >= 10 && r.waitedMs <= 14, `real-jitter smoke: waitedMs ${r.waitedMs} ∈ [10,14]`);
      }
    });
  });
});

// ─── T-Pace.6 — min>max misconfiguration normalized (swap) ────────────────────

describe("resolvePaceBand — min>max normalized via swap (D-RUN-2 / R4)", () => {
  // Given: MAI_PACE_MIN_MS="3000", MAI_PACE_MAX_MS="2500".
  // When:  resolvePaceBand() is called.
  // Then:  returns { minMs: 2500, maxMs: 3000, disabled: false } (lo/hi swapped — no negative jitter).
  it("T-Pace.6: when MAI_PACE_MIN_MS='3000' and MAI_PACE_MAX_MS='2500', resolvePaceBand() returns { minMs: 2500, maxMs: 3000, disabled: false }", () => {
    withPaceEnv({ min: "3000", max: "2500" }, () => {
      assert.deepEqual(resolvePaceBand(), { minMs: 2500, maxMs: 3000, disabled: false });
    });
  });
});

// ─── T-Pace.7 — parsePaceMs table ────────────────────────────────────────────

describe("parsePaceMs — pure-parser value table (D-RUN-2 / R4)", () => {
  // Given: a table of raw string inputs → expected parsed value (null = fall-through).
  // When:  parsePaceMs(raw) is called for each.
  // Then:  undefined→null, ""→null, "  "→null, "0"→0, "800"→800, " 800 "→800,
  //        "-5"→null, "3.5"→null, "1e3"→null, "007"→null, "00"→null.
  it("T-Pace.7: parsePaceMs maps undefined/''/'  '/'-5'/'3.5'/'1e3'/'007'/'00' → null, '0'→0, '800'→800, ' 800 '→800", () => {
    const table: Array<[string | undefined, number | null]> = [
      [undefined, null],
      ["", null],
      ["  ", null],
      ["0", 0],
      ["800", 800],
      [" 800 ", 800],
      ["-5", null],
      ["3.5", null],
      ["1e3", null],
      ["007", null],
      ["00", null],
    ];
    for (const [input, expected] of table) {
      assert.strictEqual(parsePaceMs(input), expected, `parsePaceMs(${JSON.stringify(input)}) → ${expected}`);
    }
  });
});

// ─── T-Pace.8 — read-only tools remain unpaced (R5 exclusion preserved) ───────

describe("read-only browser tools never call applyPacing (D-RUN-2 / R5 exclusion)", () => {
  // Given: the 5 read-only tool source files (inspect, screenshot, reload, close, clearCookies).
  // When:  each source is read and scanned.
  // Then:  none imports or calls `applyPacing` (the F9 read-only exclusion is unchanged).
  it("T-Pace.8: inspect/screenshot/reload/close/clearCookies tool source contains no applyPacing import or call (read-only exclusion preserved)", () => {
    const readOnly = ["inspect", "screenshot", "reload", "close", "clearCookies"];
    for (const t of readOnly) {
      const src = readFileSync(fileURLToPath(new URL(`../../src/tools/browser/${t}.ts`, import.meta.url)), "utf8");
      assert.ok(
        !/applyPacing/.test(src),
        `read-only tool ${t}.ts must NOT reference applyPacing (R5 exclusion preserved)`,
      );
    }
  });
});
