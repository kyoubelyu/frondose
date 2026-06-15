/**
 * P-AUTO-15b Step 3 — Test Scaffold — G-A15b.4..5c (QS-7.a promotion gate)
 *
 * Covers:
 *   G-A15b.4   — empty evidence + ICP targetRole configured → promote fails with re-inspect message
 *   G-A15b.5   — empty evidence + NO ICP → promote skips the gate, succeeds (backward compat)
 *   G-A15b.5a  — empty evidence + ICP + bypassPersonaCheck:true STILL fails the QS-7.a gate
 *               (bypassPersonaCheck bypasses D-29 token-overlap only, NOT the evidence gate)
 *   G-A15b.5b  — non-empty evidence + ICP → passes the evidence gate, promote succeeds
 *   G-A15b.5c  — readIdentity() is called exactly ONCE per promote (hoist verification)
 *
 * Identity isolation (CONCERN-MR-3):
 *   Every test in this file uses the canonical temp-HOME pattern from
 *   tests/tools/methodology/qualifyProfile.mock.test.ts:40-44 to isolate readIdentity().
 *   This ensures the gate behavior is deterministic regardless of the developer/operator
 *   machine's actual ~/.frondose/agent/config.json.
 *
 * Step-3 RED state (BEFORE builder Step 4):
 *   G-A15b.4, G-A15b.5a, G-A15b.5c FAIL because the QS-7.a gate doesn't exist yet:
 *     G-A15b.4:  promote currently SKIPS when empty evidence (D-29 skip) → returns ok:true (wrong)
 *     G-A15b.5a: bypassPersonaCheck:true doesn't block on evidence → returns ok:true (wrong)
 *     G-A15b.5c: cannot spy on readIdentity() before the hoist exists
 *   G-A15b.5, G-A15b.5b should PASS (today's promote works for these paths).
 *
 * Run (mock only):
 *   node --import tsx --test --test-force-exit \
 *     tests/tools/sales/promoteCandidateToLead-pAuto15b.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { closeSalesDatabase, openSalesDatabase } from "../../../src/persistence/salesDb.js";
import { makePromoteCandidateToLeadTool } from "../../../src/tools/sales/promoteCandidateToLead.js";
import { makeScoreLeadTool } from "../../../src/tools/sales/scoreLead.js";
import { upsertRawCandidate } from "../../../src/persistence/sales/raw-candidates.js";

// biome-ignore lint/suspicious/noExplicitAny: test DB rows
type AnyDb = any;

function tmpPath(label: string): string {
  return join(tmpdir(), `a15b-promote-${label}-${randomUUID()}.sqlite`);
}

/** Minimal Vercel tool execute options. */
const toolOpts = { messages: [] as never[], toolCallId: "test" };

/**
 * Canonical temp-HOME isolation pattern (CONCERN-MR-3).
 * Mirror of tests/tools/methodology/qualifyProfile.mock.test.ts:40-44.
 *
 * D-A15b.1 fix: write the legacy `identity.json` directly at
 *   <tmpHome>/.frondose/agent/identity.json
 * rather than config.json. config.json requires schema_version:2 + a full v2
 * envelope; without it, readConfig() rejects the file and readIdentity() falls
 * back to the legacy identity.json reader — which is the correct fallback path.
 *
 * identityRecord shape must satisfy identityRecordSchema (all fields optional
 * except updatedAt; icp.targetRole must have ≥1 element to pass Zod validation).
 * For the no-ICP tests, pass identityRecord=null — no identity.json is written
 * so readIdentity() returns null and the QS-7.a gate skips (backward-compat).
 *
 * Returns: { tmpHome, restore }
 *   tmpHome — the temp directory path (also used as MAI_HOME_BASE)
 *   restore — call in finally to undo env overrides and rm the temp dir
 */
