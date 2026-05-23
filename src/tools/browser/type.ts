import { tool } from "ai";
import { z } from "zod";
import { hardwareTypeAt } from "../../cdp/hardwareInput.js";
import { applyPacing, fail, failFromError, ok, resolveByLabel } from "../../linkedin/index.js";
import type { LinkedinSession } from "../../linkedin/types.js";

/** Resolve after `ms` milliseconds. */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * P-47 G-2 / OQ-1: per-character typing delay in ms. Produces human keystroke
 * timing while bounding total typing time at ~8s for any text length.
 *  - `budget` = min(8000 / textLength, 150): the per-char time slice. For text
 *    longer than ~54 chars this shrinks so `textLength × budget ≤ ~8000`.
 *  - jitter: `rand` in [0,1] maps to a 0.3..1.0 multiplier — variable timing is
 *    the anti-bot keystroke-fingerprint signal. Jitter only VARIES the delay for
 *    short/medium text; once `textLength > ~266` the floor equals the budget so
 *    the per-char delay is budget-pinned (constant) and the ~8s cap dominates.
 *  - floor = min(30, budget): a 30ms floor for short/medium text, but never
 *    above `budget`, so the ~8s cap is preserved for long text (see plan §0.3).
 */
export function computeCharDelay(textLength: number, rand: number): number {
  const budget = Math.min(8000 / Math.max(1, textLength), 150);
  const floor = Math.min(30, budget);
  return Math.max(floor, Math.floor(budget * (0.3 + rand * 0.7)));
}

const typeParams = z.object({
  text: z.string().describe("Text to type into the resolved input. Replaces existing value."),
  ref: z.string().optional().describe("Input ref from inspect, e.g. '@e3'."),
  label: z.string().optional().describe("Accessible name of the input (case-insensitive)."),
  scope: z.string().optional().describe("Scope handle to narrow the search."),
});

export function makeTypeTool(session: LinkedinSession) {
  return tool({
    description:
      "Type text into a page input. Provide either a ref or a label. Existing value is cleared first " +
      "(select-all + insertText replacement).",
    parameters: typeParams,
    execute: async ({ text, ref, label, scope }) => {
      try {
        const r = await session.getOrInitClient();
        if (!r.ok) return r;
        const { client } = r;
        let target = "";
        if (ref) {
          target = ref.startsWith("@") ? ref : `@${ref}`;
        } else {
          const ctx = session.getLastContext();
          if (!ctx) throw new Error("type: call inspect first to populate inputs.");

          // Ambiguity enforcement: when scope provided without label, check for multiple inputs.
          if (scope && !label) {
            const INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "textarea"]);
            const scopeInputs = ctx.entries.filter((e) => INPUT_ROLES.has(e.role) && e.name.length > 0);
            if (scopeInputs.length > 1) {
              const candidates = scopeInputs.map((e) => ({ ref: e.ref, label: e.name }));
              return fail(
                "type",
                "ambiguous_target",
                `scope '${scope}' exposes ${scopeInputs.length} inputs. Provide --label to target one.`,
                candidates,
              );
            }
            if (scopeInputs.length === 1) {
              // biome-ignore lint/style/noNonNullAssertion: length-checked above.
              target = scopeInputs[0]!.ref;
            }
          }

          if (!target) {
            if (label) {
              const entry = resolveByLabel(ctx.entries, label, { kind: "type", scope });
              target = entry.ref;
            } else {
              throw new Error("type: provide either 'ref' or 'label'.");
            }
          }
        }
        // P-Y2.3: paint the agent cursor + highlight on the resolved target before the focus click. Best-effort,
        // visual-only (a getBox/overlay failure must NEVER block typing); the injected driver Auto-gates (no paint
        // + no dwell in Manual/headless/REPL). The type dispatch is OUTSIDE this try (unaffected on failure).
        try {
          const box = await client.getBox(target);
          await session.showAgentTarget?.(box, label ?? target);
        } catch {
          // visual-only; ignore
        }
        // P-32: hardware-path input branch; CDP arm unchanged.
        if (session.inputMode === "hardware") {
          await hardwareTypeAt(client, target, text);
        } else {
          // Focus the input.
          await client.clickAt(target);
          // Select-all (Ctrl+A — modifiers bitmask 2).
          await client.handle.Input.dispatchKeyEvent({ type: "keyDown", key: "a", modifiers: 2 });
          await client.handle.Input.dispatchKeyEvent({ type: "keyUp", key: "a", modifiers: 2 });
          // P-47 G-2: per-character dispatch — replaces the atomic insertText.
          // Each printable char is its own insertText call (fires a discrete
          // `input` event React/LinkedIn listens to); `\n` is a real Enter key
          // event. Jittered inter-char delays give a human keystroke-timing
          // fingerprint; computeCharDelay caps the total at ~8s for long text.
          if (text.length === 0) {
            // Empty text → explicit clear: replace the Ctrl+A selection with
            // nothing. Ctrl+A only SELECTS — without this insertText the field
            // keeps its (still-selected) content. Preserves the documented
            // "`type` clears existing content by default" primitive contract
            // (references/cli-primitives.md). [P-47 B-1]
            await client.handle.Input.insertText({ text: "" });
          } else {
            for (const ch of text) {
              if (ch === "\n") {
                await client.handle.Input.dispatchKeyEvent({
                  type: "keyDown",
                  key: "Enter",
                  code: "Enter",
                  windowsVirtualKeyCode: 13,
                });
                await client.handle.Input.dispatchKeyEvent({
                  type: "keyUp",
                  key: "Enter",
                  code: "Enter",
                  windowsVirtualKeyCode: 13,
                });
              } else {
                await client.handle.Input.insertText({ text: ch });
              }
              await sleep(computeCharDelay(text.length, Math.random()));
            }
          }
        }
        const pacing = await applyPacing();
        // type does NOT emit data.hint per cli-primitives.md §type (focus-and-fill is not surface-changing).
        return ok("type", { target, text, pacing });
      } catch (e) {
        return failFromError("type", e);
      }
    },
  });
}
