import type { AmbiguityCase, InteractiveRegion } from "../contracts/inspect.js";
import type { MinimalPublicScopeId } from "../contracts/minimalPublicContract.js";
import { ACTION_NAME_TOKENS } from "../actionClassifier.js";
import { collectActiveCommentComposerEntries } from "./commentComposer.js";
import type { SnapshotEntry } from "./currentSurfaceTypes.js";
import {
  hasProfileConnectPromptOverlay,
  isActorSelectionModalEntry,
  isCommentButtonEntry,
  isCommentInputEntry,
  isMessagingConversationEntry,
  isMessagingListEntry,
  isMessagingSearchEntry,
  isProfileConnectPromptEntry,
  isThreadComposerButtonEntry,
  isThreadComposerInputEntry,
  type FeedSignals,
  type ForegroundContext,
  type MessagingSignals,
} from "./foregroundContext.js";
import { activeComposerEntriesWithEmoji, hasPostingComposer, uniqueOrdered } from "./visibleScopeCommon.js";

export interface CurrentSurfaceRegionParts {
  ambiguityCases: AmbiguityCase[];
  interactiveRegions: InteractiveRegion[];
}

function buildInteractiveRegionsForForegroundContext(
  foregroundContext: ForegroundContext,
  repeatedControls: string[],
  inputs: string[],
  entries: SnapshotEntry[],
  pageUrl: string,
  availableScopeIds: readonly MinimalPublicScopeId[],
  messagingSignals?: MessagingSignals,
  feedSignals?: FeedSignals,
): InteractiveRegion[] {
  const regions: InteractiveRegion[] = [];

  if (foregroundContext.kind === "page" && foregroundContext.routeBucket === "feed") {
    regions.push({
      id: "feed-region",
      label: "Feed",
      scope: "feed",
      controls: [],
    });

    if (repeatedControls.length > 0) {
      regions.push({
        id: "post-actions",
        label: "Post actions",
        scope: "post",
        controls: repeatedControls,
      });
      regions.push({
        id: "post-actions-local",
        label: "Post actions",
        scope: "postActions",
        controls: repeatedControls,
      });
    }

    if (feedSignals?.hasCommentComposer) {
      const activeCommentComposerEntries = collectActiveCommentComposerEntries(entries, pageUrl);
      regions.push({
        id: "comment-composer",
        label: "Comment",
        scope: "comment",
        controls: uniqueOrdered(
          (activeCommentComposerEntries.length > 0 ? activeCommentComposerEntries : entries)
            .filter(
              (entry) =>
                activeCommentComposerEntries.length > 0 || isCommentInputEntry(entry) || isCommentButtonEntry(entry),
            )
            .map((entry) => entry.name),
        ),
      });
    }
  }

  if (foregroundContext.kind === "modal") {
    if (foregroundContext.legacySurface === "composer-modal") {
      const composerEntries = activeComposerEntriesWithEmoji(entries);
      regions.push({
        id: "composer-modal",
        label: "Composer modal",
        scope: "composerModal",
        controls: [],
      });

      if (composerEntries.length > 0 && inputs.length > 0) {
        regions.push({
          id: "composer-input",
          label: "Composer input",
          scope: "composerInput",
          controls: uniqueOrdered(composerEntries.map((entry) => entry.name)),
        });
      }
    }

    if (foregroundContext.legacySurface === "composer-draft-confirmation") {
      const confirmationEntries = entries.filter((entry) => /^(discard|save as draft)$/i.test(entry.name));
      if (confirmationEntries.length > 0) {
        regions.push({
          id: "composer-modal",
          label: "Composer modal",
          scope: "composerModal",
          controls: uniqueOrdered(confirmationEntries.map((entry) => entry.name)),
        });
      }
    }

    if (
      foregroundContext.legacySurface === "composer-audience-modal" ||
      foregroundContext.legacySurface === "composer-schedule-modal" ||
      foregroundContext.legacySurface === "composer-media-modal"
    ) {
      regions.push({
        id: "composer-modal",
        label: "Composer modal",
        scope: "composerModal",
        controls: uniqueOrdered(entries.map((entry) => entry.name).filter(Boolean)),
      });
    }

    if (foregroundContext.legacySurface === "reaction-modal") {
      regions.push({
        id: "reaction-modal",
        label: "Reaction modal",
        scope: "reactionModal",
        controls: uniqueOrdered(entries.map((entry) => entry.name).filter(Boolean)),
      });
    }

    if (foregroundContext.legacySurface === "actor-selection-modal") {
      regions.push({
        id: "actor-selection-modal",
        label: "Actor selection",
        scope: "feed",
        controls: uniqueOrdered(
          entries.filter((entry) => isActorSelectionModalEntry(entry)).map((entry) => entry.name),
        ),
      });
    }
  }

  if (foregroundContext.kind === "thread" && foregroundContext.routeBucket === "messaging") {
    regions.push({
      id: "messaging-thread",
      label: "Messaging view",
      scope: "messagingThread",
      controls: [],
    });

    if (messagingSignals?.hasSearch) {
      regions.push({
        id: "message-search",
        label: "Message search",
        scope: "messagingSearch",
        controls: uniqueOrdered(entries.filter((entry) => isMessagingSearchEntry(entry)).map((entry) => entry.name)),
      });
    }

    if (messagingSignals?.hasConversationList) {
      regions.push({
        id: "conversation-list",
        label: "Conversation list",
        scope: "messagingConversationList",
        controls: uniqueOrdered(entries.filter((entry) => isMessagingListEntry(entry)).map((entry) => entry.name)),
      });
    }

    if (messagingSignals?.hasActiveConversation) {
      regions.push({
        id: "active-conversation",
        label: "Active conversation",
        scope: "messagingConversation",
        controls: uniqueOrdered(
          entries.filter((entry) => isMessagingConversationEntry(entry, pageUrl)).map((entry) => entry.name),
        ),
      });
    }

    if (messagingSignals?.hasThreadComposer) {
      regions.push({
        id: "thread-composer",
        label: "Thread composer",
        scope: "threadInput",
        controls: uniqueOrdered(
          entries
            .filter((entry) => isThreadComposerInputEntry(entry) || isThreadComposerButtonEntry(entry))
            .map((entry) => entry.name),
        ),
      });
    }
  }

  if (foregroundContext.routeBucket === "notifications") {
    regions.push({
      id: "notifications-view",
      label: "Notifications view",
      scope: "notificationsView",
      controls: [],
    });
  }

  if (foregroundContext.routeBucket === "network") {
    regions.push({
      id: "network-view",
      label: "Network view",
      scope: "networkView",
      controls: [],
    });
  }

  if (foregroundContext.routeBucket === "search") {
    regions.push({
      id: "search-results",
      label: "Search results",
      scope: "searchResults",
      controls: [],
    });
  }

  if (foregroundContext.routeBucket === "profile") {
    regions.push({
      id: "profile-view",
      label: "Profile view",
      scope: "profileView",
      controls: [],
    });

    if (
      foregroundContext.kind === "local-overlay" &&
      hasProfileConnectPromptOverlay(pageUrl, foregroundContext.legacySurface, entries)
    ) {
      regions.push({
        id: "profile-connect-prompt",
        label: "Connect prompt",
        scope: "profileView",
        controls: uniqueOrdered(
          entries.filter((entry) => isProfileConnectPromptEntry(entry)).map((entry) => entry.name),
        ),
      });
    }
  }

  if (foregroundContext.routeBucket === "company") {
    regions.push({
      id: "company-view",
      label: "Company view",
      scope: "companyView",
      controls: [],
    });

    const companyComposerEntries = activeComposerEntriesWithEmoji(entries);
    if (hasPostingComposer(entries) && companyComposerEntries.length > 0) {
      regions.push({
        id: "company-composer",
        label: "Composer modal",
        scope: "composerModal",
        controls: uniqueOrdered(companyComposerEntries.map((entry) => entry.name)),
      });
      regions.push({
        id: "company-composer-input",
        label: "Composer input",
        scope: "composerInput",
        controls: uniqueOrdered(companyComposerEntries.map((entry) => entry.name)),
      });
    }
  }

  if (foregroundContext.routeBucket === "companyInbox") {
    regions.push({
      id: "company-view",
      label: "Company view",
      scope: "companyView",
      controls: [],
    });
    regions.push({
      id: "company-inbox-thread",
      label: "Company inbox thread",
      scope: "companyInboxThread",
      controls: [],
    });
  }

  const availableScopeSet = new Set(availableScopeIds);
  return regions.filter((region) => availableScopeSet.has(region.scope));
}

