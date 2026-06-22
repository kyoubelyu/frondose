/**
 * P-POST Step 3a — post-aware mark_message_sent closeout (BLOCKER-2 fix).
 *
 * Gate: G-POST.Closeout
 *
 * Tests T-Post.Closeout.1–5 assert that mark_message_sent handles
 * kind='post' drafts (lead_id IS NULL) without calling getLead or
 * appendTimelineEvent, and that connect/dm/follow_up drafts still require
 * a lead (regression guard).
 *
 * These tests FAIL pre-Step-4 because markMessageSent.ts unconditionally
 * calls getLead(db, draft.leadId) and returns runtime_error when no lead
 * exists — which is always the case for a kind='post' draft.
 *
 * Uses in-memory better-sqlite3 via openSalesDatabase(tmpPath) following
 * the pattern in tests/tools/sales/endAutoRun.mock.test.ts.
 *
 * Run:
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/sales/markMessageSentPost.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: runtime resolution of DB + tool
type AnyFn = (...args: any[]) => any;
// biome-ignore lint/suspicious/noExplicitAny: runtime resolution
type AnyObj = Record<string, any>;

function makeTmpPath(): string {
  return join(tmpdir(), `mark-message-sent-post-${randomUUID()}.sqlite`);
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function openDb(tmpPath: string): Promise<AnyObj> {
  const dbMod = await import("../../../src/persistence/salesDb.js");
  return (dbMod as AnyObj).openSalesDatabase(tmpPath);
}

/** Insert a post-kind draft (no leadId) and return its draftId. */
async function insertPostDraft(tmpPath: string, text = "hello from Frondose smoke test"): Promise<string> {
  const dbMod = await import("../../../src/persistence/salesDb.js");
  const db = (dbMod as AnyObj).openSalesDatabase(tmpPath);
  return (dbMod as AnyObj).insertDraft(db, {
    leadId: null,
    kind: "post",
    text,
    createdBy: "llm",
  });
}

