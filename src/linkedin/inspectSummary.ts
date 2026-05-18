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
export const TEXT_ROLES = new Set(["staticText", "text", "heading", "feedPost"]);

const MAX_BUTTONS = 12;
const MAX_INPUTS = 12;
const MAX_TEXT = 10;
const TEXT_TRUNCATE = 180;

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

  const buttons = deduped
    .filter((e) => CLICKABLE_ROLES.has(e.role))
    .slice(0, MAX_BUTTONS)
    .map((e) => ({ ref: e.ref, label: e.name }));

  const inputs = deduped
    .filter((e) => INPUT_ROLES.has(e.role))
    .slice(0, MAX_INPUTS)
    .map((e) => ({ ref: e.ref, label: e.name }));

  const text = deduped
    .filter((e) => TEXT_ROLES.has(e.role) && e.name.length > 0)
    .slice(0, MAX_TEXT)
    .map((e) => (e.name.length > TEXT_TRUNCATE ? `${e.name.slice(0, TEXT_TRUNCATE)}…` : e.name));

  const availableScopes = AVAILABLE_SCOPES_BY_SURFACE[ctx.surface] ?? ["page"];

  return {
    surface: ctx.surface,
    activeLayer: ctx.activeLayer,
    availableScopes,
    text,
    buttons,
    inputs,
  };
}

/** P-3 simplified scope filter: returns full entries (full subtree resolution is P-4). */
function filterByScope(entries: SnapshotEntry[], _scope: string): SnapshotEntry[] {
  return entries;
}
