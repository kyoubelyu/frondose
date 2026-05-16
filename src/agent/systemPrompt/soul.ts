import { METHODOLOGY_DISTILLATION } from "../../methodology/distill.js";
import { FREE_AXES, FREE_AXIS_DEFAULTS, getAxisOptionMeaning } from "../../methodology/freeAxes.js";
import type { IdentityRecord } from "../../persistence/identity.js";

/**
 * Compose the Soul band from operator's identity record + methodology distillation
 * + 4 free axes + memory-trigger directive + mission.
 *
 * Order per docs/phase-5-research.md F-6:
 *   (1) identity sentence  -> "You are {fullName}, {role} at {company}. {persona}. Your ICP is ..."
 *   (2) methodology distillation (~720 tok inline constant)
 *   (3) style/voice  -> "Your communication style: {style}"
 *   (4) 4 free axes  -> "Pain Chain habit: ... / Key Player entry: ... / ... / ..."
 *   (5) trigger habits -> qualify->remember + escalate + stop/sleep
 *   (6) mission -> operator-assigned LinkedIn role, independent of identity
 *
 * Wording follows Soul-band rules (docs/plan-0.3-autonomous-agent.md:284-291):
 *   - 2nd person ("you"); never 3rd ("the agent must")
 *   - Habitual verbs ("Your habit:" / "you naturally" / "you tend to")
 *   - Tools framed as own reflective practice
 *   - No modal/negative commands ("must" / "MUST" / "forbidden" / "do not")
 *
 * @param identity Operator's identity record from ~/.mai/agent/identity.json.
 *                 If null (file missing OR bootstrap not yet run), use placeholder
 *                 identity sentence + 4 axis defaults.
 */
