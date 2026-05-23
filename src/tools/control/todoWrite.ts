import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";

export const todoWriteSchema = z.object({
  workflowTitle: z.string().min(1).max(200).describe("Operator-readable workflow title. Max 200 chars."),
  steps: z
    .array(
      z.object({
        title: z.string().min(1).max(120).describe("Operator-readable step title. Max 120 chars."),
        requiresApproval: z
          .boolean()
          .default(false)
          .describe("Set true for outbound communication steps. Manual mode pauses before these steps."),
        state: z
          .enum(["pending", "in_progress", "completed", "failed"])
          .optional()
          .describe("Optional step state. Set in_progress on the step you are starting."),
      }),
    )
    .min(1)
    .max(20)
    .describe("Linear 1-20 step list. Replace-whole-list: pass the full list every time."),
});

export const todoWriteTool = tool({
  description:
    "Declare or update your workflow plan for a multi-step task. Call this first for any non-trivial request -- anything beyond a step or two. " +
    "Calling it renders your plan as the operator's live workflow card and is your primary way to show your work; in Manual mode, marking a step in_progress arms the approval gate that pauses before outbound steps. " +
    "Replace-whole-list: pass the full step list every time. Set requiresApproval:true on outbound communication steps. " +
    "Set a step state to in_progress when starting it. Call this AGAIN before starting each step -- especially before any requiresApproval/outbound step -- marking that step in_progress; in Manual mode that is what pauses for operator approval.",
  parameters: todoWriteSchema,
  execute: async (input) => {
    const steps = input.steps.map((step) => ({
      id: `step_${randomUUID()}`,
      title: step.title,
      requiresApproval: step.requiresApproval ?? false,
      state: step.state ?? "pending",
    }));
    return { ok: true, workflowTitle: input.workflowTitle, steps };
  },
});
