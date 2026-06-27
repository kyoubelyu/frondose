import {
  classifyUploadVisibleScopeKind,
  findVisibleScopeInspectionByHandle,
  parseVisibleControlRef,
  resolveVisibleScopeKind,
} from "../contracts/visibleScope.js";
import { isMinimalPublicScopeId } from "../contracts/minimalPublicContract.js";
import type { CurrentSurfaceContext, RuntimeVisibleScopeInspection } from "../surface/currentSurfaceTypes.js";
import {
  buildVisibleScopeSignature,
  CLICKABLE_ROLES,
  CommandAmbiguousTargetError,
  CommandInvalidInputError,
  CommandNotFoundError,
  INPUT_ROLES,
  isMediaAttachedHeaderScope,
  isVolatileVisibleScopeHandle,
  SEARCH_FILTER_LABELS,
  selectorExpressionForEntry,
  selectorExpressionForToken,
  UPLOAD_TRIGGER_PATTERNS,
  type ResolveScopedTargetInput,
  type ResolveScopedTargetResult,
} from "./shared.js";
import {
  captureScopedContext,
  ensureScopeAvailable,
  isVisibleScopeHandle,
  normalizeLabel,
  normalizeRef,
  normalizeScope,
  throwOutsideFrozenPublicBoundary,
  uploadCertificationCandidates,
  type CaptureCurrentSurfaceContext,
} from "./normalize.js";
import { resolveCertifiedUploadPublicScope, resolveCertifiedUploadVisibleScope } from "./uploadCertification.js";
import {
  buildAmbiguityCandidates,
  defaultInputCandidates,
  entryMatchesKind,
  entryMatchesScope,
  matchesLabel,
  resolveEntryPublicScope,
} from "./entryMatching.js";

export interface ResolveScopedTargetOptions {
  context?: CurrentSurfaceContext;
  captureCurrentSurfaceContext?: CaptureCurrentSurfaceContext;
}

const AMBIGUOUS_SCOPE_LABEL_HINTS: ReadonlyMap<string, { label: string; reason: string }> = new Map([
  [
    "threadInput",
    {
      label: "Write a message…",
      reason: "LinkedIn's new-message compose pane exposes both the recipient picker and the message body input",
    },
  ],
]);

function formatAmbiguousInputMessage(
  kind: string,
  candidateLabel: string,
  scope: string | undefined,
  candidateLabels: string[],
  options: { reinspectHint?: boolean } = {},
): string {
  const scopeFragment = scope ? ` within scope "${scope}"` : "";
  const uniqueLabels = Array.from(new Set(candidateLabels.filter((label) => label.length > 0)));
  const listed = uniqueLabels
    .slice(0, 3)
    .map((label) => `"${label}"`)
    .join(", ");
  const labelsFragment = uniqueLabels.length > 0 ? ` Matching ${kind}s: ${listed}.` : "";

  const scopeHint = scope ? AMBIGUOUS_SCOPE_LABEL_HINTS.get(scope) : undefined;
  const scopeSteer = scopeHint
    ? ` ${scopeHint.reason} — retry with --label "${scopeHint.label}" to target the intended input.`
    : " Retry with --label matching the exact text above.";

  const reinspectSteer = options.reinspectHint
    ? ` Re-run inspect on "${scope}" and retry with --ref from controls[].ref if label resolution still fails.`
    : "";

  const docHint =
    scope === "threadInput"
      ? " See references/surface-messaging.md §Thread composer."
      : " See references/cli-primitives.md §type.";

  return `The ${kind} target "${candidateLabel}"${scopeFragment} is ambiguous.${labelsFragment}${scopeSteer}${reinspectSteer}${docHint}`;
}

function visibleScopeControlsMatchKind(
  visibleScope: RuntimeVisibleScopeInspection,
  kind: ResolveScopedTargetInput["kind"],
) {
  if (kind === "button") {
    return visibleScope.controls.filter((control) => CLICKABLE_ROLES.has(control.role));
  }

  if (kind === "input") {
    return visibleScope.controls.filter((control) => INPUT_ROLES.has(control.role));
  }

  return [];
}

function defaultVisibleInputCandidates(
  controls: RuntimeVisibleScopeInspection["controls"],
): RuntimeVisibleScopeInspection["controls"] {
  const nonSearch = controls.filter((control) => !/search/i.test(control.label));
  return nonSearch.length > 0 ? nonSearch : controls;
}

