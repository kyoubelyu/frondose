import type { VisibleScopeInspection, VisibleScopeSummary } from "../../contracts/inspect.js";
import type { CdpClient } from "../../../../cdp/client.js";
import type { RuntimeVisibleScopeControl, SnapshotEntry } from "../currentSurfaceTypes.js";
import { isPostActionEntry } from "../foregroundContext.js";
import {
  buttonsFromEntries,
  createVisibleScopeInspection,
  dedupeEntriesByRoleAndName,
  inputsFromEntries,
  previewTextFromEntries,
  toVisibleScopeControls,
} from "../visibleScopeCommon.js";

interface FeedPostDomPreview {
  menuLabel: string;
  text: string[];
  actorName?: string;
  actorFromAuthorLink?: boolean;
  // Phase 54 AG-3: author's LinkedIn href as returned by the browser eval.
  // `null` when no anchor was found; `undefined` when the eval predates the
  // Phase 54 path (shouldn't occur after this release).
  authorProfileUrl?: string | null;
}

interface ResolvedPostAnchor {
  anchor: SnapshotEntry;
  previewText?: string[];
  authorProfileUrl?: string;
  actorLabel?: string;
  startIndex?: number;
}

type LocalizedAnchorMatch = {
  actorIndex: number;
  candidateIndex: number;
  candidateOrder: number;
  direction: "before" | "after";
  hasSupport: boolean;
  startIndex: number;
};

export interface AnchorBackedPostVisibleScopeSegment {
  anchor: SnapshotEntry;
  entries: SnapshotEntry[];
  previewText?: string[];
  actorLabel?: string;
  // Phase 54 AG-3: optional author URL threaded through to VisibleScopeSummary.
  authorProfileUrl?: string;
}

function isFeedPostAnchorEntry(entry: SnapshotEntry): boolean {
  return entry.role === "button" && /^Open control menu for post by /i.test(entry.name);
}

function isFeedPostTailEntry(entry: SnapshotEntry): boolean {
  return (
    isPostActionEntry(entry) || (entry.role === "link" && /^(open actor selection screen|send)$/i.test(entry.name))
  );
}

// Phase 72 (#44, #47) — the 5 core social-action controls that must always
// reach `post:N.controls[]` regardless of body richness:
//   Button-role (3): Open reactions menu, Comment, Repost
//   Link-role   (2): Open actor selection screen, Send
//
// DIVERGES INTENTIONALLY from `isFeedPostTailEntry` above (which still
// includes "reply" and "load more comments" via `isPostActionEntry`). Those
// labels are comment-thread navigation, NOT core social actions on the post
// itself — they correctly stay in body entries (no special filter-first
// guarantee). Builder MUST NOT merge or rename these helpers (Phase 72
// W-1 / N-1).
const POST_SOCIAL_BUTTON_LABELS = /^(open reactions menu|comment|repost)$/i;
// Phase 80 (#52) — added link-role "comment" to close AG-20: company-admin
// posts (and third-party profile activity-feed posts per Phase 80 research
// §3) emit Comment as role="link", not role="button". Including it here
// ensures both `buildPostScopeControls` (feed/company `post:N`) and the new
// `buildProfileContentScopeControls` (profile `content` — see
// trustedRegions.ts) treat it as a social-action entry that bypasses the
// 24-cap. Click-by-label is positional-agnostic (Phase 72 OQ-2 ruling),
// so the ordering shift inside `controls[]` is operationally invisible.
const POST_SOCIAL_LINK_LABELS = /^(open actor selection screen|send|comment)$/i;

export function isSocialActionEntry(entry: SnapshotEntry): boolean {
  const name = entry.name.trim();
  if (entry.role === "button" && POST_SOCIAL_BUTTON_LABELS.test(name)) return true;
  if (entry.role === "link" && POST_SOCIAL_LINK_LABELS.test(name)) return true;
  return false;
}

