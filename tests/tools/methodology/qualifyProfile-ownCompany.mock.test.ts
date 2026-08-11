/**
 * T-ICP-PRECISION Step 5 RE-VALIDATION (validator, Sonnet) — SIMPLIFIED
 * (name-only) design, per plan §13. The company-URL machinery
 * (`companyLinkedInUrl` on identity, `companyProfileUrl` param) was
 * operator-directed scope creep and has been stripped entirely from
 * `src/**` — `qualify_profile`'s param surface is UNCHANGED this phase
 * (verified: `grep -rn "companyProfileUrl|companyLinkedInUrl" src/` returns
 * nothing). The own-company pre-check uses ONLY the pre-existing
 * `companyName` evidence field against `identity.company`.
 *
 * Source-under-test: `makeQualifyProfileTool` in
 * `src/tools/methodology/qualifyProfile.ts` (landed at Step 4, name-only).
 *
 * NOTE ON ENVELOPE SHAPE (validator correction to plan §5 prose): the plan's
 * example envelope reads `{ok:true, tool:"qualify_profile", payload:{...}}`,
 * but `src/linkedin/envelope.ts`'s `ok(command, data)` ACTUALLY returns
 * `{ok:true, command:"qualify_profile", data:{...}}` (verified against
 * `src/linkedin/envelope.ts:12` + the existing
 * `tests/tools/methodology/qualifyProfile.mock.test.ts` usage of
 * `r.command`/`r.data`). This file asserts the REAL field names
 * (`.command`/`.data`), not the plan's prose shorthand.
 *
 * NOTE ON REGION EVIDENCE STRINGS (validator adaptation to plan §5 prose):
 * plan §5 T-Qualify.OwnCompany.1/.2 use `region:"London, UK"` / `"Berlin,
 * Germany"` against `icp.region:["Europe"]`. `matchIcp`'s region dimension
 * is literal token-overlap (`icpMatcher.ts:28-33`), not a semantic geography
 * hierarchy — "Europe" does not literally token-match "UK" or "Germany".
 * Adapted the evidence strings to "London, Europe" / "Berlin, Europe"
 * (literal-token-matching "Europe") to preserve the plan's qualitative
 * intent ("role+region individually would already match") under the real
 * matcher semantics.
 *
 * Gates covered: plan §5 T-Qualify.OwnCompany.1–4 — F-4 (qualify_profile
 * tool own-company pre-check, name-only). T-Qualify.OwnCompany.4 pins that
 * the own-company gate runs BEFORE the `!icp` early return — i.e. it fires
 * even when NO ICP is configured at all, and the result is "disqualified",
 * never "unknown".
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeQualifyProfileTool } from "../../../src/tools/methodology/qualifyProfile.js";
import { cleanupTmpDir } from "../../_helpers/tmp";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeIdentityPath(suffix: string): string {
  const dir = join(tmpdir(), `frondose-icp-precision-qp-owncompany-${process.pid}-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "config.json");
}

/** Isolate readIdentity()'s HOME/config.json lookup from the operator's real config
 *  (mirrors the established pattern in tests/tools/methodology/qualifyProfile.mock.test.ts). */
function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
  const tmpHome = mkdtempSync(join(tmpdir(), "frondose-icp-precision-home-"));
  const origHome = process.env.HOME;
  const origHomeBase = process.env.FRONDOSE_HOME_BASE;
  process.env.HOME = tmpHome;
  process.env.FRONDOSE_HOME_BASE = tmpHome;
  return fn().finally(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origHomeBase !== undefined) process.env.FRONDOSE_HOME_BASE = origHomeBase;
    else delete process.env.FRONDOSE_HOME_BASE;
    cleanupTmpDir(tmpHome);
  });
}

function writeIdentityFixture(configPath: string, fields: { company?: string; icp?: Record<string, unknown> }): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 2,
      identity: { fullName: "TestOperator", ...fields, updatedAt: new Date().toISOString() },
      updateServerUrl: null,
    }),
    "utf-8",
  );
}

