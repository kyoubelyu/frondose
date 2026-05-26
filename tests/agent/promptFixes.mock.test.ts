/**
 * P-59 Layer-2 Step 4a — T-Exec.1m / T-Draft.1m / T-Identity.1m / T-Type.1 / T-Profile.1 — SCAFFOLD
 *
 * Source-structural tests for the prompt + code fixes in:
 *   F3 `src/tools/browser/type.ts`       — D-RUN-3 (Cmd+A select + Backspace clear)
 *   F4 `src/tools/identity/identity.ts`  — D-P59-8 (auto-derive from /in/me/)
 *   F5 `src/agent/systemPrompt/checkpoint.ts` — D-P59-9 (must-execute-after-announce)
 *   F6 `src/agent/systemPrompt/boundary.ts`   — D-P59-10 (draft-before-gate) + D-P59-8 (identity-bootstrap)
 *   F7 `src/cli/subcommands/serve/turn.ts`    — D-P59-9 belt (suggest_card in RESUME_EXCLUDED_TOOLS)
 *   F2 `src/cli/subcommands/serve.ts`          — F-MAI_PROFILE_DIR (T-Profile.1)
 *   F1 `src/agent/workflow/controller.ts`      — D-P59-9(A2) (approve() resumePrompt suggest_card)
 *
 * All assertions FAIL against the pre-builder source — each comment cites the exact pre-builder state.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * Gate/defect coverage:
 *   D-P59-9 (under-execution) ↦ T-Exec.1m (belt: suggest_card excluded; CHECKPOINT execute clause; resumePrompt)
 *   D-P59-10 (gate-before-draft) ↦ T-Draft.1m (boundary draft-preview directive)
 *   D-P59-8 (identity tool ASK→auto-derive) ↦ T-Identity.1m (identity.ts description)
 *   D-RUN-3 (Ctrl+A wrong modifier) ↦ T-Type.1 (type.ts Cmd+A + Backspace)
 *   F-MAI_PROFILE_DIR (hardcoded Chrome profile dir) ↦ T-Profile.1 (serve.ts env var)
 *   §6.4(C) D-RUN-3 fix ↦ T-Type.1; §6.4(D) identity ↦ T-Identity.1m
 *   §6.4(E) checkpoint ↦ T-Exec.1m; §6.4(F) boundary ↦ T-Draft.1m + T-Identity.1m belt
 *   §6.4(G) turn.ts ↦ T-Exec.1m; §6.4(B) serve.ts ↦ T-Profile.1
 *   §6.4(A4) controller approve() resumePrompt ↦ T-Exec.1m
 *
 * Run (mock — source-structural, no browser/LLM):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/agent/promptFixes.mock.test.ts
 * ════════════════════════════════════════════════════════════════════════════════════
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Pre-read source files (all source-structural — no runtime import of production modules needed)
const TURN_SRC = readFileSync(join(REPO, "src/cli/subcommands/serve/turn.ts"), "utf-8");
const CHECKPOINT_SRC = readFileSync(join(REPO, "src/agent/systemPrompt/checkpoint.ts"), "utf-8");
const BOUNDARY_SRC = readFileSync(join(REPO, "src/agent/systemPrompt/boundary.ts"), "utf-8");
const IDENTITY_SRC = readFileSync(join(REPO, "src/tools/identity/identity.ts"), "utf-8");
const TYPE_SRC = readFileSync(join(REPO, "src/tools/browser/type.ts"), "utf-8");
const SERVE_SRC = readFileSync(join(REPO, "src/cli/subcommands/serve.ts"), "utf-8");
const CONTROLLER_SRC = readFileSync(join(REPO, "src/agent/workflow/controller.ts"), "utf-8");

// ─── T-Exec.1m — D-P59-9 belt: suggest_card excluded from resume turns + checkpoint execute clause ──

describe("T-Exec.1m — D-P59-9 under-execution fix: source contract (turn.ts + checkpoint.ts + controller.ts)", () => {
  it("T-Exec.1m.1: RESUME_EXCLUDED_TOOLS in turn.ts must include 'suggest_card' (belt: resume turn cannot defer approved step to a suggestion card — FAILS pre-builder: current set omits 'suggest_card')", () => {
    // Given: src/cli/subcommands/serve/turn.ts source as a string
    // When:  RESUME_EXCLUDED_TOOLS set definition is located
    // Then:  the literal "suggest_card" appears within the set definition

    // Locate the RESUME_EXCLUDED_TOOLS definition block
    const resumeExcludedIdx = TURN_SRC.indexOf("RESUME_EXCLUDED_TOOLS");
    assert.notEqual(resumeExcludedIdx, -1, "T-Exec.1m.1: RESUME_EXCLUDED_TOOLS must be defined in turn.ts");

    // Extract the block around the definition (up to 200 chars)
    const block = TURN_SRC.slice(resumeExcludedIdx, resumeExcludedIdx + 200);

    assert.ok(
      block.includes('"suggest_card"') || block.includes("'suggest_card'"),
      "T-Exec.1m.1: RESUME_EXCLUDED_TOOLS must include 'suggest_card' (§6.4(G)). " +
        `Current definition (pre-builder): ${block.replace(/\n/g, " ").slice(0, 120)}. ` +
        'Pre-builder: set is `new Set(["search_memory", "getMemory", "get_memory_note"])` — suggest_card ABSENT. FAILS pre-builder.',
    );
  });

  it("T-Exec.1m.2: checkpoint.ts CHECKPOINT body must contain the must-execute-after-announce clause ('Execute, don't just narrate') — FAILS pre-builder: clause is absent", () => {
    // Given: src/agent/systemPrompt/checkpoint.ts source
    // When:  the CHECKPOINT constant body is inspected
    // Then:  the "Execute, don't just narrate" paragraph is present in the shared CHECKPOINT body
    //        (NOT only in CHECKPOINT_TASK_START — it must survive in CHECKPOINT_RESUME too)

    assert.ok(
      CHECKPOINT_SRC.includes("Execute, don't just narrate"),
      'T-Exec.1m.2: checkpoint.ts must contain "Execute, don\'t just narrate" (§6.4(E) — D-P59-9 A1). ' +
        "Pre-builder: this paragraph does NOT exist in checkpoint.ts. FAILS pre-builder.",
    );

    // Verify it is NOT only inside CHECKPOINT_TASK_START (so CHECKPOINT_RESUME also has it)
    // The plan requires it to be in the shared CHECKPOINT body BEFORE CHECKPOINT_TASK_START insertion point.
    // Source-structural check: the clause appears BEFORE the CHECKPOINT_TASK_START export line
    const checkpointTaskStartIdx = CHECKPOINT_SRC.indexOf("export const CHECKPOINT_TASK_START");
    const executeClauseIdx = CHECKPOINT_SRC.indexOf("Execute, don't just narrate");

    if (executeClauseIdx !== -1 && checkpointTaskStartIdx !== -1) {
      // After the fix: the execute clause should appear in CHECKPOINT (exported after CHECKPOINT_TASK_START)
      // This is a rough structural check — Step 5 will do a more precise assertion
      assert.ok(
        executeClauseIdx > checkpointTaskStartIdx,
        "T-Exec.1m.2: 'Execute, don't just narrate' must appear in the shared CHECKPOINT body " +
          "(after CHECKPOINT_TASK_START definition, so it is outside CHECKPOINT_TASK_START and thus " +
          "present in CHECKPOINT_RESUME too). §6.4(E) plan spec. FAILS pre-builder.",
      );
    }
  });

  it("T-Exec.1m.3: controller.ts approve() resumePrompt must contain 'Do NOT call suggest_card' — FAILS pre-builder: phrase absent from current resumePrompt", () => {
    // Given: src/agent/workflow/controller.ts source
    // When:  the approve() resumePrompt string is located
    // Then:  it contains the "Do NOT call suggest_card" instruction (§6.4(A4))

    const resumePromptIdx = CONTROLLER_SRC.indexOf("resumePrompt");
    assert.notEqual(resumePromptIdx, -1, "T-Exec.1m.3: controller.ts must define a resumePrompt in approve()");

    // Extract the resumePrompt value region (up to 800 chars from first occurrence)
    const block = CONTROLLER_SRC.slice(resumePromptIdx, resumePromptIdx + 800);

    assert.ok(
      block.includes("Do NOT call suggest_card"),
      "T-Exec.1m.3: approve() resumePrompt must contain 'Do NOT call suggest_card' (§6.4(A4) — D-P59-9 A2). " +
        `Current resumePrompt (pre-builder): "${block.replace(/\n/g, " ").slice(0, 180)}". ` +
        "Pre-builder: phrase absent. FAILS pre-builder.",
    );
  });
});

// ─── T-Draft.1m — D-P59-10 gate-before-draft: boundary.ts must have draft-preview directive ──────────

describe("T-Draft.1m — D-P59-10 draft-before-gate: boundary.ts must contain draft-preview directive (§6.4(F))", () => {
  it("T-Draft.1m: boundary.ts must contain the 'Draft-before-gate' directive embedding a ~100-char preview in the requiresApproval step title BEFORE calling todo_write in_progress — FAILS pre-builder: directive is absent", () => {
    // Given: src/agent/systemPrompt/boundary.ts source
    // When:  the BOUNDARY or BOUNDARY_RESUME body is inspected
    // Then:  the "Draft-before-gate" paragraph is present OUTSIDE BOUNDARY_RITUAL_CLAUSE
    //        (so it survives in BOUNDARY_RESUME too)

    // ── Assertion 1: "Draft-before-gate" keyword present ────────────────────────────────────────
    assert.ok(
      BOUNDARY_SRC.includes("Draft-before-gate"),
      "T-Draft.1m: boundary.ts must contain the 'Draft-before-gate' directive (§6.4(F) — D-P59-10 D1). " +
        "Pre-builder: not present. FAILS pre-builder.",
    );

    // ── Assertion 2: 100-char preview guidance present ──────────────────────────────────────────
    assert.ok(
      BOUNDARY_SRC.includes("100-char") || BOUNDARY_SRC.includes("~100 char"),
      "T-Draft.1m: boundary.ts must contain '~100-char preview' language in the draft-before-gate directive. " +
        "Pre-builder: not present. FAILS pre-builder.",
    );

    // ── Assertion 3: "Send [type]: " preview format present (from §6.4(F) sketch) ──────────────
    assert.ok(
      BOUNDARY_SRC.includes("Send [type]") || BOUNDARY_SRC.includes("Send note:"),
      "T-Draft.1m: boundary.ts must contain the step-title preview format (e.g. 'Send [type]: …'). " +
        "Pre-builder: not present. FAILS pre-builder.",
    );

    // ── Assertion 4: directive is OUTSIDE BOUNDARY_RITUAL_CLAUSE ────────────────────────────────
    // (so it survives in BOUNDARY_RESUME which replaces BOUNDARY_RITUAL_CLAUSE)
    const ritualClauseIdx = BOUNDARY_SRC.indexOf("BOUNDARY_RITUAL_CLAUSE");
    const draftBeforeGateIdx = BOUNDARY_SRC.indexOf("Draft-before-gate");
    if (draftBeforeGateIdx !== -1 && ritualClauseIdx !== -1) {
      // Draft-before-gate must appear AFTER BOUNDARY_RITUAL_CLAUSE definition
      // (i.e. in the BOUNDARY template body, not inside the BOUNDARY_RITUAL_CLAUSE string itself)
      const ritualClauseEndIdx = BOUNDARY_SRC.indexOf("`;", ritualClauseIdx);
      assert.ok(
        draftBeforeGateIdx > ritualClauseEndIdx,
        "T-Draft.1m: 'Draft-before-gate' must appear OUTSIDE (after) the BOUNDARY_RITUAL_CLAUSE definition " +
          "so it survives in BOUNDARY_RESUME too. §6.4(F) spec. FAILS pre-builder.",
      );
    }
  });
});

// ─── T-Identity.1m — D-P59-8: identity.ts description must auto-derive, not ASK first ──────────────

describe("T-Identity.1m — D-P59-8: identity.ts tool description must prefer auto-derive from /in/me/ (§6.4(D))", () => {
  it("T-Identity.1m: identity.ts tool description must NOT contain 'ASK them in conversation first'; must contain '/in/me/' auto-derive guidance — FAILS pre-builder: current description has 'ASK them in conversation first'", () => {
    // Given: src/tools/identity/identity.ts source
    // When:  the tool description string is inspected
    // Then:  no "ASK them in conversation first"; contains "/in/me/" + "auto-derive" concept

    // ── Assertion 1: old ASK-first pattern REMOVED ───────────────────────────────────────────────
    assert.ok(
      !IDENTITY_SRC.includes("ASK them in conversation first"),
      "T-Identity.1m: identity.ts description must NOT contain 'ASK them in conversation first' (§6.4(D)). " +
        "Pre-builder: currently contains exactly this phrase. FAILS pre-builder.",
    );

    // ── Assertion 2: /in/me/ auto-derive guidance ADDED ─────────────────────────────────────────
    assert.ok(
      IDENTITY_SRC.includes("/in/me/"),
      "T-Identity.1m: identity.ts description must contain '/in/me/' (navigate to own profile to auto-derive). " +
        "Pre-builder: not present. FAILS pre-builder.",
    );

    // ── Assertion 3: description still has the placeholder-data guard ───────────────────────────
    // The new description should preserve "Do NOT use placeholder data" (§6.4(D) sketch)
    assert.ok(
      IDENTITY_SRC.includes("placeholder data") || IDENTITY_SRC.includes("placeholder"),
      "T-Identity.1m: identity.ts description must still contain a placeholder-data guard " +
        "(preserved from old description per §6.4(D)). " +
        "Pre-builder: the phrase exists but the whole description will be replaced. This assertion passes pre-builder. " +
        "Step 5 will verify the EXACT wording post-builder.",
    );
  });

  it("T-Identity.1m-belt: boundary.ts must contain the 'Identity bootstrap' directive for auto-identity setup when identity is blank — FAILS pre-builder: directive is absent", () => {
    // Given: src/agent/systemPrompt/boundary.ts source
    // When:  BOUNDARY body is inspected
    // Then:  "Identity bootstrap" paragraph is present (D-P59-8 belt, §6.4(F))

    assert.ok(
      BOUNDARY_SRC.includes("Identity bootstrap"),
      "T-Identity.1m-belt: boundary.ts must contain 'Identity bootstrap' paragraph (§6.4(F) — D-P59-8 belt). " +
        "Pre-builder: not present. FAILS pre-builder.",
    );
  });
});

// ─── T-Type.1 — D-RUN-3: type.ts must use Cmd+A (modifiers:4) + Backspace, NOT Ctrl+A + insertText("") ──

describe("T-Type.1 — D-RUN-3: type.ts CDP arm must use Cmd+A (modifiers:4) + explicit Backspace — source-structural proxy for live L1 field-value assertion", () => {
  it("T-Type.1.1: type.ts must NOT contain 'modifiers: 2' in the CDP arm (Ctrl+A is wrong on macOS; must be Cmd+A = modifiers:4) — FAILS pre-builder: current line 97 has modifiers:2", () => {
    // Given: src/tools/browser/type.ts source
    // When:  the CDP arm select-all dispatch is inspected
    // Then:  `modifiers: 2` does NOT appear (Ctrl+A removed); `modifiers: 4` appears (Cmd+A added)

    // ── Assertion 1: modifiers:2 (Ctrl+A) REMOVED ───────────────────────────────────────────────
    assert.ok(
      !TYPE_SRC.includes("modifiers: 2"),
      "T-Type.1.1: type.ts must NOT contain 'modifiers: 2' (Ctrl+A — wrong modifier on macOS). " +
        "Pre-builder: L97-98 use `modifiers: 2` for Ctrl+A. FAILS pre-builder.",
    );

    // ── Assertion 2: modifiers:4 (Cmd+A) ADDED ──────────────────────────────────────────────────
    assert.ok(
      TYPE_SRC.includes("modifiers: 4"),
      "T-Type.1.1: type.ts must contain 'modifiers: 4' (Cmd+A — macOS correct modifier, §6.4(C)). " +
        "Pre-builder: not present. FAILS pre-builder.",
    );
  });

  it('T-Type.1.2: type.ts CDP arm must NOT contain `insertText({ text: "" })` as the clear mechanism — FAILS pre-builder: L110 uses insertText({text:""}) for the empty-text clear', () => {
    // Given: src/tools/browser/type.ts source
    // When:  the empty-text / clear path is inspected
    // Then:  `insertText({ text: "" })` does NOT appear as the clear primitive;
    //        explicit Backspace key dispatch (windowsVirtualKeyCode: 8) IS present instead

    // ── Assertion 1: insertText empty-text clear REMOVED ────────────────────────────────────────
    assert.ok(
      !TYPE_SRC.includes('insertText({ text: "" })'),
      'T-Type.1.2: type.ts must NOT contain `insertText({ text: "" })` (unproven clear primitive, §6.4(C)). ' +
        'Pre-builder: L110 has `await client.handle.Input.insertText({ text: "" })`. FAILS pre-builder.',
    );

    // ── Assertion 2: explicit Backspace key event ADDED ──────────────────────────────────────────
    assert.ok(
      TYPE_SRC.includes("windowsVirtualKeyCode: 8"),
      "T-Type.1.2: type.ts must contain `windowsVirtualKeyCode: 8` (explicit Backspace key event, §6.4(C)). " +
        "Backspace on a Cmd+A selection deletes the whole selection — the correct clear mechanism. " +
        "Pre-builder: not present. FAILS pre-builder.",
    );
  });

  it("T-Type.1.3: type.ts CDP arm Backspace dispatch must use key:'Backspace' with code:'Backspace' — FAILS pre-builder: Backspace dispatch not present", () => {
    // Given: src/tools/browser/type.ts source
    // When:  the Backspace key event dispatch is located
    // Then:  `key: "Backspace"` and `code: "Backspace"` appear (matching the Enter dispatch pattern)

    assert.ok(
      TYPE_SRC.includes('key: "Backspace"'),
      'T-Type.1.3: type.ts must contain `key: "Backspace"` in the CDP Backspace dispatch (§6.4(C)). ' +
        "Pre-builder: not present. FAILS pre-builder.",
    );

    assert.ok(
      TYPE_SRC.includes('code: "Backspace"'),
      'T-Type.1.3: type.ts must contain `code: "Backspace"` in the CDP Backspace dispatch. ' +
        "Pre-builder: not present. FAILS pre-builder.",
    );
  });
});

// ─── T-Profile.1 — F-MAI_PROFILE_DIR: serve.ts must honor process.env.MAI_PROFILE_DIR ──────────────

describe("T-Profile.1 — F-MAI_PROFILE_DIR: serve.ts profileDir must source process.env.MAI_PROFILE_DIR (§6.4(B))", () => {
  it("T-Profile.1: serve.ts profileDir must contain 'process.env.MAI_PROFILE_DIR' — FAILS pre-builder: L74 hardcodes the path without env var check", () => {
    // Given: src/cli/subcommands/serve.ts source
    // When:  the profileDir variable assignment is inspected
    // Then:  it reads process.env.MAI_PROFILE_DIR (with nullish coalesce to default)

    // ── Assertion 1: MAI_PROFILE_DIR env var reference present ──────────────────────────────────
    assert.ok(
      SERVE_SRC.includes("MAI_PROFILE_DIR"),
      "T-Profile.1: serve.ts must reference 'MAI_PROFILE_DIR' env var (§6.4(B)). " +
        "Pre-builder: L74 = `const profileDir = join(getHomeBase(), '.mai', 'agent', 'chrome-profile');` — hardcoded, no env var. FAILS pre-builder.",
    );

    // ── Assertion 2: process.env.MAI_PROFILE_DIR specifically ───────────────────────────────────
    assert.ok(
      SERVE_SRC.includes("process.env.MAI_PROFILE_DIR"),
      "T-Profile.1: serve.ts must use `process.env.MAI_PROFILE_DIR` (the §6.4(B) exact pattern). " +
        "Pre-builder: not present. FAILS pre-builder.",
    );

    // ── Assertion 3: nullish coalesce fallback to default path ───────────────────────────────────
    // The §6.4(B) sketch: `process.env.MAI_PROFILE_DIR ?? join(...)`
    assert.ok(
      SERVE_SRC.includes("MAI_PROFILE_DIR ?? ") || SERVE_SRC.includes("MAI_PROFILE_DIR ??"),
      "T-Profile.1: serve.ts MAI_PROFILE_DIR must use nullish coalesce (??) to fall back to the default path. " +
        "Pre-builder: not present. FAILS pre-builder.",
    );
  });
});
