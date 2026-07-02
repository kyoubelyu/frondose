// Connect-prompt present-predicate (Slice-3 harden). Mirrors COMPOSER_PRESENT_JS: a small
// shadow-piercing JS IIFE string returning JSON.stringify({present}). It detects the LinkedIn
// connect-invitation modal by its stable control signature — a visible dialog/overlay containing
// one of the "Add a note" / "Send without a note" / "Send invitation" buttons. Kept in the
// predicates layer (not inlined in readiness.ts) to match the composer pattern.

import { CONNECT_ADD_NOTE_RE, CONNECT_SEND_RE } from "../actionClassifier.js";

const CONNECT_PROMPT_CONTROL_RE_SOURCE = `(?:${CONNECT_ADD_NOTE_RE.source})|(?:${CONNECT_SEND_RE.source})`;

export function CONNECT_PROMPT_PRESENT_JS(): string {
  return `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const CONTROL_RE = new RegExp(${JSON.stringify(CONNECT_PROMPT_CONTROL_RE_SOURCE)}, 'iu');
  const vis = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const names = (el) => [
    el.getAttribute('aria-label'),
    el.innerText,
    el.textContent,
    el.getAttribute('title'),
  ].map(norm).filter(Boolean);
  const parentOrHost = (el) => {
    const root = el.getRootNode ? el.getRootNode() : null;
    return el.parentElement || (root && root.host ? root.host : null);
  };
  const insideDialog = (el) => {
    let cur = el;
    while (cur) {
      const role = norm(cur.getAttribute ? cur.getAttribute('role') : '');
      if (role === 'dialog' || (cur.getAttribute && cur.getAttribute('aria-modal') === 'true')) return true;
      cur = parentOrHost(cur);
    }
    return false;
  };
  const isCandidate = (el) => {
    if (el.tagName !== 'BUTTON') return false;
    if (!vis(el) || el.closest?.('[aria-hidden="true"]')) return false;
    if (!names(el).some((name) => CONTROL_RE.test(name))) return false;
    return insideDialog(el);
  };
  function deepFind(root, depth) {
    if (depth > 14) return null;
    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of all) {
      if (isCandidate(el)) return el;
      if (el.shadowRoot) {
        const f = deepFind(el.shadowRoot, depth + 1);
        if (f) return f;
      }
    }
    return null;
  }
  try {
    const el = deepFind(document,0);
    return JSON.stringify({present: !!el});
  } catch {
    return JSON.stringify({present: true});
  }
})()`;
}
