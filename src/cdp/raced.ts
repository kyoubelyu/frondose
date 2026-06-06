/**
 * [P-75 P-WEDGE-1] Race a CDP call against a per-call deadline + an optional turn
 * abort signal.
 *
 * WHY THIS EXISTS — the unattended-wedge root cause:
 * `chrome-remote-interface` raw CDP method promises (Page.navigate,
 * Accessibility.getFullAXTree, DOM.getBoxModel, Runtime.evaluate, …) do NOT
 * honor any AbortSignal and have NO internal timeout. When a page hangs (heavy
 * SPA, a never-settling navigation, a renderer stall), the awaited CDP promise
 * stays pending FOREVER. That leaves `runAgentLoop`'s await pending, so
 * `runOneTurn`'s `finally { state.currentTurn = null }` never runs, so every
 * later /agent/turn rejects with turn_in_progress, and — crucially — the
 * cron tick no-ops every 60s while currentTurn is non-null. The D-16 auto-cap
 * watcher and the D-27 silent-hang watcher both call `abortController.abort()`,
 * but that abort cannot reach a raw chrome-remote-interface promise, so they
 * "abort into a void." The only release sites pre-WEDGE-1 are the two operator
 * HTTP routes (D-21 routes.ts force-release) — which never fire when the app is
 * hidden in the tray. So unattended, the wedge is PERMANENT until pkill.
 *
 * NOTE — the D-21 roll-up #3 over-claim: roll-up #3 stated D-21 added an
 * "abortSignal-aware CDP wrapper in client.ts". It did not — D-21 (cc723a3) is
 * solely the routes.ts operator-route force-release. THIS module is the actual
 * CDP-level fix that roll-up #3 described but that was never built until now.
 *
 * THE FIX — two independent guards, either one breaks the permanent wedge:
 *  1. deadline (unconditional): every wrapped CDP call rejects with
 *     CdpCallTimeoutError after `deadlineMs`. No signal plumbing required — a
 *     hung call can never pend longer than the deadline, so the turn always
 *     progresses or ends. The deadline is generous (well above a healthy call)
 *     so it never false-positives on a slow-but-live page.
 *  2. signal (turn-scoped): when a turn abort signal is wired (D-16 cap /
 *     D-27 silent-hang / operator abort), an in-flight CDP call is interrupted
 *     IMMEDIATELY on abort with CdpCallAbortedError, instead of waiting out the
 *     deadline.
 *
 * HAZARD MITIGATION (per the workflow's robustness-lens caution): we cannot
 * cancel the underlying CDP promise — it keeps running in chrome-remote-interface.
 * We only stop AWAITING it. So a raced-out navigate/click may still land in
 * Chrome AFTER we threw. Callers MUST therefore treat page state as UNKNOWN
 * after a CdpCallTimeoutError/CdpCallAbortedError and force a fresh `inspect`
 * before any further action, and MUST NEVER write durable "sent" state off a
 * raced-out outbound CDP call. The deadline is set high enough that healthy
 * outbound clicks complete well within it.
 */

export class CdpCallTimeoutError extends Error {
  readonly label: string;
  readonly deadlineMs: number;
  constructor(label: string, deadlineMs: number) {
    super(
      `CDP call '${label}' exceeded ${deadlineMs}ms deadline (treated as a hang — page state is now UNKNOWN, re-inspect before acting)`,
    );
    this.name = "CdpCallTimeoutError";
    this.label = label;
    this.deadlineMs = deadlineMs;
  }
}

export class CdpCallAbortedError extends Error {
  readonly label: string;
  constructor(label: string) {
    super(`CDP call '${label}' aborted by turn signal (page state is now UNKNOWN, re-inspect before acting)`);
    this.name = "CdpCallAbortedError";
    this.label = label;
  }
}

export interface RaceCdpOpts {
  label: string;
  deadlineMs: number;
  signal?: AbortSignal;
}

/**
 * Resolve/reject with `p`'s outcome, UNLESS the deadline fires or the signal
 * aborts first — in which case reject with the corresponding error. Always
 * cleans up its timer + abort listener on settle (no leaks).
 */
export function raceCdp<T>(p: Promise<T>, opts: RaceCdpOpts): Promise<T> {
  const { label, deadlineMs, signal } = opts;
  if (signal?.aborted) {
    return Promise.reject(new CdpCallAbortedError(label));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new CdpCallAbortedError(label));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new CdpCallTimeoutError(label, deadlineMs));
    }, deadlineMs);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      },
    );
  });
}
