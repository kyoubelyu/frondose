import type { ScopeInspection, VisibleScopeInspection } from "../contracts/inspect.js";
import type { MinimalPublicScopeId } from "../contracts/minimalPublicContract.js";
import { activeCommentComposerRefs } from "./commentComposer.js";
import type { CurrentSurfaceContext, SnapshotEntry } from "./currentSurfaceTypes.js";
import {
  isCommentButtonEntry,
  isCommentInputEntry,
  isComposerButtonEntry,
  isComposerInputEntry,
  isMessagingConversationEntry,
  isMessagingListEntry,
  isMessagingSearchEntry,
  isPostActionEntry,
  isReactionModalEntry,
  isThreadComposerButtonEntry,
  isThreadComposerInputEntry,
} from "./foregroundContext.js";
import { activeComposerRefs, isInputEntry, uniqueOrdered } from "./visibleScopeCommon.js";

export function scopeOwnsEntry(
  context: CurrentSurfaceContext,
  scopeId: MinimalPublicScopeId,
  entry: SnapshotEntry,
): boolean {
  if (scopeId === "messagingSearch") {
    return isMessagingSearchEntry(entry);
  }

  if (scopeId === "messagingConversationList") {
    return isMessagingListEntry(entry);
  }

  if (scopeId === "messagingConversation") {
    return isMessagingConversationEntry(entry, context.pageUrl);
  }

  if (scopeId === "post" || scopeId === "postActions") {
    return isPostActionEntry(entry);
  }

  if (scopeId === "comment") {
    const commentComposerRefs = activeCommentComposerRefs(context.entries, context.pageUrl);
    if (commentComposerRefs.size > 0) {
      return commentComposerRefs.has(entry.ref);
    }

    return isCommentInputEntry(entry) || isCommentButtonEntry(entry);
  }

  if (scopeId === "reactionModal") {
    return isReactionModalEntry(entry);
  }

  if (scopeId === "composerInput") {
    const composerRefs = activeComposerRefs(context.entries);
    return composerRefs.size > 0
      ? composerRefs.has(entry.ref)
      : isComposerInputEntry(entry) || isComposerButtonEntry(entry);
  }

  if (scopeId === "threadInput") {
    return isThreadComposerInputEntry(entry) || isThreadComposerButtonEntry(entry);
  }

  return false;
}

function scopeOwnedEntries(context: CurrentSurfaceContext, scopeId: MinimalPublicScopeId): SnapshotEntry[] {
  return context.entries.filter((entry) => scopeOwnsEntry(context, scopeId, entry));
}

function scopeText(context: CurrentSurfaceContext, scopeId: MinimalPublicScopeId): string[] {
  if (scopeId === "page") {
    return context.summary.text;
  }

  if (
    scopeId === "notificationsView" ||
    scopeId === "networkView" ||
    scopeId === "searchResults" ||
    scopeId === "profileView" ||
    scopeId === "companyView" ||
    scopeId === "feed" ||
    scopeId === "reactionModal" ||
    scopeId === "composerModal" ||
    scopeId === "messagingThread"
  ) {
    return context.summary.text;
  }

  if (scopeId === "post" || scopeId === "postActions") {
    return uniqueOrdered(context.repeatedControls);
  }

  return uniqueOrdered(scopeOwnedEntries(context, scopeId).map((entry) => entry.name)).slice(0, 24);
}

function scopeButtons(context: CurrentSurfaceContext, scopeId: MinimalPublicScopeId): string[] {
  if (scopeId === "messagingSearch") {
    return [];
  }

  if (scopeId === "post" || scopeId === "postActions") {
    return uniqueOrdered(context.repeatedControls);
  }

  if (
    scopeId === "comment" ||
    scopeId === "composerInput" ||
    scopeId === "threadInput" ||
    scopeId === "messagingConversationList" ||
    scopeId === "messagingConversation"
  ) {
    return uniqueOrdered(
      scopeOwnedEntries(context, scopeId)
        .filter((entry) => !isInputEntry(entry))
        .map((entry) => entry.name),
    );
  }

  return context.summary.buttons;
}

function scopeInputsWithValues(
  context: CurrentSurfaceContext,
  scopeId: MinimalPublicScopeId,
): { inputs: string[]; inputValues: string[] } {
  if (scopeId === "messagingSearch") {
    const entries = context.entries.filter((entry) => isMessagingSearchEntry(entry));
    const seen = new Set<string>();
    const inputs: string[] = [];
    const inputValues: string[] = [];
    for (const entry of entries) {
      const name = entry.name.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      inputs.push(name);
      inputValues.push(entry.value ?? "");
    }
    return { inputs, inputValues };
  }

  if (scopeId === "messagingConversationList" || scopeId === "messagingConversation") {
    return { inputs: [], inputValues: [] };
  }

  if (scopeId === "comment" || scopeId === "threadInput" || scopeId === "composerInput") {
    const entries = scopeOwnedEntries(context, scopeId).filter((entry) => isInputEntry(entry));
    const seen = new Set<string>();
    const inputs: string[] = [];
    const inputValues: string[] = [];
    for (const entry of entries) {
      const name = entry.name.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      inputs.push(name);
      inputValues.push(entry.value ?? "");
    }
    return { inputs, inputValues };
  }

  if (scopeId === "post" || scopeId === "postActions") {
    return { inputs: [], inputValues: [] };
  }

  return { inputs: context.summary.inputs, inputValues: context.summary.inputValues ?? [] };
}

export function buildScopeInspection(context: CurrentSurfaceContext, scopeId: MinimalPublicScopeId): ScopeInspection {
  const scope = context.summary.availableScopes.find((candidate) => candidate.id === scopeId);
  if (!scope) {
    throw new Error(`Scope "${scopeId}" is not available on the current LinkedIn surface.`);
  }

  const interactiveRegions = context.summary.interactiveRegions.filter((region) => region.scope === scopeId);
  const ambiguityCases = context.summary.ambiguityCases.filter(
    (item) => item.anchorScope === scopeId || scopeId === "page",
  );
  const { inputs, inputValues } = scopeInputsWithValues(context, scopeId);

  return {
    scope,
    text: scopeText(context, scopeId),
    buttons: scopeButtons(context, scopeId),
    inputs,
    inputValues,
    interactiveRegions,
    ambiguityCases,
  };
}

export function buildVisibleScopeInspection(context: CurrentSurfaceContext, handle: string): VisibleScopeInspection {
  const visibleScope = context.visibleScopeInspections?.find((inspection) => inspection.scope.handle === handle);
  if (!visibleScope) {
    throw new Error(`Visible scope "${handle}" is not available on the current LinkedIn surface.`);
  }

  return visibleScope;
}
