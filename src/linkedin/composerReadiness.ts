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

export const FEED_COMPOSER_LIVE_IN_DOM_JS = FEED_COMPOSER_EDITOR_JS;

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

export const FEED_COMPOSER_FOCUS_EDITOR_JS = FEED_COMPOSER_FOCUS_JS;

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

export const FEED_COMPOSER_CLEAR_JS = `(() => {
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
  try {
    const el = deepFind(document,0);
    if (!el) return false;
    el.focus();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      let proto = el;
      let setter = null;
      while (proto && !setter) {
        proto = Object.getPrototypeOf(proto);
        setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
      }
      if (setter) setter.call(el, '');
      else el.value = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      return el.value === '';
    }
    try {
      document.execCommand('selectAll');
      document.execCommand('delete');
    } catch {}
    if ((el.innerText || '').trim() === '') return true;
    el.focus();
    const sel = (el.getRootNode().getSelection ? el.getRootNode().getSelection() : window.getSelection());
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.addRange(range);
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
    document.execCommand('delete');
    el.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
    return (el.innerText || '').trim() === '';
  } catch {
    return false;
  }
})()`;

export async function clearFeedComposerEditorLive(client: CdpClient): Promise<boolean> {
  try {
    return (await client.evaluate<boolean>(FEED_COMPOSER_CLEAR_JS)) === true;
  } catch {
    return false;
  }
}

export const FEED_COMPOSER_CLOSE_CENTER_JS = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const CLOSE_RE = /^(close|dismiss)\\b/i;
  const vis = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelledText = (el) => {
    const ids = norm(el.getAttribute('aria-labelledby'));
    if (!ids) return '';
    return ids
      .split(' ')
      .map((id) => {
        const label = document.getElementById(id);
        return label ? (label.innerText || label.textContent || '') : '';
      })
      .join(' ');
  };
  const names = (el) => [
    el.getAttribute('aria-label'),
    labelledText(el),
    el.innerText,
    el.textContent,
    el.getAttribute('title'),
  ].map(norm).filter(Boolean);
  const className = (el) => (typeof el.className === 'string' ? el.className : '');
  const parentOrHost = (el) => {
    const root = el.getRootNode ? el.getRootNode() : null;
    return el.parentElement || (root && root.host ? root.host : null);
  };
  const nodeSignal = (el) => norm([
    el.getAttribute('aria-label'),
    labelledText(el),
    el.getAttribute('data-test-id'),
    el.getAttribute('data-test-modal'),
    el.id,
    className(el),
  ].join(' '));
  const insideComposerDialog = (el) => {
    let cur = el;
    let sawDialog = false;
    let sawComposer = false;
    while (cur) {
      const role = norm(cur.getAttribute('role'));
      if (role === 'dialog' || cur.getAttribute('aria-modal') === 'true') sawDialog = true;
      if (/share|composer|post|create/i.test(nodeSignal(cur))) sawComposer = true;
      if (sawDialog && sawComposer) return true;
      cur = parentOrHost(cur);
    }
    return false;
  };
  const isCandidate = (el) => {
    if (el.tagName !== 'BUTTON') return false;
    if (!vis(el) || el.closest?.('[aria-hidden="true"]')) return false;
    if (!insideComposerDialog(el)) return false;
    return names(el).some((name) => CLOSE_RE.test(name));
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
    const button = deepFind(document,0);
    if (!button) return JSON.stringify(null);
    if (button.disabled === true ||
      button.hasAttribute('disabled') ||
      button.getAttribute('aria-disabled') === 'true') return JSON.stringify(null);
    const r = button.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return JSON.stringify(null);
    return JSON.stringify({ cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
  } catch {
    return JSON.stringify(null);
  }
})()`;

export const FEED_COMPOSER_DISCARD_CENTER_JS = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const DISCARD_RE = /^(discard|leave)\\b/i;
  const vis = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelledText = (el) => {
    const ids = norm(el.getAttribute('aria-labelledby'));
    if (!ids) return '';
    return ids
      .split(' ')
      .map((id) => {
        const label = document.getElementById(id);
        return label ? (label.innerText || label.textContent || '') : '';
      })
      .join(' ');
  };
  const names = (el) => [
    el.getAttribute('aria-label'),
    labelledText(el),
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
      const role = norm(cur.getAttribute('role'));
      if (role === 'dialog' || cur.getAttribute('aria-modal') === 'true') return true;
      cur = parentOrHost(cur);
    }
    return false;
  };
  const isCandidate = (el) => {
    if (el.tagName !== 'BUTTON') return false;
    if (!vis(el) || el.closest?.('[aria-hidden="true"]')) return false;
    if (!insideDialog(el)) return false;
    return names(el).some((name) => DISCARD_RE.test(name));
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
    const button = deepFind(document,0);
    if (!button) return JSON.stringify(null);
    if (button.disabled === true ||
      button.hasAttribute('disabled') ||
      button.getAttribute('aria-disabled') === 'true') return JSON.stringify(null);
    const r = button.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return JSON.stringify(null);
    return JSON.stringify({ cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
  } catch {
    return JSON.stringify(null);
  }
})()`;

