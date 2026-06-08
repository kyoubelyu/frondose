// [P-75 D-11 round 4] Added `Send\s+invitation\b` — LinkedIn's actual Stage-2 modal button label
// for both 3rd-deg and 2nd-deg targets. Original regex matched only `Send invite/Send now/Send
// without a note` and missed the most-common case. Live evidence: Hootan Farhat 2026-05-25 +
// Dmitry Balanovsky 2026-06-08 — agent's inspect surfaces 12 buttons MAX, and without
// outbound-promotion ranking, Send invitation got crowded out by sidebar buttons + agent
// couldn't click(label="Send invitation") on the modal. The regex also gates the click-time
// approval check (requiresApproval) so this both fixes inspect visibility AND closes a defense
// gap (Send invitation was previously not requiring step approval since it wasn't recognized
// as outbound).
export const OUTBOUND_LABEL_RE =
  /^(?:Connect\b|Invite\b.*\bto\s+connect\b|Send\s+without\s+a\s+note\b|Send\s+invitation\b|Send\s+invite\b|Send\s+now\b|邀请|添加好友|发送邀请|直接发送|连接$|立即连接)/i;

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
