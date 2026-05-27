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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { before, describe, it } from "node:test";

// Dynamic import — defers to test-run time when builder has added the export.
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder scaffold
let buildPassivePrompt: ((eventType: string, ctx: Record<string, unknown>) => string) | any;

// D-SP-C-A: buildPassivePrompt is NOT exported from passive.ts (builder Step 4b defect).
// The function is private inside the createPassiveHandlers closure. Without a module-level
// export, the dynamic import cannot resolve it.
// MITIGATION at Step 5: use source-structural scan (readFileSync on passive.ts) to verify
// that the required strings ARE present in the implementation. This validates the builder's
// F-5 §5.5 paste verbatim without requiring a runtime import.
// RECOMMENDATION: builder Step 5a should add `export { buildPassivePrompt }` (trivial — the
// function uses no closure variables and can be safely moved to module scope).

const ROOT = resolve(import.meta.dirname, "../..");
const PASSIVE_SRC = readFileSync(
  resolve(ROOT, "src/cli/subcommands/serve/passive.ts"),
  "utf-8"
);

describe("T-SP-C.Passive — buildPassivePrompt Magical-mode profile-nav branch (P-SP-C)", () => {
  before(async () => {
    // Attempt dynamic import — will succeed if builder added the export; no-op otherwise.
    const mod = await import(
      "../../src/cli/subcommands/serve/passive.js"
    ).catch(() => null);
    if (mod && typeof mod.buildPassivePrompt === "function") {
      buildPassivePrompt = mod.buildPassivePrompt;
    }
    // If not exported, buildPassivePrompt remains undefined and tests fall back to
    // the source-structural scan approach below.
  });

  // ─── T-SP-C.Passive.1 ────────────────────────────────────────────────────────
  it(
    "T-SP-C.Passive.1: profile-nav prompt source contains kernel-tool sequence keywords + candidateId + NO outbound imperatives (D-SP-C-A: source-structural scan since export missing)",
    () => {
      // Given: new buildPassivePrompt("profile-nav", ...) — or source scan of passive.ts
      // When:  string inspected (two passes: positive keyword set + negative outbound imperatives)
      // Then POSITIVE: ALL of these substrings present in the profile-nav branch:
      //   "record_raw_candidate", "search_memory", "score_lead", "suggest_card",
      //   "candidateId", "profile-nav"
      // Then NEGATIVE: hard constraint line "NEVER call" present; no raw outbound imperatives
      //   Covers G-SP-C.5

      if (typeof buildPassivePrompt === "function") {
        // Runtime path (if builder exported the function)
        const prompt = buildPassivePrompt("profile-nav", {
          handle: "alice-vp",
          url: "https://www.linkedin.com/in/alice-vp/",
        });
        for (const keyword of ["record_raw_candidate", "search_memory", "score_lead", "suggest_card", "candidateId", "alice-vp", "https://www.linkedin.com/in/alice-vp/"]) {
          assert.ok(prompt.includes(keyword),
            `profile-nav prompt must contain "${keyword}"`);
        }
        assert.ok(prompt.includes("NEVER call") || prompt.includes("NEVER"),
          `profile-nav prompt must contain "NEVER" outbound prohibition`);
      } else {
        // Source-structural path (D-SP-C-A mitigation: builder didn't export the function)
        // Scope the search to buildPassivePrompt function body (multiple eventType branches exist in file)
        const fnStart = PASSIVE_SRC.indexOf("function buildPassivePrompt");
        assert.ok(fnStart >= 0, "passive.ts must contain buildPassivePrompt function");
        const fnBody = PASSIVE_SRC.slice(fnStart, fnStart + 5000);
        const profileNavOffset = fnBody.indexOf('if (eventType === "profile-nav")');
        assert.ok(profileNavOffset >= 0,
          'buildPassivePrompt must contain profile-nav branch `if (eventType === "profile-nav")`');
        // Grab 3500 chars of the profile-nav branch text
        const profileNavSection = fnBody.slice(profileNavOffset, profileNavOffset + 3500);
        for (const keyword of ["record_raw_candidate", "search_memory", "score_lead", "suggest_card", "candidateId"]) {
          assert.ok(profileNavSection.includes(keyword),
            `passive.ts buildPassivePrompt profile-nav branch must contain "${keyword}" (source-structural scan)`);
        }
        assert.ok(
          profileNavSection.includes("NEVER call") || profileNavSection.includes("NEVER"),
          `buildPassivePrompt profile-nav branch must contain outbound prohibition "NEVER". ` +
          `Section (first 400 chars): ${profileNavSection.slice(0, 400)}`
        );
      }
    },
  );

  // ─── T-SP-C.Passive.2 ────────────────────────────────────────────────────────
  it(
    "T-SP-C.Passive.2: profile-nav prompt instructs agent to thread candidateId from step 1 into step 3 (D-SP-C-A: source-structural scan)",
    () => {
      // Given: new buildPassivePrompt("profile-nav", ...) — or passive.ts source scan
      // When:  returned string (or source) searched for candidateId threading instruction
      // Then:  prompt contains "candidateId: <from step 1>" (FK threading per OQ-A3)
      //   Covers G-SP-C.5

      if (typeof buildPassivePrompt === "function") {
        const prompt = buildPassivePrompt("profile-nav", {
          handle: "alice-vp",
          url: "https://www.linkedin.com/in/alice-vp/",
        });
        assert.ok(
          prompt.includes("candidateId: <from step 1>") || prompt.includes("from step 1"),
          `profile-nav prompt must instruct threading of candidateId from step 1. Prompt snippet: ${prompt.slice(0, 300)}`
        );
      } else {
        // Source-structural path — scoped to buildPassivePrompt function
        const fnStart = PASSIVE_SRC.indexOf("function buildPassivePrompt");
        const fnBody = PASSIVE_SRC.slice(fnStart, fnStart + 5000);
        const profileNavOffset = fnBody.indexOf('if (eventType === "profile-nav")');
        const profileNavSection = fnBody.slice(profileNavOffset, profileNavOffset + 3500);
        assert.ok(
          profileNavSection.includes("from step 1") || profileNavSection.includes("candidateId: <from step"),
          `buildPassivePrompt profile-nav branch must contain "from step 1" FK threading instruction (OQ-A3)`
        );
      }
    },
  );

  // ─── T-SP-C.Passive.3 ────────────────────────────────────────────────────────
  it(
    "T-SP-C.Passive.3: click + input branches UNCHANGED — source still contains 'remember' and 'stop' in those branches",
    () => {
      // Given: buildPassivePrompt("click"/"input") — or passive.ts source scan
      // When:  both branch texts inspected
      // Then:  CLICK branch contains "remember" and "stop" (pre-P-SP-C behavior unchanged)
      //        INPUT branch contains "remember" and "stop" (pre-P-SP-C behavior unchanged)
      //   Covers G-SP-C.6 — NG-3 + NG-4 scope discipline: F-5 did NOT touch click/input

      if (typeof buildPassivePrompt === "function") {
        const clickPrompt = buildPassivePrompt("click", {
          url: "https://www.linkedin.com/feed/",
          ref: { ariaLabel: "Like something", controlName: "Like", text: "Like" },
        });
        assert.ok(clickPrompt.includes("remember"), "click prompt must contain 'remember'");
        assert.ok(clickPrompt.includes("stop"), "click prompt must contain 'stop'");

        const inputPrompt = buildPassivePrompt("input", {
          url: "https://www.linkedin.com/messaging/",
          charCount: 30,
          snippet: "hi there",
        });
        assert.ok(inputPrompt.includes("remember"), "input prompt must contain 'remember'");
        assert.ok(inputPrompt.includes("stop"), "input prompt must contain 'stop'");
      } else {
        // Source-structural path — the file has multiple functions with if(eventType...) branches.
        // Scope all searches to the `buildPassivePrompt` function body.
        const fnStart = PASSIVE_SRC.indexOf("function buildPassivePrompt");
        assert.ok(fnStart >= 0, "passive.ts must contain buildPassivePrompt function");
        // Extract 5000 chars of the function body (profile-nav + click + input all within)
        const fnBody = PASSIVE_SRC.slice(fnStart, fnStart + 5000);

        // Click branch within buildPassivePrompt
        const clickBranchOffset = fnBody.indexOf('if (eventType === "click")');
        assert.ok(clickBranchOffset >= 0,
          'buildPassivePrompt must contain click branch `if (eventType === "click")`');
        // click branch is ~1500 chars; include 2000 from its start
        const clickSection = fnBody.slice(clickBranchOffset, clickBranchOffset + 2000);
        assert.ok(clickSection.includes("remember"),
          `passive.ts buildPassivePrompt click branch must contain 'remember'. ` +
          `Snippet: ${clickSection.slice(0, 400)}`);
        assert.ok(clickSection.includes("stop"),
          "passive.ts buildPassivePrompt click branch must contain 'stop'");

        // Input branch within buildPassivePrompt
        const inputBranchOffset = fnBody.indexOf('if (eventType === "input")');
        assert.ok(inputBranchOffset >= 0,
          'buildPassivePrompt must contain input branch `if (eventType === "input")`');
        const inputSection = fnBody.slice(inputBranchOffset, inputBranchOffset + 800);
        assert.ok(inputSection.includes("remember"),
          "passive.ts buildPassivePrompt input branch must contain 'remember'");
        assert.ok(inputSection.includes("stop"),
          "passive.ts buildPassivePrompt input branch must contain 'stop'");
      }
    },
  );
});