export async function closeFeedComposerLive(client: CdpClient): Promise<boolean> {
  try {
    await client.pressKey("Escape");
    await sleep(READBACK_RETRY_MS);
    await clickComposerDiscardControlIfPresent(client);
    if (!(await isFeedComposerLiveInDOM(client)).present) return true;

    const closeClicked = await clickComposerControlAtCenter(client, FEED_COMPOSER_CLOSE_CENTER_JS);
    if (closeClicked) {
      await clickComposerDiscardControlIfPresent(client);
      await sleep(READBACK_RETRY_MS);
    }

    return !(await isFeedComposerLiveInDOM(client)).present;
  } catch {
    return false;
  }
}

export const FEED_COMPOSER_POST_ENABLED_JS = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const POST_RE = /^post$/i;
  const vis = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelledText = (el) => {
    const ids = norm(el.getAttribute('aria-labelledby'));
    if (!ids) return '';
    return ids
      .split(' ')
      .map((id) => {
        const label = document.getElementById(id);
        return label ? (label.innerText || label.textContent || '') : '';
      })
      .join(' ');
  };
  const names = (el) => [
    el.getAttribute('aria-label'),
    labelledText(el),
    el.innerText,
    el.textContent,
    el.getAttribute('title'),
  ].map(norm).filter(Boolean);
  const className = (el) => (typeof el.className === 'string' ? el.className : '');
  const parentOrHost = (el) => {
    const root = el.getRootNode ? el.getRootNode() : null;
    return el.parentElement || (root && root.host ? root.host : null);
  };
  const nodeSignal = (el) => norm([
    el.getAttribute('aria-label'),
    labelledText(el),
    el.getAttribute('data-test-id'),
    el.getAttribute('data-test-modal'),
    el.id,
    className(el),
  ].join(' '));
  const insideComposerDialog = (el) => {
    let cur = el;
    let sawDialog = false;
    let sawComposer = false;
    while (cur) {
      const role = norm(cur.getAttribute('role'));
      if (role === 'dialog' || cur.getAttribute('aria-modal') === 'true') sawDialog = true;
      if (/share|composer|post|create/i.test(nodeSignal(cur))) sawComposer = true;
      if (sawDialog && sawComposer) return true;
      cur = parentOrHost(cur);
    }
    return false;
  };
  const isCandidate = (el) => {
    if (el.tagName !== 'BUTTON') return false;
    if (!vis(el) || el.closest?.('[aria-hidden="true"]')) return false;
    if (!insideComposerDialog(el)) return false;
    return names(el).some((name) => POST_RE.test(name));
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
    const button = deepFind(document,0);
    if (!button) return false;
    return button.disabled !== true &&
      !button.hasAttribute('disabled') &&
      button.getAttribute('aria-disabled') !== 'true';
  } catch {
    return false;
  }
})()`;

export async function isFeedComposerPostButtonEnabled(client: CdpClient): Promise<boolean> {
  try {
    return (await client.evaluate<boolean>(FEED_COMPOSER_POST_ENABLED_JS)) === true;
  } catch {
    return false;
  }
}

export const FEED_COMPOSER_POST_CENTER_JS = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const POST_RE = /^post$/i;
  const vis = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelledText = (el) => {
    const ids = norm(el.getAttribute('aria-labelledby'));
    if (!ids) return '';
    return ids
      .split(' ')
      .map((id) => {
        const label = document.getElementById(id);
        return label ? (label.innerText || label.textContent || '') : '';
      })
      .join(' ');
  };
  const names = (el) => [
    el.getAttribute('aria-label'),
    labelledText(el),
    el.innerText,
    el.textContent,
    el.getAttribute('title'),
  ].map(norm).filter(Boolean);
  const className = (el) => (typeof el.className === 'string' ? el.className : '');
  const parentOrHost = (el) => {
    const root = el.getRootNode ? el.getRootNode() : null;
    return el.parentElement || (root && root.host ? root.host : null);
  };
  const nodeSignal = (el) => norm([
    el.getAttribute('aria-label'),
    labelledText(el),
    el.getAttribute('data-test-id'),
    el.getAttribute('data-test-modal'),
    el.id,
    className(el),
  ].join(' '));
  const insideComposerDialog = (el) => {
    let cur = el;
    let sawDialog = false;
    let sawComposer = false;
    while (cur) {
      const role = norm(cur.getAttribute('role'));
      if (role === 'dialog' || cur.getAttribute('aria-modal') === 'true') sawDialog = true;
      if (/share|composer|post|create/i.test(nodeSignal(cur))) sawComposer = true;
      if (sawDialog && sawComposer) return true;
      cur = parentOrHost(cur);
    }
    return false;
  };
  const isCandidate = (el) => {
    if (el.tagName !== 'BUTTON') return false;
    if (!vis(el) || el.closest?.('[aria-hidden="true"]')) return false;
    if (!insideComposerDialog(el)) return false;
    return names(el).some((name) => POST_RE.test(name));
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
    const button = deepFind(document,0);
    if (!button) return JSON.stringify(null);
    if (button.disabled === true ||
      button.hasAttribute('disabled') ||
      button.getAttribute('aria-disabled') === 'true') return JSON.stringify(null);
    const r = button.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return JSON.stringify(null);
    return JSON.stringify({ cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
  } catch {
    return JSON.stringify(null);
  }
})()`;

