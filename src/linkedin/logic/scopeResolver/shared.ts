import type { CommandCandidate, FailureKind } from "../../types.js";
import type { RuntimeVisibleScopeInspection, SnapshotEntry } from "../surface/currentSurfaceTypes.js";

export type ScopedTargetKind = "button" | "input" | "upload";

export interface ResolveScopedTargetInput {
  kind: ScopedTargetKind;
  label?: string;
  ref?: string;
  scope?: string;
}

export interface ResolvedTarget {
  kind: ScopedTargetKind;
  selector: string;
  ref?: string;
  label: string;
  role: string;
  scope?: string;
  preferDirect?: boolean;
  volatileScopeSignature?: string;
}

export interface ResolveScopedTargetResult {
  context: import("../surface/currentSurfaceTypes.js").CurrentSurfaceContext;
  target: ResolvedTarget;
}

export type CertifiedUploadPublicScope = "threadInput" | "composerInput" | "composerModal";

export class ScopedTargetResolutionError extends Error {
  readonly kind: FailureKind;
  readonly candidates?: CommandCandidate[];

  constructor(kind: FailureKind, message: string, candidates?: CommandCandidate[]) {
    super(message);
    this.name = "ScopedTargetResolutionError";
    this.kind = kind;
    if (candidates && candidates.length > 0) {
      this.candidates = candidates;
    }
  }
}

export class CommandInvalidInputError extends ScopedTargetResolutionError {
  constructor(message: string, candidates?: CommandCandidate[]) {
    super("invalid_input", message, candidates);
    this.name = "CommandInvalidInputError";
  }
}

export class CommandNotFoundError extends ScopedTargetResolutionError {
  constructor(message: string, candidates?: CommandCandidate[]) {
    super("not_found", message, candidates);
    this.name = "CommandNotFoundError";
  }
}

export class CommandAmbiguousTargetError extends ScopedTargetResolutionError {
  constructor(message: string, candidates?: CommandCandidate[]) {
    super("ambiguous_target", message, candidates);
    this.name = "CommandAmbiguousTargetError";
  }
}

export class CommandRuntimeError extends ScopedTargetResolutionError {
  constructor(message: string, candidates?: CommandCandidate[]) {
    super("runtime_error", message, candidates);
    this.name = "CommandRuntimeError";
  }
}

export const CLICKABLE_ROLES = new Set([
  "button",
  "menuitem",
  "link",
  "clickable",
  "focusable",
  "checkbox",
  "radio",
  "switch",
  "textbox",
  "searchbox",
  "combobox",
  "textarea",
]);
export const INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "textarea", "focusable"]);
export const COMPOSER_BUTTON_LABELS = /(post|photo|video|image|media|article|add|attach)/i;
export const SCOPE_READY_RETRY_MS = 250;
export const SCOPE_READY_ATTEMPTS = 5;
export const CERTIFIED_MESSAGING_THREAD_PATH_PATTERN = /\/messaging\/thread\//i;
export const ARTICLE_EDITOR_PATH_PATTERN = /\/article\/(new|edit)(\/|$)/i;
export const CERTIFIED_COMPOSER_SURFACES = new Set(["composer-modal"]);
export const UPLOAD_TRIGGER_PATTERNS: Record<"composer" | "mediaModal" | "thread", readonly RegExp[]> = {
  composer: [/^add media$/i],
  mediaModal: [/^upload from computer$/i, /^select .+/i],
  thread: [
    /^attach a file to /i,
    /^attach an image to /i,
    /^attach a file for your draft conversation$/i,
    /^attach an image for your draft conversation$/i,
  ],
};
export const SEARCH_FILTER_LABELS = new Set([
  "jobs",
  "posts",
  "people",
  "groups",
  "companies",
  "schools",
  "courses",
  "events",
  "products",
  "services",
]);

export function selectorExpressionForToken(token: string): string {
  return /^e\d+$/i.test(token) ? `@${token}` : token;
}

export function selectorExpressionForEntry(entry: SnapshotEntry): string {
  if (entry.selector) {
    return entry.selector;
  }

  return selectorExpressionForToken(entry.ref);
}

export function isVolatileVisibleScopeHandle(handle: string | undefined): boolean {
  return Boolean(handle && /^post:\d+$/i.test(handle));
}

export function isMediaAttachedHeaderScope(visibleScope: RuntimeVisibleScopeInspection): boolean {
  return visibleScope.controls.some(
    (control) => /^remove media$/i.test(control.label) || /^edit media preview$/i.test(control.label),
  );
}

function normalizeScopeFingerprintPart(value: string | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function buildVisibleScopeSignature(visibleScope: RuntimeVisibleScopeInspection): string {
  return [visibleScope.scope.kind, visibleScope.scope.label, ...visibleScope.scope.previewText.slice(0, 3)]
    .map(normalizeScopeFingerprintPart)
    .filter(Boolean)
    .join(" | ");
}
