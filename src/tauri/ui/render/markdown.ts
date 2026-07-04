// T-FE-CHAT bug 1 — safe markdown->DOM renderer for the streamed assistant answer bubble.
// DOM-lib-free (this module is compiled by BOTH the Tauri-UI build (lib DOM) and the main build
// (no DOM lib) via the ./render.js barrel -> src/overlay/sharedEntry.ts) — references ONLY the
// structural *Like interfaces below, never HTMLElement/Document directly.
//
// Builds nodes ONLY via createElement/textContent/appendChild/classList/setAttribute. NEVER
// innerHTML/insertAdjacentHTML/DOMParser(html)/event-handler attributes/inline style-from-model/
// srcdoc. Model output is UNTRUSTED — every code path below must stay attribute-and-textContent-only.

import { span } from "./dom.js";
import type { DocumentLike, ElementLike } from "./types.js";

const SAFE_URL_SCHEMES = new Set(["http", "https", "mailto"]);

// Strip ASCII control chars + all whitespace before scheme-sniffing so a disguised scheme
// ("java\tscript:", "  javascript:", newline-split schemes) can't slip past a naive prefix check —
// mirrors how real browsers strip C0 controls/space before resolving a URL's scheme.
function normalizeUrl(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) continue; // drop C0 controls, space, and DEL
    out += ch;
  }
  return out;
}

// Returns the sanitized href if `raw` uses an allowed scheme (http/https/mailto), else null —
// callers MUST fall back to rendering the raw markdown text (never set an unsafe href).
function safeHref(raw: string): string | null {
  const normalized = normalizeUrl(raw);
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(normalized);
  if (match === null) return null;
  if (!SAFE_URL_SCHEMES.has((match[1] ?? "").toLowerCase())) return null;
  return normalized;
}

function el(doc: DocumentLike, tagName: string, className?: string): ElementLike {
  const e = doc.createElement(tagName);
  if (className !== undefined && className.length > 0) for (const c of className.split(" ")) e.classList.add(c);
  return e;
}

// --- inline (within a block: bold/italic/inline-code/links/bare URLs) ---

// Order matters: code spans first (so backticked text is never reinterpreted), then explicit
// links, then bold, then italic, then bare http(s) URLs.
const INLINE_RE = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+)/g;

function buildLink(doc: DocumentLike, label: string, rawUrl: string): ElementLike {
  const href = safeHref(rawUrl);
  if (href === null) {
    // Unsafe scheme (javascript:/data:/vbscript:/obfuscated) -> render the literal markdown text,
    // never an href. No unsanitized URL ever reaches an attribute.
    return span(doc, "", label === rawUrl ? rawUrl : `[${label}](${rawUrl})`);
  }
  const a = doc.createElement("a");
  a.classList.add("md-link");
  a.textContent = label;
  a.setAttribute?.("href", href);
  a.setAttribute?.("rel", "noopener noreferrer");
  a.setAttribute?.("target", "_blank");
  return a;
}

// A semantic <code> element (not a plain span) for an inline `code` run.
function buildInlineCode(doc: DocumentLike, text: string): ElementLike {
  const code = el(doc, "code", "md-code-inline");
  code.textContent = text;
  return code;
}

// Parses one block's raw text into inline nodes. Unmatched markers (an unterminated "**" with no
// closing pair) simply never match the regex, so they fall through as literal text — never dropped.
function parseInline(doc: DocumentLike, text: string): ElementLike[] {
  const nodes: ElementLike[] = [];
  let lastIndex = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null = INLINE_RE.exec(text);
  for (; m !== null; m = INLINE_RE.exec(text)) {
    if (m.index > lastIndex) nodes.push(span(doc, "", text.slice(lastIndex, m.index)));
    if (m[1] !== undefined) nodes.push(buildInlineCode(doc, m[1]));
    else if (m[2] !== undefined) nodes.push(span(doc, "md-bold", m[2]));
    else if (m[3] !== undefined) nodes.push(span(doc, "md-italic", m[3]));
    else if (m[4] !== undefined && m[5] !== undefined) nodes.push(buildLink(doc, m[4], m[5]));
    else if (m[6] !== undefined) nodes.push(buildLink(doc, m[6], m[6]));
    lastIndex = INLINE_RE.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(span(doc, "", text.slice(lastIndex)));
  if (nodes.length === 0) nodes.push(span(doc, "", text));
  return nodes;
}

// --- block-level (line-oriented so a streaming/partial buffer degrades gracefully) ---

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "paragraph"; text: string };

