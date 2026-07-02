import type { ActiveLayer } from "../contracts/inspect.js";
import type { ForegroundKind, ForegroundRouteBucket } from "../contracts/visibleScope.js";
import { inferSurface } from "../../scopeResolver.js";
import type { LinkedInSurface, SnapshotEntry } from "../../types.js";
import { isInputEntry } from "../predicates/_shared.js";
import { hasActorSelectionModalSurfaceSignals } from "../predicates/actorSelection.js";
import { hasArticleEditorSurfaceSignals, hasArticleManageSurfaceSignals } from "../predicates/article.js";
import {
  hasComposerAudienceSurfaceSignals,
  hasComposerScheduleSurfaceSignals,
  isComposerButtonEntry,
  isComposerInputEntry,
} from "../predicates/composer.js";
import {
  hasFeedCommentThreadSignals,
  hasProfileConnectPromptOverlay,
  hasProfileMessageOverlayThread,
} from "../predicates/feedProfile.js";
import { hasComposerMediaSurfaceSignals } from "../predicates/media.js";
import {
  isMessagingConversationEntry,
  isMessagingListEntry,
  isMessagingSearchEntry,
} from "../predicates/messaging.js";
import { hasReactionModalSurfaceSignals } from "../predicates/reactionModal.js";

export type { FeedSignals, ForegroundKind, ForegroundRouteBucket, MessagingSignals } from "../contracts/visibleScope.js";
export * from "../predicates/messaging.js";
export * from "../predicates/composer.js";
export * from "../predicates/article.js";
export * from "../predicates/reactionModal.js";
export * from "../predicates/actorSelection.js";
export * from "../predicates/media.js";
export * from "../predicates/feedProfile.js";

export interface ForegroundContext {
  legacySurface: string;
  kind: ForegroundKind;
  routeBucket: ForegroundRouteBucket;
  activeLayer: ActiveLayer;
}

const MESSAGING_OVERLAY_SHELL_LABELS = new Set([
  "You are on the messaging overlay. Press enter to open the list of conversations.",
  "You are on the messaging overlay. Press enter to minimize it.",
  "Open messenger dropdown menu",
  "Compose message",
]);
const MESSAGING_OVERLAY_FILTER_LABELS = new Set(["Filter messages by"]);
const MESSAGING_OVERLAY_SEARCH_PATTERN = /type to search for connections and conversations/i;

function isComposerDraftConfirmationEntry(entry: SnapshotEntry): boolean {
  return entry.role === "button" && /^(discard|save as draft)$/i.test(entry.name);
}

function hasComposerDraftConfirmationSurfaceSignals(entries: SnapshotEntry[]): boolean {
  return entries.some((entry) => isComposerDraftConfirmationEntry(entry));
}

function isMessagingOverlayShellEntry(entry: SnapshotEntry): boolean {
  return entry.role === "button" && MESSAGING_OVERLAY_SHELL_LABELS.has(entry.name);
}

function isMessagingOverlayProfileLinkEntry(entry: SnapshotEntry): boolean {
  return entry.role === "link" && /^View .+ profile .+/i.test(entry.name);
}

function isMessagingOverlayConversationSearchEntry(entry: SnapshotEntry): boolean {
  return isInputEntry(entry) && MESSAGING_OVERLAY_SEARCH_PATTERN.test(entry.name);
}

function isMessagingOverlayFilterEntry(entry: SnapshotEntry): boolean {
  return (
    (entry.role === "button" && MESSAGING_OVERLAY_FILTER_LABELS.has(entry.name)) ||
    (entry.role === "checkbox" && /^Select conversation with /i.test(entry.name))
  );
}

function shouldIgnoreMessagingOverlay(pageUrl: string): boolean {
  return !pageUrl.toLowerCase().includes("/messaging/");
}

function isMessagingOverlayInspectEntry(entry: SnapshotEntry, pageUrl: string): boolean {
  if (!shouldIgnoreMessagingOverlay(pageUrl)) {
    return false;
  }

  return (
    isMessagingOverlayShellEntry(entry) ||
    isMessagingOverlayProfileLinkEntry(entry) ||
    isMessagingOverlayConversationSearchEntry(entry) ||
    isMessagingOverlayFilterEntry(entry) ||
    isMessagingConversationEntry(entry, pageUrl) ||
    isMessagingSearchEntry(entry) ||
    isMessagingListEntry(entry)
  );
}

export function inspectEntriesForPage(pageUrl: string, entries: SnapshotEntry[]): SnapshotEntry[] {
  if (!shouldIgnoreMessagingOverlay(pageUrl)) {
    return entries;
  }

  return entries.filter((entry) => !isMessagingOverlayInspectEntry(entry, pageUrl));
}

