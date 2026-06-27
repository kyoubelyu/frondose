import type { CdpClient } from "../../../../cdp/client.js";

function isCompanyReplyThreadPage(pageUrl: string): boolean {
  const lowerUrl = pageUrl.toLowerCase();
  return lowerUrl.includes("/feed/update/") && lowerUrl.includes("actorcompanyid=");
}

export async function extractCompanyCommentThreadDomText(client: CdpClient, pageUrl: string): Promise<string[]> {
  if (!isCompanyReplyThreadPage(pageUrl)) {
    return [];
  }

  let stdout: string;
  try {
    stdout = await client.evaluate<string>(`(() => {
      const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
      const isVisible = (el) => {
        if (!(el instanceof Element)) {
          return false;
        }
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const cleanArticleText = (value) => {
        return normalize(value)
          .replace(/\\bLike\\s+(?:\\d+\\s+)?Reply\\b/gi, " ")
          .replace(/\\bLike\\s+Reply\\b/gi, " ")
          .replace(/\\bOpen Emoji Keyboard\\b/gi, " ")
          .replace(/\\bOpen Grammarly\\.?\\b/gi, " ")
          .replace(/\\bAdd a photo\\b/gi, " ")
          .replace(/\\bReply as [^…]+…/gi, " ")
          .replace(/\\s+/g, " ")
          .trim();
      };
      const looksLikeCommentArticle = (article) => {
        const text = normalize(article.innerText || article.textContent || "");
        if (!text) {
          return false;
        }
        if (/\\bfeed post\\b/i.test(text)) {
          return false;
        }
        const actionLabel = Array.from(article.querySelectorAll("button,[role='button'],a,[role='link'],svg[role='img']"))
          .map((element) => normalize(element.getAttribute("aria-label") || element.innerText || element.textContent || ""))
          .join(" | ");
        return /comment/i.test(actionLabel) || /\\bLike\\b.*\\bReply\\b/i.test(text) || /\\bReply\\b/i.test(text);
      };
      const articles = Array.from(document.querySelectorAll("article"))
        .filter((article) => isVisible(article) && looksLikeCommentArticle(article));
      const seen = new Set();
      const lines = [];
      for (const article of articles) {
        const text = cleanArticleText(article.innerText || article.textContent || "");
        if (!text || text.length < 12) {
          continue;
        }
        const lower = text.toLowerCase();
        if (seen.has(lower)) {
          continue;
        }
        seen.add(lower);
        lines.push(text.length > 500 ? text.slice(0, 497).trimEnd() + "..." : text);
        if (lines.length >= 8) {
          break;
        }
      }
      return JSON.stringify(lines);
    })()`);
  } catch {
    return [];
  }

  if (!stdout) {
    return [];
  }

  try {
    const parsed = JSON.parse(stdout) as string[] | string;
    return typeof parsed === "string" ? (JSON.parse(parsed) as string[]) : parsed;
  } catch {
    return [];
  }
}