async function callQualify(
  tool: ReturnType<typeof makeQualifyProfileTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const input = params as unknown as Parameters<typeof tool.execute>[0];
  const result = await tool.execute(input, { toolCallId: "test-icp-precision-qp-owncompany", messages: [] });
  return result as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// T-Qualify.OwnCompany.1 — end-to-end own-company disqualification via NAME
// ---------------------------------------------------------------------------

describe("qualify_profile own-company pre-check — name-substring disqualification (plan §5 T-Qualify.OwnCompany.1)", () => {
  it("T-Qualify.OwnCompany.1: given an identity with company='Mastars' and an ICP {targetRole:['VP Sales'], region:['Europe']}, when qualify_profile is called with role='VP Sales', region='London, Europe', companyName='Mastars Prototype Manufacturing', then the envelope's data.qualification is 'disqualified', data.score is 0, data.rationale matches /own_company/i, and data.detail.ownCompany.status is 'match' — EVEN THOUGH role+region individually would be 'match'", async () => {
    await withIsolatedHome(async () => {
      const configPath = makeIdentityPath("t1");
      try {
        writeIdentityFixture(configPath, {
          company: "Mastars",
          icp: { targetRole: ["VP Sales"], region: ["Europe"] },
        });
        const tool = makeQualifyProfileTool({ configPath });

        // When: qualify_profile is called with a profile that is a role+region
        //       match but is at the operator's OWN company (name substring).
        const envelope = await callQualify(tool, {
          role: "VP Sales",
          region: "London, Europe",
          companyName: "Mastars Prototype Manufacturing",
        });

        // Then: qualification=disqualified, score=0, rationale mentions own_company,
        //       detail.ownCompany.status="match" — despite role+region being a match.
        const data = (envelope as { data?: Record<string, unknown> }).data as Record<string, unknown>;
        const detail = data?.detail as Record<string, unknown>;
        assert.equal(data?.qualification, "disqualified", `expected disqualified; got ${JSON.stringify(envelope)}`);
        assert.equal(data?.score, 0, `expected score 0; got ${JSON.stringify(envelope)}`);
        assert.match(
          String(data?.rationale),
          /own_company/i,
          `rationale must mention own_company; got ${JSON.stringify(envelope)}`,
        );
        assert.equal(
          (detail?.ownCompany as Record<string, unknown>)?.status,
          "match",
          `detail.ownCompany.status must be "match"; got ${JSON.stringify(envelope)}`,
        );
      } finally {
        cleanupTmpDir(join(configPath, ".."));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// T-Qualify.OwnCompany.2 — non-own-company profile still runs ICP matcher
// ---------------------------------------------------------------------------

describe("qualify_profile own-company pre-check — non-match falls through to the ICP matcher, observability mismatch recorded (plan §5 T-Qualify.OwnCompany.2)", () => {
  it("T-Qualify.OwnCompany.2: given the same identity+ICP as T-Qualify.OwnCompany.1, when qualify_profile is called with a legitimate target (companyName='Acme SaaS', role='VP Sales', region='Berlin, Europe'), then data.qualification is 'qualified', data.detail.ownCompany.status is 'mismatch' (observability — the check ran and did not match), data.detail.role.status is 'match', and data.detail.region.status is 'match'", async () => {
    await withIsolatedHome(async () => {
      const configPath = makeIdentityPath("t2");
      try {
        writeIdentityFixture(configPath, {
          company: "Mastars",
          icp: { targetRole: ["VP Sales"], region: ["Europe"] },
        });
        const tool = makeQualifyProfileTool({ configPath });

        // When: qualify_profile is called with a genuinely different company.
        const envelope = await callQualify(tool, {
          role: "VP Sales",
          region: "Berlin, Europe",
          companyName: "Acme SaaS",
        });

        // Then: qualified overall; ownCompany dimension present as "mismatch" (observability);
        //       role + region dimensions independently "match".
        const data = (envelope as { data?: Record<string, unknown> }).data as Record<string, unknown>;
        const detail = data?.detail as Record<string, unknown>;
        assert.equal(data?.qualification, "qualified", `expected qualified; got ${JSON.stringify(envelope)}`);
        assert.equal(
          (detail?.ownCompany as Record<string, unknown>)?.status,
          "mismatch",
          `detail.ownCompany.status must be "mismatch" (observability); got ${JSON.stringify(envelope)}`,
        );
        assert.equal(
          (detail?.role as Record<string, unknown>)?.status,
          "match",
          `detail.role.status must be "match"; got ${JSON.stringify(envelope)}`,
        );
        assert.equal(
          (detail?.region as Record<string, unknown>)?.status,
          "match",
          `detail.region.status must be "match"; got ${JSON.stringify(envelope)}`,
        );
      } finally {
        cleanupTmpDir(join(configPath, ".."));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// T-Qualify.OwnCompany.3 — identity has no company signal → own-company check skipped
// ---------------------------------------------------------------------------

describe("qualify_profile own-company pre-check — skipped entirely when identity has no company signal (plan §5 T-Qualify.OwnCompany.3)", () => {
  it("T-Qualify.OwnCompany.3: given an identity with NO company set (blank), when qualify_profile is called with the SAME params as T-Qualify.OwnCompany.2 (a legitimate 'Acme SaaS' target), then data.detail.ownCompany is ABSENT from the payload entirely (not merely 'mismatch') and the existing ICP-matcher path runs unchanged", async () => {
    await withIsolatedHome(async () => {
      const configPath = makeIdentityPath("t3");
      try {
        writeIdentityFixture(configPath, {
          // No `company` at all.
          icp: { targetRole: ["VP Sales"], region: ["Europe"] },
        });
        const tool = makeQualifyProfileTool({ configPath });

        // When: qualify_profile is called with a legitimate-target profile.
        const envelope = await callQualify(tool, {
          role: "VP Sales",
          region: "Berlin, Europe",
          companyName: "Acme SaaS",
        });

        // Then: detail.ownCompany key must be entirely absent (not present with any status).
        const detail = (envelope as unknown as { data?: { detail?: Record<string, unknown> } } | undefined)?.data
          ?.detail;
        assert.ok(detail !== undefined, `detail must be defined; got envelope=${JSON.stringify(envelope)}`);
        assert.ok(
          !("ownCompany" in (detail as Record<string, unknown>)),
          `own-company check must be SKIPPED (key absent), not run-and-mismatch, when identity has no company signal; got detail=${JSON.stringify(detail)}`,
        );
      } finally {
        cleanupTmpDir(join(configPath, ".."));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// T-Qualify.OwnCompany.4 (no-ICP) — own-company fires BEFORE the `!icp` early
// return
// ---------------------------------------------------------------------------

describe("qualify_profile own-company pre-check — fires even when NO ICP is configured, not 'unknown' (plan §5 T-Qualify.OwnCompany.4)", () => {
  it("T-Qualify.OwnCompany.4: given an identity with company='Mastars' and NO icp block at all (and no icp override on the call), when qualify_profile is called with companyName='Mastars Prototype', then data.qualification is 'disqualified' (NOT 'unknown'), data.score is 0, and data.rationale matches /own_company/i — proving the own-company gate runs BEFORE the `!icp` early return", async () => {
    await withIsolatedHome(async () => {
      const configPath = makeIdentityPath("t4-no-icp");
      try {
        writeIdentityFixture(configPath, {
          company: "Mastars",
          // Deliberately NO `icp` field at all — the fixture omits the key
          // entirely (not merely an empty object), matching plan §5's "NO
          // icp block" premise and the operator's own state before the ICP
          // was ever configured.
        });
        const tool = makeQualifyProfileTool({ configPath });

        // When: qualify_profile is called with NO icp override, against a
        //       profile that is at the operator's OWN company (name match).
        const envelope = await callQualify(tool, {
          companyName: "Mastars Prototype",
        });

        // Then: qualification=disqualified (NOT "unknown"), score=0,
        //       rationale mentions own_company — the own-company gate must
        //       run BEFORE the tool's existing `!icp` early return.
        const data = (envelope as { data?: Record<string, unknown> }).data as Record<string, unknown>;
        assert.equal(data?.qualification, "disqualified", `expected disqualified; got ${JSON.stringify(envelope)}`);
        assert.notEqual(data?.qualification, "unknown", `must NOT be "unknown"; got ${JSON.stringify(envelope)}`);
        assert.equal(data?.score, 0, `expected score 0; got ${JSON.stringify(envelope)}`);
        assert.match(
          String(data?.rationale),
          /own_company/i,
          `rationale must mention own_company; got ${JSON.stringify(envelope)}`,
        );
      } finally {
        cleanupTmpDir(join(configPath, ".."));
      }
    });
  });
});
