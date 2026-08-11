/**
 * T-ICP-PRECISION Step 2 (validator, Sonnet) — scaffolds, all-failing.
 *
 * Source-under-test: `makeQualifyProfileTool` in
 * `src/tools/methodology/qualifyProfile.ts`. Unlike T-3, this file pins
 * behavior that ALREADY EXISTS TODAY per plan §0: the `icp` override param
 * (`qualifyProfileParams.icp`) already wins over the cached identity ICP at
 * `qualifyProfile.ts:52 (params.icp ?? getDefaultIcp())`. Design (A)
 * (operator live-input override) rides on this EXISTING seam — no production
 * change is required for these two specific assertions. This file's purpose
 * is to PIN the mechanism so the soul-band habit line (F-5, which teaches the
 * LLM to use this seam) has a locked contract to rely on, and so a future
 * regression that breaks the override is caught.
 *
 * COMPILE APPROACH: plain static import — `makeQualifyProfileTool` and the
 * `icp` override param already exist unchanged; nothing new is referenced.
 * Compiles clean today. Per CLAUDE.md § Test Discipline, this file's
 * assertions are STILL unconditional `assert.fail("TODO Step 5: …")`
 * placeholders (the whole Step-2 suite must be RED), even though a hand-run
 * of the real call would already produce the expected result.
 *
 * Gates covered: plan §5 T-Qualify.OverrideICP.1–2 — pins the pre-existing
 * `qualify_profile.icp` override seam (design A).
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
  const dir = join(tmpdir(), `frondose-icp-precision-qp-override-${process.pid}-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "config.json");
}

function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
  const tmpHome = mkdtempSync(join(tmpdir(), "frondose-icp-precision-home-override-"));
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

function writeIdentityFixture(configPath: string, icp: Record<string, unknown>): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 2,
      identity: { fullName: "TestOperator", company: "Mastars", icp, updatedAt: new Date().toISOString() },
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
  const result = await tool.execute(input, { toolCallId: "test-icp-precision-qp-override", messages: [] });
  return result as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// T-Qualify.OverrideICP.1 — operator live-input override wins
// ---------------------------------------------------------------------------

describe("qualify_profile icp override — operator's live-turn ICP overrides the standing ICP (plan §5 T-Qualify.OverrideICP.1, design A)", () => {
  it("T-Qualify.OverrideICP.1: given a standing identity ICP {targetRole:['VP Sales'], region:['Europe','United States']}, when qualify_profile is called with icp override {targetRole:['Procurement Manager'], region:['Hong Kong']} AND role='Procurement Manager', region='Hong Kong', then data.qualification is 'qualified' — the standing ICP is NOT consulted; the override wins entirely", async () => {
    await withIsolatedHome(async () => {
      const configPath = makeIdentityPath("t1");
      try {
        writeIdentityFixture(configPath, { targetRole: ["VP Sales"], region: ["Europe", "United States"] });
        const tool = makeQualifyProfileTool({ configPath });

        // When: qualify_profile is called WITH an icp override naming an
        //       out-of-standing-region target (Hong Kong).
        const envelope = await callQualify(tool, {
          role: "Procurement Manager",
          region: "Hong Kong",
          icp: { targetRole: ["Procurement Manager"], region: ["Hong Kong"] },
        });

        // Then: qualification === "qualified" (override wins; standing ICP ignored).
        const data = (envelope as { data?: Record<string, unknown> }).data as Record<string, unknown>;
        assert.equal(
          data?.qualification,
          "qualified",
          `icp override must win over standing ICP; got ${JSON.stringify(envelope)}`,
        );
      } finally {
        cleanupTmpDir(join(configPath, ".."));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// T-Qualify.OverrideICP.2 — no override → standing ICP applies (off-by-default)
// ---------------------------------------------------------------------------

describe("qualify_profile icp override — off by default, standing ICP applies with no override param (plan §5 T-Qualify.OverrideICP.2)", () => {
  it("T-Qualify.OverrideICP.2: given the SAME standing identity ICP as T-Qualify.OverrideICP.1, when qualify_profile is called with NO icp param and role='Procurement Manager', region='Hong Kong', then data.qualification is 'disqualified' (region mismatch under the standing 欧美 ICP) — proves the override mechanism is off-by-default, not always-on", async () => {
    await withIsolatedHome(async () => {
      const configPath = makeIdentityPath("t2");
      try {
        writeIdentityFixture(configPath, { targetRole: ["VP Sales"], region: ["Europe", "United States"] });
        const tool = makeQualifyProfileTool({ configPath });

        // When: qualify_profile is called with NO icp override — a Hong Kong
        //       procurement candidate that mismatches the standing 欧美 ICP.
        const envelope = await callQualify(tool, {
          role: "Procurement Manager",
          region: "Hong Kong",
        });

        // Then: qualification === "disqualified" (standing ICP applies; region mismatch).
        const data = (envelope as { data?: Record<string, unknown> }).data as Record<string, unknown>;
        assert.equal(
          data?.qualification,
          "disqualified",
          `no override → standing ICP must fire (role/region mismatch); got ${JSON.stringify(envelope)}`,
        );
      } finally {
        cleanupTmpDir(join(configPath, ".."));
      }
    });
  });
});
