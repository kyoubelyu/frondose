import { z } from "zod";

export type { SnapshotEntry } from "../../types.js";

export const VISIBLE_SCOPE_KINDS = [
  "topNav",
  "leftRail",
  "composer",
  "post",
  "messagingSearch",
  "messagingConversationList",
  "messagingConversation",
  "threadInput",
  "searchFilters",
  "searchResults",
  "networkView",
  "notifications",
  "composerAudience",
  "composerMedia",
  "composerSchedule",
  "reactionModal",
  "actorSelection",
  "profileHeader",
  "profileActions",
  "profileContent",
  "profileEditIntro",
  "profileAbout",
  "companyHeader",
  "companyActions",
  "companyContent",
  "companyCommentThread",
  "companyInboxThread",
] as const;

export const visibleScopeKindSchema = z.enum(VISIBLE_SCOPE_KINDS);
export type VisibleScopeKind = z.infer<typeof visibleScopeKindSchema>;

const visibleScopeKindSet = new Set<string>(VISIBLE_SCOPE_KINDS);

export interface VisibleScopeLocator {
  handle: string;
  kind: VisibleScopeKind;
}

export interface VisibleScopeInspectionLike<TScope extends VisibleScopeLocator = VisibleScopeLocator> {
  scope: TScope;
}

export interface VisibleControlRefParts {
  handle: string;
  controlIndex: number;
  labelOccurrence: number;
  role: string;
  label: string;
}

export type UploadVisibleScopeClass = "composer" | "mediaModal" | "thread";

const uploadVisibleScopeClassByKind: Partial<Record<VisibleScopeKind, UploadVisibleScopeClass>> = {
  composer: "composer",
  composerMedia: "mediaModal",
  threadInput: "thread",
};

function isVisibleScopeKind(value: string): value is VisibleScopeKind {
  return visibleScopeKindSet.has(value);
}

export function findVisibleScopeByHandle<T extends { handle: string }>(
  visibleScopes: readonly T[] | undefined,
  handle: string | undefined,
): T | undefined {
  if (!handle) {
    return undefined;
  }

  return visibleScopes?.find((candidate) => candidate.handle === handle);
}

function findVisibleScope<T extends VisibleScopeLocator>(
  visibleScopes: readonly T[] | undefined,
  scope: string | undefined,
): T | undefined {
  if (!scope) {
    return undefined;
  }

  return (
    findVisibleScopeByHandle(visibleScopes, scope) ??
    (isVisibleScopeKind(scope) ? visibleScopes?.find((candidate) => candidate.kind === scope) : undefined)
  );
}

export function resolveVisibleScopeKind(
  visibleScopes: readonly VisibleScopeLocator[] | undefined,
  scope: string | undefined,
): VisibleScopeKind | undefined {
  return findVisibleScope(visibleScopes, scope)?.kind ?? (scope && isVisibleScopeKind(scope) ? scope : undefined);
}

export function findVisibleScopeInspectionByHandle<T extends VisibleScopeInspectionLike>(
  inspections: readonly T[] | undefined,
  handle: string | undefined,
): T | undefined {
  if (!handle) {
    return undefined;
  }

  return inspections?.find((candidate) => candidate.scope.handle === handle);
}

export function findVisibleScopeInspection<T extends VisibleScopeInspectionLike>(
  inspections: readonly T[] | undefined,
  scope: string | undefined,
): T | undefined {
  if (!scope) {
    return undefined;
  }

  return (
    findVisibleScopeInspectionByHandle(inspections, scope) ??
    (isVisibleScopeKind(scope) ? inspections?.find((candidate) => candidate.scope.kind === scope) : undefined)
  );
}

export function buildVisibleControlRef(
  handle: string,
  label: string,
  role: string,
  controlIndex: number,
  labelOccurrence: number,
): string {
  return `vs|${encodeURIComponent(handle)}|${controlIndex}|${labelOccurrence}|${encodeURIComponent(role)}|${encodeURIComponent(label)}`;
}

export function parseVisibleControlRef(ref: string): VisibleControlRefParts | null {
  const parts = ref.split("|");
  if (parts.length !== 6 || parts[0] !== "vs") {
    return null;
  }
  const handlePart = parts[1];
  const controlIndexPart = parts[2];
  const labelOccurrencePart = parts[3];
  const rolePart = parts[4];
  const labelPart = parts[5];
  if (
    handlePart === undefined ||
    controlIndexPart === undefined ||
    labelOccurrencePart === undefined ||
    rolePart === undefined ||
    labelPart === undefined
  ) {
    return null;
  }

  const controlIndex = Number(controlIndexPart);
  const labelOccurrence = Number(labelOccurrencePart);
  if (
    !Number.isInteger(controlIndex) ||
    controlIndex < 1 ||
    !Number.isInteger(labelOccurrence) ||
    labelOccurrence < 1
  ) {
    return null;
  }

  try {
    return {
      handle: decodeURIComponent(handlePart),
      controlIndex,
      labelOccurrence,
      role: decodeURIComponent(rolePart),
      label: decodeURIComponent(labelPart),
    };
  } catch {
    return null;
  }
}

export function classifyUploadVisibleScopeKind(
  kind: VisibleScopeKind | undefined,
): UploadVisibleScopeClass | undefined {
  return kind ? uploadVisibleScopeClassByKind[kind] : undefined;
}

export interface MessagingSignals {
  hasSearch: boolean;
  hasConversationList: boolean;
  hasActiveConversation: boolean;
  hasThreadComposer: boolean;
}

export interface FeedSignals {
  hasCommentComposer: boolean;
  hasCommentThreadSurface: boolean;
}

export type ForegroundKind = "page" | "modal" | "thread" | "local-overlay";
export type ForegroundRouteBucket =
  | "feed"
  | "messaging"
  | "notifications"
  | "search"
  | "network"
  | "profile"
  | "company"
  | "companyInbox"
  | "articles";
