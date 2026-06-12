/**
 * P-57d Step 5 — T-Boundary.1, T-Boundary.2 — FILLED
 * (G-P57d.2 + G-P57d.4 [via single paragraph]; G-P57d.7 Soul UNCHANGED)
 *
 * P-BRAVE-MCP update:
 *   - Boundary still has one Tool-preference paragraph with both vision + search
 *     keywords (analyze_screenshot + inspect + vision_unavailable + web_search).
 *   - Search guidance now says Brave Search MCP when configured and missing_config
 *     fallback, not unconditional P-71 scope_disabled/future MCP.
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

// ─── T-Boundary.1 — Single paragraph; both vision + Brave MCP search directives ──

describe("BOUNDARY constant — tool-preference paragraph covering vision + Brave MCP search", () => {
  it("T-Boundary.1: given BOUNDARY import, WHEN substring + count searches applied, THEN string contains one tool-preference header; that paragraph contains vision guidance plus web_search via Brave Search MCP with missing_config fallback", () => {
    // Given: import { BOUNDARY }
    assert.ok(typeof BOUNDARY === "string" && BOUNDARY.length > 0, "BOUNDARY must be non-empty exported string");

    // EXACTLY ONE occurrence of the tool-preference paragraph header
    const matches = BOUNDARY.match(/Tool-preference hints/g) ?? [];
    assert.equal(
      matches.length,
      1,
      `BOUNDARY must contain EXACTLY ONE tool-preference header; got ${matches.length}`,
    );

    // Extract the paragraph after the header
    const headerIdx = BOUNDARY.indexOf("Tool-preference hints");
    assert.ok(headerIdx >= 0, "header index must be found");
    const remaining = BOUNDARY.slice(headerIdx);

    // BOTH vision + search keywords in the same paragraph
    assert.ok(remaining.includes("analyze_screenshot"), "tool-preference paragraph must contain 'analyze_screenshot'");
    assert.ok(remaining.includes("inspect"), "tool-preference paragraph must contain 'inspect'");
    assert.ok(remaining.includes("web_search"), "tool-preference paragraph must contain 'web_search'");
    assert.ok(remaining.includes("Brave Search MCP"), "tool-preference paragraph must mention Brave Search MCP");
    assert.ok(remaining.includes("missing_config"), "tool-preference paragraph must mention missing_config fallback");
    assert.ok(remaining.includes("vision_unavailable"), "tool-preference paragraph must contain 'vision_unavailable'");
    assert.ok(
      !remaining.includes("MCP_SEARCH_URL"),
      "tool-preference paragraph must NOT route search through MCP_SEARCH_URL",
    );
    assert.ok(
      !/web_search`? is scope-disabled during P-71|future MCP/i.test(remaining),
      "tool-preference paragraph must not say web_search is unconditionally P-71-disabled or future-only",
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
