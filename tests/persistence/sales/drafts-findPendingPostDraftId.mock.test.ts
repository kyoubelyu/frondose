/**
 * P-POST-PUBLISH-8 Step 5 — Group A (assertions filled)
 * T-DraftLookup.1–5: findPendingPostDraftId helper unit tests.
 * Edge cases EC-A.1–EC-A.3 appended after Step-2 scaffolds.
 *
 * Gate: SC-1, SC-5, SC-6
 *
 * Helper under test: `findPendingPostDraftId(db)` (added to
 * src/persistence/sales/drafts.ts at Step 4). Returns:
 *   { id: string }      — exactly one pending post draft
 *   { ambiguous: true } — two or more pending post drafts (≥2 rows)
 *   null                — zero qualifying rows
 *
 * DB setup: `openSalesDatabase(tmpPath)` runs all migrations automatically
 * (schema v1→v4), so kind='post' rows are valid after applyV2. DO NOT create
 * a raw CREATE TABLE — it will diverge from the migrated schema.
 *
 * created_at is INTEGER (epoch ms) in the migrated schema. T-DraftLookup.3
 * uses distinct integer timestamps to verify ORDER BY created_at DESC ranking.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: runtime resolution
type AnyObj = Record<string, any>;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeTmpPath(): string {
  return join(tmpdir(), `find-pending-post-draft-${randomUUID()}.sqlite`);
}

/**
 * Open (and auto-migrate) a fresh sales DB via the same path used in
 * tests/tools/sales/*.mock.test.ts — openSalesDatabase runs runSalesMigrations,
 * which includes applyV2 adding kind='post' to the CHECK constraint.
 */
async function openDb(tmpPath: string): Promise<AnyObj> {
  const dbMod = await import("../../../src/persistence/salesDb.js");
  return (dbMod as AnyObj).openSalesDatabase(tmpPath);
}

/**
 * Insert a pending post draft (kind='post', status='draft', lead_id IS NULL)
 * and return its id. `createdAt` lets callers control the epoch timestamp
 * so ORDER BY created_at DESC ordering is deterministic in T-DraftLookup.3.
 */
async function insertPendingPostDraft(db: AnyObj, opts: { text?: string; createdAt?: number } = {}): Promise<string> {
  // Use insertDraft from the barrel (it sets status='draft' and honors lead_id nullable).
  // insertDraft generates its own id internally, so we re-query the most recent row to
  // retrieve it. We then overwrite created_at when the caller needs a specific timestamp.
  const dbMod = await import("../../../src/persistence/salesDb.js");
  (dbMod as AnyObj).insertDraft(db, {
    leadId: null,
    kind: "post",
    text: opts.text ?? "scaffold post body",
    createdBy: "llm",
  });
  const row = db
    .prepare(
      "SELECT id FROM message_drafts WHERE kind = 'post' AND status = 'draft' AND lead_id IS NULL ORDER BY created_at DESC LIMIT 1",
    )
    .get() as { id: string } | undefined;
  assert.ok(row !== undefined, "insertPendingPostDraft: row not found after insert");
  if (opts.createdAt !== undefined) {
    db.prepare("UPDATE message_drafts SET created_at = ? WHERE id = ?").run(opts.createdAt, row.id);
  }
  return row.id;
}

/**
 * Resolve `findPendingPostDraftId` from the production module.
 */
async function getHelper(): Promise<((db: AnyObj) => unknown) | null> {
  const mod = await import("../../../src/persistence/sales/drafts.js").catch(() => null);
  if (!mod) return null;
  const fn = (mod as AnyObj).findPendingPostDraftId;
  return typeof fn === "function" ? (fn as (db: AnyObj) => unknown) : null;
}

// ---------------------------------------------------------------------------
// Group A — findPendingPostDraftId
// ---------------------------------------------------------------------------

