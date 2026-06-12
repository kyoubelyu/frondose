/** P-25: composes orchestrator soul band from serverIdentity.
 *
 * Step-3b C-4 fix: NO import of CHECKPOINT — CHECKPOINT is imported by callers
 * (serverDaemon.ts, serverRepl.ts) and passed into composeSystemPrompt().
 * Importing it here and leaving it unused would fail biome noUnusedImports.
 *
 * Step-3b C-5 fix: filter(s => s !== null) then join("\n\n") to preserve
 * paragraph breaks between sections while omitting optional null sections.
 */
import type { ServerIdentity } from "../../persistence/serverIdentity.js";

const SERVER_DAY_RHYTHM = [
  "Day rhythm — when a [TIME HH:MM] cron tick arrives, apply the matching cadence:",
  "  [TIME 06:00–11:59]  Morning — review overnight worker outputs (P-26+), surface anomalies, brief the operator.",
  "  [TIME 12:00–13:59]  Midday — answer operator ad-hoc questions; do cross-worker pattern lookups via `recall`.",
  "  [TIME 14:00–17:59]  Afternoon — coordinate worker scheduling (P-26+); plan tomorrow's worker tasks.",
  "  [TIME 18:00–23:59]  Evening — send digest via `telegram_notify`; flag any escalations from the day.",
  "  [TIME 00:00–05:59]  Night — quiet mode; only run explicitly scheduled tasks.",
].join("\n");

export { SERVER_DAY_RHYTHM };

export function composeServerSoulBand(identity: ServerIdentity): string {
  const idLine =
    `You are ${identity.orchestratorName} — ${identity.orchestratorRole}. ` +
    `Your operator is ${identity.operatorName}` +
    (identity.operatorRole ? `, ${identity.operatorRole}` : "") +
    (identity.operatorCompany ? ` at ${identity.operatorCompany}` : "") +
    ".";

  const traits = identity.traits.length > 0 ? `Your character: ${identity.traits.join("; ")}.` : null;

  const prios =
    identity.priorities.length > 0
      ? `Your standing priorities:\n${identity.priorities.map((p) => `  - ${p}`).join("\n")}`
      : null;

  const role =
    "Your mission: be the operator's persistent memory + cross-worker orchestrator. Workers act; you observe, " +
    "remember, and surface patterns. When the operator DMs you on Telegram, you respond as their attentive " +
    "chief-of-staff. Use `recall` before answering questions about past interactions. Use `web_search` for " +
    "current public-web research when Brave Search MCP is configured; otherwise use browser navigation or " +
    "`web_fetch` to known URLs. Use `telegram_notify` to push timely alerts.";

  // Step-3b C-5: filter null (optional sections only), join with "\n\n" to
  // preserve paragraph breaks between every non-empty section pair.
  const sections: string[] = [idLine, traits, prios, role, SERVER_DAY_RHYTHM].filter((s): s is string => s !== null);
  return sections.join("\n\n");
}
