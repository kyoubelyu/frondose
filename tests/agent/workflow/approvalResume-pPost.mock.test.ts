/**
 * P-POST Step 3a — approval resume prompt post branch (BLOCKER-1 fix).
 *
 * Mirrors tests/agent/workflow/approvalResume-pMsgSend.mock.test.ts.
 *
 * Gate: G-POST.Resume
 *
 * Tests T-Post.Resume.1–5 assert that approve() routes approved post steps
 * through postExtra (instructs inspect → click @pc2 → mark_message_sent, no
 * update_lead_stage) and that existing message/connect paths are not hijacked.
 *
 * These tests FAIL pre-Step-4 because the isPostStep/postExtra branch does not
 * yet exist in approval-gate.ts (approved "Post ..." steps fall through to
 * connectExtra which contains "Add a note", "Send invite", "connect_sent").
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/workflow/approvalResume-pPost.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approve } from "../../../src/agent/workflow/controller/approval-gate.js";
import type { WorkflowControllerDeps } from "../../../src/agent/workflow/controller.js";
import type { Workflow, WorkflowState } from "../../../src/agent/workflow/types.js";

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Build a Workflow with a single requiresApproval:true in_progress step titled
 * `stepTitle`, set awaitingApprovalStepId, call approve(), assert 200 + ok:true,
 * return the resumePrompt string.
 *
 * Copy-equivalent of the P-MSG-SEND template at approvalResume-pMsgSend.mock.test.ts:16-46.
 */
