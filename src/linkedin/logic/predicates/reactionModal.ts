import type { SnapshotEntry } from "../../types.js";

export function isReactionModalEntry(entry: SnapshotEntry): boolean {
  const normalized = entry.name.trim().toLowerCase();
  return (
    (entry.role === "button" &&
      (normalized === "dismiss" ||
        normalized === "load more" ||
        /^(like|celebrate|support|love|insightful|funny)$/.test(normalized) ||
        /^\d+\s+all reactions$/.test(normalized) ||
        /^\d+\s+(like|celebrate|love|support|insightful|curious)\s+reactions$/.test(normalized) ||
        /^(like|celebrate|love|support|insightful|curious)\s+\d+$/.test(normalized))) ||
    (entry.role === "link" &&
      (/ reacted with /i.test(entry.name) ||
        /^(like|celebrate|love|support|insightful|curious)\s+view .+ profile/i.test(entry.name)))
  );
}

export function hasReactionModalSurfaceSignals(entries: SnapshotEntry[]): boolean {
  const hasDismiss = entries.some((entry) => entry.role === "button" && /^dismiss$/i.test(entry.name));
  const reactionPickerButtons = entries.filter(
    (entry) => entry.role === "button" && /^(like|celebrate|support|love|insightful|funny)$/i.test(entry.name),
  );
  const reactionFilterButtons = entries.filter(
    (entry) =>
      entry.role === "button" &&
      (/^\d+\s+(.+)\s+reactions$/i.test(entry.name) ||
        /^(like|celebrate|love|support|insightful|curious)\s+\d+$/i.test(entry.name)),
  );
  const reactedLinks = entries.filter((entry) => entry.role === "link" && / reacted with /i.test(entry.name));
  const reactionProfileLinks = entries.filter(
    (entry) =>
      entry.role === "link" && /^(like|celebrate|love|support|insightful|curious)\s+view .+ profile/i.test(entry.name),
  );
  return (
    reactionPickerButtons.length >= 3 ||
    (hasDismiss && (reactionFilterButtons.length > 0 || reactedLinks.length > 0 || reactionProfileLinks.length > 0)) ||
    (reactionFilterButtons.some((entry) => /\ball reactions\b/i.test(entry.name)) &&
      (reactedLinks.length > 0 || reactionProfileLinks.length > 0))
  );
}