// Phase 72 filter-first builder — body entries cap at 24 via the existing
// `toVisibleScopeControls` helper; social-action entries append
// unconditionally. Result is a `controls[]` array of length ≤ 24 + 5 = 29
// on the richest posts (most posts will be well under that). The two
// internal `toVisibleScopeControls` calls each start from `controlIndex=1`
// and a fresh `labelOccurrence` map; ref ordinals therefore restart in the
// social half. This is operationally invisible — `click`'s label-based
// resolution matches against the controls array directly via {label,role},
// not via ref-string equality (Phase 72 OQ-2 ruling).
function buildPostScopeControls(handle: string, entries: readonly SnapshotEntry[]): RuntimeVisibleScopeControl[] {
  const bodyEntries = entries.filter((e) => !isSocialActionEntry(e));
  // Phase 89 (#73) — dedupe by {role, name} so duplicate social labels
  // (e.g. two "Repost" buttons when an embedded repost-of-a-post card
  // renders its own social bar inside the outer post's segment window)
  // collapse to a single control. `dedupeEntriesByRoleAndName` keeps the
  // LAST occurrence — see plan §3 for the DOM-ordering justification.
  const socialEntries = dedupeEntriesByRoleAndName(entries.filter((e) => isSocialActionEntry(e)));
  const bodyControls = toVisibleScopeControls(handle, bodyEntries);
  const socialControls = toVisibleScopeControls(handle, socialEntries);
  return [...bodyControls, ...socialControls];
}

function resolvePostCollectionStartIndex(entries: SnapshotEntry[], anchorIndex: number, lowerBound: number): number {
  let startIndex = anchorIndex;

  for (let index = anchorIndex - 1; index >= lowerBound; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }

    if (isFeedPostAnchorEntry(entry)) {
      return index + 1;
    }

    if (isFeedPostTailEntry(entry)) {
      return index + 1;
    }

    startIndex = index;
  }

  return startIndex;
}

function extractActorLabel(menuLabel: string): string {
  const match = menuLabel.match(/^Open control menu for post by (.+)$/i);
  return match && match[1] !== undefined ? match[1].trim() : menuLabel;
}

function extractPostActorLine(text: readonly string[] | undefined): string | undefined {
  const first = text?.[0]?.trim();
  const match = first?.match(/^Post actor:\s*(.+)$/);
  return match?.[1]?.trim() || undefined;
}

function extractCorrelatableActor(preview: FeedPostDomPreview): string | undefined {
  return preview.actorFromAuthorLink === true ? preview.actorName?.trim() || extractPostActorLine(preview.text) : undefined;
}

function normalizeEvidenceText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function isActorEvidenceEntry(entry: SnapshotEntry, actorName: string): boolean {
  const normalizedName = normalizeEvidenceText(entry.name);
  const normalizedActor = normalizeEvidenceText(actorName);
  if (!normalizedName || !normalizedActor) {
    return false;
  }
  const role = entry.role.toLocaleLowerCase();
  const canCarryActor =
    role === "link" ||
    role === "heading" ||
    role === "paragraph" ||
    role === "text" ||
    role === "span" ||
    role === "generic" ||
    role === "unknown";
  return canCarryActor && (normalizedName === normalizedActor || normalizedName.includes(normalizedActor));
}

