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
}

/** Compact AX tree + surface routing context for LinkedIn pages. */
export interface CurrentSurfaceContext {
  pageUrl: string;
  surface: LinkedInSurface;
  /** P-3: always "page" (modal detection deferred to P-4). */
  activeLayer: "page";
  entries: SnapshotEntry[];
}

/**
 * Zod schema + inferred type for the `inspect` tool's return shape.
 * Per guardian critic CONCERN-MR-5: `activeLayer` is `z.literal("page")` (not enum),
 * matching the implementation literal. P-4 will widen additively when modal lands.
 */
export const inspectSummarySchema = z.object({
  surface: z.string(),
  activeLayer: z.literal("page"),
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

/** Session-scoped LinkedIn state; shared across all LinkedIn tools in one binary. */
export interface LinkedinSession {
  getClient(): CdpClient;
  setLastContext(ctx: CurrentSurfaceContext): void;
  getLastContext(): CurrentSurfaceContext | undefined;
}

/** RefMap re-export for downstream consumers within `src/linkedin/`. */
export type { RefMap };

// -------- Envelope additions (rev 2 per plan §6.4) --------

/** The 4 frozen failure kinds per references/cli-primitives.md §Output envelope. */
export type FailureKind = "invalid_input" | "ambiguous_target" | "not_found" | "runtime_error";

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
}

export type CommandEnvelope<T extends Record<string, unknown> = Record<string, unknown>> =
  | CommandSuccess<T>
  | CommandFailure;

/** State-change advisory string. Identical for every state-changing primitive. */
export const SURFACE_CHANGED_HINT = "Surface may have changed. Run inspect to discover current scopes and controls.";
