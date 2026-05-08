const FIXED_DESTINATIONS = {
  feed: "https://www.linkedin.com/feed/",
  network: "https://www.linkedin.com/mynetwork/",
  notifications: "https://www.linkedin.com/notifications/",
  messaging: "https://www.linkedin.com/messaging/",
  search: "https://www.linkedin.com/search/results/all/",
  profile: "https://www.linkedin.com/in/me/",
} as const satisfies Record<string, string>;

export const LINKEDIN_FIXED_DESTINATIONS: Readonly<Record<string, string>> = FIXED_DESTINATIONS;

export function companyDestinationUrl(slug: string): string {
  if (!slug || /[^A-Za-z0-9_-]/.test(slug)) {
    throw new Error(`Invalid company slug '${slug}': only A-Z, a-z, 0-9, _, - are allowed.`);
  }
  return `https://www.linkedin.com/company/${slug}/`;
}

export type FixedDestination = keyof typeof FIXED_DESTINATIONS;
/** Operator-facing destination input — includes `message` alias for `messaging` per cli-primitives.md §launch. */
export type Destination = FixedDestination | "message" | "company";

/** Apply documented aliases (`message → messaging`). */
function aliasDestination(d: Destination): FixedDestination | "company" {
  return d === "message" ? "messaging" : d;
}

/** Resolve a destination + optional args[] to a canonical LinkedIn URL. */
export function normalizeDestination(destination: Destination, args?: string[]): string {
  const canonical = aliasDestination(destination);
  if (canonical === "company") {
    const slug = args?.[0];
    if (!slug) {
      throw new Error(
        "company destination requires args[0] = company slug (e.g. {destination: 'company', args: ['acme-corp']}).",
      );
    }
    return companyDestinationUrl(slug);
  }
  const fixed = FIXED_DESTINATIONS[canonical];
  if (!fixed) {
    throw new Error(
      `Unknown destination '${destination}'. Valid: ${Object.keys(FIXED_DESTINATIONS).join(", ")}, message, company.`,
    );
  }
  return fixed;
}