// Phase 83.5b — merged feed + search extractors (OQ-83.D full merge).
// Single IIFE template string carries an internal `if (surface === "feed")`
// branch for the two true points of divergence (container detection +
// text payload); shared helpers (normalize, isVisible, labelOf,
// extractAuthorProfileUrl, anchor regex, safe-fail, double-parse) emit
// once. Validator gates byte-fidelity against the pre-83.5b extractors
// via `git restore` equivalence (plan §5 L2 path 2).
//
// Phase 79 contract preserved: emits the same `previewText[0/1]` shape
// (`Post actor: …` + optional `Rendered context: …`) so
// feedPostResolver.ts:extractFeedPostAuthorName /
// extractFeedPostHeadline work unchanged on both surfaces.
//
// Feed container detection is DOM-structural as of Phase 91: visible
// listitem/legacy post shell + visible author link + menu-like button hint.
// Search keeps the Phase 79 text-pattern heuristic below.
//
// OQ-79.B safe-fail (search): if the headline regex misses, omit the
// `Rendered context: …` line entirely. Downstream this leaves tier2.role
// null in feedPostResolver; per icpMatcher.ts deriveQualificationFromMatch
// catch-all, untracked authors emit `qualification: "tracked"` (no
// `trackedSince`) — matching existing feed behavior on the same fallback
// path, NOT suppression. Tracked authors still emit blocks (Phase 78
// invariant).
export async function extractPostDomPreviews(client: CdpClient, surface: "feed" | "search"): Promise<FeedPostDomPreview[]> {
  let stdout: string;
  try {
    stdout = await client.evaluate<string>(`(() => {
      const SURFACE = ${JSON.stringify(surface)};
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
      const labelOf = (el) => normalize(el.getAttribute("aria-label") || el.innerText || el.textContent);
      const anchorButtons = Array.from(document.querySelectorAll("button,[role='button']")).filter((element) => {
        const label = labelOf(element);
        return /^Open control menu for post by /i.test(label) && isVisible(element);
      }).slice(0, 30);
      // Phase 54 AG-3 / A1 + Phase 55 D55-LE-1 — three-tier author-href
      // resolution. (1) /company/ link inside actor region (covers
      // company-admin posts where the admin avatar /in/ link precedes
      // the company name link in DOM order — Hermès / Ellen Wei case);
      // (2) /in/ link inside actor region (normal person posts);
      // (3) broad fallback covers posts whose actor region class doesn't
      // contain "actor" (sponsored posts, A/B variants, future LinkedIn
      // DOM changes — Phase 54 architect lock A1 / Phase 55 A2 preserve
      // this resilience tier).
      const extractAuthorProfileUrl = (root) => {
        const actorEl = root.querySelector('[class*="actor"]') || root;
        const companyConstrained = actorEl.querySelector('a[href*="/company/"]');
        if (companyConstrained) {
          return companyConstrained.getAttribute("href") || null;
        }
        const personConstrained = actorEl.querySelector('a[href*="/in/"]');
        if (personConstrained) {
          return personConstrained.getAttribute("href") || null;
        }
        const broad = root.querySelector('a[href*="/in/"], a[href*="/company/"]');
        return broad ? broad.getAttribute("href") : null;
      };
      if (SURFACE === "feed") {
        const visibleProfileLinks = (root) =>
          Array.from(root.querySelectorAll('a[href*="/company/"], a[href*="/in/"]')).filter(isVisible);
        const firstVisibleTextLine = (el) =>
          (el.innerText || el.textContent || "")
            .split(/\\n+/)
            .map(normalize)
            .find(Boolean) || "";
        const collapseRepeatedText = (value) => {
          const words = value.split(" ").filter(Boolean);
          if (words.length > 1 && words.length % 2 === 0) {
            const half = words.length / 2;
            const left = words.slice(0, half).join(" ");
            const right = words.slice(half).join(" ");
            if (left === right) {
              return left;
            }
          }
          const compact = value.replace(/\\s+/g, "");
          if (compact.length >= 4 && compact.length % 2 === 0) {
            const half = compact.length / 2;
            if (compact.slice(0, half) === compact.slice(half)) {
              return compact.slice(0, half);
            }
          }
          return value;
        };
        const actorNameFromLink = (link) => {
          const label = labelOf(link);
          const viewMatch = label.match(/^View:\\s+(.+?)(?:\\s+\\u2022|$)/i);
          if (viewMatch && viewMatch[1]) {
            return viewMatch[1].trim();
          }
          return collapseRepeatedText(firstVisibleTextLine(link));
        };
        const extractVisibleAuthorEvidence = (root) => {
          const actorEl = root.querySelector('[class*="actor"]') || root;
          const companyConstrained = visibleProfileLinks(actorEl).find((link) =>
            (link.getAttribute("href") || "").includes("/company/"),
          );
          const personConstrained = visibleProfileLinks(actorEl).find((link) =>
            (link.getAttribute("href") || "").includes("/in/"),
          );
          const broad = visibleProfileLinks(root)[0];
          const link = companyConstrained || personConstrained || broad;
          if (!link) {
            return null;
          }
          const name = actorNameFromLink(link);
          if (!name) {
            return null;
          }
          return {
            name,
            href: link.getAttribute("href") || null,
          };
        };
        const hasMenuStructureHint = (button) => {
          const label = labelOf(button);
          if (/^Open control menu for post by /i.test(label) || /^(open options|open menu)$/i.test(label)) {
            return true;
          }
          if ((button.getAttribute("aria-haspopup") || "").toLowerCase() === "menu") {
            return true;
          }
          const elements = [button, ...Array.from(button.querySelectorAll("svg,use,path"))];
          const blob = elements
            .flatMap((el) =>
              ["id", "class", "href", "xlink:href", "data-test-icon", "data-icon-name", "aria-label"].map(
                (name) => el.getAttribute(name) || "",
              ),
            )
            .join(" ");
          return /overflow|ellipsis|more|menu|options/i.test(blob);
        };
        const isPostContainer = (element) => {
          if (!(element instanceof Element) || !isVisible(element)) {
            return false;
          }
          const className = element.getAttribute("class") || "";
          const hasLinkedInPostShell = /(?:^|\\s)feed-shared-update-v2(?:\\s|$)/.test(className);
          const hasModernFeedPostShell = element.getAttribute("role") === "listitem";
          return hasLinkedInPostShell || hasModernFeedPostShell;
        };
        const findPostContainer = (button) => {
          let current = button.parentElement;
          while (current && current !== document.body) {
            if (isPostContainer(current)) {
              const author = extractVisibleAuthorEvidence(current);
              if (author) {
                return { root: current, author };
              }
            }
            current = current.parentElement;
          }
          return null;
        };
        const collectVisibleTextLines = (root) => {
          const bannedExact = new Set([
            "like",
            "comment",
            "repost",
            "send",
            "share",
            "follow",
            "following",
            "connect",
            "see more",
            "see less",
            "open reactions menu",
            "open options",
            "open control menu",
            "open control menu for post by",
            "open control menu for post",
            "open menu",
            "boost",
            "expand",
            "collapse",
            "hashtag",
            "#",
            "...more",
            "…more",
          ]);
          const bannedPrefixes = [
            "open control menu for post by ",
            "open options for ",
            "react like to ",
            "view ",
            "post impressions ",
            "profile viewers ",
          ];
          const lines = [];
          const seen = new Set();
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let current = walker.nextNode(); current; current = walker.nextNode()) {
            const parent = current.parentElement;
            if (!parent) {
              continue;
            }
            if (parent.closest("button, [role='button'], input, textarea, select")) {
              continue;
            }
            const line = normalize(current.textContent || "");
            if (!line) {
              continue;
            }
            const lower = line.toLowerCase();
            if (bannedExact.has(lower) || bannedPrefixes.some((prefix) => lower.startsWith(prefix))) {
              continue;
            }
            if (seen.has(lower)) {
              continue;
            }
            seen.add(lower);
            lines.push(line);
          }
          return lines;
        };
        const feedButtons = Array.from(document.querySelectorAll("button,[role='button']"))
          .filter((button) => isVisible(button) && labelOf(button) && hasMenuStructureHint(button))
          .map((button) => ({ button, match: findPostContainer(button) }))
          .filter((candidate) => candidate.match)
          .slice(0, 30);
        const payload = feedButtons.map(({ button, match }) => {
          const root = match.root;
          const author = match.author;
          const bodyText = collectVisibleTextLines(root).filter((line) => normalize(line) !== normalize(author.name));
          const text = ["Post actor: " + author.name, ...bodyText];
          const authorProfileUrl = extractAuthorProfileUrl(root) || author.href;
          return {
            menuLabel: labelOf(button),
            text,
            actorName: author.name,
            actorFromAuthorLink: true,
            authorProfileUrl,
          };
        });
        return JSON.stringify(payload);
      } else {
        const isSearchPostContainer = (element) => {
          if (!(element instanceof Element)) {
            return false;
          }
          const tag = element.tagName.toLowerCase();
          if (tag !== "article" && tag !== "li") {
            return false;
          }
          const text = normalize(element.innerText || "").toLowerCase();
          return text.length > 0 && text.includes("feed post");
        };
        const findContainer = (button) => {
          let current = button.parentElement;
          while (current && current !== document.body) {
            if (isSearchPostContainer(current)) {
              return current;
            }
            current = current.parentElement;
          }
          return null;
        };
        // Headline parse: "View: <name> [<badge>]? • <degree> <headline>".
        // Tolerate optional badge tokens between name and bullet.
        const parseHeadline = (root) => {
          const links = Array.from(root.querySelectorAll('a[aria-label^="View: "]'));
          for (const a of links) {
            const lbl = labelOf(a);
            const match = lbl.match(/^View:\\s+(.+?)\\s+\\u2022\\s+(?:1st|2nd|3rd\\+?)\\s+(.+)$/i);
            if (match && match[2]) {
              return match[2].trim();
            }
          }
          return null;
        };
        const payload = [];
        for (const button of anchorButtons) {
          const menuLabel = labelOf(button);
          const actorMatch = menuLabel.match(/^Open control menu for post by (.+)$/i);
          const actorName = actorMatch ? actorMatch[1].trim() : "";
          // OQ-79.B: skip the entry entirely if actor name fails to parse —
          // never emit "Post actor: " with empty trailing.
          if (!actorName) {
            continue;
          }
          const container = findContainer(button) || button;
          const headline = parseHeadline(container);
          const text = headline
            ? ["Post actor: " + actorName, "Rendered context: " + headline]
            : ["Post actor: " + actorName];
          const authorProfileUrl = extractAuthorProfileUrl(container);
          payload.push({ menuLabel, text, authorProfileUrl });
        }
        return JSON.stringify(payload);
      }
    })()`);
  } catch {
    return [];
  }

  if (!stdout) {
    return [];
  }

  try {
    const parsed = JSON.parse(stdout) as FeedPostDomPreview[] | string;
    return typeof parsed === "string" ? (JSON.parse(parsed) as FeedPostDomPreview[]) : parsed;
  } catch {
    return [];
  }
}

