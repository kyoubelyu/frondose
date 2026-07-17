/**
 * P-FIX-ICP-STALE-CACHE mock tests — T-ICP-Stale.1/.2: qualify_profile must reflect a
 * Settings-saved ICP WITHOUT a sidecar restart.
 *
 * Root cause (see docs/phase-P-FIX-ICP-STALE-CACHE-plan.md): makeQualifyProfileTool used to
 * cache identity/ICP in a closure for the whole process lifetime, so a `POST /settings` save
 * (via `applySettings`, the real write path) was invisible to an already-built tool object
 * until restart. Fix: read identity fresh per invocation (no caching).
 *
 * describe/it + Given/When/Then per CLAUDE.md § Test Discipline.
 *
 * No Chrome, no LLM required. Uses OS tmpdir for HOME override (config.json lives under it).
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { applySettings } from "../../../src/cli/subcommands/serve/settings.js";
import { makeQualifyProfileTool } from "../../../src/tools/methodology/qualifyProfile.js";
import { cleanupTmpDir } from "../../_helpers/tmp";

describe("qualify_profile reflects a live Settings save without a sidecar restart (P-FIX-ICP-STALE-CACHE)", () => {
  it("T-ICP-Stale.1: given no ICP configured, when qualify_profile is invoked, then it reports 'No ICP configured' (regression pin — unchanged behavior)", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mai-icpstale-home-"));
    const origHome = process.env.HOME;
    const origHomeBase = process.env.FRONDOSE_HOME_BASE;
    process.env.HOME = tmpHome;
    process.env.FRONDOSE_HOME_BASE = tmpHome;
    try {
      const identityPath = join(tmpHome, "identity.json"); // never written in this test — legacy fallback also empty
      const tool = makeQualifyProfileTool({ identityPath });

      const result = await tool.execute(
        { role: "CTO", industry: undefined, region: undefined, companyName: undefined, icp: undefined },
        { toolCallId: "test-icp-stale-1", messages: [] },
      );
      const r = result as unknown as Record<string, unknown>;
      const data = r.data as Record<string, unknown>;

      assert.equal(data.qualification, "unknown", "T-ICP-Stale.1: no ICP → qualification 'unknown'");
      assert.match(
        data.rationale as string,
        /No ICP configured/,
        "T-ICP-Stale.1: rationale must report 'No ICP configured'",
      );
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
      if (origHomeBase !== undefined) process.env.FRONDOSE_HOME_BASE = origHomeBase;
      else delete process.env.FRONDOSE_HOME_BASE;
      cleanupTmpDir(tmpHome);
    }
  });

  it("T-ICP-Stale.2: given the SAME tool object (no restart), when a Settings save persists an ICP via applySettings (the real POST /settings write path), then the NEXT qualify_profile call sees it — no more 'No ICP configured'", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mai-icpstale-home-"));
    const origHome = process.env.HOME;
    const origHomeBase = process.env.FRONDOSE_HOME_BASE;
    process.env.HOME = tmpHome;
    process.env.FRONDOSE_HOME_BASE = tmpHome;
    try {
      const identityPath = join(tmpHome, "identity.json"); // legacy fallback path; config.json is authoritative
      const tool = makeQualifyProfileTool({ identityPath }); // built ONCE — never rebuilt below, simulating no restart

      // Pre-condition: no ICP yet.
      const before = (await tool.execute(
        { role: "CTO", industry: undefined, region: undefined, companyName: undefined, icp: undefined },
        { toolCallId: "test-icp-stale-2-before", messages: [] },
      )) as unknown as Record<string, unknown>;
      const beforeData = before.data as Record<string, unknown>;
      assert.match(
        beforeData.rationale as string,
        /No ICP configured/,
        "T-ICP-Stale.2: pre-condition must be 'No ICP configured'",
      );

      // The real write path: same call `POST /settings` → handlePostSettings makes on a save.
      applySettings({ identity: { icp: { targetRole: ["CTO"] } } });

      // Same tool object, no rebuild — this is the regression check: it must NOT still be cached.
      const after = (await tool.execute(
        { role: "CTO", industry: undefined, region: undefined, companyName: undefined, icp: undefined },
        { toolCallId: "test-icp-stale-2-after", messages: [] },
      )) as unknown as Record<string, unknown>;
      const afterData = after.data as Record<string, unknown>;

      assert.doesNotMatch(
        afterData.rationale as string,
        /No ICP configured/,
        "T-ICP-Stale.2: after a live Settings save, the SAME tool object must stop reporting 'No ICP configured'",
      );
      assert.equal(afterData.qualification, "qualified", "T-ICP-Stale.2: CTO role now matches the saved CTO ICP");
      assert.ok(
        (afterData.matched as string[]).includes("role"),
        "T-ICP-Stale.2: matched must include 'role' once the ICP is visible",
      );
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
      if (origHomeBase !== undefined) process.env.FRONDOSE_HOME_BASE = origHomeBase;
      else delete process.env.FRONDOSE_HOME_BASE;
      cleanupTmpDir(tmpHome);
    }
  });
});
