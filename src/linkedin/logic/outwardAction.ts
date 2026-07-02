import {
  classifyActionName,
  COMPOSER_INPUT_RE,
  CONNECT_ADD_NOTE_RE,
  personNameFromActionLabel,
} from "./actionClassifier.js";
import type { CurrentSurfaceContext, SnapshotEntry } from "./surface/currentSurfaceTypes.js";

export type OutwardActionAdviceKind = "identity_missing" | "memory_recommended" | "remember_recommended";
export type OutwardActionKind = "follow" | "connect" | "message" | "comment" | "reply" | "post";
export type OutwardActionPhase = "draft" | "open" | "commit";
export type OutwardActionCommandKind = "click" | "type";
export type OutwardActionRememberInteraction = "connect" | "message" | "comment" | "post";

export interface OutwardActionSubject {
  personName?: string;
  profileUrl?: string;
}

export interface OutwardActionAdvice {
  stage: "preflight" | "post_action";
  kind: OutwardActionAdviceKind;
  required?: boolean;
  interaction: OutwardActionKind;
  message: string;
  subject?: OutwardActionSubject;
  suggestedCommand?: string;
}

export type OutwardActionClassification =
  | (OutwardActionDescriptor & { isOutbound: true })
  | {
      isOutbound: false;
      actionKind?: undefined;
      phase?: undefined;
      personName?: undefined;
      profileUrl?: undefined;
      rememberInteraction?: undefined;
      useIdentityAnchor?: undefined;
    };

export interface OutwardActionTarget {
  label?: string;
  name?: string;
  role: SnapshotEntry["role"];
  scope?: string;
}

export interface OutwardActionCommandVocabulary {
  identityPreflight?: (input: {
    interaction: OutwardActionKind;
    subject?: OutwardActionSubject;
    context: CurrentSurfaceContext;
  }) => string | undefined;
  memoryPreflight?: (input: {
    interaction: OutwardActionKind;
    subject: OutwardActionSubject;
    context: CurrentSurfaceContext;
  }) => string | undefined;
  rememberAction?: (input: {
    interaction: OutwardActionKind;
    subject?: OutwardActionSubject;
    rememberInteraction: OutwardActionRememberInteraction;
    context: CurrentSurfaceContext;
  }) => string | undefined;
}

export interface OutwardActionAdviceDeps {
  checkMemory?: (input: {
    interaction: OutwardActionKind;
    subject: OutwardActionSubject;
    context: CurrentSurfaceContext;
  }) => boolean;
  getIdentity?: (context: CurrentSurfaceContext) => OutwardActionSubject | null;
  commandVocab?: OutwardActionCommandVocabulary;
}

export interface BuildOutwardActionAdviceOptions {
  phase?: OutwardActionPhase;
  personName?: string;
  profileUrl?: string;
  rememberInteraction?: OutwardActionRememberInteraction;
  useIdentityAnchor?: boolean;
  deps?: OutwardActionAdviceDeps;
}