function resolveVisiblePostAnchors(
  postAnchors: SnapshotEntry[],
  orderedDomPreviews: FeedPostDomPreview[],
  maxVisiblePostCount: number,
): ResolvedPostAnchor[] {
  const usedAnchorRefs = new Set<string>();
  const visibleAnchors: ResolvedPostAnchor[] = [];

  for (const preview of orderedDomPreviews) {
    const match = postAnchors.find((anchor) => anchor.name === preview.menuLabel && !usedAnchorRefs.has(anchor.ref));
    if (!match) {
      continue;
    }

    visibleAnchors.push({
      anchor: match,
      previewText: preview.text,
      // Phase 54 AG-3 / N1 — coerce null → undefined so the optional
      // string field stays well-typed across the chain.
      authorProfileUrl: preview.authorProfileUrl ?? undefined,
    });
    usedAnchorRefs.add(match.ref);
  }

  const targetVisiblePostCount = Math.min(postAnchors.length, maxVisiblePostCount);
  if (visibleAnchors.length >= targetVisiblePostCount) {
    return visibleAnchors;
  }

  for (const anchor of postAnchors) {
    if (usedAnchorRefs.has(anchor.ref)) {
      continue;
    }

    visibleAnchors.push({ anchor });
    usedAnchorRefs.add(anchor.ref);
    if (visibleAnchors.length >= targetVisiblePostCount) {
      break;
    }
  }

  return visibleAnchors;
}