function approvePromptForStepTitle(stepTitle: string): string {
  const stepId = "step-approval";
  const wf: Workflow = {
    id: "wf-approval",
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
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("T-Post.Resume — approval resume prompt post branch (G-POST.Resume)", () => {
  // ─── T-Post.Resume.1 ────────────────────────────────────────────────────────
  it(
    "T-Post.Resume.1: approve() on a 'Post a thought ...' step returns post-publish guidance and excludes connect-invite + message-reply tokens",
    () => {
      // Given: an approved in-progress step titled "Post a thought: hello from Frondose".
      // When:  approve() builds the resume prompt.
      // Then:  resumePrompt contains post-publish guidance (OUTBOUND POST PUBLISH, composer Post
      //        button, mark_message_sent) and explicitly excludes connect-invite and message tokens.
      const prompt = approvePromptForStepTitle("Post a thought: hello from Frondose");

      // Post-Step-4 assertions (fail pre-Step-4 because connectExtra fires instead):
      assert.match(
        prompt,
        /THIS STEP IS THE OUTBOUND POST PUBLISH/i,
        "T-Post.Resume.1: post resume prompt must identify the step as the OUTBOUND POST PUBLISH",
      );
      assert.match(
        prompt,
        /composer's "Post" button/,
        "T-Post.Resume.1: post resume prompt must direct the agent to click the composer's 'Post' button",
      );
      assert.match(
        prompt,
        /mark_message_sent\(draftId\)/,
        "T-Post.Resume.1: post resume prompt must instruct mark_message_sent(draftId) for closeout",
      );
      assert.doesNotMatch(
        prompt,
        /Add a note/,
        "T-Post.Resume.1: post resume prompt must NOT include connect-note guidance",
      );
      assert.doesNotMatch(
        prompt,
        /Send invite/,
        "T-Post.Resume.1: post resume prompt must NOT include invite-send guidance",
      );
      assert.doesNotMatch(
        prompt,
        /connect_sent/,
        "T-Post.Resume.1: post resume prompt must NOT include connect_sent stage token (posts have no leadId)",
      );
      assert.doesNotMatch(
        prompt,
        /update_lead_stage/,
        "T-Post.Resume.1: post resume prompt must NOT call update_lead_stage (post is self-anchored)",
      );
      assert.doesNotMatch(
        prompt,
        /thread's "Send" button/,
        'T-Post.Resume.1: post resume prompt must NOT include message-reply "Send" button guidance',
      );
    },
  );

  // ─── T-Post.Resume.2 ────────────────────────────────────────────────────────
  it(
    "T-Post.Resume.2: a 'Publish post ...' step ALSO selects the post branch (isPostStep regex matches 'publish')",
    () => {
      // Given: a step titled "Publish post about Q3 launch".
      // When:  approve() builds the resume prompt.
      // Then:  the same post-publish assertions as T-Post.Resume.1 hold.
      //        The isPostStep predicate /(post|publish|发布|発信)/i matches "publish".
      const prompt = approvePromptForStepTitle("Publish post about Q3 launch");

      assert.match(
        prompt,
        /THIS STEP IS THE OUTBOUND POST PUBLISH/i,
        "T-Post.Resume.2: 'Publish post' step must select the post branch",
      );
      assert.match(
        prompt,
        /composer's "Post" button/,
        "T-Post.Resume.2: 'Publish post' resume must direct the agent to click the composer's 'Post' button",
      );
      assert.match(
        prompt,
        /mark_message_sent\(draftId\)/,
        "T-Post.Resume.2: 'Publish post' resume must instruct mark_message_sent(draftId)",
      );
      assert.doesNotMatch(
        prompt,
        /Add a note/,
        "T-Post.Resume.2: 'Publish post' resume must NOT include connect-note guidance",
      );
      assert.doesNotMatch(
        prompt,
        /connect_sent/,
        "T-Post.Resume.2: 'Publish post' resume must NOT include connect_sent token",
      );
      assert.doesNotMatch(
        prompt,
        /update_lead_stage/,
        "T-Post.Resume.2: 'Publish post' resume must NOT call update_lead_stage",
      );
    },
  );

  // ─── T-Post.Resume.3 ────────────────────────────────────────────────────────
  it(
    "T-Post.Resume.3: existing message-reply path STILL selects the message branch — post branch must NOT hijack it",
    () => {
      // Given: a step titled "Send reply: Alice after her LinkedIn response"
      //        (verbatim from the P-MSG-SEND template at approvalResume-pMsgSend.mock.test.ts:51).
      // When:  approve() builds the resume prompt.
      // Then:  the resume prompt matches the message branch (OUTBOUND MESSAGE REPLY + Send button)
      //        and does NOT match the post branch opener.
      //        Regression guard on the P-MSG-SEND behavior.
      const prompt = approvePromptForStepTitle("Send reply: Alice after her LinkedIn response");

      assert.match(
        prompt,
        /message reply/i,
        "T-Post.Resume.3: message-reply step must still route to the message branch after P-POST",
      );
      assert.match(
        prompt,
        /thread's "Send" button/,
        "T-Post.Resume.3: message-reply resume must still target the thread's Send button",
      );
      assert.doesNotMatch(
        prompt,
        /THIS STEP IS THE OUTBOUND POST PUBLISH/i,
        "T-Post.Resume.3: message-reply step must NOT be hijacked by the post branch",
      );
    },
  );

  // ─── T-Post.Resume.4 ────────────────────────────────────────────────────────
  it(
    "T-Post.Resume.4: existing connect-invite path STILL selects the connect branch — no accidental post fallthrough",
    () => {
      // Given: a step titled "Invite Alice to connect".
      // When:  approve() builds the resume prompt.
      // Then:  the resume prompt contains Add-a-note / Send-invite / connect_sent
      //        and does NOT match the post branch.
      //        The "Invite Alice to connect" title does NOT contain post|publish|发布|発信 so
      //        isPostStep MUST be false; the connect branch fires as before P-POST.
      //        Regression guard on the connect-invite behavior.
      const prompt = approvePromptForStepTitle("Invite Alice to connect");

      assert.match(
        prompt,
        /Add a note/,
        "T-Post.Resume.4: connect-invite step must still include Add-a-note guidance",
      );
      assert.match(
        prompt,
        /Send invite/,
        "T-Post.Resume.4: connect-invite step must still include Send-invite guidance",
      );
      assert.match(
        prompt,
        /connect_sent/,
        "T-Post.Resume.4: connect-invite step must still close loop with connect_sent",
      );
      assert.doesNotMatch(
        prompt,
        /THIS STEP IS THE OUTBOUND POST PUBLISH/i,
        "T-Post.Resume.4: connect-invite step must NOT be hijacked by the post branch",
      );
    },
  );

  // ─── T-Post.Resume.5 ────────────────────────────────────────────────────────
  it(
    "T-Post.Resume.5: a 'Comment on post by Bob' step must NOT trigger the post-publish branch — isPostStep must exclude comment titles (negative regression guard)",
    () => {
      // Given: a step titled "Comment on post by Bob".
      //        The title CONTAINS the noun "post" (referring to Bob's content) but the operator's
      //        intent is to COMMENT, NOT to publish. This is P-ENGAGE territory, out of P-POST scope.
      //        The CORRECT isPostStep predicate must exclude comment intent, e.g. by requiring
      //        !/(comment|react|reply to comment)/i.test(step.title).
      //        A BUGGY isPostStep (e.g. /(post|publish)/i without the comment exclusion) would
      //        match "Comment on post by Bob" via the "post" substring and mistakenly route the
      //        agent to the feed-composer Post button — a dangerous misrouting.
      // When:  approve() builds the resume prompt.
      // Then:  the resume prompt does NOT contain the post-publish branch opener
      //        /THIS STEP IS THE OUTBOUND POST PUBLISH/ — the post branch MUST NOT fire for a
      //        comment-on-post title. The acceptable fallback is the generic connect/outbound
      //        branch (connectExtra). P-ENGAGE will add a proper comment branch later.
      //
      // LOAD-BEARING GUARD: this assertion PASSES pre-Step-4 (connectExtra fires, no isPostStep
      // branch exists) AND PASSES post-Step-4 with a CORRECT implementation (isPostStep excludes
      // comment). It FAILS if the builder ships a buggy isPostStep that matches "Comment on post
      // by Bob" — exactly the predicate bug the Step-3 re-critic (BLOCKER-1-R2) identified.
      const prompt = approvePromptForStepTitle("Comment on post by Bob");

      assert.doesNotMatch(
        prompt,
        /THIS STEP IS THE OUTBOUND POST PUBLISH/i,
        "T-Post.Resume.5: isPostStep must NOT match 'Comment on post by Bob' — comment titles must never route to the post-publish branch",
      );
      assert.doesNotMatch(
        prompt,
        /THIS STEP IS THE OUTBOUND MESSAGE REPLY/i,
        "T-Post.Resume.5: 'Comment on post by Bob' must NOT be routed to the message-reply branch either",
      );
    },
  );
});
