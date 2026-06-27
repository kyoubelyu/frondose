import type { CommandCandidate } from "../../types.js";
import {
  findVisibleScopeInspectionByHandle,
  resolveVisibleScopeKind,
} from "../contracts/visibleScope.js";
import {
  isMinimalPublicScopeId,
  type MinimalPublicScopeId,
} from "../contracts/minimalPublicContract.js";
import type { CurrentSurfaceContext, SnapshotEntry } from "../surface/currentSurfaceTypes.js";
import { scopeOwnsEntry } from "../surface/scopeProjection.js";
import {
  isCommentButtonEntry,
  isCommentInputEntry,
  isMessagingConversationEntry,
  isMessagingListEntry,
  isMessagingSearchEntry,
  isPostActionEntry,
  isThreadComposerButtonEntry,
  isThreadComposerInputEntry,
} from "../surface/foregroundContext.js";
import { CLICKABLE_ROLES, COMPOSER_BUTTON_LABELS, INPUT_ROLES, type ScopedTargetKind } from "./shared.js";
import { hasInlineCompanyComposer, isVisibleScopeHandle, resolveFrozenPublicScope } from "./normalize.js";

export function matchesLabel(entry: SnapshotEntry, label: string | undefined): boolean {
  if (!label) {
    return true;
  }

  return entry.name.trim().toLowerCase() === label.toLowerCase();
}

export function entryMatchesKind(entry: SnapshotEntry, kind: ScopedTargetKind): boolean {
  if (kind === "button") {
    return CLICKABLE_ROLES.has(entry.role);
  }

  if (kind === "input") {
    return INPUT_ROLES.has(entry.role);
  }

  return false;
}

export function defaultInputCandidates(entries: SnapshotEntry[]): SnapshotEntry[] {
  const nonSearch = entries.filter((entry) => !/search/i.test(entry.name));
  return nonSearch.length > 0 ? nonSearch : entries;
}

function inferSurfaceScopeForEntry(
  context: CurrentSurfaceContext,
  entry: SnapshotEntry,
  kind: ScopedTargetKind,
): string | undefined {
  if (context.surface.startsWith("composer-")) {
    if (kind === "input" && !/search/i.test(entry.name)) {
      return "composerInput";
    }

    if (kind === "button" && COMPOSER_BUTTON_LABELS.test(entry.name)) {
      return "composerModal";
    }

    return "composerModal";
  }

  if (context.surface === "company") {
    if (kind === "input" && scopeOwnsEntry(context, "composerInput", entry)) {
      return "composerInput";
    }

    if (kind === "button" && scopeOwnsEntry(context, "composerInput", entry)) {
      return "composerModal";
    }
  }

  if (context.surface === "reaction-modal") {
    return "reactionModal";
  }

  if (context.surface === "messaging-thread") {
    if (isMessagingSearchEntry(entry)) {
      return "messagingSearch";
    }

    if (isThreadComposerInputEntry(entry) || isThreadComposerButtonEntry(entry)) {
      return "threadInput";
    }

    if (isMessagingConversationEntry(entry, context.pageUrl)) {
      return "messagingConversation";
    }

    if (isMessagingListEntry(entry)) {
      return "messagingConversationList";
    }

    return "messagingThread";
  }

  if (context.surface === "feed") {
    if (isCommentInputEntry(entry) || isCommentButtonEntry(entry)) {
      return "comment";
    }

    if (kind === "button" && isPostActionEntry(entry)) {
      return "postActions";
    }

    return "feed";
  }

  switch (context.surface) {
    case "notifications":
      return "notificationsView";
    case "network":
      return "networkView";
    case "search":
      return "searchResults";
    case "profile":
      return "profileView";
    case "company":
      return "companyView";
    default:
      return "page";
  }
}

export function inferScopeForEntry(
  context: CurrentSurfaceContext,
  entry: SnapshotEntry,
  kind: ScopedTargetKind,
): string | undefined {
  const visibleScopeHandle = context.visibleScopeInspections?.find((inspection) =>
    inspection.controls.some((control) => control.selectorRef === entry.ref || control.ref === entry.ref),
  )?.scope.handle;
  if (visibleScopeHandle) {
    return visibleScopeHandle;
  }

  return inferSurfaceScopeForEntry(context, entry, kind);
}