function findActorEvidenceIndex(entries: SnapshotEntry[], actorName: string, startIndex: number, endIndex: number): number {
  for (let index = startIndex; index < endIndex; index += 1) {
    const entry = entries[index];
    if (entry && isActorEvidenceEntry(entry, actorName)) {
      return index;
    }
  }
  return -1;
}

function hasPreviewSupportEntry(entries: SnapshotEntry[], preview: FeedPostDomPreview, startIndex: number, endIndex: number): boolean {
  const supportLines = preview.text.slice(1).map(normalizeEvidenceText).filter(Boolean);
  return (
    supportLines.length > 0 &&
    entries.slice(startIndex, endIndex).some((entry) => {
      const entryText = normalizeEvidenceText(entry.name);
      return entryText && supportLines.some((line) => entryText.includes(line) || line.includes(entryText));
    })
  );
}

function selectLocalizedAnchorMatch(matches: LocalizedAnchorMatch[]): LocalizedAnchorMatch | undefined {
  if (matches.length === 1) {
    return matches[0];
  }
  const actorEvidenceIndexes = new Set(matches.map((match) => match.actorIndex));
  if (actorEvidenceIndexes.size === 1) {
    const afterMatch = matches.find((match) => match.direction === "after");
    if (afterMatch?.hasSupport || (afterMatch && afterMatch.candidateOrder > 0)) {
      return afterMatch;
    }
    return matches.find((match) => match.direction === "before");
  }
  return undefined;
}

