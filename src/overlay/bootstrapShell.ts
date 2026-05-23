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

  function buildPanelSkeleton() {
    if (panelRoot) return;
    panelRoot = el('div', 'app');

    // topbar: brand (inline leaf + wordmark) + Manual/Auto switcher
    var topbar = el('header', 'topbar');
    var brand = el('div', 'brand');
    brand.appendChild(__maiShared.buildLeafMark(shadowDoc));
    var word = el('span', 'brand-word'); word.textContent = 'Frondose'; brand.appendChild(word);
    topbar.appendChild(brand);
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
    var outputMsg = el('div', 'msg-agent hidden', 'output-msg');
    outputMsg.appendChild(el('div', 'avatar'));
    var outputBody = el('div', 'msg-agent-body');
    var output = el('div', 'msg-agent-text', 'output');
    outputBody.appendChild(output);
    outputMsg.appendChild(outputBody); manual.appendChild(outputMsg);
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

    dialogElements = { ticker: ticker, output: output, input: input, cardSlot: cardSlot,
      nextActionsSlot: nextActionsSlot, retrySlot: retrySlot, cronSlot: cronSlot };

    // local-only wiring (NO serve transport in 2.2a)
    manualTab.addEventListener('click', function(){ window.__maiSetMode('manual'); });
    autoTab.addEventListener('click', function(){ window.__maiSetMode('auto'); });
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
    handoffBtn.textContent = 'Hand off to Auto';
    right.appendChild(approveBtn); right.appendChild(declineBtn);
    right.appendChild(pauseBtn); right.appendChild(handoffBtn);
    actions.appendChild(right); card.appendChild(actions);
    return card;
  }

  // ---- render dispatch on STATIC/mock data (serve auto-drive is 2.2b) ----
  function rerenderWorkflow() {
    if (!lastWorkflowJson) return;
    var wf = JSON.parse(lastWorkflowJson);
    if (appMode === 'auto') {
      var wfCard = shadow.getElementById('workflow-card');
      if (wfCard) wfCard.classList.add('hidden');
      __maiShared.buildAutoStage(shadowDoc, wf, { compact: true });
    } else {
      var stage = shadow.getElementById('auto-stage');
      if (stage) stage.classList.add('hidden');
      __maiShared.buildIwfCard(shadowDoc, wf, workflowExpanded);
    }
  }

  window.__maiShowWorkflow = function(payloadJson) {
    try { JSON.parse(payloadJson); } catch (e) { return; }
    lastWorkflowJson = payloadJson;
    if (!dialogExpanded) window.__maiExpandDialog();
    rerenderWorkflow();
  };

  window.__maiSetMode = function(mode) {
    appMode = (mode === 'auto') ? 'auto' : 'manual';
    __maiShared.buildSwitcher(shadow.getElementById('mode-manual-tab'), shadow.getElementById('mode-auto-tab'), appMode);
    host.classList.toggle('mode-auto', appMode === 'auto');
    var st = shadow.getElementById('status');
    if (st) st.textContent = __maiShared.statusForMode(appMode).label;   // 'Listening' / 'Working'
    rerenderWorkflow();
  };

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
