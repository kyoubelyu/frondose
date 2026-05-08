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
 * + gh_issue + stop sequentially and unconditionally:
 *   1. await telegramNotify.execute({ severity: "error", body }) — best-effort
 *   2. await ghIssue.execute({ title, body, dedupKey }) — best-effort
 *   3. control.requestStop() — UNCONDITIONAL (per scout F-3 / OQ-5 failure-of-failure rule)
 *
 * The LLM sees ONE tool call (escalate_for_capability) and ONE envelope return.
 * Inner Telegram + gh_issue API calls are internal side-effects whose outcomes
 * are folded into the composite envelope.
 */
export function makeEscalateTool(deps: EscalateDeps) {
  const requestStop =
    deps.control?.requestStop ??
    (() => {
      process.stderr.write(
        "[mai] escalate tool called but control.requestStop is not wired (likely a test environment). No-op.\n",
      );
    });
  return tool({
    description:
      "Escalate for a capability gap: notify operator via Telegram, file a tracked GitHub issue, then stop the agent cleanly. " +
      "Use ONLY when you've encountered a real capability gap (not a transient error). " +
      "Telegram + gh_issue failures are logged in the return envelope; the stop signal fires regardless.",
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

      const issueTitle = `[mai-agent escalation] ${params.neededCapability}`;
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

      // UNCONDITIONAL stop — failure of telegram or gh_issue does not block exit.
      try {
        requestStop();
      } catch (e) {
        // requestStop should never throw; if it does, log + proceed.
        process.stderr.write(`[mai] escalate: requestStop threw: ${e instanceof Error ? e.message : String(e)}\n`);
      }

      try {
        return ok("escalate_for_capability", {
          stopped: true,
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
