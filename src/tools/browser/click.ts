import { tool } from "ai";
import { z } from "zod";
import { hardwareClickAt } from "../../cdp/hardwareInput.js";
import {
  applyPacing,
  captureCurrentSurfaceContext,
  fail,
  failFromError,
  ok,
  resolveByLabel,
  withHint,
} from "../../linkedin/index.js";
import type { LinkedinSession, SnapshotEntry } from "../../linkedin/types.js";
import { LINKEDIN_OUTBOUND_SURFACES, requiresApproval } from "./outboundGuard.js";

/** [P-75 D-11 round 3] When click is called by `label` (not `ref`), the current ctx may be stale
 *  by 500–1500ms vs the live DOM — Chrome's AX tree lags after DOM mutations, especially
 *  disabled→enabled state changes LinkedIn does in React after type/click. The mai-linkedin
 *  original worked because each command re-resolved the target against a fresh AX snapshot;
 *  this port restores that property so the agent can do plain inspect → type → click(Send)
 *  without a dedicated `linkedin_connect` primitive (which was brittle to UI variance). Retries
 *  recapture the surface up to ~3s before surrendering. No-op for ref-based clicks. */
async function resolveByLabelWithRetry(
  session: LinkedinSession,
  label: string,
  scope: string | undefined,
  capture: () => Promise<{ entries: SnapshotEntry[] }>,
): Promise<SnapshotEntry> {
  const ctx0 = session.getLastContext();
  if (ctx0) {
    try {
      return resolveByLabel(ctx0.entries, label, { kind: "click", scope });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/no\s+click\s+target\s+matches/i.test(msg)) throw e;
    }
  }
  const deadline = Date.now() + 3000;
  let lastErr: unknown = new Error(`click: no label '${label}' visible`);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const fresh = await capture();
    try {
      return resolveByLabel(fresh.entries, label, { kind: "click", scope });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/no\s+click\s+target\s+matches/i.test(msg)) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

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
          // biome-ignore lint/style/noNonNullAssertion: refine guarantees ref OR label is set; ref is undefined here so label is non-null.
          const entry = await resolveByLabelWithRetry(session, label!, scope, async () => {
            const next = await captureCurrentSurfaceContext(client);
            session.setLastContext(next);
            return next;
          });
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
        // [P-75 D-17] Re-validate the ref before dispatching the click. LinkedIn re-uses
        // the same DOM input across modal states (Connect overlay, New Message dialog,
        // comment composer) — backendNodeId is unchanged but the aria-label flips. Without
        // this check, a click on a stale ref silently hits the wrong-purpose element.
        // Skip when the agent passed a label (resolveByLabel already used CURRENT entries)
        // OR when the entry wasn't in lastContext (selector fallback OR ad-hoc ref).
        if (target.startsWith("@") && targetEntry) {
          const verify = await client.verifyRef(target.slice(1), {
            role: targetEntry.role,
            name: targetEntry.name,
          });
          if (!verify.matches) {
            return fail(
              "click",
              "runtime_error",
              `ref_stale: ${target} no longer points at "${targetEntry.name}" (role=${targetEntry.role}). ` +
                `Current state: role=${verify.currentRole ?? "<gone>"} name=${verify.currentName ?? "<gone>"}. ` +
                `The DOM changed between your inspect and this click (e.g. a modal swapped its input role). ` +
                `Call inspect again to refresh refs, then retry the click against the fresh ref.`,
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