function inferLegacySurfaceId(pageUrl: string, entries: SnapshotEntry[]): string {
  const lowerUrl = pageUrl.toLowerCase();
  const surfaceEntries = inspectEntriesForPage(pageUrl, entries);
  const hasComposerSignals = surfaceEntries.some(
    (entry) => isComposerInputEntry(entry) || isComposerButtonEntry(entry),
  );
  const hasComposerAudienceSignals = hasComposerAudienceSurfaceSignals(surfaceEntries);
  const hasComposerScheduleSignals = hasComposerScheduleSurfaceSignals(surfaceEntries);
  const hasReactionModalSignals = hasReactionModalSurfaceSignals(surfaceEntries);
  const hasActorSelectionModalSignals = hasActorSelectionModalSurfaceSignals(surfaceEntries);
  const hasComposerMediaSignals = hasComposerMediaSurfaceSignals(surfaceEntries);

  if (hasReactionModalSignals) {
    return "reaction-modal";
  }

  if (hasActorSelectionModalSignals) {
    return "actor-selection-modal";
  }

  if (hasComposerMediaSignals) {
    return "composer-media-modal";
  }

  if (hasComposerScheduleSignals) {
    return "composer-schedule-modal";
  }

  if (hasComposerDraftConfirmationSurfaceSignals(surfaceEntries)) {
    return "composer-draft-confirmation";
  }

  if (hasComposerAudienceSignals) {
    return "composer-audience-modal";
  }

  if (hasArticleEditorSurfaceSignals(surfaceEntries, pageUrl)) {
    return "article-editor";
  }

  if (hasArticleManageSurfaceSignals(surfaceEntries, pageUrl)) {
    return "article-manage";
  }

  if (lowerUrl.includes("/messaging/")) {
    return "messaging-thread";
  }

  if (lowerUrl.includes("/notifications/")) {
    return "notifications";
  }

  if (lowerUrl.includes("/search/results/")) {
    return "search";
  }

  if (lowerUrl.includes("/mynetwork/")) {
    return "network";
  }

  if (lowerUrl.includes("/recent-activity/articles/")) {
    return "profile-articles";
  }

  if (lowerUrl.includes("linkedin.com/in/")) {
    return "profile";
  }

  if (lowerUrl.includes("linkedin.com/company/")) {
    return "company";
  }

  if (hasFeedCommentThreadSignals(surfaceEntries, pageUrl)) {
    return "feed";
  }

  if (hasComposerSignals) {
    return "composer-modal";
  }

  return "feed";
}

function routeBucketForLinkedInSurface(surface: LinkedInSurface): ForegroundRouteBucket | undefined {
  switch (surface) {
    case "feed":
      return "feed";
    case "messaging":
    case "messaging-thread":
      return "messaging";
    case "notifications":
      return "notifications";
    case "search":
      return "search";
    case "network":
      return "network";
    case "profile":
      return "profile";
    case "company":
      return "company";
    case "unknown":
      return undefined;
  }
}

function inferRouteBucket(pageUrl: string): ForegroundRouteBucket {
  const lowerUrl = pageUrl.toLowerCase();

  if (lowerUrl.includes("/article/")) {
    return "articles";
  }

  if (lowerUrl.includes("/admin/inbox/")) {
    return "companyInbox";
  }

  return routeBucketForLinkedInSurface(inferSurface(pageUrl)) ?? "feed";
}

function resolveForegroundKind(surface: string, pageUrl: string, entries: SnapshotEntry[]): ForegroundKind {
  if (surface === "article-editor") {
    return "page";
  }

  if (surface === "messaging-thread" || pageUrl.includes("/messaging/thread/")) {
    return "thread";
  }

  if (hasProfileConnectPromptOverlay(pageUrl, surface, entries)) {
    return "local-overlay";
  }

  if (hasProfileMessageOverlayThread(pageUrl, surface, entries)) {
    return "local-overlay";
  }

  if (surface === "composer-draft-confirmation") {
    return "modal";
  }

  if (surface.includes("modal")) {
    return "modal";
  }

  return "page";
}

function activeLayerForKind(kind: ForegroundKind): ActiveLayer {
  if (kind === "modal") {
    return "modal";
  }

  if (kind === "thread" || kind === "local-overlay") {
    return "thread";
  }

  return "page";
}

export function createForegroundContextFromSurface(
  surface: string,
  pageUrl: string,
  entries: SnapshotEntry[],
): ForegroundContext {
  const kind = resolveForegroundKind(surface, pageUrl, entries);
  return {
    legacySurface: surface,
    kind,
    routeBucket: inferRouteBucket(pageUrl),
    activeLayer: activeLayerForKind(kind),
  };
}

export function createForegroundContext(pageUrl: string, entries: SnapshotEntry[]): ForegroundContext {
  return createForegroundContextFromSurface(inferLegacySurfaceId(pageUrl, entries), pageUrl, entries);
}

export function activeLayerForForegroundContext(context: ForegroundContext): ActiveLayer {
  return context.activeLayer;
}

export function inferSurfaceId(pageUrl: string, entries: SnapshotEntry[]): string {
  return inferLegacySurfaceId(pageUrl, entries);
}

export function inferActiveLayer(surface: string, pageUrl: string, entries: SnapshotEntry[] = []): ActiveLayer {
  return activeLayerForForegroundContext(createForegroundContextFromSurface(surface, pageUrl, entries));
}
