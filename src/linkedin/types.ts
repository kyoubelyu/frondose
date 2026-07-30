import { z } from "zod";
import type { CdpClient } from "../cdp/client.js";
import type { RefMap } from "../cdp/types.js";

/** P-3 supported LinkedIn surfaces (URL-routable). */
export type LinkedInSurface =
  | "feed"
  | "messaging"
  | "messaging-thread"
  | "notifications"
  | "search"
  | "network"
  | "profile"
  | "company"
  | "unknown";

/** A single snapshot entry (refKey'd accessibility node, possibly augmented). */
export interface SnapshotEntry {
  /** Ref string with `@` prefix, e.g. "@e1" or "@mr1". */
  ref: string;
  /** ARIA role string (or synthetic role like "messagingConversationOpener"). */
  role: string;
  /** Accessible name; "" if absent. */
  name: string;
  /** DOM-region tag from capture-time. Undefined means not-aside or unknown. */
  region?: "aside";
}

/** Compact AX tree + surface routing context for LinkedIn pages. */
export interface CurrentSurfaceContext {
  pageUrl: string;
  surface: LinkedInSurface;
  /** P-59 INSPECT-1: "overlay" when an open dropdown/dialog layer is synthesized. */
  activeLayer: "page" | "overlay";
  entries: SnapshotEntry[];
}

/**
 * Zod schema + inferred type for the `inspect` tool's return shape.
 * P-59 INSPECT-1 widens `activeLayer` additively to signal synthesized overlay entries.
 */
export const inspectSummarySchema = z.object({
  surface: z.string(),
  activeLayer: z.enum(["page", "overlay"]),
  availableScopes: z.array(z.string()),
  text: z.array(z.string()),
  buttons: z.array(z.object({ ref: z.string(), label: z.string() })),
  inputs: z.array(z.object({ ref: z.string(), label: z.string(), value: z.string().optional() })),
});
export type InspectSummary = z.infer<typeof inspectSummarySchema>;

/** Pacing result returned alongside tool outputs (audit trail; LLM ignores). */
export interface PacingResult {
  waitedMs: number;
  jitterMs: number;
  serial: true;
}

/**
 * P-23 §6.5: Sentinel envelope returned by getOrInitClient. When daemon's
 * `chromeAcquireGuard` denies Chrome ownership (REPL is alive), the success
 * branch is replaced by a structured `{ok:false}` envelope; tools narrow on
 * `r.ok` and propagate the envelope back to the model verbatim.
 */
export type ClientOrUnavailable =
  | { ok: true; client: CdpClient }
  | { ok: false; error: "chrome_unavailable"; message: string };

/** Session-scoped LinkedIn state; shared across all LinkedIn tools in one binary. */
export interface LinkedinSession {
  /** P-32: resolved input mode for this session (cdp | hardware). Set once at
   *  session creation via resolveInputMode (graceful downgrade — D-4). */
  readonly inputMode: "cdp" | "hardware";
  /**
   * Lazy-boot accessor. Returns the cached CdpClient via {ok:true,client} on
   * success; otherwise boots Chrome (ensureChrome + CdpClient.connect +
   * injectStealth) and caches. Concurrent calls dedupe via promise sharing.
   * Failed boots reset internal pending state so subsequent calls retry.
   *
   * P-23 §6.5: when the optional `chromeAcquireGuard` (passed to
   * createLinkedinSession) returns false, returns
   * `{ok:false, error:"chrome_unavailable", message}` instead of throwing.
   */
  getOrInitClient(): Promise<ClientOrUnavailable>;
  /**
   * Returns the cached CdpClient if Chrome has been booted (via a prior
   * getOrInitClient() call); otherwise undefined. Useful for diagnostic /
   * introspection paths that should NOT force-boot Chrome.
   */
  getClient(): CdpClient | undefined;
  /** [P-75 P-WEDGE-1] Wire the current turn's abort signal so every CDP call is
   *  raced against it (+ a per-call deadline). Stored on the session so a client
   *  booted MID-turn also inherits it; applied to the cached client immediately.
   *  Pass undefined at turn end to clear. */
  setTurnAbortSignal(signal?: AbortSignal): void;
  clearTurnAbortSignal(owner: AbortSignal): void;
  /** P-18 D-2: probe cached CDP connection health via Runtime.evaluate("1").
   *  Returns true if healthy (or no cached client to check).
   *  On failure, clears the stale cache so next tool call triggers reconnect. */
  heartbeat(): Promise<boolean>;
  setLastContext(ctx: CurrentSurfaceContext): void;
  getLastContext(): CurrentSurfaceContext | undefined;
  /**
   * P-Y2.3 (optional): magical Auto-mode takeover visual hooks. serve injects the driver via
   * setVisualDriver after capturing overlayContextId; the driver is Auto-gated (cronEnabled) and
   * returns true ONLY when it actually painted. Browser tools call showAgentTarget?.(box,label)
   * before a click so the overlay paints the agent cursor + element highlight. Optional → REPL /
   * tests / server-mode callers that never setVisualDriver no-op (showAgentTarget?.(…) chains away).
   */
  setVisualDriver?(driver: (fnDeclaration: string) => boolean): void;
  showAgentTarget?(box: { x: number; y: number; w: number; h: number }, label: string): Promise<void>;
  canClickOutbound?: (label: string, surface: string) => boolean;
  /** P-AUTO-1+2 (B-1 defense-in-depth): resolved runtime mode probe for the click-path hard
   *  gate so it can independently require a running auto-run in Auto. Optional → REPL/test/
   *  server callers that never wire it degrade to null (no Auto run-requirement enforced). */
  resolvedMode?: () => "manual" | "magical" | "auto";
  /** P-AUTO-1+2 (B-3): in-memory fail-closed latch. Set true when a post-dispatch ledger write
   *  fails — guarantees NO further outbound this session even if the durable DB block can't be
   *  written. Checked by the click-path connect_send gate before dispatch. */
  outboundDisabled?: boolean;
  /** P-AUTO-6: connect-surface integrity. Given the clicked label + surface, return BLOCK when a
   *  note-less instant invite (search/network sidebar "Invite <Name> to connect" — sends with NO
   *  modal) would fire for a person who HAS an unsent connect_note draft. Optional → REPL/test/server
   *  callers that never wire it degrade to no-op (like canClickOutbound). */
  connectNoteRequiredForLabel?: (label: string, surface: string) => { block: boolean; reason?: string };
  clearAgentTarget?(): void;
}

