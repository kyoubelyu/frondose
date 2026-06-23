/**
 * P-POST-PUBLISH-3 Step 2 — T-PPub3.Resume.1–5 + T-NoReg.1–3 + T-PPub3.Checkpoint.1–2
 *
 * Mirrors tests/agent/workflow/approvalResume-pPost.mock.test.ts (same harness / helper).
 *
 * Gate coverage: G-PPub3.Resume.Order, G-PPub3.Resume.Both-Cases, G-PPub3.Resume.Exactness,
 *                G-PPub3.Resume.PostEnabled, G-PPub3.Resume.Closeout,
 *                G-PPub3.NoRegression.Connect, G-PPub3.NoRegression.Message,
 *                G-PPub3.NoRegression.Comment, G-PPub3.Checkpoint.Hint,
 *                G-PPub3.Checkpoint.LengthBudget.
 *
 * FAIL-ON-HEAD vs REGRESSION-BASELINE:
 *   Fail on HEAD (new behavior not yet implemented — these tests drive the Step 4 implementation):
 *     T-PPub3.Resume.1, T-PPub3.Resume.2, T-PPub3.Resume.3, T-PPub3.Resume.4,
 *     T-PPub3.Checkpoint.1
 *   Pass on HEAD as regression baselines (assert unchanged branches / budget):
 *     T-PPub3.Resume.5 (postExtra already has mark_message_sent, no update_lead_stage/connect_sent),
 *     T-NoReg.1, T-NoReg.2, T-NoReg.3, T-PPub3.Checkpoint.2
 *
 * T-Live.1 and T-Live.2 are live-only tests driven by the orchestrator/validator at Step 5
 * on win-build-host; they are NOT part of this mock suite (no .ts bodies here).
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/agent/workflow/approvalResume-pPostPublish3.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approve } from "../../../src/agent/workflow/controller/approval-gate.js";
import type { WorkflowControllerDeps } from "../../../src/agent/workflow/controller.js";
import type { Workflow, WorkflowState } from "../../../src/agent/workflow/types.js";
import { CHECKPOINT } from "../../../src/agent/systemPrompt/checkpoint.js";

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Build a Workflow with a single requiresApproval:true in_progress step titled
 * `stepTitle`, set awaitingApprovalStepId, call approve(), assert 200 + ok:true,
 * return the resumePrompt string.
 *
 * Identical pattern to approvalResume-pPost.mock.test.ts:36-66.
 */
function approvePromptForStepTitle(stepTitle: string): string {
  const stepId = "step-ppub3";
  const wf: Workflow = {
    id: "wf-ppub3",
    title: "Manual approved outbound",
    approvalMode: "manual",
    steps: [
      {
        id: stepId,
        title: stepTitle,
        state: "in_progress",
        requiresApproval: true,
      },
    ],
    state: "awaiting_approval",
    createdAt: "2026-06-23T00:00:00.000Z",
    updatedAt: "2026-06-23T00:00:00.000Z",
  };
  const state: WorkflowState = { current: wf, awaitingApprovalStepId: stepId };
  const deps: WorkflowControllerDeps = {
    emitFrame: () => {},
    writeWorkflowAudit: () => {},
  };

  const result = approve(state, new Set<string>(), deps, wf, stepId);

  assert.equal(result.status, 200, "approve() must return 200 for a pending approval");
  assert.deepEqual(result.response, { ok: true }, "approve() must accept the pending approval");
  assert.equal(typeof result.resumePrompt, "string", "approve() must return a resume prompt string");
  return result.resumePrompt as string;
}

// ─── T-PPub3.Resume — post-publish approval resume prompt (G-PPub3.Resume.*) ──

