import { tool } from "ai";
import { z } from "zod";
import { hardwareClickAt } from "../../cdp/hardwareInput.js";
import { failWithReason } from "../../linkedin/envelope.js";
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
import { appendAutoLedger, updateAutoRunStatus } from "../../persistence/sales/auto-run.js";
import { getSalesDb } from "../sales/_dbHandle.js";
import { classifyOutboundLabel, LINKEDIN_OUTBOUND_SURFACES, requiresApproval } from "./outboundGuard.js";

/** [P-75 D-11 round 3] When click is called by `label` (not `ref`), the current ctx may be stale
 *  by 500–1500ms vs the live DOM — Chrome's AX tree lags after DOM mutations, especially
 *  disabled→enabled state changes LinkedIn does in React after type/click. The mai-linkedin
 *  original worked because each command re-resolved the target against a fresh AX snapshot;
 *  this port restores that property so the agent can do plain inspect → type → click(Send)
 *  without a dedicated `linkedin_connect` primitive (which was brittle to UI variance). Retries
 *  recapture the surface up to ~3s before surrendering. No-op for ref-based clicks. */
export async function resolveByLabelWithRetry(
  session: { getLastContext: () => { entries: SnapshotEntry[] } | undefined },
  label: string,
  scope: string | undefined,
  capture: () => Promise<{ entries: SnapshotEntry[] }>,
  opts: { timeoutMs?: number; stepMs?: number } = {},
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
  const deadline = Date.now() + (opts.timeoutMs ?? 3000);
  const stepMs = opts.stepMs ?? 300;
  let lastErr: unknown = new Error(`click: no label '${label}' visible`);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
    let fresh: { entries: SnapshotEntry[] };
    try {
      fresh = await capture();
    } catch (e) {
      // Transient CDP/AX failure mid-retry — keep trying. The deadline acts as the backstop.
      lastErr = e;
      continue;
    }
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
            // P-AUTO-13 (M6): typed discriminator so the agent + ledger can tell
            // a policy block from a transient page error.
            return failWithReason(
              "click",
              "invalid_input",
              `Outbound action blocked: label "${clickLabel}" on surface "${clickSurface}" requires operator approval`,
              "approval_required",
            );
          }
        }
        // P-AUTO-1+2 (CONCERN-1/3 + B-2): shared classifier replaces the legacy per-check regex.
        // The hard daily/cooldown gate + the deterministic connect_sent ledger write fire on
        // `connect_send` ONLY (the final invite-send button) — counting the `connect_open` modal-
        // open click would overcount. The existing per-run cap stays attached to BOTH connect_open
        // and connect_send so the agent's first `Connect` click is still blocked when sent>=max.
        const outboundClass = LINKEDIN_OUTBOUND_SURFACES.has(clickSurface)
          ? classifyOutboundLabel(clickLabel)
          : "benign";
        // P-AUTO-1+2 (B-3): in-memory fail-closed latch. Once a prior connect dispatched but its
        // ledger write failed, ALL further outbound this session is blocked — independent of DB state.
        if (outboundClass === "connect_send" && session.outboundDisabled === true) {
          return failWithReason(
            "click",
            "invalid_input",
            "Outbound disabled for this session: a prior connect dispatched but its ledger write failed (fail-closed). Reconcile the auto-run ledger and start a fresh run before sending more.",
            "outbound_disabled",
          );
        }
        // Legacy per-run cap guard (P-SP-E G-PSPE.17) — connect_open OR connect_send:
        // pre-CDP hard reject when the running auto-run would exceed its connect cap.
        if (outboundClass === "connect_open" || outboundClass === "connect_send") {
          const autoRun = session.autoRun?.();
          if (autoRun && autoRun.maxConnects !== null && autoRun.connectSentCount >= autoRun.maxConnects) {
            // P-AUTO-1+2: distinct envelope reason so the agent + ledger + summary reflect reality.
            return failWithReason(
              "click",
              "invalid_input",
              `Auto cap reached: connect_sent=${autoRun.connectSentCount}/${autoRun.maxConnects}. Call end_auto_run to close the run cleanly.`,
              "auto_cap_reached",
            );
          }
        }
        // P-AUTO-1+2 (B-1/B-2 fix): hard daily-outbound + cooldown gates, fail-closed. Fire on the
        // FINAL connect_send label ONLY (counting connect_open would overcount). canClickOutbound
        // already enforced the mode-aware run requirement upstream; this is the in-tool backstop.
        if (outboundClass === "connect_send" && session.dailyOutbound !== undefined) {
          const mode = session.resolvedMode?.() ?? null;
          const autoRun = session.autoRun?.() ?? null;
          const daily = session.dailyOutbound();
          // Auto: a running auto-run row is MANDATORY — fail-closed (B-1 defense-in-depth).
          if (mode === "auto" && autoRun === null) {
            return failWithReason(
              "click",
              "invalid_input",
              "Auto outbound rejected: no running auto-run (fail-closed). Call start_auto_run first.",
              "no_active_run",
            );
          }
          // Daily snapshot is MANDATORY whenever the guardrail is wired — fail-closed (a null
          // snapshot must NEVER silently skip the cap; matches the session.dailyOutbound contract).
          if (daily === null) {
            return failWithReason(
              "click",
              "invalid_input",
              "Outbound rejected: daily-outbound snapshot unavailable (fail-closed).",
              "no_daily_snapshot",
            );
          }
          if (daily.remaining <= 0) {
            return failWithReason(
              "click",
              "invalid_input",
              `Daily outbound quota reached: remaining=${daily.remaining}. Wait for the next UTC day before sending more.`,
              "daily_quota_reached",
            );
          }
          if (daily.cooldownRemainingMs > 0) {
            return failWithReason(
              "click",
              "invalid_input",
              `Inter-outbound cooldown active: ${Math.ceil(daily.cooldownRemainingMs / 1000)}s remaining. Do read-only work until it elapses.`,
              "cooldown_active",
            );
          }
        }
        // P-AUTO-6: connect-surface integrity. The search/network sidebar "Invite <Name> to connect"
        // sends with NO modal → a personalized connect_note for that person would be silently discarded.
        if (LINKEDIN_OUTBOUND_SURFACES.has(clickSurface) && session.connectNoteRequiredForLabel) {
          const verdict = session.connectNoteRequiredForLabel(clickLabel, clickSurface);
          if (verdict.block) {
            return failWithReason(
              "click",
              "invalid_input",
              `Note-less instant invite blocked: ${verdict.reason}`,
              "connect_note_required",
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
        // P-AUTO-1+2 (B-3 fix): deterministic connect_sent/success ledger write, fail-closed.
        // The click layer is the AUTHORITY for connect-type counting (soul.ts tells the agent NOT
        // to also call record_auto_action for connect-type → no double-count). Fires on connect_send
        // (final invite-send) ONLY, after a successful CDP dispatch.
        if (outboundClass === "connect_send" && session.salesDbPath !== undefined) {
          const runRow = session.autoRun?.();
          if (runRow !== null && runRow !== undefined) {
            try {
              const db = getSalesDb(session.salesDbPath);
              appendAutoLedger(db, {
                runId: runRow.runId,
                actionType: "connect_sent",
                result: "success",
              });
            } catch (ledgerErr) {
              // GUARANTEED fail-closed (B-3): the in-memory latch cannot fail and blocks ALL further
              // outbound this session even if the durable DB block below can't be written. Then
              // best-effort persist 'blocked' so a fresh process also sees the run as stopped.
              session.outboundDisabled = true;
              try {
                updateAutoRunStatus(getSalesDb(session.salesDbPath), runRow.runId, "blocked");
              } catch {
                // Durable block unavailable (DB unreachable); the in-memory latch already fail-closes this session.
              }
              return failWithReason(
                "click",
                "runtime_error",
                `Connect dispatched but the ledger write failed (${ledgerErr instanceof Error ? ledgerErr.message : "db error"}). ` +
                  "Outbound is now DISABLED for this session to prevent uncounted sends — do NOT retry this connect (it already sent). " +
                  "Reconcile the ledger and start a fresh run.",
                "ledger_write_failed",
              );
            }
          }
        }
        // State-changing → emit data.hint per cli-primitives.md §click.
        return withHint(ok("click", { target, pacing }));
      } catch (e) {
        return failFromError("click", e);
      }
    },
  });
}
