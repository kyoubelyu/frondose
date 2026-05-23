// P-Y2.3 — TAKEOVER_JS: the magical Auto-mode takeover layer fragment. Defines (inside the install()
// closure) the .takeover-layer builder (reuses the existing all:initial shadow host → position:fixed;
// inset:0 spans the full viewport, F-RG-3) + __maiShowEdgeRing/__maiHideEdgeRing/__maiShowAgentTarget/
// __maiClearAgentTarget. All DOM-API (no innerHTML → TT-safe). References the HEAD closure var `shadow`.
// Interpolated by bootstrap.ts after LEGACY_JS. Styling comes from OVERLAY_TAKEOVER_CSS (shadow <style>).
export const TAKEOVER_JS = `
  var takeoverLayer = null;
  var agentCursor = null;
  var agentHighlight = null;
  var cursorTagText = null;

  function buildTakeoverLayer() {
    if (takeoverLayer) return takeoverLayer;
    var layer = document.createElement('div');
    layer.className = 'takeover-layer';
    var ring = document.createElement('div'); ring.className = 'takeover-ring'; layer.appendChild(ring);
    var label = document.createElement('div'); label.className = 'takeover-label';
    var ldot = document.createElement('span'); ldot.className = 'takeover-label-dot'; label.appendChild(ldot);
    var ltext = document.createElement('span'); ltext.textContent = 'FRONDOSE AGENT IS CONTROLLING THIS TAB'; label.appendChild(ltext);
    layer.appendChild(label);
    agentCursor = document.createElement('div'); agentCursor.className = 'agent-cursor hidden';
    var arrow = document.createElement('div'); arrow.className = 'cursor-arrow'; agentCursor.appendChild(arrow);
    var tag = document.createElement('div'); tag.className = 'cursor-tag';
    var tdot = document.createElement('span'); tdot.className = 'cursor-tag-dot'; tag.appendChild(tdot);
    cursorTagText = document.createElement('span'); cursorTagText.className = 'cursor-tag-text'; cursorTagText.textContent = 'agent';
    tag.appendChild(cursorTagText); agentCursor.appendChild(tag);
    layer.appendChild(agentCursor);
    agentHighlight = document.createElement('div'); agentHighlight.className = 'agent-highlight hidden';
    layer.appendChild(agentHighlight);
    takeoverLayer = layer;
    return layer;
  }

  window.__maiShowEdgeRing = function() {
    var layer = buildTakeoverLayer();
    if (layer.parentNode !== shadow) shadow.appendChild(layer);
    layer.classList.remove('hidden');
  };
  window.__maiHideEdgeRing = function() {
    if (takeoverLayer && takeoverLayer.parentNode === shadow) shadow.removeChild(takeoverLayer);
  };
  window.__maiShowAgentTarget = function(payloadJson) {
    var data;
    try { data = JSON.parse(payloadJson); } catch (e) { return; }
    if (!data || !data.box) return;
    var layer = buildTakeoverLayer();
    if (layer.parentNode !== shadow) shadow.appendChild(layer);
    var b = data.box;
    agentHighlight.style.left = b.x + 'px';
    agentHighlight.style.top = b.y + 'px';
    agentHighlight.style.width = b.w + 'px';
    agentHighlight.style.height = b.h + 'px';
    agentHighlight.classList.remove('hidden');
    agentCursor.style.left = (b.x + b.w - 8) + 'px';
    agentCursor.style.top = (b.y + b.h / 2) + 'px';
    agentCursor.classList.remove('hidden');
    if (data.label && cursorTagText) cursorTagText.textContent = String(data.label);
  };
  window.__maiClearAgentTarget = function() {
    if (agentHighlight) agentHighlight.classList.add('hidden');
    if (agentCursor) agentCursor.classList.add('hidden');
  };
`;
