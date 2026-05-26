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
const CONTEXT_TS = readFileSync(join(REPO, "src/cli/subcommands/serve/context.ts"), "utf-8");
const SERVE_TS = readFileSync(join(REPO, "src/cli/subcommands/serve.ts"), "utf-8");
const LOOP_TS = readFileSync(join(REPO, "src/agent/loop.ts"), "utf-8");

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

    // (1) TurnArgs gains the flag
    assert.ok(
      TURN_TS.includes("isWorkflowResume"),
      `turn.ts TurnArgs must declare "isWorkflowResume" — ` +
        `V5 adds: isWorkflowResume?: boolean to TurnArgs (§9.4(e)). FAILS pre-builder.`,
    );

    // (2) runOneTurn selects deps.systemResume when the flag is set
    assert.ok(
      TURN_TS.includes("deps.systemResume"),
      `turn.ts runOneTurn must reference deps.systemResume for the system selection — ` +
        `V5 adds: system: args.isWorkflowResume ? deps.systemResume : deps.system (§9.4(e) sketch). ` +
        `FAILS pre-builder.`,
    );

    // (3) resumeWorkflowTurn passes true — the ONLY path that sets the flag
    assert.ok(
      TURN_TS.includes("steerThenTrigger(prompt, true)") || TURN_TS.includes("steerThenTrigger(newPrompt, true)"),
      `turn.ts resumeWorkflowTurn must call steerThenTrigger(prompt, true) — ` +
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

describe("runOneTurn — RESUME_EXCLUDED_TOOLS deny-list blocks search_memory+getMemory+get_memory_note on resume; todo_write/remember/browser tools included; normal turn activeTools undefined (FIX-1 v3.1 §10 V5-ext+V8)", () => {
  it("T-Resume.7: turn.ts declares RESUME_EXCLUDED_TOOLS Set with all 3 lookup tools excluded; filter uses !RESUME_EXCLUDED_TOOLS.has; todo_write/remember/navigate_to_url NOT in deny-list; loop.ts AgentLoopOpts has activeTools?: string[]; streamText passes experimental_activeTools (v3.1 strengthen — GREEN against built v3.1 code)", () => {
    // Given: src/cli/subcommands/serve/turn.ts and src/agent/loop.ts sources (v3.1 built)
    // When: scanned for RESUME_EXCLUDED_TOOLS deny-list, Set-based filter, and loop.ts wiring
    // Then: Set const with all 3 excluded tools + keep-set membership + AgentLoopOpts + streamText option

    // (1) turn.ts V5-ext: RESUME_EXCLUDED_TOOLS Set const declared
    assert.ok(
      TURN_TS.includes("RESUME_EXCLUDED_TOOLS"),
      `turn.ts must declare RESUME_EXCLUDED_TOOLS (v3.1 deny-list: new Set([...3 tools...])) — ` +
        `V5-ext §10 v3.1. Must be present in built v3.1 code.`,
    );

    // (2) turn.ts: Set-based filter uses .has() — NOT the old !== "search_memory" literal predicate
    assert.ok(
      TURN_TS.includes("RESUME_EXCLUDED_TOOLS.has"),
      `turn.ts filter must use RESUME_EXCLUDED_TOOLS.has(n) (Set-membership test) — ` +
        `v3.1 replaced the single !== "search_memory" predicate with a Set deny-list.`,
    );

    // (3) turn.ts: all 3 read-only memory lookup tools are in the deny-list
    //     Parse the Set literal to verify exact membership
    const setLiteralMatch = TURN_TS.match(/RESUME_EXCLUDED_TOOLS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    const setLiteral = setLiteralMatch ? setLiteralMatch[1] : "";

    assert.ok(
      setLiteral.includes('"search_memory"'),
      `RESUME_EXCLUDED_TOOLS must include "search_memory" (primary semantic lookup, Dn-1 root). ` +
        `Set literal parsed: "${setLiteral}".`,
    );
    assert.ok(
      setLiteral.includes('"getMemory"'),
      `RESUME_EXCLUDED_TOOLS must include "getMemory" (person-specific lookup, Dn-3 root). ` +
        `Set literal parsed: "${setLiteral}".`,
    );
    assert.ok(
      setLiteral.includes('"get_memory_note"'),
      `RESUME_EXCLUDED_TOOLS must include "get_memory_note" (note lookup, Dn-3 coverage). ` +
        `Set literal parsed: "${setLiteral}".`,
    );

    // (4) turn.ts: write tools and browser tools are NOT in the deny-list
    //     (they remain available to the agent on resume — the filter is lookup-only)
    assert.ok(
      !setLiteral.includes('"todo_write"'),
      `RESUME_EXCLUDED_TOOLS must NOT contain "todo_write" — workflow writes kept on resume.`,
    );
    assert.ok(
      !setLiteral.includes('"remember"'),
      `RESUME_EXCLUDED_TOOLS must NOT contain "remember" — memory writes kept on resume.`,
    );
    assert.ok(
      !setLiteral.includes('"set_memory_note"'),
      `RESUME_EXCLUDED_TOOLS must NOT contain "set_memory_note" — note writes kept on resume.`,
    );
    assert.ok(
      !setLiteral.includes('"navigate_to_url"'),
      `RESUME_EXCLUDED_TOOLS must NOT contain "navigate_to_url" — browser tools kept on resume.`,
    );

    // (5) turn.ts: activeTools variable still exists (ternary: resume → filtered, else → undefined)
    assert.ok(
      TURN_TS.includes("activeTools"),
      `turn.ts must compute activeTools (const activeTools = args.isWorkflowResume ? ... : undefined) — V5-ext §10.`,
    );

    // (6) loop.ts V8: AgentLoopOpts interface has activeTools?: string[]
    assert.ok(
      LOOP_TS.includes("activeTools"),
      `src/agent/loop.ts AgentLoopOpts must declare activeTools?: string[] (V8 §10).`,
    );

    // (7) loop.ts V8: streamText receives experimental_activeTools (ai@4.3.19 spelling)
    assert.ok(
      LOOP_TS.includes("experimental_activeTools"),
      `src/agent/loop.ts streamText call must pass experimental_activeTools (V8 §10 — ai@4.3.19 spelling).`,
    );
  });
});
