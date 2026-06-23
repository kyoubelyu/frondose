/**
 * P-POST-PUBLISH-6 Step 2 — T-P6.Directive, T-P6.NoUnconditionalReType, T-P6.DefaultSentence, T-P6.BudgetBracket
 *
 * Content-lock scaffolds for the deterministic post-approval directive rewrite.
 *
 * Gate coverage:
 *   T-P6.Directive          → checkpoint.ts:65 contains the new deterministic directive
 *                              (click Post once + four prohibitions + gated-fallback clause)
 *   T-P6.NoUnconditionalReType → the OLD unconditional phrasing is ABSENT from CHECKPOINT
 *   T-P6.DefaultSentence    → CHECKPOINT + CHECKPOINT_RESUME carry the full verbatim default-resume
 *                              sentence from plan §2 incl. mark_message_sent (critic CONCERN-MR-1)
 *   T-P6.BudgetBracket      → CHECKPOINT.length within [5400, 5700] after the longer new line
 *
 * FAIL-ON-HEAD state (expected RED before Codex Step 4):
 *   T-P6.Directive           FAILS — new directive text absent on HEAD
 *   T-P6.NoUnconditionalReType FAILS — old unconditional phrasing still present on HEAD
 *   T-P6.DefaultSentence     FAILS — verbatim default-resume sentence absent from HEAD
 *   T-P6.BudgetBracket       FAILS — HEAD CHECKPOINT.length ~5372, below 5400 lower bound
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/systemPrompt/postApprovalDeterministic-p6.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECKPOINT, CHECKPOINT_RESUME } from "../../../src/agent/systemPrompt/checkpoint.js";

// ─── T-P6.Directive — new deterministic approval-resume directive present ─────

describe("T-P6.Directive (G-P6.Directive): CHECKPOINT Post(feed) line contains the new deterministic post-approval directive", () => {
  it(
    "given the CHECKPOINT constant after P6 edit, when the string is searched, then it contains 'click `Post` once' (approval-resume single-click instruction)",
    () => {
      // Given: CHECKPOINT from checkpoint.ts after Codex applies the P6 line-65 rewrite.
      // When:  CHECKPOINT is searched for the new approval-resume click directive.
      // Then:  contains the literal 'click `Post` once' — the core deterministic action:
      //        on approval-resume the ONLY action is to click Post once.
      //        FAIL-ON-HEAD: HEAD line 65 has no "click `Post` once" phrasing;
      //        it says "re-open composer if closed + re-type the saved body before clicking Post".
      assert.ok(
        CHECKPOINT.includes("click `Post` once"),
        `T-P6.Directive: CHECKPOINT must contain 'click \`Post\` once' (new approval-resume single-click directive). ` +
          `Got CHECKPOINT (truncated): ${CHECKPOINT.slice(0, 500)}…`,
      );
    },
  );

  it(
    "given the CHECKPOINT constant after P6 edit, when searched for the four explicit prohibitions, then it contains all four: 'do NOT press Escape', 'do NOT screenshot', 'do NOT re-open', 'do NOT re-type'",
    () => {
      // Given: CHECKPOINT from checkpoint.ts after Codex applies the P6 line-65 rewrite.
      // When:  CHECKPOINT is searched for each of the four dithering prohibitions.
      // Then:  all four literal substrings (case-insensitive match on the key verb)
      //        are present — these are the explicit anti-dithering prohibitions.
      //        FAIL-ON-HEAD: HEAD line 65 has none of these prohibitions.
      assert.match(
        CHECKPOINT,
        /do NOT press Escape/i,
        "T-P6.Directive: CHECKPOINT must contain 'do NOT press Escape' (prohibition 1 of 4)",
      );
      assert.match(
        CHECKPOINT,
        /do NOT screenshot/i,
        "T-P6.Directive: CHECKPOINT must contain 'do NOT screenshot' (prohibition 2 of 4)",
      );
      assert.match(
        CHECKPOINT,
        /do NOT re-open/i,
        "T-P6.Directive: CHECKPOINT must contain 'do NOT re-open' (prohibition 3 of 4)",
      );
      assert.match(
        CHECKPOINT,
        /do NOT re-type/i,
        "T-P6.Directive: CHECKPOINT must contain 'do NOT re-type' (prohibition 4 of 4)",
      );
    },
  );

  it(
    "given the CHECKPOINT constant after P6 edit, when searched for the gated-fallback clause, then it contains 'ONLY if' followed by 'genuinely closed' and 'empty'",
    () => {
      // Given: CHECKPOINT from checkpoint.ts after Codex applies the P6 line-65 rewrite.
      // When:  CHECKPOINT is searched for the gated-fallback condition.
      // Then:  contains 'ONLY if' (the conditional guard),
      //        'genuinely closed' (the fallback trigger condition for fully-closed composer),
      //        and 'empty' (the fallback trigger for empty editor).
      //        FAIL-ON-HEAD: HEAD line 65 has an UNCONDITIONAL re-open + re-type, not a gated form.
      assert.match(
        CHECKPOINT,
        /ONLY if/,
        "T-P6.Directive: CHECKPOINT must contain 'ONLY if' (gated-fallback guard keyword). FAIL-ON-HEAD.",
      );
      assert.match(
        CHECKPOINT,
        /genuinely closed/i,
        "T-P6.Directive: CHECKPOINT must contain 'genuinely closed' (gated-fallback composer-closed trigger). FAIL-ON-HEAD.",
      );
      assert.match(
        CHECKPOINT,
        /editor empty|its editor empty|genuinely.*empty/i,
        "T-P6.Directive: CHECKPOINT must contain 'editor empty' or 'its editor empty' (gated-fallback empty-editor trigger). FAIL-ON-HEAD.",
      );
    },
  );

  it(
    "given the CHECKPOINT constant after P6 edit, when CHECKPOINT_RESUME is derived via .replace(), then CHECKPOINT_RESUME also contains the new deterministic directive (derivation preserved)",
    () => {
      // Given: CHECKPOINT and CHECKPOINT_RESUME from checkpoint.ts.
      //        CHECKPOINT_RESUME = CHECKPOINT.replace(CHECKPOINT_TASK_START, CHECKPOINT_TASK_START_RESUME).
      //        The Post(feed) line lives OUTSIDE the TASK_START block, so .replace() preserves it.
      // When:  CHECKPOINT_RESUME is searched for the new approval-resume directive.
      // Then:  CHECKPOINT_RESUME also contains 'click `Post` once' (directive survived .replace()).
      //        FAIL-ON-HEAD: 'click `Post` once' absent on HEAD in both CHECKPOINT and CHECKPOINT_RESUME.
      assert.ok(
        CHECKPOINT_RESUME.includes("click `Post` once"),
        "T-P6.Directive: CHECKPOINT_RESUME must also contain 'click `Post` once' — .replace() must preserve the Post(feed) line (CHECKPOINT_RESUME derivation invariant). FAIL-ON-HEAD.",
      );
    },
  );
});

// ─── T-P6.NoUnconditionalReType — old unconditional phrasing must be ABSENT ───

describe("T-P6.NoUnconditionalReType (G-P6.Directive): the OLD unconditional re-type-on-resume phrasing from line 65 is GONE from CHECKPOINT", () => {
  it(
    "given the CHECKPOINT constant after P6 edit, when the string is searched for the OLD unconditional phrasing, then the literal substring 'on approval-resume re-open composer if closed + re-type the saved body before clicking Post' is ABSENT",
    () => {
      // Given: CHECKPOINT from checkpoint.ts after Codex applies the P6 line-65 rewrite.
      // When:  CHECKPOINT is searched for the OLD unconditional directive (verbatim P3 phrase).
      // Then:  the substring is NOT present — the unconditional directive has been replaced
      //        by the new gated form.
      //        FAIL-ON-HEAD: HEAD line 65 still contains this exact phrase (it IS present).
      //        This assertion FAILS on HEAD and PASSES after Codex removes the old phrase.
      assert.ok(
        !CHECKPOINT.includes("on approval-resume re-open composer if closed + re-type the saved body before clicking Post"),
        "T-P6.NoUnconditionalReType: CHECKPOINT must NOT contain the old unconditional 're-open + re-type' phrasing from P3. " +
          "The old phrasing IS present on HEAD, so this assertion FAILS on HEAD (correct RED state). " +
          `CHECKPOINT (truncated): ${CHECKPOINT.slice(0, 600)}…`,
      );
    },
  );
});

// ─── T-P6.DefaultSentence — full default resume sentence + mark_message_sent closeout ─

describe("T-P6.DefaultSentence (G-P6.Directive): CHECKPOINT and CHECKPOINT_RESUME carry the verbatim default-resume sentence from plan §2", () => {
  it(
    "given the CHECKPOINT constant after P6 edit, when searched for the full default resume sentence, then it matches 'On approval-resume the composer is STILL OPEN with your typed text — your ONLY action is to click `Post` once, then `mark_message_sent`'",
    () => {
      // Given: CHECKPOINT from checkpoint.ts after Codex applies the P6 line-65 rewrite.
      // When:  CHECKPOINT is searched for the verbatim default resume sentence from plan §2.
      // Then:  the regex matches the full sentence including mark_message_sent closeout —
      //        weaker wording (e.g. omitting mark_message_sent, or paraphrasing) fails.
      //        FAIL-ON-HEAD: HEAD line 65 has the OLD unconditional re-open+re-type directive;
      //        the new default-resume sentence is absent on HEAD.
      assert.match(
        CHECKPOINT,
        /On approval-resume the composer is STILL OPEN with your typed text.*your ONLY action is to click `Post` once, then `mark_message_sent`/s,
        "T-P6.DefaultSentence: CHECKPOINT must lock the full anti-dither default resume sentence (plan §2 verbatim). FAIL-ON-HEAD.",
      );
    },
  );

  it(
    "given CHECKPOINT_RESUME derived via .replace(), when searched for the full default resume sentence, then CHECKPOINT_RESUME also matches the verbatim sentence (derivation invariant)",
    () => {
      // Given: CHECKPOINT_RESUME = CHECKPOINT.replace(CHECKPOINT_TASK_START, CHECKPOINT_TASK_START_RESUME).
      //        The Post(feed) line lives OUTSIDE the CHECKPOINT_TASK_START block — .replace() preserves it.
      // When:  CHECKPOINT_RESUME is searched for the full default resume sentence from plan §2.
      // Then:  CHECKPOINT_RESUME also carries the sentence — the derivation invariant holds.
      //        FAIL-ON-HEAD: new sentence absent from both CHECKPOINT and CHECKPOINT_RESUME on HEAD.
      assert.match(
        CHECKPOINT_RESUME,
        /On approval-resume the composer is STILL OPEN with your typed text.*your ONLY action is to click `Post` once, then `mark_message_sent`/s,
        "T-P6.DefaultSentence: CHECKPOINT_RESUME must also carry the full default resume sentence (derivation invariant). FAIL-ON-HEAD.",
      );
    },
  );
});

// ─── T-P6.BudgetBracket — CHECKPOINT.length within new bracket after longer line ─

describe("T-P6.BudgetBracket (G-P6.Directive): CHECKPOINT.length is within [5400, 5700] after the P6 line-65 expansion", () => {
  it(
    "given the CHECKPOINT constant after P6 edit, when its length is measured, then 5400 <= CHECKPOINT.length <= 5700 (the new bracket after adding the deterministic directive and four prohibitions)",
    () => {
      // Given: CHECKPOINT from checkpoint.ts after Codex applies the P6 line-65 rewrite.
      //        The new line 65 is ~207 chars longer than the old one
      //        (adds: click-once instruction + four prohibitions + gated-fallback clause).
      //        Pre-P6 HEAD length: ~5279.  Post-P6 estimated: ~5486.
      // When:  CHECKPOINT.length is measured.
      // Then:  5400 <= length <= 5700
      //        FAIL-ON-HEAD: HEAD CHECKPOINT.length ~5279, which is BELOW the new lower bound 5400.
      //        This assertion FAILS on HEAD and PASSES after Codex adds the longer new directive.
      const len = CHECKPOINT.length;
      assert.ok(
        len >= 5400,
        `T-P6.BudgetBracket: CHECKPOINT.length=${len} is below the expected post-P6 lower bound of 5400. ` +
          "FAIL-ON-HEAD: HEAD length ~5279 < 5400 (correct RED state). " +
          "Will pass after Codex adds the new deterministic directive (~207 chars extra).",
      );
      assert.ok(
        len <= 5700,
        `T-P6.BudgetBracket: CHECKPOINT.length=${len} exceeds the 5700-char P6 upper budget cap. ` +
          "The new line 65 should add ~200-250 chars; anything above 5700 suggests unintended content was added.",
      );
    },
  );
});
