import { tool } from "ai";
import { z } from "zod";
import { hardwareClickAt } from "../../cdp/hardwareInput.js";
import { applyPacing, failFromError, ok, resolveByLabel, withHint } from "../../linkedin/index.js";
import type { LinkedinSession } from "../../linkedin/types.js";

const clickParams = z
  .object({
    ref: z.string().optional().describe("Element ref from inspect, e.g. '@e14'."),
    label: z.string().optional().describe("Accessible name of the element to click (case-insensitive)."),
    scope: z.string().optional().describe("Scope handle to narrow the search."),
  })
  .refine((v) => Boolean(v.ref) || Boolean(v.label), {
    message: "click requires either 'ref' or 'label'",
  });

export function makeClickTool(session: LinkedinSession) {
  return tool({
    description:
      "Click an element on the current LinkedIn page. Provide either a ref from the most-recent inspect (e.g. '@e14') " +
      "or a label (accessible name). If both are provided, ref wins.",
    parameters: clickParams,
    execute: async ({ ref, label, scope }) => {
      try {
        const r = await session.getOrInitClient();
        if (!r.ok) return r;
        const { client } = r;
        let target: string;
        if (ref) {
          target = ref.startsWith("@") ? ref : `@${ref}`;
        } else {
          const ctx = session.getLastContext();
          if (!ctx) {
            throw new Error("click: call inspect first to populate refs and entries.");
          }
          // biome-ignore lint/style/noNonNullAssertion: refine guarantees ref OR label is set; ref is undefined here so label is non-null.
          const entry = resolveByLabel(ctx.entries, label!, { kind: "click", scope });
          target = entry.ref;
        }
        // P-32: hardware-path input branch; CDP arm unchanged.
        if (session.inputMode === "hardware") await hardwareClickAt(client, target);
        else await client.clickAt(target);
        const pacing = await applyPacing();
        // State-changing → emit data.hint per cli-primitives.md §click.
        return withHint(ok("click", { target, pacing }));
      } catch (e) {
        return failFromError("click", e);
      }
    },
  });
}
