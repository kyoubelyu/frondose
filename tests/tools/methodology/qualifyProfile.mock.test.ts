/**
 * P-5 mock tests — T-M_p5.14..T-M_p5.15: qualify_profile tool.
 *
 * Tests:
 *   T-M_p5.14 — Tool returns correct `ok` envelope shape (G-P5.3)
 *   T-M_p5.15 — Tool reads identity.json ICP when `icp` arg omitted; uses override when provided (G-P5.3, OQ-6)
 *
 * No Chrome, no LLM required. Uses OS tmpdir for identity fixture.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeQualifyProfileTool } from "../../../src/tools/methodology/qualifyProfile.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTempPath(suffix: string): string {
  const dir = join(tmpdir(), `mai-p5-qp-${process.pid}-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "identity.json");
}

function cleanup(path: string): void {
  try {
    rmSync(join(path, ".."), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ─── T-M_p5.14 — Envelope shape ──────────────────────────────────────────────

test("T-M_p5.14: qualify_profile returns ok envelope with qualification/score/matched/missing/rationale", async () => {
  // HOME override: makeQualifyProfileTool calls readIdentity(identityPath) which checks
  // DEFAULT_CONFIG_PATH() (HOME-relative) first. Without override, operator's ICP would
  // be used instead of the fixture ICP, making qualification assertions unpredictable.
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-p44-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const identityPath = makeTempPath("envelope");
  try {
    // Write identity with ICP
    writeFileSync(
      identityPath,
      JSON.stringify({
        fullName: "TestUser",
        company: "TestCo",
        icp: { targetRole: ["CTO"] },
        updatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );

    const tool = makeQualifyProfileTool({ identityPath });
    // Invoke the execute function directly (Vercel tool shape)
    const result = await tool.execute(
      { role: "CTO", industry: undefined, region: undefined, companyName: undefined, icp: undefined },
      { toolCallId: "test-t-m-p5-14", messages: [] },
    );

    // Use unknown as intermediate to avoid TS type overlap issues (union return type)
    const r = result as unknown as Record<string, unknown>;

    // Must be an ok envelope
    assert.ok(typeof r === "object" && r !== null, "T-M_p5.14: result must be object");
    assert.equal(r.ok, true, "T-M_p5.14: result.ok must be true");
    assert.equal(r.command, "qualify_profile", "T-M_p5.14: result.command must be 'qualify_profile'");

    const data = r.data as Record<string, unknown>;
    assert.ok(typeof data === "object" && data !== null, "T-M_p5.14: result.data must be object");
    assert.ok("qualification" in data, "T-M_p5.14: data.qualification must be present");
    assert.ok("score" in data, "T-M_p5.14: data.score must be present");
    assert.ok("matched" in data, "T-M_p5.14: data.matched must be present");
    assert.ok("missing" in data, "T-M_p5.14: data.missing must be present");
    assert.ok("rationale" in data, "T-M_p5.14: data.rationale must be present");

    // For CTO role matching CTO ICP → qualified
    assert.equal(data.qualification, "qualified", "T-M_p5.14: CTO→CTO ICP must be 'qualified'");
    assert.equal(data.score, 1.0, "T-M_p5.14: qualified score must be 1.0");
    assert.ok(Array.isArray(data.matched), "T-M_p5.14: matched must be array");
    assert.ok(Array.isArray(data.missing), "T-M_p5.14: missing must be array");
    assert.ok(typeof data.rationale === "string", "T-M_p5.14: rationale must be string");
    assert.ok((data.matched as string[]).includes("role"), "T-M_p5.14: matched must include 'role'");

    console.log(
      `T-M_p5.14: qualify_profile envelope correct — qualification=${data.qualification}, score=${data.score} ✓`,
    );
  } finally {
    cleanup(identityPath);
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ─── T-M_p5.15 — Default ICP from identity.json; override works ──────────────

test("T-M_p5.15: qualify_profile uses identity.json ICP by default; explicit icp override takes precedence", async () => {
  // HOME override: readIdentity() checks DEFAULT_CONFIG_PATH() (HOME-relative) first.
  // Without override, operator's ICP shadows the fixture ICP, breaking T-M_p5.15a.
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-p44-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const identityPath = makeTempPath("default-icp");
  try {
    // Identity has ICP: targetRole = ["VP Engineering"]
    writeFileSync(
      identityPath,
      JSON.stringify({
        fullName: "TestUser",
        company: "TestCo",
        icp: { targetRole: ["VP Engineering"] },
        updatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );

    const tool = makeQualifyProfileTool({ identityPath });

    // 1. No explicit icp → reads identity.json ICP (targetRole=VP Engineering)
    //    evidence role=VP Engineering → should match → qualified
    const defaultResult = await tool.execute(
      { role: "VP Engineering", icp: undefined },
      { toolCallId: "test-t-m-p5-15a", messages: [] },
    );
    const defaultData = (defaultResult as unknown as Record<string, unknown>).data as Record<string, unknown>;
    assert.equal(
      defaultData.qualification,
      "qualified",
      `T-M_p5.15a: default ICP from identity.json — expected 'qualified' for VP Engineering matching VP Engineering ICP`,
    );

    // 2. explicit icp override → uses override (targetRole=CTO), not identity ICP
    //    evidence role=VP Engineering → no match against CTO ICP → disqualified
    const overrideResult = await tool.execute(
      {
        role: "VP Engineering",
        icp: { targetRole: ["CTO"] },
      },
      { toolCallId: "test-t-m-p5-15b", messages: [] },
    );
    const overrideData = (overrideResult as unknown as Record<string, unknown>).data as Record<string, unknown>;
    assert.equal(
      overrideData.qualification,
      "disqualified",
      `T-M_p5.15b: explicit ICP override — expected 'disqualified' for VP Engineering against CTO ICP override`,
    );

    // 3. No ICP in identity.json, no explicit icp → returns "unknown" with rationale
    const noIcpPath = makeTempPath("no-icp");
    try {
      writeFileSync(
        noIcpPath,
        JSON.stringify({
          fullName: "TestUser",
          company: "TestCo",
          updatedAt: new Date().toISOString(),
          // no icp field
        }),
        "utf-8",
      );
      const toolNoIcp = makeQualifyProfileTool({ identityPath: noIcpPath });
      const noIcpResult = await toolNoIcp.execute(
        { role: "CTO", icp: undefined },
        { toolCallId: "test-t-m-p5-15c", messages: [] },
      );
      const noIcpData = (noIcpResult as unknown as Record<string, unknown>).data as Record<string, unknown>;
      assert.equal(noIcpData.qualification, "unknown", `T-M_p5.15c: no ICP configured → expected 'unknown'`);
      assert.ok(
        typeof noIcpData.rationale === "string" && (noIcpData.rationale as string).includes("No ICP configured"),
        `T-M_p5.15c: rationale must mention 'No ICP configured'`,
      );
    } finally {
      cleanup(noIcpPath);
    }

    console.log("T-M_p5.15: qualify_profile ICP default/override behavior verified ✓");
  } finally {
    cleanup(identityPath);
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
