import type { VisibleScopeInspection, VisibleScopeSummary } from "../../contracts/inspect.js";
import { type VisibleScopeKind } from "../../contracts/visibleScope.js";
import type { SnapshotEntry } from "../currentSurfaceTypes.js";
import type { CdpClient } from "../../../../cdp/client.js";
import {
  buttonsFromEntries,
  createVisibleScopeInspection,
  inputsFromEntries,
  previewTextFromEntries,
  toVisibleScopeControls,
} from "../visibleScopeCommon.js";

interface ConnectablePersonSummary {
  inviteLabel: string;
  personName: string;
}

function extractConnectablePersonSummary(label: string): ConnectablePersonSummary | null {
  const match = label.match(/^Invite (.+) to connect$/i);
  if (!match) {
    return null;
  }

  const personName = match[1]?.trim();
  if (!personName) {
    return null;
  }

  return {
    inviteLabel: label,
    personName,
  };
}

function isConnectablePersonInviteEntry(entry: SnapshotEntry): boolean {
  return entry.role === "button" && extractConnectablePersonSummary(entry.name) !== null;
}

function isConnectablePersonSectionBoundaryEntry(entry: SnapshotEntry): boolean {
  const normalizedName = entry.name.trim();
  if (!normalizedName) {
    return false;
  }

  if (entry.role === "link" && /^Show all suggestions for /i.test(normalizedName)) {
    return true;
  }

  return /^(See all people results|Show more results)$/i.test(normalizedName);
}

function findConnectablePersonStartIndex(entries: SnapshotEntry[], anchorIndex: number, personName: string): number {
  const normalizedName = personName.replace(/\s+/g, " ").trim().toLowerCase();
  let startIndex = anchorIndex;

  for (let index = anchorIndex - 1; index >= 0 && index >= anchorIndex - 8; index -= 1) {
    const entry = entries[index];
    if (!entry || isConnectablePersonInviteEntry(entry)) {
      break;
    }

    const normalizedEntry = entry.name.replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalizedEntry) {
      continue;
    }

    if (
      normalizedEntry === normalizedName ||
      normalizedEntry.includes(`${normalizedName}'s profile`) ||
      normalizedEntry.includes(`${normalizedName}’s profile`) ||
      normalizedEntry.includes(normalizedName)
    ) {
      startIndex = index;
    }
  }

  return startIndex;
}

function findConnectablePersonEndIndex(entries: SnapshotEntry[], anchorIndex: number): number {
  for (let index = anchorIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    if (isConnectablePersonSectionBoundaryEntry(entry)) {
      return index;
    }

    if (!isConnectablePersonInviteEntry(entry)) {
      continue;
    }

    const summary = extractConnectablePersonSummary(entry.name);
    if (!summary) {
      return index;
    }

    const nextStartIndex = findConnectablePersonStartIndex(entries, index, summary.personName);
    return nextStartIndex >= 0 ? nextStartIndex : index;
  }

  return entries.length;
}

interface PersonCardDomPreview {
  personName: string;
  text: string[];
}