describe("T-PPub3.Resume — post-branch approval resume prompt (P-POST-PUBLISH-3)", () => {
  // ─── T-PPub3.Resume.1 ─────────────────────────────────────────────────────
  it(
    "T-PPub3.Resume.1: when an approved post step resumes, resumePrompt contains the post-publish marker, and inspect appears before type before click, and re-type instruction is present",
    () => {
      // Given: an approved in-progress step titled "Post a thought: hello from Frondose".
      // When:  approve() builds the resume prompt.
      // Then:  resumePrompt contains "THIS STEP IS THE OUTBOUND POST PUBLISH";
      //        "inspect" appears before "type" before "click";
      //        matches /re-type|retype/i (unconditional re-type directive present).
      //
      // FAIL-ON-HEAD: HEAD postExtra lacks the unconditional re-type sequence (steps 1-3-click order
      // is present but "Start a post" re-open path, "regardless", and "exact/verbatim" clauses are
      // absent). The re-type regex check fails on HEAD because HEAD has no "re-type" substring.
      const prompt = approvePromptForStepTitle("Post a thought: hello from Frondose");

      assert.match(
        prompt,
        /THIS STEP IS THE OUTBOUND POST PUBLISH/i,
        "T-PPub3.Resume.1: post resume must contain the post-publish step marker",
      );

      // Ordering: indexOf(inspect) < indexOf(type) < indexOf(click)
      const iInspect = prompt.indexOf("inspect");
      const iType = prompt.indexOf("`type`");
      const iClick = prompt.indexOf("`click`");
      assert.ok(iInspect !== -1, "T-PPub3.Resume.1: resumePrompt must mention 'inspect'");
      assert.ok(iType !== -1, "T-PPub3.Resume.1: resumePrompt must mention '`type`'");
      assert.ok(iClick !== -1, "T-PPub3.Resume.1: resumePrompt must mention '`click`'");
      assert.ok(
        iInspect < iType,
        `T-PPub3.Resume.1: 'inspect' (pos ${iInspect}) must appear before '\`type\`' (pos ${iType}) in resumePrompt`,
      );
      assert.ok(
        iType < iClick,
        `T-PPub3.Resume.1: '\`type\`' (pos ${iType}) must appear before '\`click\`' (pos ${iClick}) in resumePrompt`,
      );

      assert.match(
        prompt,
        /re-type|retype/i,
        "T-PPub3.Resume.1: resumePrompt must contain a re-type directive matching /re-type|retype/i",
      );
    },
  );

  // ─── T-PPub3.Resume.2 ─────────────────────────────────────────────────────
  it(
    "T-PPub3.Resume.2: when an approved post step resumes, resumePrompt covers both 'composer open but empty' and 'composer fully closed' reset modes",
    () => {
      // Given: an approved in-progress step titled "Post a thought: hello from Frondose".
      // When:  approve() builds the resume prompt.
      // Then:  matches /Start a post/i (re-open path for fully-closed composer case);
      //        matches /regardless|either way|whether or not|in both cases|always/i
      //        (unconditional re-type regardless of inspect outcome).
      //
      // FAIL-ON-HEAD: HEAD postExtra has no "Start a post" re-open step and no unconditional
      // "regardless/always/either way" clause — it uses a conditional "if it is NOT" check only.
      const prompt = approvePromptForStepTitle("Post a thought: hello from Frondose");

      assert.match(
        prompt,
        /Start a post/i,
        "T-PPub3.Resume.2: resumePrompt must mention the 'Start a post' re-open path for the fully-closed composer case",
      );
      assert.match(
        prompt,
        /regardless|either way|whether or not|in both cases|always/i,
        "T-PPub3.Resume.2: resumePrompt must include an unconditional re-type clause (/regardless|either way|whether or not|in both cases|always/i)",
      );
    },
  );

  // ─── T-PPub3.Resume.3 ─────────────────────────────────────────────────────
  it(
    "T-PPub3.Resume.3: when an approved post step resumes, resumePrompt mandates re-typing the EXACT saved post body with no paraphrase",
    () => {
      // Given: an approved in-progress step titled "Post a thought: hello from Frondose".
      // When:  approve() builds the resume prompt.
      // Then:  matches /exact|verbatim|exactly as saved|do not paraphrase|do not rewrite/i
      //        (brand-safety analog of connect-note text-fidelity guard for posts).
      //
      // FAIL-ON-HEAD: HEAD postExtra has no exactness/verbatim/do-not-paraphrase clause —
      // it only says "type the approved draft text" without forbidding paraphrase.
      // NOTE: HEAD already contains "label exactly \"Post\"" — the word "exact" appears in a
      // different context. We therefore assert on more-specific body-fidelity substrings
      // (verbatim, do not paraphrase, do not rewrite, exact saved draft) that are absent on HEAD.
      const prompt = approvePromptForStepTitle("Post a thought: hello from Frondose");

      assert.match(
        prompt,
        /verbatim|exactly as saved|do not paraphrase|do not rewrite|exact saved draft/i,
        "T-PPub3.Resume.3: resumePrompt must mandate re-typing the exact saved body (/verbatim|exactly as saved|do not paraphrase|do not rewrite|exact saved draft/i). HEAD has 'label exactly' but NOT a body-fidelity clause.",
      );
    },
  );

  // ─── T-PPub3.Resume.4 ─────────────────────────────────────────────────────
  it(
    "T-PPub3.Resume.4: when an approved post step resumes, resumePrompt instructs verifying the Post button is enabled before clicking",
    () => {
      // Given: an approved in-progress step titled "Post a thought: hello from Frondose".
      // When:  approve() builds the resume prompt.
      // Then:  matches /enabled|not (?:aria-)?disabled/i
      //        (catches no-op click on a still-disabled button — the P-POST-PUBLISH-2 symptom).
      //
      // FAIL-ON-HEAD: HEAD postExtra has no "enabled" / "not aria-disabled" clause.
      const prompt = approvePromptForStepTitle("Post a thought: hello from Frondose");

      assert.match(
        prompt,
        /enabled|not (?:aria-)?disabled/i,
        "T-PPub3.Resume.4: resumePrompt must instruct verifying the Post button is enabled before clicking (/enabled|not (?:aria-)?disabled/i)",
      );
    },
  );

  // ─── T-PPub3.Resume.5 ─────────────────────────────────────────────────────
  it(
    "T-PPub3.Resume.5: when an approved post step resumes, resumePrompt ends with mark_message_sent(draftId) and contains no update_lead_stage or connect_sent",
    () => {
      // Given: an approved in-progress step titled "Post a thought: hello from Frondose".
      // When:  approve() builds the resume prompt.
      // Then:  contains "mark_message_sent(draftId)" (post draft closeout);
      //        does NOT contain "update_lead_stage" (posts are self-anchored, no leadId);
      //        does NOT contain "connect_sent" (post branch must not bleed connect tokens).
      //
      // PASS-ON-HEAD AS REGRESSION BASELINE: HEAD postExtra already has mark_message_sent(draftId)
      // and already lacks update_lead_stage / connect_sent. This test keeps that invariant
      // across the Step-4 postExtra rewrite.
      const prompt = approvePromptForStepTitle("Post a thought: hello from Frondose");

      assert.match(
        prompt,
        /mark_message_sent\(draftId\)/,
        "T-PPub3.Resume.5: resumePrompt must instruct mark_message_sent(draftId) as post-publish closeout",
      );
      assert.doesNotMatch(
        prompt,
        /update_lead_stage/,
        "T-PPub3.Resume.5: resumePrompt must NOT call update_lead_stage — posts are self-anchored with no leadId",
      );
      assert.doesNotMatch(
        prompt,
        /connect_sent/,
        "T-PPub3.Resume.5: resumePrompt must NOT contain connect_sent token — post branch must not bleed connect tokens",
      );
    },
  );
});

