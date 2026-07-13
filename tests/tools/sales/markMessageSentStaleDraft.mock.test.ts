/**
 * P-FIX-MARK-SENT-STALE-DRAFT FM-2 — mark_message_sent prior-state validation
 * + markDraftRejected guarded transition.
 *
 * THE BUG (live 2026-07-13): mark_message_sent only rejected status='sent',
 * so a stale draftId whose owning approval step the operator DECLINED could
 * still be marked sent (draft 58df78de… recorded connect_note|sent with text
 * that never went out). Fix: allow-list — only status='draft' is sendable —
 * plus decline() retiring the captured draft to status='rejected' via the
 * guarded markDraftRejected writer.
 *
 * Run:
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/sales/markMessageSentStaleDraft.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  findDraftForDeclinedStep,
  insertDraft,
  markDraftRejected,
  openSalesDatabase,
} from "../../../src/persistence/salesDb.js";
import { makeMarkMessageSentTool } from "../../../src/tools/sales/markMessageSent.js";
import { makeTmpFile } from "../../_helpers/tmp";

// biome-ignore lint/suspicious/noExplicitAny: runtime envelope introspection
type AnyObj = Record<string, any>;

/** Minimal Vercel tool execute options. */
const toolOpts = { messages: [] as never[], toolCallId: "test" };

