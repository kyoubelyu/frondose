import { CLICKABLE_ROLES, INPUT_ROLES } from "./inspectSummary.js";
import type { SnapshotEntry } from "./types.js";

export interface LabelResolveOpts {
  kind: "click" | "type";
  scope?: string;
}

/** Resolve a label-based target. Throws on no match or ambiguity. */
export function resolveByLabel(entries: SnapshotEntry[], label: string, opts: LabelResolveOpts): SnapshotEntry {
  const roles = opts.kind === "click" ? CLICKABLE_ROLES : INPUT_ROLES;
  const needle = label.toLowerCase();
  const matches = entries.filter((e) => roles.has(e.role)).filter((e) => e.name.toLowerCase().includes(needle));

  if (matches.length === 0) {
    throw new Error(
      `resolveByLabel: no ${opts.kind} target matches '${label}'. ` +
        `Did you call inspect first? Run inspect to see available buttons/inputs.`,
    );
  }
  if (matches.length > 1) {
    const preview = matches
      .slice(0, 5)
      .map((m) => `${m.ref}="${m.name}"`)
      .join(", ");
    throw new Error(
      `resolveByLabel: ambiguous ${opts.kind} target '${label}' (${matches.length} matches). ` +
        `Candidates: ${preview}. Use a more specific label or use ref directly.`,
    );
  }
  // matches.length === 1; non-null per length check above, but appease tsc:
  const only = matches[0];
  if (!only) throw new Error("unreachable: matches.length === 1");
  return only;
}
