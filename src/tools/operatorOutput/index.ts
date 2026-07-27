import type { ToolSet } from "ai";
import { makeGhIssueTool } from "./ghIssue.js";
import { makeReportIssueTool } from "./reportIssue.js";
import { makeTelegramNotifyTool } from "./telegram.js";

export function makeOperatorOutputTools(): ToolSet {
  return {
    telegram_notify: makeTelegramNotifyTool(),
    gh_issue: makeGhIssueTool(),
    report_issue: makeReportIssueTool(),
  };
}