// ─── T-NoReg — no-regression guards: connect / message / comment branches unchanged ──

describe("T-NoReg — no-regression: connect/message/comment branches unchanged by post-publish-3 fix", () => {
  // ─── T-NoReg.1 ────────────────────────────────────────────────────────────
  it(
    "T-NoReg.1: connect-invite resume prompt still contains Add-a-note/Send-invite/connect_sent and does NOT contain the post-publish marker",
    () => {
      // Given: an approved in-progress step titled "Invite Alice to connect".
      // When:  approve() builds the resume prompt.
      // Then:  contains "Add a note", "Send invite", "connect_sent";
      //        does NOT contain "THIS STEP IS THE OUTBOUND POST PUBLISH".
      //
      // PASS-ON-HEAD AS REGRESSION BASELINE: the connect branch (connectExtra) is unchanged
      // by P-POST-PUBLISH-3. This re-pins it from a P-PPub3 perspective.
      const prompt = approvePromptForStepTitle("Invite Alice to connect");

      assert.match(prompt, /Add a note/, "T-NoReg.1: connect resume must still include Add-a-note guidance");
      assert.match(prompt, /Send invite/, "T-NoReg.1: connect resume must still include Send-invite guidance");
      assert.match(prompt, /connect_sent/, "T-NoReg.1: connect resume must still close loop with connect_sent");
      assert.doesNotMatch(
        prompt,
        /THIS STEP IS THE OUTBOUND POST PUBLISH/i,
        "T-NoReg.1: connect-invite resume must NOT be hijacked by the post-publish branch",
      );
    },
  );

  // ─── T-NoReg.2 ────────────────────────────────────────────────────────────
  it(
    "T-NoReg.2: message-reply resume prompt still contains 'message reply' and thread Send, and does NOT contain the post-publish marker",
    () => {
      // Given: an approved in-progress step titled "Send reply: Alice after her LinkedIn response".
      // When:  approve() builds the resume prompt.
      // Then:  contains "message reply" and "thread's \"Send\" button";
      //        does NOT contain "THIS STEP IS THE OUTBOUND POST PUBLISH".
      //
      // PASS-ON-HEAD AS REGRESSION BASELINE: the message branch (messageExtra) is unchanged
      // by P-POST-PUBLISH-3. This re-pins it from a P-PPub3 perspective.
      const prompt = approvePromptForStepTitle("Send reply: Alice after her LinkedIn response");

      assert.match(
        prompt,
        /message reply/i,
        "T-NoReg.2: message-reply resume must still identify the step as a message reply",
      );
      assert.match(
        prompt,
        /thread's "Send" button/,
        "T-NoReg.2: message-reply resume must still target the thread's Send button",
      );
      assert.doesNotMatch(
        prompt,
        /THIS STEP IS THE OUTBOUND POST PUBLISH/i,
        "T-NoReg.2: message-reply resume must NOT be hijacked by the post-publish branch",
      );
    },
  );

  // ─── T-NoReg.3 ────────────────────────────────────────────────────────────
  it(
    "T-NoReg.3: a 'Comment on post by Bob' step is NOT routed to the post-publish branch — isPostStep excludes comment titles",
    () => {
      // Given: an approved in-progress step titled "Comment on post by Bob".
      //        The title contains the noun "post" (Bob's content) but the intent is to COMMENT.
      //        isPostStep must exclude: !/\b(comment|react|repost)\b/i.test(step.title).
      // When:  approve() builds the resume prompt.
      // Then:  does NOT contain "THIS STEP IS THE OUTBOUND POST PUBLISH".
      //
      // PASS-ON-HEAD AS REGRESSION BASELINE: re-pins the P-POST T-Post.Resume.5 assertion
      // from a P-PPub3 perspective to confirm the comment exclusion survives the postExtra rewrite.
      const prompt = approvePromptForStepTitle("Comment on post by Bob");

      assert.doesNotMatch(
        prompt,
        /THIS STEP IS THE OUTBOUND POST PUBLISH/i,
        "T-NoReg.3: isPostStep must NOT match 'Comment on post by Bob' — comment titles must never route to the post-publish branch even after the postExtra body is rewritten",
      );
    },
  );
});

