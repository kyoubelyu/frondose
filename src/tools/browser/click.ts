import { tool } from "ai";
import { z } from "zod";
import { hardwareClickAt } from "../../cdp/hardwareInput.js";
import { applyPacing, fail, failFromError, ok, resolveByLabel, withHint } from "../../linkedin/index.js";
import type { LinkedinSession } from "../../linkedin/types.js";
import { LINKEDIN_OUTBOUND_SURFACES, requiresApproval } from "./outboundGuard.js";

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
      "Click an element on the current page. Provide either a ref from the most-recent inspect (e.g. '@e14') " +
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
        // P-Y2.3: paint the agent cursor + highlight on the resolved target before acting. Best-effort,
        // visual-only (a getBox/overlay failure must NEVER block the click); the injected driver Auto-gates
        // (no paint + no dwell in Manual/headless/REPL). Same getBox the click resolves → highlight box ==
        // clickAt landing (live cross-check). The click dispatch is OUTSIDE this try (unaffected on failure).
        try {
          const box = await client.getBox(target);
          await session.showAgentTarget?.(box, label ?? target);
        } catch {
          // visual-only; ignore
        }
        // Outbound guard — checked before any CDP dispatch
        const clickContext = session.getLastContext();
        const targetEntry = clickContext?.entries?.find((e) => e.ref === target);
        const clickLabel = (targetEntry?.name ?? "").trim();
        const clickSurface = clickContext?.surface ?? "";
        if (!LINKEDIN_OUTBOUND_SURFACES.has(clickSurface)) {
          // P-33 general-web carve-out: not a LinkedIn outbound surface -> skip guard
        } else if (session.canClickOutbound && requiresApproval(clickLabel, clickSurface)) {
          if (!session.canClickOutbound(clickLabel, clickSurface)) {
            return fail(
              "click",
              "invalid_input",
              `Outbound action blocked: label "${clickLabel}" on surface "${clickSurface}" requires operator approval`,
            );
          }
        }
        // P-SP-E: Auto-mode cap guard. Hard reject before CDP dispatch when running auto-run
        // would exceed its connect cap. Only fires for LinkedIn outbound surfaces (Connect family
        // per OUTBOUND_LABEL_RE) AND when session.autoRun returns a row with maxConnects != null.
        // The P-63 OUTBOUND_LABEL_RE catches Connect/Invite/Send variants; cap-guard checks ONLY
        // the connect_sent count (Send/Message do not count toward connect cap — they have their
        // own implicit cap via the workflow approval pattern in non-Auto modes).
        if (
          LINKEDIN_OUTBOUND_SURFACES.has(clickSurface) &&
          /^(Connect\b|Invite\b.*\bto\s+connect\b)/i.test(clickLabel)
        ) {
          const autoRun = session.autoRun?.();
          if (autoRun && autoRun.maxConnects !== null && autoRun.connectSentCount >= autoRun.maxConnects) {
            return fail(
              "click",
              "invalid_input",
              `Auto cap reached: connect_sent=${autoRun.connectSentCount}/${autoRun.maxConnects}. Call end_auto_run to close the run cleanly.`,
            );
          }
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
