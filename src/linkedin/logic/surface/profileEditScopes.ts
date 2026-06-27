import type { SnapshotEntry } from "./currentSurfaceTypes.js";

export function isProfileEditIntroUrl(pageUrl: string): boolean {
  return /\/in\/[^/]+\/edit\/intro\/?/i.test(pageUrl);
}

const PROFILE_EDIT_INTRO_INPUT_ROLES = new Set(["textbox", "combobox", "searchbox", "textarea"]);

function isProfileEditIntroFormButton(entry: SnapshotEntry): boolean {
  return entry.role === "button" && /^(save|dismiss|discard)$/i.test(entry.name.trim());
}

export function collectProfileEditIntroFormEntries(
  entries: SnapshotEntry[],
  topNavEntries: SnapshotEntry[],
): SnapshotEntry[] {
  const topNavRefs = new Set(topNavEntries.map((entry) => entry.ref));
  return entries.filter((entry) => {
    if (topNavRefs.has(entry.ref)) {
      return false;
    }
    if (PROFILE_EDIT_INTRO_INPUT_ROLES.has(entry.role)) {
      return true;
    }
    return isProfileEditIntroFormButton(entry);
  });
}

export function isMainProfileUrl(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl);
    return /^\/in\/[^/]+\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isEditAboutLinkEntry(entry: SnapshotEntry): boolean {
  return entry.role === "link" && /^edit about$/i.test(entry.name.trim());
}

export function collectAboutSectionEntries(entries: SnapshotEntry[]): SnapshotEntry[] {
  const anchorIndex = entries.findIndex((entry) => isEditAboutLinkEntry(entry));
  if (anchorIndex < 0) {
    return [];
  }

  const anchor = entries[anchorIndex];
  if (!anchor) {
    return [];
  }
  const collected: SnapshotEntry[] = [anchor];
  const maxLookback = 16;
  for (let i = anchorIndex - 1, hops = 0; i >= 0 && hops < maxLookback; i -= 1, hops += 1) {
    const entry = entries[i];
    if (!entry) {
      break;
    }
    if (
      entry.role === "paragraph" ||
      entry.role === "text" ||
      entry.role === "generic" ||
      (entry.role === "heading" && /^about$/i.test(entry.name.trim()))
    ) {
      collected.unshift(entry);
      if (entry.role === "heading") {
        break;
      }
    } else {
      break;
    }
  }
  return collected;
}
