import type { SnapshotEntry } from "../../types.js";

export const INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "textarea"]);

export function isInputEntry(entry: SnapshotEntry): boolean {
  return INPUT_ROLES.has(entry.role);
}
