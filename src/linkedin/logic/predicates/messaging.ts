import type { SnapshotEntry } from "../../types.js";
import { MESSAGING_INPUT_RE } from "../actionClassifier.js";
import type { MessagingSignals } from "../contracts/visibleScope.js";
import { isInputEntry } from "./_shared.js";

const MESSAGING_LIST_BUTTON_LABELS = new Set([
  "Focused",
  "Unread",
  "Connections",
  "InMail",
  "Starred",
  "Compose a new message",
  "Compose message",
  "See more messaging options",
]);

export function isMessagingSearchEntry(entry: SnapshotEntry): boolean {
  return isInputEntry(entry) && /search messages/i.test(entry.name);
}

export function isMessagingListEntry(entry: SnapshotEntry): boolean {
  return (
    entry.role === "button" &&
    (MESSAGING_LIST_BUTTON_LABELS.has(entry.name) ||
      /^Open conversation with /i.test(entry.name) ||
      /^Open the options list in your conversation with /i.test(entry.name))
  );
}

export function isMessagingConversationEntry(entry: SnapshotEntry, _pageUrl: string): boolean {
  return (
    (entry.role === "link" && entry.name === "Jump to active conversation details") ||
    (entry.role === "button" &&
      (/star conversation/i.test(entry.name) ||
        /^Minimize your conversation$/i.test(entry.name) ||
        /^Minimize your conversation with /i.test(entry.name) ||
        /^Close your draft conversation$/i.test(entry.name) ||
        /^Close your conversation with /i.test(entry.name)))
  );
}

export function isThreadComposerInputEntry(entry: SnapshotEntry): boolean {
  return (
    isInputEntry(entry) &&
    !/search/i.test(entry.name) &&
    MESSAGING_INPUT_RE.test(entry.name)
  );
}

export function isThreadComposerButtonEntry(entry: SnapshotEntry): boolean {
  return entry.role === "button" && /(send|reply|attach|emoji|gif)/i.test(entry.name);
}

export function detectMessagingSignals(entries: SnapshotEntry[], pageUrl: string): MessagingSignals {
  return {
    hasSearch: entries.some((entry) => isMessagingSearchEntry(entry)),
    hasConversationList: entries.some((entry) => isMessagingListEntry(entry)),
    hasActiveConversation:
      pageUrl.includes("/messaging/thread/") || entries.some((entry) => isMessagingConversationEntry(entry, pageUrl)),
    hasThreadComposer: entries.some((entry) => isThreadComposerInputEntry(entry)),
  };
}