// ─── T-NoReg.ByteEqual — byte-equality snapshots: connect + message resumePrompts ──
//
// Critic CONCERN (Step 3): T-NoReg.1/2/3 guard branch BEHAVIOR but not literal byte-equality of
// connectExtra / messageExtra. A future accidental mutation to those strings (e.g. a wording
// drift, a character transposition, an unintended re-ordering) could slip through the substring
// guards without detection. These two tests PIN the exact current resumePrompt string
// (post-Step-4 state) for a representative connect step and a representative message step.
// Any future change to connectExtra or messageExtra will fail here immediately, surfacing the
// mutation before it reaches live code.
//
// The snapshot values are captured from the production code at the Step-4 / Step-5 boundary
// (2026-06-23, approval-gate.ts post-P-POST-PUBLISH-3). The step-title-embedding header is
// included in the snapshot so the full output contract is locked — not just the extra suffix.

// Snapshot for "Invite Alice to connect" — full resumePrompt byte-equality
const CONNECT_RESUME_SNAPSHOT =
  "WORKFLOW RESUME (not a new task). " +
  'Operator approved step "Invite Alice to connect" in workflow "Manual approved outbound". ' +
  "Do not start this resume turn with search_memory or a new todo_write plan — " +
  "the workflow plan is already declared and active and those tools are now disabled. " +
  "Continue from the existing in_progress step: perform the approved step " +
  '"Invite Alice to connect" using browser tools now, ' +
  "then update the existing workflow state with todo_write as you progress. " +
  "Do NOT call suggest_card for this approved step — it is approved for EXECUTION; " +
  "perform it with browser tools directly." +
  " THIS STEP IS THE OUTBOUND ACTION. Do NOT navigate, do NOT search, do NOT re-qualify, do NOT save another draft. " +
  "Your VERY FIRST tool call MUST be `inspect` on the current page (no `navigate_to_url`). " +
  "Then locate a button whose label matches one of these EXACT terms (case-insensitive): " +
  '"Connect", "Invite to connect", "Invite ${name} to connect", "Send invite", "Send now", "Send without a note", ' +
  '"Add a note", "邀请", "添加好友", "发送邀请", "直接发送", "连接", "立即连接", "Follow". ' +
  "`click` that button by its `ref` directly (not by label, to avoid ambiguous-target errors). " +
  'If the dialog asks "Add a note", click "Add a note" — DO NOT click "Send without a note" unless the operator explicitly declined to send a note. ' +
  "Then `type` the draft text into the note textarea and `click` \"Send invite\". " +
  'Immediately after the outbound click, call `mark_message_sent(draftId)` AND `update_lead_stage(leadId, "connect_sent")` to close the loop.';