function defaultUploadTrigger(
  context: CurrentSurfaceContext,
  visibleScope: RuntimeVisibleScopeInspection,
): RuntimeVisibleScopeInspection["controls"][number] | undefined {
  const controls = visibleScopeControlsMatchKind(visibleScope, "button");
  let patterns = UPLOAD_TRIGGER_PATTERNS.composer;
  const uploadScopeClass = classifyUploadVisibleScopeKind(
    resolveVisibleScopeKind(context.summary.visibleScopes, visibleScope.scope.handle) ?? visibleScope.scope.kind,
  );

  if (uploadScopeClass === "thread") {
    patterns = UPLOAD_TRIGGER_PATTERNS.thread;
  } else if (uploadScopeClass === "mediaModal" || context.surface === "composer-media-modal") {
    patterns = UPLOAD_TRIGGER_PATTERNS.mediaModal;
  }

  for (const pattern of patterns) {
    const matched = controls.find((control) => pattern.test(control.label));
    if (matched) {
      return matched;
    }
  }

  return undefined;
}

const ARTICLE_EDITOR_UPLOAD_ADVICE =
  'Upload on the article editor requires clicking "Upload from computer" first to open the cover image modal, then running upload from the resulting modal.';

const LABEL_NOT_FOUND_REINSPECT_HINT =
  " Re-run inspect first to confirm the label is visible, then retry with the exact label text from the output.";

const UPLOAD_SURFACE_MISMATCH_MESSAGE = (surface: string) =>
  `Upload is only certified on a full /messaging/thread/... page with --scope threadInput or on the full post composer with --scope composerInput (current surface: "${surface}"). ` +
  `If on the feed, click "Start a post" to open the composer, then retry. ` +
  `If LinkedIn's Add media dialog is open, click Back or dismiss it before uploading.`;

function resolveUploadTarget(
  context: CurrentSurfaceContext,
  scope: string | undefined,
  label: string | undefined,
  ref: string | undefined,
): ResolveScopedTargetResult {
  const certifiedUploadScope = resolveCertifiedUploadPublicScope(context, scope);
  if (!certifiedUploadScope) {
    if (context.surface === "article-editor") {
      throw new CommandNotFoundError(ARTICLE_EDITOR_UPLOAD_ADVICE, [
        { label: "Upload from computer", scope: "articleEditor" },
      ]);
    }
    throw new CommandNotFoundError(UPLOAD_SURFACE_MISMATCH_MESSAGE(context.surface), uploadCertificationCandidates());
  }

  const visibleScope = resolveCertifiedUploadVisibleScope(context);
  if (!visibleScope) {
    throw new CommandNotFoundError(
      "LinkedIn did not expose a certified upload host on the current surface.",
      uploadCertificationCandidates(),
    );
  }

  if (label || ref) {
    const resolved = resolveVisibleScopeTarget(
      context,
      {
        kind: "button",
        label,
        ref,
        scope: visibleScope.scope.handle,
      },
      visibleScope.scope.handle,
      label,
      ref,
    );
    return {
      context: resolved.context,
      target: {
        ...resolved.target,
        kind: "upload",
        scope: visibleScope.scope.handle,
      },
    };
  }

  const trigger = defaultUploadTrigger(context, visibleScope);
  if (trigger) {
    const selectorToken = trigger.selectorRef ?? trigger.ref;
    if (selectorToken) {
      return {
        context,
        target: {
          kind: "upload",
          selector: selectorExpressionForToken(selectorToken),
          ref: trigger.ref,
          label: trigger.label,
          role: trigger.role,
          scope: visibleScope.scope.handle,
          preferDirect: true,
        },
      };
    }
  }

  if (isMediaAttachedHeaderScope(visibleScope)) {
    throw new CommandNotFoundError(
      'Media is already attached to the composer. Remove it first (click "Remove media"), then retry upload.',
    );
  }

  throw new CommandNotFoundError(
    "LinkedIn did not expose a certified upload trigger on the current surface. Re-run inspect and retry with --ref when the target is visible.",
    uploadCertificationCandidates(),
  );
}

