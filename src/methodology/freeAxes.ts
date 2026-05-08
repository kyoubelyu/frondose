import { z } from "zod";
import type { FreeAxesRecord, FreeAxisDefinition } from "./types.js";

const PAIN_CHAIN_LEAN_OPTIONS = [
  {
    key: "cause-first",
    meaning:
      "Walk downstream (Step 4) to operational antecedent before any I2 probe — anchor R2-controlled on root cause, then expand upward.",
  },
  {
    key: "economic-buyer-first",
    meaning:
      "Walk upstream (Step 3) early — use I2-controlled to surface the CFO/CRO quarterly number before fully confirming root cause.",
  },
  {
    key: "speculative-chain-built",
    meaning:
      "Build the full speculative Pain Chain during precall before any outreach; first message uses chain-derived R2 candidates.",
  },
  {
    key: "admitted-pain-start",
    meaning:
      "Start R1 from what the buyer admits; build the chain node-by-node from buyer evidence rather than pre-speculation.",
  },
  {
    key: "lateral-stakeholder-first",
    meaning:
      "Expand laterally via I1-open (Who else is affected?) before walking up or down; map stakeholder breadth before committing to a chain direction.",
  },
  {
    key: "cause-confirmed-then-up",
    meaning:
      "Confirm one root cause (R3-confirming) before transitioning to I2 upstream probes — full R-row before starting I-row.",
  },
] as const;

const LEAD_ROLE_OPTIONS = [
  {
    key: "pain-owner first",
    meaning:
      "Open on the operational role that owns the admitted pain (VP Sales, RevOps, Head of DevEx) — closest to pain, most likely to admit it.",
  },
  {
    key: "economic-buyer first",
    meaning: "Open on the CFO / CRO / CEO — whoever owns the quarterly number the Pain Chain resolves to.",
  },
  {
    key: "technical-evaluator first",
    meaning:
      "Open on CTO / VP Engineering / Head of DevEx — whoever owns the stack or infra capability that addresses the root cause.",
  },
  {
    key: "practitioner first",
    meaning: "Open on Head-of / team-lead level (below VP); closer to operational friction, easier to reach.",
  },
  {
    key: "champion-led",
    meaning:
      "Find whoever admits pain most readily first and build an internal champion before approaching economic buyer.",
  },
  {
    key: "multi-thread-parallel",
    meaning: "Approach 2–3 KPL roles simultaneously at precall phase; converge on strongest response.",
  },
] as const;

const DISCOVERY_LEAN_OPTIONS = [
  {
    key: "R-lean",
    meaning:
      "Stay in R1/R2/R3 (cause-mapping) until cause is fully quantified (count × rate × time) — never enter I-row on partial cause evidence.",
  },
  {
    key: "I-lean",
    meaning:
      "Expand quickly to I2-controlled (stakeholder map) as soon as cause is admitted in R1 — map the org before confirming root cause.",
  },
  {
    key: "C-lean",
    meaning:
      "Move to C1-open (capability framing) as soon as R3-confirming is done — compress I-row, prioritize vision building.",
  },
  {
    key: "ratio-disciplined",
    meaning: "Maintain strict 3:1 controlled:open ratio across all rows; self-audit from memory before each turn.",
  },
  {
    key: "precall-thorough",
    meaning:
      "Invest deeply in KPL + Pain Chain at precall phase before any spark-interest outreach; start with R2 candidates already prepared.",
  },
  {
    key: "validate-close-fast",
    meaning:
      "Compress R/I discovery, prioritize C3-confirming + formal Value Proposition delivery; optimized for validate/close phases.",
  },
  {
    key: "spark-interest-focused",
    meaning:
      "Prioritize Reference Story quality and first-outreach response rate; invest most energy at spark-interest and treat 9-block as supporting structure.",
  },
] as const;