// Snapshot for "Send reply: Alice after her LinkedIn response" — full resumePrompt byte-equality
const MESSAGE_RESUME_SNAPSHOT =
  "WORKFLOW RESUME (not a new task). " +
  'Operator approved step "Send reply: Alice after her LinkedIn response" in workflow "Manual approved outbound". ' +
  "Do not start this resume turn with search_memory or a new todo_write plan — " +
  "the workflow plan is already declared and active and those tools are now disabled. " +
  "Continue from the existing in_progress step: perform the approved step " +
  '"Send reply: Alice after her LinkedIn response" using browser tools now, ' +
  "then update the existing workflow state with todo_write as you progress. " +
  "Do NOT call suggest_card for this approved step — it is approved for EXECUTION; " +
  "perform it with browser tools directly." +
  " THIS STEP IS THE OUTBOUND MESSAGE REPLY. Do NOT navigate, search, re-qualify, or save another draft. " +
  "Your VERY FIRST tool call MUST be `inspect` on the current messaging thread (scope `threadInput` or `messagingConversation`), NOT navigate_to_url. " +
  "This is a DIRECT MESSAGE, not a connection invite; there is NO note-dialog step and NO Connect/Invite button. " +
  "Ensure the approved reply text is already in the message composer (\"Write a message…\" textbox); if it is NOT, `type` the approved draft text there first. " +
  "Then `click` the thread's \"Send\" button (label \"Send\" / \"发送\") by its `ref` directly (not by label, to avoid ambiguous-target). " +
  "Immediately after the send, call `mark_message_sent(draftId)` to record it. " +
  "Do NOT call `update_lead_stage` for a connection-request stage; this was a message reply, not a connection request.";

describe("T-NoReg.ByteEqual — byte-equality snapshots for connect and message resumePrompts (critic CONCERN addressed)", () => {
  // ─── T-NoReg.ByteEqual.Connect ────────────────────────────────────────────
  it(
    "T-NoReg.ByteEqual.Connect: connect-invite resumePrompt is byte-equal to the Step-4 snapshot (any wording drift in connectExtra fails immediately)",
    () => {
      // Given: an approved in-progress step titled "Invite Alice to connect".
      // When:  approve() builds the resumePrompt.
      // Then:  the full resumePrompt string is EXACTLY equal (byte-for-byte) to CONNECT_RESUME_SNAPSHOT.
      //        Any change to connectExtra (character, word, or ordering mutation) fails this test.
      //
      // This test pins the CURRENT post-Step-4 connectExtra string, which is UNCHANGED by
      // P-POST-PUBLISH-3 (only postExtra was modified). It is a mutation sentinel.
      const prompt = approvePromptForStepTitle("Invite Alice to connect");
      assert.equal(
        prompt,
        CONNECT_RESUME_SNAPSHOT,
        "T-NoReg.ByteEqual.Connect: resumePrompt for connect step must be byte-equal to the Step-4 snapshot. " +
          "If this fails, connectExtra was mutated (or the step-title-embedding header changed). " +
          `Actual length=${prompt.length}, snapshot length=${CONNECT_RESUME_SNAPSHOT.length}`,
      );
    },
  );

  // ─── T-NoReg.ByteEqual.Message ────────────────────────────────────────────
  it(
    "T-NoReg.ByteEqual.Message: message-reply resumePrompt is byte-equal to the Step-4 snapshot (any wording drift in messageExtra fails immediately)",
    () => {
      // Given: an approved in-progress step titled "Send reply: Alice after her LinkedIn response".
      // When:  approve() builds the resumePrompt.
      // Then:  the full resumePrompt string is EXACTLY equal (byte-for-byte) to MESSAGE_RESUME_SNAPSHOT.
      //        Any change to messageExtra (character, word, or ordering mutation) fails this test.
      //
      // This test pins the CURRENT post-Step-4 messageExtra string, which is UNCHANGED by
      // P-POST-PUBLISH-3 (only postExtra was modified). It is a mutation sentinel.
      const prompt = approvePromptForStepTitle("Send reply: Alice after her LinkedIn response");
      assert.equal(
        prompt,
        MESSAGE_RESUME_SNAPSHOT,
        "T-NoReg.ByteEqual.Message: resumePrompt for message step must be byte-equal to the Step-4 snapshot. " +
          "If this fails, messageExtra was mutated (or the step-title-embedding header changed). " +
          `Actual length=${prompt.length}, snapshot length=${MESSAGE_RESUME_SNAPSHOT.length}`,
      );
    },
  );
});