/** RefMap re-export for downstream consumers within `src/linkedin/`. */
export type { RefMap };

// -------- Envelope additions (rev 2 per plan §6.4) --------

/** The 4 frozen failure kinds per references/cli-primitives.md §Output envelope. */
export type FailureKind = "invalid_input" | "ambiguous_target" | "not_found" | "runtime_error";

/**
 * P-AUTO-13 (M6): a machine-readable discriminator for guard-rejected failures.
 * Carried as an OPTIONAL top-level field on CommandFailure (matching the historic
 * `{...fail(), reason}` spread shape). Produced via the typed `failWithReason()`
 * helper in envelope.ts (parameter-typed `reason: GuardReason`) at the nine
 * click-path producer sites (click.ts:117/140/153/170/180/188/196/205/265).
 * Absent for transient failures (e.g. ref_stale, page errors), which the agent
 * classifies as result:'failed'; present for policy guard-blocks, which the
 * agent classifies as result:'skipped' (the skip-worthy subset excludes
 * ledger_write_failed — see soul.ts auto fragment for the contract).
 */
export type GuardReason =
  | "outbound_disabled"
  | "no_active_run"
  | "no_daily_snapshot"
  | "daily_quota_reached"
  | "cooldown_active"
  | "auto_cap_reached"
  | "connect_note_required"
  | "approval_required"
  | "ledger_write_failed"
  | "unresolvable_ref_on_outbound_surface";

/** A single ambiguity candidate (e.g. when click matches multiple labels). */
export interface CommandCandidate {
  label?: string;
  scope?: string;
  ref?: string;
}

/** Success envelope — `data` is per-command. State-changing primitives include `data.hint`. */
export interface CommandSuccess<T extends Record<string, unknown>> {
  ok: true;
  command: string;
  data: T;
}

/** Failure envelope — kind selected from the 4-element FailureKind enum. */
export interface CommandFailure {
  ok: false;
  command: string;
  error: {
    kind: FailureKind;
    message: string;
    candidates?: CommandCandidate[];
  };
  /** P-AUTO-13: optional guard-rejection discriminator (top-level — matches
   *  the historic `{...fail(), reason}` spread shape, now produced via the
   *  typed `failWithReason()` helper at click.ts:117/140/153/170/180/188/
   *  196/205/265). Absent for transient failures; present for pre-dispatch
   *  policy blocks and the post-dispatch ledger_write_failed case. */
  reason?: GuardReason;
}

export type CommandEnvelope<T extends Record<string, unknown> = Record<string, unknown>> =
  | CommandSuccess<T>
  | CommandFailure;

/** State-change advisory string. Identical for every state-changing primitive. */
export const SURFACE_CHANGED_HINT = "Surface may have changed. Run inspect to discover current scopes and controls.";
