import type { CdpClient } from "../../../../cdp/client.js";

// Phase 85.2 — company admin inbox extractor (closes GitHub #58 for
// `/company/<id>/admin/inbox/thread/<urn>/`). Reads currently-loaded
// message bubbles via DOM eval; does NOT auto-paginate (operator chains
// `scroll` + `inspect` per ROADMAP non-goals).
//
// Selectors (research §3 / AG-N3): `.org-inbox-thread__container` is the
// per-message container; `<a class="org-inbox-message__message-admin-sender">`
// child indicates an admin (operator) message. Sender display name comes
// from the avatar `<img alt="...">`. Body uses `.innerText` to collapse
// `<p>`-wrapped + direct-text bodies uniformly.
//
// Safe-fail mirrors `extractPostDomPreviews` (post-Phase-83 pattern):
// `false` or JSON parse failure → return `[]`. Empty-body
// bubbles are filtered at IIFE level (system messages / attachment-only
// shells stay out).

export interface CompanyInboxMessage {
  isAdmin: boolean;
  sender: string | null;
  body: string;
  timestamp: string | null;
}

export async function extractCompanyInboxThread(client: CdpClient): Promise<CompanyInboxMessage[]> {
  let stdout: string;
  try {
    stdout = await client.evaluate<string>(`(() => {
      const containers = Array.from(document.querySelectorAll('.org-inbox-message__container'));
      const payload = [];
      for (const container of containers) {
        const isAdmin = !!container.querySelector('a.org-inbox-message__message-admin-sender');
        const senderImg = container.querySelector('img');
        const sender = (senderImg && senderImg.getAttribute('alt')) || null;
        const bodyEl = container.querySelector('.org-inbox-message__content');
        const body = bodyEl ? (bodyEl.innerText || bodyEl.textContent || '').trim() : '';
        const timeEl = container.querySelector('time.org-inbox-message__timestamp');
        const timestamp = timeEl ? (timeEl.innerText || timeEl.textContent || '').trim() || null : null;
        if (body) {
          payload.push({ isAdmin, sender, body, timestamp });
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
    const parsed = JSON.parse(stdout) as CompanyInboxMessage[] | string;
    return typeof parsed === "string" ? (JSON.parse(parsed) as CompanyInboxMessage[]) : parsed;
  } catch {
    return [];
  }
}

// Phase 85 WARN-1 — guard `sender ?? "Unknown"` so a missing avatar
// alt does NOT render as the literal string "[null]" (would mislead any
// downstream agent name extraction). The `[You – {sender}]` self-prefix
// asymmetry vs personal messaging's `[You]` is intentional per OQ-85.G:
// company admin pages have multiple admin identities (one per company),
// so the disambiguation is load-bearing.
export function formatCompanyInboxMessage(msg: CompanyInboxMessage): string {
  const safeSender = msg.sender ?? "Unknown";
  const prefix = msg.isAdmin ? `[You – ${safeSender}]` : `[${safeSender}]`;
  const suffix = msg.timestamp ? ` (${msg.timestamp})` : "";
  return `${prefix} ${msg.body}${suffix}`;
}
