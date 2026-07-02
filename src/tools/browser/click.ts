import { tool } from "ai";
import { z } from "zod";
import type { CdpClient } from "../../cdp/client.js";
import { hardwareClickAt } from "../../cdp/hardwareInput.js";
import { failWithReason } from "../../linkedin/envelope.js";
import { applyPacing, captureCurrentSurfaceContext, fail, failFromError, ok, withHint } from "../../linkedin/index.js";
import { resolveByLabelWithRetry } from "../../linkedin/labelResolver.js";
import type { OutwardActionAdvice } from "../../linkedin/logic/outwardAction.js";
import type { LinkedinSession, SnapshotEntry } from "../../linkedin/types.js";
import { appendAutoLedger, updateAutoRunStatus } from "../../persistence/sales/auto-run.js";
import { getSalesDb } from "../sales/_dbHandle.js";
import { classifyOutboundEntry, LINKEDIN_OUTBOUND_SURFACES, requiresApproval } from "./outboundGuard.js";
import { buildScopedClickAdvice, resolveScopedForTool, scopedResolveEnabled } from "./scopedResolve.js";

const REF_STALE_RETRY_TIMEOUT_MS = 3000;
const REF_STALE_MAX_RETRIES = 2;
const REF_STALE_RETRY_STEP_MS = 300;

function makeAbortError(): Error {
  const err = new Error("click aborted");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) throw makeAbortError();
}