function resolveEntryTarget(
  context: CurrentSurfaceContext,
  input: ResolveScopedTargetInput,
  scope: string | undefined,
  label: string | undefined,
  ref: string | undefined,
): ResolveScopedTargetResult {
  let matchedEntries = context.entries.filter((entry) => entryMatchesKind(entry, input.kind));

  if (ref) {
    matchedEntries = matchedEntries.filter((entry) => entry.ref === ref);
  }

  if (label) {
    matchedEntries = matchedEntries.filter((entry) => matchesLabel(entry, label));
  }
  matchedEntries = matchedEntries.filter((entry) => entryMatchesScope(context, scope, entry));

  if (input.kind === "input" && !label && !ref && matchedEntries.length > 1) {
    matchedEntries = defaultInputCandidates(matchedEntries);
  }

  if (matchedEntries.length === 0) {
    const description = ref
      ? `ref "${ref}"${scope ? ` within scope "${scope}"` : ""}`
      : label
        ? `"${label}"${scope ? ` within scope "${scope}"` : ""}`
        : `a scoped ${input.kind}`;
    throw new CommandNotFoundError(
      `Unable to resolve ${description} on the current LinkedIn surface.${LABEL_NOT_FOUND_REINSPECT_HINT}`,
    );
  }

  if (matchedEntries.length > 1) {
    const candidateLabel = label ?? matchedEntries[0]?.name ?? input.kind;
    throw new CommandAmbiguousTargetError(
      formatAmbiguousInputMessage(
        input.kind,
        candidateLabel,
        scope,
        matchedEntries.map((entry) => entry.name),
      ),
      buildAmbiguityCandidates(context, candidateLabel, scope, matchedEntries, input.kind),
    );
  }

  const entry = matchedEntries[0];
  if (!entry) {
    throw new CommandNotFoundError(`Unable to resolve ${input.kind} target on the current LinkedIn surface.`);
  }
  const publicScope = resolveEntryPublicScope(context, entry, input.kind, scope);
  if (!publicScope) {
    throwOutsideFrozenPublicBoundary(context, `Resolved ${input.kind} target "${entry.name || label || input.kind}"`);
  }

  return {
    context,
    target: {
      kind: input.kind,
      selector: selectorExpressionForEntry(entry),
      ref: entry.ref,
      label: entry.name || label || input.kind,
      role: entry.role,
      scope: publicScope,
      preferDirect: true,
    },
  };
}

function resolveVisibleScopeTarget(
  context: CurrentSurfaceContext,
  input: ResolveScopedTargetInput,
  scope: string,
  label: string | undefined,
  ref: string | undefined,
): ResolveScopedTargetResult {
  const visibleScope = findVisibleScopeInspectionByHandle(context.visibleScopeInspections, scope);
  if (!visibleScope) {
    const handles = (context.visibleScopeInspections ?? []).map((inspection) => ({
      label: inspection.scope.handle,
    }));
    throw new CommandNotFoundError(
      `Scope "${scope}" is not available on the current LinkedIn surface.`,
      handles.length > 0 ? handles : undefined,
    );
  }

  let matchedControls = visibleScopeControlsMatchKind(visibleScope, input.kind);
  const parsedRef = ref ? parseVisibleControlRef(ref) : null;

  if (ref) {
    matchedControls = matchedControls.filter((control) => control.ref === ref || control.selectorRef === ref);
    if (matchedControls.length === 0 && parsedRef && parsedRef.handle === scope) {
      const allControls = visibleScopeControlsMatchKind(visibleScope, input.kind);
      const indexedControl = allControls[parsedRef.controlIndex - 1];
      if (indexedControl && indexedControl.role === parsedRef.role && indexedControl.label === parsedRef.label) {
        matchedControls = [indexedControl];
      } else {
        const labelMatchedControls = allControls.filter(
          (control) => control.role === parsedRef.role && control.label === parsedRef.label,
        );
        const occurredControl = labelMatchedControls[parsedRef.labelOccurrence - 1];
        if (occurredControl) {
          matchedControls = [occurredControl];
        }
      }
    }
  }

  if (input.kind === "input" && !label && !ref) {
    matchedControls = defaultVisibleInputCandidates(matchedControls);
  }

  if (label) {
    matchedControls = matchedControls.filter((control) => {
      return control.label.trim().toLowerCase() === label.toLowerCase();
    });
  }

  if (matchedControls.length === 0) {
    const description = ref
      ? `ref "${ref}" within scope "${scope}"`
      : label
        ? `"${label}" within scope "${scope}"`
        : `a scoped ${input.kind}`;
    throw new CommandNotFoundError(
      `Unable to resolve ${description} on the current LinkedIn surface.${LABEL_NOT_FOUND_REINSPECT_HINT}`,
    );
  }

  if (matchedControls.length > 1) {
    const candidateLabel = label ?? matchedControls[0]?.label ?? input.kind;
    throw new CommandAmbiguousTargetError(
      formatAmbiguousInputMessage(
        input.kind,
        candidateLabel,
        scope,
        matchedControls.map((control) => control.label),
        { reinspectHint: true },
      ),
    );
  }

  const control = matchedControls[0];
  if (!control || !control.ref) {
    throw new CommandNotFoundError(
      `LinkedIn did not expose a stable ref for "${control?.label ?? input.kind}" within scope "${scope}".`,
    );
  }

  const volatileScopeSignature = isVolatileVisibleScopeHandle(visibleScope.scope.handle)
    ? buildVisibleScopeSignature(visibleScope)
    : undefined;

  return {
    context,
    target: {
      kind: input.kind,
      selector: selectorExpressionForToken(control.selectorRef ?? control.ref),
      ref: control.ref,
      label: control.label,
      role: control.role,
      scope,
      preferDirect: true,
      ...(volatileScopeSignature ? { volatileScopeSignature } : {}),
    },
  };
}

