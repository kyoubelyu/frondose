import type { CdpClient } from "../cdp/client.js";

export const READBACK_RETRY_MS = 120;

export interface ComposerLiveProbeResult {
  present: boolean;
  editorText: string;
}

export const FEED_COMPOSER_EDITOR_JS = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const INPUT_RE = /creating content|what do you want to talk about|Text editor for creating content/i;
  const vis = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const isCandidate = (el) => {
    const tag = el.tagName;
    return el.getAttribute('contenteditable') === 'true' ||
      tag === 'TEXTAREA' ||
      tag === 'INPUT' ||
      el.getAttribute('role') === 'textbox' ||
      el.hasAttribute('aria-label');
  };
  function deepFind(root, depth) {
    if (depth > 14) return null;
    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of all) {
      if (isCandidate(el) && vis(el) && !el.closest?.('[aria-hidden="true"]')) {
        const label = norm(el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('placeholder'));
        if (INPUT_RE.test(label)) return el;
      }
      if (el.shadowRoot) {
        const f = deepFind(el.shadowRoot, depth + 1);
        if (f) return f;
      }
    }
    return null;
  }
  const el = deepFind(document,0);
  if (!el) return JSON.stringify({present:false,editorText:''});
  const editorText = ('value' in el && typeof el.value==='string') ? el.value : (el.innerText||'');
  return JSON.stringify({present:true, editorText});
})()`;

export const FEED_COMPOSER_FOCUS_JS = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const INPUT_RE = /creating content|what do you want to talk about|Text editor for creating content/i;
  const vis = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const isCandidate = (el) => {
    const tag = el.tagName;
    return el.getAttribute('contenteditable') === 'true' ||
      tag === 'TEXTAREA' ||
      tag === 'INPUT' ||
      el.getAttribute('role') === 'textbox' ||
      el.hasAttribute('aria-label');
  };
  function deepFind(root, depth) {
    if (depth > 14) return null;
    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of all) {
      if (isCandidate(el) && vis(el) && !el.closest?.('[aria-hidden="true"]')) {
        const label = norm(el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('placeholder'));
        if (INPUT_RE.test(label)) return el;
      }
      if (el.shadowRoot) {
        const f = deepFind(el.shadowRoot, depth + 1);
        if (f) return f;
      }
    }
    return null;
  }
  const el = deepFind(document,0);
  if (!el) return false;
  try {
    el.focus();
  } catch {
    return false;
  }
  return (el.getRootNode().activeElement === el) || (document.activeElement === el);
})()`;

export async function isFeedComposerLiveInDOM(client: CdpClient): Promise<ComposerLiveProbeResult> {
  try {
    const raw = await client.evaluate<string>(FEED_COMPOSER_EDITOR_JS);
    const parsed = JSON.parse(raw) as { present?: boolean; editorText?: string };
    if (parsed.present !== true) return { present: false, editorText: "" };
    return { present: true, editorText: typeof parsed.editorText === "string" ? parsed.editorText : "" };
  } catch {
    return { present: false, editorText: "" };
  }
}

export async function focusFeedComposerEditorLive(client: CdpClient): Promise<boolean> {
  try {
    const focused = await client.evaluate<boolean>(FEED_COMPOSER_FOCUS_JS);
    return focused === true;
  } catch {
    return false;
  }
}

export function composerTextMatches(intended: string, observed: string): boolean {
  const norm = (value: string): string =>
    value
      .normalize("NFC")
      .replace(/\r\n?/g, "\n")
      .replace(/\n+$/, "")
      .replace(/[ \t]+/g, " ")
      .trim();
  const normalizedIntended = norm(intended);
  const normalizedObserved = norm(observed);
  if (normalizedIntended === normalizedObserved) return true;
  if (normalizedIntended.length > 1000) return normalizedObserved.startsWith(normalizedIntended.slice(0, 200));
  return false;
}