/** Insert a dm-kind draft WITH a lead and return {draftId, leadId}. */
async function insertDmDraftWithLead(tmpPath: string): Promise<{ draftId: string; leadId: string }> {
  const dbMod = await import("../../../src/persistence/salesDb.js");
  const db = (dbMod as AnyObj).openSalesDatabase(tmpPath);
  // Insert a minimal candidate + lead so getLead succeeds.
  const candidateId = randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO raw_candidates (id, person_name, profile_url, source, observed_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(candidateId, "Test Lead", "https://www.linkedin.com/in/test-lead-" + candidateId, "search", now, now);
  const leadId = randomUUID();
  db.prepare(
    "INSERT INTO leads (id, candidate_id, person_name, profile_url, stage, owner_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(leadId, candidateId, "Test Lead", "https://www.linkedin.com/in/test-lead-" + candidateId, "qualified", "manual", now, now);
  const draftId = (dbMod as AnyObj).insertDraft(db, {
    leadId,
    kind: "dm",
    text: "test dm body",
    createdBy: "llm",
  });
  return { draftId, leadId };
}

/** Insert a draft directly via raw SQL with FK enforcement temporarily OFF.
 *  Used for T-Post.Closeout.5 to create a kind='post' draft that has a non-null lead_id
 *  (a normally-impossible state that the post short-circuit must handle). */
async function insertDraftRawNoFk(
  tmpPath: string,
  input: { leadId: string | null; kind: string; text: string },
): Promise<string> {
  const dbMod = await import("../../../src/persistence/salesDb.js");
  const db = (dbMod as AnyObj).openSalesDatabase(tmpPath);
  const id = randomUUID();
  // Disable FK enforcement only for this insert so we can inject the malformed row.
  db.pragma("foreign_keys = OFF");
  try {
    db.prepare(
      "INSERT INTO message_drafts (id, lead_id, kind, text, status, created_by, evidence, created_at) VALUES (?, ?, ?, ?, 'draft', 'llm', NULL, ?)",
    ).run(id, input.leadId, input.kind, input.text, Date.now());
  } finally {
    db.pragma("foreign_keys = ON");
  }
  return id;
}

// ─── Tool factory ─────────────────────────────────────────────────────────────

async function makeMarkMessageSent(salesDbPath: string): Promise<AnyObj> {
  const mod = await import("../../../src/tools/sales/markMessageSent.js").catch(() => null);
  const factory: AnyFn | null = (mod as AnyObj | null)?.makeMarkMessageSentTool ?? null;
  assert.ok(factory !== null, "makeMarkMessageSentTool must be exported from markMessageSent.ts");
  return (factory as AnyFn)(salesDbPath);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("T-Post.Closeout — post-aware mark_message_sent closeout (G-POST.Closeout)", () => {
  // ─── T-Post.Closeout.1 ──────────────────────────────────────────────────────
  it(
    "T-Post.Closeout.1: save_message_draft(kind:'post') → mark_message_sent(draftId) succeeds without a lead — ok=true, leadId:null, status='sent'",
    async () => {
      // Given: in-memory sales DB with NO leads inserted;
      //        a post draft inserted via insertDraft({kind:'post', leadId:null}).
      // When:  mark_message_sent({draftId}) is called.
      // Then:  envelope ok=true with payload {draftId, leadId:null};
      //        message_drafts.status='sent' for that draft;
      //        getLead was never called (the post branch short-circuits before getLead).
      //        Pre-Step-4: mark_message_sent calls getLead(db, null) → fails with runtime_error.
      const tmpPath = makeTmpPath();
      const draftId = await insertPostDraft(tmpPath);
      const tool = await makeMarkMessageSent(tmpPath);

      const result = await tool.execute({ draftId });

      // Pre-Step-4: result.ok === false (runtime_error "Lead null missing for draft …")
      // Post-Step-4: result.ok === true, data.leadId === null
      assert.ok(
        result.ok === true,
        `T-Post.Closeout.1: mark_message_sent for a post draft must succeed; got: ${JSON.stringify(result)}`,
      );
      assert.equal(
        (result as AnyObj).data?.leadId,
        null,
        "T-Post.Closeout.1: returned leadId must be null for a post draft",
      );
      assert.equal(
        (result as AnyObj).data?.draftId,
        draftId,
        "T-Post.Closeout.1: returned draftId must match",
      );

      // Verify DB state
      const db = await openDb(tmpPath);
      const row = db.prepare("SELECT status FROM message_drafts WHERE id = ?").get(draftId) as
        | { status: string }
        | undefined;
      assert.ok(row !== undefined, "T-Post.Closeout.1: draft row must exist");
      assert.equal(
        row?.status,
        "sent",
        "T-Post.Closeout.1: message_drafts.status must be 'sent' after mark_message_sent",
      );
    },
  );

  // ─── T-Post.Closeout.2 ──────────────────────────────────────────────────────
  it(
    "T-Post.Closeout.2: post-kind mark_message_sent does NOT append a lead_timeline event",
    async () => {
      // Given: same setup as T-Post.Closeout.1 (in-memory DB, post draft, no leads).
      // When:  mark_message_sent({draftId}) returns ok.
      // Then:  SELECT COUNT(*) FROM lead_timeline === 0 (no message_sent event row).
      //        Posts are self-anchored — no lead timeline append.
      const tmpPath = makeTmpPath();
      const draftId = await insertPostDraft(tmpPath);
      const tool = await makeMarkMessageSent(tmpPath);

      await tool.execute({ draftId });

      const db = await openDb(tmpPath);
      const countResult = db
        .prepare("SELECT COUNT(*) AS n FROM lead_timeline")
        .get() as { n: number };
      assert.equal(
        countResult.n,
        0,
        "T-Post.Closeout.2: lead_timeline must have 0 rows after a post-draft closeout (posts are self-anchored)",
      );
    },
  );

  // ─── T-Post.Closeout.3 ──────────────────────────────────────────────────────
  it(
    "T-Post.Closeout.3: connect_note/dm/follow_up paths STILL require a lead — regression guard",
    async () => {
      // Given: a dm draft bound to a lead that is then DELETED from the DB
      //        (simulating a dangling lead_id — the FK constraint only prevents inserting a
      //        non-existent lead_id; we delete the lead AFTER the draft is inserted to get a
      //        real getDraft success followed by a getLead miss).
      // When:  mark_message_sent({draftId}) is called after the lead is deleted.
      // Then:  envelope ok=false, reason='runtime_error',
      //        message contains "<leadId> missing for draft".
      //        Regression guard: the post branch did NOT cannibalize the existing closeout path.
      const tmpPath = makeTmpPath();
      const { draftId, leadId } = await insertDmDraftWithLead(tmpPath);

      // Delete the lead AFTER the draft is inserted (FK allows this in SQLite with pragma OFF,
      // or by using pragma foreign_keys = OFF around the delete).
      const dbMod = await import("../../../src/persistence/salesDb.js");
      const db = (dbMod as AnyObj).openSalesDatabase(tmpPath);
      db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM leads WHERE id = ?").run(leadId);
      db.pragma("foreign_keys = ON");

      const tool = await makeMarkMessageSent(tmpPath);
      const result = await tool.execute({ draftId });

      assert.ok(
        result.ok === false,
        `T-Post.Closeout.3: dm draft with deleted lead must fail; got: ${JSON.stringify(result)}`,
      );
      const reason = (result as AnyObj).error?.kind ?? (result as AnyObj).reason;
      assert.equal(reason, "runtime_error", "T-Post.Closeout.3: reason must be runtime_error");
      const message = (result as AnyObj).error?.message ?? "";
      assert.ok(
        message.includes(`Lead ${leadId} missing for draft`),
        `T-Post.Closeout.3: error message must contain "Lead ${leadId} missing for draft"; got: ${message}`,
      );
    },
  );

  // ─── T-Post.Closeout.4 ──────────────────────────────────────────────────────
  it(
    "T-Post.Closeout.4: post-kind closeout still rejects double-send — already-sent guard fires BEFORE kind branch",
    async () => {
      // Given: a post draft that has already been marked sent (via T-Post.Closeout.1 flow).
      // When:  mark_message_sent({draftId}) is called a SECOND time.
      // Then:  envelope ok=false, reason='invalid_input',
      //        message contains "Draft <draftId> is already sent".
      //        The already-sent guard (markMessageSent.ts:24-26) runs BEFORE the kind branch.
      const tmpPath = makeTmpPath();
      const draftId = await insertPostDraft(tmpPath);
      const tool = await makeMarkMessageSent(tmpPath);

      // First call (should succeed post-Step-4)
      const first = await tool.execute({ draftId });
      // If pre-Step-4 the first call fails, we can still attempt the second to ensure the
      // already-sent guard fires; but we only assert the second call's behavior here.
      // For pre-Step-4 this test may fail at the second assert if first call returned error.

      // Second call: must be rejected
      const second = await tool.execute({ draftId });

      assert.ok(
        second.ok === false,
        `T-Post.Closeout.4: second mark_message_sent call must be rejected; got: ${JSON.stringify(second)}`,
      );
      const reason = (second as AnyObj).error?.kind ?? (second as AnyObj).reason;
      // Pre-Step-4: first call returns runtime_error (no lead), second call ALSO sees draft.status='draft'
      // (not 'sent') → second call hits getLead path again → runtime_error again.
      // Post-Step-4: first call marks status='sent'; second call returns invalid_input "already sent".
      // This assertion enforces post-Step-4 behavior:
      assert.equal(
        reason,
        "invalid_input",
        `T-Post.Closeout.4: second call must return invalid_input (already sent), not ${reason}`,
      );
      const message = (second as AnyObj).error?.message ?? "";
      assert.ok(
        message.includes(`Draft ${draftId} is already sent`),
        `T-Post.Closeout.4: error message must say "Draft ${draftId} is already sent"; got: ${message}`,
      );
    },
  );

  // ─── T-Post.Closeout.5 ──────────────────────────────────────────────────────
  it(
    "T-Post.Closeout.5: malformed post-kind draft (kind=post but lead_id non-null) FALLS THROUGH to existing path",
    async () => {
      // Given: a draft inserted with kind='post' AND a non-null lead_id (unsupported state;
      //        save_message_draft guarantees leadId:null for kind='post', but defense-in-depth);
      //        AND the lead exists matching that lead_id.
      //        The raw insert uses FK enforcement OFF to place the malformed row.
      // When:  mark_message_sent({draftId}) runs.
      // Then:  envelope ok=true; the existing markDraftSent + appendTimelineEvent path runs
      //        (returns {draftId, leadId:<the-lead-id>}).
      //        The post short-circuit branch requires BOTH kind==='post' AND lead_id IS NULL.
      //        A malformed post-with-lead must NOT crash and must NOT skip the timeline write.
      const tmpPath = makeTmpPath();

      // Insert a real lead first (needed for the existing path to succeed via getLead).
      const { leadId } = await insertDmDraftWithLead(tmpPath);
      // Insert a malformed 'post' draft that has a lead_id using FK-OFF raw insert.
      const draftId = await insertDraftRawNoFk(tmpPath, {
        leadId,
        kind: "post",
        text: "malformed post draft with a lead_id",
      });
      const tool = await makeMarkMessageSent(tmpPath);

      const result = await tool.execute({ draftId });

      // Post-Step-4: the kind==='post' && lead_id IS NULL branch does NOT fire (lead_id is non-null)
      // → falls through to getLead → lead exists → markDraftSent + appendTimelineEvent → ok=true.
      assert.ok(
        result.ok === true,
        `T-Post.Closeout.5: malformed post draft (kind=post, lead_id non-null) must succeed via existing path; got: ${JSON.stringify(result)}`,
      );
      assert.equal(
        (result as AnyObj).data?.leadId,
        leadId,
        "T-Post.Closeout.5: returned leadId must match the lead_id (existing path executed, not the post short-circuit)",
      );
      assert.equal(
        (result as AnyObj).data?.draftId,
        draftId,
        "T-Post.Closeout.5: returned draftId must match",
      );

      // Verify lead_timeline has 1 row (appendTimelineEvent fired).
      const db = await openDb(tmpPath);
      const countResult = db
        .prepare("SELECT COUNT(*) AS n FROM lead_timeline")
        .get() as { n: number };
      assert.equal(
        countResult.n,
        1,
        "T-Post.Closeout.5: lead_timeline must have 1 row (existing path ran appendTimelineEvent for malformed post draft)",
      );
    },
  );
});
