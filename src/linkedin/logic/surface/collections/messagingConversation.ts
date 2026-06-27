import type { CdpClient } from "../../../../cdp/client.js";

// Phase 85.3 — personal messaging conversation extractor (closes the
// `/messaging/thread/<urn>/` half of GitHub #58). Reads currently-loaded
// message bubbles via DOM eval; does NOT auto-paginate (operator chains
// `scroll` + `inspect` per ROADMAP non-goals).
//
// Selectors (research §3 / AG-N1, AG-N3): `.msg-s-event-listitem` is the
// per-message `<li>`; the CSS class `msg-s-event-listitem--other` on the
// `<li>` indicates the OTHER party. Absent class = self (operator). Sender
// display name comes from the avatar `<img alt="...">`. Body uses
// `.innerText` to collapse `<p>`-wrapped (InMail) + direct-text bodies
// uniformly.
//
// Safe-fail mirrors `extractPostDomPreviews` (post-Phase-83 pattern):
// `false` or JSON parse failure → return `[]`. Empty-body
// bubbles are filtered at IIFE level (system messages / attachment-only
// shells stay out).

export interface PersonalMessagingMessage {
  isOther: boolean;
  sender: string | null;
  body: string;
  timestamp: string | null;
}

export async function extractMessagingConversationMessages(client: CdpClient): Promise<PersonalMessagingMessage[]> {
  let stdout: string;
  try {
    stdout = await client.evaluate<string>(`(() => {
      const items = Array.from(document.querySelectorAll('.msg-s-event-listitem'));
      const payload = [];
      for (const li of items) {
        const isOther = li.classList.contains('msg-s-event-listitem--other');
        const senderImg = li.querySelector('img');
        const sender = (senderImg && senderImg.getAttribute('alt')) || null;
        const bodyEl = li.querySelector('.msg-s-event-listitem__body');
        const body = bodyEl ? (bodyEl.innerText || bodyEl.textContent || '').trim() : '';
        const timeEl = li.querySelector('time.msg-s-message-group__timestamp');
        const timestamp = timeEl ? (timeEl.innerText || timeEl.textContent || '').trim() || null : null;
        if (body) {
          payload.push({ isOther, sender, body, timestamp });
        }
      }
      return JSON.stringify(payload);
    })()`);
  } catch {
    return [];
  }

  if (!stdout) {
    return [];
  }

  try {
    const parsed = JSON.parse(stdout) as PersonalMessagingMessage[] | string;
    return typeof parsed === "string" ? (JSON.parse(parsed) as PersonalMessagingMessage[]) : parsed;
  } catch {
    return [];
  }
}

// Phase 85 — NIT-4: explicit "omit timestamp suffix when null" clause
// (parity with formatCompanyInboxMessage). WARN-1 — guard
// `sender ?? "Unknown"` for the other-party branch so a missing avatar
// alt does NOT render the literal string `[null]`. Self-prefix is `[You]`
// (no display-name disambiguation needed; operator has only one personal
// identity per session — OQ-85.G ruling).
export function formatPersonalMessagingMessage(msg: PersonalMessagingMessage): string {
  const safeSender = msg.sender ?? "Unknown";
  const prefix = msg.isOther ? `[${safeSender}]` : "[You]";
  const suffix = msg.timestamp ? ` (${msg.timestamp})` : "";
  return `${prefix} ${msg.body}${suffix}`;
}
