import { buildVisibleControlRef, type VisibleScopeKind } from "../contracts/visibleScope.js";
import type { VisibleScopeSummary } from "../contracts/inspect.js";
import { isComposerButtonEntry, isComposerEmojiEntry, isComposerInputEntry } from "./foregroundContext.js";
import type {
  RuntimeVisibleScopeControl,
  RuntimeVisibleScopeInspection,
  SnapshotEntry,
} from "./currentSurfaceTypes.js";

const INPUT_ENTRY_ROLES = new Set(["textbox", "searchbox", "combobox", "textarea"]);
const CONTROL_ENTRY_ROLES = new Set(["button", "menuitem", "link", "file-input", "checkbox", "radio", "switch", "tab"]);

export function isInputEntry(entry: SnapshotEntry): boolean {
  return INPUT_ENTRY_ROLES.has(entry.role);
}

function hasStableEntrySelector(entry: SnapshotEntry): boolean {
  return Boolean(entry.selector) || /^@?e\d+$/i.test(entry.ref);
}

function selectorTokenForEntry(entry: SnapshotEntry): string | undefined {
  if (entry.selector) {
    return entry.selector;
  }

  if (/^@?e\d+$/i.test(entry.ref)) {
    return entry.ref;
  }

  return undefined;
}

export function uniqueOrdered(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function toUncappedVisibleScopeControls(
  handle: string,
  entries: SnapshotEntry[],
): RuntimeVisibleScopeControl[] {
  const controls: RuntimeVisibleScopeControl[] = [];
  let controlIndex = 0;
  const labelCounts = new Map<string, number>();

  for (const entry of entries) {
    if (!entry.name) {
      continue;
    }

    if (!(CONTROL_ENTRY_ROLES.has(entry.role) || isInputEntry(entry))) {
      continue;
    }

    controlIndex += 1;
    const labelKey = `${entry.role}:${entry.name}`;
    const labelOccurrence = (labelCounts.get(labelKey) ?? 0) + 1;
    labelCounts.set(labelKey, labelOccurrence);
    controls.push({
      label: entry.name,
      role: entry.role,
      ...(hasStableEntrySelector(entry)
        ? { ref: buildVisibleControlRef(handle, entry.name, entry.role, controlIndex, labelOccurrence) }
        : {}),
      ...(selectorTokenForEntry(entry) ? { selectorRef: selectorTokenForEntry(entry) } : {}),
      ...(entry.value !== undefined ? { value: entry.value } : {}),
    });
  }

  return controls;
}

export function toVisibleScopeControls(handle: string, entries: SnapshotEntry[]): RuntimeVisibleScopeControl[] {
  return toUncappedVisibleScopeControls(handle, entries).slice(0, 24);
}

export function buttonsFromEntries(entries: SnapshotEntry[]): string[] {
  return uniqueOrdered(
    entries.filter((entry) => entry.role === "button" || entry.role === "switch").map((entry) => entry.name),
  ).slice(0, 16);
}

export function inputsWithValuesFromEntries(entries: SnapshotEntry[]): { inputs: string[]; inputValues: string[] } {
  const inputEntries = entries.filter((entry) => isInputEntry(entry)).slice(0, 8);
  const seen = new Set<string>();
  const inputs: string[] = [];
  const inputValues: string[] = [];

  for (const entry of inputEntries) {
    const name = entry.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    inputs.push(name);
    inputValues.push(entry.value ?? "");
  }

  return { inputs, inputValues };
}

export function inputsFromEntries(entries: SnapshotEntry[]): string[] {
  return inputsWithValuesFromEntries(entries).inputs;
}

export function previewTextFromEntries(entries: SnapshotEntry[]): string[] {
  return uniqueOrdered(entries.map((entry) => entry.name).filter(Boolean)).slice(0, 8);
}

export function uniqueEntriesByRoleAndName(entries: SnapshotEntry[]): SnapshotEntry[] {
  const seen = new Set<string>();
  const ordered: SnapshotEntry[] = [];

  for (const entry of entries) {
    const key = `${entry.role}:${entry.name}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    ordered.push(entry);
  }

  return ordered;
}

export function dedupeEntriesByRoleAndName(entries: SnapshotEntry[]): SnapshotEntry[] {
  const seen = new Set<string>();
  const deduped: SnapshotEntry[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    const key = `${entry.role}:${entry.name}`;
    if (!entry.name || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(entry);
  }

  return deduped.reverse();
}

export function dedupeEntriesByRoleAndNormalizedName(entries: SnapshotEntry[]): SnapshotEntry[] {
  const seen = new Set<string>();
  const deduped: SnapshotEntry[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || !entry.name) {
      continue;
    }

    const normalizedName = entry.name.replace(/\s+/g, " ").trim().toLowerCase();
    const key = `${entry.role}:${normalizedName}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(entry);
  }

  return deduped.reverse();
}

export function activeComposerEntries(entries: SnapshotEntry[]): SnapshotEntry[] {
  const anchorIndex = entries.findIndex((entry) => isComposerInputEntry(entry));
  if (anchorIndex < 0) {
    return [];
  }

  let startIndex = anchorIndex;
  while (startIndex - 1 >= 0) {
    const candidate = entries[startIndex - 1];
    if (!candidate || !(isComposerInputEntry(candidate) || isComposerButtonEntry(candidate))) {
      break;
    }
    startIndex -= 1;
  }

  const composerEntries = entries.slice(startIndex, anchorIndex + 1);
  for (let index = anchorIndex + 1; index < entries.length; index += 1) {
    const candidate = entries[index];
    if (!candidate) {
      continue;
    }

    if (candidate.role === "button" && /^(start a post|photo|video)$/i.test(candidate.name)) {
      break;
    }

    if (isComposerInputEntry(candidate) || isComposerButtonEntry(candidate)) {
      composerEntries.push(candidate);
      if (candidate.role === "button" && /^post$/i.test(candidate.name)) {
        break;
      }
    }
  }

  return dedupeEntriesByRoleAndNormalizedName(composerEntries);
}

export function activeComposerEntriesWithEmoji(entries: SnapshotEntry[]): SnapshotEntry[] {
  const composerEntries = activeComposerEntries(entries);
  const emojiEntries = entries.filter((entry) => isComposerEmojiEntry(entry));
  if (emojiEntries.length === 0) {
    return composerEntries;
  }

  return dedupeEntriesByRoleAndNormalizedName([...composerEntries, ...emojiEntries]);
}

export function activeComposerRefs(entries: SnapshotEntry[]): Set<string> {
  return new Set(activeComposerEntries(entries).map((entry) => entry.ref));
}

export function hasPostingComposer(entries: SnapshotEntry[]): boolean {
  const composerEntries = activeComposerEntries(entries);
  return composerEntries.some(
    (entry) =>
      entry.role === "button" &&
      /(^post$|^dismiss$|^add media$|^schedule post$|^edit media preview$|^remove media$|post to anyone|create an event|celebrate an occasion)/i.test(
        entry.name,
      ),
  );
}

export function createVisibleScopeSummary(
  handle: string,
  kind: VisibleScopeKind,
  label: string,
  parent: string | undefined,
  entries: SnapshotEntry[],
  previewText: string[],
): VisibleScopeSummary {
  const { inputs, inputValues } = inputsWithValuesFromEntries(entries);
  return {
    handle,
    kind,
    label,
    ...(parent ? { parent } : {}),
    ...(entries[0] && hasStableEntrySelector(entries[0]) ? { anchorRef: entries[0].ref } : {}),
    previewText,
    buttons: buttonsFromEntries(entries),
    inputs,
    inputValues,
    controls: toVisibleScopeControls(handle, entries),
  };
}

export function createVisibleScopeInspection(
  summary: VisibleScopeSummary,
  text: string[],
  entries: SnapshotEntry[],
  options?: { prebuiltControls?: RuntimeVisibleScopeControl[] },
): RuntimeVisibleScopeInspection {
  const controls = options?.prebuiltControls ?? toVisibleScopeControls(summary.handle, entries);
  const { inputs, inputValues } = inputsWithValuesFromEntries(entries);
  return {
    scope: {
      ...summary,
      controls,
      inputs,
      inputValues,
    },
    text,
    buttons: buttonsFromEntries(entries),
    inputs,
    controls,
  };
}

export function createVisibleScopeFromEntries(
  handle: string,
  kind: VisibleScopeKind,
  label: string,
  parent: string | undefined,
  entries: SnapshotEntry[],
  text = previewTextFromEntries(entries),
  options?: { prebuiltControls?: RuntimeVisibleScopeControl[] },
): RuntimeVisibleScopeInspection {
  return createVisibleScopeInspection(
    createVisibleScopeSummary(handle, kind, label, parent, entries, text.slice(0, 8)),
    text,
    entries,
    options,
  );
}