function buildAmbiguityCasesForForegroundContext(
  foregroundContext: ForegroundContext,
  repeatedControls: string[],
): AmbiguityCase[] {
  const ambiguityCases: AmbiguityCase[] = [];

  if (foregroundContext.kind === "page" && foregroundContext.routeBucket === "feed" && repeatedControls.length > 0) {
    ambiguityCases.push({
      label: "AMB-POST-ACTIONS",
      anchorScope: "post",
      repeatedLabels: repeatedControls,
    });
  }

  if (foregroundContext.kind === "modal" && foregroundContext.legacySurface === "composer-modal") {
    ambiguityCases.push({
      label: "LAYER-COMPOSER",
      anchorScope: "composerModal",
      repeatedLabels: ACTION_NAME_TOKENS.post.slice(),
    });
  }

  return ambiguityCases;
}

export function buildCurrentSurfaceRegionParts(
  foregroundContext: ForegroundContext,
  repeatedControls: string[],
  inputs: string[],
  entries: SnapshotEntry[],
  pageUrl: string,
  availableScopeIds: readonly MinimalPublicScopeId[],
  messagingSignals?: MessagingSignals,
  feedSignals?: FeedSignals,
): CurrentSurfaceRegionParts {
  return {
    ambiguityCases: buildAmbiguityCasesForForegroundContext(foregroundContext, repeatedControls),
    interactiveRegions: buildInteractiveRegionsForForegroundContext(
      foregroundContext,
      repeatedControls,
      inputs,
      entries,
      pageUrl,
      availableScopeIds,
      messagingSignals,
      feedSignals,
    ),
  };
}
