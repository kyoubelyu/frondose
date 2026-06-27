import type { CommandCandidate } from "../../types.js";
import {
  findVisibleScopeByHandle,
  resolveVisibleScopeKind,
} from "../contracts/visibleScope.js";
import {
  isMinimalPublicScopeId,
  type MinimalPublicScopeId,
} from "../contracts/minimalPublicContract.js";
import type { CurrentSurfaceContext } from "../surface/currentSurfaceTypes.js";
import {
  buildVisibleScopeSignature,
  CommandNotFoundError,
  CommandRuntimeError,
  SCOPE_READY_ATTEMPTS,
  SCOPE_READY_RETRY_MS,
} from "./shared.js";

export type CaptureCurrentSurfaceContext = () => Promise<CurrentSurfaceContext>;

let configuredScopedContextCapture: CaptureCurrentSurfaceContext | undefined;

export function setScopedContextCapture(capture: CaptureCurrentSurfaceContext | undefined): void {
  configuredScopedContextCapture = capture;
}

export function normalizeLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeRef(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function hasAvailableScope(context: CurrentSurfaceContext, scopeId: string): boolean {
  return context.summary.availableScopes.some((candidate) => candidate.id === scopeId);
}

export function hasInlineCompanyComposer(context: CurrentSurfaceContext): boolean {
  return context.surface === "company" && hasAvailableScope(context, "composerInput");
}

export function normalizeScope(scope: string | undefined): string | undefined {
  if (!scope) {
    return undefined;
  }

  return scope.trim() || undefined;
}

export function publicScopeCandidates(context: CurrentSurfaceContext): CommandCandidate[] {
  return context.summary.availableScopes.map((candidate) => ({
    label: candidate.label,
    scope: candidate.id,
  }));
}

export function uploadCertificationCandidates(): CommandCandidate[] {
  return [
    { label: "Upload", scope: "threadInput" },
    { label: "Upload", scope: "composerInput" },
  ];
}

export function throwOutsideFrozenPublicBoundary(context: CurrentSurfaceContext, description: string): never {
  throw new CommandNotFoundError(
    `${description} is not a recognized action target on this LinkedIn surface. Use one of the available scopes listed in candidates.`,
    publicScopeCandidates(context),
  );
}

export function resolveFrozenPublicScope(
  context: CurrentSurfaceContext,
  scope: string | undefined,
): MinimalPublicScopeId | undefined {
  const normalizedScope = normalizeScope(scope);
  if (!normalizedScope) {
    return undefined;
  }

  if (isMinimalPublicScopeId(normalizedScope)) {
    return hasAvailableScope(context, normalizedScope) ? normalizedScope : undefined;
  }

  if (!isVisibleScopeHandle(context, normalizedScope)) {
    return undefined;
  }

  const visibleScopeKind = resolveVisibleScopeKind(context.summary.visibleScopes, normalizedScope);
  if (!visibleScopeKind || !isMinimalPublicScopeId(visibleScopeKind)) {
    return undefined;
  }

  return hasAvailableScope(context, visibleScopeKind) ? visibleScopeKind : undefined;
}

export function findVolatileVisibleScopeHandleBySignature(
  context: CurrentSurfaceContext,
  signature: string | undefined,
): string | undefined {
  if (!signature) {
    return undefined;
  }

  return context.visibleScopeInspections?.find((inspection) => {
    const handle = inspection.scope.handle;
    return Boolean(handle && /^post:\d+$/i.test(handle)) && buildVisibleScopeSignature(inspection) === signature;
  })?.scope.handle;
}

export function isVisibleScopeHandle(context: CurrentSurfaceContext, scope: string | undefined): boolean {
  return Boolean(findVisibleScopeByHandle(context.summary.visibleScopes, scope));
}

export function scopeIsAvailable(context: CurrentSurfaceContext, scope: string | undefined): boolean {
  if (!scope) {
    return true;
  }

  if (isMinimalPublicScopeId(scope)) {
    return context.summary.availableScopes.some((candidate) => candidate.id === scope);
  }

  return Boolean(
    findVisibleScopeByHandle(context.summary.visibleScopes, scope) || resolveFrozenPublicScope(context, scope),
  );
}

function modalScopeRequiresModalLayer(context: CurrentSurfaceContext, scope: string): boolean {
  if (scope === "reactionModal") {
    return true;
  }

  if (scope === "composerModal") {
    return !hasInlineCompanyComposer(context);
  }

  return false;
}

function ensureLayerCompatibleWithScope(context: CurrentSurfaceContext, scope: string | undefined): void {
  if (!scope) {
    return;
  }

  if (modalScopeRequiresModalLayer(context, scope) && context.activeLayer !== "modal") {
    throw new CommandNotFoundError(
      `Scope "${scope}" requires LinkedIn's active layer to be "modal" (current activeLayer: "${context.activeLayer}").`,
      publicScopeCandidates(context),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function captureScopedContext(
  scope: string | undefined,
  captureCurrentSurfaceContext = configuredScopedContextCapture,
): Promise<CurrentSurfaceContext> {
  if (!captureCurrentSurfaceContext) {
    throw new CommandRuntimeError(
      "captureScopedContext requires a current-surface capture function. Batch D wires this to captureCurrentSurfaceContext.",
    );
  }

  let context = await captureCurrentSurfaceContext();
  if (scopeIsAvailable(context, scope)) {
    return context;
  }

  for (let attempt = 1; attempt < SCOPE_READY_ATTEMPTS; attempt += 1) {
    await sleep(SCOPE_READY_RETRY_MS);
    context = await captureCurrentSurfaceContext();
    if (scopeIsAvailable(context, scope)) {
      return context;
    }
  }

  return context;
}

export function ensureScopeAvailable(context: CurrentSurfaceContext, scope: string | undefined): void {
  if (!scope) {
    return;
  }

  ensureLayerCompatibleWithScope(context, scope);

  if (isMinimalPublicScopeId(scope)) {
    const available = context.summary.availableScopes.some((candidate) => candidate.id === scope);
    if (!available) {
      throw new CommandNotFoundError(
        `Scope "${scope}" is not available on the current LinkedIn surface.`,
        context.summary.availableScopes.map((candidate) => ({
          label: candidate.label,
          scope: candidate.id,
        })),
      );
    }

    return;
  }

  if (!isVisibleScopeHandle(context, scope)) {
    throw new CommandNotFoundError(
      `Scope "${scope}" is not available on the current LinkedIn surface.`,
      publicScopeCandidates(context),
    );
  }
}
