// P-Y2.2a — SHELL_JS: the NEW frondose chrome string fragment. Defines (inside the install() closure):
// the shadow-scoped DocumentLike shim, the frondose collapsed pill (mai-pill), the id-bearing panel
// skeleton (mirrors index.html body L262-354 — every workflow-*/mode-*-tab/auto-stage/command-input/
// send-btn id, ported to createElement/createElementNS — DOM-API only, no HTML-string sinks), the
// workflow-card skeleton with
// the canonical button LABELS (render.ts only toggles visibility, never writes them), __maiShowWorkflow /
// __maiSetMode (LOCAL re-render on static/mock data; serve drive is P-Y2.2b), the switcher-tab + show-all
// LOCAL wiring, and __maiExpandDialog / __maiCollapseDialog. Uses __maiShared.buildIwfCard / buildAutoStage /
// buildSwitcher / buildLeafMark / statusForMode. Interpolated by bootstrap.ts; references HEAD closure vars
// (host / shadow / appMode / workflowExpanded / lastWorkflowJson / dialogExpanded / dialogElements / post).
export const SHELL_JS = `
  // ---- shadow-scoped DocumentLike shim: the bridge that lets render.ts builders run in the overlay ----
  var shadowDoc = {
    createElement: function(t){ return document.createElement(t); },
    createElementNS: function(ns, t){ return document.createElementNS(ns, t); },
    getElementById: function(id){ return shadow.getElementById(id); },
    get documentElement(){ return panelRoot; },
    get body(){ return panelRoot; }
  };

  var panelRoot = null;

  // ---- frondose collapsed pill (inline leaf + wordmark) ----
  var pill = document.createElement('div');
  pill.className = 'mai-pill';
  pill.appendChild(__maiShared.buildLeafMark(shadowDoc));
  var pillLabel = document.createElement('span');
  pillLabel.textContent = 'Frondose';
  pill.appendChild(pillLabel);
  shadow.appendChild(pill);

  // ---- id-bearing skeleton (ports index.html body; ids match render.ts getElementById targets) ----
  function el(tag, cls, id){ var e = document.createElement(tag); if (cls) e.className = cls; if (id) e.id = id; return e; }

  function wfRef() {
    try { var w = JSON.parse(lastWorkflowJson); return { workflowId: w && w.workflowId, stepId: w && w.pendingStepId }; }
    catch (e) { return {}; }
  }

  function buildPanelSkeleton() {
    if (panelRoot) return;
    panelRoot = el('div', 'app');

    // topbar: drag-grip (G7 visual only) + brand + status + mode-badge (G5) + switcher
    var topbar = el('header', 'topbar');
    var grip = el('div', 'drag-grip');
    for (var gi = 0; gi < 3; gi++) {
      var row = el('div', 'drag-grip-row');
      row.appendChild(el('div', 'drag-grip-dot'));
      row.appendChild(el('div', 'drag-grip-dot'));
      grip.appendChild(row);
    }
    topbar.appendChild(grip);
    var brand = el('div', 'brand');
    brand.appendChild(__maiShared.buildLeafMark(shadowDoc));
    var word = el('span', 'brand-word'); word.textContent = 'Frondose'; brand.appendChild(word);
    topbar.appendChild(brand);
    // P-Y2-MA G5: mode-badge pill; text + class flip via __maiSetMode below.
    var modeBadge = el('span', 'mode-badge manual', 'mode-badge'); modeBadge.textContent = 'MANUAL';
    topbar.appendChild(modeBadge);
    var switcher = el('div', 'switcher');
    var manualTab = el('button', 'seg-tab active', 'mode-manual-tab'); manualTab.textContent = 'Manual';
    var autoTab = el('button', 'seg-tab', 'mode-auto-tab'); autoTab.textContent = 'Auto';
    switcher.appendChild(manualTab); switcher.appendChild(autoTab);
    topbar.appendChild(switcher);
    panelRoot.appendChild(topbar);

    // scroll area: manual surface (status/output/ticker/legacy-slots/workflow-card) + auto-stage
    var scroll = el('div', 'scroll-area');
    var manual = el('section', 'conv', 'manual-surface');
    var statusLine = el('div', 'status-line');
    statusLine.appendChild(el('span', 'status-dot'));
    var statusEl = el('span', '', 'status'); statusEl.textContent = 'Listening'; statusLine.appendChild(statusEl);
    manual.appendChild(statusLine);
    // P-Y2-MA G1+G2 overlay parity: replace static output-msg with append-list.
    // [CONCERN-MR-1 fix, 3b round-1] <div> not <ul> — matches mockup '.conv > .msg-*' selectors.
    var convList = document.createElement('div');
    convList.id = 'conversation-list';
    convList.className = 'conv-list';
    convList.setAttribute('role', 'log');
    convList.setAttribute('aria-live', 'polite');
    convList.setAttribute('aria-relevant', 'additions');
    manual.appendChild(convList);
    var ticker = el('div', 'ticker hidden', 'ticker');
    manual.appendChild(ticker);
    // overlay-specific legacy slots (preserved features render into these)
    var cardSlot = el('div', '', 'card-slot');
    var nextActionsSlot = el('div', '', 'next-actions-slot');
    var retrySlot = el('div', '', 'retry-slot');
    var cronSlot = el('div', '', 'cron-slot');
    manual.appendChild(cronSlot); manual.appendChild(cardSlot); manual.appendChild(nextActionsSlot); manual.appendChild(retrySlot);
    manual.appendChild(buildWorkflowCardSkeleton());   // #workflow-card + all workflow-* ids
    scroll.appendChild(manual);
    scroll.appendChild(el('section', 'auto-stage hidden', 'auto-stage'));
    panelRoot.appendChild(scroll);

    // composer (keeps the EXISTING prompt transport: Enter -> post({type:'prompt'}))
    var footer = el('footer', 'footer');
    var composer = el('div', 'composer', 'composer');
    var inner = el('div', 'composer-inner');
    var input = document.createElement('input'); input.id = 'command-input'; input.type = 'text';
    input.placeholder = 'Ask about this page, or give a task\\u2026';
    input.addEventListener('keydown', function(e){
      if (e.key === 'Enter') { var t = input.value; if (t && t.length) { input.value = ''; post({ type:'prompt', text:t, t0:Date.now() }); } }
    });
    inner.appendChild(input);
    var send = el('button', 'composer-send', 'send-btn'); inner.appendChild(send);
    composer.appendChild(inner); footer.appendChild(composer); panelRoot.appendChild(footer);

    // shared error/retry/cron banners
    panelRoot.appendChild(el('div', 'banner-error hidden', 'error-banner'));
    panelRoot.appendChild(el('button', 'btn-retry hidden', 'retry-btn'));
    panelRoot.appendChild(el('div', 'cron-banner hidden', 'cron-tick-banner'));

    dialogElements = { ticker: ticker, convList: convList, input: input, cardSlot: cardSlot,
      nextActionsSlot: nextActionsSlot, retrySlot: retrySlot, cronSlot: cronSlot };

    manualTab.addEventListener('click', function(){ window.__maiSetMode('manual'); post({ type:'mode', mode:'manual', t0:Date.now() }); });
    autoTab.addEventListener('click', function(){ window.__maiSetMode('auto'); post({ type:'mode', mode:'auto', t0:Date.now() }); });
    var showAll = shadow.getElementById('workflow-showall-btn');
    if (showAll) showAll.addEventListener('click', function(){ workflowExpanded = !workflowExpanded; rerenderWorkflow(); });
  }

  function buildWorkflowCardSkeleton() {
    var card = el('div', 'iwf-card hidden', 'workflow-card');
    var head = el('div', 'iwf-head');
    head.appendChild(el('div', 'iwf-icon'));
    var ht = el('div', 'iwf-head-text');
    ht.appendChild(el('div', 'iwf-title', 'workflow-title'));
    ht.appendChild(el('div', 'iwf-sub', 'workflow-sub')); head.appendChild(ht);
    var pw = el('div', 'iwf-progress-wrap');
    var bar = el('div', 'iwf-progress-bar'); bar.appendChild(el('div', 'iwf-progress-fill', 'workflow-progress-fill'));
    pw.appendChild(bar);
    var pt = el('div', 'iwf-progress-text', 'workflow-progress-text'); pt.textContent = '0 / 0'; pw.appendChild(pt);
    head.appendChild(pw); card.appendChild(head);
    card.appendChild(el('div', 'iwf-steps', 'workflow-steps'));
    card.appendChild(el('div', 'iwf-notice hidden', 'workflow-notice'));
    var actions = el('div', 'iwf-actions');
    // Labels are set HERE in the skeleton — render.ts buildIwfCard ONLY toggles visibility/state, it never
    // writes Approve/Decline/Pause/Hand-off text (it DOES rewrite #workflow-showall-btn on render; the static
    // default below keeps it non-empty pre-render). Strings are the canonical desktop copy from index.html
    // L315-320 → overlay == desktop. Omitting these = the P-Y2.1 empty-shell failure (blank buttons).
    var showAllBtn = el('button', 'iwf-btn-ghost hidden', 'workflow-showall-btn');
    showAllBtn.textContent = 'Show all steps';
    actions.appendChild(showAllBtn);
    var right = el('div', 'iwf-actions-right');
    var approveBtn = el('button', 'iwf-btn iwf-btn-approve hidden', 'workflow-approve-btn');
    approveBtn.textContent = 'Approve';
    var declineBtn = el('button', 'iwf-btn hidden', 'workflow-decline-btn');
    declineBtn.textContent = 'Decline';
    var pauseBtn = el('button', 'iwf-btn', 'workflow-pause-btn');
    pauseBtn.textContent = 'Pause';
    var handoffBtn = el('button', 'iwf-btn iwf-btn-primary', 'workflow-handoff-btn');
    // P-Y2-MA G9: overlay-only label — "Run on Auto" per hover mockup; desktop keeps "Hand off to Auto".
    handoffBtn.textContent = 'Run on Auto';
    right.appendChild(approveBtn); right.appendChild(declineBtn);
    right.appendChild(pauseBtn); right.appendChild(handoffBtn);
    actions.appendChild(right); card.appendChild(actions);
    approveBtn.addEventListener('click', function(){ var w = wfRef(); post({ type:'workflow-approve', workflowId:w.workflowId, stepId:w.stepId, t0:Date.now() }); });
    declineBtn.addEventListener('click', function(){ var w = wfRef(); post({ type:'workflow-decline', workflowId:w.workflowId, stepId:w.stepId, reason:'operator_declined', t0:Date.now() }); });
    handoffBtn.addEventListener('click', function(){ var w = wfRef(); post({ type:'workflow-handoff', workflowId:w.workflowId, t0:Date.now() }); });
    pauseBtn.addEventListener('click', function(){ post({ type:'abort', t0:Date.now() }); });
    return card;
  }

  // ---- render dispatch on STATIC/mock data (serve auto-drive is 2.2b) ----
  function bindAutoStageButtons() {
    var p = shadow.getElementById('auto-pause-btn');
    if (p) p.addEventListener('click', function(){ post({ type:'abort', t0:Date.now() }); });
    var t = shadow.getElementById('auto-takeover-btn');
    if (t) t.addEventListener('click', function(){ post({ type:'abort', t0:Date.now() }); });
  }

  function rerenderWorkflow() {
    if (!lastWorkflowJson) return;
    var wf = JSON.parse(lastWorkflowJson);
    if (!wf) {
      var c0 = shadow.getElementById('workflow-card'); if (c0) c0.classList.add('hidden');
      var a0 = shadow.getElementById('auto-stage'); if (a0) a0.classList.add('hidden');
      return;
    }
    if (appMode === 'auto') {
      var wfCard = shadow.getElementById('workflow-card');
      if (wfCard) wfCard.classList.add('hidden');
      __maiShared.buildAutoStage(shadowDoc, wf, { compact: true });
      bindAutoStageButtons();
    } else {
      var stage = shadow.getElementById('auto-stage');
      if (stage) stage.classList.add('hidden');
      __maiShared.buildIwfCard(shadowDoc, wf, workflowExpanded);
    }
  }

  window.__maiShowWorkflow = function(payloadJson) {
    var parsed;
    try { parsed = JSON.parse(payloadJson); } catch (e) { return; }
    lastWorkflowJson = payloadJson;
    if (parsed && !dialogExpanded) window.__maiExpandDialog();
    rerenderWorkflow();
  };

  window.__maiSetMode = function(mode) {
    appMode = (mode === 'auto') ? 'auto' : (mode === 'magical' ? 'magical' : 'manual');
    __maiShared.buildSwitcher(shadow.getElementById('mode-manual-tab'), shadow.getElementById('mode-auto-tab'), appMode);
    host.classList.toggle('mode-auto', appMode === 'auto');
    host.classList.toggle('mode-magical', appMode === 'magical');
    var st = shadow.getElementById('status');
    if (st) st.textContent = __maiShared.statusForMode(appMode).label;   // 'Listening' / 'Observing' / 'Working'
    // P-Y2-MA G5: mode-badge text + class hook (styling: P-Y2-Magical owns Magical visual).
    var mb = shadow.getElementById('mode-badge');
    if (mb) {
      mb.textContent = (appMode === 'auto') ? 'AUTO' : (appMode === 'magical' ? 'MAGICAL' : 'MANUAL');
      mb.className = 'mode-badge ' + appMode;
    }
    rerenderWorkflow();
  };

  // P-Y2-MA G1 overlay parity: conversation-list helpers, mirror Sketch A.
  var activeAgentTextEl = null;
  function isOverlayNearBottom() {
    var sc = shadow.getElementById('scroll-area') || (panelRoot && panelRoot.querySelector ? panelRoot.querySelector('.scroll-area') : null);
    if (!sc) return true;
    var distance = sc.scrollHeight - (sc.scrollTop + sc.clientHeight);
    return distance <= 100;
  }
  function overlayScrollIfPinned() {
    var sc = shadow.getElementById('scroll-area') || (panelRoot && panelRoot.querySelector ? panelRoot.querySelector('.scroll-area') : null);
    if (!sc || !isOverlayNearBottom()) return;
    sc.scrollTop = sc.scrollHeight - sc.clientHeight;
  }
  window.__maiAppendUser = function(text) {
    var list = shadow.getElementById('conversation-list');
    if (!list) return;
    var b = document.createElement('div');
    b.className = 'msg-user';
    b.textContent = String(text);
    list.appendChild(b);
    overlayScrollIfPinned();
  };
  window.__maiBeginAgent = function() {
    var list = shadow.getElementById('conversation-list');
    if (!list) return;
    var wrap = el('div', 'msg-agent');
    var avatar = el('div', 'avatar');
    // G3 sparkles SVG (same path as index.html L313).
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M12 2.5l1.7 6 6 1.7-6 1.7-1.7 6-1.7-6-6-1.7 6-1.7z');
    svg.appendChild(p); avatar.appendChild(svg); wrap.appendChild(avatar);
    var body = el('div', 'msg-agent-body');
    var text = el('div', 'msg-agent-text');
    body.appendChild(text); wrap.appendChild(body);
    list.appendChild(wrap);
    activeAgentTextEl = text;
    overlayScrollIfPinned();
  };
  window.__maiAppendChunk = function(chunk) {
    // [NEW-BLOCKER-1 fix, 3b round-2] Frame-agnostic on the overlay side, symmetric
    // with Sketch A's appendAgentChunk auto-open (§5.1.2). The legacy serve→overlay
    // wire is: serve/turn.ts:35 calls __maiClearOutput (now __maiEndAgent, nulls
    // activeAgentTextEl); serve/turn.ts:100 calls __maiAppendOutput per text-delta
    // (now routed to __maiAppendChunk per C-1 migration). Without the auto-open,
    // the FIRST chunk of every turn would silently drop because activeAgentTextEl
    // is null right after the per-turn clear. Auto-open here mirrors B1's contract:
    // first text chunk creates a bubble; subsequent chunks accumulate into it.
    if (!activeAgentTextEl && typeof window.__maiBeginAgent === 'function') {
      window.__maiBeginAgent();
    }
    if (!activeAgentTextEl) return; // defensive — bootstrap not complete / no conv-list yet
    activeAgentTextEl.textContent = (activeAgentTextEl.textContent || '') + String(chunk);
    overlayScrollIfPinned();
  };
  window.__maiEndAgent = function() { activeAgentTextEl = null; };

  window.__maiExpandDialog = function() {
    buildPanelSkeleton();
    if (!dialogExpanded) {
      pill.style.display = 'none';
      shadow.appendChild(panelRoot);
      dialogExpanded = true;
    }
  };
  window.__maiCollapseDialog = function() {
    if (dialogExpanded && panelRoot && panelRoot.parentNode === shadow) {
      shadow.removeChild(panelRoot);
      pill.style.display = '';
      dialogExpanded = false;
    }
  };
`;
