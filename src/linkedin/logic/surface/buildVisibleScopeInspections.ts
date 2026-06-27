import type { CdpClient } from "../../../cdp/client.js";
import type { VisibleScopeSummary } from "../contracts/inspect.js";
import type { RuntimeVisibleScopeInspection } from "./currentSurfaceTypes.js";
import {
  createForegroundContextFromSurface,
  hasArticleManageSurfaceSignals,
  hasProfileConnectPromptOverlay,
  hasProfileMessageOverlayThread,
  hasArticleEditorSurfaceSignals,
  isArticleManageDraftEntry,
  isArticleManageTabEntry,
  isActorSelectionModalEntry,
  isArticleEditorButtonEntry,
  isArticleEditorInputEntry,
  isComposerAudienceModalEntry,
  isComposerInputEntry,
  isComposerMediaModalEntry,
  isProfileArticleFilterEntry,
  isProfileConnectPromptEntry,
  isComposerScheduleModalEntry,
  isMessagingConversationEntry,
  isMessagingListEntry,
  isMessagingSearchEntry,
  isReactionModalEntry,
  isThreadComposerButtonEntry,
  isThreadComposerInputEntry,
} from "./foregroundContext.js";
import { extractMediaEditorThumbnailInputEntry, mergeMediaEditorThumbnailInputEntry } from "./mediaEditorThumbnail.js";
import type { SnapshotEntry } from "./currentSurfaceTypes.js";
import { extractCompanyCommentThreadDomText } from "./collections/commentThreads.js";
import { buildActivityCommentsScopeControls, extractActivityCommentsDomText } from "./collections/activityComments.js";
import {
  buildAnchorBackedPostVisibleScopeInspections,
  collectAnchorBackedPostVisibleScopeSegments,
  extractPostDomPreviews,
} from "./collections/posts.js";
import { extractCompanyInboxThread, formatCompanyInboxMessage } from "./collections/companyInbox.js";
import {
  extractMessagingConversationMessages,
  formatPersonalMessagingMessage,
} from "./collections/messagingConversation.js";
import { buildConnectablePersonVisibleScopeInspections } from "./collections/connectablePeople.js";
import {
  activeComposerEntriesWithEmoji,
  buttonsFromEntries,
  createVisibleScopeFromEntries,
  createVisibleScopeInspection,
  inputsFromEntries,
  previewTextFromEntries,
  toVisibleScopeControls,
  uniqueEntriesByRoleAndName,
  dedupeEntriesByRoleAndName,
} from "./visibleScopeCommon.js";
import { collectActiveCommentComposerEntries } from "./commentComposer.js";
import {
  buildTrustedHeaderActionsContentVisibleScopeInspections,
  buildTrustedSingleContentPageVisibleScopeInspections,
  collectLeadingTopNavEntries,
  splitTrustedHeaderActionsContentEntries,
  TRUSTED_HEADER_ACTIONS_CONTENT_PAGE_SPECS,
  TRUSTED_SINGLE_CONTENT_PAGE_SPECS,
} from "./visibleScopeTrusted.js";
import {
  collectAboutSectionEntries,
  collectProfileEditIntroFormEntries,
  isMainProfileUrl,
  isProfileEditIntroUrl,
} from "./profileEditScopes.js";
import {
  buildCompanyCommentThreadScopeControls,
  collectCompanyActivityCommentEntries,
  collectCompanyCommentThreadEntries,
  collectCompanyReplyThreadEntries,
  resolveCompanyCommentThreadPreviewText,
} from "./companyCommentHelpers.js";

// Phase 83 OQ-83.A Option C — `isFeedComposerEntry` deleted; the regex
// is inlined at all 3 former call sites (composer scan + ahead-only loop
// in the feed branch below; thread-content composer-anchor in
// companyCommentHelpers.ts). Cluster L66-222 of the pre-83.1 file moved
// to ./companyCommentHelpers.ts (closes AG-28).