// Phase 81 (#53) — accessibility-tree filter at snapshotCapture.ts:242 drops
// LinkedIn's headline + location <span role="generic"> elements (no aria-name
// → empty entry.name → filtered out). DOM eval bridges the gap, mirroring
// Phase 79's extractSearchPostDomPreviews pattern: tag heuristic + innerText
// pattern (NO CSS selectors per OQ-79.C carry); name-first-line walk-up
// container heuristic; prefix-tagged result lines so consumers can parse the
// specific field without knowing ordinal position (Phase 79 prefix precedent).
//
// Surface-aware parsing (single eval, branching algorithm per OQ-81.B):
//   • search-people (degree bullet present): headline = lines[degreeIdx+2],
//     location = lines[degreeIdx+3] with CTA/mutual/followers exclusion.
//   • networkView (no degree bullet): headline = lines[2], location =
//     lines[3] with the same exclusion (institution-vs-geographic distinction
//     reported as "Location: …" uniformly per OQ-81.E ruling).
//
// Safe-fail (OQ-79.B carry): if container or actor-name parse fails → emit
// no extra lines for that card; pre-Phase-81 baseline preserved.
//
// SINGLE EVAL PER inspect (R-2d lock): one browser-side call extracts all
// visible cards in a single browser-side IIFE iteration; latency is
// surface-fixed, not per-card.
export async function extractPersonCardDomPreviews(client: CdpClient): Promise<PersonCardDomPreview[]> {
  let stdout: string;
  try {
    stdout = await client.evaluate<string>(`(() => {
      const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
      const isVisible = (el) => {
        if (!(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const labelOf = (el) => normalize(el.getAttribute("aria-label") || el.innerText || el.textContent);

      // Anchor: visible CTA buttons matching connectable-person invite/
      // follow/message patterns. This regex is INTENTIONALLY a strict
      // superset of extractConnectablePersonSummary's scope-construction-
      // time gate (which only accepts /^Invite (.+) to connect$/i). The
      // broader pattern catches person cards under any CTA variant so
      // enrichment fires for follow/message-only cards too; the strict
      // consumer-side gate in buildConnectablePersonVisibleScopeInspections
      // then prevents non-person matches (e.g. company Follow CTAs in
      // universal /search/results/?keywords=... results) from corrupting
      // any personCard:N scope, since the name-keyed Map lookup never
      // resolves company names to a personCard scope. R-2c per plan §6.
      const ctaPattern = /^(Invite (.+) to connect|Follow (.+)|Message (.+))$/i;
      const anchorButtons = Array.from(
        document.querySelectorAll("button,[role='button']"),
      ).filter((el) => {
        const lbl = labelOf(el);
        return ctaPattern.test(lbl) && isVisible(el);
      }).slice(0, 12);

      // Container: name-first-line walk-up. No CSS classes, no role-based
      // queries — pure innerText comparison (OQ-79.C carry). Tolerates the
      // duplicate-name anomaly (research §3.1 Variant H) because line[0]
      // remains the name even when LinkedIn renders it twice.
      const findContainer = (button, personName) => {
        let cur = button.parentElement;
        for (let depth = 0; depth < 12; depth += 1) {
          if (!cur || cur === document.body) break;
          const lines = (cur.innerText || "").split("\\n").map((l) => normalize(l)).filter(Boolean);
          const firstLine = lines[0];
          if (firstLine && firstLine.split(",")[0].trim() === personName) {
            return { el: cur, lines };
          }
          cur = cur.parentElement;
        }
        return null;
      };

      const CTA_RE = /^(Connect|Follow|Message|Pending)$/i;
      const MUTUAL_RE = /(?:is a mutual|are mutual|other mutual)/i;
      const FOLLOWERS_RE = /\\bfollowers?\\b/i;
      const isInvalidLocation = (line) =>
        !line || CTA_RE.test(line) || MUTUAL_RE.test(line) || FOLLOWERS_RE.test(line);

      const extractFromLines = (lines) => {
        // degreeIdx is the surface marker: present on search-people cards,
        // absent on networkView cards. Per OQ-81.A: findIndex (NOT fixed
        // position) — Variant H (duplicate-name) shifts the index from 2
        // to 3 and the anchor adapts.
        const degreeIdx = lines.findIndex((l) => /^\\u2022\\s*(?:1st|2nd|3rd\\+?)/i.test(l));
        let headline = null;
        let location = null;
        if (degreeIdx >= 0) {
          headline = lines[degreeIdx + 2] || null;
          const candidate = lines[degreeIdx + 3] || null;
          location = isInvalidLocation(candidate) ? null : candidate;
        } else {
          headline = lines[2] || null;
          const candidate = lines[3] || null;
          location = isInvalidLocation(candidate) ? null : candidate;
        }
        if (headline && CTA_RE.test(headline)) headline = null;
        return { headline, location };
      };

      const ctaToPersonName = (label) => {
        const m = label.match(ctaPattern);
        // Match groups: 2 = invite-name, 3 = follow-name, 4 = message-name.
        const captured = m && (m[2] || m[3] || m[4]);
        return captured ? captured.trim() : "";
      };

      const payload = [];
      const seen = new Set();
      for (const button of anchorButtons) {
        const personName = ctaToPersonName(labelOf(button));
        if (!personName || seen.has(personName)) continue;
        seen.add(personName);
        const found = findContainer(button, personName);
        if (!found) continue;
        const { headline, location } = extractFromLines(found.lines);
        const text = [];
        if (headline) text.push("Headline: " + headline);
        if (location) text.push("Location: " + location);
        if (text.length === 0) continue;
        payload.push({ personName, text });
      }
      return JSON.stringify(payload);
    })()`);
  } catch {
    return [];
  }

  if (!stdout) return [];
  try {
    const parsed = JSON.parse(stdout) as PersonCardDomPreview[] | string;
    return typeof parsed === "string" ? (JSON.parse(parsed) as PersonCardDomPreview[]) : parsed;
  } catch {
    return [];
  }
}

