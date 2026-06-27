import type { SnapshotEntry } from "../../types.js";

export const MEDIA_EDITOR_THUMBNAIL_UPLOAD_LABEL = "Add video thumbnail";
export const MEDIA_EDITOR_THUMBNAIL_REMOVE_LABEL = "Remove video thumbnail";

function hasExactEntryName(entry: SnapshotEntry, pattern: RegExp): boolean {
  return pattern.test(entry.name);
}

function hasExactLabel(entry: SnapshotEntry, label: string): boolean {
  return entry.name.trim().toLowerCase() === label.toLowerCase();
}

function isMediaSelectionEntry(entry: SnapshotEntry): boolean {
  return (
    entry.role === "button" && (hasExactEntryName(entry, /^upload from computer$/i) || /^select .+/i.test(entry.name))
  );
}

function isMediaNavigationEntry(entry: SnapshotEntry): boolean {
  return entry.role === "button" && hasExactEntryName(entry, /^(add|back|next)$/i);
}

function isVideoMediaEditorToolbarEntry(entry: SnapshotEntry): boolean {
  return (
    entry.role === "button" &&
    hasExactEntryName(entry, /^(captions|video thumbnail|apply|edit|tag|alternative text|duplicate|delete|back)$/i)
  );
}

function isStrongVideoMediaEditorMarker(entry: SnapshotEntry): boolean {
  return entry.role === "button" && hasExactEntryName(entry, /^(back|edit|tag|alternative text|duplicate|delete)$/i);
}

function isCaptionPaneActionEntry(entry: SnapshotEntry): boolean {
  return (
    (entry.role === "button" && hasExactEntryName(entry, /^upload srt$/i)) ||
    (entry.role === "switch" && hasExactEntryName(entry, /^add auto captions$/i))
  );
}

function isCaptionPaneBoundaryEntry(entry: SnapshotEntry): boolean {
  return entry.role === "button" && hasExactEntryName(entry, /^(apply|back)$/i);
}

export function isMediaEditorThumbnailUploadLabel(label: string | undefined): boolean {
  return Boolean(label && label.trim().toLowerCase() === MEDIA_EDITOR_THUMBNAIL_UPLOAD_LABEL.toLowerCase());
}

export function isMediaEditorThumbnailActionEntry(entry: SnapshotEntry): boolean {
  return (
    entry.role === "button" &&
    (hasExactLabel(entry, MEDIA_EDITOR_THUMBNAIL_UPLOAD_LABEL) ||
      hasExactLabel(entry, MEDIA_EDITOR_THUMBNAIL_REMOVE_LABEL))
  );
}

export function hasMediaEditorThumbnailSurfaceSignals(entries: SnapshotEntry[]): boolean {
  const hasDismiss = entries.some((entry) => entry.role === "button" && hasExactLabel(entry, "Dismiss"));
  const hasBack = entries.some((entry) => entry.role === "button" && hasExactLabel(entry, "Back"));
  const hasAdd = entries.some((entry) => entry.role === "button" && hasExactLabel(entry, "Add"));
  const hasThumbnailAction = entries.some((entry) => isMediaEditorThumbnailActionEntry(entry));
  return hasDismiss && hasBack && hasAdd && hasThumbnailAction;
}

export function isComposerMediaModalEntry(entry: SnapshotEntry): boolean {
  return (
    isMediaSelectionEntry(entry) ||
    isMediaNavigationEntry(entry) ||
    isVideoMediaEditorToolbarEntry(entry) ||
    isCaptionPaneActionEntry(entry) ||
    isMediaEditorThumbnailActionEntry(entry)
  );
}

export function hasComposerMediaSurfaceSignals(entries: SnapshotEntry[]): boolean {
  const mediaEntries = entries.filter((entry) => isComposerMediaModalEntry(entry));
  const hasDismiss = entries.some((entry) => entry.role === "button" && /^dismiss$/i.test(entry.name));
  const hasSelectionButton = mediaEntries.some((entry) => isMediaSelectionEntry(entry));
  const hasNavigationControls = mediaEntries.some((entry) => isMediaNavigationEntry(entry));
  const hasUploadSelectionSurface = hasSelectionButton && hasNavigationControls;
  const hasVideoEditorToolbarSurface =
    mediaEntries.some(
      (entry) => entry.role === "button" && hasExactEntryName(entry, /^(captions|video thumbnail)$/i),
    ) && mediaEntries.some((entry) => isStrongVideoMediaEditorMarker(entry));
  const hasCaptionsPaneSurface =
    mediaEntries.some((entry) => isCaptionPaneActionEntry(entry)) &&
    mediaEntries.some((entry) => isCaptionPaneBoundaryEntry(entry));
  const hasThumbnailSurface = hasMediaEditorThumbnailSurfaceSignals(entries);
  return (
    hasDismiss &&
    (hasUploadSelectionSurface || hasVideoEditorToolbarSurface || hasCaptionsPaneSurface || hasThumbnailSurface)
  );
}
