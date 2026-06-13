import { type Tool, tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import type { ControlSignals } from "./stop.js";

const escalateParams = z.object({
  neededCapability: z
    .string()
    .min(1)
    .max(200)
    .describe("Short label of the capability the agent needs that is not in the tool list."),
  whyExistingToolsInsufficient: z.string().min(1).max(500).describe("Why existing tools cannot address this need."),
  reproducerSteps: z
    .string()
    .max(1000)
    .optional()
    .describe("Steps to reproduce the situation (helpful for the gh_issue body)."),
});

export interface EscalateDeps {
  telegramTool: Tool;
  ghIssueTool: Tool;
  control: ControlSignals | undefined;
}

/**
 * Build the escalate_for_capability tool. The composite calls telegram_notify
 * + gh_issue sequentially (both best-effort), then conditionally calls stop:
 *   1. await telegramNotify.execute({ severity: "error", body }) — best-effort
 *   2. await ghIssue.execute({ title, body, dedupKey }) — best-effort
 *   3. control.requestStop() — UNCONDITIONAL in autonomous/cron mode (F-3 / OQ-5);
 *      SUPPRESSED in interactive REPL mode (P-54 OQ-1) so a misfire on a chat
 *      question cannot kill the operator's session. Telegram + gh_issue still
 *      fire in both modes (per P-54 OQ-4 — gh_issue is not gated by mode).
 *
 * The LLM sees ONE tool call (escalate_for_capability) and ONE envelope return.
 * Inner Telegram + gh_issue API calls are internal side-effects whose outcomes
 * are folded into the composite envelope. The envelope's `stopped` field
 * mirrors the mode: `true` in autonomous/cron, `false` in interactive REPL.
 */
export function makeEscalateTool(deps: EscalateDeps) {
  const requestStop =
    deps.control?.requestStop ??
    (() => {
      process.stderr.write(
        "[frondose] escalate tool called but control.requestStop is not wired (likely a test environment). No-op.\n",
      );
    });
  return tool({
    description:
      "Composite escalation for a GENUINE capability gap encountered MID-TASK. " +
      "This single tool internally sends the Telegram notification, files the GitHub issue, " +
      "and signals stop — do NOT call `telegram_notify` or `gh_issue` yourself before it; " +
      "that would double-notify and double-file. " +
      "Use ONLY when you are executing a specific task (navigate, click, type, search, …) " +
      "and have determined mid-execution that a required capability is genuinely absent from " +
      "your tool list (not a transient error, not a retry-able failure). " +
      "Do NOT call in response to conversational questions, hypotheticals, or meta-discussions " +
      "about your capabilities — those are conversation, answer in plain text. " +
      "Return envelope: `stopped: true` in autonomous/cron mode (agent loop exits); " +
      "`stopped: false` in interactive REPL mode (session stays alive — do NOT re-invoke; " +
      "surface the situation to the operator in your next message). " +
      "Telegram + gh_issue failures are logged in the envelope.",
    parameters: escalateParams,
    execute: async (params) => {
      const tgBody =
        `Capability gap: ${params.neededCapability}\n\n` +
        `Why existing tools insufficient: ${params.whyExistingToolsInsufficient}` +
        (params.reproducerSteps ? `\n\nReproducer:\n${params.reproducerSteps}` : "");

      let telegramOutcome: unknown = null;
      let telegramFailure: string | null = null;
      try {
        // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is dynamically typed by Vercel
        const tgExec = (deps.telegramTool as any).execute as (
          args: { body: string; severity: string },
          ctx?: unknown,
        ) => Promise<unknown>;
        telegramOutcome = await tgExec({ body: tgBody, severity: "error" }, undefined);
      } catch (e) {
        telegramFailure = e instanceof Error ? e.message : String(e);
      }

      const issueTitle = `[frondose escalation] ${params.neededCapability}`;
      const issueBody =
        `**Capability gap:** ${params.neededCapability}\n\n` +
        `**Why existing tools insufficient:** ${params.whyExistingToolsInsufficient}\n\n` +
        (params.reproducerSteps ? `**Reproducer:**\n\n\`\`\`\n${params.reproducerSteps}\n\`\`\`\n` : "");
      const dedupKey = `escalate:${params.neededCapability
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 64)}`;

      let ghOutcome: unknown = null;
      let ghFailure: string | null = null;
      try {
        // biome-ignore lint/suspicious/noExplicitAny: same
        const ghExec = (deps.ghIssueTool as any).execute as (
          args: { title: string; body: string; labels: string[]; dedupKey: string },
          ctx?: unknown,
        ) => Promise<unknown>;
        ghOutcome = await ghExec({ title: issueTitle, body: issueBody, labels: ["escalation"], dedupKey }, undefined);
      } catch (e) {
        ghFailure = e instanceof Error ? e.message : String(e);
      }

      // P-54 OQ-1: interactive REPL mode suppresses the stop call (telegram +
      // gh_issue still fired above). Cron / autonomous mode keeps the F-3
      // unconditional-stop semantics. Read at EXECUTE time (not factory time)
      // because `control.isInteractive` is mutated per-turn — the interactive
      // operator-turn flips it to `true` before each runAgentLoop call.
      const isInteractive = deps.control?.isInteractive === true;
      if (!isInteractive) {
        // Unconditional stop — failure of telegram or gh_issue does not block exit.
        try {
          requestStop();
        } catch (e) {
          // requestStop should never throw; if it does, log + proceed.
          process.stderr.write(
            `[frondose] escalate: requestStop threw: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      }

      try {
        return ok("escalate_for_capability", {
          stopped: !isInteractive,
          telegramOutcome,
          telegramFailure,
          ghOutcome,
          ghFailure,
          dedupKey,
        });
      } catch (e) {
        return failFromError("escalate_for_capability", e);
      }
    },
  });
}
