export const OUTBOUND_LABEL_RE =
  /^(?:Connect\b|Invite\b.*\bto\s+connect\b|Send\s+without\s+a\s+note\b|Send\s+invite\b|Send\s+now\b|邀请|添加好友|发送邀请|直接发送|连接$|立即连接)/i;

export const FOLLOW_LABEL_RE = /^(?:Follow\b(?!ing)|关注$)/i;

export const LINKEDIN_OUTBOUND_SURFACES = new Set([
  "feed",
  "profile",
  "network",
  "search",
  "company",
  "messaging",
  "messaging-thread",
  "notifications",
]);

export function isOutboundLabel(label: string): boolean {
  return OUTBOUND_LABEL_RE.test(label);
}

export function isFollowLabel(label: string): boolean {
  return FOLLOW_LABEL_RE.test(label);
}

export function requiresApproval(label: string, surface: string): boolean {
  if (isOutboundLabel(label)) return true;
  if (isFollowLabel(label)) return surface === "profile";
  return false;
}
