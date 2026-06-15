/**
 * P-AUTO-16 Step 5 — Validation — G-A16.6, G-A16.7, G-A16.8, G-A16.9, G-A16.13
 *
 * PO-7: soul auto fragment contains the resume-caps clause for start_auto_run
 * PO-8: soul STOP CONDITIONS split into 5 + cooldown-not-a-stop precedence
 *       checkpoint mirrors 5-condition split (Auto 5-stop)
 * G-A16.9: byte-identity guard for 4 existing clauses that MUST NOT be changed
 * G-A16.13: start_auto_run runtime behavior is unchanged (PO-7 is prompt-only)
 *
 * CRITIC NIT #2 (Step-3 flagged, MUST honor):
 *   G-A16.7 PO-8 negative regex scope: the assertion that status='stopped_by_user'
 *   is ABSENT must be scoped to the (4a)→(4b) DIRECTIVE SEGMENT ONLY — not the whole
 *   fragment — because the fragment legitimately contains 'stopped_by_user' in the
 *   server-only explanatory parenthetical after the (4a) directive.
 *   Implementation: slice from the (4a) index to the (4b) index, assert the
 *   directive `status='stopped_by_agent'` IS in that slice AND the literal
 *   directive shape `status='stopped_by_user'` (as a STATUS ASSIGNMENT to the tool,
 *   not as an explanation) is NOT in the (4a)-only directive text.
 *   The whole-fragment negative regex would FALSE-FAIL on the allowed parenthetical.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/auto/phase-auto-16-po7-po8-prompt.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CHECKPOINT } from "../../src/agent/systemPrompt/checkpoint.js";

// Dynamic import — soulModeFragment is the stable export; its CONTENT changes at Step 4.
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder compatibility
let soulModeFragment: ((mode: "manual" | "magical" | "auto") => string) | undefined;

const soulMod = await import("../../src/agent/systemPrompt/soul.js").catch(() => null);
soulModeFragment = soulMod?.soulModeFragment;

// ---------------------------------------------------------------------------
// Byte-identity anchors (G-A16.9) — verbatim substrings from §5 of the plan.
// Each must be present in the post-Step-4 auto fragment BYTE-FOR-BYTE.
// These pins catch unintended drift of the surrounding soul clauses.
//
// P-AUTO-9 cooldown sentence (from soul.ts:162 — current source):
const LOCKED_AUTO9_COOLDOWN =
  "If ONLY `dailyOutbound.cooldownActive` is true (not enough time since the last outbound), do NOT send outbound this turn — keep doing read-only discovery/capture/scoring and let the cooldown elapse (re-check `get_auto_run_state` before the next outbound); NEVER bypass the cooldown to fire outbound back-to-back.";

// P-AUTO-10 duplicateOf anchor (stable prefix from soul.ts:162):
const LOCKED_AUTO10_DUPLICATE_OF =
  "Before any outbound to a lead, check whether the lead carries a duplicateOf signal";

// P-AUTO-13 failure-branch anchor (from soul.ts:169):
const LOCKED_AUTO13_FAILURE_BRANCH =
  "After EVERY outbound attempt — INCLUDING a click that returns ok=false or is guard-rejected";

// P-AUTO-14 CONVERT THE BEST anchor (from soul.ts:161):
const LOCKED_AUTO14_CONVERT_THE_BEST =
  "★ CONVERT THE BEST (per-turn funnel budget):";

// ---------------------------------------------------------------------------

describe("T-A16.PO7 — soul auto fragment PO-7 resume-caps clause (P-AUTO-16 PO-7)", () => {
  // ─── G-A16.6 ───────────────────────────────────────────────────────────────
  it(
    "T-A16.PO7.6: soul auto fragment contains the start_auto_run resume-discards-caps clause",
    () => {
      // Given: soulModeFragment("auto") after builder Step 4 inserts the PO-7 clause
      // When:  the returned string is asserted by substring
      // Then:  contains "start_auto_run" AND "RESUMES it and DISCARDS any caps you passed"
      //        (the verbatim wording from §2 Fix 3 — the builder must not paraphrase this)

      if (!soulModeFragment) throw new Error("soulModeFragment not importable — builder Step 4 required");
      const fragment = soulModeFragment("auto");

      assert.ok(
        fragment.includes("start_auto_run"),
        "G-A16.6: soul auto fragment must contain 'start_auto_run'",
      );
      assert.ok(
        fragment.includes("RESUMES it and DISCARDS any caps you passed"),
        `G-A16.6: soul auto fragment must contain the verbatim PO-7 clause ` +
          `"RESUMES it and DISCARDS any caps you passed". ` +
          `Fragment excerpt (start_auto_run context): ${fragment.slice(Math.max(0, fragment.indexOf("start_auto_run") - 20), Math.min(fragment.length, fragment.indexOf("start_auto_run") + 250)).substring(0, 200)}...`,
      );
    },
  );
});

describe("T-A16.PO8 — soul STOP CONDITIONS 5-split + cooldown precedence (P-AUTO-16 PO-8)", () => {
  // ─── G-A16.7 ───────────────────────────────────────────────────────────────
  it(
    "T-A16.PO8.7: soul STOP CONDITIONS split into 5 conditions — (4a) directive uses stopped_by_agent, not stopped_by_user",
    () => {
      // Given: soulModeFragment("auto") after builder Step 4 replaces the STOP CONDITIONS block
      // When:  asserted by substring
      // Then:  contains all required substrings
      //        (4a) directive regex /(4a)[^]*?status='stopped_by_agent'/ matches
      //        (4a)→(4b) DIRECTIVE SEGMENT does NOT contain the directive form status='stopped_by_user'
      //
      // CRITIC NIT #2 (honored): the negative assertion is scoped to the (4a)-only
      // directive text segment (from the (4a) index to the (4b) index) — NOT the whole
      // fragment. The fragment legitimately contains 'stopped_by_user' in the parenthetical
      // explanation after the (4a) directive (e.g. "the `stopped_by_user` status is reserved
      // for the server's /workflow/cancel path"). A whole-fragment negative regex would
      // false-fail on that allowed parenthetical.

      if (!soulModeFragment) throw new Error("soulModeFragment not importable — builder Step 4 required");
      const fragment = soulModeFragment("auto");

      // Required positive substrings (whole-fragment assertions):
      const requiredSubstrings = [
        "STOP CONDITIONS — call `end_auto_run` when any of these 5 hold",
        "(4a)",
        "(4b)",
        "stopped_by_agent",
        "User stop/cancel",
        "No next action",
        "PRECEDENCE — outbound cooldown is NEVER a stop",
        "dailyOutbound.remaining > 0",
      ] as const;

      for (const s of requiredSubstrings) {
        assert.ok(
          fragment.includes(s),
          `G-A16.7: soul auto fragment must contain "${s}"`,
        );
      }

      // Negative: old conflated wording must NOT appear
      assert.ok(
        !fragment.includes("User stop/cancel or no clear next action"),
        `G-A16.7: soul fragment must NOT contain the OLD conflated wording ` +
          `"User stop/cancel or no clear next action" (PO-8 splits this into (4a) and (4b))`,
      );

      // (4a) directive regex: /(4a)[^]*?status='stopped_by_agent'/ must match
      const directive4aToAgent = /(4a)[^]*?status='stopped_by_agent'/;
      assert.ok(
        directive4aToAgent.test(fragment),
        `G-A16.7: soul fragment must match /(4a)[^]*?status='stopped_by_agent'/ ` +
          `(the (4a) directive must assign status='stopped_by_agent', not status='stopped_by_user')`,
      );

      // CRITIC NIT #2: scope the negative stopped_by_user assertion to the (4a) DIRECTIVE SEGMENT only.
      // Extract the text from "(4a)" up to "(4b)" — this is the directive text for the (4a) condition.
      // The fragment MAY legitimately mention 'stopped_by_user' in an explanatory parenthetical
      // WITHIN the (4a) directive (e.g. "the `stopped_by_user` status is reserved for...").
      // The test must NOT use a whole-fragment negative regex. Instead, check that the DIRECTIVE
      // ASSIGNMENT pattern `→ status='stopped_by_user'` does NOT appear in the (4a) directive.
      //
      // Specifically: the (4a) directive text is:
      //   "(4a) the user EXPLICITLY asks you to stop or cancel the run → status='stopped_by_agent', summary='User stop/cancel: ...' (... the `stopped_by_user` status is reserved ...)"
      // The directive assigns status='stopped_by_agent' (the → assignment), NOT status='stopped_by_user'.
      // The word "stopped_by_user" appears in the PARENTHETICAL EXPLANATION (allowed).
      // Test: the DIRECTIVE ASSIGNMENT `→ status='stopped_by_user'` must NOT appear in the (4a) directive.

      const idx4a = fragment.indexOf("(4a)");
      const idx4b = fragment.indexOf("(4b)");
      assert.ok(idx4a !== -1, "G-A16.7: fragment must contain '(4a)'");
      assert.ok(idx4b !== -1, "G-A16.7: fragment must contain '(4b)'");
      assert.ok(idx4a < idx4b, "G-A16.7: '(4a)' must appear before '(4b)' in the fragment");

      // The (4a) directive segment: from idx4a to idx4b
      const directive4aSegment = fragment.slice(idx4a, idx4b);

      // The directive form that must NOT appear in the (4a) directive:
      // "→ status='stopped_by_user'" — this would be wrong (the agent cannot call this)
      // Allow "stopped_by_user" to appear in the explanatory parenthetical, but NOT as a directive.
      const forbiddenDirectivePattern = /→\s*status='stopped_by_user'/;
      assert.ok(
        !forbiddenDirectivePattern.test(directive4aSegment),
        `G-A16.7: the (4a) directive segment must NOT contain the directive pattern "→ status='stopped_by_user'". ` +
          `(4a) directive text (first 300 chars): "${directive4aSegment.substring(0, 300)}"`,
      );

      // Confirm: the (4a) directive DOES contain the correct assignment
      const correctDirectivePattern = /→\s*status='stopped_by_agent'/;
      assert.ok(
        correctDirectivePattern.test(directive4aSegment),
        `G-A16.7: the (4a) directive segment must contain "→ status='stopped_by_agent'". ` +
          `(4a) directive text (first 300 chars): "${directive4aSegment.substring(0, 300)}"`,
      );
    },
  );

  // ─── G-A16.8 ───────────────────────────────────────────────────────────────
  it(
    "T-A16.PO8.8: checkpoint mirrors 5-condition split — contains 'Auto 5-stop', (4a), (4b), cooldown-not-a-stop; NOT 'Auto 4-stop'",
    () => {
      // Given: CHECKPOINT constant imported from checkpoint.ts after builder Step 4 edit
      // When:  asserted by substring
      // Then:  contains all 5-split substrings; does NOT contain "Auto 4-stop"
      //        The (4a) directive prescribes stopped_by_agent; parenthetical explaining
      //        stopped_by_user as server-only is allowed in the explanatory clause

      const required = [
        "Auto 5-stop",
        "(4a)",
        "(4b)",
        "stopped_by_agent",
        "User stop/cancel",
        "No next action",
        "cooldown is NOT a stop",
      ] as const;

      for (const s of required) {
        assert.ok(
          CHECKPOINT.includes(s),
          `G-A16.8: CHECKPOINT must contain "${s}"`,
        );
      }

      // Old label must be gone
      assert.ok(
        !CHECKPOINT.includes("Auto 4-stop"),
        `G-A16.8: CHECKPOINT must NOT contain "Auto 4-stop" (replaced by "Auto 5-stop" in PO-8 edit)`,
      );

      // The (4a) directive in checkpoint should use stopped_by_agent (directive form)
      // Apply the same critic-NIT-#2 scoping: check within (4a)→(4b) segment
      const idx4a = CHECKPOINT.indexOf("(4a)");
      const idx4b = CHECKPOINT.indexOf("(4b)");
      if (idx4a !== -1 && idx4b !== -1 && idx4a < idx4b) {
        const ckpt4aSegment = CHECKPOINT.slice(idx4a, idx4b);
        // The directive assignment in checkpoint for (4a) must reference stopped_by_agent
        assert.ok(
          ckpt4aSegment.includes("stopped_by_agent"),
          `G-A16.8: checkpoint (4a) directive segment must contain 'stopped_by_agent'. ` +
            `Segment: "${ckpt4aSegment.substring(0, 200)}"`,
        );
      }
    },
  );
});

describe("T-A16.ByteGuard — P-AUTO-9/10/13/14 clauses byte-identical after PO-8 edit (P-AUTO-16 §3.3)", () => {
  // ─── G-A16.9 ───────────────────────────────────────────────────────────────
  it(
    "T-A16.ByteGuard.9: four verbatim clause anchors present byte-for-byte in the post-Step-4 auto fragment",
    () => {
      // Given: soulModeFragment("auto") after builder Step 4
      //        The 4 locked anchors from §5 G-A16.9 must be byte-identical to the pre-Step-4 source.
      //        The PO-8 edit ONLY changes the STOP CONDITIONS block; these 4 clauses are in
      //        adjacent but NON-edited zones of the auto fragment — any accidental overwrite
      //        or off-by-one paste FAILS this test.
      // When:  each locked anchor is searched in the fragment with includes()
      // Then:  all 4 are present byte-for-byte:
      //   (a) LOCKED_AUTO9_COOLDOWN  — P-AUTO-9 cooldown sentence
      //   (b) LOCKED_AUTO10_DUPLICATE_OF — P-AUTO-10 duplicateOf sentinel
      //   (c) LOCKED_AUTO13_FAILURE_BRANCH — P-AUTO-13 failure-branch opener
      //   (d) LOCKED_AUTO14_CONVERT_THE_BEST — P-AUTO-14 convert-the-best marker

      if (!soulModeFragment) throw new Error("soulModeFragment not importable — builder Step 4 required");
      const fragment = soulModeFragment("auto");

      assert.ok(
        fragment.includes(LOCKED_AUTO9_COOLDOWN),
        `G-A16.9(a): P-AUTO-9 cooldown clause must be byte-identical after PO-8 edit. ` +
          `Missing anchor: "${LOCKED_AUTO9_COOLDOWN.substring(0, 80)}..."`,
      );
      assert.ok(
        fragment.includes(LOCKED_AUTO10_DUPLICATE_OF),
        `G-A16.9(b): P-AUTO-10 duplicateOf clause must be byte-identical after PO-8 edit. ` +
          `Missing anchor: "${LOCKED_AUTO10_DUPLICATE_OF}"`,
      );
      assert.ok(
        fragment.includes(LOCKED_AUTO13_FAILURE_BRANCH),
        `G-A16.9(c): P-AUTO-13 failure-branch clause must be byte-identical after PO-8 edit. ` +
          `Missing anchor: "${LOCKED_AUTO13_FAILURE_BRANCH}"`,
      );
      assert.ok(
        fragment.includes(LOCKED_AUTO14_CONVERT_THE_BEST),
        `G-A16.9(d): P-AUTO-14 convert-the-best clause must be byte-identical after PO-8 edit. ` +
          `Missing anchor: "${LOCKED_AUTO14_CONVERT_THE_BEST}"`,
      );
    },
  );
});

describe("T-A16.PO7Runtime — start_auto_run runtime behavior unchanged (P-AUTO-16 PO-7 no-code-change)", () => {
  // ─── G-A16.13 ──────────────────────────────────────────────────────────────
  it(
    "T-A16.PO7.13: start_auto_run with an in-flight run returns { resumed: true, maxConnects: <existing> } — caller-supplied maxConnects discarded",
    async () => {
      // Given: PO-7 is prompt-only — no production code change to startAutoRun.ts
      //        a :memory:-keyed (tmp-path) DB seeded with one running auto_run row (maxConnects=3)
      //        makeStartAutoRunTool(dbPath) called
      // When:  start_auto_run({ maxConnects: 10 }) called (caller tries to "bump" the cap)
      // Then:  returned envelope has resumed: true AND maxConnects: 3 (NOT 10)
      //        (the runtime behavior is byte-identical to pre-P-AUTO-16; PO-7 only adds a soul prompt)

      const salesMod = await import("../../src/persistence/salesDb.js").catch(() => null);
      const openSalesDatabaseFn: (...args: unknown[]) => unknown = salesMod?.openSalesDatabase ?? null;
      const insertAutoRunFn: (...args: unknown[]) => unknown = salesMod?.insertAutoRun ?? null;
      const closeSalesDatabaseFn: (...args: unknown[]) => void = salesMod?.closeSalesDatabase ?? null;

      if (!openSalesDatabaseFn) throw new Error("openSalesDatabase not importable");
      if (!insertAutoRunFn) throw new Error("insertAutoRun not importable");

      const toolMod = await import("../../src/tools/sales/startAutoRun.js").catch(() => null);
      // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
      const makeStartAutoRunTool: (path: string) => { execute: (input: Record<string, unknown>) => Promise<unknown> } = (toolMod as any)?.makeStartAutoRunTool ?? null;

      if (!makeStartAutoRunTool) throw new Error("makeStartAutoRunTool not importable");

      // Use a tmp DB path so the in-memory singleton cache is isolated per test
      const dbPath = join(tmpdir(), `po7-runtime-${randomUUID()}.sqlite`);

      // Seed: open DB and insert one running row with maxConnects=3
      const db = openSalesDatabaseFn(dbPath) as import("better-sqlite3").Database;
      insertAutoRunFn(db, { maxConnects: 3 });

      // Verify pre-condition: getCurrentAutoRun returns the row
      const salesDbMod2 = await import("../../src/persistence/salesDb.js");
      const preCheck = salesDbMod2.getCurrentAutoRun(db as import("better-sqlite3").Database);
      assert.ok(preCheck !== null, "pre-condition: getCurrentAutoRun must find the seeded row");
      assert.equal(preCheck.maxConnects, 3, "pre-condition: seeded row must have maxConnects=3");

      // Call the tool with maxConnects=10 (trying to "bump" the cap)
      const tool = makeStartAutoRunTool(dbPath);
      // biome-ignore lint/suspicious/noExplicitAny: tool result shape
      const result: any = await tool.execute({ maxConnects: 10 });

      assert.ok(
        result.ok === true || (result.data && result.data.resumed !== undefined),
        `G-A16.13: start_auto_run must return ok=true; got: ${JSON.stringify(result)}`,
      );

      const data = result.data ?? result;
      assert.ok(
        data.resumed === true,
        `G-A16.13: start_auto_run must return resumed=true when an in-flight run exists; got: ${JSON.stringify(data)}`,
      );
      assert.equal(
        data.maxConnects,
        3,
        `G-A16.13: maxConnects must be 3 (the original run's cap — NOT the caller-supplied 10). ` +
          `PO-7 is prompt-only; the runtime discard behavior (V-10) must be unchanged. ` +
          `Got: ${JSON.stringify(data)}`,
      );

      if (closeSalesDatabaseFn) closeSalesDatabaseFn(dbPath);
    },
  );
});
