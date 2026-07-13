import { t } from "../i18n.js";
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
    // [P-THINK] Gray thinking block ABOVE the answer: a "thinking…" line + the streamed reasoning.
    // Starts hidden (revealed by the first reasoning chunk) and is removed on `done`/`error`.
    const thinking = doc.createElement("div");
    thinking.classList.add("agent-thinking");
    thinking.classList.add("hidden");
    const thinkingLine = doc.createElement("div");
    thinkingLine.classList.add("thinking-line");
    thinkingLine.textContent = t("status.thinking");
    const thinkingText = doc.createElement("div");
    thinkingText.classList.add("thinking-text");
    thinking.appendChild(thinkingLine);
    thinking.appendChild(thinkingText);
    body.appendChild(thinking);
    const text = doc.createElement("div");
    text.classList.add("msg-agent-text");
    body.appendChild(text);
    wrap.appendChild(body);
    conversationListEl.appendChild(wrap);
    return { textEl: text, thinkingWrap: thinking, thinkingTextEl: thinkingText };
}
//# sourceMappingURL=agentBubble.js.map