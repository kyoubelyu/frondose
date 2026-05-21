import type { CdpHandle } from "../cdp/types.js";

/** P-56b: exported so host-side overlay helpers and tests can reference the exact bootstrap source. */
export const OVERLAY_BOOTSTRAP_JS = `
(function install() {
  if (window.top !== window.self) return;
  if (window.__maiBootstrapped) return;
  if (!document.documentElement) {
    document.addEventListener("DOMContentLoaded", install, {once: true});
    return;
  }

  const host = document.createElement('div');
  host.id = '__mai_root';
  host.style.cssText = 'all:initial; position:fixed; bottom:72px; right:16px; z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });

  var pillStyle = 'background:#0a66c2; color:white; padding:8px 12px; border-radius:16px; font:14px/1.2 system-ui; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,0.15);';
  var pillHiddenStyle = pillStyle + ' display:none;';
  var cardSlotHiddenStyle = 'border:1px solid #e0e0e0; border-radius:6px; padding:0; display:none;';
  var cardSlotVisibleStyle = 'border:1px solid #e0e0e0; border-radius:6px; padding:12px; display:block; background:white; max-width:440px; max-height:80vh; overflow:auto;';
  var nextActionsHiddenStyle = 'display:none; flex-direction:column; gap:6px;';
  var nextActionsVisibleStyle = 'display:flex; flex-direction:column; gap:6px;';

  const pill = document.createElement('div');
  pill.style.cssText = pillStyle;
  pill.textContent = 'mai \\xb7 idle';
  shadow.appendChild(pill);

  document.documentElement.appendChild(host);
  window.__maiBootstrapped = true;

  new MutationObserver(() => {
    if (!document.documentElement.contains(host)) {
      document.documentElement.appendChild(host);
    }
  }).observe(document.documentElement, { childList: true });

  function post(payload) {
    var json = JSON.stringify(payload);
    window.__maiLastEventJson = json;
    window.__maiPost(json);
  }

  var dialog = null;
  var dialogElements = null;
  var dialogExpanded = false;

  function buildDialog() {
    if (dialog) return;
    dialog = document.createElement('div');
    dialog.style.cssText = 'all:initial; position:fixed; bottom:72px; right:16px; width:440px; height:600px; background:white; color:#222; border:1px solid #0a66c2; border-radius:8px; padding:0; font:14px/1.4 -apple-system,system-ui,sans-serif; box-shadow:0 4px 20px rgba(0,0,0,0.2); display:flex; flex-direction:column;';

    var titleBar = document.createElement('div');
    titleBar.id = 'title-bar';
    titleBar.style.cssText = 'background:#0a66c2; color:white; padding:8px 12px; border-radius:8px 8px 0 0; display:flex; justify-content:space-between; align-items:center; font-size:13px; font-weight:600;';
    var titleText = document.createElement('span');
    titleText.id = 'title-text';
    titleText.textContent = 'mai \\xb7 hover';
    titleBar.appendChild(titleText);
    var closeBtn = document.createElement('button');
    closeBtn.id = 'close';
    closeBtn.style.cssText = 'background:transparent; border:0; color:white; font-size:18px; cursor:pointer; padding:0 4px; line-height:1;';
    closeBtn.textContent = '\\u00d7';
    closeBtn.addEventListener('click', function() { window.__maiCollapseDialog(); });
    titleBar.appendChild(closeBtn);
    dialog.appendChild(titleBar);

    var body = document.createElement('div');
    body.id = 'body';
    body.style.cssText = 'flex:1; overflow:auto; padding:12px; display:flex; flex-direction:column; gap:10px;';
    dialog.appendChild(body);

    var ticker = document.createElement('div');
    ticker.id = 'ticker';
    ticker.style.cssText = 'font-size:12px; color:#0a66c2; font-style:italic; min-height:16px;';
    body.appendChild(ticker);

    var cardSlot = document.createElement('div');
    cardSlot.id = 'card-slot';
    cardSlot.style.cssText = cardSlotHiddenStyle;
    body.appendChild(cardSlot);

    var nextActionsSlot = document.createElement('div');
    nextActionsSlot.id = 'next-actions-slot';
    nextActionsSlot.style.cssText = nextActionsHiddenStyle;
    body.appendChild(nextActionsSlot);

    var output = document.createElement('div');
    output.id = 'output';
    output.style.cssText = 'font-size:13px; color:#222; white-space:pre-wrap; min-height:80px; padding:8px; background:#f8f8f8; border-radius:4px;';
    body.appendChild(output);

    var inputFooter = document.createElement('div');
    inputFooter.id = 'input-footer';
    inputFooter.style.cssText = 'padding:8px 12px; border-top:1px solid #e0e0e0; display:flex; gap:6px; align-items:center;';
    var input = document.createElement('input');
    input.id = 'input';
    input.type = 'text';
    input.placeholder = 'Ask mai...';
    input.style.cssText = 'flex:1; padding:6px 8px; border:1px solid #ccc; border-radius:4px; font-size:13px;';
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        var text = input.value;
        if (text && text.length > 0) {
          input.value = '';
          post({ type:'prompt', text: text, t0: Date.now() });
        }
      }
    });
    inputFooter.appendChild(input);
    dialog.appendChild(inputFooter);

    dialogElements = { ticker: ticker, output: output, input: input, cardSlot: cardSlot, nextActionsSlot: nextActionsSlot };
  }

  window.__maiExpandDialog = function() {
    buildDialog();
    if (!dialogExpanded) {
      pill.style.cssText = pillHiddenStyle;
      shadow.appendChild(dialog);
      dialogExpanded = true;
    }
  };

  window.__maiCollapseDialog = function() {
    if (dialogExpanded && dialog && dialog.parentNode === shadow) {
      shadow.removeChild(dialog);
      pill.style.cssText = pillStyle;
      dialogExpanded = false;
    }
  };

  var resetTimer = null;
  window.__maiUpdateTicker = function(text) {
    if (resetTimer) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
    if (dialogExpanded && dialogElements && dialogElements.ticker) {
      dialogElements.ticker.textContent = text;
    } else {
      pill.textContent = text;
    }
    if (text === 'done') {
      resetTimer = setTimeout(function() {
        if (dialogExpanded && dialogElements && dialogElements.ticker) {
          dialogElements.ticker.textContent = '';
        } else {
          pill.textContent = 'mai \\xb7 idle';
        }
        resetTimer = null;
      }, 5000);
    }
  };

  window.__maiAppendOutput = function(chunk) {
    if (!dialogExpanded || !dialogElements) return;
    var text = chunk;
    try {
      var parsed = JSON.parse(chunk);
      if (typeof parsed === 'string') text = parsed;
    } catch (e) {
    }
    var prev = dialogElements.output.textContent || '';
    dialogElements.output.textContent = prev + text;
    dialogElements.output.scrollTop = dialogElements.output.scrollHeight;
  };

  window.__maiClearOutput = function() {
    if (!dialogElements) return;
    dialogElements.output.textContent = '';
  };

  window.__maiShowCard = function(payloadJson) {
    var payload;
    try { payload = JSON.parse(payloadJson); } catch (e) { return; }
    if (!dialogExpanded) window.__maiExpandDialog();
    if (!dialogElements) return;
    var slot = dialogElements.cardSlot;
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    slot.style.cssText = cardSlotVisibleStyle;

    if (payload.dismissed) {
      var reason = document.createElement('div');
      reason.style.cssText = 'color:#888; font-style:italic; font-size:13px;';
      reason.textContent = payload.reason || 'no suggestion';
      slot.appendChild(reason);
      return;
    }
    if (payload.title) {
      var title = document.createElement('div');
      title.style.cssText = 'font-weight:600; font-size:14px; margin-bottom:6px;';
      title.textContent = payload.title;
      slot.appendChild(title);
    }
    if (payload.icpMatch) {
      var icp = document.createElement('div');
      icp.style.cssText = 'font-size:11px; color:' + (payload.icpMatch.qualified ? '#0a8540' : '#a04000') + '; margin-bottom:6px;';
      icp.textContent = (payload.icpMatch.qualified ? '\\u2713 qualified \\u00b7 ' : '\\u26a0 ') + 'ICP: ' + (payload.icpMatch.matched || []).join(', ');
      slot.appendChild(icp);
    }
    if (payload.painChainHypothesis) {
      var hyp = document.createElement('div');
      hyp.style.cssText = 'margin:6px 0; line-height:1.5; font-size:13px;';
      hyp.textContent = payload.painChainHypothesis;
      slot.appendChild(hyp);
    }
    if (payload.painChainStage) {
      var footer = document.createElement('div');
      footer.style.cssText = 'font-size:10px; color:#888; margin-top:4px;';
      footer.textContent = 'methodology \\u00b7 ' + payload.painChainStage;
      slot.appendChild(footer);
    }
    if (payload.suggestedMove) {
      var move = document.createElement('div');
      move.style.cssText = 'background:#f3f6f8; padding:8px; border-radius:4px; margin-top:8px;';
      var kind = document.createElement('div');
      kind.style.cssText = 'font-size:10px; color:#666; text-transform:uppercase; margin-bottom:4px;';
      kind.textContent = 'suggested ' + payload.suggestedMove.kind;
      move.appendChild(kind);
      var text = document.createElement('div');
      text.style.cssText = 'font-size:13px;';
      text.textContent = payload.suggestedMove.text;
      move.appendChild(text);
      slot.appendChild(move);
    }
  };

  window.__maiHideCard = function() {
    if (!dialogElements) return;
    var slot = dialogElements.cardSlot;
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    slot.style.cssText = cardSlotHiddenStyle;
  };

  window.__maiShowNextActions = function(payloadJson) {
    var payload;
    try { payload = JSON.parse(payloadJson); } catch (e) { return; }
    if (!dialogExpanded) window.__maiExpandDialog();
    if (!dialogElements) return;
    var slot = dialogElements.nextActionsSlot;
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    slot.style.cssText = nextActionsVisibleStyle;

    if (payload.summary) {
      var sum = document.createElement('div');
      sum.style.cssText = 'font-size:12px; color:#666; margin-bottom:4px;';
      sum.textContent = payload.summary;
      slot.appendChild(sum);
    }
    (payload.actions || []).forEach(function(a) {
      var btn = document.createElement('button');
      btn.style.cssText = 'background:' + (a.danger ? '#c00' : '#0a66c2') + '; color:white; padding:6px 10px; border:0; border-radius:4px; cursor:pointer; font-size:13px; text-align:left;';
      btn.textContent = a.label;
      btn.addEventListener('click', function() {
        post({ type:'card-action', prompt: a.prompt, id: a.id, t0: Date.now() });
      });
      slot.appendChild(btn);
    });
  };

  pill.addEventListener('click', function() {
    var m = window.location.pathname.match(/^\\/in\\/([^/]+)\\/?$/);
    if (m) {
      window.__maiExpandDialog();
      post({
        type: 'activate',
        url: window.location.href,
        handle: m[1],
        pageContext: document.title || '',
        t0: Date.now(),
      });
    } else {
      window.__maiExpandDialog();
      post({
        type: 'expand-dialog',
        url: window.location.href,
        t0: Date.now(),
      });
    }
  });

  var lastPathname = window.location.pathname;
  function checkRouteChange() {
    if (window.location.pathname === lastPathname) return;
    lastPathname = window.location.pathname;
    var m2 = lastPathname.match(/^\\/in\\/([^/]+)\\/?$/);
    if (m2) {
      post({
        type: 'profile-nav',
        url: window.location.href,
        handle: m2[1],
        t0: Date.now(),
      });
    }
  }
  var titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(checkRouteChange).observe(titleEl, { childList: true });
  }
  window.addEventListener('popstate', checkRouteChange);
})();
`.trim();

