import type { CdpClient } from "../../../../cdp/client.js";
import type { RuntimeVisibleScopeControl, SnapshotEntry } from "../currentSurfaceTypes.js";
import { toUncappedVisibleScopeControls, toVisibleScopeControls } from "../visibleScopeCommon.js";

// Phase 73 (#49) — extractor + filter-first scope helpers for the company
// admin Activity → Comments page (`/company/<id>/admin/notifications/comments/`).
//
// Two concerns ship in this module:
//   - Gap #1 (73.1): comment-body text lives inside `<button aria-hidden>`
//     elements that the accessibility-tree snapshot drops. We re-run a DOM
//     extraction to recover it, mirroring the `commentThreads.ts` pattern.
//     Commenter NAME is sourced from the card's avatar `<img alt="...">`
//     (live-confirmed on all 16 visible Mastars cards in Step 5a DOM walk).
//   - Gap #4 (73.3): the 24-cap on `controls[]` drops the 11th+ commenter
//     pair on rich pages; a filter-first split (anchor entries unconditional,
//     non-anchor body entries cap at 24) restores them. Mirrors Phase 72's
//     `buildPostScopeControls` pattern, but stays separate per Phase 72
//     W-1 ruling — see `isActivityCommentAnchorEntry` divergence comment.
//
// Gap #2 (commenter profile URL surfacing — original Phase 73.2 scope) is
// PARTIAL-CLOSED as AG-21. Live DOM analysis showed `/in/<slug>/` URLs are
// fundamentally absent from notification card markup; the original 3-slot
// output (name • url • snippet) reduced to 2-slot (name • snippet) here.
// AG-21 carries forward the open question for a future phase that can
// resolve commenter URLs via thread-page navigation or another path.

// Private URL-gate predicate (N-1): MIRRORS the existing
// `isCompanyActivityCommentsPage` test at
// `buildVisibleScopeInspections.ts:71` per the `commentThreads.ts` precedent
// (which carries its own private `isCompanyReplyThreadPage`). Builder MUST
// NOT import from `buildVisibleScopeInspections.ts` — keeping each
// collector module self-contained avoids circular imports and matches the
// established pattern.
function isCompanyActivityCommentsPage(pageUrl: string): boolean {
  return /\/company\/[^/]+\/admin\/notifications\/comments\/?/i.test(pageUrl);
}

/**
 * Phase 73.1 — extract enriched per-card lines from the company admin
 * Activity → Comments DOM.
 *
 * Output: `string[]` of ` • `-joined lines per visible notification card.
 * Each line concatenates up to two slots from the card:
 *   `<commenterName> • <comment-text snippet>`
 * Empty slots are dropped (`filter(Boolean).join(" • ")`); a fully empty
 * card is skipped. Capped at 16 lines.
 *
 * URL-gated: returns `[]` immediately for non-activityComments URLs.
 *
 * Mirrors the runtime contract of `extractCompanyCommentThreadDomText`
 * (timeout, parse-fallback) so the wire-in caller can fall back to
 * entry-name `previewText` on DOM failure (graceful).
 *
 * Phase 73 Step 5a (AG-21): the original Step 4 design had a third slot
 * for the commenter's profile URL, sourced from a card-local
 * `<a href="/in/<slug>/">`. Live DOM analysis on
 * `/company/<id>/admin/notifications/comments/` showed `/in/` URLs are
 * fundamentally absent from notification card markup (verified across 16
 * visible cards on Mastars admin). The slot was removed; profile-URL
 * surfacing carries forward as AG-21 for a future phase that can resolve
 * commenter URLs via thread-page navigation or another path.
 */
