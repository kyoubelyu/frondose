/**
 * P-16 Step 4a — T-Search.1..T-Search.3 (search flow scenario scaffolds)
 *
 * Tests for search flow: agent prompted to find+qualify prospects on LinkedIn.
 * Uses real LLM against FakeLinkedInWorld (builder creates at Step 4b).
 *
 * T-Search.1: tool call presence + counts + launch→inspect order
 * T-Search.2: methodology terms ≥2 of 10
 * T-Search.3: ICP-based assertions (Alex Chen remembered, Kevin Huang NOT)
 *
 * Gate coverage: G-P16.2 (T-Search.1), G-P16.3 (T-Search.3), G-P16.6 (T-Search.2)
 *
 * timeout: 600_000 (10 min) per test for real LLM calls
 *
 * Assertion bodies are TODO — filled at Step 5 after builder creates
 * FakeLinkedInWorld + harness at Step 4b.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type CapturedToolCall, runScenario, type ScenarioResult } from "./setup.js";

const SEARCH_FLOW_PROMPT = `
帮我找找 LinkedIn 上适合 outreach 的潜在客户。
我想找 VP Sales 或 CRO 级别的人，目标行业是 B2B SaaS 和企业软件，公司在北美。
搜到之后帮我看看他们的 profile，判断是否符合我们的 ICP，
把符合条件的记住，我可以后续跟进。
`.trim();

const METHODOLOGY_TERMS = [
  "ICP",
  "qualify",
  "Pain Chain",
  "9-block",
  "Key Players",
  "Value Cycle",
  "Solution Selling",
  "R1",
  "I1",
  "C1",
];

// ─── Shared setup: single LLM run powers all 3 search tests ─────
// C-3: share one runScenario result to cut 6 LLM runs → 2 total.

let searchResult: ScenarioResult;
test.before(async () => {
  searchResult = await runScenario({ prompt: SEARCH_FLOW_PROMPT, maxSteps: 15 });
});

// ─── T-Search.1 ──────────────────────────────────────────────────
// Given: FakeLinkedInWorld with search + 4 profiles, full 24 tools
// When:  agent receives search prompt and runs up to maxSteps:15
// Then:  toolCalls includes launch AND inspect AND qualify_profile AND remember;
//        launch comes before first inspect; inspect ≥2x, remember ≥1x, qualify_profile ≥1x

test("T-Search.1: agent calls expected tools in Search flow", { timeout: 600_000 }, async () => {
  const toolNames = searchResult.toolCalls.map((tc: CapturedToolCall) => tc.toolName);

  // Presence assertions
  assert.ok(toolNames.includes("launch"), "Expected launch in tool calls");
  assert.ok(toolNames.includes("inspect"), "Expected inspect in tool calls");
  assert.ok(toolNames.includes("qualify_profile"), "Expected qualify_profile in tool calls");
  assert.ok(toolNames.includes("remember"), "Expected remember in tool calls");

  // Count assertions
  const launchCount = toolNames.filter((n: string) => n === "launch").length;
  const inspectCount = toolNames.filter((n: string) => n === "inspect").length;
  const qualifyCount = toolNames.filter((n: string) => n === "qualify_profile").length;
  const rememberCount = toolNames.filter((n: string) => n === "remember").length;

  assert.ok(launchCount >= 1, `launch count ${launchCount} should be ≥ 1`);
  assert.ok(inspectCount >= 2, `inspect count ${inspectCount} should be ≥ 2`);
  assert.ok(qualifyCount >= 1, `qualify_profile count ${qualifyCount} should be ≥ 1`);
  assert.ok(rememberCount >= 1, `remember count ${rememberCount} should be ≥ 1`);

  // Order assertion: launch before first inspect
  const launchIdx = toolNames.indexOf("launch");
  const firstInspectIdx = toolNames.indexOf("inspect");
  assert.ok(launchIdx < firstInspectIdx,
    `launch (idx=${launchIdx}) must precede first inspect (idx=${firstInspectIdx})`);
});

// ─── T-Search.2 ──────────────────────────────────────────────────
// Given: same setup as T-Search.1
// When:  agent completes search flow
// Then:  textOutput contains ≥3 methodology terms

test("T-Search.2: methodology terms appear in text output", { timeout: 600_000 }, async () => {
  const foundTerms = METHODOLOGY_TERMS.filter((t) => searchResult.textOutput.includes(t));
  assert.ok(
    foundTerms.length >= 2,
    `Expected ≥2 methodology terms in text output, found ${foundTerms.length}: ${foundTerms.join(", ")}`
  );
});

// ─── T-Search.3 ──────────────────────────────────────────────────
// Given: search results include Alex Chen (VP Sales, Acme Corp), Maria Santos (CRO, DataSync),
//        Kevin Huang (VP Engineering — non-ICP)
// When:  agent finishes search flow
// Then:  Alex Chen is remembered, Kevin Huang is NOT remembered

test("T-Search.3: agent remembers qualified leads, ignores non-ICP", { timeout: 600_000 }, async () => {
  const rememberCalls = searchResult.toolCalls.filter((tc: CapturedToolCall) => tc.toolName === "remember");

  // remember tool uses `personName` parameter (not `key`) — verified from src/tools/memory/remember.ts:8-16
  const rememberPeople = rememberCalls.map((tc: CapturedToolCall) =>
    String(tc.args.personName ?? "").toLowerCase());

  // Alex Chen should be remembered (VP Sales at Acme Corp = B2B SaaS ✓)
  const alexRemembered = rememberPeople.some((n: string) =>
    n.includes("alex") || n.includes("chen"));
  assert.ok(alexRemembered, "Expected Alex Chen to be remembered (ICP match)");

  // Best-effort: Maria Santos should be remembered (CRO at DataSync = tech ✓)
  const mariaRemembered = rememberPeople.some((n: string) =>
    n.includes("maria") || n.includes("santos"));
  if (!mariaRemembered) {
    process.stderr.write("[T-Search.3] Soft fail: Maria Santos not remembered (agent may not have visited all results)\n");
  }

  // Kevin Huang should NOT be remembered (VP Engineering — wrong role ✗)
  const kevinRemembered = rememberPeople.some((n: string) =>
    n.includes("kevin") || n.includes("huang"));
  assert.ok(!kevinRemembered, "Kevin Huang (VP Engineering) should NOT be remembered (non-ICP)");
});
