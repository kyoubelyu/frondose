import { METHODOLOGY_DISTILLATION } from "../../methodology/distill.js";
import { FREE_AXES, FREE_AXIS_DEFAULTS, getAxisOptionMeaning } from "../../methodology/freeAxes.js";
import type { IdentityRecord } from "../../persistence/identity.js";

/**
 * Compose the Soul band from operator's identity record + methodology distillation
 * + 4 free axes + memory-trigger directive.
 *
 * Order per docs/phase-5-research.md F-6:
 *   (1) identity sentence  → "你是 {fullName}, {company} 的 {role}. {persona}. 你的 ICP 是 ..."
 *   (2) methodology distillation (~660 tok inline constant)
 *   (3) style/voice  → "你的沟通风格: {style}"
 *   (4) 4 free axes  → "你的 Pain Chain 习惯是 ... / 你习惯从 ... 切入 / ... / ..."
 *   (5) memory-trigger directive  → "你的习惯是: operator 让你'记住'..."
 *
 * Wording follows Soul-band rules (docs/plan-0.3-autonomous-agent.md:284-291):
 *   - 2nd person ("你"); never 3rd ("the agent must")
 *   - Habitual verbs ("你的习惯是 / 你倾向 / 你会自然")
 *   - Tools framed as own reflective practice
 *   - No modal/negative commands ("必须" / "MUST" / "禁止" / "do not")
 *
 * @param identity Operator's identity record from ~/.mai/agent/identity.json.
 *                 If null (file missing OR bootstrap not yet run), use placeholder
 *                 identity sentence + 4 axis defaults.
 */
export function composeSoulBand(identity: IdentityRecord | null): string {
  // ── Section 1: identity sentence ─────────────────────────────
  const id: Partial<IdentityRecord> = identity ?? {};
  const name = id.fullName ?? "mai-agent operator";
  const company = id.company ?? "(company 待 identity init 后填入)";
  const role = id.role ?? "BD";
  const persona = id.persona ?? "你做 outbound 销售工作，方法论是 Solution Selling®";
  const targetRoles = id.icp?.targetRole?.join("、") ?? "(ICP 待 identity init 后填入)";
  const industries = id.icp?.industry?.join("、") ?? "";
  const icpSentence = industries
    ? `你的 ICP 是 ${targetRoles} — 在 ${industries} 行业。`
    : `你的 ICP 是 ${targetRoles}。`;

  const identitySentence = `你是 ${name}，${company} 的 ${role}。${persona}。${icpSentence}`;

  // ── Section 3: style/voice (using existing identity.style) ───
  const style = id.style ?? "直接、技术化、有同理心";
  const styleSentence = `你的沟通风格：${style}。你按这个风格写每一条 outreach。`;

  // ── Section 4: 4 free axes (chosen options or defaults) ──────
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

  const axesSection = `
你的方法论习惯（你的 sub-persona — 锁定后稳定）：

  Pain Chain 方向：${axes.pain_chain_lean}
    意思是：${painChainMeaning}

  Key Players 切入：${axes.lead_role}
    意思是：${leadRoleMeaning}

  9-block 节奏：${axes.discovery_lean}
    意思是：${discoveryMeaning}

  spark-interest 风格：${axes.story_shape}
    意思是：${storyMeaning}
`.trim();

  // ── Section 5: trigger habits (memory + escalate; OQ-3 + F-8 line 372 verbatim) ──
  // CJK typographic quotes (U+201C/U+201D) around 记住 are preserved verbatim per
  // P-5 NIT-r2-2 / P-6 dispatch carryover. Same preservation applies to the
  // escalate-habit directive below.
  const triggerHabits =
    "你的习惯是：operator 让你“记住”某件事或某个人，你立刻调用 `remember` 工具记下来。想着说不算，工具存下来才算。\n\n" +
    "你的习惯是 — 遇到工具能力之外的请求，先用 `telegram_notify` 报告 operator，再用 `gh_issue` 留下可追踪的票，然后 `escalate_for_capability` 干净退出。任务完成时，`stop` 就是你说再见的方式。需要等一下，`sleep` 代替你站在那里等。";

  // ── Compose: 1 → 2 → 3 → 4 → 5, separated by blank lines ────
  return [identitySentence, "", METHODOLOGY_DISTILLATION, "", styleSentence, "", axesSection, "", triggerHabits].join(
    "\n",
  );
}
