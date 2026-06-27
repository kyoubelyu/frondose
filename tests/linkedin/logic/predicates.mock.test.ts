import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SnapshotEntry } from "../../../src/linkedin/types.js";
import { hasActorSelectionModalSurfaceSignals, isActorSelectionModalEntry } from "../../../src/linkedin/logic/predicates/actorSelection.js";
import {
  hasArticleEditorSurfaceSignals,
  hasArticleManageSurfaceSignals,
  isArticleEditorButtonEntry,
  isArticleEditorInputEntry,
  isArticleManageDraftEntry,
  isArticleManageTabEntry,
  isProfileArticleFilterEntry,
} from "../../../src/linkedin/logic/predicates/article.js";
import {
  COMPOSER_CLEAR_JS,
  COMPOSER_EDITOR_JS,
  COMPOSER_FOCUS_JS,
  hasComposerAudienceSurfaceSignals,
  hasComposerScheduleSurfaceSignals,
  isComposerAudienceModalEntry,
  isComposerButtonEntry,
  isComposerEmojiEntry,
  isComposerInputEntry,
  isComposerScheduleModalEntry,
} from "../../../src/linkedin/logic/predicates/composer.js";
import {
  detectFeedSignals,
  hasFeedCommentThreadSignals,
  hasProfileConnectPromptOverlay,
  hasProfileMessageOverlayThread,
  isCommentButtonEntry,
  isCommentInputEntry,
  isPostActionEntry,
  isProfileConnectPromptEntry,
} from "../../../src/linkedin/logic/predicates/feedProfile.js";
import {
  detectMessagingSignals,
  isMessagingConversationEntry,
  isMessagingListEntry,
  isMessagingSearchEntry,
  isThreadComposerButtonEntry,
  isThreadComposerInputEntry,
} from "../../../src/linkedin/logic/predicates/messaging.js";
import {
  hasComposerMediaSurfaceSignals,
  hasMediaEditorThumbnailSurfaceSignals,
  isComposerMediaModalEntry,
  isMediaEditorThumbnailActionEntry,
  isMediaEditorThumbnailUploadLabel,
} from "../../../src/linkedin/logic/predicates/media.js";
import { hasReactionModalSurfaceSignals, isReactionModalEntry } from "../../../src/linkedin/logic/predicates/reactionModal.js";
import { isInputEntry } from "../../../src/linkedin/logic/predicates/_shared.js";

function entry(role: string, name: string, ref = "@e1"): SnapshotEntry {
  return { ref, role, name };
}

describe("shared input predicates", () => {
  it("T-Predicate.Shared.1: classifies AX input roles and rejects non-input controls", () => {
    // Given: a textbox entry and a button entry.
    // When: isInputEntry evaluates each entry.
    // Then: only the textbox is treated as an input.
    assert.equal(isInputEntry(entry("textbox", "Write a message")), true);
    assert.equal(isInputEntry(entry("button", "Write a message")), false);
  });
});

