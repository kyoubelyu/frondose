/**
 * Auto-mode outbound guardrails — countOutboundSince / lastOutboundAt / resolveOutboundGuardrails.
 * The cross-run daily LinkedIn-safety quota + inter-outbound cooldown (surfaced via get_auto_run_state).
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/persistence/salesDb-autoRunOutboundGuardrails.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: runtime resolution
type AnyFn = (...args: any[]) => any;
let openSalesDatabase: AnyFn;
let insertAutoRun: AnyFn;
let countOutboundSince: AnyFn;
let lastOutboundAt: AnyFn;
let resolveOutboundGuardrails: AnyFn;
const DAY_MS = 86_400_000;

before(async () => {
  const mod = await import("../../src/persistence/salesDb.js");
  openSalesDatabase = mod.openSalesDatabase;
  insertAutoRun = mod.insertAutoRun;
  countOutboundSince = mod.countOutboundSince;
  lastOutboundAt = mod.lastOutboundAt;
  resolveOutboundGuardrails = mod.resolveOutboundGuardrails;
});

function makeTmpPath(): string {
  return join(tmpdir(), `salesDb-outbound-guard-${randomUUID()}.sqlite`);
}
// Insert a ledger row with an EXPLICIT ts (appendAutoLedger pins Date.now(), so we go raw for time control).
function insertLedger(db: AnyFn, runId: string, actionType: string, ts: number, result = "success"): void {
  db.prepare(
    `INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, ts, count_weight, result)
     VALUES (?, ?, ?, NULL, ?, 1.0, ?)`,
  ).run(randomUUID(), runId, actionType, ts, result);
}
function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

describe("Auto outbound guardrails — countOutboundSince / lastOutboundAt", () => {
  // Given empty DB; When queried; Then zero / null.
  it("empty ledger → countOutboundSince=0, lastOutboundAt=null", () => {
    const db = openSalesDatabase(makeTmpPath());
    assert.equal(countOutboundSince(db, startOfTodayMs()), 0);
    assert.equal(lastOutboundAt(db), null);
  });

  // Given 3 successful outbound today + 1 yesterday; When counted from start-of-today; Then only today's 3.
  it("counts ONLY successful outbound on/after the since boundary (excludes yesterday)", () => {
    const db = openSalesDatabase(makeTmpPath());
    const run = insertAutoRun(db, { maxDurationMinutes: 30, maxConnects: 5 });
    const now = Date.now();
    insertLedger(db, run.id, "connect_sent", now - 1000);
    insertLedger(db, run.id, "message_sent", now - 2000);
    insertLedger(db, run.id, "follow_up_sent", now - 3000);
    insertLedger(db, run.id, "connect_sent", now - DAY_MS); // yesterday — excluded
    assert.equal(countOutboundSince(db, startOfTodayMs()), 3, "only today's 3 outbound counted");
  });

  // Given a failed outbound + a non-outbound action type; When counted; Then neither counts.
  it("excludes failed results AND non-outbound action types (comment_posted)", () => {
    const db = openSalesDatabase(makeTmpPath());
    const run = insertAutoRun(db, { maxDurationMinutes: 30, maxConnects: 5 });
    const now = Date.now();
    insertLedger(db, run.id, "connect_sent", now - 1000, "failed"); // failed — excluded
    insertLedger(db, run.id, "comment_posted", now - 2000, "success"); // not an outbound type — excluded
    insertLedger(db, run.id, "connect_sent", now - 3000, "success"); // the only one that counts
    assert.equal(countOutboundSince(db, startOfTodayMs()), 1);
  });

  // Given outbound rows; When lastOutboundAt; Then the MAX successful-outbound ts.
  it("lastOutboundAt returns the most-recent successful outbound ts", () => {
    const db = openSalesDatabase(makeTmpPath());
    const run = insertAutoRun(db, { maxDurationMinutes: 30, maxConnects: 5 });
    const now = Date.now();
    insertLedger(db, run.id, "connect_sent", now - 5000);
    insertLedger(db, run.id, "message_sent", now - 1000); // most recent
    insertLedger(db, run.id, "connect_sent", now - 500, "failed"); // failed — ignored
    assert.equal(lastOutboundAt(db), now - 1000);
  });
});

describe("resolveOutboundGuardrails — defaults + env override", () => {
  // Given no env; Then conservative LinkedIn-safe defaults (15/day, 5min cooldown).
  it("defaults: dailyCap=15, cooldownMs=300000", () => {
    const prevCap = process.env.FRONDOSE_AUTO_DAILY_OUTBOUND_CAP;
    const prevCool = process.env.FRONDOSE_AUTO_OUTBOUND_COOLDOWN_MIN;
    delete process.env.FRONDOSE_AUTO_DAILY_OUTBOUND_CAP;
    delete process.env.FRONDOSE_AUTO_OUTBOUND_COOLDOWN_MIN;
    try {
      assert.deepEqual(resolveOutboundGuardrails(), { dailyCap: 15, cooldownMs: 300_000 });
    } finally {
      if (prevCap !== undefined) process.env.FRONDOSE_AUTO_DAILY_OUTBOUND_CAP = prevCap;
      if (prevCool !== undefined) process.env.FRONDOSE_AUTO_OUTBOUND_COOLDOWN_MIN = prevCool;
    }
  });

  // Given env overrides; Then they win; 0 disables that guardrail.
  it("env override: cap=8, cooldown=0 (disabled) → {dailyCap:8, cooldownMs:0}", () => {
    const prevCap = process.env.FRONDOSE_AUTO_DAILY_OUTBOUND_CAP;
    const prevCool = process.env.FRONDOSE_AUTO_OUTBOUND_COOLDOWN_MIN;
    process.env.FRONDOSE_AUTO_DAILY_OUTBOUND_CAP = "8";
    process.env.FRONDOSE_AUTO_OUTBOUND_COOLDOWN_MIN = "0";
    try {
      assert.deepEqual(resolveOutboundGuardrails(), { dailyCap: 8, cooldownMs: 0 });
    } finally {
      if (prevCap !== undefined) process.env.FRONDOSE_AUTO_DAILY_OUTBOUND_CAP = prevCap;
      else delete process.env.FRONDOSE_AUTO_DAILY_OUTBOUND_CAP;
      if (prevCool !== undefined) process.env.FRONDOSE_AUTO_OUTBOUND_COOLDOWN_MIN = prevCool;
      else delete process.env.FRONDOSE_AUTO_OUTBOUND_COOLDOWN_MIN;
    }
  });
});