export async function buildConnectablePersonVisibleScopeInspections(
  client: CdpClient,
  entries: SnapshotEntry[],
  parent: "networkView" | "searchResults",
  kind: Extract<VisibleScopeKind, "networkView" | "searchResults">,
  maxVisiblePersonCount = 8,
): Promise<VisibleScopeInspection[]> {
  const personAnchors = entries
    .filter((entry) => isConnectablePersonInviteEntry(entry))
    .slice(0, maxVisiblePersonCount);
  const inspections: VisibleScopeInspection[] = [];

  // Phase 81 — supplement accessibility-tree previewText with DOM-eval-derived
  // headline/location lines. Single eval covers all visible cards on the
  // current page (search-people OR networkView). Map keyed by person name;
  // safe no-op when eval returns empty (timeout, unsupported page shape).
  // Consumer-side strict gate (isConnectablePersonInviteEntry → invite-only
  // pattern) already filters non-person matches before this lookup, so
  // company Follow / job CTAs that the broader eval anchor catches simply
  // never get consumed here (R-2c lock).
  const domPreviews = await extractPersonCardDomPreviews(client);
  const domPreviewByName = new Map(domPreviews.map((p) => [p.personName, p.text]));

  for (const [index, anchor] of personAnchors.entries()) {
    const summary = extractConnectablePersonSummary(anchor.name);
    if (!summary) {
      continue;
    }

    const anchorEntryIndex = entries.findIndex((entry) => entry.ref === anchor.ref);
    if (anchorEntryIndex < 0) {
      continue;
    }

    const startIndex = findConnectablePersonStartIndex(entries, anchorEntryIndex, summary.personName);
    const endIndex = findConnectablePersonEndIndex(entries, anchorEntryIndex);
    const segmentEntries = entries.slice(startIndex, endIndex);
    const handle = `personCard:${index + 1}`;
    const baselinePreviewText = previewTextFromEntries(segmentEntries);
    const enrichmentLines = domPreviewByName.get(summary.personName) ?? [];
    // Cap at 12 (baseline 8 + 4 enrichment headroom) per OQ-81.G ruling.
    const previewText = [...baselinePreviewText, ...enrichmentLines].slice(0, 12);
    const visibleSummary: VisibleScopeSummary = {
      handle,
      kind,
      label: summary.personName,
      parent,
      anchorRef: anchor.ref,
      previewText,
      buttons: buttonsFromEntries(segmentEntries),
      inputs: inputsFromEntries(segmentEntries),
      controls: toVisibleScopeControls(handle, segmentEntries),
    };
    inspections.push(createVisibleScopeInspection(visibleSummary, previewText, segmentEntries));
  }

  return inspections;
}
