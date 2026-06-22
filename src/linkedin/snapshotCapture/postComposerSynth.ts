import type { CdpClient } from "../../cdp/client.js";
import type { RefMap, SnapshotEntry } from "../types.js";

export interface PostComposerRaw {
  i: number;
  role: string;
  label: string;
}

export const POST_COMPOSER_SYNTH_JS = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const INPUT_RE = /creating content|what do you want to talk about|Text editor for creating content/i;
  const POST_RE = /^post$/i;
  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll('[contenteditable="true"],textarea,input,[role="textbox"],[aria-label]')) {
    if (!vis(el) || el.closest('[aria-hidden="true"]')) continue;
    const label = norm(el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('placeholder'));
    if (!INPUT_RE.test(label)) continue;
    i++;
    el.setAttribute('data-frondose-pc', String(i));
    out.push({ i, role: 'textbox', label: label.slice(0, 120) });
    break;
  }
  for (const el of document.querySelectorAll('button,[role="button"]')) {
    if (!vis(el) || el.closest('[aria-hidden="true"]')) continue;
    const label = norm(el.getAttribute('aria-label') || el.innerText);
    if (!POST_RE.test(label)) continue;
    i++;
    el.setAttribute('data-frondose-pc', String(i));
    out.push({ i, role: 'button', label });
    break;
  }
  return JSON.stringify(out);
})()`;

function parsePostComposer(raw: string): PostComposerRaw[] {
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

/** P-POST: resolve post-composer controls to backendNodeIds so @pc refs are type/clickable. */
export async function synthesizePostComposerEntries(
  client: CdpClient,
): Promise<{ entries: SnapshotEntry[]; refs: RefMap }> {
  const entries: SnapshotEntry[] = [];
  const refs: RefMap = {};
  try {
    const items = parsePostComposer(await client.evaluate<string>(POST_COMPOSER_SYNTH_JS));
    for (const item of items) {
      try {
        const nodeIds = await client.querySelectorAll(`[data-frondose-pc="${item.i}"]`);
        const nodeId = nodeIds[0];
        if (typeof nodeId !== "number") continue;
        const desc = await client.raceHandle(client.handle.DOM.describeNode({ nodeId }), "snapshot.describeNode");
        const backendNodeId = desc.node?.backendNodeId;
        if (typeof backendNodeId !== "number") continue;
        const ref = `pc${item.i}`;
        const role = item.role === "button" ? "button" : "textbox";
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
        "document.querySelectorAll('[data-frondose-pc]').forEach(e=>e.removeAttribute('data-frondose-pc'));",
      );
    } catch {
      // best-effort cleanup
    }
  }
  return { entries, refs };
}
