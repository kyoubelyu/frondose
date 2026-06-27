import type { SnapshotEntry } from "../../types.js";
import { isInputEntry } from "./_shared.js";

export function isArticleEditorInputEntry(entry: SnapshotEntry): boolean {
  return isInputEntry(entry) && /^(title|article editor content)$/i.test(entry.name);
}

export function isArticleEditorButtonEntry(entry: SnapshotEntry): boolean {
  return (
    (entry.role === "button" &&
      /(individual article|style|manage menu|next|upload from computer|open grammarly\.?|duplicate as draft|settings|drafts|scheduled|published|new draft|create newsletter|help|give feedback)/i.test(
        entry.name,
      )) ||
    (entry.role === "link" && /^preview$/i.test(entry.name))
  );
}

export function isProfileArticleFilterEntry(entry: SnapshotEntry): boolean {
  return entry.role === "button" && /^(posts|comments|videos|images|more|documents|reactions)$/i.test(entry.name);
}

export function isArticleManageTabEntry(entry: SnapshotEntry): boolean {
  return entry.role === "tab" && /^(drafts|scheduled|published)$/i.test(entry.name);
}

function isArticleManageShellEntry(entry: SnapshotEntry): boolean {
  return (
    entry.role === "button" &&
    /^(dismiss|close|not now|.+ article actions menu|delete [\u201c"].+[\u201d"]|delete draft [\u201c"].+[\u201d"]|edit [\u201c"].+[\u201d"]|duplicate as draft)$/i.test(
      entry.name,
    )
  );
}

export function isArticleManageDraftEntry(entry: SnapshotEntry): boolean {
  return (
    isArticleManageShellEntry(entry) ||
    (entry.role === "link" && /^edit draft /i.test(entry.name)) ||
    (entry.role === "link" && entry.name.trim().length > 0)
  );
}

export function hasArticleManageSurfaceSignals(entries: SnapshotEntry[], pageUrl: string): boolean {
  const lowerUrl = pageUrl.toLowerCase();
  if (!lowerUrl.includes("/article/manage/")) {
    return false;
  }

  const hasTabs = entries.some((entry) => isArticleManageTabEntry(entry));
  const hasDraftEntries = entries.some((entry) => isArticleManageDraftEntry(entry));
  return hasTabs && hasDraftEntries;
}

export function hasArticleEditorSurfaceSignals(entries: SnapshotEntry[], pageUrl: string): boolean {
  const lowerUrl = pageUrl.toLowerCase();
  if (!lowerUrl.includes("/article/")) {
    return false;
  }

  const hasTitle = entries.some((entry) => isInputEntry(entry) && /^title$/i.test(entry.name));
  const hasBody = entries.some((entry) => isInputEntry(entry) && /^article editor content$/i.test(entry.name));
  const hasArticleChrome = entries.some((entry) => isArticleEditorButtonEntry(entry));
  return hasTitle && hasBody && hasArticleChrome;
}
