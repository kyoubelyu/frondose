// P-Y1 — Workflow primitive data model.
// Single-session, in-memory only; durable history is audit.jsonl events.

export interface TodoStep {
  id: string;
  title: string;
  state: "pending" | "in_progress" | "completed" | "failed";
  requiresApproval: boolean;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
}

export interface Workflow {
  id: string;
  title: string;
  approvalMode: "manual" | "auto";
  steps: TodoStep[];
  state: "active" | "awaiting_approval" | "completed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowState {
  current: Workflow | null;
  awaitingApprovalStepId: string | null;
}

export interface WorkflowAuditEntry {
  ts: string;
  type: "workflow_event";
  event:
    | { kind: "proposed"; workflowId: string; title: string; approvalMode: string; stepCount: number }
    | { kind: "step_advance"; workflowId: string; stepId: string; prevState: string; nextState: string }
    | { kind: "approval_pending"; workflowId: string; stepId: string; turnIdAborted: string }
    | {
        kind: "approval_resolved";
        workflowId: string;
        stepId: string;
        decision: "approved" | "declined";
        declineReason?: string;
      }
    | { kind: "always_ask"; workflowId: string | null; toolName: "telegram_notify" | "gh_issue"; turnId: string }
    | { kind: "commit_warning"; workflowId: string | null; detectedLabel: string; stepId?: string }
    | { kind: "completed"; workflowId: string; finalState: string };
}

export type WorkflowSseFrame =
  | {
      type: "workflow-proposed";
      turnId: string;
      workflowId: string;
      title: string;
      approvalMode: Workflow["approvalMode"];
      steps: Array<{ id: string; title: string; requiresApproval: boolean; state: TodoStep["state"] }>;
      ts: number;
    }
  | {
      type: "workflow-step-advanced";
      turnId: string;
      workflowId: string;
      stepId: string;
      prevState: TodoStep["state"];
      nextState: TodoStep["state"];
      ts: number;
    }
  | {
      type: "workflow-approval-pending";
      turnId: string;
      workflowId: string;
      stepId: string;
      stepTitle: string;
      ts: number;
    }
  | {
      type: "workflow-approval-resolved";
      turnId: string;
      workflowId: string;
      stepId: string;
      decision: "approved" | "declined";
      ts: number;
    }
  | { type: "workflow-mode-changed"; workflowId: string; approvalMode: Workflow["approvalMode"]; ts: number }
  | { type: "workflow-completed"; workflowId: string; finalState: Workflow["state"]; ts: number }
  | { type: "commit-warning"; workflowId: string | null; label: string; severity: "low"; ts: number };