function isBlockStart(line: string): boolean {
  return /^\s*```/.test(line) || /^#{1,6}\s+/.test(line) || /^\s*(?:[-*]|\d+\.)\s+/.test(line);
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isTableSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

// noUncheckedIndexedAccess (root tsconfig) types every lines[idx] as `string | undefined` even
// where the surrounding `i < lines.length` guard makes it always defined — `at()` centralizes the
// `?? ""` fallback so the loop logic below stays readable.
function at(lines: string[], idx: number): string {
  return lines[idx] ?? "";
}

// Only promote a pipe block to a real table when a valid header + separator + body shape is
// present; an in-progress/invalid pipe block (no separator row yet) falls through to a plain
// paragraph instead of being swallowed.
function parseBlocks(raw: string): Block[] {
  const lines = raw.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = at(lines, i);
    if (line.trim().length === 0) {
      i++;
      continue;
    }

    if (/^\s*```/.test(line)) {
      // Fenced code block. Unterminated (no closing fence before the buffer ends, the common
      // mid-stream case) -> treat everything through the end of the buffer as code; never dropped.
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(at(lines, i))) {
        codeLines.push(at(lines, i));
        i++;
      }
      if (i < lines.length) i++; // consume the closing fence
      blocks.push({ kind: "code", text: codeLines.join("\n") });
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch !== null) {
      const hashes = headingMatch[1] ?? "#";
      blocks.push({ kind: "heading", level: hashes.length, text: (headingMatch[2] ?? "").trim() });
      i++;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparatorRow(at(lines, i + 1))) {
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && at(lines, i).trim().length > 0 && at(lines, i).includes("|")) {
        rows.push(splitTableRow(at(lines, i)));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const listMatch = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (listMatch !== null) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [listMatch[1] ?? ""];
      i++;
      while (i < lines.length) {
        const next = at(lines, i);
        const nextMatch = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(next);
        if (nextMatch === null) break;
        if (/^\s*\d+\./.test(next) !== ordered) break;
        items.push(nextMatch[1] ?? "");
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // Paragraph: consume consecutive non-blank lines that don't start another block, joined into
    // one flowing paragraph. Trailing partial text (buffer ends mid-sentence) is still included.
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length && at(lines, i).trim().length > 0 && !isBlockStart(at(lines, i))) {
      paraLines.push(at(lines, i));
      i++;
    }
    blocks.push({ kind: "paragraph", text: paraLines.join(" ") });
  }
  return blocks;
}

function buildParagraph(doc: DocumentLike, text: string): ElementLike {
  const p = el(doc, "p", "md-p");
  for (const node of parseInline(doc, text)) p.appendChild(node);
  return p;
}

function buildHeading(doc: DocumentLike, level: number, text: string): ElementLike {
  const tag = `h${Math.min(Math.max(level, 1), 6)}`;
  const h = el(doc, tag, "md-heading");
  for (const node of parseInline(doc, text)) h.appendChild(node);
  return h;
}

function buildCodeBlock(doc: DocumentLike, text: string): ElementLike {
  const pre = el(doc, "pre", "md-pre");
  const code = el(doc, "code", "md-code");
  code.textContent = text;
  pre.appendChild(code);
  return pre;
}

function buildList(doc: DocumentLike, ordered: boolean, items: string[]): ElementLike {
  const list = el(doc, ordered ? "ol" : "ul", "md-list");
  for (const item of items) {
    const li = el(doc, "li");
    for (const node of parseInline(doc, item)) li.appendChild(node);
    list.appendChild(li);
  }
  return list;
}

function buildTable(doc: DocumentLike, header: string[], rows: string[][]): ElementLike {
  const table = el(doc, "table", "md-table");
  const thead = el(doc, "thead");
  const headRow = el(doc, "tr");
  for (const cell of header) {
    const th = el(doc, "th");
    for (const node of parseInline(doc, cell)) th.appendChild(node);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el(doc, "tbody");
  for (const row of rows) {
    const tr = el(doc, "tr");
    for (const cell of row) {
      const td = el(doc, "td");
      for (const node of parseInline(doc, cell)) td.appendChild(node);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

// Builds the block sequence for `raw` as a list of top-level nodes (paragraphs/lists/tables/
// headings/code blocks), each built via the safe DOM-builder helpers above.
export function buildMarkdownNodes(doc: DocumentLike, raw: string): ElementLike[] {
  const nodes: ElementLike[] = [];
  for (const block of parseBlocks(raw)) {
    switch (block.kind) {
      case "heading":
        nodes.push(buildHeading(doc, block.level, block.text));
        break;
      case "code":
        nodes.push(buildCodeBlock(doc, block.text));
        break;
      case "list":
        nodes.push(buildList(doc, block.ordered, block.items));
        break;
      case "table":
        nodes.push(buildTable(doc, block.header, block.rows));
        break;
      case "paragraph":
        nodes.push(buildParagraph(doc, block.text));
        break;
    }
  }
  return nodes;
}

// Clears `container` and re-renders `raw` markdown into it as safe DOM (one pass, replacing all
// children). `container` is expected to be a plain block element (e.g. .msg-agent-text).
export function renderMarkdownInto(doc: DocumentLike, container: ElementLike, raw: string): void {
  container.textContent = ""; // clears existing children (same pattern as render/dom.ts:clear)
  for (const node of buildMarkdownNodes(doc, raw)) container.appendChild(node);
}