function shouldPreferSearchFilters(
  context: CurrentSurfaceContext,
  input: ResolveScopedTargetInput,
  scope: string | undefined,
  label: string | undefined,
): boolean {
  return (
    input.kind === "button" &&
    context.surface === "search" &&
    (!scope || scope === "searchResults" || scope === "searchFilters") &&
    Boolean(label && SEARCH_FILTER_LABELS.has(label.toLowerCase())) &&
    Boolean(findVisibleScopeInspectionByHandle(context.visibleScopeInspections, "searchFilters"))
  );
}

function isResolveOptions(
  value: CurrentSurfaceContext | ResolveScopedTargetOptions | undefined,
): value is ResolveScopedTargetOptions {
  return Boolean(value && !("entries" in value));
}

async function resolveContext(
  scope: string | undefined,
  contextArg: CurrentSurfaceContext | ResolveScopedTargetOptions | undefined,
): Promise<CurrentSurfaceContext> {
  if (!contextArg) {
    return captureScopedContext(scope);
  }

  if (isResolveOptions(contextArg)) {
    return contextArg.context ?? captureScopedContext(scope, contextArg.captureCurrentSurfaceContext);
  }

  return contextArg;
}

export async function resolveScopedTarget(
  input: ResolveScopedTargetInput,
  contextArg?: CurrentSurfaceContext | ResolveScopedTargetOptions,
): Promise<ResolveScopedTargetResult> {
  const scope = normalizeScope(input.scope);
  const context = await resolveContext(scope, contextArg);
  const label = normalizeLabel(input.label);
  const ref = normalizeRef(input.ref);
  const parsedVisibleRef = ref ? parseVisibleControlRef(ref) : null;

  ensureScopeAvailable(context, scope);

  if (input.kind !== "upload" && !label && !ref && input.kind !== "input") {
    throw new CommandInvalidInputError(`The ${input.kind} command requires a target label or --ref.`);
  }

  if (input.kind === "upload") {
    return resolveUploadTarget(context, scope, label, ref);
  }

  if (shouldPreferSearchFilters(context, input, scope, label)) {
    return resolveVisibleScopeTarget(context, input, "searchFilters", label, ref);
  }

  if (parsedVisibleRef && isVisibleScopeHandle(context, parsedVisibleRef.handle)) {
    const resolved = resolveVisibleScopeTarget(context, input, parsedVisibleRef.handle, label, ref);
    return {
      context: resolved.context,
      target: {
        ...resolved.target,
      },
    };
  }

  if (scope && !isMinimalPublicScopeId(scope) && isVisibleScopeHandle(context, scope)) {
    const resolved = resolveVisibleScopeTarget(context, input, scope, label, ref);
    return {
      context: resolved.context,
      target: resolved.target,
    };
  }

  return resolveEntryTarget(context, input, scope, label, ref);
}