function resolveLocalizedPostAnchors(
  entries: SnapshotEntry[],
  orderedDomPreviews: FeedPostDomPreview[],
): ResolvedPostAnchor[] {
  const usedAnchorRefs = new Set<string>();
  const resolved: ResolvedPostAnchor[] = [];
  const previewMenuLabels = new Set(orderedDomPreviews.map((preview) => preview.menuLabel).filter(Boolean));
  const localizedCandidateIndexes = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.role === "button" && previewMenuLabels.has(entry.name))
    .map(({ index }) => index);

  for (const preview of orderedDomPreviews) {
    const actorName = extractCorrelatableActor(preview);
    if (!actorName || !preview.menuLabel) {
      continue;
    }

    const candidateIndexes = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.role === "button" && entry.name === preview.menuLabel && !usedAnchorRefs.has(entry.ref))
      .map(({ index }) => index);
    const correlated = candidateIndexes
      .map((candidateIndex, candidateOrder) => {
        const resolvedAnchorIndexes = resolved
          .map(({ anchor }) => entries.findIndex((entry) => entry.ref === anchor.ref))
          .filter((index) => index >= 0)
          .sort((left, right) => left - right);
        const previousCandidateIndex = candidateOrder > 0 ? (candidateIndexes[candidateOrder - 1] ?? -1) : -1;
        const previousAcceptedIndex = resolvedAnchorIndexes.filter((index) => index < candidateIndex).at(-1) ?? -1;
        const nextSameLabelCandidateIndex = candidateIndexes[candidateOrder + 1] ?? entries.length;
        const nextLocalizedCandidateIndex =
          localizedCandidateIndexes.find((index) => index > candidateIndex) ?? entries.length;
        const nextAcceptedIndex = resolvedAnchorIndexes.find((index) => index > candidateIndex) ?? entries.length;
        const lowerBound = Math.max(previousAcceptedIndex + 1, previousCandidateIndex + 1);
        const beforeActorIndex = findActorEvidenceIndex(entries, actorName, lowerBound, candidateIndex);
        if (beforeActorIndex >= 0) {
          return {
            candidateIndex,
            candidateOrder,
            actorIndex: beforeActorIndex,
            direction: "before" as const,
            hasSupport: false,
            startIndex: beforeActorIndex,
          };
        }
        const upperBound = Math.min(nextSameLabelCandidateIndex, nextLocalizedCandidateIndex, nextAcceptedIndex);
        const afterActorIndex = findActorEvidenceIndex(entries, actorName, candidateIndex + 1, upperBound);
        return {
          candidateIndex,
          candidateOrder,
          actorIndex: afterActorIndex,
          direction: "after" as const,
          hasSupport: hasPreviewSupportEntry(entries, preview, candidateIndex + 1, upperBound),
          startIndex: candidateIndex,
        };
      })
      .filter((match) => match.actorIndex >= 0);

    const matched = selectLocalizedAnchorMatch(correlated);
    if (!matched) {
      continue;
    }
    const { candidateIndex } = matched;
    const anchor = entries[candidateIndex];
    if (!anchor) {
      continue;
    }

    resolved.push({
      anchor,
      previewText: preview.text,
      authorProfileUrl: preview.authorProfileUrl ?? undefined,
      actorLabel: actorName,
      startIndex: matched.startIndex,
    });
    usedAnchorRefs.add(anchor.ref);
  }

  return resolved;
}

