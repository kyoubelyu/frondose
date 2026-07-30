import {
  CONNECT_OPEN_RE,
  CONNECT_SEND_RE,
  classifyActionName,
  FOLLOW_RE,
  personNameFromActionLabel,
} from "../../linkedin/logic/actionClassifier.js";

// [P-75 D-11 round 4] Added `Send\s+invitation\b` — LinkedIn's actual Stage-2 modal button label
// for both 3rd-deg and 2nd-deg targets. Original regex matched only `Send invite/Send now/Send
// without a note` and missed the most-common case. Live evidence: Hootan Farhat 2026-05-25 +
// Dmitry Balanovsky 2026-06-08 — agent's inspect surfaces 12 buttons MAX, and without
// outbound-promotion ranking, Send invitation got crowded out by sidebar buttons + agent
// couldn't click(label="Send invitation") on the modal. The regex also gates the click-time
// approval check (requiresApproval) so this both fixes inspect visibility AND closes a defense
// gap (Send invitation was previously not requiring step approval since it wasn't recognized
// as outbound).
export const OUTBOUND_LABEL_RE = new RegExp(`(?:${CONNECT_SEND_RE.source})|(?:${CONNECT_OPEN_RE.source})`, "iu");

export const FOLLOW_LABEL_RE = FOLLOW_RE;

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

const MESSAGING_SURFACES = new Set(["messaging", "messaging-thread"]);

export function isOutboundLabel(label: string): boolean {
  return OUTBOUND_LABEL_RE.test(label);
}

export function isFollowLabel(label: string): boolean {
  return FOLLOW_LABEL_RE.test(label);
}

/**
 * After F1, NO bare send-family label on any LinkedIn outbound surface can reach a real CDP
 * send without operator approval — the approval gate is independent of connect-vs-message
 * classification and of any dialog-context detection.
 */
export function requiresApproval(label: string, surface: string): boolean {
  const outboundClass = classifyOutboundLabel(label);
  if (isOutboundLabel(label)) return true;
  if (isFollowLabel(label)) return surface === "profile";
  if (outboundClass === "message_send" && LINKEDIN_OUTBOUND_SURFACES.has(surface)) return true;
  if (outboundClass === "post" && surface === "feed") return true;
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
 * - `post`          — a feed share-composer publish button named exactly "Post"; NOT "Repost".
 * - `benign`        — everything else (Follow uses FOLLOW_LABEL_RE separately, never counts
 *                     toward the connect cap).
 */
export type OutboundClass = "connect_open" | "connect_send" | "message_send" | "post" | "benign";

export function classifyOutboundLabel(label: string): OutboundClass {
  switch (classifyActionName(label)) {
    case "connect_send":
      return "connect_send";
    case "connect_open":
      return "connect_open";
    case "message_send":
      return "message_send";
    case "post_publish":
      return "post";
    default:
      return "benign";
  }
}

/** P-AUTO-17 §6.4: classify the resolved element's current accessible name. */
export function classifyOutboundEntry(
  entry: { name: string; role: string } | null | undefined,
  surface: string,
  opts: { connectDialogActive?: boolean } = {},
): OutboundClass {
  if (!LINKEDIN_OUTBOUND_SURFACES.has(surface)) return "benign";
  if (!entry) return "benign";
  const outboundClass = classifyOutboundLabel(entry.name);
  if (outboundClass === "message_send" && opts.connectDialogActive === true && !MESSAGING_SURFACES.has(surface)) {
    return "connect_send";
  }
  return outboundClass;
}

/** P-AUTO-10 (M3): the inner-cleanup chain from personNameFromInviteLabel,
 *  exported so promote-time same-person dedup can normalize a bare name
 *  (not just a captured invite-label group). The order is identical to the
 *  P-75 D-11 round-4 chain and is regression-pinned by T-Norm.1.
 *   (2) drop a trailing parenthetical ("Jane Doe (She/Her)" -> "Jane Doe")
 *   (3) drop a trailing creds clause after the first comma
 *   (4) drop a trailing connection-degree token end-anchored ("1st" / "2nd" / "3rd" / "1度" ...)
 *   (5) strip glyphs that are not letters/marks/space/.'’-
 *   (6) Unicode NFC + collapse internal whitespace + trim. */
export function normalizePersonName(name: string): string {
  return name
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/,\s*.*$/, "")
    .replace(/\s+(?:1st|2nd|3rd|1度|2度|3度)$/iu, "")
    .replace(/[^\p{L}\p{M}\s.'’-]/gu, "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}

/** P-AUTO-6: extract + normalize the target person from the instant-invite label.
 *  "Invite Onder Temel to connect" → "Onder Temel". Returns null when the label
 *  is not an instant-invite ("Connect", "Send invitation"). The inner cleanup
 *  chain lives in normalizePersonName above (extracted in P-AUTO-10). */
export function personNameFromInviteLabel(label: string): string | null {
  const parsed = personNameFromActionLabel(label);
  if (parsed?.kind !== "connect_open") return null;
  const name = normalizePersonName(parsed.personName);
  return name || null;
}
