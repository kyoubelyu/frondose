export function buildAgentBubble(doc, conversationListEl) {
    const wrap = doc.createElement("div");
    wrap.classList.add("msg-agent");
    const avatar = doc.createElement("div");
    avatar.classList.add("avatar");
    // Sparkles SVG (same path as index.html:313 desktop reference).
    const svg = doc.createElementNS
        ? doc.createElementNS("http://www.w3.org/2000/svg", "svg")
        : doc.createElement("svg");
    svg.setAttribute?.("viewBox", "0 0 24 24");
    svg.setAttribute?.("fill", "currentColor");
    svg.setAttribute?.("aria-hidden", "true");
    const path = doc.createElementNS
        ? doc.createElementNS("http://www.w3.org/2000/svg", "path")
        : doc.createElement("path");
    path.setAttribute?.("d", "M12 2.5l1.7 6 6 1.7-6 1.7-1.7 6-1.7-6-6-1.7 6-1.7z");
    svg.appendChild(path);
    avatar.appendChild(svg);
    wrap.appendChild(avatar);
    const body = doc.createElement("div");
    body.classList.add("msg-agent-body");
    const progress = doc.createElement("div");
    progress.classList.add("assistant-progress");
    progress.classList.add("hidden");
    progress.setAttribute?.("aria-live", "polite");
    progress.setAttribute?.("role", "status");
    const progressText = doc.createElement("div");
    progressText.classList.add("assistant-progress-text");
    progress.appendChild(progressText);
    body.appendChild(progress);
    const text = doc.createElement("div");
    text.classList.add("msg-agent-text");
    body.appendChild(text);
    wrap.appendChild(body);
    conversationListEl.appendChild(wrap);
    return { textEl: text, progressWrap: progress, progressTextEl: progressText };
}
//# sourceMappingURL=agentBubble.js.map