// P-SPLIT-APPTS-LOC: the agent-message bubble DOM skeleton (avatar SVG + gray "thinking" block +
// answer-text sink) extracted from app.ts's beginAgentBubble() — a stateless DOM builder/mounter
// (no closure state; mirrors the existing render/*.ts build*-and-append convention, e.g. buildIwfCard,
// buildAutoStage, buildLeafMark). 800-line cap exhausted; established split pattern (S-Public.2: one
// exported function per leaf). Behavior byte-preserved.
import type { DocumentLike, ElementLike } from "../render.js";
import { t } from "../i18n.js";

export interface AgentBubbleRefs {
  textEl: ElementLike;
  thinkingWrap: ElementLike;
  thinkingTextEl: ElementLike;
}

export function buildAgentBubble(doc: DocumentLike, conversationListEl: ElementLike): AgentBubbleRefs {
  const wrap = doc.createElement("div") as unknown as ElementLike;
  wrap.classList.add("msg-agent");
  const avatar = doc.createElement("div") as unknown as ElementLike;
  avatar.classList.add("avatar");
  // Sparkles SVG (same path as index.html:313 desktop reference).
  const svg = doc.createElementNS
    ? (doc.createElementNS("http://www.w3.org/2000/svg", "svg") as unknown as ElementLike)
    : (doc.createElement("svg") as unknown as ElementLike);
  svg.setAttribute?.("viewBox", "0 0 24 24");
  svg.setAttribute?.("fill", "currentColor");
  svg.setAttribute?.("aria-hidden", "true");
  const path = doc.createElementNS
    ? (doc.createElementNS("http://www.w3.org/2000/svg", "path") as unknown as ElementLike)
    : (doc.createElement("path") as unknown as ElementLike);
  path.setAttribute?.("d", "M12 2.5l1.7 6 6 1.7-6 1.7-1.7 6-1.7-6-6-1.7 6-1.7z");
  svg.appendChild(path);
  avatar.appendChild(svg);
  wrap.appendChild(avatar);
  const body = doc.createElement("div") as unknown as ElementLike;
  body.classList.add("msg-agent-body");
  // [P-THINK] Gray thinking block ABOVE the answer: a "thinking…" line + the streamed reasoning.
  // Starts hidden (revealed by the first reasoning chunk) and is removed on `done`/`error`.
  const thinking = doc.createElement("div") as unknown as ElementLike;
  thinking.classList.add("agent-thinking");
  thinking.classList.add("hidden");
  const thinkingLine = doc.createElement("div") as unknown as ElementLike;
  thinkingLine.classList.add("thinking-line");
  thinkingLine.textContent = t("status.thinking");
  const thinkingText = doc.createElement("div") as unknown as ElementLike;
  thinkingText.classList.add("thinking-text");
  thinking.appendChild(thinkingLine);
  thinking.appendChild(thinkingText);
  body.appendChild(thinking);
  const text = doc.createElement("div") as unknown as ElementLike;
  text.classList.add("msg-agent-text");
  body.appendChild(text);
  wrap.appendChild(body);
  conversationListEl.appendChild(wrap);
  return { textEl: text, thinkingWrap: thinking, thinkingTextEl: thinkingText };
}
