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

/**
 * P-AUTO-1+2 (CONCERN-1/3 fix): shared classifier used by approval, cap, daily/cooldown,
 * and the connect_sent ledger write. The hard click-path gates + the deterministic
 * connect_sent/success ledger append fire on `connect_send` ONLY — counting the
 * `connect_open` (modal-open) click would overcount.
 *
 * - `connect_open`  — opens the Connect modal (label="Connect" or "Invite ... to connect"
 *                     entry-point that brings up the Send invitation overlay).
 * - `connect_send`  — the FINAL invite-send button on the modal:
 *                     "Send invitation" | "Send invite" | "Send without a note" | "Send now".
 * - `message_send`  — a plain DM "Send" (messaging surfaces); NOT in P-AUTO-1+2 connect-gate
 *                     scope (per Critic CONCERN-5: message/follow-up hard gating is a later phase).
 * - `benign`        — everything else (Follow uses FOLLOW_LABEL_RE separately, never counts
 *                     toward the connect cap).
 */
export type OutboundClass = "connect_open" | "connect_send" | "message_send" | "benign";

const CONNECT_SEND_RE =
  /^(?:Send\s+invitation\b|Send\s+invite\b|Send\s+without\s+a\s+note\b|Send\s+now\b|发送邀请|直接发送|立即连接)/i;
const CONNECT_OPEN_RE = /^(?:Connect\b|Invite\b.*\bto\s+connect\b|邀请|添加好友|连接$)/i;
const MESSAGE_SEND_RE = /^Send\s*$/i;

export function classifyOutboundLabel(label: string): OutboundClass {
  const trimmed = label.trim();
  if (CONNECT_SEND_RE.test(trimmed)) return "connect_send";
  if (CONNECT_OPEN_RE.test(trimmed)) return "connect_open";
  if (MESSAGE_SEND_RE.test(trimmed)) return "message_send";
  return "benign";
}
