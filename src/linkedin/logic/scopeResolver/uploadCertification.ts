import { findVisibleScopeInspectionByHandle } from "../contracts/visibleScope.js";
import type { CurrentSurfaceContext, RuntimeVisibleScopeInspection } from "../surface/currentSurfaceTypes.js";
import {
  ARTICLE_EDITOR_PATH_PATTERN,
  CERTIFIED_COMPOSER_SURFACES,
  CERTIFIED_MESSAGING_THREAD_PATH_PATTERN,
  type CertifiedUploadPublicScope,
} from "./shared.js";
import { hasAvailableScope, hasInlineCompanyComposer, normalizeScope, resolveFrozenPublicScope } from "./normalize.js";

export function resolveCertifiedUploadPublicScope(
  context: CurrentSurfaceContext,
  scope: string | undefined,
): CertifiedUploadPublicScope | undefined {
  if (context.surface === "composer-media-modal" && ARTICLE_EDITOR_PATH_PATTERN.test(context.pageUrl)) {
    const normalizedScope = normalizeScope(scope);
    if (normalizedScope === undefined || normalizedScope === "composerModal" || normalizedScope === "modal") {
      return hasAvailableScope(context, "composerModal") ? "composerModal" : undefined;
    }
    return undefined;
  }

  if (context.surface !== "messaging-thread") {
    const inlineCompanyComposer = hasInlineCompanyComposer(context);
    if (!CERTIFIED_COMPOSER_SURFACES.has(context.surface) && !inlineCompanyComposer) {
      return undefined;
    }

    const normalizedScope = normalizeScope(scope);
    if (!normalizedScope) {
      return hasAvailableScope(context, "composerInput") ? "composerInput" : undefined;
    }

    if (normalizedScope === "composerInput" || normalizedScope === "composerModal") {
      const publicScope = resolveFrozenPublicScope(context, normalizedScope);
      if (publicScope === normalizedScope) {
        return publicScope;
      }

      if (inlineCompanyComposer) {
        return hasAvailableScope(context, "composerInput") ? "composerInput" : undefined;
      }

      return undefined;
    }

    if (normalizedScope === "composer") {
      if (hasAvailableScope(context, "composerInput")) {
        return "composerInput";
      }

      return hasAvailableScope(context, "composerModal") ? "composerModal" : undefined;
    }

    if (normalizedScope === "modal") {
      if (context.surface === "composer-media-modal") {
        return hasAvailableScope(context, "composerModal") ? "composerModal" : undefined;
      }

      return hasAvailableScope(context, "composerInput") ? "composerInput" : undefined;
    }

    if (inlineCompanyComposer && normalizedScope === "header") {
      return hasAvailableScope(context, "composerInput") ? "composerInput" : undefined;
    }

    return undefined;
  }

  if (!CERTIFIED_MESSAGING_THREAD_PATH_PATTERN.test(context.pageUrl)) {
    return undefined;
  }

  const publicScope = resolveFrozenPublicScope(context, scope ?? "threadInput");
  if (publicScope !== "threadInput") {
    return undefined;
  }

  return hasAvailableScope(context, "threadInput") ? "threadInput" : undefined;
}

export function resolveCertifiedUploadVisibleScope(
  context: CurrentSurfaceContext,
): RuntimeVisibleScopeInspection | undefined {
  if (context.surface === "messaging-thread") {
    return findVisibleScopeInspectionByHandle(context.visibleScopeInspections, "threadInput");
  }

  if (context.surface === "composer-modal") {
    return (
      context.visibleScopeInspections?.find((inspection) => inspection.scope.kind === "composer") ??
      findVisibleScopeInspectionByHandle(context.visibleScopeInspections, "composer")
    );
  }

  if (context.surface === "composer-media-modal") {
    return (
      context.visibleScopeInspections?.find((inspection) => inspection.scope.kind === "composerMedia") ??
      findVisibleScopeInspectionByHandle(context.visibleScopeInspections, "modal")
    );
  }

  if (hasInlineCompanyComposer(context)) {
    return findVisibleScopeInspectionByHandle(context.visibleScopeInspections, "header");
  }

  return undefined;
}
