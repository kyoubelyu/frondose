/**
 * P-57d Step 5 — T-Boundary.1, T-Boundary.2 — FILLED
 * (G-P57d.2 + G-P57d.4 [via single paragraph]; G-P57d.7 Soul UNCHANGED)
 *
 * Per source grep at Step 5 baseline (post-Step 4b):
 *   - boundary.ts L29-30 has the P-57d Tool-preference paragraph with both vision +
 *     search keywords (analyze_screenshot + inspect + vision_unavailable + web_search +
 *     MCP_SEARCH_URL + scope_disabled).
 *   - soul.ts exports SOUL constant without any P-57d keywords (verified absent).
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/agent/systemPrompt/boundary-p57d.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOUNDARY } from "../../../src/agent/systemPrompt/boundary.js";
import { composeSoulBand } from "../../../src/agent/systemPrompt/soul.js";

// Soul band is composed dynamically via composeSoulBand(identity); test with null to get
// the canonical placeholder soul band string (template + methodology distillation).
const SOUL = composeSoulBand(null);

// ─── T-Boundary.1 — Single P-57d paragraph; both vision + search directives ──

// P-71 update: header changed from "P-57d scope lock" to "P-71 scope lock"; MCP_SEARCH_URL removed from the paragraph.
describe("BOUNDARY constant — single P-71 tool-preference paragraph covering both vision + search (G-P57d.2 + G-P57d.4)", () => {
  it("T-Boundary.1: given BOUNDARY import, WHEN substring + count searches applied, THEN string contains EXACTLY ONE occurrence of 'Tool-preference hints (P-71 scope lock)' header; that paragraph contains BOTH 'analyze_screenshot' + 'inspect' (vision directive) AND 'web_search' + 'scope_disabled' (search directive)", () => {
    // Given: import { BOUNDARY }
    // P-71: paragraph header updated from P-57d to P-71; MCP_SEARCH_URL removed from text.
    assert.ok(typeof BOUNDARY === "string" && BOUNDARY.length > 0, "BOUNDARY must be non-empty exported string");

    // EXACTLY ONE occurrence of the P-71 paragraph header
    const matches = BOUNDARY.match(/Tool-preference hints \(P-71 scope lock\)/g) ?? [];
    assert.equal(
      matches.length,
      1,
      `BOUNDARY must contain EXACTLY ONE 'Tool-preference hints (P-71 scope lock)' header; got ${matches.length}`,
    );

    // Extract the paragraph after the header
    const headerIdx = BOUNDARY.indexOf("Tool-preference hints (P-71 scope lock)");
    assert.ok(headerIdx >= 0, "header index must be found");
    const remaining = BOUNDARY.slice(headerIdx);

    // BOTH vision + search keywords in the same paragraph
    assert.ok(remaining.includes("analyze_screenshot"), "P-71 paragraph must contain 'analyze_screenshot'");
    assert.ok(remaining.includes("inspect"), "P-71 paragraph must contain 'inspect'");
    assert.ok(remaining.includes("web_search"), "P-71 paragraph must contain 'web_search'");
    assert.ok(remaining.includes("scope_disabled"), "P-71 paragraph must contain 'scope_disabled'");
    assert.ok(remaining.includes("vision_unavailable"), "P-71 paragraph must contain 'vision_unavailable'");
    // MCP_SEARCH_URL removed in P-71 (web_search is unconditionally scope-disabled until future MCP phase)
    assert.ok(
      !remaining.includes("MCP_SEARCH_URL"),
      "P-71 paragraph must NOT contain 'MCP_SEARCH_URL' (removed in P-71)",
    );
  });
});

// ─── T-Boundary.2 — Soul UNCHANGED ──────────────────────────────────────────

describe("Soul band — UNCHANGED by P-57d per OQ-scope-4 LOCKED (G-P57d.7)", () => {
  it("T-Boundary.2: given SOUL import from src/agent/systemPrompt/soul.ts, WHEN substring searches applied for P-57d markers, THEN SOUL is a non-empty exported string + does NOT contain 'Tool-preference hints (P-57d scope lock)' / 'scope_disabled' / 'vision_unavailable' / 'MCP_SEARCH_URL' (P-57d directives belong in Boundary; Soul is identity/methodology only)", () => {
    assert.ok(typeof SOUL === "string" && SOUL.length > 0, "SOUL must be non-empty exported string");
    assert.ok(
      !SOUL.includes("Tool-preference hints (P-57d scope lock)"),
      "Soul must NOT contain P-57d Tool-preference header (Boundary's job)",
    );
    assert.ok(!SOUL.includes("scope_disabled"), "Soul must NOT contain 'scope_disabled'");
    assert.ok(!SOUL.includes("vision_unavailable"), "Soul must NOT contain 'vision_unavailable'");
    assert.ok(!SOUL.includes("MCP_SEARCH_URL"), "Soul must NOT contain 'MCP_SEARCH_URL'");
  });
});