interface OutwardActionDescriptor {
  actionKind: OutwardActionKind;
  phase: OutwardActionPhase;
  personName?: string;
  profileUrl?: string;
  rememberInteraction?: OutwardActionRememberInteraction;
  useIdentityAnchor?: boolean;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeProfileUrl(profileUrl: string): string {
  return `${profileUrl.replace(/\/+$/, "")}/`;
}

function hasSubject(subject: OutwardActionSubject | undefined): subject is OutwardActionSubject {
  return Boolean(subject?.personName || subject?.profileUrl);
}

function targetLabel(target: OutwardActionTarget): string {
  return normalizeWhitespace(target.label ?? target.name ?? "");
}

function isLikelyProfileName(value: string | undefined): value is string {
  if (!value) {
    return false;
  }

  const trimmed = normalizeWhitespace(value);
  if (!trimmed || /\d/.test(trimmed)) {
    return false;
  }

  if (
    /notification|home|network|jobs|messaging|for business|advertise|search|more|contact info|edit profile|profile photo|followers|connections|request services/i.test(
      trimmed,
    )
  ) {
    return false;
  }

  const words = trimmed.split(/\s+/);
  return words.length >= 2 && words.length <= 6;
}

function extractProfileUrlFromPageUrl(pageUrl: string): string | undefined {
  try {
    const url = new URL(pageUrl);
    if (!/linkedin\.com$/i.test(url.hostname)) {
      return undefined;
    }

    if (!/^\/in\/[^/]+/i.test(url.pathname)) {
      return undefined;
    }

    return normalizeProfileUrl(`${url.origin}${url.pathname}`);
  } catch {
    return undefined;
  }
}

function inferProfileNameFromContext(context: CurrentSurfaceContext): string | undefined {
  const headingEntry = context.entries.find((entry) => entry.role === "heading" && isLikelyProfileName(entry.name));
  if (headingEntry) {
    return normalizeWhitespace(headingEntry.name);
  }

  const textEntry = context.summary.text.find((entry) => isLikelyProfileName(entry));
  if (textEntry) {
    return normalizeWhitespace(textEntry);
  }

  return undefined;
}

function inferProfileTarget(context: CurrentSurfaceContext): OutwardActionSubject {
  const profileUrl = extractProfileUrlFromPageUrl(context.pageUrl);
  if (!profileUrl) {
    return {};
  }

  return {
    profileUrl,
    personName: inferProfileNameFromContext(context),
  };
}

export function parseDynamicLabel(
  label: string,
): Partial<Pick<OutwardActionDescriptor, "personName" | "actionKind" | "phase" | "rememberInteraction">> {
  const normalized = normalizeWhitespace(label);
  const parsed = personNameFromActionLabel(normalized);

  if (parsed?.kind === "follow") {
    return {
      actionKind: "follow",
      phase: "commit",
      personName: normalizeWhitespace(parsed.personName),
    };
  }

  if (parsed?.kind === "connect_open") {
    return {
      actionKind: "connect",
      phase: "open",
      personName: normalizeWhitespace(parsed.personName),
    };
  }

  if (parsed?.kind === "message_open") {
    return {
      actionKind: "message",
      phase: "open",
      personName: normalizeWhitespace(parsed.personName),
    };
  }

  return {};
}

function classifyClickActionDescriptor(
  context: CurrentSurfaceContext,
  target: OutwardActionTarget,
): OutwardActionDescriptor | null {
  const normalizedLabel = targetLabel(target);
  const dynamic = parseDynamicLabel(normalizedLabel);
  const linkedInAction = classifyActionName(normalizedLabel);
  const profileTarget = inferProfileTarget(context);

  if (linkedInAction === "connect_open") {
    return {
      actionKind: "connect",
      phase: "open",
      personName: dynamic.personName ?? profileTarget.personName,
      profileUrl: profileTarget.profileUrl,
    };
  }

  if (linkedInAction === "follow") {
    return {
      actionKind: "follow",
      phase: "commit",
      personName: dynamic.personName,
      profileUrl: profileTarget.profileUrl,
    };
  }

  if (dynamic.actionKind === "connect") {
    return {
      actionKind: "connect",
      phase: "open",
      personName: dynamic.personName ?? profileTarget.personName,
      profileUrl: profileTarget.profileUrl,
    };
  }

  if (linkedInAction === "message_open") {
    return {
      actionKind: "message",
      phase: "open",
      personName: dynamic.personName ?? profileTarget.personName,
      profileUrl: profileTarget.profileUrl,
    };
  }

  if (linkedInAction === "connect_send") {
    return {
      actionKind: "connect",
      phase: "commit",
      personName: profileTarget.personName,
      profileUrl: profileTarget.profileUrl,
      rememberInteraction: "connect",
    };
  }

  if (target.scope === "activityComments" && /^Respond/i.test(normalizedLabel)) {
    return {
      actionKind: "reply",
      phase: "open",
    };
  }

  if (linkedInAction === "message_send") {
    if (target.scope === "threadInput" || target.scope === "messageOverlayThreadInput") {
      return {
        actionKind: "message",
        phase: "commit",
        personName: profileTarget.personName,
        profileUrl: profileTarget.profileUrl,
        rememberInteraction: "message",
      };
    }

    if (target.scope === "connectPrompt") {
      return {
        actionKind: "connect",
        phase: "commit",
        personName: profileTarget.personName,
        profileUrl: profileTarget.profileUrl,
        rememberInteraction: "connect",
      };
    }

    return null;
  }

  if (/^Reply$/i.test(normalizedLabel)) {
    if (target.scope === "comment" || target.scope === "commentReply" || target.scope === "connectPrompt") {
      return {
        actionKind: "reply",
        phase: "commit",
        personName: profileTarget.personName,
        profileUrl: profileTarget.profileUrl,
        rememberInteraction: "comment",
      };
    }

    return null;
  }

  if (linkedInAction === "post_publish") {
    return {
      actionKind: "post",
      phase: "commit",
      useIdentityAnchor: true,
      rememberInteraction: "post",
    };
  }

  return null;
}

function classifyTypeActionDescriptor(
  context: CurrentSurfaceContext,
  target: OutwardActionTarget,
): OutwardActionDescriptor | null {
  const normalizedLabel = targetLabel(target);
  const linkedInAction = classifyActionName(normalizedLabel);
  const profileTarget = inferProfileTarget(context);

  if (
    target.scope === "threadInput" ||
    target.scope === "messageOverlayThreadInput" ||
    linkedInAction === "message_open"
  ) {
    return {
      actionKind: "message",
      phase: "draft",
      personName: profileTarget.personName,
      profileUrl: profileTarget.profileUrl,
    };
  }

  if (target.scope === "comment" || target.scope === "commentReply" || linkedInAction === "connect_add_note") {
    const isConnectNote = CONNECT_ADD_NOTE_RE.test(normalizedLabel);
    return {
      actionKind: isConnectNote ? "connect" : target.scope === "commentReply" ? "reply" : "comment",
      phase: "draft",
      personName: profileTarget.personName,
      profileUrl: profileTarget.profileUrl,
      ...(isConnectNote ? { rememberInteraction: "connect" as const } : {}),
    };
  }

  if (target.scope === "composerInput" || COMPOSER_INPUT_RE.test(normalizedLabel)) {
    return {
      actionKind: "post",
      phase: "draft",
      useIdentityAnchor: true,
      rememberInteraction: "post",
    };
  }

  return null;
}

function toClassification(descriptor: OutwardActionDescriptor | null): OutwardActionClassification {
  return descriptor ? { ...descriptor, isOutbound: true } : { isOutbound: false };
}

export function classifyClickDescriptor(
  context: CurrentSurfaceContext,
  target: OutwardActionTarget,
): OutwardActionClassification {
  return toClassification(classifyClickActionDescriptor(context, target));
}

export function classifyTypeDescriptor(
  context: CurrentSurfaceContext,
  target: OutwardActionTarget,
): OutwardActionClassification {
  return toClassification(classifyTypeActionDescriptor(context, target));
}

export function classifyDescriptor(
  commandKind: OutwardActionCommandKind,
  context: CurrentSurfaceContext,
  target: OutwardActionTarget,
): OutwardActionClassification {
  return commandKind === "click" ? classifyClickDescriptor(context, target) : classifyTypeDescriptor(context, target);
}

function normalizeSubject(subject: OutwardActionSubject): OutwardActionSubject | undefined {
  const normalized = {
    ...(subject.personName ? { personName: normalizeWhitespace(subject.personName) } : {}),
    ...(subject.profileUrl ? { profileUrl: normalizeProfileUrl(subject.profileUrl) } : {}),
  };

  return hasSubject(normalized) ? normalized : undefined;
}

function commandField(suggestedCommand: string | undefined): Pick<OutwardActionAdvice, "suggestedCommand"> {
  return suggestedCommand ? { suggestedCommand } : {};
}

function buildIdentityAdvice(
  interaction: OutwardActionKind,
  context: CurrentSurfaceContext,
  commandVocab: OutwardActionCommandVocabulary | undefined,
  subject?: OutwardActionSubject,
): OutwardActionAdvice {
  const normalizedSubject = normalizeSubject(subject ?? {});
  return {
    stage: "preflight",
    kind: "identity_missing",
    interaction,
    message: "This looks like outward-facing LinkedIn work. Confirm the operator identity before continuing.",
    ...(normalizedSubject ? { subject: normalizedSubject } : {}),
    ...commandField(commandVocab?.identityPreflight?.({ interaction, subject: normalizedSubject, context })),
  };
}

function buildMemoryAdvice(
  interaction: OutwardActionKind,
  personName: string | undefined,
  profileUrl: string | undefined,
  context: CurrentSurfaceContext,
  commandVocab: OutwardActionCommandVocabulary | undefined,
): OutwardActionAdvice | null {
  const subject = normalizeSubject({
    ...(personName ? { personName } : {}),
    ...(profileUrl ? { profileUrl } : {}),
  });

  if (!subject) {
    return null;
  }

  return {
    stage: "preflight",
    kind: "memory_recommended",
    required: true,
    interaction,
    message: subject.personName
      ? `This looks like person-targeted outreach for ${subject.personName}. Read local LinkedIn memory before any further person-targeted outward action for this subject.`
      : "This looks person-targeted. Read local LinkedIn memory before any further person-targeted outward action for this subject.",
    subject,
    ...commandField(commandVocab?.memoryPreflight?.({ interaction, subject, context })),
  };
}

function buildRememberAdvice(
  descriptor: OutwardActionDescriptor,
  context: CurrentSurfaceContext,
  identity: OutwardActionSubject | null,
  commandVocab: OutwardActionCommandVocabulary | undefined,
): OutwardActionAdvice | null {
  if (!descriptor.rememberInteraction) {
    return null;
  }

  if (descriptor.useIdentityAnchor) {
    const subject = normalizeSubject(identity ?? {});
    return {
      stage: "post_action",
      kind: "remember_recommended",
      interaction: descriptor.actionKind,
      message: subject
        ? "Outward-facing action completed. Record one remember event for the sender profile."
        : "Outward-facing action completed. Re-read sender identity, then record a remember event against the sender profile.",
      ...(subject ? { subject } : {}),
      ...commandField(
        commandVocab?.rememberAction?.({
          interaction: descriptor.actionKind,
          subject,
          rememberInteraction: descriptor.rememberInteraction,
          context,
        }),
      ),
    };
  }

  const subject = normalizeSubject({
    ...(descriptor.personName ? { personName: descriptor.personName } : {}),
    ...(descriptor.profileUrl ? { profileUrl: descriptor.profileUrl } : {}),
  });

  if (!subject) {
    return null;
  }

  return {
    stage: "post_action",
    kind: "remember_recommended",
    interaction: descriptor.actionKind,
    message: subject.profileUrl
      ? "Outward-facing action completed. Record one remember event for this person."
      : "Outward-facing action completed. If you continue with this person, open a stable profile URL and then record a remember event.",
    subject,
    ...commandField(
      commandVocab?.rememberAction?.({
        interaction: descriptor.actionKind,
        subject,
        rememberInteraction: descriptor.rememberInteraction,
        context,
      }),
    ),
  };
}

function descriptorFromInput(
  actionKind: OutwardActionKind | OutwardActionClassification,
  context: CurrentSurfaceContext,
  opts: BuildOutwardActionAdviceOptions,
): OutwardActionDescriptor | null {
  if (typeof actionKind !== "string") {
    return actionKind.isOutbound ? actionKind : null;
  }

  const profileTarget = inferProfileTarget(context);
  return {
    actionKind,
    phase: opts.phase ?? "draft",
    personName: opts.personName ?? profileTarget.personName,
    profileUrl: opts.profileUrl ?? profileTarget.profileUrl,
    rememberInteraction: opts.rememberInteraction,
    useIdentityAnchor: opts.useIdentityAnchor ?? actionKind === "post",
  };
}

export function buildOutwardActionAdvice(
  actionKind: OutwardActionKind | OutwardActionClassification,
  context: CurrentSurfaceContext,
  opts: BuildOutwardActionAdviceOptions = {},
  deps: OutwardActionAdviceDeps = opts.deps ?? {},
): OutwardActionAdvice[] {
  const descriptor = descriptorFromInput(actionKind, context, opts);
  if (!descriptor) {
    return [];
  }

  // FLAG TODO(Slice 4): wire frondose persistence + tool vocab by injecting these deps.
  const commandVocab = deps.commandVocab;
  const identity = deps.getIdentity?.(context) ?? null;
  const advice: OutwardActionAdvice[] = [];

  if (!identity) {
    advice.push(
      buildIdentityAdvice(
        descriptor.actionKind,
        context,
        commandVocab,
        normalizeSubject({
          ...(descriptor.personName ? { personName: descriptor.personName } : {}),
          ...(descriptor.profileUrl ? { profileUrl: descriptor.profileUrl } : {}),
        }),
      ),
    );
  }

  if (!descriptor.useIdentityAnchor) {
    const subject = normalizeSubject({
      ...(descriptor.personName ? { personName: descriptor.personName } : {}),
      ...(descriptor.profileUrl ? { profileUrl: descriptor.profileUrl } : {}),
    });
    const hasMemory = subject
      ? deps.checkMemory?.({ interaction: descriptor.actionKind, subject, context }) === true
      : false;

    if (!hasMemory) {
      const memoryAdvice = buildMemoryAdvice(
        descriptor.actionKind,
        descriptor.personName,
        descriptor.profileUrl,
        context,
        commandVocab,
      );
      if (memoryAdvice) {
        advice.push(memoryAdvice);
      }
    }
  }

  if (descriptor.phase === "commit") {
    const rememberAdvice = buildRememberAdvice(descriptor, context, identity, commandVocab);
    if (rememberAdvice) {
      advice.push(rememberAdvice);
    }
  }

  return advice;
}
