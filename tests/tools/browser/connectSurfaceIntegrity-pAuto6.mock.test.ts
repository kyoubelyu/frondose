/**
 * P-AUTO-6 Step 3 scaffold → Step 5 assertions filled.
 *
 * Layers A + B:
 *   A. personNameFromInviteLabel parser (pure, from outboundGuard.ts) — T-AUTO6.7
 *   B. connectNoteRequiredForLabel seam (exported from serve.ts) against a seeded
 *      temp sales DB — T-AUTO6.1, .2, .3, .3b, .3c, .4, .5, .6, .9
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/tools/browser/connectSurfaceIntegrity-pAuto6.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { personNameFromInviteLabel } from "../../../src/tools/browser/outboundGuard.js";
import { connectNoteRequiredForLabel } from "../../../src/cli/subcommands/serve.js";

// Disable pacing noise
process.env.MAI_PACE_MIN_MS = "0";
process.env.MAI_PACE_MAX_MS = "0";

// ─────────────────────────────────────────────────────────────────────────────
// Layer A — personNameFromInviteLabel parser (T-AUTO6.7)
// ─────────────────────────────────────────────────────────────────────────────

describe("G-AUTO6.Parser — personNameFromInviteLabel normalizer (T-AUTO6.7)", () => {
  // ─── T-AUTO6.7a — baseline: plain two-word name ───────────────────────────
  it("T-AUTO6.7a: 'Invite Onder Temel to connect' → 'Onder Temel'", () => {
    // Given/When/Then: a plain label returns the bare name.
    assert.equal(personNameFromInviteLabel("Invite Onder Temel to connect"), "Onder Temel");
  });

  // ─── T-AUTO6.7b — creds clause (comma-separated, letters) ────────────────
  it("T-AUTO6.7b: 'Invite Jane Doe, PhD to connect' → 'Jane Doe' (creds clause stripped)", () => {
    // Given/When/Then: everything from the first comma onward is dropped.
    assert.equal(personNameFromInviteLabel("Invite Jane Doe, PhD to connect"), "Jane Doe");
  });

  // ─── T-AUTO6.7c — creds clause containing a degree token ─────────────────
  it("T-AUTO6.7c: 'Invite Jane Doe, 1st VP to connect' → 'Jane Doe' (1st inside creds tail NOT eaten by degree-strip)", () => {
    // Given/When/Then: the comma-creds strip removes ', 1st VP' before the end-anchored degree can fire.
    assert.equal(personNameFromInviteLabel("Invite Jane Doe, 1st VP to connect"), "Jane Doe");
  });

  // ─── T-AUTO6.7d — trailing parenthetical (pronouns) ─────────────────────
  it("T-AUTO6.7d: 'Invite Jane Doe (She/Her) to connect' → 'Jane Doe' (parenthetical stripped)", () => {
    assert.equal(personNameFromInviteLabel("Invite Jane Doe (She/Her) to connect"), "Jane Doe");
  });

  // ─── T-AUTO6.7e — end-anchored degree token '1st' (no comma) ────────────
  it("T-AUTO6.7e: 'Invite Jane Doe 1st to connect' → 'Jane Doe' (end-anchored degree stripped)", () => {
    assert.equal(personNameFromInviteLabel("Invite Jane Doe 1st to connect"), "Jane Doe");
  });

  // ─── T-AUTO6.7f — end-anchored degree token '2nd' (critic round-2 locked case) ─
  it("T-AUTO6.7f: 'Invite Jane Doe 2nd to connect' → 'Jane Doe' (2nd alternation in degree regex)", () => {
    assert.equal(personNameFromInviteLabel("Invite Jane Doe 2nd to connect"), "Jane Doe");
  });

  // ─── T-AUTO6.7g — glyph strip (verification checkmark badge) ────────────
  it("T-AUTO6.7g: 'Invite Jane Doe ✓ to connect' → 'Jane Doe' (non-letter glyph stripped)", () => {
    assert.equal(personNameFromInviteLabel("Invite Jane Doe ✓ to connect"), "Jane Doe");
  });

  // ─── T-AUTO6.7h — NFD-to-NFC accent equivalence ─────────────────────────
  it("T-AUTO6.7h: NFD-decomposed 'José' label normalizes to NFC form 'José' after parse", () => {
    // Given: an NFD-decomposed accented label. Then: the result is NFC-normalized.
    const nfdLabel = "Invite José Díaz to connect".normalize("NFD");
    const result = personNameFromInviteLabel(nfdLabel);
    assert.ok(result !== null, "must return a name, not null");
    assert.equal(result, result.normalize("NFC"), "result must already be NFC-normalized");
    assert.equal(result, "José Díaz".normalize("NFC"));
  });

  // ─── T-AUTO6.7i — double-space collapse ──────────────────────────────────
  it("T-AUTO6.7i: label with double spaces between name tokens → collapsed to single space", () => {
    assert.equal(personNameFromInviteLabel("Invite Jane  Doe to connect"), "Jane Doe");
  });

  // ─── T-AUTO6.7j — case-insensitive 'Invite'/'to connect' matching ────────
  it("T-AUTO6.7j: 'invite Jane Doe TO CONNECT' (mixed case) → 'Jane Doe' (case-insensitive regex)", () => {
    assert.equal(personNameFromInviteLabel("invite Jane Doe TO CONNECT"), "Jane Doe");
  });

  // ─── T-AUTO6.7k/l/m — non-invite labels → null ───────────────────────────
  it("T-AUTO6.7k: 'Connect' → null (not an instant-invite label)", () => {
    assert.equal(personNameFromInviteLabel("Connect"), null);
  });

  it("T-AUTO6.7l: 'Send invitation' → null (final-send label, not instant-invite)", () => {
    assert.equal(personNameFromInviteLabel("Send invitation"), null);
  });

  it("T-AUTO6.7m: 'Message' → null (message label, unrelated to connect)", () => {
    assert.equal(personNameFromInviteLabel("Message"), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer B — connectNoteRequiredForLabel seam (T-AUTO6.1-6, .9)
// ─────────────────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: runtime DB rows
type AnyDB = any;

async function openTempDb(suffix: string): Promise<AnyDB> {
  const { openSalesDatabase } = (await import("../../../src/persistence/salesDb.js")) as {
    openSalesDatabase: (path: string) => AnyDB;
  };
  return openSalesDatabase(join(tmpdir(), `auto6-${suffix}-${randomUUID()}.sqlite`));
}

/** Insert a raw_candidates row with the given person_name; return candidateId. */
function seedCandidate(db: AnyDB, personName: string): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO raw_candidates
      (id, person_name, profile_url, account_id, source, observed_at, last_seen_at, status, evidence_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, personName, `https://www.linkedin.com/in/${id.slice(0, 8)}/`, null, "search", now, now, "new", "auto6 test");
  return id;
}