describe("composer predicates", () => {
  it("T-Predicate.Composer.1: recognizes composer inputs and composer buttons", () => {
    // Given: feed composer AX entries and unrelated feed controls.
    // When: composer input/button predicates evaluate them.
    // Then: only composer-specific labels match.
    assert.equal(isComposerInputEntry(entry("textbox", "Text editor for creating content")), true);
    assert.equal(isComposerInputEntry(entry("textbox", "Search messages")), false);
    assert.equal(isComposerButtonEntry(entry("button", "Post")), true);
    assert.equal(isComposerButtonEntry(entry("button", "Repost")), false);
  });

  it("T-Predicate.Composer.2: recognizes composer emoji controls", () => {
    // Given: emoji keyboard controls and unrelated short buttons.
    // When: isComposerEmojiEntry evaluates them.
    // Then: named emoji controls match and ordinary buttons do not.
    assert.equal(isComposerEmojiEntry(entry("button", "Search for emojis")), true);
    assert.equal(isComposerEmojiEntry(entry("tab", "Emoji category selection")), true);
    assert.equal(isComposerEmojiEntry(entry("button", "Go")), false);
  });

  it("T-Predicate.Composer.3: recognizes composer audience modal entries and signals", () => {
    // Given: audience modal labels and ordinary page labels.
    // When: audience predicates evaluate entries and an entry list.
    // Then: the modal options match and unrelated entries do not.
    const entries = [entry("button", "Anyone on or off LinkedIn"), entry("button", "Done")];
    assert.equal(isComposerAudienceModalEntry(entries[0]!), true);
    assert.equal(hasComposerAudienceSurfaceSignals(entries), true);
    assert.equal(hasComposerAudienceSurfaceSignals([entry("button", "Post")]), false);
  });

  it("T-Predicate.Composer.4: recognizes composer schedule modal entries and signals", () => {
    // Given: schedule modal date/time controls and non-schedule controls.
    // When: schedule predicates evaluate entries and an entry list.
    // Then: schedule controls match and ordinary post controls do not.
    const entries = [entry("textbox", "Date"), entry("button", "Expand timepicker")];
    assert.equal(isComposerScheduleModalEntry(entries[0]!), true);
    assert.equal(hasComposerScheduleSurfaceSignals(entries), true);
    assert.equal(hasComposerScheduleSurfaceSignals([entry("button", "Post")]), false);
  });

  it("T-Predicate.Composer.5: parameterizes deepFind composer scripts by label pattern", () => {
    // Given: a messaging-specific input label pattern.
    // When: the deepFind script builders are called.
    // Then: each script embeds that pattern and keeps the expected action body.
    const labelPattern = /write a message/i;
    const editorJs = COMPOSER_EDITOR_JS(labelPattern);
    const focusJs = COMPOSER_FOCUS_JS(labelPattern);
    const clearJs = COMPOSER_CLEAR_JS(labelPattern);
    assert.match(editorJs, /const INPUT_RE = \/write a message\/i/);
    assert.match(focusJs, /el\.focus\(\)/);
    assert.match(clearJs, /deleteContentBackward/);
  });
});

describe("messaging predicates", () => {
  it("T-Predicate.Messaging.1: recognizes messaging search, list, conversation, input, and button entries", () => {
    // Given: AX entries from the messaging surface.
    // When: messaging predicates evaluate each entry.
    // Then: each role/label pair maps to the expected messaging bucket.
    assert.equal(isMessagingSearchEntry(entry("textbox", "Search messages")), true);
    assert.equal(isMessagingListEntry(entry("button", "Open conversation with Ada Lovelace")), true);
    assert.equal(
      isMessagingConversationEntry(entry("link", "Jump to active conversation details"), "https://www.linkedin.com/messaging/"),
      true,
    );
    assert.equal(isThreadComposerInputEntry(entry("textbox", "Write a message")), true);
    assert.equal(isThreadComposerButtonEntry(entry("button", "Send")), true);
  });

  it("T-Predicate.Messaging.2: rejects non-messaging lookalikes", () => {
    // Given: feed/search controls with similar roles.
    // When: messaging predicates evaluate them.
    // Then: unrelated labels do not match messaging-specific predicates.
    assert.equal(isMessagingSearchEntry(entry("textbox", "Search jobs")), false);
    assert.equal(isThreadComposerInputEntry(entry("textbox", "Search messages")), false);
    assert.equal(isThreadComposerButtonEntry(entry("link", "Send")), false);
  });

  it("T-Predicate.Messaging.3: detects combined messaging surface signals", () => {
    // Given: a messaging thread URL and entries for search, list, and composer.
    // When: detectMessagingSignals runs.
    // Then: all expected messaging flags are true.
    const signals = detectMessagingSignals(
      [
        entry("textbox", "Search messages"),
        entry("button", "Focused"),
        entry("textbox", "Write a message"),
      ],
      "https://www.linkedin.com/messaging/thread/123/",
    );
    assert.deepEqual(signals, {
      hasSearch: true,
      hasConversationList: true,
      hasActiveConversation: true,
      hasThreadComposer: true,
    });
  });
});

