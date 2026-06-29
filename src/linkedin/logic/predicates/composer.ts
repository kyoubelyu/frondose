import type { SnapshotEntry } from "../../types.js";
import { isInputEntry } from "./_shared.js";

export const DEFAULT_COMPOSER_LABEL_PATTERN = /creating content|what do you want to talk about|Text editor for creating content/i;

type ComposerLabelPattern = RegExp | string;

function labelPatternSource(labelPattern: ComposerLabelPattern): string {
  return labelPattern instanceof RegExp ? labelPattern.toString() : new RegExp(labelPattern, "i").toString();
}

function deepFindPrelude(labelPattern: ComposerLabelPattern): string {
  return `
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const INPUT_RE = ${labelPatternSource(labelPattern)};
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
  }`;
}

export function COMPOSER_EDITOR_JS(labelPattern: ComposerLabelPattern = DEFAULT_COMPOSER_LABEL_PATTERN): string {
  return `(() => {${deepFindPrelude(labelPattern)}
  const el = deepFind(document,0);
  if (!el) return JSON.stringify({present:false,editorText:''});
  const editorText = ('value' in el && typeof el.value==='string') ? el.value : (el.innerText||'');
  return JSON.stringify({present:true, editorText});
})()`;
}

export function COMPOSER_POST_BUTTON_ENABLED_JS(): string {
  return `(() => {
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
}

export function COMPOSER_PRESENT_JS(labelPattern: ComposerLabelPattern = DEFAULT_COMPOSER_LABEL_PATTERN): string {
  return `(() => {${deepFindPrelude(labelPattern)}
  const el = deepFind(document,0);
  return JSON.stringify({present: !!el});
})()`;
}

export function COMPOSER_FOCUS_JS(labelPattern: ComposerLabelPattern = DEFAULT_COMPOSER_LABEL_PATTERN): string {
  return `(() => {${deepFindPrelude(labelPattern)}
  const el = deepFind(document,0);
  if (!el) return false;
  try {
    el.focus();
  } catch {
    return false;
  }
  return (el.getRootNode().activeElement === el) || (document.activeElement === el);
})()`;
}

export function COMPOSER_CLEAR_JS(labelPattern: ComposerLabelPattern = DEFAULT_COMPOSER_LABEL_PATTERN): string {
  return `(() => {${deepFindPrelude(labelPattern)}
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
}

export function isComposerInputEntry(entry: SnapshotEntry): boolean {
  return isInputEntry(entry) && /creating content|what do you want to talk about/i.test(entry.name);
}

export function isComposerButtonEntry(entry: SnapshotEntry): boolean {
  return (
    entry.role === "button" &&
    /(post to anyone|edit media preview|remove media|open emoji keyboard|open grammarly\.?|add media|schedule post|create a post|create an event|celebrate an occasion|^post$)/i.test(
      entry.name,
    )
  );
}

export function isComposerEmojiEntry(entry: SnapshotEntry): boolean {
  if (
    /^search for emojis$/i.test(entry.name) ||
    /^close emoji keyboard$/i.test(entry.name) ||
    /^select emoji skintone$/i.test(entry.name)
  ) {
    return true;
  }

  if (entry.role === "tab" && /emoji category selection$/i.test(entry.name)) {
    return true;
  }

  return entry.role === "button" && /[^\x00-\x7F]/.test(entry.name) && entry.name.length <= 4;
}

export function isComposerAudienceModalEntry(entry: SnapshotEntry): boolean {
  return /anyone on or off linkedin|connections only|comment control|more info about brand partnership|brand partnership|^back$|^done$/i.test(
    entry.name,
  );
}

export function isComposerScheduleModalEntry(entry: SnapshotEntry): boolean {
  return (
    /^(date|time)$/i.test(entry.name) || /expand timepicker|view all scheduled posts|^back$|^next$/i.test(entry.name)
  );
}

export function hasComposerAudienceSurfaceSignals(entries: SnapshotEntry[]): boolean {
  return entries.some((entry) =>
    /anyone on or off linkedin|connections only|comment control|brand partnership|more info about brand partnership/i.test(
      entry.name,
    ),
  );
}

export function hasComposerScheduleSurfaceSignals(entries: SnapshotEntry[]): boolean {
  return entries.some(
    (entry) => /^(date|time)$/i.test(entry.name) || /expand timepicker|view all scheduled posts/i.test(entry.name),
  );
}
