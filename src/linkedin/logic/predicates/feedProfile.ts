import type { SnapshotEntry } from "../../types.js";
import { CONNECT_ADD_NOTE_RE, CONNECT_SEND_RE } from "../actionClassifier.js";
import type { FeedSignals } from "../contracts/visibleScope.js";
import { isInputEntry } from "./_shared.js";
import { isMessagingConversationEntry, isThreadComposerButtonEntry, isThreadComposerInputEntry } from "./messaging.js";

const POST_ACTION_LABELS = new Set([
  "open actor selection screen",
  "open reactions menu",
  "comment",
  "repost",
  "send",
  "reply",
  "load more comments",
]);

export function isCommentInputEntry(entry: SnapshotEntry): boolean {
  return isInputEntry(entry) && /creating comment|write a comment|add a comment/i.test(entry.name);
}

export function isCommentButtonEntry(entry: SnapshotEntry): boolean {
  return (
    entry.role === "button" &&
    /show emoji picker|open emoji keyboard|share photo|add a photo|^comment$/i.test(entry.name)
  );
}

export function isProfileConnectPromptEntry(entry: SnapshotEntry): boolean {
  if (entry.role === "button") {
    return (
      /^(dismiss|cancel|cancel adding a note)$/i.test(entry.name) ||
      CONNECT_ADD_NOTE_RE.test(entry.name) ||
      CONNECT_SEND_RE.test(entry.name)
    );
  }

  return (
    (entry.role === "link" && /^pending, click to withdraw invitation sent to /i.test(entry.name)) ||
    (isInputEntry(entry) &&
      /personal note|add a note|message|please limit personal note to 300 characters/i.test(entry.name))
  );
}

export function hasProfileConnectPromptOverlay(pageUrl: string, surface: string, entries: SnapshotEntry[]): boolean {
  if (surface !== "profile" || pageUrl.toLowerCase().includes("/messaging/")) {
    return false;
  }

  const hasAddNote = entries.some((entry) => entry.role === "button" && CONNECT_ADD_NOTE_RE.test(entry.name));
  const hasSendWithoutNote = entries.some((entry) => entry.role === "button" && CONNECT_SEND_RE.test(entry.name));
  const hasPromptAction = hasAddNote || hasSendWithoutNote;
  const hasPendingInvite = entries.some(
    (entry) => entry.role === "link" && /^pending, click to withdraw invitation sent to /i.test(entry.name),
  );
  const hasPersonalNoteInput = entries.some(
    (entry) =>
      isInputEntry(entry) && /personal note|add a note|please limit personal note to 300 characters/i.test(entry.name),
  );
  const hasCancel = entries.some((entry) => entry.role === "button" && /^cancel(?: adding a note)?$/i.test(entry.name));
  const hasSendInvitation = entries.some((entry) => entry.role === "button" && CONNECT_SEND_RE.test(entry.name));
  const hasPromptBoundary = entries.some(
    (entry) =>
      (entry.role === "button" &&
        (/^(dismiss|cancel|cancel adding a note)$/i.test(entry.name) || CONNECT_SEND_RE.test(entry.name))) ||
      (isInputEntry(entry) &&
        /personal note|add a note|message|please limit personal note to 300 characters/i.test(entry.name)) ||
      /(you can add a note|personal note|invitation|connect with)/i.test(entry.name),
  );
  const hasPreSendConfirmation = (hasAddNote && hasSendWithoutNote) || (hasPromptAction && hasPromptBoundary);
  const hasNoteStateConfirmation = hasPersonalNoteInput && hasCancel && hasSendInvitation;

  return (hasPromptAction && hasPendingInvite) || hasPreSendConfirmation || hasNoteStateConfirmation;
}

export function isPostActionEntry(entry: SnapshotEntry): boolean {
  const normalized = entry.name.trim().toLowerCase();
  return (
    entry.role === "button" &&
    (POST_ACTION_LABELS.has(normalized) || normalized === "load more comments load more comments")
  );
}

function isFeedCommentThreadSignalEntry(entry: SnapshotEntry): boolean {
  return (
    (entry.role === "button" &&
      (/^Current selected sort order is /i.test(entry.name) ||
        /^Reply to .+ comment$/i.test(entry.name) ||
        /^Open options for .+ comment$/i.test(entry.name) ||
        /^React Like to .+ comment$/i.test(entry.name))) ||
    (entry.role === "link" && /^\d+\s+comments? on .+ post$/i.test(entry.name))
  );
}

export function hasFeedCommentThreadSignals(entries: SnapshotEntry[], pageUrl: string): boolean {
  return (
    pageUrl.toLowerCase().includes("/feed/update/") && entries.some((entry) => isFeedCommentThreadSignalEntry(entry))
  );
}

export function hasProfileMessageOverlayThread(pageUrl: string, surface: string, entries: SnapshotEntry[]): boolean {
  if (surface !== "profile" || pageUrl.toLowerCase().includes("/messaging/")) {
    return false;
  }

  const hasConversation = entries.some((entry) => isMessagingConversationEntry(entry, pageUrl));
  const hasThreadComposer = entries.some(
    (entry) => isThreadComposerInputEntry(entry) || isThreadComposerButtonEntry(entry),
  );

  return hasConversation && hasThreadComposer;
}

export function detectFeedSignals(hasCommentComposer: boolean, entries: SnapshotEntry[], pageUrl: string): FeedSignals {
  return {
    hasCommentComposer,
    hasCommentThreadSurface: hasFeedCommentThreadSignals(entries, pageUrl),
  };
}
