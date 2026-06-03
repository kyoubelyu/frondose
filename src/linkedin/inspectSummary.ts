import { FOLLOW_LABEL_RE, OUTBOUND_LABEL_RE } from "../tools/browser/outboundGuard.js";
import type { CurrentSurfaceContext, InspectSummary, LinkedInSurface, SnapshotEntry } from "./types.js";

export const CLICKABLE_ROLES = new Set([
  "button",
  "menuitem",
  "link",
  "checkbox",
  "radio",
  "switch",
  "textbox",
  "searchbox",
  "combobox",
  "textarea",
]);
export const INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "textarea"]);
// P-37 B4: feedPost — synthesized feed-post entries surface as inspect text.
// P-47 G-3: profileCard — synthesized profile-card entries (prepended on the
// profile surface). Chrome AX returns "StaticText" (capital S); keep both forms.
export const TEXT_ROLES = new Set(["staticText", "StaticText", "text", "heading", "feedPost", "profileCard"]);

const MAX_BUTTONS = 12;
const MAX_INPUTS = 12;
const MAX_TEXT = 40;
const TEXT_TRUNCATE = 180;

// P-46 D-3: composer-surface detection. Predicates ported from
// mai-linkedin/src/runtime/predicates/composer.ts — match the post-composer
// modal's buttons + text-editor input by accessible-name signal (NOT by URL
// surface, which stays "feed" while the modal is open).
const COMPOSER_BUTTON_RE =
  /(post to anyone|edit media preview|remove media|open emoji keyboard|open grammarly\.?|add media|schedule post|create a post|create an event|celebrate an occasion|^post$)/i;
const COMPOSER_INPUT_RE = /creating content|what do you want to talk about/i;
// The composer's publish control — accessible name exactly "Post" (anchored,
// so it does NOT match "Repost"). This is the strongest single composer signal.
const COMPOSER_PUBLISH_RE = /^post$/i;

function isComposerButtonEntry(e: SnapshotEntry): boolean {
  return e.role === "button" && COMPOSER_BUTTON_RE.test(e.name);
}

function isComposerInputEntry(e: SnapshotEntry): boolean {
  return INPUT_ROLES.has(e.role) && COMPOSER_INPUT_RE.test(e.name);
}

function isComposerPublishEntry(e: SnapshotEntry): boolean {
  return e.role === "button" && COMPOSER_PUBLISH_RE.test(e.name);
}

/** [P-75 D-11 inspect-side] An outbound-action button: matches the OUTBOUND_LABEL_RE
 *  set used by `outboundGuard.requiresApproval`, OR (on the profile surface only)
 *  matches the FOLLOW_LABEL_RE — so the entries the agent will click to execute the
 *  approved outbound action are surfaced as a distinct category in the inspect output. */
function isOutboundActionEntry(e: SnapshotEntry, surface: LinkedInSurface): boolean {
  if (!CLICKABLE_ROLES.has(e.role)) return false;
  if (OUTBOUND_LABEL_RE.test(e.name)) return true;
  if (surface === "profile" && FOLLOW_LABEL_RE.test(e.name)) return true;
  return false;
}

/**
 * True when the captured AX entries contain a STRONG post-composer signal.
 * C-5: a single weak composer-adjacent button (e.g. "create a post" — the feed
 * entry-point button, present even when no modal is open) must NOT advertise
 * the `composerModal` scope (per `references/inspect-contract.md` — a scope is
 * omitted when not actually visible). Require EITHER a confirmed publish
 * ("Post") button, OR the composer text editor input together with at least
 * one composer action button — those co-occur only inside the open modal.
 */
function hasComposerSignals(entries: SnapshotEntry[]): boolean {
  let hasPublish = false;
  let hasActionButton = false;
  let hasInput = false;
  for (const e of entries) {
    if (isComposerPublishEntry(e)) hasPublish = true;
    else if (isComposerButtonEntry(e)) hasActionButton = true;
    if (isComposerInputEntry(e)) hasInput = true;
  }
  return hasPublish || (hasInput && hasActionButton);
}

/**
 * Static per-surface availableScopes map. Subsets of the 18 frozen public scope ids
 * per `references/inspect-contract.md` §Public scope ids. P-3 ships the always-present
 * subset per surface; conditional scopes (e.g. `composerModal` only when composer is open)
 * are P-4+ enhancements.
 */
