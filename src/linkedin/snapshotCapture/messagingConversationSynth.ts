import type { CdpClient } from "../../cdp/client.js";
import { MESSAGING_INPUT_RE } from "../logic/actionClassifier.js";
import type { RefMap, SnapshotEntry } from "../types.js";

export interface MessagingMessageRaw {
  isOther: boolean;
  sender: string | null;
  body: string;
  timestamp: string | null;
}

export interface MessagingComposerRaw {
  i: number;
  role: string;
  label: string;
}

export const MESSAGING_CONVERSATION_SYNTH_JS = `(() => {
  const items = Array.from(document.querySelectorAll('.msg-s-event-listitem'));
  const payload = [];
  for (const li of items) {
    const isOther = li.classList.contains('msg-s-event-listitem--other');
    const senderImg = li.querySelector('img[alt]');
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
})()`;

export const MESSAGING_COMPOSER_SYNTH_JS = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
	  const INPUT_RE = ${MESSAGING_INPUT_RE.toString()};
  const BUTTON_RE = /send|reply|attach|emoji|gif/i;
  const SEARCH_RE = /search/i;
  const seen = new Set();
  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll('[aria-label],textarea,input,[role="textbox"],[role="combobox"],[contenteditable="true"],button,[role="button"]')) {
    if (!vis(el) || el.closest('[aria-hidden="true"]')) continue;
    const label = norm(el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('placeholder'));
    if (!label || SEARCH_RE.test(label)) continue;
    const explicitRole = norm(el.getAttribute('role')).toLowerCase();
    const tag = el.tagName.toLowerCase();
    const isButton = tag === 'button' || explicitRole === 'button';
    const isInput =
      tag === 'textarea' ||
      tag === 'input' ||
      explicitRole === 'textbox' ||
      explicitRole === 'combobox' ||
      el.getAttribute('contenteditable') === 'true';
    if (!((isInput && INPUT_RE.test(label)) || (isButton && BUTTON_RE.test(label)))) continue;
    const role = isButton ? 'button' : explicitRole === 'combobox' ? 'combobox' : 'textbox';
    const key = role + '::' + label;
    if (seen.has(key)) continue;
    seen.add(key);
    i++;
    el.setAttribute('data-frondose-mc', String(i));
    out.push({ i, role, label: label.slice(0, 120) });
  }
  return JSON.stringify(out);
})()`;

function parseMessagingMessages(raw: string): MessagingMessageRaw[] {
  const parsed = JSON.parse(raw) as unknown;
  const payload = typeof parsed === "string" ? (JSON.parse(parsed) as unknown) : parsed;
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((msg): msg is Record<string, unknown> => typeof msg === "object" && msg !== null)
    .map((msg) => ({
      isOther: msg.isOther === true,
      sender: typeof msg.sender === "string" ? msg.sender : null,
      body: typeof msg.body === "string" ? msg.body : "",
      timestamp: typeof msg.timestamp === "string" ? msg.timestamp : null,
    }));
}

function parseMessagingComposer(raw: string): MessagingComposerRaw[] {
  const parsed = JSON.parse(raw) as unknown;
  const payload = typeof parsed === "string" ? (JSON.parse(parsed) as unknown) : parsed;
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      i: typeof item.i === "number" ? item.i : 0,
      role: typeof item.role === "string" ? item.role : "textbox",
      label: typeof item.label === "string" ? item.label : "",
    }))
    .filter((item) => item.i > 0 && item.label.length > 0);
}

export function formatMessagingMessage(msg: MessagingMessageRaw): string | null {
  const body = msg.body.trim();
  if (!body) return null;
  const safeSender = msg.sender ?? "Unknown";
  const prefix = msg.isOther ? `[${safeSender}]` : "[You]";
  const suffix = msg.timestamp ? ` (${msg.timestamp})` : "";
  return `${prefix} ${body}${suffix}`;
}

/** P-MSG-REPLY: synthesize visible active-thread bubbles as read-only transcript text entries. */
export async function synthesizeMessagingTranscriptEntries(client: CdpClient): Promise<SnapshotEntry[]> {
  try {
    const messages = parseMessagingMessages(await client.evaluate<string>(MESSAGING_CONVERSATION_SYNTH_JS));
    const entries: SnapshotEntry[] = [];
    for (const msg of messages) {
      const name = formatMessagingMessage(msg);
      if (!name) continue;
      entries.push({ ref: `@mt${entries.length + 1}`, role: "messagingTranscript", name });
    }
    return entries;
  } catch {
    return [];
  }
}

/** P-MSG-REPLY: resolve composer controls to real backendNodeIds so @mc refs are type/clickable. */
export async function synthesizeMessagingComposerEntries(
  client: CdpClient,
): Promise<{ entries: SnapshotEntry[]; refs: RefMap }> {
  const entries: SnapshotEntry[] = [];
  const refs: RefMap = {};
  try {
    const items = parseMessagingComposer(await client.evaluate<string>(MESSAGING_COMPOSER_SYNTH_JS));
    for (const item of items) {
      try {
        const nodeIds = await client.querySelectorAll(`[data-frondose-mc="${item.i}"]`);
        const nodeId = nodeIds[0];
        if (typeof nodeId !== "number") continue;
        const desc = await client.raceHandle(client.handle.DOM.describeNode({ nodeId }), "snapshot.describeNode");
        const backendNodeId = desc.node?.backendNodeId;
        if (typeof backendNodeId !== "number") continue;
        const ref = `mc${item.i}`;
        const role = item.role === "button" ? "button" : item.role === "combobox" ? "combobox" : "textbox";
        refs[ref] = { axNodeId: "", backendNodeId, role, name: item.label };
        entries.push({ ref: `@${ref}`, role, name: item.label });
      } catch {
        // best-effort per item
      }
    }
  } catch {
    return { entries: [], refs: {} };
  } finally {
    try {
      await client.evaluate(
        "document.querySelectorAll('[data-frondose-mc]').forEach(e=>e.removeAttribute('data-frondose-mc'));",
      );
    } catch {
      // best-effort cleanup
    }
  }
  return { entries, refs };
}

/** Synthesize `mr1, mr2, ...` refs for messaging conversation list items. */
export async function synthesizeMessagingConversationOpeners(client: CdpClient): Promise<SnapshotEntry[]> {
  // Selector per mai-linkedin reference; OQ-P3.2 risk — verify in P-3 live smoke.
  const nodeIds = await client.querySelectorAll("li[class*='msg-conversation-listitem']");
  const out: SnapshotEntry[] = [];
  let i = 0;
  for (const nodeId of nodeIds) {
    i++;
    const ref = `@mr${i}`;
    let label = "";
    try {
      const attrs = await client.raceHandle(client.handle.DOM.getAttributes({ nodeId }), "snapshot.getAttributes");
      const arr = (attrs?.attributes ?? []) as string[];
      // Interleaved [name0, value0, name1, value1, ...] per CDP spec.
      for (let k = 0; k < arr.length - 1; k += 2) {
        if (arr[k] === "aria-label") {
          label = arr[k + 1] ?? "";
          break;
        }
      }
    } catch {
      // best-effort; continue with empty label
    }
    out.push({ ref, role: "messagingConversationOpener", name: label });
  }
  return out;
}
