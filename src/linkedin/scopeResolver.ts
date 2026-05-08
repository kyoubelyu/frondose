import type { LinkedInSurface } from "./types.js";

export const LINKEDIN_APP_HOSTS = new Set(["linkedin.com", "www.linkedin.com"]);

/** Match LinkedIn's login URLs (`/uas/login`, `/login`). */
const LOGIN_RE = /linkedin\.com\/(?:uas\/login|login)(?:[/?#]|$)/i;
export function isLinkedInLoginUrl(url: string): boolean {
  return LOGIN_RE.test(url);
}

/** URL-routed surface inference. The 7 certified surfaces + unknown. */
export function inferSurface(pageUrl: string): LinkedInSurface {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return "unknown";
  }
  if (!LINKEDIN_APP_HOSTS.has(url.hostname)) return "unknown";
  const p = url.pathname;
  if (/\/messaging\/thread\//i.test(p)) return "messaging-thread";
  if (/\/messaging\//i.test(p)) return "messaging";
  if (/\/notifications\//i.test(p)) return "notifications";
  if (/\/search\/results\//i.test(p)) return "search";
  if (/\/mynetwork\//i.test(p)) return "network";
  if (/\/in\/[^/]+/i.test(p)) return "profile";
  if (/\/company\/[^/]+/i.test(p)) return "company";
  if (/^\/feed(\/|$)/i.test(p) || p === "/" || p === "") return "feed";
  return "unknown";
}
