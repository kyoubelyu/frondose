import type { AmbiguityCase, InspectScope, InteractiveRegion } from "../contracts/inspect.js";
import {
  MINIMAL_PUBLIC_SCOPE_LABELS,
  MINIMAL_PUBLIC_SCOPE_PARENTS,
  type MinimalPublicScopeId,
} from "../contracts/minimalPublicContract.js";
import type { SnapshotEntry } from "./currentSurfaceTypes.js";
import {
  hasArticleManageSurfaceSignals,
  hasProfileConnectPromptOverlay,
  hasArticleEditorSurfaceSignals,
  isActorSelectionModalEntry,
  isArticleEditorButtonEntry,
  isArticleEditorInputEntry,
  isArticleManageDraftEntry,
  isArticleManageTabEntry,
  isComposerAudienceModalEntry,
  isComposerMediaModalEntry,
  isComposerScheduleModalEntry,
  isProfileConnectPromptEntry,
  isReactionModalEntry,
  type FeedSignals,
  type ForegroundContext,
  type MessagingSignals,
} from "./foregroundContext.js";
import { buildCurrentSurfaceRegionParts } from "./currentSurfaceRegions.js";
import {
  activeComposerEntriesWithEmoji,
  dedupeEntriesByRoleAndName,
  hasPostingComposer,
  isInputEntry,
  uniqueOrdered,
} from "./visibleScopeCommon.js";

const REPEATED_CONTROL_LABELS = new Set([
  "Comment",
  "Repost",
  "Send",
  "Message",
  "More",
  "Reply",
  "Open reactions menu",
  "Open actor selection screen",
  "Load more comments",
]);

export interface CurrentSurfaceSummaryParts {
  availableScopeIds: MinimalPublicScopeId[];
  summaryEntries: SnapshotEntry[];
  text: string[];
  buttons: string[];
  inputs: string[];
  inputValues: string[];
  repeatedControls: string[];
}

export interface CurrentSurfaceSummaryAssembly {
  ambiguityCases: AmbiguityCase[];
  availableScopes: InspectScope[];
  buttons: string[];
  inputs: string[];
  inputValues: string[];
  interactiveRegions: InteractiveRegion[];
  repeatedControls: string[];
  text: string[];
}

function summaryEntriesForForegroundContext(
  foregroundContext: ForegroundContext,
  entries: SnapshotEntry[],
  pageUrl: string,
): SnapshotEntry[] {
  if (foregroundContext.legacySurface === "article-editor" && hasArticleEditorSurfaceSignals(entries, pageUrl)) {
    return dedupeEntriesByRoleAndName(
      entries.filter((entry) => isArticleEditorInputEntry(entry) || isArticleEditorButtonEntry(entry)),
    );
  }

  if (foregroundContext.legacySurface === "article-manage" && hasArticleManageSurfaceSignals(entries, pageUrl)) {
    return dedupeEntriesByRoleAndName(
      entries.filter((entry) => isArticleManageTabEntry(entry) || isArticleManageDraftEntry(entry)),
    );
  }

  if (
    foregroundContext.kind === "local-overlay" &&
    foregroundContext.routeBucket === "profile" &&
    hasProfileConnectPromptOverlay(pageUrl, foregroundContext.legacySurface, entries)
  ) {
    return dedupeEntriesByRoleAndName(entries.filter((entry) => isProfileConnectPromptEntry(entry)));
  }

  if (foregroundContext.kind !== "modal") {
    return entries;
  }

  if (foregroundContext.legacySurface === "composer-modal") {
    return activeComposerEntriesWithEmoji(entries);
  }

  if (foregroundContext.legacySurface === "composer-draft-confirmation") {
    return entries.filter((entry) => /^(discard|save as draft)$/i.test(entry.name));
  }

  if (foregroundContext.legacySurface === "composer-audience-modal") {
    return entries.filter((entry) => isComposerAudienceModalEntry(entry));
  }

  if (foregroundContext.legacySurface === "composer-media-modal") {
    return entries.filter((entry) => isComposerMediaModalEntry(entry));
  }

  if (foregroundContext.legacySurface === "composer-schedule-modal") {
    return entries.filter((entry) => isComposerScheduleModalEntry(entry));
  }

  if (foregroundContext.legacySurface === "reaction-modal") {
    return entries.filter((entry) => isReactionModalEntry(entry));
  }

  if (foregroundContext.legacySurface === "actor-selection-modal") {
    return entries.filter((entry) => isActorSelectionModalEntry(entry));
  }

  return entries;
}

