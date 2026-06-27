const LINKEDIN_APP_HOSTS = new Set(["linkedin.com", "www.linkedin.com"]);

export const LINKEDIN_AUTH_INTERRUPTION_MESSAGE =
  "LinkedIn authentication is interrupted by a sign-in or checkpoint page. Manually complete the LinkedIn sign-in/checkpoint in Chrome, then retry in Frondose. Frondose cannot automate SSO, CAPTCHA, or account challenges.";

function parseLinkedInAppUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }

    if (!LINKEDIN_APP_HOSTS.has(parsed.hostname.toLowerCase())) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function isLinkedInLoginUrl(url: string): boolean {
  return /linkedin\.com\/(?:uas\/login|login)(?:[/?#]|$)/i.test(url);
}

export function isLinkedInAuthInterruptionUrl(url: string): boolean {
  const parsed = parseLinkedInAppUrl(url);
  if (!parsed) {
    return false;
  }

  if (isLinkedInLoginUrl(parsed.toString())) {
    return true;
  }

  const [firstSegment] = parsed.pathname.split("/").filter(Boolean);
  return firstSegment?.toLowerCase() === "checkpoint";
}

export function linkedInAuthInterruptionMessage(url?: string): string {
  return url ? `${LINKEDIN_AUTH_INTERRUPTION_MESSAGE} Current URL: ${url}` : LINKEDIN_AUTH_INTERRUPTION_MESSAGE;
}

export function isSupportedLinkedInSurfaceUrl(url: string): boolean {
  const parsed = parseLinkedInAppUrl(url);
  return Boolean(parsed && !isLinkedInAuthInterruptionUrl(parsed.toString()));
}
