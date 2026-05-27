/**
 * Methodology distillation — folded into the Soul band per CLAUDE.md Q-4.
 * Source: references/methodology*.md (port of mai-linkedin's Solution Selling® notes).
 *
 * Token budget: ≤ 800 tokens per ROADMAP G-P5.6. Current: ~776 tok (~3,100 chars at ~4 char/token) post P-SP-B.
 * Team-lead's tighter target was ≤700; ROADMAP gate is 800. Validator's T-M_p5.1 measures actual.
 * If this constant grows, re-distill before exceeding 800 tok — the full Soul band has a
 * ~1,200-tok ceiling per ROADMAP G-P5.6 and the other 4 sections together take ~280 tok.
 *
 * Coverage:
 *  - 15-phase enum (precall, spark-interest, R/I/C × open/controlled/confirming, validate/close/post, disqualified)
 *  - R1/I1/C1 canonical open-question phrasings (3 each)
 *  - Pain Chain pre-call frame (Step 3 walk-up + Step 4 walk-down)
 *  - Key Players List one-line note
 *  - Value Cycle 4 phases (validate / close / post)
 *  - 3:1 controlled:open ratio guideline
 *  - Regression rule (discomfort → regress to OPEN row)
 *
 * Style: methodology-fact-sheet prose. Soul wrapping (habitual form, 2nd person)
 * happens in composeSoulBand around this constant — see src/agent/systemPrompt/soul.ts.
 */
export const METHODOLOGY_DISTILLATION = `
Methodology (Solution Selling® distillation; full reference at references/methodology*.md):

Phase vocabulary (15-phase enum): precall (pre-outreach: build Key Players List + Pain Chain + select Reference Story); spark-interest (first outreach — Reference Story or initial Value Proposition); R1-open / R2-controlled / R3-confirming (cause); I1-open / I2-controlled / I3-confirming (impact); C1-open / C2-controlled / C3-confirming (capability — C3 is buying-vision ownership); validate (formal Value Proposition with buyer-attested numbers); close (quantified outcome motivates buyer action); post (baseline → actual, feeds next Reference Story); disqualified (ICP mismatch).

Open questions (Row 1 — hand control to buyer):
  R1-open: "What's causing this?" / "Take me through what happens right before that symptom."
  I1-open: "Who else does this affect?" / "Does this ripple into [adjacent function]?"
  C1-open: "What would it take to fix this?" / "Describe what 'this is solved' looks like in 6 months."
Aim short (≤ 30 words). Capability stays implicit at this row — the point is to hear the buyer's model.

Pain Chain + Key Players List (precall artifacts): KPL is the per-ICP table of target titles + likely pains; book base 7-role skeleton (CEO/COO/CFO/CIO/VP Sales/VP Mfg/VP Eng) is adapted per ICP. Pain Chain links each title's pain to the title whose pain it feeds — Step 3 walks up (whose quarterly number is affected?) feeds I2-controlled; Step 4 walks down (what daily-execution friction causes this pain?) feeds R2-controlled. Start at the title most plausibly contactable on LinkedIn — usually VP-level or Head-of. Build speculatively before outreach; revise as buyer evidence confirms or replaces nodes.

Value Cycle (4 gates after C3-confirming): validate (deliver formal 5-slot Value Proposition with buyer-attested numbers from R2/C2 digs) → close (quantified outcome motivates action — procurement call, intro to economic buyer) → post (record baseline → actual; feeds next Reference Story).

Ratio guideline: top performers run controlled:open ≈ 3:1 across the 9-block; poor performers run 1:3. A thread dominated by open questions past R1 signals top performers shift to controlled on the next turn.

Regression rule: on buyer discomfort (short replies, pushback, topic deflection at any confirming-row turn), regress to the OPEN row (R1/I1/C1) for that investigative area — controlled-question density against discomfort backfires (the worked behavior is to regress, not press). After buyer relaxes, progress through controlled and confirming again.

Methodology repertoire (record in score_lead.methodUsed): solution_selling (default; strong Pain Chain evidence), spin (open discovery: Situation/Problem/Implication/Need-payoff), challenger (complacent buyer; teach an insight), meddic (enterprise multi-stakeholder).
`.trim();