function scopeIdsForForegroundContext(
  foregroundContext: ForegroundContext,
  entries: SnapshotEntry[],
  messagingSignals?: MessagingSignals,
  feedSignals?: FeedSignals,
): MinimalPublicScopeId[] {
  if (foregroundContext.kind === "modal") {
    switch (foregroundContext.legacySurface) {
      case "composer-modal":
        return ["page", "feed", "composerModal", "composerInput"];
      case "composer-media-modal":
        return ["page", "feed", "composerModal"];
      case "composer-draft-confirmation":
        return ["page", "feed", "composerModal"];
      case "reaction-modal":
        return ["page", "reactionModal"];
      case "actor-selection-modal":
        return ["page", "feed"];
      case "composer-audience-modal":
      case "composer-schedule-modal":
        return ["page", "feed", "composerModal"];
      default:
        return ["page"];
    }
  }

  if (foregroundContext.kind === "thread" && foregroundContext.routeBucket === "messaging") {
    const scopeIds: MinimalPublicScopeId[] = ["page", "messagingThread"];

    if (messagingSignals?.hasSearch) {
      scopeIds.push("messagingSearch");
    }

    if (messagingSignals?.hasConversationList) {
      scopeIds.push("messagingConversationList");
    }

    if (messagingSignals?.hasActiveConversation) {
      scopeIds.push("messagingConversation");
    }

    if (messagingSignals?.hasThreadComposer) {
      scopeIds.push("threadInput");
    }

    return scopeIds;
  }

  switch (foregroundContext.routeBucket) {
    case "network":
      return ["page", "networkView"];
    case "notifications":
      return ["page", "notificationsView"];
    case "search":
      return ["page", "searchResults"];
    case "profile":
      return ["page", "profileView"];
    case "company":
      return hasPostingComposer(entries)
        ? ["page", "companyView", "composerModal", "composerInput"]
        : ["page", "companyView"];
    case "companyInbox":
      return ["page", "companyView", "companyInboxThread"];
    case "articles":
      return ["page"];
    case "feed":
    default:
      return [
        "page",
        "feed",
        "post",
        ...(feedSignals?.hasCommentComposer ? (["comment"] as const) : []),
        "postActions",
      ];
  }
}

function buildButtons(entries: SnapshotEntry[]): string[] {
  return uniqueOrdered(
    entries
      .filter((entry) => entry.role === "button" || entry.role === "switch")
      .map((entry) => entry.name)
      .slice(0, 24),
  );
}

function buildInputsWithValues(entries: SnapshotEntry[]): { inputs: string[]; inputValues: string[] } {
  const inputEntries = entries.filter((entry) => isInputEntry(entry)).slice(0, 12);
  const seen = new Set<string>();
  const inputs: string[] = [];
  const inputValues: string[] = [];

  for (const entry of inputEntries) {
    const name = (entry.name || entry.role).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    inputs.push(name);
    inputValues.push(entry.value ?? "");
  }

  return { inputs, inputValues };
}

function buildTexts(entries: SnapshotEntry[]): string[] {
  return uniqueOrdered(
    entries
      .filter((entry) =>
        [
          "button",
          "link",
          "heading",
          "textbox",
          "searchbox",
          "combobox",
          "textarea",
          "radio",
          "switch",
          "tab",
        ].includes(entry.role),
      )
      .map((entry) => entry.name)
      .slice(0, 20),
  );
}

function buildRepeatedControls(entries: SnapshotEntry[]): string[] {
  const counts = new Map<string, number>();

  for (const entry of entries) {
    if (!entry.name) {
      continue;
    }

    counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([label, count]) => count > 1 && REPEATED_CONTROL_LABELS.has(label))
    .map(([label]) => label)
    .slice(0, 12);
}

export function buildCurrentSurfaceSummaryParts(
  foregroundContext: ForegroundContext,
  inspectEntries: SnapshotEntry[],
  pageUrl: string,
  messagingSignals?: MessagingSignals,
  feedSignals?: FeedSignals,
): CurrentSurfaceSummaryParts {
  const summaryEntries = summaryEntriesForForegroundContext(foregroundContext, inspectEntries, pageUrl);
  const { inputs, inputValues } = buildInputsWithValues(summaryEntries);

  return {
    availableScopeIds: scopeIdsForForegroundContext(foregroundContext, inspectEntries, messagingSignals, feedSignals),
    summaryEntries,
    text: buildTexts(summaryEntries),
    buttons: buildButtons(summaryEntries),
    inputs,
    inputValues,
    repeatedControls: buildRepeatedControls(summaryEntries),
  };
}

function toInspectScope(id: MinimalPublicScopeId): InspectScope {
  const parent = MINIMAL_PUBLIC_SCOPE_PARENTS[id];
  return {
    id,
    label: MINIMAL_PUBLIC_SCOPE_LABELS[id],
    ...(parent ? { parent } : {}),
  };
}

export function buildCurrentSurfaceSummaryAssembly(
  foregroundContext: ForegroundContext,
  inspectEntries: SnapshotEntry[],
  entries: SnapshotEntry[],
  pageUrl: string,
  messagingSignals?: MessagingSignals,
  feedSignals?: FeedSignals,
): CurrentSurfaceSummaryAssembly {
  const summaryParts = buildCurrentSurfaceSummaryParts(
    foregroundContext,
    inspectEntries,
    pageUrl,
    messagingSignals,
    feedSignals,
  );
  const interactiveEntries = foregroundContext.kind === "local-overlay" ? entries : summaryParts.summaryEntries;
  const regionParts = buildCurrentSurfaceRegionParts(
    foregroundContext,
    summaryParts.repeatedControls,
    summaryParts.inputs,
    interactiveEntries,
    pageUrl,
    summaryParts.availableScopeIds,
    messagingSignals,
    feedSignals,
  );

  return {
    ambiguityCases: regionParts.ambiguityCases,
    availableScopes: summaryParts.availableScopeIds.map(toInspectScope),
    buttons: summaryParts.buttons,
    inputs: summaryParts.inputs,
    inputValues: summaryParts.inputValues,
    interactiveRegions: regionParts.interactiveRegions,
    repeatedControls: summaryParts.repeatedControls,
    text: summaryParts.text,
  };
}