async function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  throwIfAborted(abortSignal);
  if (!abortSignal) {
    await new Promise((r) => setTimeout(r, ms));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

function sameRoleName(entry: SnapshotEntry, expected: { role: string; name?: string }): boolean {
  if (entry.role !== expected.role) return false;
  const expectedName = (expected.name ?? "").trim().toLowerCase();
  const actualName = (entry.name ?? "").trim().toLowerCase();
  return expectedName.length > 0 ? actualName === expectedName : true;
}

function findFreshRefByRoleName(
  entries: SnapshotEntry[],
  expected: { role: string; name?: string },
): SnapshotEntry | undefined {
  const matches = entries.filter((entry) => sameRoleName(entry, expected));
  return matches.length === 1 ? matches[0] : undefined;
}

async function recaptureFreshRefByRoleName(
  session: LinkedinSession,
  client: CdpClient,
  expected: { role: string; name?: string },
  opts: { timeoutMs?: number; stepMs?: number; maxRetries?: number; abortSignal?: AbortSignal } = {},
): Promise<SnapshotEntry | undefined> {
  const deadline = Date.now() + (opts.timeoutMs ?? REF_STALE_RETRY_TIMEOUT_MS);
  const stepMs = opts.stepMs ?? REF_STALE_RETRY_STEP_MS;
  const maxRetries = opts.maxRetries ?? REF_STALE_MAX_RETRIES;
  for (let attempt = 0; attempt < maxRetries && Date.now() < deadline; attempt++) {
    await sleepWithAbort(stepMs, opts.abortSignal);
    throwIfAborted(opts.abortSignal);
    try {
      const fresh = await captureCurrentSurfaceContext(client);
      session.setLastContext(fresh);
      const entry = findFreshRefByRoleName(fresh.entries, expected);
      if (entry) return entry;
    } catch (e) {
      if (opts.abortSignal?.aborted) throw e;
      // Transient recapture failure — keep trying within the bounded retry window.
    }
  }
  return undefined;
}

function refStaleFailure(
  target: string,
  targetEntry: SnapshotEntry,
  verify: { currentRole?: string; currentName?: string },
) {
  return fail(
    "click",
    "runtime_error",
    `ref_stale: ${target} no longer points at "${targetEntry.name}" (role=${targetEntry.role}). ` +
      `Current state: role=${verify.currentRole ?? "<gone>"} name=${verify.currentName ?? "<gone>"}. ` +
      `The DOM changed between your inspect and this click (e.g. a modal swapped its input role). ` +
      `Call inspect again to refresh refs, then retry the click against the fresh ref.`,
  );
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
    execute: async ({ ref, label, scope }, executeOpts) => {
      try {
        const abortSignal = executeOpts?.abortSignal;
        throwIfAborted(abortSignal);
        const r = await session.getOrInitClient();
        if (!r.ok) return r;
        const { client } = r;
        let target: string;
        let targetEntry: SnapshotEntry | undefined;
        // Slice-4 (FRONDOSE_SCOPED_RESOLVE=on): advice added to the success envelope + whether the
        // resolved target was selector-only (ref absent) so the outbound guard can fail closed.
        let scopedAdvice: OutwardActionAdvice[] = [];
        let scopedSelectorOnly = false;
        if (ref) {
          target = ref.startsWith("@") ? ref : `@${ref}`;
        } else if (scopedResolveEnabled()) {
          // Slice-4 flag-on: resolve (label, scope) through the logic-layer scope resolver.
          // biome-ignore lint/style/noNonNullAssertion: refine guarantees ref OR label; ref is undefined here.
          const scoped = await resolveScopedForTool(client, "button", label!, scope);
          target = scoped.target;
          targetEntry = scoped.targetEntry;
          scopedSelectorOnly = scoped.selectorOnly;
          // Refresh runtime lastContext so the outbound guard + ref-stale re-validation classify on
          // the SAME surface + entries the resolver used (runtime inferSurface, resolver's entries).
          session.setLastContext(scoped.runtimeContext);
          scopedAdvice = buildScopedClickAdvice(scoped.logicContext, scoped.resolvedTarget);
        } else {
          // biome-ignore lint/style/noNonNullAssertion: refine guarantees ref OR label is set; ref is undefined here so label is non-null.
          const resolveLabel = label!;
          const entry = await resolveByLabelWithRetry(
            session,
            resolveLabel,
            scope,
            async () => {
              const next = await captureCurrentSurfaceContext(client);
              session.setLastContext(next);
              return next;
            },
            { abortSignal },
          );
          target = entry.ref;
          targetEntry = entry;
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
        targetEntry ??= clickContext?.entries?.find((e) => e.ref === target);
        let clickSurface = clickContext?.surface ?? "";
        if (ref && target.startsWith("@") && !targetEntry) {
          try {
            const fresh = await captureCurrentSurfaceContext(client);
            session.setLastContext(fresh);
            targetEntry = fresh.entries.find((e) => e.ref === target);
            clickSurface = fresh.surface;
          } catch {
            // Fail closed below on LinkedIn outbound surfaces; preserve general-web dispatch.
          }
        }
        if (ref && target.startsWith("@") && !targetEntry && LINKEDIN_OUTBOUND_SURFACES.has(clickSurface)) {
          return failWithReason(
            "click",
            "invalid_input",
            `Unresolvable ref on outbound surface: ${target} is not in the current snapshot and a fresh recapture also could not find it (surface=${clickSurface}). ` +
              "Refusing to dispatch an unclassifiable click on a LinkedIn outbound surface. " +
              "Call inspect again to refresh refs, then retry with a fresh ref or with a label.",
            "unresolvable_ref_on_outbound_surface",
          );
        }
        // Slice-4 flag-on: a selector-only scoped target (ref absent) that we cannot classify
        // (no accessible name to gate on) MUST NOT bypass the outbound guard — fail closed on a
        // LinkedIn outbound surface, mirroring the ref-path unresolvable branch above. (The common
        // case synthesizes a named targetEntry from the resolver's matched label, so classification
        // still runs; this only catches a truly unnameable selector-only outbound target.)
        if (
          scopedSelectorOnly &&
          !(targetEntry && targetEntry.name.trim().length > 0) &&
          LINKEDIN_OUTBOUND_SURFACES.has(clickSurface)
        ) {
          return failWithReason(
            "click",
            "invalid_input",
            `Unclassifiable selector-only target on outbound surface (surface=${clickSurface}). ` +
              "Refusing to dispatch an unguardable click on a LinkedIn outbound surface. " +
              "Call inspect again to refresh refs, then retry with a fresh ref or label.",
            "unresolvable_ref_on_outbound_surface",
          );
        }
        const clickLabel = (targetEntry?.name ?? "").trim();
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
        const outboundClass = classifyOutboundEntry(targetEntry, clickSurface);
        if (outboundClass === "message_send" && session.resolvedMode?.() === "auto") {
          return failWithReason(
            "click",
            "invalid_input",
            "Auto message-send is not authorized. Switch to Manual mode and use operator approval before sending.",
            "approval_required",
          );
        }
        if (outboundClass === "post" && session.resolvedMode?.() === "auto") {
          return failWithReason(
            "click",
            "invalid_input",
            "Auto post is not authorized. Switch to Manual mode and use operator approval before publishing.",
            "approval_required",
          );
        }
        // P-AUTO-1+2 (B-3): in-memory fail-closed latch. Once a prior connect dispatched but its
        // ledger write failed, ALL further outbound this session is blocked — independent of DB state.
        if (
          (outboundClass === "connect_send" || outboundClass === "message_send") &&
          session.outboundDisabled === true
        ) {
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
          if (mode === "auto") {
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
          const currentRef = client.currentRefMap?.[target.slice(1)];
          const expected = {
            role: targetEntry.role,
            name: targetEntry.name || currentRef?.name,
          };
          let latestVerify: { matches: boolean; currentRole?: string; currentName?: string } | null = null;
          for (let attempt = 0; attempt <= REF_STALE_MAX_RETRIES; attempt++) {
            throwIfAborted(abortSignal);
            latestVerify = await client.verifyRef(target.slice(1), expected);
            if (latestVerify.matches) break;
            if (attempt >= REF_STALE_MAX_RETRIES) {
              return refStaleFailure(target, targetEntry, latestVerify);
            }
            const freshEntry = await recaptureFreshRefByRoleName(session, client, expected, { abortSignal });
            if (!freshEntry) {
              return refStaleFailure(target, targetEntry, latestVerify);
            }
            target = freshEntry.ref;
            targetEntry = freshEntry;
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
          const runRow = session.autoRun?.() ?? null;
          const runId = session.resolvedMode?.() === "auto" ? (runRow?.runId ?? null) : null;
          try {
            const db = getSalesDb(session.salesDbPath);
            appendAutoLedger(db, {
              runId,
              actionType: "connect_sent",
              result: "success",
            });
          } catch (ledgerErr) {
            // GUARANTEED fail-closed (B-3): the in-memory latch cannot fail and blocks ALL further
            // outbound this session even if the durable DB block below can't be written. Then
            // best-effort persist 'blocked' so a fresh process also sees the run as stopped.
            session.outboundDisabled = true;
            if (runId !== null) {
              try {
                updateAutoRunStatus(getSalesDb(session.salesDbPath), runId, "blocked");
              } catch {
                // Durable block unavailable (DB unreachable); the in-memory latch already fail-closes this session.
              }
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
        if (outboundClass === "message_send" && session.salesDbPath !== undefined) {
          try {
            const db = getSalesDb(session.salesDbPath);
            appendAutoLedger(db, {
              runId: null,
              actionType: "message_sent",
              result: "success",
            });
          } catch (ledgerErr) {
            session.outboundDisabled = true;
            return failWithReason(
              "click",
              "runtime_error",
              `Message dispatched but the ledger write failed (${ledgerErr instanceof Error ? ledgerErr.message : "db error"}). ` +
                "Outbound is now DISABLED for this session to prevent uncounted sends — do NOT retry this send (it already left the page). " +
                "Reconcile the ledger and start a fresh run.",
              "ledger_write_failed",
            );
          }
        }
        // State-changing → emit data.hint per cli-primitives.md §click.
        // Slice-4 flag-on: attach the outward-action advice block when the resolved target is
        // outbound-classified (additive — envelope + schema unchanged when empty / flag-off).
        const clickData: Record<string, unknown> = { target, pacing };
        if (scopedAdvice.length > 0) clickData.advice = scopedAdvice;
        return withHint(ok("click", clickData));
      } catch (e) {
        return failFromError("click", e);
      }
    },
  });
}
