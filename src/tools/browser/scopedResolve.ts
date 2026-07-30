// NATIVE-PORT SLICE 4 — flag-gated tool-layer wire-in to the Slice-1 logic-layer scope
// resolver (`resolveScopedTarget`). OFF by default; selected by FRONDOSE_SCOPED_RESOLVE=on,
// mirroring the proven S2 FRONDOSE_PUBLISH_VIA_ACTION / DETERMINISTIC_POST_PUBLISH pattern.
// When the flag is unset the tools keep their verbatim `resolveByLabel(WithRetry)` path
// (ZERO runtime change). No child_process — this stays within the no-bash tool boundary
// (imports are the pure logic layer + CDP client type + the FRONDOSE_ env reader only).

import type { CdpClient } from "../../cdp/client.js";
import { frondoseEnv } from "../../env.js";
import { rankAmbiguousMatches } from "../../linkedin/labelResolver.js";
import {
  buildOutwardActionAdvice,
  classifyClickDescriptor,
  classifyTypeDescriptor,
  type OutwardActionAdvice,
} from "../../linkedin/logic/outwardAction.js";
import { CommandAmbiguousTargetError, type ResolvedTarget } from "../../linkedin/logic/scopeResolver/shared.js";
import { resolveScopedTarget } from "../../linkedin/logic/scopeResolver/targetResolution.js";
import { captureCurrentSurfaceContext as captureLogicSurfaceContext } from "../../linkedin/logic/surface/currentSurface.js";
import type { CurrentSurfaceContext as LogicSurfaceContext } from "../../linkedin/logic/surface/currentSurfaceTypes.js";
import { inferSurface } from "../../linkedin/scopeResolver.js";
import type { CurrentSurfaceContext as RuntimeSurfaceContext, SnapshotEntry } from "../../linkedin/types.js";

// Blueprint §Slice-3/4: poll the scope-ready window 5×250ms (same budget the connect/publish
// action runtimes use). resolveScopedTarget / captureScopedContext own this retry — do NOT
// double-wrap it in the tool.
const SCOPE_READY_ATTEMPTS = 5;
const SCOPE_READY_RETRY_MS = 250;

/** Slice-4 kill-switch. UNSET / anything-but-"on" ⇒ the legacy labelResolver path. */
export function scopedResolveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return frondoseEnv("SCOPED_RESOLVE", env) === "on";
}

export interface ScopedToolResolution {
  /** `@e{N}` AX ref (preferred) — else the CSS selector for a `.ref`-absent synthesized control. */
  target: string;
  /** Synthesized runtime entry (ref + role + accessible name) so the outbound guard classifies
   *  the resolved element identically to the label path — the resolver's matched `.label` IS the
   *  element's accessible name. */
  targetEntry: SnapshotEntry;
  /** True when `resolveScopedTarget` returned no `.ref` (visible-scope selector-only control). */
  selectorOnly: boolean;
  /** The resolver's captured logic context, adapted to the runtime shape so `setLastContext`
   *  keeps the outbound guard + ref-stale re-validation on the SAME surface + entries. */
  runtimeContext: RuntimeSurfaceContext;
  /** The resolver's own logic context — for advice classification (needs the rich summary). */
  logicContext: LogicSurfaceContext;
  /** The raw resolved target (label / role / scope / selector / ref). */
  resolvedTarget: ResolvedTarget;
  /** [P-FIX-TYPEAHEAD-TARGETING] set when the pick was tie-broken out of the scoped resolver's
   *  ambiguous candidate set by the fallback below (undefined on a direct resolution). */
  disambiguated?: boolean;
  candidatesCount?: number;
  method?: "startsWith" | "roleFamily";
}

function normalizeRef(ref: string): string {
  return ref.startsWith("@") ? ref : `@${ref}`;
}

/** [P-FIX-TYPEAHEAD-TARGETING] Ambiguous-scoped-resolution fallback. The scoped resolver's
 *  CommandAmbiguousTargetError already carries the SCOPE-FILTERED candidate set — rank ONLY
 *  those (never a fresh full-surface re-resolve, which could escape the requested scope).
 *  Candidate→entry mapping is unique + scope-bound or the candidate is dropped; anything
 *  other than exactly one ranked survivor rethrows the ORIGINAL error. */