// ─── T-PPub3.Checkpoint — CHECKPOINT string guards (G-PPub3.Checkpoint.*) ────

describe("T-PPub3.Checkpoint — CHECKPOINT post-flow hint and length budget", () => {
  // ─── T-PPub3.Checkpoint.1 ─────────────────────────────────────────────────
  it(
    "T-PPub3.Checkpoint.1: CHECKPOINT contains '**Post (feed)**:' AND contains the P6 deterministic directive ('click `Post` once' + 'do NOT press Escape')",
    () => {
      // Given: the CHECKPOINT constant imported from src/agent/systemPrompt/checkpoint.ts
      //        after the P-POST-PUBLISH-6 Codex edit.
      // When:  the string is searched.
      // Then:  contains "**Post (feed)**:" (structural label — unchanged by P6);
      //        AND contains 'click `Post` once' (new P6 deterministic approval-resume directive).
      //        AND matches /do NOT press Escape/i (one of the four P6 prohibitions).
      //
      // Updated from P-POST-PUBLISH-3 (which checked /re-?type the saved body|re-?open the composer if closed/i)
      // to P-POST-PUBLISH-6 (which replaces the unconditional re-type with the deterministic click-once +
      // four prohibitions + gated fallback). The P3 unconditional phrasing is now ABSENT (see T-P6.NoUnconditionalReType).
      //
      // FAIL-ON-HEAD: 'click `Post` once' absent on HEAD.
      // PASSES after Codex applies the P6 line-65 rewrite.
      assert.ok(
        CHECKPOINT.includes("**Post (feed)**:"),
        `T-PPub3.Checkpoint.1: CHECKPOINT must contain "**Post (feed)**:" (structural Post(feed) label); got length=${CHECKPOINT.length}`,
      );
      assert.ok(
        CHECKPOINT.includes("click `Post` once"),
        "T-PPub3.Checkpoint.1: CHECKPOINT must contain 'click `Post` once' (P6 deterministic approval-resume directive). FAIL-ON-HEAD.",
      );
      assert.match(
        CHECKPOINT,
        /do NOT press Escape/i,
        "T-PPub3.Checkpoint.1: CHECKPOINT must contain 'do NOT press Escape' (P6 anti-dithering prohibition). FAIL-ON-HEAD.",
      );
    },
  );

  // ─── T-PPub3.Checkpoint.2 ─────────────────────────────────────────────────
  it(
    "T-PPub3.Checkpoint.2: CHECKPOINT.length <= 5700 (length budget regression guard; P6 raised cap from 5400 to 5700 to fit the deterministic directive + four prohibitions + gated fallback)",
    () => {
      // Given: CHECKPOINT.length after the P6 line-65 rewrite adds ~207 chars
      //        (click-once instruction + four prohibitions + gated-fallback clause).
      // When:  the length is measured.
      // Then:  <= 5700 (pre-P6 HEAD ~5279 + ~207 new chars = ~5486; P6 cap raised from 5400→5700).
      //
      // Updated from P-POST-PUBLISH-3 cap 5400 to P-POST-PUBLISH-6 cap 5700.
      // The 5400 cap was set to fit the P3 re-type-on-resume hint (~80 chars extra over P-POST).
      // The P6 deterministic directive is ~207 chars longer than the old P3 line, requiring
      // the cap to be raised. Mirrors T-Checkpoint.7 in checkpoint.mock.test.ts (also updated).
      assert.ok(
        CHECKPOINT.length <= 5700,
        `T-PPub3.Checkpoint.2: CHECKPOINT.length=${CHECKPOINT.length} exceeds 5700-char budget (P-POST-PUBLISH-6 regression guard)`,
      );
    },
  );
});