describe("feed and profile predicates", () => {
  it("T-Predicate.FeedProfile.1: recognizes comment composer inputs and buttons", () => {
    // Given: comment controls and unrelated feed controls.
    // When: comment predicates evaluate them.
    // Then: comment-specific input/button labels match.
    assert.equal(isCommentInputEntry(entry("textbox", "Write a comment")), true);
    assert.equal(isCommentInputEntry(entry("textbox", "Write a message")), false);
    assert.equal(isCommentButtonEntry(entry("button", "Comment")), true);
    assert.equal(isCommentButtonEntry(entry("link", "Comment")), false);
  });

  it("T-Predicate.FeedProfile.2: recognizes profile connect prompt entries and overlay signals", () => {
    // Given: connect-prompt modal entries on a profile URL.
    // When: connect prompt predicates evaluate the entries.
    // Then: the prompt is detected only on profile surfaces.
    const entries = [
      entry("button", "Add a note"),
      entry("button", "Send without a note"),
      entry("link", "Pending, click to withdraw invitation sent to Ada Lovelace"),
    ];
    assert.equal(isProfileConnectPromptEntry(entries[0]!), true);
    assert.equal(hasProfileConnectPromptOverlay("https://www.linkedin.com/in/ada/", "profile", entries), true);
    assert.equal(hasProfileConnectPromptOverlay("https://www.linkedin.com/messaging/", "profile", entries), false);
  });

  it("T-Predicate.FeedProfile.3: recognizes feed post action controls", () => {
    // Given: feed action buttons and non-action controls.
    // When: isPostActionEntry evaluates them.
    // Then: post action labels match and unrelated buttons do not.
    assert.equal(isPostActionEntry(entry("button", "Open reactions menu")), true);
    assert.equal(isPostActionEntry(entry("button", "Connect")), false);
  });

  it("T-Predicate.FeedProfile.4: detects feed comment-thread signals only on update URLs", () => {
    // Given: a feed update URL and a comment-thread AX signal.
    // When: hasFeedCommentThreadSignals evaluates matching and non-matching URLs.
    // Then: only the feed update URL reports a comment thread.
    const entries = [entry("button", "Reply to Ada comment")];
    assert.equal(hasFeedCommentThreadSignals(entries, "https://www.linkedin.com/feed/update/urn:li:activity:1/"), true);
    assert.equal(hasFeedCommentThreadSignals(entries, "https://www.linkedin.com/feed/"), false);
  });

  it("T-Predicate.FeedProfile.5: detects profile message overlays and feed signal summaries", () => {
    // Given: profile overlay conversation entries and a comment-thread signal.
    // When: overlay and feed summary predicates run.
    // Then: profile message and feed comment-thread flags are set.
    const profileEntries = [
      entry("link", "Jump to active conversation details"),
      entry("textbox", "Write a message"),
    ];
    assert.equal(hasProfileMessageOverlayThread("https://www.linkedin.com/in/ada/", "profile", profileEntries), true);
    assert.deepEqual(
      detectFeedSignals(true, [entry("link", "3 comments on Ada post")], "https://www.linkedin.com/feed/update/1/"),
      { hasCommentComposer: true, hasCommentThreadSurface: true },
    );
  });
});

describe("reaction modal predicates", () => {
  it("T-Predicate.ReactionModal.1: recognizes reaction modal entries", () => {
    // Given: reaction modal controls and unrelated controls.
    // When: isReactionModalEntry evaluates them.
    // Then: reaction controls match and unrelated links do not.
    assert.equal(isReactionModalEntry(entry("button", "Like")), true);
    assert.equal(isReactionModalEntry(entry("link", "Ada reacted with Love")), true);
    assert.equal(isReactionModalEntry(entry("button", "Connect")), false);
  });

  it("T-Predicate.ReactionModal.2: detects reaction modal surface signals", () => {
    // Given: a reaction modal button set.
    // When: hasReactionModalSurfaceSignals evaluates the list.
    // Then: a modal with multiple reaction controls is detected.
    const entries = [entry("button", "Like"), entry("button", "Celebrate"), entry("button", "Support")];
    assert.equal(hasReactionModalSurfaceSignals(entries), true);
    assert.equal(hasReactionModalSurfaceSignals([entry("button", "Connect")]), false);
  });
});

describe("actor selection predicates", () => {
  it("T-Predicate.ActorSelection.1: recognizes actor selection modal entries", () => {
    // Given: actor selection controls and unrelated controls.
    // When: isActorSelectionModalEntry evaluates them.
    // Then: select/save controls match and unrelated controls do not.
    assert.equal(isActorSelectionModalEntry(entry("button", "Save selection")), true);
    assert.equal(isActorSelectionModalEntry(entry("radio", "Select Frondose")), true);
    assert.equal(isActorSelectionModalEntry(entry("button", "Post")), false);
  });

  it("T-Predicate.ActorSelection.2: detects actor selection modal signals", () => {
    // Given: a save button and selectable actor entries.
    // When: hasActorSelectionModalSurfaceSignals evaluates the list.
    // Then: the actor selection modal is detected.
    const entries = [entry("button", "Save selection"), entry("button", "Dismiss"), entry("radio", "Select Frondose")];
    assert.equal(hasActorSelectionModalSurfaceSignals(entries), true);
    assert.equal(hasActorSelectionModalSurfaceSignals([entry("radio", "Select Frondose")]), false);
  });
});