function setupTempHome(identityRecord: Record<string, unknown> | null): { tmpHome: string; restore: () => void } {
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-pAuto15b-home-"));
  const origHome = process.env.HOME;
  const origHomeBase = process.env.MAI_HOME_BASE;
  process.env.HOME = tmpHome;
  process.env.MAI_HOME_BASE = tmpHome;

  // Write the identity.json into the legacy fallback path.
  // readIdentity() checks config.json first; if absent/invalid, falls back to
  // identity.json. Writing only identity.json exercises the fallback path cleanly.
  mkdirSync(join(tmpHome, ".frondose", "agent"), { recursive: true });
  if (identityRecord !== null) {
    writeFileSync(
      join(tmpHome, ".frondose", "agent", "identity.json"),
      JSON.stringify({ ...identityRecord, updatedAt: new Date().toISOString() }),
    );
  }

  return {
    tmpHome,
    restore: () => {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
      if (origHomeBase !== undefined) process.env.MAI_HOME_BASE = origHomeBase;
      else delete process.env.MAI_HOME_BASE;
      rmSync(tmpHome, { recursive: true, force: true });
    },
  };
}

/**
 * Seed a candidate row with the given evidenceSummary and a passing score (totalScore=60, qualified).
 * Returns candidateId for use in promote calls.
 *
 * The score must include evidenceJson (QS-5 gate) when totalScore>=40.
 */
async function seedScoredCandidate(
  salesDbPath: string,
  db: AnyDb,
  opts: { evidenceSummary?: string; profileUrl?: string } = {},
): Promise<string> {
  const profileUrl = opts.profileUrl ?? `https://www.linkedin.com/in/test-a15b-${randomUUID()}/`;
  const { candidateId } = upsertRawCandidate(db, {
    personName: "Test Person",
    profileUrl,
    source: "profile-nav",
    evidenceSummary: opts.evidenceSummary,
  });

  // Score the candidate (qualifies D-29 + P-AUTO-4 gates)
  // Use qualified band + evidenceJson to pass QS-5 (added by this phase)
  await makeScoreLeadTool(salesDbPath).execute(
    {
      candidateId,
      qualification: "qualified",
      totalScore: 60,
      confidence: 0.7,
      nextAction: "connect_now",
      evidenceJson: '{"role":"VP Sales","source":"a15b-test-fixture"}',
    },
    toolOpts,
  );

  return candidateId;
}

// ─── G-A15b.4: empty evidence + ICP targetRole → fail ─────────────────────