/** Insert a leads row for the given candidateId; return leadId. */
function seedLead(db: AnyDB, candidateId: string): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO leads
      (id, candidate_id, account_id, person_name, profile_url, stage,
       total_score, confidence, one_line_pain_chain, next_action,
       next_action_due_at, owner_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, candidateId, null, "Fixture Lead", `https://www.linkedin.com/in/${id.slice(0, 8)}/`,
    "qualified", 80, 0.85, "test", null, null, "manual", now, now);
  return id;
}

/** Insert a message_drafts row; defaults to kind='connect_note', status='draft'. */
function seedDraftRow(db: AnyDB, leadId: string, opts?: { kind?: string; status?: string }): string {
  const id = randomUUID();
  const now = Date.now();
  const kind = opts?.kind ?? "connect_note";
  const status = opts?.status ?? "draft";
  db.prepare(`
    INSERT INTO message_drafts (id, lead_id, kind, text, status, created_by, evidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, leadId, kind, "Hi, personalized note here.", status, "llm", null, now);
  return id;
}

describe("G-AUTO6.Seam — connectNoteRequiredForLabel DB seam (T-AUTO6.1-6, .9)", () => {
  // ─── T-AUTO6.1 — core block: draft(status='draft') exists ────────────────
  it("T-AUTO6.1: connect_note draft(status='draft') for 'Onder Temel' → block:true on surface='search'", async () => {
    const db = await openTempDb("t1");
    const candidateId = seedCandidate(db, "Onder Temel");
    const leadId = seedLead(db, candidateId);
    seedDraftRow(db, leadId, { kind: "connect_note", status: "draft" });
    const result = connectNoteRequiredForLabel(db, "Invite Onder Temel to connect", "search");
    assert.equal(result.block, true, "must block when a draft connect_note exists");
    assert.ok(result.reason && result.reason.length > 0, "must include a non-empty reason string");
  });

  // ─── T-AUTO6.2 — deliberate note-less invite allowed (no draft) ──────────
  it("T-AUTO6.2: NO connect_note draft for 'Jane Roe' → block:false (note-less invite proceeds)", async () => {
    const db = await openTempDb("t2");
    const result = connectNoteRequiredForLabel(db, "Invite Jane Roe to connect", "search");
    assert.equal(result.block, false, "must not block when no candidate/draft exists");
  });

  it("T-AUTO6.2b: candidate exists but no lead → block:false", async () => {
    const db = await openTempDb("t2b");
    seedCandidate(db, "Jane Roe");
    const result = connectNoteRequiredForLabel(db, "Invite Jane Roe to connect", "search");
    assert.equal(result.block, false, "no lead → must not block");
  });

  it("T-AUTO6.2c: lead exists but no connect_note draft → block:false", async () => {
    const db = await openTempDb("t2c");
    const cid = seedCandidate(db, "Jane Roe");
    seedLead(db, cid);
    const result = connectNoteRequiredForLabel(db, "Invite Jane Roe to connect", "search");
    assert.equal(result.block, false, "no draft → must not block");
  });

  // ─── T-AUTO6.3 — status='sent' → no block ────────────────────────────────
  it("T-AUTO6.3: connect_note draft status='sent' → block:false (connect already went out)", async () => {
    const db = await openTempDb("t3");
    const cid = seedCandidate(db, "Alice Smith");
    const lid = seedLead(db, cid);
    seedDraftRow(db, lid, { kind: "connect_note", status: "sent" });
    const result = connectNoteRequiredForLabel(db, "Invite Alice Smith to connect", "search");
    assert.equal(result.block, false, "sent draft must not block");
  });

  // ─── T-AUTO6.3b — status ∈ ('draft','approved','revised') → block ────────
  it("T-AUTO6.3b: status='approved' → block:true; status='revised' → block:true; status='draft' → block:true", async () => {
    for (const status of ["approved", "revised", "draft"] as const) {
      const db = await openTempDb(`t3b-${status}`);
      const cid = seedCandidate(db, "Bob Builder");
      const lid = seedLead(db, cid);
      seedDraftRow(db, lid, { kind: "connect_note", status });
      const result = connectNoteRequiredForLabel(db, "Invite Bob Builder to connect", "search");
      assert.equal(result.block, true, `status='${status}' must block`);
    }
  });

  // ─── T-AUTO6.3c — status='rejected' → no block (Step-2a Issue-3 fix) ────
  it("T-AUTO6.3c: connect_note draft status='rejected' → block:false (operator declined the note — not intended)", async () => {
    const db = await openTempDb("t3c");
    const cid = seedCandidate(db, "Carol Carr");
    const lid = seedLead(db, cid);
    seedDraftRow(db, lid, { kind: "connect_note", status: "rejected" });
    const result = connectNoteRequiredForLabel(db, "Invite Carol Carr to connect", "search");
    assert.equal(result.block, false, "rejected draft must NOT block (operator declined)");
  });

  // ─── T-AUTO6.4 — surface scoping: profile → no block ────────────────────
  it("T-AUTO6.4: draft exists but surface='profile' → block:false (profile modal is the sanctioned note path)", async () => {
    const db = await openTempDb("t4");
    const cid = seedCandidate(db, "Dave Drew");
    const lid = seedLead(db, cid);
    seedDraftRow(db, lid, { kind: "connect_note", status: "draft" });
    const result = connectNoteRequiredForLabel(db, "Invite Dave Drew to connect", "profile");
    assert.equal(result.block, false, "surface='profile' must not block");
  });

  it("T-AUTO6.4b: draft exists + surface='network' → block:true (network IS a blocked surface)", async () => {
    const db = await openTempDb("t4b");
    const cid = seedCandidate(db, "Eve Edwards");
    const lid = seedLead(db, cid);
    seedDraftRow(db, lid, { kind: "connect_note", status: "draft" });
    const result = connectNoteRequiredForLabel(db, "Invite Eve Edwards to connect", "network");
    assert.equal(result.block, true, "surface='network' must block when draft exists");
  });

  // ─── T-AUTO6.5 — D-14 immunity: kind='connect_note' regardless of workflow ──
  it("T-AUTO6.5: draft row is kind='connect_note' even when workflow title would give kind=null/outbound → still blocks", async () => {
    const db = await openTempDb("t5");
    const cid = seedCandidate(db, "Frank Ford");
    const lid = seedLead(db, cid);
    seedDraftRow(db, lid, { kind: "connect_note", status: "draft" });
    const result = connectNoteRequiredForLabel(db, "Invite Frank Ford to connect", "search");
    assert.equal(result.block, true, "D-14 immunity: kind=connect_note from DB is sufficient; no WorkflowState");
  });

  // ─── T-AUTO6.6 — cold-sweep immunity: no WorkflowState involved ──────────
  it("T-AUTO6.6: connectNoteRequiredForLabel takes only (db, label, surface) — no WorkflowState param → immune to cold-sweep null-workflow", () => {
    assert.equal(connectNoteRequiredForLabel.length, 3, "must have exactly 3 parameters (no WorkflowState)");
  });

  // ─── T-AUTO6.9 — per-person scoping (no cross-person false-positive) ─────
  it("T-AUTO6.9: draft exists ONLY for person A — invite for person B → block:false for B", async () => {
    const db = await openTempDb("t9");
    const cidA = seedCandidate(db, "Grace Green");
    const lidA = seedLead(db, cidA);
    seedDraftRow(db, lidA, { kind: "connect_note", status: "draft" });
    seedCandidate(db, "Hank Hill"); // person B, no draft
    const result = connectNoteRequiredForLabel(db, "Invite Hank Hill to connect", "search");
    assert.equal(result.block, false, "per-person scope: A's draft must not block B's invite");
  });

  // ─── T-AUTO6.9b — homonym over-block (Step-5a, audit BLOCKER fix) ─────────
  it("T-AUTO6.9b: two candidates share person_name 'Sam Lee' — the no-draft one inserted FIRST, the other HAS a connect_note draft → block:true (fail-closed over-block, JOIN scans all same-named rows)", async () => {
    // Given: candidate A 'Sam Lee' with NO lead/draft (inserted first → lower rowid, the row the OLD
    //        single-.get() would have fetched), candidate B 'Sam Lee' WITH a connect_note draft.
    // When:  connectNoteRequiredForLabel(db, 'Invite Sam Lee to connect', 'search') called
    // Then:  block:true — the JOIN finds B's draft despite A being fetched first (closes the audit
    //        BLOCKER homonym false-negative; matches plan §4 fail-closed over-block).
    const db = await openTempDb("t9b");
    seedCandidate(db, "Sam Lee"); // A — no lead/draft, inserted FIRST
    const cidB = seedCandidate(db, "Sam Lee"); // B — same name
    const lidB = seedLead(db, cidB);
    seedDraftRow(db, lidB, { kind: "connect_note", status: "draft" });
    const result = connectNoteRequiredForLabel(db, "Invite Sam Lee to connect", "search");
    assert.equal(result.block, true, "homonym: must block if ANY same-named candidate has an unsent connect_note (fail-closed)");
  });
});