async function resolveFromAmbiguousCandidates(
  client: CdpClient,
  kind: "button" | "input",
  label: string | undefined,
  scope: string | undefined,
  err: CommandAmbiguousTargetError,
): Promise<ScopedToolResolution> {
  const candidates = err.candidates ?? [];
  if (!label || candidates.length === 0) throw err;
  // Mapping-only capture: the throw path carries no context, so capture fresh — candidate
  // refs may have churned, and unmatched candidates are simply excluded (fail-closed).
  const ctx = await captureLogicSurfaceContext(client);
  const needle = label.toLowerCase();
  const inScope = (entry: { ref?: string; selector?: string }): boolean => {
    if (!scope) return true;
    const vsi = ctx.visibleScopeInspections?.find((v) => v.scope.handle === scope);
    if (!vsi) return true; // scope not covered by inspections → entries are the scope
    return vsi.controls.some(
      (c) =>
        (c.ref && entry.ref && c.ref === entry.ref) || // ref-to-ref
        (c.selectorRef && entry.selector && c.selectorRef === entry.selector), // selector-to-selector
    );
  };
  const mapped: Array<{
    cand: { label?: string; scope?: string; ref?: string };
    entry: LogicSurfaceContext["entries"][number];
  }> = [];
  for (const cand of candidates) {
    const ref = cand.ref ? normalizeRef(cand.ref) : undefined;
    let entry: LogicSurfaceContext["entries"][number] | undefined;
    if (ref) {
      // Ref-present candidates map by EXACT ref only — never a label fallback.
      entry = ctx.entries.find((en) => en.ref === ref);
    } else {
      // Ref-less candidates: capture-wide UNIQUE exact-label match, selector-bearing, in-scope.
      const byLabel = ctx.entries.filter((en) => en.name === cand.label);
      const only = byLabel.length === 1 ? byLabel[0] : undefined;
      if (only?.selector && inScope(only)) entry = only;
    }
    if (entry) mapped.push({ cand: { ...cand, ref }, entry });
  }
  const ranked = rankAmbiguousMatches(
    mapped.map((m) => m.entry),
    needle,
  );
  if (!ranked.entry || !ranked.method) throw err;
  const winner = mapped.find((m) => m.entry === ranked.entry);
  if (!winner) throw err;
  const { cand, entry } = winner;
  const target = cand.ref ?? entry.selector;
  if (!target) throw err; // string-guaranteed target — never dispatch a missing one
  return {
    target,
    selectorOnly: !cand.ref,
    targetEntry: { ref: target, role: entry.role, name: cand.label ?? entry.name },
    runtimeContext: logicToRuntimeContext(ctx),
    logicContext: ctx,
    resolvedTarget: {
      kind,
      selector: entry.selector ?? "",
      ...(cand.ref ? { ref: cand.ref } : {}),
      label: cand.label ?? "",
      role: entry.role,
      ...(cand.scope ? { scope: cand.scope } : {}),
    },
    disambiguated: true,
    candidatesCount: candidates.length,
    method: ranked.method,
  };
}

/** Adapt a logic-layer context into the runtime `CurrentSurfaceContext` the session stores.
 *  - `surface`: recomputed via the RUNTIME `inferSurface(pageUrl)` so the outbound-guard surface
 *    check is byte-for-byte identical to the labelResolver path (which reads a runtime capture).
 *  - `activeLayer`: logic "page" stays "page"; "modal"/"thread" collapse to runtime "overlay".
 *  - `entries`: logic SnapshotEntry ⊇ runtime SnapshotEntry (adds optional selector/value) — the
 *    same refs the resolver matched, so no re-snapshot / ref-renumber risk. */
function logicToRuntimeContext(ctx: LogicSurfaceContext): RuntimeSurfaceContext {
  return {
    pageUrl: ctx.pageUrl,
    surface: inferSurface(ctx.pageUrl),
    activeLayer: ctx.activeLayer === "page" ? "page" : "overlay",
    entries: ctx.entries,
  };
}

/** Flag-on resolution: route the tool's (label, scope) through the logic-layer scope resolver
 *  and adapt the result back into exactly what the labelResolver path feeds downstream. */
export async function resolveScopedForTool(
  client: CdpClient,
  kind: "button" | "input",
  label: string | undefined,
  scope: string | undefined,
): Promise<ScopedToolResolution> {
  let resolved: Awaited<ReturnType<typeof resolveScopedTarget>>;
  try {
    resolved = await resolveScopedTarget(
      { kind, ...(label ? { label } : {}), ...(scope ? { scope } : {}) },
      {
        captureCurrentSurfaceContext: () => captureLogicSurfaceContext(client),
        scopeReadyAttempts: SCOPE_READY_ATTEMPTS,
        scopeReadyRetryMs: SCOPE_READY_RETRY_MS,
      },
    );
  } catch (e) {
    // [P-FIX-TYPEAHEAD-TARGETING] ambiguous scoped resolution → rank ONLY the caught
    // already-scoped candidates; anything else (and any fallback miss) rethrows as-is.
    if (e instanceof CommandAmbiguousTargetError) {
      return resolveFromAmbiguousCandidates(client, kind, label, scope, e);
    }
    throw e;
  }
  const rt = resolved.target;
  const hasRef = typeof rt.ref === "string" && rt.ref.trim().length > 0;
  // Prefer the `@e{N}` ref so the existing getBox/clickAt/outbound-guard chain is unchanged;
  // fall back to the CSS selector only for a synthesized visible-scope control with no ref.
  const target = hasRef ? normalizeRef(rt.ref as string) : rt.selector;
  const targetEntry: SnapshotEntry = { ref: target, role: rt.role, name: rt.label };
  return {
    target,
    targetEntry,
    selectorOnly: !hasRef,
    runtimeContext: logicToRuntimeContext(resolved.context),
    logicContext: resolved.context,
    resolvedTarget: rt,
  };
}

/** Success-envelope advice for a click, classified from the resolved target + logic context.
 *  Returns [] for non-outbound targets (additive — the envelope is unchanged when empty). */
export function buildScopedClickAdvice(
  logicContext: LogicSurfaceContext,
  resolvedTarget: ResolvedTarget,
): OutwardActionAdvice[] {
  const classification = classifyClickDescriptor(logicContext, {
    label: resolvedTarget.label,
    role: resolvedTarget.role,
    scope: resolvedTarget.scope,
  });
  return buildOutwardActionAdvice(classification, logicContext);
}

/** Success-envelope advice for a type, classified from the resolved target + logic context. */
export function buildScopedTypeAdvice(
  logicContext: LogicSurfaceContext,
  resolvedTarget: ResolvedTarget,
): OutwardActionAdvice[] {
  const classification = classifyTypeDescriptor(logicContext, {
    label: resolvedTarget.label,
    role: resolvedTarget.role,
    scope: resolvedTarget.scope,
  });
  return buildOutwardActionAdvice(classification, logicContext);
}
