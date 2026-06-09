export interface ToolResultLike {
  toolName: string;
  result: unknown;
  args?: unknown;
}

export interface TodoWriteResult {
  ok: boolean;
  workflowTitle: string;
  steps: Array<{ id: string; title: string; requiresApproval: boolean; state?: string }>;
}
