import type { RuntimeVisibleScopeControl, SnapshotEntry } from "./currentSurfaceTypes.js";
import { collectActiveCommentComposerEntries } from "./commentComposer.js";
import { hasFeedCommentThreadSignals } from "./foregroundContext.js";
import { collectLeadingTopNavEntries } from "./visibleScopeTrusted.js";
import {
  dedupeEntriesByRoleAndName,
  previewTextFromEntries,
  toUncappedVisibleScopeControls,
  toVisibleScopeControls,
  uniqueOrdered,
} from "./visibleScopeCommon.js";

export function isCompanyActivityCommentsPage(pageUrl: string): boolean {
  return /\/company\/[^/]+\/admin\/notifications\/comments\/?/i.test(pageUrl);
}

function isCompanyActivityCommentAnchorEntry(entry: SnapshotEntry): boolean {
  return (entry.role === "button" || entry.role === "link") && /^Respond/i.test(entry.name);
}

export function collectCompanyActivityCommentEntries(entries: SnapshotEntry[], pageUrl: string): SnapshotEntry[] {
  if (!isCompanyActivityCommentsPage(pageUrl)) {
    return [];
  }

  const topNavEntries = collectLeadingTopNavEntries(entries);
  const lastTopNavRef = topNavEntries.at(-1)?.ref;
  const topNavEndIndex =
    lastTopNavRef !== undefined ? entries.findIndex((candidate) => candidate.ref === lastTopNavRef) : -1;
  const contentEntries = topNavEndIndex >= 0 ? entries.slice(topNavEndIndex + 1) : entries;
  const anchorIndexes = contentEntries
    .map((entry, index) => (isCompanyActivityCommentAnchorEntry(entry) ? index : -1))
    .filter((index) => index >= 0);

  if (anchorIndexes.length === 0) {
    return [];
  }

  const collected = new Map<string, SnapshotEntry>();

  for (const anchorIndex of anchorIndexes) {
    const startIndex = Math.max(0, anchorIndex - 4);
    const endIndex = Math.min(contentEntries.length, anchorIndex + 6);
    for (const entry of contentEntries.slice(startIndex, endIndex)) {
      if (entry.name) {
        collected.set(entry.ref, entry);
      }
    }
  }

  return dedupeEntriesByRoleAndName(Array.from(collected.values()));
}

export function isCompanyReplyThreadPage(pageUrl: string): boolean {
  const lowerUrl = pageUrl.toLowerCase();
  return lowerUrl.includes("/feed/update/") && lowerUrl.includes("actorcompanyid=");
}

function isCompanyReplyThreadAnchorEntry(entry: SnapshotEntry): boolean {
  return (
    (entry.role === "button" &&
      (/^Reply to .+ comment$/i.test(entry.name) ||
        /^Open options for .+ comment$/i.test(entry.name) ||
        /^React Like to .+ comment$/i.test(entry.name) ||
        /^Reply$/i.test(entry.name))) ||
    (entry.role === "link" && /^\d+\s+comments? on .+ post$/i.test(entry.name))
  );
}

const COMMENT_THREAD_BODY_ROLES = new Set(["article", "div", "heading", "listitem", "paragraph", "section", "span"]);

function isCompanyCommentThreadBodyEntry(entry: SnapshotEntry): boolean {
  return entry.name.trim().length > 0 && COMMENT_THREAD_BODY_ROLES.has(entry.role);
}

export function isCompanyCommentThreadBroadPostEntry(entry: SnapshotEntry): boolean {
  return entry.role === "button" && /^Open Grammarly\.?$/i.test(entry.name);
}

function isCompanyCommentThreadPreviewEntry(entry: SnapshotEntry): boolean {
  return !(entry.role === "button" && /^Reply$/i.test(entry.name));
}

function isCompanyCommentThreadPreviewLine(line: string): boolean {
  return !/^Reply$/i.test(line);
}

