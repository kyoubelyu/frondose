import { randomUUID } from "node:crypto";
import type { CoreMessage, StepResult, ToolSet } from "ai";
import { runAgentLoop } from "../../agent/loop.js";
import type { OverlayEvent } from "../../overlay/eventBus.js";
import { callInOverlay } from "../../overlay/inject.js";
import type { ServeDeps, ServeState, SuggestionCardPayload } from "./context.js";

const PASSIVE_PROFILE_CACHE_TTL_MS = 10 * 60 * 1000;

function overlayStringField(event: OverlayEvent, key: string): string | undefined {
  const eventRecord = event as unknown as Record<string, unknown>;
  const payload = event.payload;
  const direct = eventRecord[key];
  if (typeof direct === "string") return direct;
  const fromPayload = payload?.[key];
  return typeof fromPayload === "string" ? fromPayload : undefined;
}

function isProfileCacheHit(state: ServeState, handle: string): boolean {
  const entry = state.passiveProfileCache.get(handle);
  if (entry === undefined) return false;
  if (Date.now() - entry.ts <= PASSIVE_PROFILE_CACHE_TTL_MS) return true;
  state.passiveProfileCache.delete(handle);
  return false;
}

export function createPassiveHandlers(
  state: ServeState,
  deps: ServeDeps,
): {
  handlePassiveProfileNav(event: OverlayEvent): void;
  handlePassiveObservation(event: OverlayEvent): void;
} {
  function handlePassiveProfileNav(event: OverlayEvent): void {
    const handle = overlayStringField(event, "handle");
    const url = overlayStringField(event, "url");
    const ts = Date.now();
    if (!state.passiveEnabled) {
      deps.emitFrame({ type: "passive-skipped", ts, reason: "disabled" });
      return;
    }
    if (state.currentTurn !== null) {
      deps.emitFrame({ type: "passive-skipped", ts, reason: "busy" });
      return;
    }
    if (!handle || !url) return;
    if (isProfileCacheHit(state, handle)) {
      deps.emitFrame({ type: "passive-skipped", ts, reason: "cache_hit" });
      return;
    }
    if (!state.passiveLimiter.tryConsume()) {
      deps.emitFrame({ type: "passive-skipped", ts, reason: "rate_limit" });
      return;
    }
    state.passiveProfileCache.set(handle, { ts: Date.now() });
    void triggerPassiveAnalysis("profile-nav", { handle, url });
  }

  function handlePassiveObservation(event: OverlayEvent): void {
    const ts = Date.now();
    if (!state.passiveEnabled) {
      deps.emitFrame({ type: "passive-skipped", ts, reason: "disabled" });
      return;
    }
    if (state.currentTurn !== null) {
      deps.emitFrame({ type: "passive-skipped", ts, reason: "busy" });
      return;
    }

    const eventType = typeof event.payload?.event_type === "string" ? event.payload.event_type : undefined;
    const ctx = event.payload?.ctx;
    if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return;
    const ctxRecord = ctx as Record<string, unknown>;

    if (eventType === "click") {
      // P-57e rev-2 (item d): tier-2 ICP-text filter REMOVED. Client-side
      // getElementRef (inject.ts) already filters non-interactive clicks at
      // the observer; null-ref clicks never reach serve.ts. Rate-limit (1/30s
      // + 5/60s) + profile-cache dedup are sufficient cost-control.
      // Removed: profilePageHit, icpRoleHit, matchIcp call — operator framing
      // 2026-05-22 "any refable click → agent + ref name" — every interactive
      // click is intent-bearing.
      if (!state.passiveLimiter.tryConsume()) {
        deps.emitFrame({ type: "passive-skipped", ts, reason: "rate_limit", ctx: ctxRecord });
        return;
      }
      void triggerPassiveAnalysis("click", ctxRecord);
      return;
    }

    if (eventType === "input") {
      if (!state.passiveLimiter.tryConsume()) {
        deps.emitFrame({ type: "passive-skipped", ts, reason: "rate_limit", ctx: ctxRecord });
        return;
      }
      void triggerPassiveAnalysis("input", ctxRecord);
    }
  }

  function buildPassivePrompt(eventType: string, ctx: Record<string, unknown>): string {
    if (eventType === "profile-nav") {
      // P-SP-C: Magical-mode profile-nav sequence — every observation enters the
      // sales kernel. record_raw_candidate is upsertable by profileUrl (safe to
      // call on repeat views; just bumps last_seen_at). score_lead requires the
      // candidateId from step 1's response (P-SP-B FK pre-check at scoreLead.ts).
      // suggest_card is surfaced only when the score warrants. NO outbound in
      // Magical mode — never call click/navigate/connect/message in this turn.
      return [
        `Operator viewed LinkedIn profile: ${ctx.handle} (${ctx.url}).`,
        ``,
        `Step 1: call \`record_raw_candidate\` with { profileUrl: "${ctx.url}", personName: (inferred from page context or "unknown"), source: "profile-nav", sourceContext: "${ctx.handle}", evidenceSummary: (one-line role/headline if you can read it, else omit) }. The response data.candidateId is required for step 3a.`,
        `Step 2: call \`search_memory\` for "${ctx.handle}" — retrieve any prior context.`,
        `Step 2b: call \`qualify_profile\` with { role, industry, region, companyName } extracted from the visible profile (omit any dimension you can't read — that dimension becomes "unknown"). The returned data.qualification (one of "qualified" | "partial_match" | "tracked" | "unknown" | "disqualified") is REQUIRED for step 3a.`,
        `Step 3a: if context is sufficient (role + company visible OR prior memory found) → call \`score_lead\` with { candidateId: <from step 1>, leadId: null, qualification: <from step 2b — REQUIRED>, totalScore: 0–100 (consistent with the qualification band: disqualified 0-19, tracked 0-39, partial_match 40-59, qualified 60-100; unknown = no constraint — for thin first-view evidence a low score is fine), confidence: 0.1–0.4 (low for first passive view; higher only if prior memory adds evidence), icpFit, painHypothesis, buyingTrigger, authorityLevel, suggestedOpeningLine, nextAction: "research_more" | "connect" | "message" | "wait_for_signal", evidenceJson, methodUsed: "solution_selling" (or another methodology) }.`,
        `Step 3b: if context is insufficient → call \`remember\` (kind: "at", note: "profile-view footprint — insufficient evidence for score") and then \`stop\`.`,
        `Step 4: if step 3a ran AND the returned totalScore ≥ 40 AND painHypothesis is non-empty → call \`suggest_card\` with { title: (personName + " — " + painHypothesis truncated to ~60 chars), totalScore: <from step 3a>, evidenceSummary: (one-line digest), icpMatch: { qualified: icpFit !== "none", matched: [...], missing: [...] }, painChainHypothesis, painChainStage, suggestedMove: { kind: "connect"|"comment"|"message", text: suggestedOpeningLine } }.`,
        ``,
        `Hard constraint: NEVER call \`click\`, \`navigate_to_url\`, \`connect\`, \`message\`, or any outbound tool in this turn — Magical mode is observe-and-judge only. Typical sequence length: 4–6 steps; maxSteps is 20.`,
      ].join("\n");
    }
    if (eventType === "click") {
      // P-57e rev-2 (items c+e): ctx.ref from getElementRef; memory-first default.
      const ref = ctx.ref && typeof ctx.ref === "object" ? (ctx.ref as Record<string, unknown>) : {};
      // rev-1 MR fix: ariaLabel FIRST (most human-readable headline — natural language
      // describing action + target aids LLM comprehension). controlName + all other
      // fields stay fully visible to the LLM via the `ctx.ref: ${JSON.stringify(ref)}`
      // dump on the line below — nothing lost; headline just reads naturally.
      const refSummary =
        [ref.ariaLabel, ref.controlName, ref.text].filter(
          (v) => typeof v === "string" && (v as string).length > 0,
        )[0] ?? "(unlabelled)";
      return [
        `Operator clicked: ${ref.tag ?? "?"} "${String(refSummary).slice(0, 80)}" at ${ctx.url}.`,
        `ctx.ref: ${JSON.stringify(ref)}.`,
        ``,
        `Default response is memory-first: call \`remember\` to record this footprint (interaction kind matching the click intent — like, comment, connect, message, post, etc. — derived from ref.ariaLabel/controlName), then \`stop\`.`,
        `Call \`suggest_card\` ONLY when this click signals a Pain-Chain-suggestion-worthy moment: e.g. operator is reading a NEW ICP-match profile and you have a methodology insight worth surfacing.`,
        `Routine engagement clicks (Like / Comment / Connect / Send / Follow buttons) → remember+stop. Composer interactions (input/textarea typing) → remember the draft snippet + stop. Profile-nav footprint where you already have memory → remember-or-stop (don't re-suggest_card the same profile).`,
      ].join("\n");
    }
    if (eventType === "input") {
      const snippet = typeof ctx.snippet === "string" ? (ctx.snippet as string).slice(0, 100) : undefined;
      return [
        `Operator is composing a message (${ctx.charCount} chars). Snippet: ${JSON.stringify(snippet)}.`,
        ``,
        `Default response: call \`remember\` to record this draft moment (interaction kind: message; note the snippet preview + person context if visible), then \`stop\`.`,
        `Call \`suggest_card\` ONLY if the draft is incomplete/struggling AND you have a strong methodology-aligned rephrase to offer.`,
      ].join("\n");
    }
    return "";
  }

  function passiveRefSummary(eventType: string, ctx: Record<string, unknown>): string {
    if (eventType === "click") {
      const ref = (ctx.ref as Record<string, string> | undefined) ?? {};
      return (
        [ref.ariaLabel, ref.controlName, ref.text]
          .find((v) => typeof v === "string" && v.trim().length > 0)
          ?.slice(0, 60) ?? "an element"
      );
    }
    if (eventType === "input") {
      const val = String((ctx.value as string | undefined) ?? "");
      return val.slice(0, 40) || "an input";
    }
    if (eventType === "profile-nav") return String((ctx.handle as string | undefined) ?? "a profile");
    return "the page";
  }

  function passiveTicker(text: string): void {
    const ctxId = state.overlayContextId;
    const client = deps.session.getClient();
    if (ctxId === undefined || !client) return;
    void callInOverlay(client.handle, ctxId, `function() { window.__frondoseUpdateTicker(${JSON.stringify(text)}); }`);
  }

  async function triggerPassiveAnalysis(eventType: string, ctx: Record<string, unknown>): Promise<void> {
    // P-APP-8: passive analysis is opportunistic. When the model is unconfigured,
    // skip with a diagnostic frame instead of surfacing an operator-facing turn error.
    if (deps.model === null) {
      deps.emitFrame({ type: "passive-skipped", ts: Date.now(), reason: "disabled" });
      return;
    }
    const passiveMessages: CoreMessage[] = [];
    const prompt = buildPassivePrompt(eventType, ctx);
    if (!prompt) return;
    passiveMessages.push({ role: "user", content: prompt });
    const turnId = randomUUID();
    // P-57f (D-DOGFOOD-06): real-time ticker feedback — passive turns were silent.
    passiveTicker(`mai · observing ${eventType}: ${passiveRefSummary(eventType, ctx)}…`);
    try {
      // P-AUTO-8 (M1, F-2): passive analysis is ALWAYS Magical context. After the boot split
      // removed the mode fragment from `deps.system`, reading `deps.system` would drop the
      // system-level "You NEVER initiate outbound in Magical mode" sentence (soul.ts:167) for
      // passive turns — which is fine for `profile-nav` (its prompt carries an explicit hard
      // outbound prohibition) but a regression for `click` and `input` passive prompts (which
      // don't). Using `composeOperatorSystem("magical")` here restores that system-level
      // guardrail for all three passive event types, with the fragment INSIDE Soul (3-band
      // invariant preserved).
      await runAgentLoop({
        model: deps.model,
        system: deps.composeOperatorSystem("magical"),
        messages: passiveMessages,
        tools: deps.tools,
        maxSteps: 20,
        onStepFinish: async (step: StepResult<ToolSet>) => {
          await deps.auditWriter(step);
          const toolResults =
            (step as unknown as { toolResults?: Array<{ toolName: string; result: unknown }> }).toolResults ?? [];
          for (const tr of toolResults) {
            if (tr.toolName !== "suggest_card") continue;
            const card = (tr.result as SuggestionCardPayload | undefined) ?? {};
            if (card.dismissed) continue;
            const ctxId = state.overlayContextId;
            const client = deps.session.getClient();
            if (ctxId === undefined || !client) continue;
            const collapsedPayload = {
              id: turnId,
              title: card.title ?? "Suggestion",
              painChainStage: card.painChainStage ?? "",
              fullCardJson: JSON.stringify(card),
            };
            const collapsedJson = JSON.stringify(collapsedPayload);
            void callInOverlay(
              client.handle,
              ctxId,
              `function() { window.__frondoseShowCollapsedCard(${JSON.stringify(collapsedJson)}); }`,
            );
          }
        },
      });
      deps.emitFrame({ type: "passive-fired", turnId, ts: Date.now(), reason: eventType });
      // P-57f: surface a brief result on the ticker (✓-prefix → overlay auto-clears after 5s, §3.2).
      passiveTicker(`✓ noted: ${passiveRefSummary(eventType, ctx)}`);
    } catch (e) {
      deps.emitFrame({
        type: "error",
        turnId,
        message: `passive analysis failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return { handlePassiveProfileNav, handlePassiveObservation };
}
