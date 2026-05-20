import type { CdpClient } from "../cdp/client.js";
import { inferSurface } from "./scopeResolver.js";
import type { CurrentSurfaceContext, SnapshotEntry } from "./types.js";

/** P-37 B4: synthesize feed-post entries — LinkedIn's feed DOM does not expose
 *  post author/body in the AX tree. Heuristic is TEXT-SIGNAL-PRIMARY (OQ-2):
 *  the post container is the nearest ancestor whose innerText carries a
 *  post-action signal — NOT the `feed-shared-update-v2` BEM class (which churns).
 *  Capped at 5 posts (the feed renders ~5-7 visible per scroll). */
export const FEED_POST_SYNTH_JS = `(() => {
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const SIGNALS = ["comment", "repost", "reaction"];
  const anchors = Array.from(document.querySelectorAll("button,[role='button']"))
    .filter((b) => /^Open control menu for post by /i.test(norm(b.getAttribute("aria-label") || b.innerText)) && visible(b))
    .slice(0, 5);
  const out = [];
  for (const a of anchors) {
    const author = norm(a.getAttribute("aria-label") || a.innerText)
      .replace(/^Open control menu for post by /i, "").trim();
    // text-signal-primary container walk (D-3): ascend until innerText carries
    // a post-action signal. No reliance on the feed-shared-update-v2 class.
    let container = a, hops = 0;
    while (container.parentElement && hops < 12) {
      container = container.parentElement; hops++;
      if (SIGNALS.some((sig) => (container.innerText || "").toLowerCase().includes(sig))) break;
    }
    const actor = container.querySelector('[class*="actor"]') || container;
    const link = actor.querySelector('a[href*="/in/"], a[href*="/company/"]');
    const profileUrl = link ? link.getAttribute("href") : null;
    let headline = "";
    for (const el of container.querySelectorAll("span,div,p")) {
      if (!visible(el)) continue;
      const t = norm(el.innerText);
      if (t.length > 12 && !t.startsWith(author) && !/^Open control menu/i.test(t)) { headline = t; break; }
    }
    out.push({ author, headline: headline.slice(0, 160), profileUrl });
  }
  return JSON.stringify(out);
})()`;

interface FeedPostRaw {
  author: string;
  headline: string;
  profileUrl: string | null;
}

/** P-47 G-3: synthesize a structured profile card from the rendered profile DOM.
 *  The AX tree buries name/headline/location under ~15 nav/sidebar entries; this
 *  h1-anchored DOM scan (ported from mai-linkedin profileFieldExtractor.ts)
 *  extracts the identity fields directly. ASSUMED-confidence (plan OQ-2) — the
 *  Step-5 live test against a real LinkedIn profile is the authoritative check. */
export const PROFILE_SYNTH_JS = `(() => {
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const CHROME_PREFIXES = [
    "Profile photo", "Edit profile", "Edit background", "Contact info",
    "Add section", "Open to", "Compose", "Message", "Connect",
    "Manage notifications", "View", "Follow", "Report", "Pending", "Save",
  ];
  const isChrome = (t) => CHROME_PREFIXES.some((p) => t.startsWith(p));
  const titleMatch = document.title.match(/^(.+?)\\s*\\|\\s*LinkedIn\\b/);
  if (!titleMatch) return JSON.stringify(null);
  let name = titleMatch[1].trim();
  if (name.includes(' - ')) name = name.split(' - ')[0].trim();
  const headings = Array.from(document.querySelectorAll("h1, h2, h3"));
  const NAV_SELECTOR = "[role='banner'], [role='navigation'], nav, header";
  let anchor = headings.find(el => norm(el.innerText) === name && !el.closest(NAV_SELECTOR));
  if (!anchor) anchor = headings.find(el => norm(el.innerText) === name);
  if (!anchor) return JSON.stringify(null);
  const afterH1Ps = Array.from(document.querySelectorAll("p, span[class*='_']"))
    .filter((el) => anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
    .slice(0, 20);
  let headline = null;
  let subtitle = null;
  let location = null;
  for (const p of afterH1Ps) {
    const t = norm(p.innerText);
    if (!t || t.length < 3) continue;
    if (isChrome(t)) continue;
    if (t.toLowerCase() === name.toLowerCase()) continue;
    if (t.startsWith("·")) continue;
    if (!headline && !t.includes("·") && t.length >= 8) {
      headline = t.slice(0, 200);
    } else if (!subtitle && t.includes("·") && !t.startsWith("·")) {
      subtitle = t.slice(0, 200);
    } else if (subtitle && !location) {
      if (!t.includes("·") && !/^\\d/.test(t) && t.length >= 3 && t.length <= 80) {
        location = t;
      }
    }
    if (headline && subtitle && location) break;
  }
  const company = subtitle ? ((subtitle.split("·")[0] || "").trim() || null) : null;
  const connEl = Array.from(document.querySelectorAll("a, span")).find((el) => {
    const t = norm(el.innerText);
    return /\\d.*connection/i.test(t) && t.length < 50;
  });
  const connections = connEl ? norm(connEl.innerText) : null;
  return JSON.stringify({ name, headline, company, location, connections });
})()`;

