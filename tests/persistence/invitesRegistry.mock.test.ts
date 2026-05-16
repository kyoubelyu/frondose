/**
 * P-27 Step 5 — T-INV.1..9, T-INV.RACE.1
 *
 * Tests for src/persistence/invitesRegistry.ts — invites.sqlite CRUD.
 * Gate coverage: G-P27.26 (schema + housekeeping), G-P27.27 (race safety),
 *                G-P27.1 (lookupPending), G-P27.2 (expired), G-P27.3 (consumed),
 *                G-P27.5 (consume), G-P27.6 (double-consume)
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  consumeInvite,
  insertInvite,
  listInvitesByPersona,
  lookupInviteAny,
  lookupPendingInvite,
  markInviteExpired,
  openInvitesDb,
} from "../../src/persistence/invitesRegistry.js";

/** SHA-256 of a plaintext token for test use. */
function tokenSha(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

const NOW = Date.now();
const FUTURE = NOW + 1_800_000; // +30 min
const PAST = NOW - 1; // already expired

// ─── T-INV.1 ─────────────────────────────────────────────────────────────────

describe("openInvitesDb — schema bootstrap (G-P27.26)", () => {
  it("T-INV.1: when openInvitesDb(':memory:') called, schema_version=1 row present and invites table exists", () => {
    // Given: no prior DB state
    // When:  openInvitesDb(":memory:") succeeds
    // Then:  schema_version=1 row present; invites table with correct columns
    const db = openInvitesDb(":memory:");
    const ver = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as
      | { version: number }
      | undefined;
    assert.equal(ver?.version, 1, "schema_version row must be 1");
    const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='invites'").get() as
      | { name: string }
      | undefined;
    assert.ok(tbl, "invites table must exist");
    db.close();
  });
});

// ─── T-INV.2 ─────────────────────────────────────────────────────────────────

describe("insertInvite (G-P27.11)", () => {
  it("T-INV.2: after insertInvite, row exists in DB with status='pending'", () => {
    // Given: fresh :memory: invites DB
    // When:  insertInvite(db, tokenSha("tok1"), "persona-x", null, FUTURE)
    // Then:  SELECT returns row with status='pending' and correct fields
    const db = openInvitesDb(":memory:");
    const sha = tokenSha("tok1");
    insertInvite(db, sha, "persona-x", null, FUTURE);
    const row = db.prepare("SELECT * FROM invites WHERE token_sha256=?").get(sha) as
      | { status: string; persona_id: string; hostname_hint: null; expires_at: number }
      | undefined;
    assert.ok(row, "row must exist after insertInvite");
    assert.equal(row.status, "pending");
    assert.equal(row.persona_id, "persona-x");
    assert.equal(row.hostname_hint, null);
    assert.equal(row.expires_at, FUTURE);
    db.close();
  });
});

// ─── T-INV.3 ─────────────────────────────────────────────────────────────────

describe("lookupPendingInvite — happy path (G-P27.1)", () => {
  it("T-INV.3: given pending + unexpired invite, lookupPendingInvite returns the row", () => {
    // Given: insert invite with expires_at=FUTURE and status='pending'
    // When:  lookupPendingInvite(db, tokenSha("tok3"))
    // Then:  returns non-null with persona_id='persona-x' and expires_at=FUTURE
    const db = openInvitesDb(":memory:");
    const sha = tokenSha("tok3");
    insertInvite(db, sha, "persona-x", "vm-alpha", FUTURE);
    const row = lookupPendingInvite(db, sha);
    assert.ok(row !== null, "must return row for pending+unexpired invite");
    assert.equal(row.persona_id, "persona-x");
    assert.equal(row.hostname_hint, "vm-alpha");
    assert.equal(row.expires_at, FUTURE);
    db.close();
  });
});

// ─── T-INV.4 ─────────────────────────────────────────────────────────────────

describe("lookupPendingInvite — expired invite (G-P27.2)", () => {
  it("T-INV.4: given invite with expires_at < Date.now(), lookupPendingInvite returns null", () => {
    // Given: insert invite with expires_at=PAST (already expired)
    // When:  lookupPendingInvite(db, tokenSha("tok4"))
    // Then:  returns null (expires_at > ? filter excludes the row)
    const db = openInvitesDb(":memory:");
    const sha = tokenSha("tok4");
    insertInvite(db, sha, "persona-x", null, PAST);
    const row = lookupPendingInvite(db, sha);
    assert.equal(row, null, "must return null for expired invite");
    db.close();
  });
});

// ─── T-INV.5 ─────────────────────────────────────────────────────────────────

describe("lookupPendingInvite — consumed invite (G-P27.3)", () => {
  it("T-INV.5: given invite already consumed, lookupPendingInvite returns null", () => {
    // Given: insert pending invite, then consume it → status='consumed'
    // When:  lookupPendingInvite(db, tokenSha("tok5"))
    // Then:  returns null (status='pending' filter excludes consumed rows)
    const db = openInvitesDb(":memory:");
    const sha = tokenSha("tok5");
    insertInvite(db, sha, "persona-x", null, FUTURE);
    consumeInvite(db, sha, "worker_X");
    const row = lookupPendingInvite(db, sha);
    assert.equal(row, null, "must return null for consumed invite");
    db.close();
  });
});

// ─── T-INV.6 ─────────────────────────────────────────────────────────────────

describe("consumeInvite — successful consume (G-P27.5)", () => {
  it("T-INV.6: given pending invite, consumeInvite returns true and row has status='consumed' + worker_id_assigned", () => {
    // Given: pending unexpired invite
    // When:  consumeInvite(db, tokenSha("tok6"), "worker_X")
    // Then:  returns true; row.status='consumed'; row.worker_id_assigned='worker_X'
    const db = openInvitesDb(":memory:");
    const sha = tokenSha("tok6");
    insertInvite(db, sha, "persona-x", null, FUTURE);
    const ok = consumeInvite(db, sha, "worker_X");
    assert.equal(ok, true, "consumeInvite must return true on first consume");
    const row = db.prepare("SELECT status, worker_id_assigned FROM invites WHERE token_sha256=?").get(sha) as
      | { status: string; worker_id_assigned: string }
      | undefined;
    assert.equal(row?.status, "consumed");
    assert.equal(row?.worker_id_assigned, "worker_X");
    db.close();
  });
});

// ─── T-INV.7 ─────────────────────────────────────────────────────────────────

describe("consumeInvite — already consumed (G-P27.6)", () => {
  it("T-INV.7: given already-consumed invite, second consumeInvite call returns false and row is unchanged", () => {
    // Given: pending invite consumed by worker_A
    // When:  second consumeInvite with worker_B
    // Then:  returns false; row.worker_id_assigned still 'worker_A'
    const db = openInvitesDb(":memory:");
    const sha = tokenSha("tok7");
    insertInvite(db, sha, "persona-x", null, FUTURE);
    consumeInvite(db, sha, "worker_A");
    const ok2 = consumeInvite(db, sha, "worker_B");
    assert.equal(ok2, false, "second consumeInvite must return false");
    const row = db.prepare("SELECT worker_id_assigned FROM invites WHERE token_sha256=?").get(sha) as
      | { worker_id_assigned: string }
      | undefined;
    assert.equal(row?.worker_id_assigned, "worker_A", "worker_id_assigned must remain worker_A");
    db.close();
  });
});

// ─── T-INV.8 ─────────────────────────────────────────────────────────────────

describe("markInviteExpired (G-P27.26 housekeeping)", () => {
  it("T-INV.8: given pending invite, markInviteExpired sets status='expired'", () => {
    // Given: pending invite
    // When:  markInviteExpired(db, tokenSha("tok8"))
    // Then:  row.status='expired'
    const db = openInvitesDb(":memory:");
    const sha = tokenSha("tok8");
    insertInvite(db, sha, "persona-x", null, FUTURE);
    markInviteExpired(db, sha);
    const row = db.prepare("SELECT status FROM invites WHERE token_sha256=?").get(sha) as
      | { status: string }
      | undefined;
    assert.equal(row?.status, "expired");
    db.close();
  });
});

// ─── T-INV.9 ─────────────────────────────────────────────────────────────────

describe("listInvitesByPersona (G-P27.26 housekeeping)", () => {
  it("T-INV.9: given 2 invites with same persona_id, listInvitesByPersona returns both ordered by created_at DESC", () => {
    // Given: two invites for 'p1' inserted with slight delay
    // When:  listInvitesByPersona(db, 'p1')
    // Then:  length===2; ordered created_at DESC (most-recent first); both have token_sha256/status/expires_at
    const db = openInvitesDb(":memory:");
    const sha1 = tokenSha("tok9a");
    const sha2 = tokenSha("tok9b");
    // Insert with explicit timestamps via raw SQL to control order deterministically.
    db.prepare("INSERT INTO invites (token_sha256, persona_id, hostname_hint, expires_at, status, created_at) VALUES (?, ?, NULL, ?, 'pending', ?)").run(sha1, "p1", FUTURE, NOW + 1000);
    db.prepare("INSERT INTO invites (token_sha256, persona_id, hostname_hint, expires_at, status, created_at) VALUES (?, ?, NULL, ?, 'pending', ?)").run(sha2, "p1", FUTURE, NOW + 2000);
    const rows = listInvitesByPersona(db, "p1");
    assert.equal(rows.length, 2);
    // DESC order: sha2 (created_at=NOW+2000) should be first
    assert.equal(rows[0].token_sha256, sha2, "most-recent first");
    assert.equal(rows[1].token_sha256, sha1);
    assert.ok("token_sha256" in rows[0] && "status" in rows[0] && "expires_at" in rows[0]);
    db.close();
  });
});

// ─── T-INV.RACE.1 ─────────────────────────────────────────────────────────────

describe("consumeInvite — race safety (G-P27.27)", () => {
  it("T-INV.RACE.1: simulated concurrent double-consume — first call returns true, second returns false", () => {
    // Given: pending unexpired invite in DB
    // When:  consumeInvite called twice in direct succession
    // Then:  first=true; second=false; row.worker_id_assigned='worker_A'
    const db = openInvitesDb(":memory:");
    const sha = tokenSha("tok_race");
    insertInvite(db, sha, "persona-x", null, FUTURE);
    const result1 = consumeInvite(db, sha, "worker_A");
    const result2 = consumeInvite(db, sha, "worker_B");
    assert.equal(result1, true, "first consume must win");
    assert.equal(result2, false, "second consume must lose (atomic UPDATE guard)");
    // Verify lookupInviteAny (used in 404/410 discrimination) returns consumed row.
    const any = lookupInviteAny(db, sha);
    assert.equal(any?.status, "consumed");
    const row = db.prepare("SELECT worker_id_assigned FROM invites WHERE token_sha256=?").get(sha) as
      | { worker_id_assigned: string }
      | undefined;
    assert.equal(row?.worker_id_assigned, "worker_A");
    db.close();
  });
});
