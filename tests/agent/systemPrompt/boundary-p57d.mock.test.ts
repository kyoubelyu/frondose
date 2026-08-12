/**
 * P-57d Step 5 — T-Boundary.1, T-Boundary.2 — FILLED
 * (G-P57d.2 + G-P57d.4 [via single paragraph]; G-P57d.7 Soul UNCHANGED)
 *
 * P-WEB-SEARCH-MCP-SCOPE → P-EXT-SEARCH realign (2026-08-12):
 *   - Boundary still has one Tool-preference paragraph with both vision + search
 *     keywords (analyze_screenshot + inspect + vision_unavailable + web_search).
 *   - Search guidance now says Brave Search API with missing_config/search_error fallback.
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

// ─── T-Boundary.1 — Single paragraph; both vision + Brave Search directives ──

describe("BOUNDARY constant — tool-preference paragraph covering vision + Brave Search", () => {
  it("T-Boundary.1: tool-preference guidance carries vision plus Brave web_search and visible failure fallback", () => {
    // Given: import { BOUNDARY }
    assert.ok(typeof BOUNDARY === "string" && BOUNDARY.length > 0, "BOUNDARY must be non-empty exported string");

    // EXACTLY ONE occurrence of the tool-preference paragraph header
    const matches = BOUNDARY.match(/Tool-preference hints/g) ?? [];
    assert.equal(matches.length, 1, `BOUNDARY must contain EXACTLY ONE tool-preference header; got ${matches.length}`);

    // Extract the paragraph after the header
    const headerIdx = BOUNDARY.indexOf("Tool-preference hints");
    assert.ok(headerIdx >= 0, "header index must be found");
    const remaining = BOUNDARY.slice(headerIdx);

    // BOTH vision + search keywords in the same paragraph
    assert.ok(remaining.includes("analyze_screenshot"), "tool-preference paragraph must contain 'analyze_screenshot'");
    assert.ok(remaining.includes("inspect"), "tool-preference paragraph must contain 'inspect'");
    assert.ok(remaining.includes("web_search"), "tool-preference paragraph must contain 'web_search'");
    assert.match(remaining, /Brave Search API/i);
    assert.ok(remaining.includes("missing_config"), "tool-preference paragraph must mention missing_config fallback");
    assert.ok(remaining.includes("search_error"), "tool-preference paragraph must mention search_error fallback");
    assert.ok(remaining.includes("vision_unavailable"), "tool-preference paragraph must contain 'vision_unavailable'");
    assert.doesNotMatch(remaining, /operator-configured MCP server|MCP_SEARCH_URL|mcp_error|Tavily/i);
  });
});

// ─── T-Boundary.2 — Soul UNCHANGED ──────────────────────────────────────────

describe("Soul band — base identity/methodology remains free of Boundary-only runtime directives", () => {
  it("T-Boundary.2: base SOUL excludes tool-preference/runtime-failure markers", () => {
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