/** Seed a candidate + lead (named), insert a connect_note draft; returns ids. */
function seedLeadDraft(tmpPath: string, personName = "Stale Fixture"): { draftId: string; leadId: string } {
  const db = openSalesDatabase(tmpPath);
  const candidateId = randomUUID();
  const leadId = randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO raw_candidates (id, person_name, profile_url, source, observed_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(candidateId, personName, `https://www.linkedin.com/in/stale-${candidateId.slice(0, 8)}/`, "search", now, now);
  db.prepare(
    "INSERT INTO leads (id, candidate_id, person_name, profile_url, stage, owner_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    leadId,
    candidateId,
    personName,
    `https://www.linkedin.com/in/stale-${candidateId.slice(0, 8)}/`,
    "qualified",
    "manual",
    now,
    now,
  );
  const draftId = insertDraft(db, {
    leadId,
    kind: "connect_note",
    text: "Hi — note text for the stale-draft fixture.",
    createdBy: "llm",
  });
  return { draftId, leadId };
}

function getStatus(tmpPath: string, draftId: string): string | undefined {
  const db = openSalesDatabase(tmpPath);
  const row = db.prepare("SELECT status FROM message_drafts WHERE id = ?").get(draftId) as
    | { status: string }
    | undefined;
  return row?.status;
}

function setStatus(tmpPath: string, draftId: string, status: string): void {
  openSalesDatabase(tmpPath).prepare("UPDATE message_drafts SET status = ? WHERE id = ?").run(status, draftId);
}

describe("T-StaleDraft — mark_message_sent prior-state validation (allow-list)", () => {
  it("T-StaleDraft.1: draft status='draft' → mark_message_sent succeeds, status becomes 'sent'", async () => {
    // Given: a live status='draft' connect_note draft bound to an existing lead.
    // When:  mark_message_sent({draftId}) is called.
    // Then:  envelope ok=true and the row transitions to status='sent' (happy path unchanged).
    const tmpPath = makeTmpFile(`stale-draft-${randomUUID()}.sqlite`);
    const { draftId, leadId } = seedLeadDraft(tmpPath);
    const tool = makeMarkMessageSentTool(tmpPath) as AnyObj;

    const result = await tool.execute({ draftId }, toolOpts);

    assert.equal(result.ok, true, `happy path must still succeed; got: ${JSON.stringify(result)}`);
    assert.equal(result.data?.leadId, leadId, "returned leadId must match the draft's lead");
    assert.equal(getStatus(tmpPath, draftId), "sent", "row must be status='sent' after the call");
  });

  it("T-StaleDraft.2: draft status='sent' → rejected invalid_input with the exact historical 'already sent' message", async () => {
    // Given: a draft already marked sent.
    // When:  mark_message_sent({draftId}) is called again.
    // Then:  ok=false, kind=invalid_input, message is EXACTLY the pre-existing string
    //        (existing tests assert it; the new allow-list must not reword this branch).
    const tmpPath = makeTmpFile(`stale-sent-${randomUUID()}.sqlite`);
    const { draftId } = seedLeadDraft(tmpPath);
    const tool = makeMarkMessageSentTool(tmpPath) as AnyObj;
    await tool.execute({ draftId }, toolOpts); // first send

    const second = await tool.execute({ draftId }, toolOpts);

    assert.equal(second.ok, false, "second call must be rejected");
    assert.equal(second.error?.kind, "invalid_input", "kind must be invalid_input");
    assert.equal(
      second.error?.message,
      `Draft ${draftId} is already sent`,
      "the 'already sent' branch must keep its exact historical message",
    );
  });

  it("T-StaleDraft.3: draft status='rejected' (operator-declined) → rejected invalid_input citing the status; row stays 'rejected'", async () => {
    // Given: a draft whose owning approval step was declined (status='rejected').
    // When:  mark_message_sent({draftId}) is called (the live-incident replay).
    // Then:  ok=false invalid_input with the deterministic status-citing message;
    //        the row is NOT transitioned to 'sent'.
    const tmpPath = makeTmpFile(`stale-rejected-${randomUUID()}.sqlite`);
    const { draftId } = seedLeadDraft(tmpPath);
    setStatus(tmpPath, draftId, "rejected");
    const tool = makeMarkMessageSentTool(tmpPath) as AnyObj;

    const result = await tool.execute({ draftId }, toolOpts);

    assert.equal(result.ok, false, `a rejected draft must not be markable as sent; got: ${JSON.stringify(result)}`);
    assert.equal(result.error?.kind, "invalid_input", "kind must be invalid_input");
    assert.equal(
      result.error?.message,
      `Draft ${draftId} cannot be marked sent from status 'rejected'; only status 'draft' is sendable.`,
      "message must cite the actual status and the allow-list rule",
    );
    assert.equal(getStatus(tmpPath, draftId), "rejected", "row must remain 'rejected'");
  });

  it("T-StaleDraft.4: unknown draftId → not_found (unchanged)", async () => {
    // Given: an empty sales DB.
    // When:  mark_message_sent with a random id.
    // Then:  ok=false, kind=not_found (pre-existing behavior preserved).
    const tmpPath = makeTmpFile(`stale-unknown-${randomUUID()}.sqlite`);
    openSalesDatabase(tmpPath); // create schema
    const tool = makeMarkMessageSentTool(tmpPath) as AnyObj;

    const result = await tool.execute({ draftId: randomUUID() }, toolOpts);

    assert.equal(result.ok, false, "unknown id must fail");
    assert.equal(result.error?.kind, "not_found", "kind must be not_found");
  });

  it("T-StaleDraft.5: draft status='approved' or 'revised' (declared-but-unwritten statuses) → rejected invalid_input (fail-closed)", async () => {
    // Given: rows hand-set to the DraftStatus values no production code writes yet.
    // When:  mark_message_sent is called on each.
    // Then:  both fail closed with invalid_input — the allow-list needs no foreknowledge
    //        of which non-'draft' statuses exist.
    for (const status of ["approved", "revised"]) {
      const tmpPath = makeTmpFile(`stale-${status}-${randomUUID()}.sqlite`);
      const { draftId } = seedLeadDraft(tmpPath);
      setStatus(tmpPath, draftId, status);
      const tool = makeMarkMessageSentTool(tmpPath) as AnyObj;

      const result = await tool.execute({ draftId }, toolOpts);

      assert.equal(result.ok, false, `status='${status}' must fail closed`);
      assert.equal(result.error?.kind, "invalid_input", `status='${status}' kind must be invalid_input`);
      assert.equal(
        result.error?.message,
        `Draft ${draftId} cannot be marked sent from status '${status}'; only status 'draft' is sendable.`,
        `message must cite status='${status}'`,
      );
      assert.equal(getStatus(tmpPath, draftId), status, `row must remain '${status}'`);
    }
  });
});

describe("T-RejectWrite — markDraftRejected guarded transition (draft → rejected only)", () => {
  it("T-RejectWrite.1: draft → rejected fires (returns true), row status becomes 'rejected'", () => {
    // Given: a status='draft' row.
    // When:  markDraftRejected(db, id).
    // Then:  returns true and the row is 'rejected'.
    const tmpPath = makeTmpFile(`rejwrite-1-${randomUUID()}.sqlite`);
    const { draftId } = seedLeadDraft(tmpPath);
    const db = openSalesDatabase(tmpPath);

    const changed = markDraftRejected(db, draftId);

    assert.equal(changed, true, "guarded update must report the row changed");
    assert.equal(getStatus(tmpPath, draftId), "rejected", "row must be 'rejected'");
  });

  it("T-RejectWrite.2: an unrelated draft row is untouched by the update", () => {
    // Given: two draft rows for the same lead.
    // When:  markDraftRejected targets only the first.
    // Then:  the second stays 'draft'.
    const tmpPath = makeTmpFile(`rejwrite-2-${randomUUID()}.sqlite`);
    const { draftId, leadId } = seedLeadDraft(tmpPath);
    const db = openSalesDatabase(tmpPath);
    const otherId = insertDraft(db, { leadId, kind: "dm", text: "other draft", createdBy: "llm" });

    markDraftRejected(db, draftId);

    assert.equal(getStatus(tmpPath, otherId), "draft", "unrelated row must remain 'draft'");
    assert.equal(getStatus(tmpPath, draftId), "rejected", "target row must be 'rejected'");
  });

  it("T-RejectWrite.3: sent → rejected does NOT fire (returns false, row stays 'sent') — the guard", () => {
    // Given: a row already 'sent' (e.g. no-note fallback marked it before a later decline).
    // When:  markDraftRejected runs.
    // Then:  returns false and the 'sent' record is preserved (only draft → rejected is legal).
    const tmpPath = makeTmpFile(`rejwrite-3-${randomUUID()}.sqlite`);
    const { draftId } = seedLeadDraft(tmpPath);
    setStatus(tmpPath, draftId, "sent");
    const db = openSalesDatabase(tmpPath);

    const changed = markDraftRejected(db, draftId);

    assert.equal(changed, false, "guarded update must NOT fire on a sent row");
    assert.equal(getStatus(tmpPath, draftId), "sent", "sent row must be untouched");
  });

  it("T-RejectWrite.4: unknown id returns false, no rows changed", () => {
    // Given: a DB with one draft row.
    // When:  markDraftRejected with a random id.
    // Then:  returns false; the existing row is untouched (benign no-op contract).
    const tmpPath = makeTmpFile(`rejwrite-4-${randomUUID()}.sqlite`);
    const { draftId } = seedLeadDraft(tmpPath);
    const db = openSalesDatabase(tmpPath);

    const changed = markDraftRejected(db, randomUUID());

    assert.equal(changed, false, "unknown id must be a no-op returning false");
    assert.equal(getStatus(tmpPath, draftId), "draft", "existing row must be untouched");
  });
});

describe("T-FindDecline — findDraftForDeclinedStep semantic correlation (r2 critic: ownership, not order)", () => {
  it("T-FindDecline.1: step title naming the draft's lead → resolves that draft", () => {
    // Given: one pending connect_note draft for lead 'Wilfred Fixture'.
    // When:  the declined step title is "Send connect note to Wilfred Fixture".
    // Then:  the finder returns exactly that draft's id.
    const tmpPath = makeTmpFile(`find-1-${randomUUID()}.sqlite`);
    const { draftId } = seedLeadDraft(tmpPath, "Wilfred Fixture");
    const db = openSalesDatabase(tmpPath);

    const rec = findDraftForDeclinedStep(db, "Send connect note to Wilfred Fixture");

    assert.deepEqual(rec, { id: draftId }, "the lead-named pending draft must be resolved");
  });

  it("T-FindDecline.2: CROSS-LEAD guard — a pending draft for lead X is NOT resolved by a step about lead Y", () => {
    // Given: a pending draft only for 'Lead Xavier'; the declined step is about 'Lead Yolanda'.
    // When:  the finder runs with Y's step title.
    // Then:  null — declining Y's outbound must never retire X's draft (r2 BLOCKER case 1).
    const tmpPath = makeTmpFile(`find-2-${randomUUID()}.sqlite`);
    seedLeadDraft(tmpPath, "Lead Xavier");
    const db = openSalesDatabase(tmpPath);

    const rec = findDraftForDeclinedStep(db, "Send connect note to Lead Yolanda");

    assert.equal(rec, null, "a step about lead Y must not resolve lead X's draft");
  });

  it("T-FindDecline.3: two pending drafts for the SAME named lead → ambiguous (never guess)", () => {
    // Given: two status='draft' rows for 'Wilfred Fixture' (e.g. old A + revised B).
    // When:  the finder runs with a title naming that lead.
    // Then:  { ambiguous: true } — the caller warns and retires nothing (r2 CONCERN-MR).
    const tmpPath = makeTmpFile(`find-3-${randomUUID()}.sqlite`);
    const { leadId } = seedLeadDraft(tmpPath, "Wilfred Fixture");
    const db = openSalesDatabase(tmpPath);
    insertDraft(db, { leadId, kind: "connect_note", text: "revised second draft", createdBy: "llm" });

    const rec = findDraftForDeclinedStep(db, "Send connect note to Wilfred Fixture");

    assert.deepEqual(rec, { ambiguous: true }, "two plausible pending drafts must be reported ambiguous");
  });

  it("T-FindDecline.4: non-'draft' statuses are excluded — a rejected/sent row is never re-resolved", () => {
    // Given: the lead's only draft is already 'rejected' (or 'sent').
    // When:  the finder runs (the live follow-on: bare-connect decline AFTER the first retirement).
    // Then:  null — no double-retirement, and a sent record is never a decline target.
    const tmpPath = makeTmpFile(`find-4-${randomUUID()}.sqlite`);
    const { draftId } = seedLeadDraft(tmpPath, "Wilfred Fixture");
    const db = openSalesDatabase(tmpPath);
    markDraftRejected(db, draftId);

    const rec = findDraftForDeclinedStep(db, "Send bare connect (no note) to Wilfred Fixture");

    assert.equal(rec, null, "a rejected row must not be resolved again");

    setStatus(tmpPath, draftId, "sent");
    const rec2 = findDraftForDeclinedStep(db, "Send connect note to Wilfred Fixture");
    assert.equal(rec2, null, "a sent row must never be a decline target");
  });

  it("T-FindDecline.5: person_name shorter than 4 chars never matches (substring false-positive guard, e.g. 'Lin' ⊂ 'LinkedIn')", () => {
    // Given: a pending draft for a lead named 'Lin' (3 chars).
    // When:  the step title contains 'LinkedIn' (which contains 'Lin' as a substring).
    // Then:  null — under-retirement is the fail-safe direction; a short name must not
    //        accidentally bind via an unrelated word.
    const tmpPath = makeTmpFile(`find-5-${randomUUID()}.sqlite`);
    seedLeadDraft(tmpPath, "Lin");
    const db = openSalesDatabase(tmpPath);

    const rec = findDraftForDeclinedStep(db, "Send connect note on LinkedIn");

    assert.equal(rec, null, "a <4-char person_name must never substring-match");
  });

  it("T-FindDecline.6: post drafts (lead_id IS NULL) are excluded from decline correlation", () => {
    // Given: a pending kind='post' draft (no lead) and NO lead-bound drafts.
    // When:  the finder runs with any step title.
    // Then:  null — posts have their own recovery path (findPendingPostDraftId) and must not be
    //        retired via lead-name correlation.
    const tmpPath = makeTmpFile(`find-6-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(tmpPath);
    insertDraft(db, { leadId: null, kind: "post", text: "a pending self-broadcast post", createdBy: "llm" });

    const rec = findDraftForDeclinedStep(db, "Publish the drafted post to the feed");

    assert.equal(rec, null, "post drafts must be excluded by the lead JOIN");
  });
});
