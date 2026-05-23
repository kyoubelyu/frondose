// P-Y2.2a — LEGACY_JS: the preserved + recolored existing overlay features (ticker / output /
// suggest_card / next-actions / retry / cron-banner / collapsed-card + sessionStorage replay state +
// route-change + passive page observers), moved verbatim from inject.ts with the §6.4-G hex recolor map
// applied (legacy LinkedIn-blue recolored to frondose navy #15487B, etc). The P-57b/e passive logic + P-57d
// sessionStorage replay are preserved VERBATIM. Interpolated by bootstrap.ts into the install() closure;
// references the HEAD/SHELL closure vars (host/shadow/pill/pillLabel/dialogElements/dialogExpanded/post).
export const LEGACY_JS = `
  // ---- legacy slot inline-style strings (recolored) ----
  var cardSlotHiddenStyle = 'border:1px solid #E0DDD2; border-radius:6px; padding:0; display:none;';
  var cardSlotVisibleStyle = 'border:1px solid #E0DDD2; border-radius:6px; padding:12px; display:block; background:white; max-width:440px; max-height:80vh; overflow:auto;';
  var nextActionsHiddenStyle = 'display:none; flex-direction:column; gap:6px;';
  var nextActionsVisibleStyle = 'display:flex; flex-direction:column; gap:6px;';

  // P-57d (item d): sessionStorage dialog state replay.
  // type MaiDialogState = {
  //   ts: number;
  //   ticker: string | null;
  //   output: string;
  //   card: string | null;
  //   frames?: Array<{ type: "text" | "tool", content: string, ts: number }>;
  // };
  var MAI_DIALOG_KEY = '__mai_dialog_state';
  var MAI_OUTPUT_CAP = 2000;
  var MAI_FRAMES_CAP = 20;

  function maiReadDialogState() {
    try {
      return JSON.parse(sessionStorage.getItem(MAI_DIALOG_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  function maiWriteDialogState(state) {
    try {
      state.ts = Date.now();
      state.output = state.output || '';
      state.output = state.output.slice(-MAI_OUTPUT_CAP);
      state.frames = state.frames || [];
      state.frames = state.frames.slice(-MAI_FRAMES_CAP);
      sessionStorage.setItem(MAI_DIALOG_KEY, JSON.stringify(state));
    } catch (e) {
      // sessionStorage quota exceeded or disabled; dialog still works.
    }
  }

  var maiDialogState = {
    ts: Date.now(),
    ticker: null,
    output: '',
    card: null,
    frames: [],
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
      pillLabel.textContent = text;
    }
    maiDialogState.ticker = text || null;
    maiWriteDialogState(maiDialogState);
    if (text === 'done' || (typeof text === 'string' && text.charAt(0) === '✓')) {
      resetTimer = setTimeout(function() {
        if (dialogExpanded && dialogElements && dialogElements.ticker) {
          dialogElements.ticker.textContent = '';
        } else {
          pillLabel.textContent = 'Frondose';
        }
        resetTimer = null;
        maiDialogState.ticker = null;
        maiWriteDialogState(maiDialogState);
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
    maiDialogState.output = dialogElements.output.textContent || '';
    maiDialogState.frames = maiDialogState.frames || [];
    maiDialogState.frames.push({ type: 'text', content: text, ts: Date.now() });
    maiWriteDialogState(maiDialogState);
  };

  window.__maiClearOutput = function() {
    if (!dialogElements) return;
    dialogElements.output.textContent = '';
    maiDialogState.output = '';
    maiDialogState.frames = [];
    maiWriteDialogState(maiDialogState);
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
      reason.style.cssText = 'color:#8B8475; font-style:italic; font-size:13px;';
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
      icp.style.cssText = 'font-size:11px; color:' + (payload.icpMatch.qualified ? '#46B54A' : '#B58740') + '; margin-bottom:6px;';
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
      footer.style.cssText = 'font-size:10px; color:#8B8475; margin-top:4px;';
      footer.textContent = 'methodology \\u00b7 ' + payload.painChainStage;
      slot.appendChild(footer);
    }
    if (payload.suggestedMove) {
      var move = document.createElement('div');
      move.style.cssText = 'background:#FAFAF5; padding:8px; border-radius:4px; margin-top:8px;';
      var kind = document.createElement('div');
      kind.style.cssText = 'font-size:10px; color:#625E53; text-transform:uppercase; margin-bottom:4px;';
      kind.textContent = 'suggested ' + payload.suggestedMove.kind;
      move.appendChild(kind);
      var text = document.createElement('div');
      text.style.cssText = 'font-size:13px;';
      text.textContent = payload.suggestedMove.text;
      move.appendChild(text);
      slot.appendChild(move);
    }
    maiDialogState.card = payloadJson;
    maiDialogState.frames = maiDialogState.frames || [];
    maiDialogState.frames.push({ type: 'tool', content: payloadJson, ts: Date.now() });
    maiWriteDialogState(maiDialogState);
  };

  window.__maiHideCard = function() {
    if (!dialogElements) return;
    var slot = dialogElements.cardSlot;
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    slot.style.cssText = cardSlotHiddenStyle;
    maiDialogState.card = null;
    maiWriteDialogState(maiDialogState);
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
      sum.style.cssText = 'font-size:12px; color:#625E53; margin-bottom:4px;';
      sum.textContent = payload.summary;
      slot.appendChild(sum);
    }
    (payload.actions || []).forEach(function(a) {
      var btn = document.createElement('button');
      btn.style.cssText = 'background:' + (a.danger ? '#B85547' : '#15487B') + '; color:white; padding:6px 10px; border:0; border-radius:4px; cursor:pointer; font-size:13px; text-align:left;';
      btn.textContent = a.label;
      btn.addEventListener('click', function() {
        post({ type:'card-action', prompt: a.prompt, id: a.id, t0: Date.now() });
      });
      slot.appendChild(btn);
    });
  };

  window.__maiShowRetry = function(message) {
    if (!dialogExpanded) window.__maiExpandDialog();
    if (!dialogElements) return;
    var slot = dialogElements.retrySlot;
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    slot.style.cssText = 'display:flex; padding:8px; background:rgba(184,85,71,0.12); border:1px solid #B85547; border-radius:4px; align-items:center; gap:8px; margin:8px 0;';

    var msg = document.createElement('div');
    msg.style.cssText = 'flex:1; font-size:12px; color:#B85547;';
    msg.textContent = message || 'agent error';
    slot.appendChild(msg);

    var btn = document.createElement('button');
    btn.style.cssText = 'background:#15487B; color:white; border:0; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:13px;';
    btn.textContent = 'Retry';
    btn.addEventListener('click', function() {
      post({ type:'retry', t0: Date.now() });
    });
    slot.appendChild(btn);
  };

  window.__maiHideRetry = function() {
    if (!dialogElements) return;
    var slot = dialogElements.retrySlot;
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    slot.style.cssText = 'display:none; padding:8px; background:rgba(184,85,71,0.12); border:1px solid #B85547; border-radius:4px; align-items:center; gap:8px; margin:8px 0;';
  };

  var cronBannerEl = null;
  var cronBannerPulseInterval = null;

  window.__maiShowCronBanner = function(text) {
    if (window.__maiHideCronBanner) window.__maiHideCronBanner();

    cronBannerEl = document.createElement('div');
    cronBannerEl.id = '__mai_cron_banner';
    cronBannerEl.style.cssText = 'all:initial; background:#F2DCAE; color:#2A2A22; border:1px solid #D9A75F; border-left:4px solid #D9A75F; border-radius:6px; padding:9px 11px; font:13px/1.35 -apple-system,system-ui,sans-serif; box-shadow:0 6px 20px rgba(0,0,0,0.15); z-index:2147483647;';

    if (dialogExpanded && dialogElements && dialogElements.cronSlot) {
      cronBannerEl.style.cssText += ' margin-bottom:6px;';
      dialogElements.cronSlot.appendChild(cronBannerEl);
    } else {
      cronBannerEl.style.cssText += ' position:fixed; bottom:248px; right:16px; width:300px;';
      document.documentElement.appendChild(cronBannerEl);
    }

    var title = document.createElement('div');
    title.style.cssText = 'font-weight:600; font-size:12px; line-height:18px; color:#9A6F1F;';
    title.textContent = '\\u23f0 cron active';
    cronBannerEl.appendChild(title);

    if (text) {
      var hint = document.createElement('div');
      hint.style.cssText = 'margin-top:3px; font-size:11px; line-height:15px; color:#8B8475; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;';
      hint.textContent = text;
      cronBannerEl.appendChild(hint);
    }

    var pulseDirection = -1;
    var currentOpacity = 1;
    cronBannerPulseInterval = setInterval(function() {
      if (!cronBannerEl) return;
      currentOpacity += pulseDirection * 0.04;
      if (currentOpacity <= 0.6) {
        currentOpacity = 0.6;
        pulseDirection = 1;
      } else if (currentOpacity >= 1) {
        currentOpacity = 1;
        pulseDirection = -1;
      }
      cronBannerEl.style.opacity = String(currentOpacity);
    }, 80);
  };

  window.__maiHideCronBanner = function() {
    if (cronBannerPulseInterval !== null) {
      clearInterval(cronBannerPulseInterval);
      cronBannerPulseInterval = null;
    }
    if (cronBannerEl && cronBannerEl.parentNode) {
      cronBannerEl.parentNode.removeChild(cronBannerEl);
    }
    cronBannerEl = null;
  };

  var activeCardEl = null;
  var activeCardTimer = null;

  window.__maiShowCollapsedCard = function(payloadJson) {
    var payload;
    try { payload = JSON.parse(payloadJson); } catch (e) { return; }
    if (!payload) return;
    if (activeCardEl && activeCardEl.parentNode) {
      activeCardEl.parentNode.removeChild(activeCardEl);
    }
    if (activeCardTimer) {
      clearTimeout(activeCardTimer);
      activeCardTimer = null;
    }

    activeCardEl = document.createElement('div');
    activeCardEl.id = '__mai_collapsed_card';
    activeCardEl.style.cssText = 'all:initial;position:fixed;bottom:160px;right:16px;width:300px;max-height:80px;background:white;color:#2A2A22;border:1px solid #E0DDD2;border-left:4px solid #15487B;border-radius:6px;padding:9px 11px;font:13px/1.35 -apple-system,system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,0.18);cursor:pointer;z-index:2147483647;overflow:hidden;';

    var title = document.createElement('div');
    title.style.cssText = 'font-weight:600;font-size:13px;line-height:18px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;';
    title.textContent = payload.title || 'Suggestion';
    activeCardEl.appendChild(title);

    var stage = document.createElement('div');
    stage.style.cssText = 'margin-top:4px;font-size:11px;line-height:15px;color:#8B8475;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;';
    stage.textContent = payload.painChainStage || 'methodology';
    activeCardEl.appendChild(stage);

    activeCardEl.addEventListener('click', function() {
      var fullCardJson = payload.fullCardJson;
      if (window.__maiHideCollapsedCard) window.__maiHideCollapsedCard();
      if (window.__maiExpandDialog) window.__maiExpandDialog(payload);
      if (fullCardJson && window.__maiShowCard) window.__maiShowCard(fullCardJson);
    });

    document.documentElement.appendChild(activeCardEl);
    activeCardTimer = setTimeout(function() {
      if (window.__maiHideCollapsedCard) window.__maiHideCollapsedCard();
    }, 30000);
  };

  window.__maiHideCollapsedCard = function() {
    if (activeCardTimer) {
      clearTimeout(activeCardTimer);
      activeCardTimer = null;
    }
    if (activeCardEl && activeCardEl.parentNode) {
      activeCardEl.parentNode.removeChild(activeCardEl);
    }
    activeCardEl = null;
  };

  // ---- route-change observer (P-Y4 profile-nav; preserved) ----
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

  // ---- passive page observers (P-57b/e — preserved VERBATIM) ----
  function installPageObservers() {
    function debounce(fn, ms) {
      var t;
      return function() {
        var a = arguments;
        clearTimeout(t);
        t = setTimeout(function() { fn.apply(null, a); }, ms);
      };
    }

    // P-57e rev-2 (item c) — getElementRef: walk up DOM tree to nearest interactive
    // ancestor (depth=8). Returns null if no interactive ancestor found within
    // depth budget OR if target is <input>/<textarea> (handled by separate input
    // observer; avoid double-fire per OQ-3).
    function getElementRef(target) {
      var node = target;
      var matched = false;
      for (var i = 0; i < 8 && node; i++) {
        if (node === document.documentElement || node === document.body) break;
        // OQ-3: skip input/textarea — handled by input observer; avoid double-fire
        if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') return null;
        if (node.tagName === 'BUTTON') {
          matched = true;
          break;
        }
        if (node.tagName === 'A' && node.hasAttribute && node.hasAttribute('href')) {
          matched = true;
          break;
        }
        if (node.getAttribute) {
          if (node.getAttribute('role') === 'button' ||
              node.hasAttribute('aria-label') ||
              node.hasAttribute('data-control-name') ||
              node.hasAttribute('data-test-id')) {
            matched = true;
            break;
          }
        }
        node = node.parentElement;
      }
      if (!node || !matched || node === document.documentElement || node === document.body) {
        return null;
      }
      var text = '';
      try { text = (node.textContent || '').trim().slice(0, 100); } catch (e) { text = ''; }
      var ref = { tag: node.tagName, text: text };
      var ariaLabel = node.getAttribute ? node.getAttribute('aria-label') : null;
      var controlName = node.getAttribute ? node.getAttribute('data-control-name') : null;
      var testId = node.getAttribute ? node.getAttribute('data-test-id') : null;
      var href = (node.tagName === 'A' && node.getAttribute) ? node.getAttribute('href') : null;
      var role = node.getAttribute ? node.getAttribute('role') : null;
      if (ariaLabel) ref.ariaLabel = ariaLabel;
      if (controlName) ref.controlName = controlName;
      if (testId) ref.testId = testId;
      if (href) ref.href = href;
      if (role) ref.role = role;
      return ref;
    }

    var debouncedClick = debounce(function(event) {
      var target = event.target;
      if (!target || !target.closest) return;
      if (target.closest('#__mai_root') !== null) return;
      if (target.closest('#__mai_collapsed_card') !== null) return;
      // P-57e rev-2 (item c): use getElementRef to find nearest interactive ancestor.
      // Returns null if no ref found (within depth=8) OR if target is input/textarea.
      // Null-ref clicks are SKIPPED — no SSE emit (saves cost; agent only sees
      // interactive UI interactions).
      var ref = getElementRef(target);
      if (ref === null) return;
      window.__maiPost(JSON.stringify({
        type: 'observe',
        event_type: 'click',
        ctx: {
          url: location.href,
          ref: ref,
          x: event.clientX,
          y: event.clientY,
        },
        t0: Date.now(),
      }));
    }, 300);

    document.documentElement.addEventListener('click', debouncedClick, { capture: true, passive: true });

    var debouncedInput = debounce(function(event) {
      var target = event.target;
      if (!target || !target.matches) return;
      if (!target.matches('div[contenteditable], textarea')) return;
      var text = target.textContent || target.value || '';
      if (text.length < 20) return;
      window.__maiPost(JSON.stringify({
        type: 'observe',
        event_type: 'input',
        ctx: {
          url: location.href,
          charCount: text.length,
          snippet: text.slice(0, 100),
        },
        t0: Date.now(),
      }));
    }, 1000);

    document.addEventListener('input', debouncedInput, { capture: true, passive: true });
  }
`;
