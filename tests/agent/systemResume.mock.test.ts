/**
 * P-59 v2-rev Step 4a-v2 — T-Resume.4, T-Resume.4b, T-Resume.6, T-Resume.6b — SCAFFOLD
 * (assertion bodies are REAL + intentionally RED; all FAIL pre-builder)
 *
 * Tests the FIX-1 v2-rev mechanism: resume-aware system prompt (V1–V4 §9.4).
 *
 * T-Resume.4 (source-structural — flag threading, §9.4(e) V5):
 *   turn.ts TurnArgs has `isWorkflowResume?: boolean`; runOneTurn selects
 *   `deps.systemResume` when the flag is set; `resumeWorkflowTurn` calls
 *   `steerThenTrigger(prompt, true)` so the resume path uses systemResume;
 *   context.ts ServeDeps declares `systemResume: string`.
 *   → currently FAILS: none of these symbols exist in turn.ts / context.ts.
 *
 * T-Resume.4b (source-structural — live-survival guarantee, §9.4(a)(b) V1+V2):
 *   PRESENCE baseline: both ritual phrases appear in the normal BOUNDARY/CHECKPOINT (PASSES).
 *   STRUCTURAL: boundary.ts exports `BOUNDARY_RITUAL_CLAUSE` (the extracted clause) AND
 *     `BOUNDARY_RESUME` (the post-replace band); checkpoint.ts exports `CHECKPOINT_TASK_START`
 *     AND `CHECKPOINT_RESUME`.
 *   → currently FAILS: none of the v2-rev consts exist in boundary.ts / checkpoint.ts.
 *   (Step 5 adds runtime absence assertions via dynamic import of the post-builder modules.)
 *
 * T-Resume.6 (source-structural — composition structure, §9.4(a)-(d) V1–V4):
 *   BOUNDARY_RESUME + CHECKPOINT_RESUME exist in their files; serve.ts computes `systemResume`
 *   via `composeSystemPrompt`; context.ts ServeDeps declares `systemResume`.
 *   → currently FAILS: v2-rev symbols absent.
 *
 * T-Resume.6b (source-structural — golden embed contract, §9.4(a)(b)):
 *   boundary.ts embeds `BOUNDARY_RITUAL_CLAUSE` into `BOUNDARY` via template literal (proving
 *   byte-identity post-factor); checkpoint.ts embeds `CHECKPOINT_TASK_START` into `CHECKPOINT`.
 *   The normal ritual phrases STILL appear in the current source (baseline).
 *   → currently FAILS on the embed-pattern checks (BOUNDARY_RITUAL_CLAUSE doesn't exist).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * Gate / v2-rev finding coverage:
 *   Dn-1 residual (FIX-1 v1 insufficient) → T-Resume.4, T-Resume.4b, T-Resume.6, T-Resume.6b
 *   §9.4(a) checkpoint.ts V1                → T-Resume.4b, T-Resume.6, T-Resume.6b
 *   §9.4(b) boundary.ts V2                  → T-Resume.4b, T-Resume.6, T-Resume.6b
 *   §9.4(c) serve.ts V3                     → T-Resume.6
 *   §9.4(d) context.ts V4                   → T-Resume.4, T-Resume.6
 *   §9.4(e) turn.ts V5                      → T-Resume.4
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/agent/systemResume.mock.test.ts
 * ════════════════════════════════════════════════════════════════════════════════════
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const BOUNDARY_TS = readFileSync(join(REPO, "src/agent/systemPrompt/boundary.ts"), "utf-8");
const CHECKPOINT_TS = readFileSync(join(REPO, "src/agent/systemPrompt/checkpoint.ts"), "utf-8");
const TURN_TS = readFileSync(join(REPO, "src/cli/subcommands/serve/turn.ts"), "utf-8");
// P-72 slice 7: isWorkflowResume + deps.systemResume moved to turn/runOne.ts; steerThenTrigger(prompt, true) moved to turn/steer.ts.
// P-AUTO-8: deps.systemResume further extracted to turn/selectSystem.ts (pure helper for 3-branch system select).
const TURN_RUN_ONE_TS = readFileSync(join(REPO, "src/cli/subcommands/serve/turn/runOne.ts"), "utf-8");
const TURN_SELECT_SYSTEM_TS = readFileSync(join(REPO, "src/cli/subcommands/serve/turn/selectSystem.ts"), "utf-8");
const TURN_STEER_TS = readFileSync(join(REPO, "src/cli/subcommands/serve/turn/steer.ts"), "utf-8");
const CONTEXT_TS = readFileSync(join(REPO, "src/cli/subcommands/serve/context.ts"), "utf-8");
const SERVE_TS = readFileSync(join(REPO, "src/cli/subcommands/serve.ts"), "utf-8");

// ── Ritual-phrase golden anchors (from current source — EXACT substrings per §9.5 T-Resume.4b) ────
// boundary.ts L27 and checkpoint.ts L22 are template literals — inside a TS template literal,
// backticks are escaped as \` in the raw source. readFileSync returns raw source chars, so the
// anchor strings must also use backslash-backtick to match.
// boundary.ts L27: the Plan-first discipline ritual clause substring
const BOUNDARY_RITUAL_PHRASE = "FIRST the \\`search_memory\\` lookup, THEN";
// checkpoint.ts L22: the Task-start context lookup substring
const CHECKPOINT_RITUAL_PHRASE = "FIRST tool call MUST be \\`search_memory\\`";

// ─── T-Resume.4 ─── isWorkflowResume flag threading (§9.4(e) V5) ──────────────────────────────────

describe("turn.ts — isWorkflowResume flag threads resume path to deps.systemResume (FIX-1 v2-rev §9.4(e) D-Dn1)", () => {
  it("T-Resume.4: TurnArgs has isWorkflowResume?: boolean; runOneTurn selects deps.systemResume; resumeWorkflowTurn calls steerThenTrigger(prompt, true); context.ts ServeDeps declares systemResume: string (V5+V4 required — FAILS pre-builder)", () => {
    // Given: src/cli/subcommands/serve/turn.ts and context.ts sources
    // When: scanned for isWorkflowResume flag threading + system selection + ServeDeps field
    // Then: all four wiring points are present — all currently absent → FAIL

    // P-72 slice 7: isWorkflowResume + deps.systemResume moved to turn/runOne.ts (Strategy A split).
    // steerThenTrigger(prompt, true) call moved to turn/steer.ts (resumeWorkflowTurn → await steer(prompt, true)).
    // P-AUTO-8: deps.systemResume further extracted to turn/selectSystem.ts (3-branch pure helper).
    // Widen each check to OR across the original turn.ts and the relevant submodule(s).
    const combinedTurnAndRunOne = TURN_TS + TURN_RUN_ONE_TS + TURN_SELECT_SYSTEM_TS;
    const combinedTurnAndSteer = TURN_TS + TURN_STEER_TS;

    // (1) TurnArgs gains the flag — lives in turn/runOne.ts post-split
    assert.ok(
      combinedTurnAndRunOne.includes("isWorkflowResume"),
      `turn.ts or turn/runOne.ts TurnArgs must declare "isWorkflowResume" — ` +
        `V5 adds: isWorkflowResume?: boolean to TurnArgs (§9.4(e)). FAILS pre-builder.`,
    );

    // (2) runOneTurn selects deps.systemResume when the flag is set — in turn/runOne.ts post-split
    assert.ok(
      combinedTurnAndRunOne.includes("deps.systemResume"),
      `turn.ts or turn/runOne.ts runOneTurn must reference deps.systemResume for the system selection — ` +
        `V5 adds: system: args.isWorkflowResume ? deps.systemResume : deps.system (§9.4(e) sketch). ` +
        `FAILS pre-builder.`,
    );

    // (3) resumeWorkflowTurn passes true — in turn/steer.ts post-split (await steer(prompt, true))
    assert.ok(
      combinedTurnAndSteer.includes("steerThenTrigger(prompt, true)") ||
        combinedTurnAndSteer.includes("steerThenTrigger(newPrompt, true)") ||
        combinedTurnAndSteer.includes("steer(prompt, true)"),
      `turn.ts or turn/steer.ts resumeWorkflowTurn must call steerThenTrigger / steer with true — ` +
        `currently: steerThenTrigger(prompt) [no flag]. ` +
        `V5 adds the second arg (§9.4(e)): await steerThenTrigger(prompt, true). FAILS pre-builder.`,
    );

    // (4) ServeDeps declares systemResume (context.ts)
    assert.ok(
      CONTEXT_TS.includes("systemResume: string"),
      `context.ts ServeDeps must declare "systemResume: string" — ` +
        `V4 adds the field (§9.4(d)). Currently ServeDeps has only "system: string". FAILS pre-builder.`,
    );
  });
});

// ─── T-Resume.4b ─── live-survival guarantee: ritual phrases ABSENT from resume bands ─────────────

describe("systemResume live-survival guarantee — BOUNDARY_RESUME + CHECKPOINT_RESUME omit both ritual phrases (FIX-1 v2-rev §9.4(a)(b) [v2-rev BLOCKER #2])", () => {
  it("T-Resume.4b: BOUNDARY_RITUAL_CLAUSE + BOUNDARY_RESUME exported from boundary.ts; CHECKPOINT_TASK_START + CHECKPOINT_RESUME exported from checkpoint.ts; ritual phrases present in normal bands AND absent from resume bands (V1+V2 required — FAILS pre-builder on structural checks)", () => {
    // Given: src/agent/systemPrompt/boundary.ts and checkpoint.ts sources
    // When: checked for v2-rev exports and embed-then-replace pattern
    // Then: extracted clause consts + resume variants exist; normal bands retain ritual phrases

    // ── Baseline (PASSES pre-builder) — confirms the ritual phrases are in the CURRENT source ──────
    // These anchor the "byte-identical" requirement: if the builder accidentally removes them
    // from BOUNDARY/CHECKPOINT, this assertion fails (prevents silent degradation).
    assert.ok(
      BOUNDARY_TS.includes(BOUNDARY_RITUAL_PHRASE),
      `boundary.ts BOUNDARY must contain the Plan-first ritual phrase ` +
        `("${BOUNDARY_RITUAL_PHRASE}") — currently present. ` +
        `If this fails post-builder, the factor-then-embed refactor accidentally removed it.`,
    );
    assert.ok(
      CHECKPOINT_TS.includes(CHECKPOINT_RITUAL_PHRASE),
      `checkpoint.ts CHECKPOINT must contain the Task-start ritual phrase ` +
        `("${CHECKPOINT_RITUAL_PHRASE}") — currently present. ` +
        `If this fails post-builder, the factor-then-embed refactor accidentally removed it.`,
    );

    // ── Structural: extracted clause consts must exist (FAILS pre-builder) ──────────────────────
    assert.ok(
      BOUNDARY_TS.includes("BOUNDARY_RITUAL_CLAUSE"),
      `boundary.ts must export BOUNDARY_RITUAL_CLAUSE (the extracted Plan-first ritual clause, §9.4(b)). ` +
        `V2 adds: export const BOUNDARY_RITUAL_CLAUSE = \`...\`. FAILS pre-builder.`,
    );
    assert.ok(
      CHECKPOINT_TS.includes("CHECKPOINT_TASK_START"),
      `checkpoint.ts must export CHECKPOINT_TASK_START (the extracted Task-start lookup subsection, §9.4(a)). ` +
        `V1 adds: export const CHECKPOINT_TASK_START = \`...\`. FAILS pre-builder.`,
    );

    // ── Structural: resume variants must exist (FAILS pre-builder) ─────────────────────────────
    assert.ok(
      BOUNDARY_TS.includes("BOUNDARY_RESUME"),
      `boundary.ts must export BOUNDARY_RESUME = BOUNDARY.replace(BOUNDARY_RITUAL_CLAUSE, BOUNDARY_RITUAL_CLAUSE_RESUME) ` +
        `(§9.4(b) V2). FAILS pre-builder.`,
    );
    assert.ok(
      CHECKPOINT_TS.includes("CHECKPOINT_RESUME"),
      `checkpoint.ts must export CHECKPOINT_RESUME = CHECKPOINT.replace(CHECKPOINT_TASK_START, CHECKPOINT_TASK_START_RESUME) ` +
        `(§9.4(a) V1). FAILS pre-builder.`,
    );

    // ── Step 5 (runtime) will add absence assertions on rendered systemResume: ──────────────────
    // dynamic import of post-builder boundary.ts + checkpoint.ts to compute BOUNDARY_RESUME,
    // then assert BOUNDARY_RESUME.includes(BOUNDARY_RITUAL_PHRASE) === false.
    // (Cannot be done here pre-builder — the exports don't exist yet.)
  });
});

// ─── T-Resume.6 ─── structural: BOUNDARY_RESUME + CHECKPOINT_RESUME + systemResume composition ────

describe("systemResume structure — BOUNDARY_RESUME + CHECKPOINT_RESUME exported; systemResume composed via composeSystemPrompt; ServeDeps.systemResume declared (FIX-1 v2-rev V1–V4 §9.4(a)-(d))", () => {
  it("T-Resume.6: boundary.ts exports BOUNDARY_RESUME; checkpoint.ts exports CHECKPOINT_RESUME; serve.ts computes systemResume = composeSystemPrompt({boundary: BOUNDARY_RESUME, ...}); context.ts ServeDeps has systemResume: string (V1-V4 required — FAILS pre-builder)", () => {
    // Given: src/agent/systemPrompt/boundary.ts, checkpoint.ts, serve/serve.ts, serve/context.ts
    // When: scanned for v2-rev composition structure
    // Then: all four files have their required v2-rev addition

    // boundary.ts exports BOUNDARY_RESUME
    assert.ok(
      BOUNDARY_TS.includes("BOUNDARY_RESUME"),
      `boundary.ts must export BOUNDARY_RESUME (§9.4(b) V2). FAILS pre-builder.`,
    );

    // checkpoint.ts exports CHECKPOINT_RESUME
    assert.ok(
      CHECKPOINT_TS.includes("CHECKPOINT_RESUME"),
      `checkpoint.ts must export CHECKPOINT_RESUME (§9.4(a) V1). FAILS pre-builder.`,
    );

    // serve.ts computes systemResume (V3 §9.4(c))
    assert.ok(
      SERVE_TS.includes("systemResume"),
      `serve.ts must compute systemResume (const systemResume = composeSystemPrompt({boundary: BOUNDARY_RESUME, ...})) ` +
        `and pass it into deps (§9.4(c) V3). FAILS pre-builder.`,
    );

    // context.ts ServeDeps declares systemResume: string (V4 §9.4(d))
    assert.ok(
      CONTEXT_TS.includes("systemResume"),
      `context.ts ServeDeps must declare systemResume (§9.4(d) V4). FAILS pre-builder.`,
    );

    // serve.ts uses composeSystemPrompt with BOUNDARY_RESUME (confirms 3-band order preserved)
    assert.ok(
      SERVE_TS.includes("BOUNDARY_RESUME") || SERVE_TS.includes("boundary: BOUNDARY_RESUME"),
      `serve.ts must pass BOUNDARY_RESUME into composeSystemPrompt for systemResume ` +
        `(§9.4(c): composeSystemPrompt({ boundary: BOUNDARY_RESUME, soul: soulBand, checkpoint: CHECKPOINT_RESUME })). ` +
        `FAILS pre-builder.`,
    );
  });
});

// ─── T-Resume.6b ─── golden: normal BOUNDARY + CHECKPOINT byte-identical post-factor ───────────────

describe("systemResume golden — BOUNDARY and CHECKPOINT byte-identical after factor-then-embed refactor; ritual phrases survive in normal bands (FIX-1 v2-rev §9.4(a)(b) embed contract)", () => {
  it("T-Resume.6b: boundary.ts embeds BOUNDARY_RITUAL_CLAUSE via template literal into BOUNDARY (byte-identical); checkpoint.ts embeds CHECKPOINT_TASK_START via template literal into CHECKPOINT; the ritual phrases are still present in the normal bands (V1+V2 embed pattern required — FAILS pre-builder on embed checks)", () => {
    // Given: src/agent/systemPrompt/boundary.ts and checkpoint.ts sources
    // When: scanned for the embed-then-replace pattern (${BOUNDARY_RITUAL_CLAUSE} inside BOUNDARY)
    // Then: the clause consts are embedded in their bands via template literal;
    //       the ritual phrases STILL appear (embed preserved them byte-identically)

    // ── Embed pattern: BOUNDARY embeds ${BOUNDARY_RITUAL_CLAUSE} (FAILS pre-builder) ─────────────
    // This is the structural proof that BOUNDARY and BOUNDARY.replace(BOUNDARY_RITUAL_CLAUSE, ...)
    // together form a valid guaranteed-match replace (because BOUNDARY literally contains the const).
    assert.ok(
      BOUNDARY_TS.includes("BOUNDARY_RITUAL_CLAUSE"),
      `boundary.ts must define BOUNDARY_RITUAL_CLAUSE and use it in BOUNDARY via template literal — ` +
        `V2 refactor: BOUNDARY = \`...\${BOUNDARY_RITUAL_CLAUSE}...\` (§9.4(b)). FAILS pre-builder.`,
    );
    // Check the template embed is present (the const is interpolated inside BOUNDARY definition)
    assert.ok(
      BOUNDARY_TS.includes("${BOUNDARY_RITUAL_CLAUSE}"),
      `boundary.ts must interpolate \${BOUNDARY_RITUAL_CLAUSE} inside the BOUNDARY const definition ` +
        `to guarantee byte-identical embedding. V2 refactor (§9.4(b)). FAILS pre-builder.`,
    );

    // ── Embed pattern: CHECKPOINT embeds ${CHECKPOINT_TASK_START} (FAILS pre-builder) ─────────────
    assert.ok(
      CHECKPOINT_TS.includes("CHECKPOINT_TASK_START"),
      `checkpoint.ts must define CHECKPOINT_TASK_START and embed it in CHECKPOINT via template literal — ` +
        `V1 refactor: CHECKPOINT = \`...\${CHECKPOINT_TASK_START}...\` (§9.4(a)). FAILS pre-builder.`,
    );
    assert.ok(
      CHECKPOINT_TS.includes("${CHECKPOINT_TASK_START}"),
      `checkpoint.ts must interpolate \${CHECKPOINT_TASK_START} inside the CHECKPOINT const definition. ` +
        `V1 refactor (§9.4(a)). FAILS pre-builder.`,
    );

    // ── Byte-identity survival: ritual phrases STILL present in normal bands (PASSES pre-builder) ─
    // If this fails AFTER builder, the embed broke something → T-Resume.6b fails as intended.
    assert.ok(
      BOUNDARY_TS.includes(BOUNDARY_RITUAL_PHRASE),
      `boundary.ts BOUNDARY/BOUNDARY_RITUAL_CLAUSE must contain the Plan-first ritual phrase ` +
        `("${BOUNDARY_RITUAL_PHRASE}") — the embed must be byte-identical to today's source.`,
    );
    assert.ok(
      CHECKPOINT_TS.includes(CHECKPOINT_RITUAL_PHRASE),
      `checkpoint.ts CHECKPOINT/CHECKPOINT_TASK_START must contain the Task-start ritual phrase ` +
        `("${CHECKPOINT_RITUAL_PHRASE}") — the embed must be byte-identical to today's source.`,
    );

    // ── Step 5 (runtime) will add: ─────────────────────────────────────────────────────────────
    // Dynamic import post-builder: assert BOUNDARY === <golden> (the pre-change flat string)
    // by importing boundary.ts's BOUNDARY export and comparing to a locally-computed reference.
  });
});

// ─── T-Resume.7 ─── deterministic interceptor: experimental_activeTools deny-list on resume turn ─────

describe("runOneTurn — workflow-resume tools are removed from the registry before the Pi loop", () => {
  it("T-Resume.7: runOne.ts keeps the exact 14-tool resume deny-list and passes the filtered registry to runAgentLoopPi", () => {
    // Given: the current post-P72 split runOne.ts implementation
    // When:  its resume deny-list and Pi-loop call are inspected
    // Then:  the exact safety list is filtered from deps.tools itself, while memory writes and browser tools remain

    // P-72 slice 7 moved the implementation from turn.ts to turn/runOne.ts.
    assert.ok(TURN_RUN_ONE_TS.includes("RESUME_EXCLUDED_TOOLS"), "turn/runOne.ts must declare RESUME_EXCLUDED_TOOLS");

    assert.ok(
      TURN_RUN_ONE_TS.includes("RESUME_EXCLUDED_TOOLS.has"),
      "turn/runOne.ts must filter resume tools with Set membership",
    );

    const setLiteralMatch = TURN_RUN_ONE_TS.match(/RESUME_EXCLUDED_TOOLS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    const setLiteral = setLiteralMatch ? setLiteralMatch[1] : "";
    const excluded = [...setLiteral.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    assert.deepStrictEqual(excluded, [
      "search_memory",
      "getMemory",
      "get_memory_note",
      "suggest_card",
      "todo_write",
      "record_raw_candidate",
      "score_lead",
      "score_account",
      "promote_candidate_to_lead",
      "get_lead_context",
      "get_account_context",
      "save_message_draft",
      "list_due_followups",
      "get_sales_report",
    ]);
    for (const retained of ["remember", "set_memory_note", "navigate_to_url"]) {
      assert.ok(!excluded.includes(retained), `${retained} must remain available on workflow resume`);
    }
    assert.ok(
      TURN_RUN_ONE_TS.includes("Object.entries(deps.tools).filter(([n]) => !RESUME_EXCLUDED_TOOLS.has(n))"),
      "resume filtering must subset the tool registry itself, not rely on provider activeTools support",
    );
    assert.ok(
      TURN_RUN_ONE_TS.includes("tools: filteredTools"),
      "runAgentLoopPi must receive the filtered tool registry",
    );
  });
});
