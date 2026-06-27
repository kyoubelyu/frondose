import {
  hasFeedCommentThreadSignals,
  isCommentButtonEntry,
  isCommentInputEntry,
  isComposerInputEntry,
} from "./foregroundContext.js";
import type { SnapshotEntry } from "./currentSurfaceTypes.js";
import { dedupeEntriesByRoleAndName } from "./visibleScopeCommon.js";

const COMMENT_COMPOSER_FORWARD_SCAN_LIMIT = 14;

function isContextualCommentInputEntry(entry: SnapshotEntry, hasCommentThreadSurface: boolean): boolean {
  return isCommentInputEntry(entry) || (hasCommentThreadSurface && isComposerInputEntry(entry));
}

function isContextualCommentComposerControlEntry(entry: SnapshotEntry, hasCommentThreadSurface: boolean): boolean {
  if (isCommentButtonEntry(entry)) {
    return true;
  }

  return (
    hasCommentThreadSurface && entry.role === "button" && /^(open emoji keyboard|add a photo|reply)$/i.test(entry.name)
  );
}

export function collectActiveCommentComposerEntries(entries: SnapshotEntry[], pageUrl: string): SnapshotEntry[] {
  const hasCommentThreadSurface = hasFeedCommentThreadSignals(entries, pageUrl);
  const inputIndexes = entries
    .map((entry, index) => (isContextualCommentInputEntry(entry, hasCommentThreadSurface) ? index : -1))
    .filter((index) => index >= 0);

  const candidates: SnapshotEntry[][] = [];

  for (const inputIndex of inputIndexes) {
    const candidateEntries: SnapshotEntry[] = [];
    const beforeInput = entries[inputIndex - 1];
    if (beforeInput && isContextualCommentComposerControlEntry(beforeInput, hasCommentThreadSurface)) {
      candidateEntries.push(beforeInput);
    }

    const inputEntry = entries[inputIndex];
    if (!inputEntry) {
      continue;
    }
    candidateEntries.push(inputEntry);
    let sawForwardControl = false;

    for (
      let index = inputIndex + 1;
      index < entries.length && index <= inputIndex + COMMENT_COMPOSER_FORWARD_SCAN_LIMIT;
      index += 1
    ) {
      const candidate = entries[index];
      if (!candidate) {
        continue;
      }

      if (isContextualCommentInputEntry(candidate, hasCommentThreadSurface)) {
        break;
      }

      if (/^Open Grammarly\./i.test(candidate.name)) {
        candidateEntries.push(candidate);
        continue;
      }

      if (isContextualCommentComposerControlEntry(candidate, hasCommentThreadSurface)) {
        candidateEntries.push(candidate);
        sawForwardControl = true;
        continue;
      }

      if (!sawForwardControl && hasCommentThreadSurface && candidate.role === "link") {
        continue;
      }

      if (sawForwardControl || candidateEntries.length > 1) {
        if (candidateEntries.some((entry) => entry.role === "button" && /^(comment|reply)$/i.test(entry.name))) {
          break;
        }
        continue;
      }
    }

    candidates.push(dedupeEntriesByRoleAndName(candidateEntries));
  }

  const replyCandidate = candidates.find((candidate) =>
    candidate.some((entry) => entry.role === "button" && /^reply$/i.test(entry.name)),
  );
  if (replyCandidate) {
    return replyCandidate;
  }

  const commentCandidate = candidates.find((candidate) =>
    candidate.some((entry) => entry.role === "button" && /^comment$/i.test(entry.name)),
  );
  if (commentCandidate) {
    return commentCandidate;
  }

  return candidates[0] ?? [];
}

export function activeCommentComposerRefs(entries: SnapshotEntry[], pageUrl: string): Set<string> {
  const activeCommentComposerEntries = collectActiveCommentComposerEntries(entries, pageUrl);
  if (activeCommentComposerEntries.length > 0) {
    return new Set(activeCommentComposerEntries.map((entry) => entry.ref));
  }

  const refs = new Set<string>();
  const inputIndexes = entries
    .map((candidate, index) => (isCommentInputEntry(candidate) ? index : -1))
    .filter((index) => index >= 0);

  for (const inputIndex of inputIndexes) {
    const inputEntry = entries[inputIndex];
    if (!inputEntry) {
      continue;
    }
    refs.add(inputEntry.ref);

    for (
      let index = inputIndex + 1;
      index < entries.length && index <= inputIndex + COMMENT_COMPOSER_FORWARD_SCAN_LIMIT;
      index += 1
    ) {
      const candidate = entries[index];
      if (!candidate) {
        continue;
      }
      if (
        isCommentInputEntry(candidate) ||
        isCommentButtonEntry(candidate) ||
        /^Open Grammarly\./i.test(candidate.name)
      ) {
        refs.add(candidate.ref);
        continue;
      }

      if (refs.size > 1) {
        const hasSubmit = Array.from(refs).some((ref) => {
          const entry = entries.find((item) => item.ref === ref);
          return Boolean(entry && entry.role === "button" && /^(comment|reply)$/i.test(entry.name));
        });
        if (!hasSubmit) {
          continue;
        }
        break;
      }
    }
  }

  return refs;
}