describe("article predicates", () => {
  it("T-Predicate.Article.1: recognizes article editor inputs, buttons, and profile filters", () => {
    // Given: article editor controls and profile content filters.
    // When: article predicates evaluate them.
    // Then: editor and filter controls match their expected labels.
    assert.equal(isArticleEditorInputEntry(entry("textbox", "Title")), true);
    assert.equal(isArticleEditorButtonEntry(entry("button", "Upload from computer")), true);
    assert.equal(isProfileArticleFilterEntry(entry("button", "Documents")), true);
    assert.equal(isArticleEditorInputEntry(entry("textbox", "Search")), false);
  });

  it("T-Predicate.Article.2: recognizes article manage tabs and drafts", () => {
    // Given: article management tabs and draft links.
    // When: manage predicates evaluate them.
    // Then: draft management entries match and ordinary buttons do not.
    assert.equal(isArticleManageTabEntry(entry("tab", "Drafts")), true);
    assert.equal(isArticleManageDraftEntry(entry("link", "Edit draft Launch plan")), true);
    assert.equal(isArticleManageDraftEntry(entry("button", "Post")), false);
  });

  it("T-Predicate.Article.3: detects article editor and manage surface signals", () => {
    // Given: article editor and manage fixtures.
    // When: surface signal predicates evaluate them on matching URLs.
    // Then: article surfaces are detected only with the required controls.
    const editorEntries = [
      entry("textbox", "Title"),
      entry("textbox", "Article editor content"),
      entry("button", "Next"),
    ];
    const manageEntries = [entry("tab", "Drafts"), entry("link", "Edit draft Launch plan")];
    assert.equal(hasArticleEditorSurfaceSignals(editorEntries, "https://www.linkedin.com/article/edit/"), true);
    assert.equal(hasArticleManageSurfaceSignals(manageEntries, "https://www.linkedin.com/article/manage/"), true);
    assert.equal(hasArticleManageSurfaceSignals(manageEntries, "https://www.linkedin.com/feed/"), false);
  });
});

describe("media predicates", () => {
  it("T-Predicate.Media.1: recognizes composer media modal entries", () => {
    // Given: media modal controls and unrelated controls.
    // When: isComposerMediaModalEntry evaluates them.
    // Then: media controls match and unrelated controls do not.
    assert.equal(isComposerMediaModalEntry(entry("button", "Upload from computer")), true);
    assert.equal(isComposerMediaModalEntry(entry("button", "Captions")), true);
    assert.equal(isComposerMediaModalEntry(entry("button", "Post")), false);
  });

  it("T-Predicate.Media.2: recognizes media editor thumbnail controls", () => {
    // Given: thumbnail upload labels and controls.
    // When: thumbnail predicates evaluate them.
    // Then: upload labels and action buttons match.
    assert.equal(isMediaEditorThumbnailUploadLabel("Add video thumbnail"), true);
    assert.equal(isMediaEditorThumbnailUploadLabel("Upload from computer"), false);
    assert.equal(isMediaEditorThumbnailActionEntry(entry("button", "Add video thumbnail")), true);
  });

  it("T-Predicate.Media.3: detects composer media and thumbnail surface signals", () => {
    // Given: media modal and thumbnail modal fixtures.
    // When: media surface predicates evaluate each list.
    // Then: both media surface variants are detected.
    const uploadEntries = [
      entry("button", "Dismiss"),
      entry("button", "Upload from computer"),
      entry("button", "Next"),
    ];
    const thumbnailEntries = [
      entry("button", "Dismiss"),
      entry("button", "Back"),
      entry("button", "Add"),
      entry("button", "Add video thumbnail"),
    ];
    assert.equal(hasComposerMediaSurfaceSignals(uploadEntries), true);
    assert.equal(hasMediaEditorThumbnailSurfaceSignals(thumbnailEntries), true);
    assert.equal(hasComposerMediaSurfaceSignals([entry("button", "Upload from computer")]), false);
  });
});
