// P-72 slice 12 — extracted from src/tauri/ui/render.ts L22-74.
// Structural *Like interfaces (DOM-lib-free) + Step/Workflow data shapes.
// Re-exported by the ./render.js barrel.

import type { AppMode } from "../mode.js";

export interface ClassListLike {
  add(token: string): void;
  remove(token: string): void;
  toggle(token: string, force?: boolean): void;
}

export interface TextElementLike {
  classList: ClassListLike;
  textContent: string | null;
  setAttribute?(name: string, value: string): void;
}

export interface ElementLike extends TextElementLike {
  appendChild(child: ElementLike): void;
}

export interface ButtonElementLike extends TextElementLike {
  disabled: boolean;
  addEventListener(type: "click", listener: () => void): void;
}

export interface InputElementLike extends TextElementLike {
  value: string;
  disabled: boolean;
  addEventListener(type: "keydown", listener: (e: { key?: string; preventDefault: () => void }) => void): void;
  addEventListener(type: "input", listener: () => void): void;
}

export interface DocumentLike {
  documentElement: ElementLike;
  body?: ElementLike;
  getElementById(id: string): TextElementLike | null;
  createElement(tagName: string): ElementLike;
  createElementNS?(namespace: string, tagName: string): ElementLike;
}

export type StepState = "pending" | "in_progress" | "completed" | "failed";

export type StepLike = {
  id: string;
  title: string;
  requiresApproval?: boolean;
  state: StepState;
};

export type WorkflowLike = {
  workflowId: string;
  title: string;
  approvalMode: AppMode;
  steps: StepLike[];
  pendingStepId: string | null;
  notice: string;
};