export function collectAnchorBackedPostVisibleScopeSegments(
  entries: SnapshotEntry[],
  options?: {
    maxVisiblePostCount?: number;
    orderedDomPreviews?: FeedPostDomPreview[];
    previewTextByAnchorLabel?: Map<string, string[]>;
  },
): AnchorBackedPostVisibleScopeSegment[] {
  const postAnchors = entries.filter((entry) => isFeedPostAnchorEntry(entry));
  const previewTextByAnchorLabel = options?.previewTextByAnchorLabel ?? new Map<string, string[]>();
  const orderedDomPreviews =
    options?.orderedDomPreviews ??
    Array.from(previewTextByAnchorLabel.entries()).map(([menuLabel, text]) => ({ menuLabel, text }));
  const maxVisiblePostCount = options?.maxVisiblePostCount ?? 3;
  const localizedAnchors =
    postAnchors.length === 0 ? resolveLocalizedPostAnchors(entries, orderedDomPreviews) : [];
  const visiblePostAnchors =
    postAnchors.length > 0
      ? resolveVisiblePostAnchors(postAnchors, orderedDomPreviews, maxVisiblePostCount)
      : localizedAnchors.slice(0, maxVisiblePostCount);
  if (visiblePostAnchors.length === 0) {
    return [];
  }
  const boundaryAnchors: ResolvedPostAnchor[] =
    postAnchors.length > 0 ? postAnchors.map((anchor) => ({ anchor })) : localizedAnchors;
  const segments: AnchorBackedPostVisibleScopeSegment[] = [];

  for (const { anchor, previewText, authorProfileUrl, actorLabel, startIndex: anchoredStartIndex } of visiblePostAnchors) {
    const anchorEntryIndex = entries.findIndex((entry) => entry.ref === anchor.ref);
    const startIndex =
      anchoredStartIndex ?? (anchorEntryIndex >= 0 ? resolvePostCollectionStartIndex(entries, anchorEntryIndex, 0) : -1);
    const anchorIndex = boundaryAnchors.findIndex((candidate) => candidate.anchor.ref === anchor.ref);
    const nextAnchor = anchorIndex >= 0 ? boundaryAnchors[anchorIndex + 1] : undefined;
    const endIndex = nextAnchor
      ? (nextAnchor.startIndex ?? entries.findIndex((entry) => entry.ref === nextAnchor.anchor.ref))
      : entries.length;
    const segmentEntries = startIndex >= 0 ? entries.slice(startIndex, endIndex) : [];
    segments.push({
      anchor,
      entries: segmentEntries,
      ...(previewText ? { previewText: previewText.slice(0, 8) } : {}),
      ...(actorLabel ? { actorLabel } : {}),
      ...(authorProfileUrl ? { authorProfileUrl } : {}),
    });
  }

  return segments;
}

