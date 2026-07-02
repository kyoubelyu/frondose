import { FOLLOW_LABEL_RE, OUTBOUND_LABEL_RE } from "../tools/browser/outboundGuard.js";
import { COMPOSER_INPUT_RE, MESSAGING_INPUT_RE, POST_PUBLISH_RE } from "./logic/actionClassifier.js";
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
// P-AUTO-3 (B3): searchResult — synthesized person entries on search/network surfaces.
export const TEXT_ROLES = new Set([
  "staticText",
  "StaticText",
  "text",
  "heading",
  "feedPost",
  "profileCard",
  "searchResult",
  "messagingTranscript",
]);

// P-AUTO-15a (CAP-3 (b)): person-bearing roles whose names may embed a /in/<slug>
// URL. When the URL is recoverable, dedup keys on `${role}::${slug}` so two
// same-name distinct people both survive. Fallback to `${role}::${name}` when
// no URL is recoverable (rare — feed posts whose actor anchor doesn't carry an
// /in/ link; profileCard names which embed headline not URL).
export const PERSON_BEARING_ROLES = new Set(["searchResult", "feedPost", "profileCard"]);

// Match an embedded LinkedIn /in/<slug> URL inside a person-bearing entry name.
// Accepts absolute (https://www.linkedin.com/in/<slug>/) AND relative (/in/<slug>).
const PROFILE_URL_RE = /\/in\/([A-Za-z0-9._%-]+)/;

export function extractProfileUrl(name: string): string | null {
  const m = name.match(PROFILE_URL_RE);
  return m?.[1] ? m[1].toLowerCase() : null;
}

export function dedupKeyFor(e: SnapshotEntry): string {
  if (PERSON_BEARING_ROLES.has(e.role)) {
    const slug = extractProfileUrl(e.name);
    if (slug) return `${e.role}::${slug}`;
  }
  return `${e.role}::${e.name}`;
}

const MAX_BUTTONS = 12;
const MAX_INPUTS = 12;
const MAX_TEXT = 40;
export const MAX_TRANSCRIPT = 20;
const TEXT_TRUNCATE = 180;
// P-AUTO-15a (CAP-3 (c)): safety upper bound on person-bearing text entries.
// Well above any real surface's upstream synth caps (FEED_POST_CAP=15 +
// searchResultSynth internal cap=10 + profile's small fixed count). Unreachable
// in practice; exists only to prevent a synthetic/runaway context from emitting
// unboundedly.
const MAX_PERSON_HARD = 60;

// P-46 D-3: composer-surface detection. Predicates ported from
// mai-linkedin/src/runtime/predicates/composer.ts — match the post-composer
// modal's buttons + text-editor input by accessible-name signal (NOT by URL
// surface, which stays "feed" while the modal is open).
const COMPOSER_BUTTON_RE =
  /(post to anyone|edit media preview|remove media|open emoji keyboard|open grammarly\.?|add media|schedule post|create a post|create an event|celebrate an occasion|^post$)/i;
export { COMPOSER_INPUT_RE };
// The composer's publish control — accessible name exactly "Post" (anchored,
// so it does NOT match "Repost"). This is the strongest single composer signal.
const COMPOSER_PUBLISH_RE = POST_PUBLISH_RE;

function isComposerButtonEntry(e: SnapshotEntry): boolean {
  return e.role === "button" && (COMPOSER_BUTTON_RE.test(e.name) || POST_PUBLISH_RE.test(e.name));
}

function isComposerInputEntry(e: SnapshotEntry): boolean {
  return INPUT_ROLES.has(e.role) && COMPOSER_INPUT_RE.test(e.name);
}

function isComposerPublishEntry(e: SnapshotEntry): boolean {
  return e.role === "button" && COMPOSER_PUBLISH_RE.test(e.name);
}

function isMessagingConversationEntry(e: SnapshotEntry): boolean {
  return (
    (e.role === "link" && e.name === "Jump to active conversation details") ||
    (e.role === "button" &&
      (/star conversation/i.test(e.name) ||
        /^Minimize your conversation$/i.test(e.name) ||
        /^Minimize your conversation with /i.test(e.name) ||
        /^Close your draft conversation$/i.test(e.name) ||
        /^Close your conversation with /i.test(e.name)))
  );
}

function isThreadComposerInputEntry(e: SnapshotEntry): boolean {
  return INPUT_ROLES.has(e.role) && !/search/i.test(e.name) && MESSAGING_INPUT_RE.test(e.name);
}

