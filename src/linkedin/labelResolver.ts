import { CLICKABLE_ROLES, INPUT_ROLES } from "./inspectSummary.js";
import type { SnapshotEntry } from "./types.js";

export interface LabelResolveOpts {
  kind: "click" | "type";
  scope?: string;
  activeLayer?: "page" | "overlay";
}

// P-AUTO-16 OUT-6: inspectSummary.ts:199 decorates outbound action labels with a
// "[OUTBOUND] " display prefix (e.g. "[OUTBOUND] Connect"). The raw SnapshotEntry.name
// stays unprefixed, so an operator/agent who copies the displayed label trips
// resolveByLabel's includes() match. Strip a single leading "[OUTBOUND] " before the
// match so display-prefixed labels resolve identically to the raw name. The error
// messages still cite the ORIGINAL `label` (pre-strip) for operator clarity.
const OUTBOUND_DISPLAY_PREFIX_RE = /^\[OUTBOUND\]\s+/;

/** Resolve a label-based target. Throws on no match or ambiguity. */
export function resolveByLabel(entries: SnapshotEntry[], label: string, opts: LabelResolveOpts): SnapshotEntry {
  const roles = opts.kind === "click" ? CLICKABLE_ROLES : INPUT_ROLES;
  // P-AUTO-16 OUT-6: strip a single leading "[OUTBOUND] " display prefix; fall back to
  // the ORIGINAL label if the strip leaves nothing (label was literally "[OUTBOUND] "),
  // otherwise JS's "".includes(needle) semantics — every string includes "" — would
  // degrade to wrong-target / ambiguity. With the fallback, the original "[OUTBOUND] "
  // gets a clean zero-match throw against unprefixed AX names.
  const stripped = label.replace(OUTBOUND_DISPLAY_PREFIX_RE, "");
  const usable = stripped.trim().length > 0 ? stripped : label;
  const needle = usable.toLowerCase();
  const roleFiltered = entries.filter((e) => roles.has(e.role));
  const exact = roleFiltered.filter((e) => e.name.toLowerCase() === needle);
  const substr = roleFiltered.filter((e) => e.name.toLowerCase().includes(needle));
  let matches = exact.length > 0 ? exact : substr;

  if (matches.length > 1) {
    const nonAside = matches.filter((e) => e.region !== "aside");
    if (nonAside.length > 0) matches = nonAside;
  }

  if (opts.activeLayer === "overlay") {
    const overlayOnly = matches.filter((e) => e.ref.startsWith("@ov"));
    if (overlayOnly.length > 0) matches = overlayOnly;
  }

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
