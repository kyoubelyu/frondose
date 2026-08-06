import type { IncomingMessage, ServerResponse } from "node:http";
import { frondoseEnv } from "../../../env.js";
import {
  type PublishPostActionResult,
  publishApprovedFeedPostViaAction,
} from "../../../linkedin/action/publishPost.js";
import { writeWorkflowAudit } from "../../../persistence/audit.js";
import type { ServeDeps, ServeState } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";
import type { createTurnRunner } from "../turn.js";
import { handleWorkflowCancel } from "./workflowCancel.js";

export async function handlePostWorkflow(
  state: ServeState,
  deps: ServeDeps,
  turn: ReturnType<typeof createTurnRunner>,
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
): Promise<void> {
  const body = await readJsonBody(req);
  const r = deps.workflow.handleEndpoint(url, body);
  if (url === "/workflow/cancel") {
    // P-AUTO-16 RLS-6 handling extracted to workflowCancel.ts (§4.2 LoC budget) —
    // behavior preserved byte-identical. Returns true if it already sent a
    // short-circuit response (controller said no_workflow AND we closed a run).
    if (handleWorkflowCancel(state, deps, r, res)) return;
  }
  const resumePrompt = r.resumePrompt;
  if (resumePrompt) {
    const killSwitch = frondoseEnv("DETERMINISTIC_POST_PUBLISH") === "skip";
    const draftId = r.draftId;
    const stepId = r.stepId;
    if (!killSwitch && url === "/workflow/approve" && r.isPostPublish === true && draftId && stepId) {
      const publish = deps.publishApprovedFeedPostViaAction ?? publishApprovedFeedPostViaAction;
      void (async () => {
        let result: PublishPostActionResult;
        try {
          const clientRes = await deps.session.getOrInitClient();
          if (!clientRes.ok) {
            await turn.resumeWorkflowTurn(resumePrompt);
            return;
          }
          const wfState = deps.workflow.getState();
          result = await publish({
            session: deps.session,
            client: clientRes.client,
            salesDbPath: deps.salesDbPath,
            auditPath: deps.auditPath,
            workflowDeps: {
              emitFrame: deps.emitFrame,
              writeWorkflowAudit: (event) => writeWorkflowAudit(deps.auditPath, event),
            },
            workflowId: wfState.current?.id ?? null,
            stepId,
            draftId,
          });
        } catch {
          await turn.resumeWorkflowTurn(resumePrompt);
          return;
        }
        if (result.dispatchAttempted) return;
        if (result.fallbackAllowed) await turn.resumeWorkflowTurn(resumePrompt);
      })();
    } else {
      void turn.resumeWorkflowTurn(resumePrompt);
    }
  }
  sendJson(res, r.status, r.response);
}