const STORY_SHAPE_OPTIONS = [
  {
    key: "reference-story led",
    meaning:
      "Open with the 6-row Reference Story (Situation / Key issue / Cause / Capability needed / We provided / Result); let prospect self-select via recognition.",
  },
  {
    key: "initial-value-prop led",
    meaning:
      "Open with the 5-slot initial Value Proposition with seller-estimated numbers; lead with quantified outcome hook before any pain admission.",
  },
  {
    key: "cause-named direct",
    meaning:
      "Name a likely cause directly in outreach ('I suspect [cause] is eating ~X% of your team's time') — names a Pain Sheet candidate without a story frame.",
  },
  {
    key: "pain-question first",
    meaning: "Open with an R1-style open question; hand control to buyer's narrative before offering any frame.",
  },
  {
    key: "number-anchored opener",
    meaning:
      "Always include a count × rate × time estimate in first outreach — quantified even at spark-interest before buyer attest.",
  },
  {
    key: "C3-shaped closer",
    meaning:
      "Frame the opening message toward the vision-confirmation shape (C3 skeleton); compress R/I implication into the opener and invite a 'yes/no' on outcome.",
  },
] as const;

export const FREE_AXES: Record<string, FreeAxisDefinition> = {
  pain_chain_lean: {
    name: "pain_chain_lean",
    description: "Your habitual direction when working a Pain Chain (walk-up vs walk-down vs lateral-first).",
    options: PAIN_CHAIN_LEAN_OPTIONS as readonly { key: string; meaning: string }[] as {
      key: string;
      meaning: string;
    }[],
    defaultPick: "cause-confirmed-then-up",
  },
  lead_role: {
    name: "lead_role",
    description: "Which Key Players List role you habitually open on first.",
    options: LEAD_ROLE_OPTIONS as readonly { key: string; meaning: string }[] as { key: string; meaning: string }[],
    defaultPick: "pain-owner first",
  },
  discovery_lean: {
    name: "discovery_lean",
    description: "Your habitual pacing through the 9-block / Value Cycle.",
    options: DISCOVERY_LEAN_OPTIONS as readonly { key: string; meaning: string }[] as {
      key: string;
      meaning: string;
    }[],
    defaultPick: "ratio-disciplined",
  },
  story_shape: {
    name: "story_shape",
    description: "Your habitual first-outreach shape at spark-interest phase.",
    options: STORY_SHAPE_OPTIONS as readonly { key: string; meaning: string }[] as { key: string; meaning: string }[],
    defaultPick: "reference-story led",
  },
};

export const FREE_AXIS_DEFAULTS: FreeAxesRecord = {
  // biome-ignore lint/style/noNonNullAssertion: keys are statically populated literals above.
  pain_chain_lean: FREE_AXES.pain_chain_lean!.defaultPick,
  // biome-ignore lint/style/noNonNullAssertion: keys are statically populated literals above.
  lead_role: FREE_AXES.lead_role!.defaultPick,
  // biome-ignore lint/style/noNonNullAssertion: keys are statically populated literals above.
  discovery_lean: FREE_AXES.discovery_lean!.defaultPick,
  // biome-ignore lint/style/noNonNullAssertion: keys are statically populated literals above.
  story_shape: FREE_AXES.story_shape!.defaultPick,
};

/** Zod schema constraining each axis to its allowed option keys. */
export const freeAxesSchema = z.object({
  pain_chain_lean: z.enum(PAIN_CHAIN_LEAN_OPTIONS.map((o) => o.key) as [string, ...string[]]),
  lead_role: z.enum(LEAD_ROLE_OPTIONS.map((o) => o.key) as [string, ...string[]]),
  discovery_lean: z.enum(DISCOVERY_LEAN_OPTIONS.map((o) => o.key) as [string, ...string[]]),
  story_shape: z.enum(STORY_SHAPE_OPTIONS.map((o) => o.key) as [string, ...string[]]),
});

/** Render an axis's option pool as a numbered list (for readline prompts). */
export function formatAxisOptionsForPrompt(axisKey: string): string {
  const axis = FREE_AXES[axisKey];
  if (!axis) throw new Error(`Unknown axis: ${axisKey}`);
  const lines = [`\n${axis.name} — ${axis.description}`];
  axis.options.forEach((opt, i) => {
    const marker = opt.key === axis.defaultPick ? " [default]" : "";
    lines.push(`  ${i + 1}. ${opt.key}${marker}`);
    lines.push(`     ${opt.meaning}`);
  });
  return lines.join("\n");
}

/** Look up an option's meaning by axis + key. Returns undefined if not found. */
export function getAxisOptionMeaning(axisKey: string, optionKey: string): string | undefined {
  return FREE_AXES[axisKey]?.options.find((o) => o.key === optionKey)?.meaning;
}
