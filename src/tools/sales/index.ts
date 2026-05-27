import type { ToolSet } from "ai";
import { makeEndAutoRunTool } from "./endAutoRun.js";
import { makeGetAccountContextTool } from "./getAccountContext.js";
import { makeGetAutoRunStateTool } from "./getAutoRunState.js";
import { makeGetLeadContextTool } from "./getLeadContext.js";
import { makeGetSalesReportTool } from "./getSalesReport.js";
import { makeListDueFollowupsTool } from "./listDueFollowups.js";
import { makeMarkMessageSentTool } from "./markMessageSent.js";
import { makePromoteCandidateToLeadTool } from "./promoteCandidateToLead.js";
import { makeRecordAutoActionTool } from "./recordAutoAction.js";
import { makeRecordLeadEventTool } from "./recordLeadEvent.js";
import { makeRecordRawCandidateTool } from "./recordRawCandidate.js";
import { makeSaveMessageDraftTool } from "./saveMessageDraft.js";
import { makeScheduleFollowUpTool } from "./scheduleFollowUp.js";
import { makeScoreAccountTool } from "./scoreAccount.js";
import { makeScoreLeadTool } from "./scoreLead.js";
import { makeStartAutoRunTool } from "./startAutoRun.js";
import { makeUpdateLeadStageTool } from "./updateLeadStage.js";

/** P-SP-A/P-SP-F: build the 17 sales-kernel tools.
 *  Worker-mode only (per P-SP-A non-goal: server mode has no LinkedIn primitives). */
export function makeSalesTools(salesDbPath: string): ToolSet {
  return {
    record_raw_candidate: makeRecordRawCandidateTool(salesDbPath),
    promote_candidate_to_lead: makePromoteCandidateToLeadTool(salesDbPath),
    update_lead_stage: makeUpdateLeadStageTool(salesDbPath),
    record_lead_event: makeRecordLeadEventTool(salesDbPath),
    save_message_draft: makeSaveMessageDraftTool(salesDbPath),
    mark_message_sent: makeMarkMessageSentTool(salesDbPath),
    schedule_follow_up: makeScheduleFollowUpTool(salesDbPath),
    list_due_followups: makeListDueFollowupsTool(salesDbPath),
    get_lead_context: makeGetLeadContextTool(salesDbPath),
    get_account_context: makeGetAccountContextTool(salesDbPath),
    get_auto_run_state: makeGetAutoRunStateTool(salesDbPath),
    record_auto_action: makeRecordAutoActionTool(salesDbPath),
    score_lead: makeScoreLeadTool(salesDbPath),
    score_account: makeScoreAccountTool(salesDbPath),
    start_auto_run: makeStartAutoRunTool(salesDbPath),
    end_auto_run: makeEndAutoRunTool(salesDbPath),
    get_sales_report: makeGetSalesReportTool(salesDbPath),
  };
}