describe("G-A15b.4 — QS-7.a: empty evidence + ICP configured → promote fails (re-inspect required)", () => {
  it("G-A15b.4: when candidate.evidence_summary IS NULL and identity.icp.targetRole=['VP Sales'], promote fails with re-inspect message", async () => {
    // Given: candidate with evidence_summary=NULL status='scored' with a passing score;
    //        tmp-HOME isolation seeds config.json with identity.icp.targetRole=['VP Sales']
    // When:  promote_candidate_to_lead({candidateId})
    // Then:  {ok:false, error:{kind:'invalid_input', reason:/re-inspect|evidence_summary/i}};
    //        no leads row written; raw_candidates.status stays 'scored'
    const path = tmpPath("qs7a-fail-icp");
    const db = openSalesDatabase(path) as AnyDb;
    // D-A15b.1: write flat identityRecord to identity.json (legacy fallback path)
    const { restore } = setupTempHome({
      fullName: "Test BD",
      role: "BD",
      icp: { targetRole: ["VP Sales"] },
    });
    try {
      // Seed with NO evidenceSummary (NULL in DB)
      const candidateId = await seedScoredCandidate(path, db, { evidenceSummary: undefined });

      const result = await makePromoteCandidateToLeadTool(path).execute({ candidateId }, toolOpts);

      // TODO: Step-5 assertion fill — currently D-29 skips and promote returns ok:true
      assert.equal(result.ok, false, "G-A15b.4: empty evidence + ICP must fail promotion");
      const errorMsg: string = result.error?.message ?? result.error?.reason ?? "";
      assert.ok(
        /re-inspect|evidence_summary/i.test(errorMsg),
        `G-A15b.4: error must mention re-inspect or evidence_summary; got: ${errorMsg}`,
      );
      const leadsCount = (db.prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n;
      assert.equal(leadsCount, 0, "G-A15b.4: no leads row must be written on QS-7.a gate failure");
    } finally {
      restore();
      closeSalesDatabase(path);
    }
  });
});

// ─── G-A15b.5: empty evidence + NO ICP → skip (backward compat) ────────────

describe("G-A15b.5 — QS-7.a: empty evidence + NO ICP → gate skips, promote succeeds", () => {
  it("G-A15b.5: when evidence_summary IS NULL and identity has NO targetRole (empty ICP), promote succeeds (D-29 mirror skip)", async () => {
    // Given: candidate with evidence_summary=NULL status='scored';
    //        tmp-HOME isolation seeds config.json with identity.icp.targetRole=[] (no ICP)
    // When:  promote_candidate_to_lead({candidateId})
    // Then:  {ok:true}; leads row written; raw_candidates.status='promoted'
    const path = tmpPath("qs7a-no-icp");
    const db = openSalesDatabase(path) as AnyDb;
    // D-A15b.1: no identity.json written → readIdentity() returns null → gate skips
    const { restore } = setupTempHome(null);
    try {
      const candidateId = await seedScoredCandidate(path, db, { evidenceSummary: undefined });

      const result = await makePromoteCandidateToLeadTool(path).execute({ candidateId }, toolOpts);

      // TODO: Step-5 assertion fill
      assert.equal(result.ok, true, `G-A15b.5: no-ICP must skip the evidence gate; got ${JSON.stringify(result)}`);
      const cand = db.prepare("SELECT status FROM raw_candidates WHERE id = ?").get(candidateId) as {
        status: string;
      };
      assert.equal(cand.status, "promoted", "G-A15b.5: raw_candidates.status must be 'promoted' after successful promote");
    } finally {
      restore();
      closeSalesDatabase(path);
    }
  });
});

// ─── G-A15b.5a: bypassPersonaCheck does NOT bypass the evidence gate ────────

describe("G-A15b.5a — QS-7.a: bypassPersonaCheck:true does NOT bypass the QS-7.a evidence gate", () => {
  it("G-A15b.5a: when evidence=NULL + ICP present + bypassPersonaCheck:true, the QS-7.a evidence gate still fires", async () => {
    // Given: same as G-A15b.4 (empty evidence, ICP targetRole=['VP Sales']);
    //        bypassPersonaCheck:true is passed (which normally bypasses D-29 token-overlap)
    // When:  promote_candidate_to_lead({candidateId, bypassPersonaCheck:true})
    // Then:  gate STILL fails (bypassPersonaCheck bypasses D-29 only, NOT the evidence gate);
    //        error mentions evidence_summary / re-inspect
    const path = tmpPath("qs7a-bypass-still-fails");
    const db = openSalesDatabase(path) as AnyDb;
    // D-A15b.1: flat identityRecord with ICP to identity.json
    const { restore } = setupTempHome({
      fullName: "Test BD",
      role: "BD",
      icp: { targetRole: ["VP Sales"] },
    });
    try {
      const candidateId = await seedScoredCandidate(path, db, { evidenceSummary: undefined });

      const result = await makePromoteCandidateToLeadTool(path).execute(
        { candidateId, bypassPersonaCheck: true },
        toolOpts,
      );

      // TODO: Step-5 assertion fill
      assert.equal(result.ok, false, "G-A15b.5a: bypassPersonaCheck must NOT bypass the evidence gate; must still fail");
      const errorMsg: string = result.error?.message ?? result.error?.reason ?? "";
      assert.ok(
        /re-inspect|evidence_summary/i.test(errorMsg),
        `G-A15b.5a: error must mention re-inspect or evidence_summary; got: ${errorMsg}`,
      );
    } finally {
      restore();
      closeSalesDatabase(path);
    }
  });
});

// ─── G-A15b.5b: non-empty evidence + ICP → passes the gate ──────────────────

describe("G-A15b.5b — QS-7.a: non-empty evidence + ICP passes the evidence gate and promotes", () => {
  it("G-A15b.5b: when evidence_summary='VP Sales · EMEA · Acme' and ICP targetRole=['VP Sales'], promote succeeds (D-29 token-overlap matches + evidence gate passes)", async () => {
    // Given: candidate with non-empty evidence_summary; tmp-HOME with ICP targetRole=['VP Sales']
    // When:  promote_candidate_to_lead({candidateId})
    // Then:  {ok:true}; leads row written; status='promoted'
    const path = tmpPath("qs7a-evidence-pass");
    const db = openSalesDatabase(path) as AnyDb;
    // D-A15b.1: flat identityRecord with ICP to identity.json
    const { restore } = setupTempHome({
      fullName: "Test BD",
      role: "BD",
      icp: { targetRole: ["VP Sales"] },
    });
    try {
      // Seed with NON-EMPTY evidenceSummary that token-overlaps with 'VP Sales' ICP
      const candidateId = await seedScoredCandidate(path, db, {
        evidenceSummary: "VP Sales · EMEA · Acme",
      });

      const result = await makePromoteCandidateToLeadTool(path).execute({ candidateId }, toolOpts);

      // TODO: Step-5 assertion fill
      assert.equal(result.ok, true, `G-A15b.5b: non-empty evidence + matching ICP must succeed; got ${JSON.stringify(result)}`);
      const cand = db.prepare("SELECT status FROM raw_candidates WHERE id = ?").get(candidateId) as {
        status: string;
      };
      assert.equal(cand.status, "promoted", "G-A15b.5b: raw_candidates.status must be 'promoted'");
    } finally {
      restore();
      closeSalesDatabase(path);
    }
  });
});

// ─── G-A15b.5c: readIdentity() called exactly once per promote ───────────────

describe("G-A15b.5c — QS-7.a: readIdentity() hoist — called exactly ONCE per promote (G-A15b.5c)", () => {
  it("G-A15b.5c: readIdentity() is called exactly ONCE per promote_candidate_to_lead call (single hoist, shared by D-29 and QS-7.a gate)", async () => {
    // Given: tmp-HOME with ICP targetRole=['VP Sales'] (so both D-29 and QS-7.a can potentially run)
    //        candidate has non-empty evidenceSummary (so promote completes — we're counting reads, not testing failure)
    // When:  promote_candidate_to_lead({candidateId})
    // Then:  readIdentity() was invoked exactly ONCE inside promote
    //        (the hoist means a single const identity = readIdentity() is shared by checkPersonaMatch AND QS-7.a gate)
    //
    // Implementation approach:
    //   We observe readIdentity behavior indirectly via the config.json access count.
    //   At Step 3, we scaffold the counter assertion as a placeholder; Step 5 fills
    //   the fs-spy or module-mock approach for counting invocations.
    //
    // At Step 3: this test compiles + asserts ok:true (the visible behavior)
    //   Step 5 TODO: assert readIdentity call count === 1 via module spy
    const path = tmpPath("qs7a-hoist");
    const db = openSalesDatabase(path) as AnyDb;
    // D-A15b.1: flat identityRecord with ICP to identity.json
    const { restore } = setupTempHome({
      fullName: "Test BD",
      role: "BD",
      icp: { targetRole: ["VP Sales"] },
    });
    try {
      const candidateId = await seedScoredCandidate(path, db, {
        evidenceSummary: "VP Sales · hiring 3 AEs — strong ICP",
      });

      const result = await makePromoteCandidateToLeadTool(path).execute({ candidateId }, toolOpts);

      // TODO: Step-5 assertion fill — spy on readIdentity to assert invocation count === 1
      assert.equal(result.ok, true, `G-A15b.5c: promote with non-empty evidence must succeed; got ${JSON.stringify(result)}`);
      // Placeholder: at Step 5 this assertion is replaced with the spy count check
      // For now, verifying the tool runs is the compile/RED-state intent.
    } finally {
      restore();
      closeSalesDatabase(path);
    }
  });
});