export async function extractActivityCommentsDomText(client: CdpClient, pageUrl: string): Promise<string[]> {
  if (!isCompanyActivityCommentsPage(pageUrl)) {
    return [];
  }

  let stdout: string;
  try {
    stdout = await client.evaluate<string>(`(() => {
      const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
      const isVisible = (el) => {
        if (!(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      // The aria-hidden buttons LinkedIn uses to wrap comment bodies on
      // notifications cards. Per OQ-73.1, use innerText || textContent so
      // ARIA-suppressed nodes still yield text.
      const buttons = Array.from(document.querySelectorAll("button[aria-hidden='true']"))
        .filter((el) => isVisible(el));
      const seenLines = new Set();
      const lines = [];
      for (const button of buttons) {
        const snippetRaw = normalize(button.innerText || button.textContent || "");
        if (!snippetRaw) continue;
        // Phase 73 Step 5a (AG-21) — commenter NAME from the avatar img alt
        // text inside the nearest <article.nt-card> ancestor. Live DOM on
        // /company/<id>/admin/notifications/comments/ never carries an
        // <a href="/in/<slug>/"> for the commenter (verified across 16
        // visible cards), so the original 3-slot output (name • url •
        // snippet) reduces to a 2-slot (name • snippet) here. Profile URL
        // surfacing is carried forward as AG-21; revisit via thread
        // navigation in a future phase if the URL becomes essential.
        const card = button.closest("article.nt-card") || button.closest("article");
        let commenterName = "";
        if (card) {
          const avatarImg = card.querySelector("img[alt]");
          if (avatarImg) {
            commenterName = normalize(avatarImg.getAttribute("alt") || "");
          }
        }
        const snippet = snippetRaw.length > 240 ? snippetRaw.slice(0, 237).trimEnd() + "..." : snippetRaw;
        const line = [commenterName, snippet].filter(Boolean).join(" • ");
        if (!line) continue;
        const lower = line.toLowerCase();
        if (seenLines.has(lower)) continue;
        seenLines.add(lower);
        lines.push(line);
        if (lines.length >= 16) break;
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

// Phase 73.3 — anchor predicate for the filter-first 24-cap fix.
//
// DIVERGES INTENTIONALLY from TWO existing helpers; Builder MUST NOT
// merge, rename, or replace either:
//   1. Phase 72's `isSocialActionEntry` (`posts.ts`) — different question
//      (per-commenter pair vs. 5 fixed core-social labels).
//   2. The narrow `isCompanyActivityCommentAnchorEntry` at
//      `buildVisibleScopeInspections.ts:75` — that predicate matches ONLY
//      `^Respond to .+$` and is used as the ±4 / +6 entry-window anchor in
//      `collectCompanyActivityCommentEntries`. THIS predicate is BROAD
//      (matches both `Respond to X` AND "X commented on your company's
//      update") because the filter-first guarantee needs BOTH members of
//      each commenter pair to survive. Window-anchoring vs. filter-first
//      guarantee — co-existence intentional; consolidation would lose the
//      distinction.
//
// Phase 73 Step 5a (AG-21) note: the helper itself is unchanged — Step 5a's
// live-DOM finding affected the SIBLING extractor `extractActivityCommentsDomText`,
// not this anchor predicate. The previewText line shape was reduced from 3
// slots (name • url • snippet) to 2 slots (name • snippet) because `/in/<slug>/`
// URLs are absent from notification card DOM. AG-21 carries forward the open
// question of profile-URL surfacing for a future phase. The divergence-from-
// `isCompanyActivityCommentAnchorEntry` rationale is independent of that
// finding; the predicate's filter-first semantics remain correct.
const ACTIVITY_COMMENT_ANCHOR_PATTERNS: readonly RegExp[] = [
  /^Respond/i,
  / commented on your company's update$/i,
];

export function isActivityCommentAnchorEntry(entry: SnapshotEntry): boolean {
  if (entry.role !== "button" && entry.role !== "link") {
    return false;
  }
  const name = entry.name.trim();
  return ACTIVITY_COMMENT_ANCHOR_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Phase 88 — filter-first controls so notification-card anchors (Respond
 * + X commented...) survive the 24-cap on rich pages (20 cards × 2 anchor
 * types = 40 entries). Mirrors Phase 87.2's `buildCompanyCommentThreadScopeControls`
 * — the anchor group is UNCAPPED via `toUncappedVisibleScopeControls` (same
 * pattern). Body entries (sidebar chrome) cap at 24 via `toVisibleScopeControls`
 * — the parent `notifications` scope already carries full sidebar chrome, so
 * no information is lost. The two internal builder calls each start from
 * `controlIndex=1` and a fresh `labelOccurrence` map; ref ordinals therefore
 * restart in the anchor half. This is operationally invisible — `click`'s
 * label-based resolution matches against the controls array directly via
 * {label,role}, not via ref-string equality (Phase 72 OQ-2 ruling carried
 * forward).
 */
export function buildActivityCommentsScopeControls(
  handle: string,
  entries: readonly SnapshotEntry[],
): RuntimeVisibleScopeControl[] {
  const bodyEntries = entries.filter((entry) => !isActivityCommentAnchorEntry(entry));
  const anchorEntries = entries.filter((entry) => isActivityCommentAnchorEntry(entry));
  const bodyControls = toVisibleScopeControls(handle, bodyEntries);
  const anchorControls = toUncappedVisibleScopeControls(handle, anchorEntries);
  return [...bodyControls, ...anchorControls];
}