export function resolveEntryPublicScope(
  context: CurrentSurfaceContext,
  entry: SnapshotEntry,
  kind: ScopedTargetKind,
  requestedScope: string | undefined,
): MinimalPublicScopeId | undefined {
  const inferredScope = inferScopeForEntry(context, entry, kind);
  const inferredPublicScope = resolveFrozenPublicScope(context, inferredScope);
  if (inferredPublicScope) {
    return inferredPublicScope;
  }

  if (inferredScope && !isMinimalPublicScopeId(inferredScope) && isVisibleScopeHandle(context, inferredScope)) {
    const inferredVisibleKind = resolveVisibleScopeKind(context.summary.visibleScopes, inferredScope);
    if (inferredVisibleKind && isMinimalPublicScopeId(inferredVisibleKind)) {
      return undefined;
    }
  }

  return resolveFrozenPublicScope(context, inferSurfaceScopeForEntry(context, entry, kind) ?? requestedScope);
}

export function entryMatchesScope(
  context: CurrentSurfaceContext,
  scope: string | undefined,
  entry: SnapshotEntry,
): boolean {
  if (!scope || scope === "page") {
    return true;
  }

  if (!isMinimalPublicScopeId(scope)) {
    const visibleScope = findVisibleScopeInspectionByHandle(context.visibleScopeInspections, scope);
    return (
      visibleScope?.controls.some((control) => control.selectorRef === entry.ref || control.ref === entry.ref) ?? false
    );
  }

  if (scope === "feed") {
    return context.surface === "feed" && !scopeOwnsEntry(context, "comment", entry);
  }

  if (scope === "post" || scope === "postActions") {
    return context.surface === "feed" && scopeOwnsEntry(context, scope, entry);
  }

  if (scope === "comment") {
    return context.surface === "feed" && scopeOwnsEntry(context, scope, entry);
  }

  if (scope === "composerModal") {
    return (
      context.surface.startsWith("composer-") ||
      (hasInlineCompanyComposer(context) && scopeOwnsEntry(context, "composerInput", entry))
    );
  }

  if (scope === "reactionModal") {
    return context.surface === "reaction-modal" && scopeOwnsEntry(context, scope, entry);
  }

  if (scope === "composerInput") {
    return scopeOwnsEntry(context, "composerInput", entry);
  }

  if (scope === "messagingThread") {
    return context.surface === "messaging-thread";
  }

  if (scope === "messagingSearch") {
    return context.surface === "messaging-thread" && scopeOwnsEntry(context, scope, entry);
  }

  if (scope === "messagingConversationList") {
    return context.surface === "messaging-thread" && scopeOwnsEntry(context, scope, entry);
  }

  if (scope === "messagingConversation") {
    return context.surface === "messaging-thread" && scopeOwnsEntry(context, scope, entry);
  }

  if (scope === "threadInput") {
    return context.surface === "messaging-thread" && scopeOwnsEntry(context, scope, entry);
  }

  if (scope === "notificationsView") {
    return context.surface === "notifications";
  }

  if (scope === "networkView") {
    return context.surface === "network";
  }

  if (scope === "searchResults") {
    return context.surface === "search";
  }

  if (scope === "profileView") {
    return context.surface === "profile";
  }

  if (scope === "companyView") {
    return context.surface === "company";
  }

  return false;
}

export function buildAmbiguityCandidates(
  context: CurrentSurfaceContext,
  label: string,
  scope: string | undefined,
  matchedEntries: SnapshotEntry[],
  kind: ScopedTargetKind,
): CommandCandidate[] {
  const candidates = new Map<string, CommandCandidate>();

  if (scope) {
    candidates.set(`${label}:${scope}`, {
      label,
      scope,
    });
  }

  for (const ambiguityCase of context.summary.ambiguityCases) {
    const matches = ambiguityCase.repeatedLabels.some((item) => item.toLowerCase() === label.toLowerCase());
    if (!matches) {
      continue;
    }

    const suggestedScopes =
      ambiguityCase.anchorScope === "post"
        ? (["post", "postActions"] as const)
        : ([ambiguityCase.anchorScope] as const);
    for (const suggestedScope of suggestedScopes) {
      candidates.set(`${label}:${suggestedScope}`, {
        label,
        scope: suggestedScope,
      });
    }
  }

  for (const entry of matchedEntries) {
    const inferredScope = inferScopeForEntry(context, entry, kind);
    candidates.set(`${entry.name}:${inferredScope ?? "page"}`, {
      label: entry.name || label,
      ...(inferredScope ? { scope: inferredScope } : {}),
    });
  }

  return [...candidates.values()];
}