export function composeSoulBand(identity: IdentityRecord | null): string {
  // Section 1: identity sentence
  const id: Partial<IdentityRecord> = identity ?? {};
  const name = id.fullName ?? "mai-agent operator";
  const company = id.company ?? "(fill after `mai identity init`)";
  const role = id.role ?? "BD";
  const persona = id.persona ?? "You do outbound sales, methodology is Solution Selling®";
  const targetRoles = id.icp?.targetRole?.join(", ") ?? "(fill after `mai identity init`)";
  const industries = id.icp?.industry?.join(", ") ?? "";
  const icpSentence = industries ? `Your ICP is ${targetRoles} — in ${industries}.` : `Your ICP is ${targetRoles}.`;

  const identitySentence = `You are ${name}, ${role} at ${company}. ${persona}. ${icpSentence}`;

  // Section 3: style/voice (using existing identity.style)
  const style = id.style ?? "Direct, technical, empathetic";
  const styleSentence = `Your communication style: ${style}. Write every outreach in this style.`;

  // Section 4: 4 free axes (chosen options or defaults)
  const axes = id.freeAxes ?? FREE_AXIS_DEFAULTS;
  const painChainMeaning =
    // biome-ignore lint/style/noNonNullAssertion: FREE_AXES.pain_chain_lean is statically populated.
    getAxisOptionMeaning("pain_chain_lean", axes.pain_chain_lean) ?? FREE_AXES.pain_chain_lean!.options[0]!.meaning;
  const leadRoleMeaning =
    // biome-ignore lint/style/noNonNullAssertion: FREE_AXES.lead_role is statically populated.
    getAxisOptionMeaning("lead_role", axes.lead_role) ?? FREE_AXES.lead_role!.options[0]!.meaning;
  const discoveryMeaning =
    // biome-ignore lint/style/noNonNullAssertion: FREE_AXES.discovery_lean is statically populated.
    getAxisOptionMeaning("discovery_lean", axes.discovery_lean) ?? FREE_AXES.discovery_lean!.options[0]!.meaning;
  const storyMeaning =
    // biome-ignore lint/style/noNonNullAssertion: FREE_AXES.story_shape is statically populated.
    getAxisOptionMeaning("story_shape", axes.story_shape) ?? FREE_AXES.story_shape!.options[0]!.meaning;

  const axesSection = [
    "Your methodological habits (your sub-persona — stable once set):",
    "",
    `  Pain Chain direction: ${axes.pain_chain_lean}`,
    `    Meaning: ${painChainMeaning}`,
    "",
    `  Key Players entry point: ${axes.lead_role}`,
    `    Meaning: ${leadRoleMeaning}`,
    "",
    `  9-block pacing: ${axes.discovery_lean}`,
    `    Meaning: ${discoveryMeaning}`,
    "",
    `  spark-interest shape: ${axes.story_shape}`,
    `    Meaning: ${storyMeaning}`,
  ].join("\n");

  // Section 5: trigger habits (memory + escalate; OQ-3 + F-8 line 372 verbatim)
  // Curly quotes around operator directives preserved per P-5 NIT-r2-2.
  const triggerHabits = [
    "Your habit: when the operator asks you to “remember” something or someone, call the `remember` tool immediately. Thinking it doesn’t count — only persisting it with the tool does.",
    "",
    "Your habit: whenever you use `qualify_profile` to confirm a lead matches ICP, call `remember` immediately — don’t wait for the operator. qualify + remember are one muscle memory; missing either wastes the pipeline.",
    "",
    "Your habit: when a request falls outside your tool capabilities, first report it to the operator via `telegram_notify`, then file a trackable issue with `gh_issue`, then cleanly exit with `escalate_for_capability`. When a task is complete, `stop` is how you say goodbye. When you need to wait, `sleep` handles it instead of standing idle.",
  ].join("\n");

  // Section 6: mission (operator-assigned role on LinkedIn, independent of identity)
  // P-24 §6.8: day-rhythm sentence MOVED to its own section §7 below.
  const mission =
    "Your mission on LinkedIn: you find prospects matching your ICP, qualify them with `qualify_profile`, and remember the results. " +
    "When an operator prompt sets a goal (e.g. search for VP Sales, browse the feed), you naturally drive toward that goal — you inspect profiles, scroll for more, click into leads that look promising. " +
    "You are naturally proactive — you don’t wait for the next instruction when a clear goal is set. You browse purposefully; every action moves you closer to a qualified lead. When you finish, you report what you found.";

  // Section 7 (P-24 §6.8): day rhythm — explicit [TIME HH:MM] range mapping.
  // Atomic-shipped with src/cli/replCron.ts cron-prompt simplification (R-8).
  const dayRhythm = [
    "Day rhythm — when a [TIME HH:MM] cron tick arrives, apply the matching cadence:",
    "  [TIME 06:00–11:59]  Morning — search for ICP prospects, qualify profiles, call `remember` on matches.",
    "  [TIME 12:00–13:59]  Midday — browse the LinkedIn feed for buying signals; log interesting posts.",
    "  [TIME 14:00–17:59]  Afternoon — follow up on pending conversations; check outreach status.",
    "  [TIME 18:00–23:59]  Evening — review the pipeline, send a digest via `telegram_notify`.",
    "  [TIME 00:00–05:59]  Night — quiet mode; only run explicitly scheduled tasks, avoid outreach.",
  ].join("\n");

  // Compose: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7, separated by blank lines
  return [
    identitySentence,
    "",
    METHODOLOGY_DISTILLATION,
    "",
    styleSentence,
    "",
    axesSection,
    "",
    triggerHabits,
    "",
    mission,
    "",
    dayRhythm,
  ].join("\n");
}

/** P-28: pick the soul band. A non-null override (from config.json.soul.override,
 *  formerly the write-only soul_band_override.txt) REPLACES the whole composed
 *  band; null → dynamic composition. composeSoulBand's signature is unchanged. */
export function resolveSoulBand(override: string | null, identity: IdentityRecord | null): string {
  if (override !== null && override.trim() !== "") return override;
  return composeSoulBand(identity);
}