interface ProfileCardRaw {
  name: string;
  headline: string | null;
  company: string | null;
  location: string | null;
  connections: string | null;
}

/** Capture the current surface: AX snapshot + URL routing + (messaging) opener synthesis. */
export async function captureCurrentSurfaceContext(client: CdpClient): Promise<CurrentSurfaceContext> {
  await client.snapshot();
  const refMap = client.currentRefMap;
  const entries: SnapshotEntry[] = Object.entries(refMap).map(([key, e]) => ({
    ref: `@${key}`,
    role: e.role,
    name: e.name ?? "",
  }));

  const pageUrl = await client.getCurrentUrl();
  const surface = inferSurface(pageUrl);

  if (surface === "messaging" || surface === "messaging-thread") {
    const synth = await synthesizeMessagingConversationOpeners(client);
    entries.push(...synth);
  } else if (surface === "feed") {
    entries.push(...(await synthesizeFeedPostEntries(client))); // P-37 B4
  } else if (surface === "profile") {
    // P-47 G-3 (OQ-3): PREPEND the structured profile entries at index 0 so
    // they lead the text list ahead of the ~15 nav/sidebar entries and survive
    // the buildInspectSummary MAX_TEXT=40 truncation.
    entries.unshift(...(await synthesizeProfileEntries(client)));
  }

  return { pageUrl, surface, activeLayer: "page", entries };
}

/** P-37 B4: synthesize feed-post entries from the rendered feed DOM. */
async function synthesizeFeedPostEntries(client: CdpClient): Promise<SnapshotEntry[]> {
  let posts: FeedPostRaw[] = [];
  try {
    posts = JSON.parse(await client.evaluate<string>(FEED_POST_SYNTH_JS)) as FeedPostRaw[];
  } catch {
    return []; // best-effort — a feed with no extractable posts yields no entries
  }
  return posts.slice(0, 5).map((p, i) => ({
    ref: `@fp${i + 1}`,
    role: "feedPost",
    name: p.profileUrl ? `Post by ${p.author} (${p.profileUrl}): ${p.headline}` : `Post by ${p.author}: ${p.headline}`,
  }));
}

/** P-47 G-3: synthesize structured profile-card entries from the profile DOM.
 *  Best-effort — any extraction failure yields no entries (never throws). */
async function synthesizeProfileEntries(client: CdpClient): Promise<SnapshotEntry[]> {
  let p: ProfileCardRaw | null = null;
  try {
    p = JSON.parse(await client.evaluate<string>(PROFILE_SYNTH_JS)) as ProfileCardRaw | null;
  } catch {
    return []; // extraction / parse failure → no entries
  }
  if (!p || !p.name) return [];
  const out: SnapshotEntry[] = [];
  // @pp1 — identity line: name + headline.
  out.push({
    ref: "@pp1",
    role: "profileCard",
    name: (p.headline ? `${p.name} — ${p.headline}` : p.name).slice(0, 220),
  });
  // @pp2 — details line: present-only company / location / connections.
  const details = [p.company, p.location, p.connections].filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  if (details.length > 0) {
    out.push({ ref: "@pp2", role: "profileCard", name: `Profile: ${details.join(" · ")}` });
  }
  return out;
}

/** Synthesize `mr1, mr2, ...` refs for messaging conversation list items. */
async function synthesizeMessagingConversationOpeners(client: CdpClient): Promise<SnapshotEntry[]> {
  // Selector per mai-linkedin reference; OQ-P3.2 risk — verify in P-3 live smoke.
  const nodeIds = await client.querySelectorAll("li[class*='msg-conversation-listitem']");
  const out: SnapshotEntry[] = [];
  let i = 0;
  for (const nodeId of nodeIds) {
    i++;
    const ref = `@mr${i}`;
    let label = "";
    try {
      const attrs = await client.handle.DOM.getAttributes({ nodeId });
      const arr = (attrs?.attributes ?? []) as string[];
      // Interleaved [name0, value0, name1, value1, ...] per CDP spec.
      for (let k = 0; k < arr.length - 1; k += 2) {
        if (arr[k] === "aria-label") {
          label = arr[k + 1] ?? "";
          break;
        }
      }
    } catch {
      // best-effort; continue with empty label
    }
    out.push({ ref, role: "messagingConversationOpener", name: label });
  }
  return out;
}