describe("findPendingPostDraftId — pending post draft lookup helper (SC-1, SC-5, SC-6)", () => {
  // ─── T-DraftLookup.1 ─────────────────────────────────────────────────────
  it("T-DraftLookup.1: when message_drafts has exactly one kind='post' status='draft' lead_id IS NULL row, findPendingPostDraftId returns { id: <that row's id> }", async () => {
    // Given: sales DB (migrated) with exactly one pending post draft inserted.
    // When:  findPendingPostDraftId(db) is called.
    // Then:  returns { id: <the draft's id> } — single match, no ambiguity.
    const helper = await getHelper();
    assert.ok(
      helper !== null,
      "T-DraftLookup.1: findPendingPostDraftId must be exported from src/persistence/sales/drafts.ts",
    );

    const tmpPath = makeTmpPath();
    const db = await openDb(tmpPath);
    const insertedId = await insertPendingPostDraft(db);

    const result = helper(db) as { id: string } | { ambiguous: true } | null;

    assert.ok(result !== null, "T-DraftLookup.1: expected { id } but got null");
    assert.ok(!("ambiguous" in (result as object)), "T-DraftLookup.1: expected { id } but got { ambiguous:true }");
    assert.equal(
      (result as { id: string }).id,
      insertedId,
      "T-DraftLookup.1: returned id must match the inserted draft id",
    );
  });

  // ─── T-DraftLookup.2 ─────────────────────────────────────────────────────
  it("T-DraftLookup.2: when message_drafts has no pending post draft (empty, or only non-post/non-draft/lead-bound rows), findPendingPostDraftId returns null", async () => {
    // Given: empty sales DB (migrated); OR DB containing only sent/connect/dm drafts.
    // When:  findPendingPostDraftId(db) is called.
    // Then:  returns null — no recovery possible (SC-5: route falls through to LLM).
    const helper = await getHelper();
    assert.ok(helper !== null, "T-DraftLookup.2: findPendingPostDraftId must be exported");

    const tmpPath = makeTmpPath();
    const db = await openDb(tmpPath);
    // No rows inserted — empty table

    const result = helper(db);

    assert.equal(result, null, "T-DraftLookup.2: empty DB must return null");
  });

  // ─── T-DraftLookup.3 ─────────────────────────────────────────────────────
  it("T-DraftLookup.3: when message_drafts has two pending post drafts (kind='post' status='draft' lead_id IS NULL), findPendingPostDraftId returns { ambiguous: true } — NOT the newest", async () => {
    // Given: two rows with kind='post' status='draft' lead_id IS NULL at distinct
    //        integer created_at timestamps (older=T1, newer=T2 > T1).
    // When:  findPendingPostDraftId(db) is called.
    // Then:  returns { ambiguous: true } (NOT { id: T2.id } — refusing is safer). SC-6.
    const helper = await getHelper();
    assert.ok(helper !== null, "T-DraftLookup.3: findPendingPostDraftId must be exported");

    const tmpPath = makeTmpPath();
    const db = await openDb(tmpPath);
    await insertPendingPostDraft(db, { text: "older post", createdAt: 1000000 });
    await insertPendingPostDraft(db, { text: "newer post", createdAt: 2000000 });

    const result = helper(db) as { id: string } | { ambiguous: true } | null;

    assert.ok(result !== null, "T-DraftLookup.3: expected { ambiguous:true } but got null");
    assert.ok("ambiguous" in (result as object), "T-DraftLookup.3: expected { ambiguous:true } but got { id }");
    assert.equal((result as { ambiguous: true }).ambiguous, true, "T-DraftLookup.3: ambiguous flag must be true");
  });

  // ─── T-DraftLookup.4 ─────────────────────────────────────────────────────
  it("T-DraftLookup.4: filters on lead_id IS NULL — a kind='post' status='draft' row with a non-null lead_id is invisible to the helper", async () => {
    // Given: one 'post'/'draft' row with lead_id='lead_xyz' (FK-off raw insert)
    //        AND one 'post'/'draft' row with lead_id IS NULL.
    // When:  findPendingPostDraftId(db) is called.
    // Then:  returns { id } of only the lead-null row (the lead-bound row is filtered).
    //        Pins the schema invariant: only genuinely self-anchored drafts qualify.
    const helper = await getHelper();
    assert.ok(helper !== null, "T-DraftLookup.4: findPendingPostDraftId must be exported");

    const tmpPath = makeTmpPath();
    const db = await openDb(tmpPath);

    // Insert a lead-bound post draft using raw SQL (FK disabled) — 'post'/'draft' with lead_id set
    db.pragma("foreign_keys = OFF");
    const leadBoundId = randomUUID();
    db.prepare(
      "INSERT INTO message_drafts (id, lead_id, kind, text, status, created_by, evidence, created_at) VALUES (?, ?, 'post', 'lead-bound', 'draft', 'llm', NULL, ?)",
    ).run(leadBoundId, "lead_xyz", Date.now() - 1000);
    db.pragma("foreign_keys = ON");

    // Insert the genuine self-anchored post draft (lead_id IS NULL)
    const nullLeadId = await insertPendingPostDraft(db, { text: "self-anchored post" });

    const result = helper(db) as { id: string } | { ambiguous: true } | null;

    assert.ok(result !== null, "T-DraftLookup.4: expected { id } but got null");
    assert.ok(!("ambiguous" in (result as object)), "T-DraftLookup.4: expected { id } not { ambiguous:true }");
    assert.equal(
      (result as { id: string }).id,
      nullLeadId,
      "T-DraftLookup.4: must return the lead_id IS NULL row, not the lead-bound row",
    );
    assert.notEqual((result as { id: string }).id, leadBoundId, "T-DraftLookup.4: must NOT return the lead-bound row");
  });

  // ─── T-DraftLookup.5 ─────────────────────────────────────────────────────
  it("T-DraftLookup.5: filters out non-draft statuses and non-post kinds — kind='post' status='sent' and kind='dm' status='draft' lead_id=null are both invisible", async () => {
    // Given: one kind='post' status='sent' lead_id IS NULL row (already sent)
    //        AND one kind='dm' status='draft' lead_id IS NULL row (wrong kind).
    // When:  findPendingPostDraftId(db) is called.
    // Then:  returns null — the WHERE clause (kind='post' AND status='draft' AND lead_id IS NULL)
    //        excludes both rows.
    const helper = await getHelper();
    assert.ok(helper !== null, "T-DraftLookup.5: findPendingPostDraftId must be exported");

    const tmpPath = makeTmpPath();
    const db = await openDb(tmpPath);

    // Insert a 'post'/'sent' row (already sent, should be excluded)
    const sentId = randomUUID();
    db.prepare(
      "INSERT INTO message_drafts (id, lead_id, kind, text, status, created_by, evidence, created_at) VALUES (?, NULL, 'post', 'sent post', 'sent', 'llm', NULL, ?)",
    ).run(sentId, Date.now() - 2000);

    // Insert a 'dm'/'draft' row (wrong kind, should be excluded)
    const dmId = randomUUID();
    db.prepare(
      "INSERT INTO message_drafts (id, lead_id, kind, text, status, created_by, evidence, created_at) VALUES (?, NULL, 'dm', 'dm draft', 'draft', 'llm', NULL, ?)",
    ).run(dmId, Date.now() - 1000);

    const result = helper(db);

    assert.equal(result, null, "T-DraftLookup.5: neither 'post'/'sent' nor 'dm'/'draft' qualify — must return null");
  });

  // ─── EC-A.1 — CJK post step title recovery works via isPostStep heuristic ─
  // (edge case added at Step 5 to harden SC-1: ensure the DB helper itself
  // is kind/status/lead_id agnostic — the CJK-title concern lives in approval-gate.ts,
  // not in the helper. A row inserted by the agent with a CJK-titled step is still
  // a kind='post' status='draft' lead_id IS NULL row in the DB.)
  it("EC-A.1: a draft inserted under a CJK-post-step (发布/発信 title) is still kind='post' status='draft' lead_id IS NULL — findPendingPostDraftId returns { id }", async () => {
    // Given: one kind='post' status='draft' lead_id IS NULL row (text contains CJK content).
    // When:  findPendingPostDraftId(db) is called.
    // Then:  returns { id } — the helper is title-agnostic; it queries only kind/status/lead_id.
    const helper = await getHelper();
    assert.ok(helper !== null, "EC-A.1: findPendingPostDraftId must be exported");

    const tmpPath = makeTmpPath();
    const db = await openDb(tmpPath);
    // The draft row for a 发布 step is indistinguishable from any other post draft in the DB
    const cjkDraftId = await insertPendingPostDraft(db, { text: "发布新动态：产品上线啦！" });

    const result = helper(db) as { id: string } | { ambiguous: true } | null;

    assert.ok(result !== null, "EC-A.1: expected { id } but got null");
    assert.ok(!("ambiguous" in (result as object)), "EC-A.1: expected { id } not { ambiguous:true }");
    assert.equal((result as { id: string }).id, cjkDraftId, "EC-A.1: id must match the CJK-content post draft");
  });

  // ─── EC-A.2 — approved/revised statuses excluded ────────────────────────
  it("EC-A.2: a kind='post' status='approved' row and a kind='post' status='revised' row are both excluded — findPendingPostDraftId returns null when only those rows exist", async () => {
    // Given: one 'post'/'approved' row + one 'post'/'revised' row, no 'post'/'draft' row.
    // When:  findPendingPostDraftId(db) is called.
    // Then:  returns null — only status='draft' qualifies.
    const helper = await getHelper();
    assert.ok(helper !== null, "EC-A.2: findPendingPostDraftId must be exported");

    const tmpPath = makeTmpPath();
    const db = await openDb(tmpPath);

    db.prepare(
      "INSERT INTO message_drafts (id, lead_id, kind, text, status, created_by, evidence, created_at) VALUES (?, NULL, 'post', 'approved post', 'approved', 'llm', NULL, ?)",
    ).run(randomUUID(), Date.now() - 3000);

    db.prepare(
      "INSERT INTO message_drafts (id, lead_id, kind, text, status, created_by, evidence, created_at) VALUES (?, NULL, 'post', 'revised post', 'revised', 'llm', NULL, ?)",
    ).run(randomUUID(), Date.now() - 2000);

    const result = helper(db);
    assert.equal(result, null, "EC-A.2: approved/revised post rows must not qualify — return null");
  });

  // ─── EC-A.3 — ambiguity warning NOT triggered on single-row happy path ────
  // (The helper itself is a pure DB query — it has no side effects. The commit-warning
  // is emitted in approve() in approval-gate.ts, NOT in this helper. This test pins
  // that the helper returns { id }, never { ambiguous:true }, when exactly one row exists.)
  it("EC-A.3: when exactly one pending post draft exists, findPendingPostDraftId does NOT return { ambiguous:true } — the ambiguity safety-net does not fire on the happy path", async () => {
    // Given: exactly one kind='post' status='draft' lead_id IS NULL row.
    // When:  findPendingPostDraftId(db) is called.
    // Then:  returns { id } — NOT { ambiguous:true }. The 1-row happy path is unambiguous.
    const helper = await getHelper();
    assert.ok(helper !== null, "EC-A.3: findPendingPostDraftId must be exported");

    const tmpPath = makeTmpPath();
    const db = await openDb(tmpPath);
    await insertPendingPostDraft(db, { text: "single post draft" });

    const result = helper(db) as { id: string } | { ambiguous: true } | null;

    assert.ok(result !== null, "EC-A.3: expected { id } but got null");
    assert.ok(
      !("ambiguous" in (result as object)),
      "EC-A.3: single pending post draft must NOT return { ambiguous:true }",
    );
  });
});
