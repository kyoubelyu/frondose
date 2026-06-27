import { CLICKABLE_ROLES, INPUT_ROLES } from "./inspectSummary.js";
import type { CurrentSurfaceContext, SnapshotEntry } from "./types.js";

export interface LabelResolveOpts {
  kind: "click" | "type";
  scope?: string;
  activeLayer?: "page" | "overlay";
}

// P-AUTO-16 OUT-6: inspectSummary.ts:199 decorates outbound action labels with a
// "[OUTBOUND] " display prefix (e.g. "[OUTBOUND] Connect"). The raw SnapshotEntry.name
// stays unprefixed, so an operator/agent who copies the displayed label trips
// resolveByLabel's includes() match. Strip a single leading "[OUTBOUND] " before the
// match so display-prefixed labels resolve identically to the raw name. The error
// messages still cite the ORIGINAL `label` (pre-strip) for operator clarity.
const OUTBOUND_DISPLAY_PREFIX_RE = /^\[OUTBOUND\]\s+/;

/** Resolve a label-based target. Throws on no match or ambiguity. */
export function resolveByLabel(entries: SnapshotEntry[], label: string, opts: LabelResolveOpts): SnapshotEntry {
  const roles = opts.kind === "click" ? CLICKABLE_ROLES : INPUT_ROLES;
  // P-AUTO-16 OUT-6: strip a single leading "[OUTBOUND] " display prefix; fall back to
  // the ORIGINAL label if the strip leaves nothing (label was literally "[OUTBOUND] "),
  // otherwise JS's "".includes(needle) semantics — every string includes "" — would
  // degrade to wrong-target / ambiguity. With the fallback, the original "[OUTBOUND] "
  // gets a clean zero-match throw against unprefixed AX names.
  const stripped = label.replace(OUTBOUND_DISPLAY_PREFIX_RE, "");
  const usable = stripped.trim().length > 0 ? stripped : label;
  const needle = usable.toLowerCase();
  const roleFiltered = entries.filter((e) => roles.has(e.role));
  const exact = roleFiltered.filter((e) => e.name.toLowerCase() === needle);
  const substr = roleFiltered.filter((e) => e.name.toLowerCase().includes(needle));
  let matches = exact.length > 0 ? exact : substr;

  if (matches.length > 1) {
    const nonAside = matches.filter((e) => e.region !== "aside");
    if (nonAside.length > 0) matches = nonAside;
  }

  if (opts.activeLayer === "overlay") {
    const overlayOnly = matches.filter((e) => e.ref.startsWith("@ov"));
    if (overlayOnly.length > 0) matches = overlayOnly;
  }

  if (matches.length === 0) {
    throw new Error(
      `resolveByLabel: no ${opts.kind} target matches '${label}'. ` +
        `Did you call inspect first? Run inspect to see available buttons/inputs.`,
    );
  }
  if (matches.length > 1) {
    const preview = matches
      .slice(0, 5)
      .map((m) => `${m.ref}="${m.name}"`)
      .join(", ");
    throw new Error(
      `resolveByLabel: ambiguous ${opts.kind} target '${label}' (${matches.length} matches). ` +
        `Candidates: ${preview}. Use a more specific label or use ref directly.`,
    );
  }
  // matches.length === 1; non-null per length check above, but appease tsc:
  const only = matches[0];
  if (!only) throw new Error("unreachable: matches.length === 1");
  return only;
}

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

/** [P-75 D-11 round 3] When click is called by `label` (not `ref`), the current ctx may be stale
 *  by 500–1500ms vs the live DOM — Chrome's AX tree lags after DOM mutations, especially
 *  disabled→enabled state changes LinkedIn does in React after type/click. The mai-linkedin
 *  original worked because each command re-resolved the target against a fresh AX snapshot;
 *  this port restores that property so the agent can do plain inspect → type → click(Send)
 *  without a dedicated `linkedin_connect` primitive (which was brittle to UI variance). Retries
 *  recapture the surface up to ~3s before surrendering. No-op for ref-based clicks. */
export async function resolveByLabelWithRetry(
  session: { getLastContext: () => CurrentSurfaceContext | undefined },
  label: string,
  scope: string | undefined,
  capture: () => Promise<{ entries: SnapshotEntry[]; activeLayer?: "page" | "overlay" }>,
  opts: { timeoutMs?: number; stepMs?: number; abortSignal?: AbortSignal } = {},
): Promise<SnapshotEntry> {
  throwIfAborted(opts.abortSignal);
  const ctx0 = session.getLastContext();
  if (ctx0) {
    try {
      return resolveByLabel(ctx0.entries, label, { kind: "click", scope, activeLayer: ctx0.activeLayer });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/no\s+click\s+target\s+matches/i.test(msg)) throw e;
    }
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 3000);
  const stepMs = opts.stepMs ?? 300;
  let lastErr: unknown = new Error(`click: no label '${label}' visible`);
  while (Date.now() < deadline) {
    await sleepWithAbort(stepMs, opts.abortSignal);
    throwIfAborted(opts.abortSignal);
    let fresh: { entries: SnapshotEntry[]; activeLayer?: "page" | "overlay" };
    try {
      fresh = await capture();
    } catch (e) {
      // Transient CDP/AX failure mid-retry — keep trying. The deadline acts as the backstop.
      lastErr = e;
      continue;
    }
    try {
      return resolveByLabel(fresh.entries, label, { kind: "click", scope, activeLayer: fresh.activeLayer });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/no\s+click\s+target\s+matches/i.test(msg)) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}