export const AVAILABLE_SCOPES_BY_SURFACE: Record<LinkedInSurface, string[]> = {
  feed: ["page", "feed", "post", "postActions"],
  network: ["page", "networkView"],
  notifications: ["page", "notificationsView"],
  messaging: ["page", "messagingThread", "messagingConversationList"],
  "messaging-thread": ["page", "messagingThread", "messagingConversation", "threadInput"],
  search: ["page", "searchResults"],
  profile: ["page", "profileView"],
  company: ["page", "companyView"],
  unknown: ["page"],
};

/** Build the compact InspectSummary from a captured surface context. */
export function buildInspectSummary(ctx: CurrentSurfaceContext, scope?: string): InspectSummary {
  const seen = new Set<string>();
  const dedupe = (e: SnapshotEntry): boolean => {
    const k = `${e.role}::${e.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };

  const filteredEntries = scope ? filterByScope(ctx.entries, scope) : ctx.entries;
  const deduped = filteredEntries.filter(dedupe);

  // P-46 D-3 (OQ-3): when a composer is open, promote composer buttons (esp.
  // "Post") ahead of the MAX_BUTTONS truncation so the unscoped inspect output
  // surfaces them without the agent needing to know the "composerModal" scope.
  // [P-75 D-11 inspect-side] Also promote OUTBOUND-action buttons (Connect / Invite /
  // Send invite / Send / 邀请 / 连接 / Follow on profile) to the FRONT of the list
  // and prefix their labels with `[OUTBOUND]` so the agent can't miss them when an
  // approved outbound step is in_progress. The list ranking + category prefix make
  // "which button executes the approved outbound" unambiguous at the inspect surface.
  const clickables = deduped.filter((e) => CLICKABLE_ROLES.has(e.role));
  const composerBtns = clickables.filter(isComposerButtonEntry);
  const outboundBtns = clickables
    .filter((e) => !isComposerButtonEntry(e))
    .filter((e) => isOutboundActionEntry(e, ctx.surface));
  const otherBtns = clickables.filter(
    (e) => !isComposerButtonEntry(e) && !isOutboundActionEntry(e, ctx.surface),
  );
  const buttons = [...composerBtns, ...outboundBtns, ...otherBtns]
    .slice(0, MAX_BUTTONS)
    .map((e) => ({
      ref: e.ref,
      label: isOutboundActionEntry(e, ctx.surface) ? `[OUTBOUND] ${e.name}` : e.name,
    }));

  const inputs = deduped
    .filter((e) => INPUT_ROLES.has(e.role))
    .slice(0, MAX_INPUTS)
    .map((e) => ({ ref: e.ref, label: e.name }));

  const text = deduped
    .filter((e) => TEXT_ROLES.has(e.role) && e.name.length > 0)
    .slice(0, MAX_TEXT)
    .map((e) => (e.name.length > TEXT_TRUNCATE ? `${e.name.slice(0, TEXT_TRUNCATE)}…` : e.name));

  // P-46 D-3 (OQ-4): composerModal is a runtime-conditional scope — list it only
  // when composer signals are actually present (per inspect-contract.md).
  const availableScopes = [...(AVAILABLE_SCOPES_BY_SURFACE[ctx.surface] ?? ["page"])];
  if (hasComposerSignals(ctx.entries) && !availableScopes.includes("composerModal")) {
    availableScopes.push("composerModal");
  }
  if (ctx.activeLayer === "overlay" && !availableScopes.includes("overlay")) {
    availableScopes.push("overlay");
  }

  return {
    surface: ctx.surface,
    activeLayer: ctx.activeLayer,
    availableScopes,
    text,
    buttons,
    inputs,
  };
}

/** P-46 D-3: scope filter. `composerModal` → composer buttons + composer text
 *  input only. All other scopes keep the P-3 no-op behavior (full entry set). */
function filterByScope(entries: SnapshotEntry[], scope: string): SnapshotEntry[] {
  if (scope === "composerModal") {
    return entries.filter((e) => isComposerButtonEntry(e) || isComposerInputEntry(e));
  }
  if (scope === "overlay") {
    return entries.filter((e) => e.ref.startsWith("@ov"));
  }
  return entries;
}
