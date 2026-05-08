import { tool } from "ai";
import { z } from "zod";
import { applyPacing, failFromError, ok, resolveByLabel } from "../../linkedin/index.js";
import type { LinkedinSession } from "../../linkedin/types.js";

const typeParams = z.object({
  text: z.string().describe("Text to type into the resolved input. Replaces existing value."),
  ref: z.string().optional().describe("Input ref from inspect, e.g. '@e3'."),
  label: z.string().optional().describe("Accessible name of the input (case-insensitive)."),
  scope: z.string().optional().describe("Scope handle to narrow the search."),
});

export function makeTypeTool(session: LinkedinSession) {
  return tool({
    description:
      "Type text into a LinkedIn input. Provide either a ref or a label. Existing value is cleared first " +
      "(select-all + insertText replacement).",
    parameters: typeParams,
    execute: async ({ text, ref, label, scope }) => {
      try {
        const client = session.getClient();
        let target: string;
        if (ref) {
          target = ref.startsWith("@") ? ref : `@${ref}`;
        } else if (label) {
          const ctx = session.getLastContext();
          if (!ctx) throw new Error("type: call inspect first to populate inputs.");
          const entry = resolveByLabel(ctx.entries, label, { kind: "type", scope });
          target = entry.ref;
        } else {
          throw new Error("type: provide either 'ref' or 'label'.");
        }
        // Focus the input.
        await client.clickAt(target);
        // Select-all (Ctrl+A — modifiers bitmask 2).
        await client.handle.Input.dispatchKeyEvent({ type: "keyDown", key: "a", modifiers: 2 });
        await client.handle.Input.dispatchKeyEvent({ type: "keyUp", key: "a", modifiers: 2 });
        // Replace with new text via insertText (preserves React onChange).
        await client.handle.Input.insertText({ text });
        const pacing = await applyPacing();
        // type does NOT emit data.hint per cli-primitives.md §type (focus-and-fill is not surface-changing).
        return ok("type", { target, text, pacing });
      } catch (e) {
        return failFromError("type", e);
      }
    },
  });
}