export function collectCompanyReplyThreadEntries(entries: SnapshotEntry[], pageUrl: string): SnapshotEntry[] {
  if (!isCompanyReplyThreadPage(pageUrl) || !hasFeedCommentThreadSignals(entries, pageUrl)) {
    return [];
  }

  const composerEntries = collectActiveCommentComposerEntries(entries, pageUrl);
  const anchorIndexes = entries
    .map((entry, index) => (isCompanyReplyThreadAnchorEntry(entry) ? index : -1))
    .filter((index) => index >= 0);

  if (anchorIndexes.length === 0 && composerEntries.length === 0) {
    return [];
  }

  const collected = new Map<string, SnapshotEntry>();

  for (const anchorIndex of anchorIndexes) {
    const startIndex = Math.max(0, anchorIndex - 5);
    const endIndex = Math.min(entries.length, anchorIndex + 10);
    for (const entry of entries.slice(startIndex, endIndex)) {
      if (entry.name) {
        collected.set(entry.ref, entry);
      }
    }
  }

  for (const entry of composerEntries) {
    if (entry.name) {
      collected.set(entry.ref, entry);
    }
  }

  return dedupeEntriesByRoleAndName(Array.from(collected.values()));
}

export function collectCompanyCommentThreadEntries(entries: SnapshotEntry[], pageUrl: string): SnapshotEntry[] {
  const replyThreadEntries = collectCompanyReplyThreadEntries(entries, pageUrl);
  if (replyThreadEntries.length === 0) {
    return [];
  }

  const composerIndex = entries.findIndex((entry) => /^(start a post|video|photo|write article)$/i.test(entry.name));
  const contentStartIndex = composerIndex >= 0 ? composerIndex + 1 : 0;
  const threadAnchorIndex = entries.findIndex((entry) => isCompanyReplyThreadAnchorEntry(entry));
  const contentEndIndex = threadAnchorIndex >= 0 ? threadAnchorIndex : entries.length;
  const threadBodyEntries =
    contentEndIndex > contentStartIndex
      ? dedupeEntriesByRoleAndName(
          entries.slice(contentStartIndex, contentEndIndex).filter((entry) => isCompanyCommentThreadBodyEntry(entry)),
        )
      : [];
  const threadBodyKeys = new Set(threadBodyEntries.map((entry) => `${entry.role}:${entry.name}`));
  const replyThreadVisibleEntries = replyThreadEntries.filter(
    (entry) => !threadBodyKeys.has(`${entry.role}:${entry.name}`) && !isCompanyCommentThreadBroadPostEntry(entry),
  );

  return dedupeEntriesByRoleAndName([...threadBodyEntries, ...replyThreadVisibleEntries]);
}

export function resolveCompanyCommentThreadPreviewText(
  companyCommentThreadEntries: SnapshotEntry[],
  postSegments: Array<{ anchor: SnapshotEntry; entries: SnapshotEntry[]; previewText?: string[] }>,
  domThreadText: string[] = [],
): string[] {
  const currentPostSegment =
    postSegments.find((segment) =>
      companyCommentThreadEntries.some(
        (entry) => entry.ref === segment.anchor.ref || entry.name === segment.anchor.name,
      ),
    ) ?? postSegments[0];
  const postPreviewText = (
    currentPostSegment?.previewText ?? previewTextFromEntries(currentPostSegment?.entries ?? [])
  ).filter((line) => isCompanyCommentThreadPreviewLine(line));
  return uniqueOrdered([
    ...postPreviewText,
    ...domThreadText,
    ...previewTextFromEntries(companyCommentThreadEntries.filter((entry) => isCompanyCommentThreadPreviewEntry(entry))),
  ]);
}

export function buildCompanyCommentThreadScopeControls(
  handle: string,
  entries: readonly SnapshotEntry[],
): RuntimeVisibleScopeControl[] {
  const bodyEntries = entries.filter((entry) => !isCompanyReplyThreadAnchorEntry(entry));
  const anchorEntries = entries.filter((entry) => isCompanyReplyThreadAnchorEntry(entry));
  const bodyControls = toVisibleScopeControls(handle, bodyEntries);
  const anchorControls = toUncappedVisibleScopeControls(handle, anchorEntries);
  return [...bodyControls, ...anchorControls];
}