export function buildAnchorBackedPostVisibleScopeInspections(
  entries: SnapshotEntry[],
  parent: string,
  options?: {
    maxVisiblePostCount?: number;
    orderedDomPreviews?: FeedPostDomPreview[];
    previewTextByAnchorLabel?: Map<string, string[]>;
    activeCommentComposerEntries?: SnapshotEntry[];
  },
): VisibleScopeInspection[] {
  const segments = collectAnchorBackedPostVisibleScopeSegments(entries, options);
  const inspections: VisibleScopeInspection[] = [];
  const activeCommentRefs = new Set((options?.activeCommentComposerEntries ?? []).map((entry) => entry.ref));
  const activeCommentFirstIndex = options?.activeCommentComposerEntries?.length
    ? entries.findIndex((entry) => entry.ref === options.activeCommentComposerEntries?.[0]?.ref)
    : -1;
  const segmentContainingActiveCommentIndex = segments.findIndex((segment) =>
    segment.entries.some((entry) => activeCommentRefs.has(entry.ref)),
  );
  const nearestSegmentBeforeActiveCommentIndex =
    segmentContainingActiveCommentIndex >= 0 || activeCommentFirstIndex < 0
      ? -1
      : segments.reduce((nearestIndex, segment, segmentIndex) => {
          const anchorIndex = entries.findIndex((entry) => entry.ref === segment.anchor.ref);
          if (anchorIndex >= 0 && anchorIndex < activeCommentFirstIndex) {
            return segmentIndex;
          }
          return nearestIndex;
        }, -1);

  for (const [index, segment] of segments.entries()) {
    const text =
      segment.previewText ??
      options?.previewTextByAnchorLabel?.get(segment.anchor.name) ??
      previewTextFromEntries(segment.entries);
    const handle = `post:${index + 1}`;
    const segmentEntryRefs = new Set(segment.entries.map((entry) => entry.ref));
    const shouldAttachActiveComment =
      activeCommentRefs.size > 0 &&
      (index === segmentContainingActiveCommentIndex || index === nearestSegmentBeforeActiveCommentIndex);
    const entriesWithActiveComment = shouldAttachActiveComment
      ? [
          ...segment.entries,
          ...(options?.activeCommentComposerEntries ?? []).filter((entry) => !segmentEntryRefs.has(entry.ref)),
        ]
      : segment.entries;
    // Phase 72 (#44/#47) — pre-build controls via the filter-first split so
    // social-action entries reach `controls[]` regardless of body richness.
    // Thread the same array through both `summary.controls` and the new
    // `prebuiltControls` escape hatch on `createVisibleScopeInspection` to
    // bypass the helper's internal 24-cap re-computation.
    const prebuiltControls = buildPostScopeControls(handle, entriesWithActiveComment);
    const summary: VisibleScopeSummary = {
      handle,
      kind: "post",
      label: segment.actorLabel ?? extractActorLabel(segment.anchor.name),
      parent,
      anchorRef: segment.anchor.ref,
      previewText: text.slice(0, 8),
      buttons: buttonsFromEntries(entriesWithActiveComment),
      inputs: inputsFromEntries(entriesWithActiveComment),
      controls: prebuiltControls,
      ...(segment.authorProfileUrl ? { authorProfileUrl: segment.authorProfileUrl } : {}),
    };
    inspections.push(
      createVisibleScopeInspection(summary, text, entriesWithActiveComment, {
        prebuiltControls,
      }),
    );
  }

  return inspections;
}