function isThreadComposerButtonEntry(e: SnapshotEntry): boolean {
  return e.role === "button" && /(send|reply|attach|emoji|gif)/i.test(e.name);
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

/** [P-75 D-11 round 4] Send-family priority within outbound buttons. When a Connect-invite
 *  modal is open AND the page also has sidebar "Invite <Other> to connect" entries (the
 *  Hootan/Dmitry pattern: ~15 sidebar invites), the modal's Send button would be ranked
 *  alphabetically/positionally among the sidebar invites and could fall outside MAX_BUTTONS=12.
 *  Send-family always wins inside outboundBtns: Send invitation / Send invite / Send without
 *  a note / Send now / 发送(邀请)? / 直接发送 / 无备注发送 — these are the modal's outbound-
 *  COMMIT buttons (clicking sends), not the modal's outbound-ENTER buttons (clicking opens
 *  invite dialog). Commit-buttons are the highest-stakes click in any session — never crowd
 *  them out. */
const SEND_FAMILY_RE =
  /^(?:Send(?:\s+(?:invitation|invite|now|without\s+a\s+note))?\b|发送(?:邀请)?\b|直接发送|无备注发送)/i;
function isSendFamilyEntry(e: SnapshotEntry): boolean {
  return CLICKABLE_ROLES.has(e.role) && SEND_FAMILY_RE.test(e.name);
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
export function hasComposerSignals(entries: SnapshotEntry[]): boolean {
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
    const k = dedupKeyFor(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };

  const filteredEntries = scope ? filterEntriesByScope(ctx.entries, scope, ctx.surface) : ctx.entries;
  const deduped = filteredEntries.filter(dedupe);

  // P-46 D-3 (OQ-3): when a composer is open, promote composer buttons (esp.
  // "Post") ahead of the MAX_BUTTONS truncation so the unscoped inspect output
  // surfaces them without the agent needing to know the "composerModal" scope.
  // [P-75 D-11 inspect-side] Also promote OUTBOUND-action buttons (Connect / Invite /
  // Send invite / Send / 邀请 / 连接 / Follow on profile) to the FRONT of the list
  // and prefix their labels with `[OUTBOUND]` so the agent can't miss them when an
  // approved outbound step is in_progress. The list ranking + category prefix make
  // "which button executes the approved outbound" unambiguous at the inspect surface.
  const clickables = deduped.filter(
    (e) =>
      CLICKABLE_ROLES.has(e.role) &&
      !(ctx.surface === "messaging-thread" && scope === "threadInput" && INPUT_ROLES.has(e.role)),
  );
  // [P-75 D-11] Subject-scoped profile action controls (@pa*/@pm* synthesized refs from
  // snapshotCapture) ALWAYS lead the button list — they are the profile subject's OWN
  // Connect/Message/More/Follow, isolated from the sidebar "People you may know" invite/follow
  // buttons the flat AX tree mixes in. Without this, the [OUTBOUND] promotion ranked a dozen
  // sidebar "Invite <Other> to connect" buttons above the subject's own More (the path to Connect) —
  // the D-11 mis-targeting root cause.
  const isSubjectActionRef = (e: SnapshotEntry): boolean => /^@(pa|pm)\d/.test(e.ref);
  const subjectBtns = clickables.filter(isSubjectActionRef);
  const rest = clickables.filter((e) => !isSubjectActionRef(e));
  const composerBtns = rest.filter(isComposerButtonEntry);
  // [P-75 D-11 round 4] Split outboundBtns: Send-family (modal COMMIT button) ALWAYS
  // ranks above the rest. Without this, sidebar "Invite <Other> to connect" entries
  // (which also match OUTBOUND_LABEL_RE) can crowd Send invitation out of the top-12.
  const allOutboundBtns = rest
    .filter((e) => !isComposerButtonEntry(e))
    .filter((e) => isOutboundActionEntry(e, ctx.surface));
  const sendFamilyBtns = allOutboundBtns.filter(isSendFamilyEntry);
  const outboundBtns = allOutboundBtns.filter((e) => !isSendFamilyEntry(e));
  const otherBtns = rest.filter((e) => !isComposerButtonEntry(e) && !isOutboundActionEntry(e, ctx.surface));
  const buttons = [...subjectBtns, ...composerBtns, ...sendFamilyBtns, ...outboundBtns, ...otherBtns]
    .slice(0, MAX_BUTTONS)
    .map((e) => ({
      ref: e.ref,
      label: isOutboundActionEntry(e, ctx.surface) ? `[OUTBOUND] ${e.name}` : e.name,
    }));

  const inputs = deduped
    .filter((e) => INPUT_ROLES.has(e.role))
    .slice(0, MAX_INPUTS)
    .map((e) => ({ ref: e.ref, label: e.name }));

  // P-AUTO-15a (CAP-3 (c)+(d)): person-first-uncapped partition. Person-bearing
  // text entries get FIRST-CLAIM access to the text budget bounded only by the
  // safety cap MAX_PERSON_HARD. Non-person entries fill the REMAINDER of MAX_TEXT.
  // When something is dropped (shown < visible), append a synthetic diagnostic
  // hint entry as an EXTRA slot beyond MAX_TEXT (does NOT consume a real-entry
  // slot). Invariant: person_shown ≥ what the old text.slice(0, MAX_TEXT) would
  // have surfaced, for every input (post-dedup, post-scope-filter).
  const textEligible = deduped.filter((e) => TEXT_ROLES.has(e.role) && e.name.length > 0);
  const transcriptEligible =
    ctx.surface === "messaging-thread" ? textEligible.filter((e) => e.role === "messagingTranscript") : [];
  const remainderEligible =
    ctx.surface === "messaging-thread" ? textEligible.filter((e) => e.role !== "messagingTranscript") : textEligible;
  const transcriptShown = transcriptEligible.slice(0, MAX_TRANSCRIPT);
  const personEligible = remainderEligible.filter((e) => PERSON_BEARING_ROLES.has(e.role));
  const nonPersonEligible = remainderEligible.filter((e) => !PERSON_BEARING_ROLES.has(e.role));
  const personShown = personEligible.slice(0, MAX_PERSON_HARD);
  const nonPersonBudget = Math.max(0, MAX_TEXT - transcriptShown.length - personShown.length);
  const nonPersonShown = nonPersonEligible.slice(0, nonPersonBudget);
  const renderText = (e: SnapshotEntry) =>
    e.name.length > TEXT_TRUNCATE ? `${e.name.slice(0, TEXT_TRUNCATE)}…` : e.name;
  const text = [...transcriptShown.map(renderText), ...personShown.map(renderText), ...nonPersonShown.map(renderText)];
  const visibleCount = textEligible.length;
  const shownCount = text.length; // real entries only; hint not yet appended
  if (shownCount < visibleCount) {
    text.push(`[diagnostic] ${visibleCount} entries visible, ${shownCount} shown — scroll/refine to see more`);
  }

  // P-46 D-3 (OQ-4): composerModal is a runtime-conditional scope — list it only
  // when composer signals are actually present (per inspect-contract.md).
  const availableScopes = [...(AVAILABLE_SCOPES_BY_SURFACE[ctx.surface] ?? ["page"])];
  if (hasComposerSignals(ctx.entries) && !availableScopes.includes("composerModal")) {
    availableScopes.push("composerModal");
  }
  if (hasComposerSignals(ctx.entries) && !availableScopes.includes("composerInput")) {
    availableScopes.push("composerInput");
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
 *  input only. All other scopes keep the P-3 no-op behavior (full entry set).
 *  P-AUTO-15a: exported as `filterEntriesByScope` so the inspect tool can reuse
 *  the SAME scope filter when deriving full:true diagnostics (N2 fix — keeps
 *  the scoped count consistent with the scoped set the partition observed). */
export function filterEntriesByScope(
  entries: SnapshotEntry[],
  scope: string,
  surface?: LinkedInSurface,
): SnapshotEntry[] {
  if (scope === "composerModal") {
    return entries.filter((e) => isComposerButtonEntry(e) || isComposerInputEntry(e));
  }
  if (scope === "composerInput") {
    return entries.filter((e) => e.ref.startsWith("@pc"));
  }
  if (scope === "overlay") {
    return entries.filter((e) => e.ref.startsWith("@ov"));
  }
  if (surface === "messaging-thread" && scope === "messagingConversation") {
    return entries.filter((e) => e.role === "messagingTranscript" || isMessagingConversationEntry(e));
  }
  if (surface === "messaging-thread" && scope === "threadInput") {
    return entries.filter((e) => isThreadComposerInputEntry(e) || isThreadComposerButtonEntry(e));
  }
  return entries;
}
