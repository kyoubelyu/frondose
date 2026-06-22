/**
 * P-FIX-CUSTOM-INVITE-SURFACE — T-CIS.5..7 click-path guard integration.
 *
 * Mirrors the compact P-AUTO-17 click mock harness: real makeClickTool, real
 * sales DB migrations, fake LinkedinSession/CDP client.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CdpClient } from "../../../src/cdp/client.js";
import { inferSurface } from "../../../src/linkedin/scopeResolver.js";
import type { CurrentSurfaceContext, LinkedinSession } from "../../../src/linkedin/types.js";
import { countSuccessfulConnects, openSalesDatabase } from "../../../src/persistence/salesDb.js";
import { makeClickTool } from "../../../src/tools/browser/click.js";

process.env.FRONDOSE_PACE_MIN_MS = "0";
process.env.FRONDOSE_PACE_MAX_MS = "0";

const CUSTOM_INVITE_URL = "https://www.linkedin.com/preload/custom-invite/?vanityName=john-doe";

type ClickResult = {
  ok: boolean;
  reason?: string;
  error?: { kind?: string; message?: string };
};

type ClickSpy = {
  called: boolean;
  calledWith?: string;
};

function makeTmpDbPath(): string {
  return join(tmpdir(), `custom-invite-click-${randomUUID()}.sqlite`);
}

function seedAutoRun(dbPath: string, maxConnects = 5): { db: ReturnType<typeof openSalesDatabase>; runId: string } {
  const db = openSalesDatabase(dbPath);
  const runId = randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, now, null, 480, maxConnects, "running", null, null);
  return { db, runId };
}

function customInviteContext(label: string): CurrentSurfaceContext {
  const surface = inferSurface(CUSTOM_INVITE_URL);
  assert.equal(surface, "profile", "custom-invite preload URL must infer profile before makeClickTool guards run");
  return {
    pageUrl: CUSTOM_INVITE_URL,
    surface,
    activeLayer: "overlay",
    entries: [{ ref: "@ov4", role: "button", name: label }],
  };
}

function ledgerCount(db: ReturnType<typeof openSalesDatabase>, runId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM auto_run_ledger WHERE run_id = ? AND action_type = 'connect_sent' AND result = 'success'",
    )
    .get(runId) as { n: number };
  return row.n;
}

function makeSession(opts: {
  dbPath: string;
  runId: string;
  context: CurrentSurfaceContext;
  clickAtSpy: ClickSpy;
  canClickOutbound: (label: string, surface: string) => boolean;
  mode?: "manual" | "auto";
  connectSentCount?: number;
  maxConnects?: number | null;
}): LinkedinSession {
  let context = opts.context;
  const fakeClient = {
    currentRefMap: {},
    getBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
    clickAt: async (ref: string) => {
      opts.clickAtSpy.called = true;
      opts.clickAtSpy.calledWith = ref;
    },
    verifyRef: async (_refKey: string, expected: { role: string; name?: string }) => ({
      matches: true,
      currentRole: expected.role,
      currentName: expected.name ?? null,
    }),
  } as unknown as CdpClient;
  return {
    inputMode: "cdp",
    getOrInitClient: async () => ({ ok: true, client: fakeClient }),
    getClient: () => fakeClient,
    setTurnAbortSignal: () => {},
    heartbeat: async () => true,
    setLastContext: (next: CurrentSurfaceContext) => {
      context = next;
    },
    getLastContext: () => context,
    canClickOutbound: opts.canClickOutbound,
    resolvedMode: () => opts.mode ?? "auto",
    autoRun: () => ({
      runId: opts.runId,
      maxConnects: opts.maxConnects ?? 5,
      connectSentCount: opts.connectSentCount ?? 0,
    }),
    dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
    salesDbPath: opts.dbPath,
  } as unknown as LinkedinSession;
}

async function executeCustomInviteClick(opts: {
  label: string;
  canClickOutbound: (label: string, surface: string) => boolean;
  mode?: "manual" | "auto";
  connectSentCount?: number;
  maxConnects?: number | null;
}): Promise<{ result: ClickResult; db: ReturnType<typeof openSalesDatabase>; runId: string; clickAtSpy: ClickSpy }> {
  const dbPath = makeTmpDbPath();
  const { db, runId } = seedAutoRun(dbPath, opts.maxConnects ?? 5);
  const clickAtSpy: ClickSpy = { called: false };
  const session = makeSession({
    dbPath,
    runId,
    context: customInviteContext(opts.label),
    clickAtSpy,
    canClickOutbound: opts.canClickOutbound,
    mode: opts.mode,
    connectSentCount: opts.connectSentCount,
    maxConnects: opts.maxConnects,
  });
  const result = (await makeClickTool(session).execute({ ref: "@ov4" })) as ClickResult;
  return { result, db, runId, clickAtSpy };
}

describe("T-CIS.5..7 — custom-invite preload surface engages click outbound guards", () => {
  it("T-CIS.5: Manual unapproved custom-invite 'Send without a note' returns approval_required without CDP dispatch or ledger row", async () => {
    // Given/When/Then: inferSurface(custom-invite URL) feeds profile context, approval denies, so click blocks before dispatch and ledger.
    const { result, db, runId, clickAtSpy } = await executeCustomInviteClick({
      label: "Send without a note",
      mode: "manual",
      canClickOutbound: () => false,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "approval_required");
    assert.equal(clickAtSpy.called, false);
    assert.equal(countSuccessfulConnects(db, runId), 0);
    assert.equal(ledgerCount(db, runId), 0);
  });

  it("T-CIS.6: approved Auto custom-invite send labels dispatch once and write exactly one connect_sent/success ledger row", async () => {
    // Given/When/Then: inferSurface(custom-invite URL) feeds profile context, approval allows, so each send label dispatches and writes one ledger row.
    for (const label of ["Send without a note", "Send invitation"]) {
      const { result, db, runId, clickAtSpy } = await executeCustomInviteClick({
        label,
        mode: "auto",
        canClickOutbound: () => true,
      });

      assert.equal(result.ok, true, `${label}: click must succeed`);
      assert.equal(clickAtSpy.called, true, `${label}: clickAt must dispatch`);
      assert.equal(clickAtSpy.calledWith, "@ov4", `${label}: clickAt must target the resolved overlay entry`);
      assert.equal(countSuccessfulConnects(db, runId), 1, `${label}: successful connect count must be exactly one`);
      assert.equal(ledgerCount(db, runId), 1, `${label}: exactly one connect_sent/success ledger row expected`);
    }
  });

  it("T-CIS.7: Auto at-cap custom-invite 'Send without a note' returns auto_cap_reached without CDP dispatch or new ledger row", async () => {
    // Given/When/Then: inferSurface(custom-invite URL) feeds profile context and autoRun is at cap, so cap blocks before dispatch and ledger.
    const { result, db, runId, clickAtSpy } = await executeCustomInviteClick({
      label: "Send without a note",
      mode: "auto",
      connectSentCount: 5,
      maxConnects: 5,
      canClickOutbound: () => true,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "auto_cap_reached");
    assert.equal(clickAtSpy.called, false);
    assert.equal(countSuccessfulConnects(db, runId), 0);
    assert.equal(ledgerCount(db, runId), 0);
  });
});
