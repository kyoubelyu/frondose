import type { SnapshotEntry } from "../../types.js";

export function isActorSelectionModalEntry(entry: SnapshotEntry): boolean {
  const normalized = entry.name.trim();
  if (!normalized) {
    return false;
  }

  if (entry.role === "button" && /^(dismiss|save selection)$/i.test(normalized)) {
    return true;
  }

  return (
    (entry.role === "radio" || entry.role === "button" || entry.role === "checkbox" || entry.role === "link") &&
    /^select\s+.+/i.test(normalized)
  );
}

export function hasActorSelectionModalSurfaceSignals(entries: SnapshotEntry[]): boolean {
  const hasSaveSelection = entries.some((entry) => entry.role === "button" && /^save selection$/i.test(entry.name));
  const hasDismiss = entries.some((entry) => entry.role === "button" && /^dismiss$/i.test(entry.name));
  const selectionEntries = entries.filter(
    (entry) =>
      (entry.role === "radio" || entry.role === "button" || entry.role === "checkbox" || entry.role === "link") &&
      /^select\s+.+/i.test(entry.name),
  );

  return hasSaveSelection && selectionEntries.length > 0 && (hasDismiss || selectionEntries.length > 1);
}