export async function getFeedComposerPostButtonCenterLive(client: CdpClient): Promise<{ x: number; y: number } | null> {
  try {
    const raw = await client.evaluate<string>(FEED_COMPOSER_POST_CENTER_JS);
    const parsed = parseCenterPayload(raw);
    if (!parsed) return null;
    return { x: parsed.cx, y: parsed.cy };
  } catch {
    return null;
  }
}

export const FEED_START_A_POST_CENTER_JS = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const START_RE = /^Start a post$/i;
  const vis = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelledText = (el) => {
    const ids = norm(el.getAttribute('aria-labelledby'));
    if (!ids) return '';
    return ids
      .split(' ')
      .map((id) => {
        const label = document.getElementById(id);
        return label ? (label.innerText || label.textContent || '') : '';
      })
      .join(' ');
  };
  const names = (el) => [
    el.getAttribute('aria-label'),
    labelledText(el),
    el.innerText,
    el.textContent,
    el.getAttribute('title'),
  ].map(norm).filter(Boolean);
  const isCandidate = (el) => {
    const role = norm(el.getAttribute('role'));
    if (el.tagName !== 'BUTTON' && role !== 'button') return false;
    if (!vis(el) || el.closest?.('[aria-hidden="true"]')) return false;
    return names(el).some((name) => START_RE.test(name));
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
    const button = deepFind(document,0);
    if (!button) return JSON.stringify(null);
    if (button.disabled === true ||
      button.hasAttribute('disabled') ||
      button.getAttribute('aria-disabled') === 'true') return JSON.stringify(null);
    const r = button.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return JSON.stringify(null);
    return JSON.stringify({ cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
  } catch {
    return JSON.stringify(null);
  }
})()`;

export async function triggerStartAPostLive(client: CdpClient): Promise<boolean> {
  try {
    const raw = await client.evaluate<unknown>(FEED_START_A_POST_CENTER_JS);
    if (raw === true) return true;
    const parsed = parseCenterPayload(raw);
    if (!parsed) return false;
    await client.dispatchHumanLikeClickAtCoords(parsed.cx, parsed.cy);
    await sleep(READBACK_RETRY_MS);
    return true;
  } catch {
    return false;
  }
}

async function clickComposerDiscardControlIfPresent(client: CdpClient): Promise<boolean> {
  return clickComposerControlAtCenter(client, FEED_COMPOSER_DISCARD_CENTER_JS);
}

async function clickComposerControlAtCenter(client: CdpClient, js: string): Promise<boolean> {
  try {
    const raw = await client.evaluate<unknown>(js);
    const parsed = parseCenterPayload(raw);
    if (!parsed) return false;
    await client.dispatchHumanLikeClickAtCoords(parsed.cx, parsed.cy);
    await sleep(READBACK_RETRY_MS);
    return true;
  } catch {
    return false;
  }
}

function parseCenterPayload(raw: unknown): { cx: number; cy: number } | null {
  const parsed = typeof raw === "string" ? safeParseJson(raw) : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const cx = (parsed as { cx?: unknown }).cx;
  const cy = (parsed as { cy?: unknown }).cy;
  return typeof cx === "number" && Number.isFinite(cx) && typeof cy === "number" && Number.isFinite(cy)
    ? { cx, cy }
    : null;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
