// P-SPLIT-APPTS-LOC: the agent-message bubble DOM skeleton (avatar SVG + temporary progress +
// answer-text sink) extracted from app.ts — a stateless DOM builder/mounter
// (no closure state; mirrors the existing render/*.ts build*-and-append convention, e.g. buildIwfCard,
// buildAutoStage, buildLeafMark). 800-line cap exhausted; established split pattern (S-Public.2: one
// exported function per leaf). Behavior byte-preserved.
import type { DocumentLike, ElementLike } from "../render.js";

export interface AgentBubbleRefs {
  textEl: ElementLike;
  progressWrap: ElementLike;
  progressTextEl: ElementLike;
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
  const progress = doc.createElement("div") as unknown as ElementLike;
  progress.classList.add("assistant-progress");
  progress.classList.add("hidden");
  progress.setAttribute?.("aria-live", "polite");
  progress.setAttribute?.("role", "status");
  const progressText = doc.createElement("div") as unknown as ElementLike;
  progressText.classList.add("assistant-progress-text");
  progress.appendChild(progressText);
  body.appendChild(progress);
  const text = doc.createElement("div") as unknown as ElementLike;
  text.classList.add("msg-agent-text");
  body.appendChild(text);
  wrap.appendChild(body);
  conversationListEl.appendChild(wrap);
  return { textEl: text, progressWrap: progress, progressTextEl: progressText };
}