export async function installOverlay(client: CdpHandle): Promise<string> {
  await client.Runtime.enable();
  await client.Page.enable();
  await client.Runtime.addBinding({ name: "__maiPost" });
  const { identifier } = await client.Page.addScriptToEvaluateOnNewDocument({
    source: OVERLAY_BOOTSTRAP_JS,
    worldName: "mai-overlay",
    runImmediately: true,
  });
  return identifier;
}

interface OverlayExecutionContext {
  id: number;
  name?: string;
  auxData?: {
    frameId?: string;
  };
}

/** P-56b: subscribe to the isolated overlay execution context. */
export async function subscribeContextId(
  client: CdpHandle,
  onContext: (contextId: number) => void,
): Promise<() => void> {
  const { frameTree } = await client.Page.getFrameTree();
  const mainFrameId = typeof frameTree?.frame?.id === "string" ? frameTree.frame.id : undefined;
  // top-frame context fires first due to runImmediately, so filtering by frameId after getFrameTree resolves is safe in practice.
  return client.Runtime.executionContextCreated(({ context }: { context: OverlayExecutionContext }) => {
    if (context.name !== "mai-overlay") return;
    if (mainFrameId !== undefined && context.auxData?.frameId !== mainFrameId) return;
    onContext(context.id);
  });
}

/** P-56b: call a function inside the captured isolated overlay execution context. */
export async function callInOverlay(client: CdpHandle, contextId: number, functionDeclaration: string): Promise<void> {
  await client.Runtime.callFunctionOn({
    executionContextId: contextId,
    functionDeclaration,
    silent: true,
  });
}