export async function buildVisibleScopeInspections(
  client: CdpClient,
  surface: string,
  entries: SnapshotEntry[],
  pageUrl: string,
  sourceEntries: SnapshotEntry[] = entries,
): Promise<RuntimeVisibleScopeInspection[]> {
  const foregroundContext = createForegroundContextFromSurface(surface, pageUrl, sourceEntries);
  const topNavEntries = collectLeadingTopNavEntries(entries);

  if (foregroundContext.kind === "page" && foregroundContext.routeBucket === "feed") {
    const inspections: RuntimeVisibleScopeInspection[] = [];

    if (topNavEntries.length > 0) {
      inspections.push(createVisibleScopeFromEntries("topNav", "topNav", "Top navigation", "page", topNavEntries));
    }

    // Phase 83 OQ-83.A Option C — inline regex (former isFeedComposerEntry).
    const composerIndex = entries.findIndex((entry) =>
      /^(start a post|video|photo|write article)$/i.test(entry.name),
    );
    const lastTopNavRefFeed = topNavEntries.at(-1)?.ref;
    const topNavEndIndex =
      lastTopNavRefFeed !== undefined ? entries.findIndex((entry) => entry.ref === lastTopNavRefFeed) : -1;

    const leftRailEntries = composerIndex > topNavEndIndex + 1 ? entries.slice(topNavEndIndex + 1, composerIndex) : [];
    if (leftRailEntries.length > 0) {
      inspections.push(createVisibleScopeFromEntries("leftRail", "leftRail", "Left rail", "feed", leftRailEntries));
    }

    const composerEntries: SnapshotEntry[] = [];
    if (composerIndex >= 0) {
      for (let index = composerIndex; index < entries.length; index += 1) {
        const entry = entries[index];
        if (!entry || !/^(start a post|video|photo|write article)$/i.test(entry.name)) {
          if (composerEntries.length > 0) {
            break;
          }
          continue;
        }

        composerEntries.push(entry);
      }
    }

    if (composerEntries.length > 0) {
      inspections.push(createVisibleScopeFromEntries("composer", "composer", "Composer", "feed", composerEntries));
    }

    const lastComposerRef = composerEntries.at(-1)?.ref;
    const composerEndIndex =
      lastComposerRef !== undefined ? entries.findIndex((entry) => entry.ref === lastComposerRef) : topNavEndIndex;
    const domPreviews = await extractPostDomPreviews(client, "feed");
    const postEntries = composerEndIndex >= 0 ? entries.slice(composerEndIndex + 1) : entries;
    const domPreviewMap = new Map(domPreviews.map((preview) => [preview.menuLabel, preview.text]));
    const activeCommentComposerEntries = collectActiveCommentComposerEntries(entries, pageUrl);
    const postSegments = collectAnchorBackedPostVisibleScopeSegments(postEntries, {
      maxVisiblePostCount: 3,
      orderedDomPreviews: domPreviews,
      previewTextByAnchorLabel: domPreviewMap,
    });
    inspections.push(
        ...buildAnchorBackedPostVisibleScopeInspections(postEntries, "feed", {
        maxVisiblePostCount: 3,
        orderedDomPreviews: domPreviews,
        previewTextByAnchorLabel: domPreviewMap,
        activeCommentComposerEntries,
      }),
    );

    const companyCommentThreadEntries = collectCompanyCommentThreadEntries(entries, pageUrl);
    if (companyCommentThreadEntries.length > 0) {
      const domThreadText = await extractCompanyCommentThreadDomText(client, pageUrl);
      const companyCommentThreadPreviewText = resolveCompanyCommentThreadPreviewText(
        companyCommentThreadEntries,
        postSegments,
        domThreadText,
      );
      // Phase 87.2 — filter-first prebuiltControls so all comment action buttons
      // survive the 24-cap on threads with 5+ comments (OQ-87.A Option A).
      const prebuiltControls = buildCompanyCommentThreadScopeControls(
        "companyCommentThread",
        companyCommentThreadEntries,
      );
      inspections.push(
        createVisibleScopeFromEntries(
          "companyCommentThread",
          "companyCommentThread",
          "Company comment thread",
          "feed",
          companyCommentThreadEntries,
          companyCommentThreadPreviewText,
          { prebuiltControls },
        ),
      );
    }

    const commentReplyEntries = collectCompanyReplyThreadEntries(entries, pageUrl);
    if (commentReplyEntries.length > 0) {
      inspections.push(
        createVisibleScopeFromEntries("commentReply", "post", "Comment reply", "feed", commentReplyEntries),
      );
    }

    return inspections;
  }

  if (foregroundContext.kind === "page" && foregroundContext.legacySurface === "profile-articles") {
    const inspections: RuntimeVisibleScopeInspection[] = [];

    if (topNavEntries.length > 0) {
      inspections.push(createVisibleScopeFromEntries("topNav", "topNav", "Top navigation", "page", topNavEntries));
    }

    const filterEntries = uniqueEntriesByRoleAndName(entries.filter((entry) => isProfileArticleFilterEntry(entry)));
    const lastTopNavRefArticles = topNavEntries.at(-1)?.ref;
    const lastTopNavIndex =
      lastTopNavRefArticles !== undefined ? entries.findIndex((entry) => entry.ref === lastTopNavRefArticles) : -1;
    const lastFilterIndex =
      filterEntries.length > 0
        ? Math.max(...filterEntries.map((entry) => entries.findIndex((candidate) => candidate.ref === entry.ref)))
        : -1;

    if (lastFilterIndex > lastTopNavIndex) {
      const headerEntries = dedupeEntriesByRoleAndName(entries.slice(lastTopNavIndex + 1, lastFilterIndex + 1));
      if (headerEntries.length > 0) {
        inspections.push(
          createVisibleScopeFromEntries("header", "profileHeader", "Profile header", "profileView", headerEntries),
        );
      }
    }

    if (filterEntries.length > 0) {
      inspections.push(
        createVisibleScopeFromEntries(
          "articleFilters",
          "profileActions",
          "Article filters",
          "profileView",
          filterEntries,
        ),
      );
    }

    if (lastFilterIndex >= 0 && lastFilterIndex + 1 < entries.length) {
      const contentEntries = dedupeEntriesByRoleAndName(entries.slice(lastFilterIndex + 1));
      if (contentEntries.length > 0) {
        inspections.push(
          createVisibleScopeFromEntries("content", "profileContent", "Profile content", "profileView", contentEntries),
        );
      }
    }

    return inspections;
  }

  if (
    foregroundContext.kind === "page" &&
    foregroundContext.routeBucket === "articles" &&
    foregroundContext.legacySurface === "article-manage" &&
    hasArticleManageSurfaceSignals(entries, pageUrl)
  ) {
    const inspections: RuntimeVisibleScopeInspection[] = [];

    if (topNavEntries.length > 0) {
      inspections.push(createVisibleScopeFromEntries("topNav", "topNav", "Top navigation", "page", topNavEntries));
    }

    const tabEntries = uniqueEntriesByRoleAndName(entries.filter((entry) => isArticleManageTabEntry(entry)));
    const manageShellEntries = uniqueEntriesByRoleAndName(entries.filter((entry) => isArticleManageDraftEntry(entry)));

    const tabAndShellEntries = uniqueEntriesByRoleAndName([
      ...tabEntries,
      ...manageShellEntries.filter((entry) => /^(dismiss|close)$/i.test(entry.name)),
    ]);
    if (tabAndShellEntries.length > 0) {
      inspections.push(
        createVisibleScopeFromEntries(
          "articleManageTabs",
          "profileActions",
          "Article manage tabs",
          "page",
          tabAndShellEntries,
        ),
      );
    }

    const draftEntries = uniqueEntriesByRoleAndName(
      manageShellEntries.filter((entry) => !/^(dismiss|close)$/i.test(entry.name)),
    );
    if (draftEntries.length > 0) {
      inspections.push(
        createVisibleScopeFromEntries("articleDrafts", "profileContent", "Article drafts", "page", draftEntries),
      );
    }

    return inspections;
  }

  if (
    foregroundContext.kind === "page" &&
    foregroundContext.routeBucket === "articles" &&
    foregroundContext.legacySurface === "article-editor" &&
    hasArticleEditorSurfaceSignals(entries, pageUrl)
  ) {
    const inspections: RuntimeVisibleScopeInspection[] = [];

    if (topNavEntries.length > 0) {
      inspections.push(createVisibleScopeFromEntries("topNav", "topNav", "Top navigation", "page", topNavEntries));
    }

    const articleHeaderEntries = uniqueEntriesByRoleAndName(
      entries.filter(
        (entry) =>
          (entry.role === "button" &&
            /(individual article|style|manage menu|next|duplicate as draft|settings|drafts|scheduled|published|new draft|create newsletter|help|give feedback)/i.test(
              entry.name,
            )) ||
          (entry.role === "link" && /^preview$/i.test(entry.name)),
      ),
    );
    if (articleHeaderEntries.length > 0) {
      inspections.push(
        createVisibleScopeFromEntries("articleHeader", "profileHeader", "Article header", "page", articleHeaderEntries),
      );
    }

    const articleEditorEntries = uniqueEntriesByRoleAndName(
      entries.filter((entry) => isArticleEditorInputEntry(entry) || isArticleEditorButtonEntry(entry)),
    );
    if (articleEditorEntries.length > 0) {
      inspections.push(
        createVisibleScopeFromEntries(
          "articleEditor",
          "profileContent",
          "Article editor",
          "page",
          articleEditorEntries,
        ),
      );
    }

    const articleEditorInputEntries = uniqueEntriesByRoleAndName(
      entries.filter((entry) => isArticleEditorInputEntry(entry)),
    );
    if (articleEditorInputEntries.length > 0) {
      inspections.push(
        createVisibleScopeFromEntries(
          "articleEditorInput",
          "profileContent",
          "Article editor input",
          "page",
          articleEditorInputEntries,
        ),
      );
    }

    return inspections;
  }

  if (foregroundContext.kind === "thread" && foregroundContext.routeBucket === "messaging") {
    const inspections: RuntimeVisibleScopeInspection[] = [];

    if (topNavEntries.length > 0) {
      inspections.push(createVisibleScopeFromEntries("topNav", "topNav", "Top navigation", "page", topNavEntries));
    }

    const searchEntries = entries.filter((entry) => isMessagingSearchEntry(entry));
    if (searchEntries.length > 0) {
      inspections.push(
        createVisibleScopeFromEntries(
          "messagingSearch",
          "messagingSearch",
          "Message search",
          "messagingThread",
          searchEntries,
        ),
      );
    }

    const conversationListEntries = uniqueEntriesByRoleAndName(entries.filter((entry) => isMessagingListEntry(entry)));
    if (conversationListEntries.length > 0) {
      inspections.push(
        createVisibleScopeFromEntries(
          "conversationList",
          "messagingConversationList",
          "Conversation list",
          "messagingThread",
          conversationListEntries,
        ),
      );
    }

    const conversationEntries = entries.filter((entry) => isMessagingConversationEntry(entry, pageUrl));
    // Phase 85.3 — enrich previewText with formatted message bubbles
    // (per OQ-85.B option (a): no new scope id; existing
    // messagingConversation surfaces both ARIA controls AND content).
    // Per NIT-2, the messages array REPLACES the default
    // previewTextFromEntries(entries) (which would otherwise yield button
    // label fragments like "Star conversation") rather than augmenting it.
    // WARN-2 robustness: gate on `conversationEntries.length > 0 ||
    // messages.length > 0` so the scope still surfaces when ARIA controls
    // are absent but message content is present.
    const conversationMessages = await extractMessagingConversationMessages(client);
    if (conversationEntries.length > 0 || conversationMessages.length > 0) {
      const conversationPreviewLines = conversationMessages.map(formatPersonalMessagingMessage);
      inspections.push(
        createVisibleScopeFromEntries(
          "conversation",
          "messagingConversation",
          "Active conversation",
          "messagingThread",
          conversationEntries,
          conversationPreviewLines,
        ),
      );
    }

    const threadInputEntries = entries.filter(
      (entry) => isThreadComposerInputEntry(entry) || isThreadComposerButtonEntry(entry),
    );
    if (threadInputEntries.length > 0) {
      inspections.push(
        createVisibleScopeFromEntries(
          "threadInput",
          "threadInput",
          "Thread input",
          "messagingThread",
          threadInputEntries,
        ),
      );
    }

    return inspections;
  }

  if (foregroundContext.kind === "page" && foregroundContext.routeBucket === "search") {
    const inspections = buildTrustedSingleContentPageVisibleScopeInspections(
      entries,
      topNavEntries,
      TRUSTED_SINGLE_CONTENT_PAGE_SPECS.search,
    );
    inspections.push(
      ...(await buildConnectablePersonVisibleScopeInspections(client, entries, "searchResults", "searchResults")),
    );

    // Phase 79 — search→content surface emits `kind: "post"` scopes for
    // each post in the search results. Reuses the feed builder; the eval
    // produces the same previewText contract as feed (see
    // collections/posts.ts:extractSearchPostDomPreviews) so
    // feedPostResolver.ts works unchanged on these scopes.
    const searchPostDomPreviews = await extractPostDomPreviews(client, "search");
    if (searchPostDomPreviews.length > 0) {
      const searchPostDomPreviewMap = new Map(
        searchPostDomPreviews.map((preview) => [preview.menuLabel, preview.text]),
      );
      inspections.push(
        ...buildAnchorBackedPostVisibleScopeInspections(entries, "searchResults", {
          maxVisiblePostCount: 3,
          orderedDomPreviews: searchPostDomPreviews,
          previewTextByAnchorLabel: searchPostDomPreviewMap,
        }),
      );
    }
    return inspections;
  }

  if (foregroundContext.kind === "page" && foregroundContext.routeBucket === "network") {
    const inspections = buildTrustedSingleContentPageVisibleScopeInspections(
      entries,
      topNavEntries,
      TRUSTED_SINGLE_CONTENT_PAGE_SPECS.network,
    );
    inspections.push(...(await buildConnectablePersonVisibleScopeInspections(client, entries, "networkView", "networkView")));
    return inspections;
  }

  if (foregroundContext.kind === "page" && foregroundContext.routeBucket === "notifications") {
    const inspections = buildTrustedSingleContentPageVisibleScopeInspections(
      entries,
      topNavEntries,
      TRUSTED_SINGLE_CONTENT_PAGE_SPECS.notifications,
    );
    const activityCommentEntries = collectCompanyActivityCommentEntries(entries, pageUrl);
    if (activityCommentEntries.length > 0) {
      // Phase 73 (#49) — DOM-side enrichment for previewText/text (Gap #1
      // + Gap #2). On DOM failure, fall back to entry-name-derived
      // previewText so the scope still emits with the legacy content.
      const domText = await extractActivityCommentsDomText(client, pageUrl);
      const text = domText.length > 0 ? domText : previewTextFromEntries(activityCommentEntries);
      // Phase 73 (#49) — filter-first controls so all `Respond to X` and
      // `X commented on your company's update` anchors survive the 24-cap
      // even on rich pages with 11+ commenter pairs (Gap #4).
      const prebuiltControls = buildActivityCommentsScopeControls("activityComments", activityCommentEntries);
      inspections.push(
        createVisibleScopeFromEntries(
          "activityComments",
          "notifications",
          "Activity comments",
          "notificationsView",
          activityCommentEntries,
          text,
          { prebuiltControls },
        ),
      );
    }
    return inspections;
  }

  if (foregroundContext.kind === "modal" && foregroundContext.legacySurface === "composer-modal") {
    const composerEntries = activeComposerEntriesWithEmoji(entries);
    if (composerEntries.length === 0) {
      return [];
    }

    const anchor = composerEntries.find((entry) => isComposerInputEntry(entry)) ?? composerEntries[0];
    const summary: VisibleScopeSummary = {
      handle: "composer",
      kind: "composer",
      label: "Composer",
      parent: "composerModal",
      anchorRef: anchor?.ref,
      previewText: previewTextFromEntries(composerEntries),
      buttons: buttonsFromEntries(composerEntries),
      inputs: inputsFromEntries(composerEntries),
      controls: toVisibleScopeControls("composer", composerEntries),
    };

    return [createVisibleScopeInspection(summary, previewTextFromEntries(composerEntries), composerEntries)];
  }

  if (foregroundContext.kind === "modal" && foregroundContext.legacySurface === "composer-draft-confirmation") {
    const modalEntries = entries.filter((entry) => /^(discard|save as draft)$/i.test(entry.name));
    if (modalEntries.length === 0) {
      return [];
    }

    return [
      createVisibleScopeFromEntries(
        "composerDraftConfirmation",
        "composer",
        "Draft confirmation",
        "composerModal",
        modalEntries,
      ),
    ];
  }

  if (foregroundContext.kind === "modal" && foregroundContext.legacySurface === "composer-audience-modal") {
    const modalEntries = entries.filter((entry) => isComposerAudienceModalEntry(entry));
    if (modalEntries.length === 0) {
      return [];
    }

    return [
      createVisibleScopeFromEntries("modal", "composerAudience", "Audience modal", "composerModal", modalEntries),
    ];
  }

  if (foregroundContext.kind === "modal" && foregroundContext.legacySurface === "composer-media-modal") {
    const thumbnailInput = await extractMediaEditorThumbnailInputEntry(client, entries);
    const modalEntries = mergeMediaEditorThumbnailInputEntry(
      entries.filter((entry) => isComposerMediaModalEntry(entry)),
      thumbnailInput,
    );
    if (modalEntries.length === 0) {
      return [];
    }

    return [createVisibleScopeFromEntries("modal", "composerMedia", "Media modal", "composerModal", modalEntries)];
  }

  if (foregroundContext.kind === "modal" && foregroundContext.legacySurface === "composer-schedule-modal") {
    const modalEntries = entries.filter((entry) => isComposerScheduleModalEntry(entry));
    if (modalEntries.length === 0) {
      return [];
    }

    return [
      createVisibleScopeFromEntries("modal", "composerSchedule", "Schedule modal", "composerModal", modalEntries),
    ];
  }

  if (foregroundContext.kind === "modal" && foregroundContext.legacySurface === "reaction-modal") {
    const modalEntries = entries.filter((entry) => isReactionModalEntry(entry));
    if (modalEntries.length === 0) {
      return [];
    }

    return [createVisibleScopeFromEntries("modal", "reactionModal", "Reaction modal", "reactionModal", modalEntries)];
  }

  if (foregroundContext.kind === "modal" && foregroundContext.legacySurface === "actor-selection-modal") {
    const modalEntries = entries.filter((entry) => isActorSelectionModalEntry(entry));
    if (modalEntries.length === 0) {
      return [];
    }

    return [createVisibleScopeFromEntries("actorSelection", "actorSelection", "Actor selection", "feed", modalEntries)];
  }

  // Phase 85.2 — company admin inbox (`/company/<id>/admin/inbox/...`).
  // Dedicated branch BEFORE the shared profile/company dispatch below
  // because companyInbox routebucket is distinct from "company" (R-9
  // load-bearing order-of-detection in inferRouteBucket).
  if (foregroundContext.kind === "page" && foregroundContext.routeBucket === "companyInbox") {
    const inspections: RuntimeVisibleScopeInspection[] = [];
    if (topNavEntries.length > 0) {
      inspections.push(createVisibleScopeFromEntries("topNav", "topNav", "Top navigation", "page", topNavEntries));
    }
    // companyView scope-id is exposed via scopeIdsForForegroundContext;
    // no dedicated visible-scope inspection needed (parallels the feed
    // / messaging dispatch where parent scopes appear in availableScopeIds
    // without separate inspections).
    const messages = await extractCompanyInboxThread(client);
    if (messages.length > 0) {
      const previewLines = messages.map(formatCompanyInboxMessage);
      inspections.push(
        createVisibleScopeFromEntries(
          "companyInboxThread",
          "companyInboxThread",
          "Company inbox thread",
          "companyView",
          [],
          previewLines,
        ),
      );
    }
    return inspections;
  }

  if (
    (foregroundContext.kind === "page" || foregroundContext.kind === "local-overlay") &&
    (foregroundContext.routeBucket === "profile" || foregroundContext.routeBucket === "company")
  ) {
    const profileSurface = foregroundContext.routeBucket === "profile" ? "profile" : "company";
    const pageSpec = TRUSTED_HEADER_ACTIONS_CONTENT_PAGE_SPECS[profileSurface];
    const pageSegments = splitTrustedHeaderActionsContentEntries(entries, topNavEntries, pageSpec);
    const inspections = buildTrustedHeaderActionsContentVisibleScopeInspections(entries, topNavEntries, pageSpec);

    if (profileSurface === "company" && foregroundContext.kind === "page") {
      const domPreviews = await extractPostDomPreviews(client, "feed");
      const domPreviewMap = new Map(domPreviews.map((preview) => [preview.menuLabel, preview.text]));
      inspections.push(
        ...buildAnchorBackedPostVisibleScopeInspections(pageSegments.contentEntries, "companyView", {
          maxVisiblePostCount: 3,
          orderedDomPreviews: domPreviews,
          previewTextByAnchorLabel: domPreviewMap,
        }),
      );
    }

    // Phase 70.1 (#37) — `/in/<slug>/edit/intro/` form scope. Coexists with
    // the standard header/actions/content split from above (additive). Only
    // emitted when URL matches; on other profile pages the scope is absent.
    if (profileSurface === "profile" && foregroundContext.kind === "page" && isProfileEditIntroUrl(pageUrl)) {
      const introFormEntries = collectProfileEditIntroFormEntries(entries, topNavEntries);
      if (introFormEntries.length > 0) {
        inspections.push(
          createVisibleScopeFromEntries(
            "intro",
            "profileEditIntro",
            "Edit intro form",
            "profileView",
            introFormEntries,
          ),
        );
      }
    }

    // Phase 70.3 (#39 partial) — About card on the main `/in/<slug>/` page.
    // Bypasses the content scope's 24-control activity-feed cap by living
    // in its own scope. NOT emitted on `/details/...` or `/edit/...`.
    if (profileSurface === "profile" && foregroundContext.kind === "page" && isMainProfileUrl(pageUrl)) {
      const aboutEntries = collectAboutSectionEntries(entries);
      if (aboutEntries.length > 0) {
        inspections.push(
          createVisibleScopeFromEntries("about", "profileAbout", "About section", "profileView", aboutEntries),
        );
      }
    }

    if (
      profileSurface === "profile" &&
      foregroundContext.kind === "local-overlay" &&
      hasProfileConnectPromptOverlay(pageUrl, profileSurface, sourceEntries)
    ) {
      const connectPromptEntries = dedupeEntriesByRoleAndName(
        sourceEntries.filter((entry) => isProfileConnectPromptEntry(entry)),
      );
      if (connectPromptEntries.length > 0) {
        inspections.push(
          createVisibleScopeFromEntries(
            "connectPrompt",
            "profileActions",
            "Connect prompt",
            "profileView",
            connectPromptEntries,
          ),
        );
      }
    }

    if (
      profileSurface === "profile" &&
      foregroundContext.kind === "local-overlay" &&
      hasProfileMessageOverlayThread(pageUrl, profileSurface, sourceEntries)
    ) {
      const conversationEntries = sourceEntries.filter((entry) => isMessagingConversationEntry(entry, pageUrl));
      if (conversationEntries.length > 0) {
        inspections.push(
          createVisibleScopeFromEntries(
            "messageOverlayConversation",
            "messagingConversation",
            "Active conversation",
            "profileView",
            conversationEntries,
          ),
        );
      }

      const threadInputEntries = sourceEntries.filter(
        (entry) => isThreadComposerInputEntry(entry) || isThreadComposerButtonEntry(entry),
      );
      if (threadInputEntries.length > 0) {
        inspections.push(
          createVisibleScopeFromEntries(
            "messageOverlayThreadInput",
            "threadInput",
            "Thread input",
            "profileView",
            threadInputEntries,
          ),
        );
      }
    }

    return inspections;
  }

  return [];
}
