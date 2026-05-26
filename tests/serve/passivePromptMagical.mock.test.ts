/**
 * P-SP-C scaffold — T-SP-C.Passive.1..3 (F-8)
 * buildPassivePrompt profile-nav branch: Magical-mode tool-sequence text contract.
 *
 * Step 4a: assertion bodies are TODO stubs — ALL FAIL pre-builder.
 * Step 5:  builder replaces profile-nav branch in passive.ts (F-5 §5.5) → assertions filled.
 *
 * NOTE: `buildPassivePrompt` is currently a PRIVATE function inside the
 * `createPassiveHandlers` closure in `src/cli/subcommands/serve/passive.ts`.
 * For these tests to work, builder must export it as a named export from that
 * module (e.g., `export { buildPassivePrompt }` or move it to module level).
 * This requirement is explicitly documented in the scaffold so builder is aware.
 * Dynamic import defers resolution.
 *
 * If builder cannot export it without a significant refactor, validator will file
 * a Step 5a routing note and test via an integration path (triggerPassiveAnalysis
 * mock with a spy on the generated prompt string).
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/serve/passivePromptMagical.mock.test.ts
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// Dynamic import — defers to test-run time when builder has added the export.
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder scaffold
let buildPassivePrompt: ((eventType: string, ctx: Record<string, unknown>) => string) | any;

describe("T-SP-C.Passive — buildPassivePrompt Magical-mode profile-nav branch (P-SP-C)", () => {
  before(async () => {
    // TODO (builder F-5 Step 4b): export `buildPassivePrompt` from passive.ts.
    const mod = await import(
      "../../src/cli/subcommands/serve/passive.js"
    ).catch(() => null);
    if (mod && typeof mod.buildPassivePrompt === "function") {
      buildPassivePrompt = mod.buildPassivePrompt;
    }
  });

  // ─── T-SP-C.Passive.1 ────────────────────────────────────────────────────────
  it(
    "T-SP-C.Passive.1: profile-nav prompt contains kernel-tool sequence keywords + candidateId + NO outbound imperatives",
    () => {
      // Given: new buildPassivePrompt("profile-nav", {handle:"alice-vp",
      //   url:"https://www.linkedin.com/in/alice-vp/"})
      // When:  returned string inspected via substring checks (two passes)
      // Then POSITIVE: ALL of these substrings present:
      //   "record_raw_candidate", "search_memory", "score_lead", "suggest_card",
      //   "candidateId", "alice-vp", "https://www.linkedin.com/in/alice-vp/"
      // Then NEGATIVE: prompt's Step directives must NOT name outbound tools as
      //   actions (only as prohibition). Hard constraint line must be present.
      //   Covers G-SP-C.5
      assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
    },
  );

  // ─── T-SP-C.Passive.2 ────────────────────────────────────────────────────────
  it(
    "T-SP-C.Passive.2: profile-nav prompt instructs agent to thread candidateId from step 1 into step 3",
    () => {
      // Given: new buildPassivePrompt("profile-nav", {handle:"alice-vp",
      //   url:"https://www.linkedin.com/in/alice-vp/"})
      // When:  returned string searched for candidateId threading instruction
      // Then:  prompt contains substring "candidateId: <from step 1>" (or equivalent)
      //   Covers G-SP-C.5 — OQ-A3 FK threading (agent explicitly told to read
      //   candidateId from step 1 response and pass to step 3 score_lead call)
      assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
    },
  );

  // ─── T-SP-C.Passive.3 ────────────────────────────────────────────────────────
  it(
    "T-SP-C.Passive.3: click + input branches UNCHANGED — still contain 'remember' and 'stop'",
    () => {
      // Given: buildPassivePrompt("click", {url:"https://www.linkedin.com/feed/",
      //   ref:{ariaLabel:"Like something", controlName:"Like", text:"Like"}})
      // AND:   buildPassivePrompt("input", {url:"https://www.linkedin.com/...",
      //   charCount: 30, snippet: "hi there"})
      // When:  both returned strings inspected
      // Then:  CLICK prompt contains "remember" and "stop" (pre-P-SP-C behavior unchanged)
      //        INPUT prompt contains "remember" and "stop" (pre-P-SP-C behavior unchanged)
      //   Covers G-SP-C.6 — NG-3 + NG-4 scope discipline: Part A did NOT touch click/input
      assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
    },
  );
});
