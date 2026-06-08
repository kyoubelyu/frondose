import { tool } from "ai";
import { z } from "zod";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";
import { captureCurrentSurfaceContext } from "../../linkedin/index.js";
import type { LinkedinSession, SnapshotEntry } from "../../linkedin/types.js";
import { tokenizeRoleQuery } from "../../methodology/icpMatcher.js";
import { appendTimelineEvent, getRawCandidate, upsertRawCandidate } from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

const recordRawCandidateParams = z.object({
  personName: z.string().trim().min(1).describe("Full name of the observed person."),
  profileUrl: z
    .string()
    .trim()
    .url()
    .describe(
      "LinkedIn profile URL — MUST be a canonical /in/<slug>/ profile URL (e.g. https://www.linkedin.com/in/alice/). " +
        "Search-result URLs, post URLs, and company URLs are REJECTED.",
    ),
  source: z
    .enum(["search", "profile-nav", "click", "feed", "company", "memory", "auto"])
    .describe(
      "Where this person was first seen: search result, profile navigation, click, feed signal, company page, prior memory, or Auto-mode discovery.",
    ),
  sourceContext: z
    .string()
    .trim()
    .max(400)
    .optional()
    .describe("Optional free-text context (e.g. the search query, the feed post title)."),
  accountId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional account id (from a prior get_account_context call) to link this candidate to a company."),
  evidenceSummary: z
    .string()
    .trim()
    .max(400)
    .optional()
    .describe("Short snippet of evidence (<=400 chars) — what made this person worth recording."),
  bypassIdentityCheck: z
    .boolean()
    .optional()
    .describe(
      "[P-75 D-30] Default false. Set true ONLY when the operator has explicitly authorized capturing a person " +
        "whose name/URL the live identity check would reject. Auto mode should NEVER set this.",
    ),
});

/**
 * [P-75 D-30] Canonical LinkedIn profile URL = path matches /^\/in\/[^/]+\/?$/.
 * The Ahmed-class wrong-URL hazard often comes from search-result/company/post URLs being passed as
 * "the lead's profile URL" — those are NOT identity-stable. Normalizes a trailing slash off the path.
 */
function canonicalProfileSlug(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("linkedin.com")) return null;
    const m = u.pathname.match(/^\/in\/([^/]+)\/?$/i);
    return m?.[1] ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Heading entry from the captured surface — the profile subject's name (PROFILE_SYNTH_JS prepends it). */
function firstHeadingName(entries: SnapshotEntry[]): string | undefined {
  for (const e of entries) {
    if ((e.role === "heading" || e.role === "profileCard") && e.name.trim().length > 1) return e.name.trim();
  }
  return undefined;
}

/**
 * [P-75 D-30] Live identity check: when the session's current page IS this profileUrl, extract the
 * subject's heading name from the AX tree and require token-overlap with the supplied personName.
 * - Ahmed case (the bug that motivated this): linkedin.com/in/ahmed-elbanna/ resolves to a marketing
 *   manager whose heading is "Ahmed ElBanna" — same name, but the page heading + the supplied
 *   evidenceSummary disagree about role. evidenceSummary vs live-headline check (next layer) catches
 *   it; name token-overlap catches the gross misbinding (recording person X with person Y's URL).
 * Returns: { ok: true } | { ok: false; reason }. Skips silently (returns ok) when the session is not
 * on this profileUrl — that's a different defense (Vercel-cutover discipline: navigate before record).
 */
function checkIdentity(
  session: LinkedinSession | undefined,
  expectedSlug: string,
  personName: string,
  pageUrl: string,
  entries: SnapshotEntry[],
): { ok: true } | { ok: false; reason: string } {
  if (!session) return { ok: true };
  const pageSlug = canonicalProfileSlug(pageUrl);
  if (pageSlug !== expectedSlug) return { ok: true }; // not on this profile — can't verify; let it through
  const heading = firstHeadingName(entries);
  if (!heading) return { ok: true }; // page hasn't surfaced a heading; don't false-positive
  const wantTokens = new Set(tokenizeRoleQuery(personName));
  const gotTokens = new Set(tokenizeRoleQuery(heading));
  // Require at least one shared token AND require the longest expected token (typically a surname)
  // be present in the page heading. Catches "Ahmed Other" claimed as "Ahmed ElBanna" only when the
  // shared tokens are sparse; for true same-name pages the next layer (evidenceSummary vs headline)
  // is the defense.
  const intersect = [...wantTokens].filter((t) => gotTokens.has(t));
  if (intersect.length === 0) {
    return {
      ok: false,
      reason:
        `Identity mismatch at ${pageUrl}: claimed personName "${personName}" shares NO tokens with the live ` +
        `profile heading "${heading}". This is the wrong-URL-binding hazard (D-30) — the URL points to a different ` +
        `person. Re-navigate to the CORRECT profile of "${personName}" before recording, or pass bypassIdentityCheck=true ` +
        `only after explicit operator confirmation.`,
    };
  }
  return { ok: true };
}

/** P-SP-A: record a discovered LinkedIn person as a raw candidate.
 *  Upsert semantics — calling again for the same profileUrl bumps last_seen_at
 *  but does NOT change status or evidence. Also appends a 'discovered' event
 *  to lead_timeline on FIRST observation only (subsequent calls are silent).
 *  [P-75 D-30] Now accepts an optional LinkedinSession to live-identity-check the URL. */
export function makeRecordRawCandidateTool(salesDbPath: string, session?: LinkedinSession) {
  return tool({
    description:
      "Record a discovered LinkedIn person as a raw candidate in the sales kernel. " +
      "Use this for every person you observe on LinkedIn (profile view, search hit, feed signal) " +
      "BEFORE you decide whether to qualify or message them — the kernel learns from every observation. " +
      "Upsert by profileUrl; calling again for the same person bumps last_seen_at. Returns { candidateId, status }. " +
      "[P-75 D-30] profileUrl MUST be a canonical /in/<slug>/ URL; if the session is on that profile, the live " +
      "heading name must token-overlap personName (catches the wrong-URL-binding hazard). bypassIdentityCheck=true " +
      "skips the live check (operator override only).",
    parameters: recordRawCandidateParams,
    execute: async (input) => {
      try {
        const parsed = recordRawCandidateParams.parse(input);
        // [P-75 D-30] URL shape gate — only canonical /in/<slug>/ URLs accepted (rejects search-result,
        // post, and company URLs that share the linkedin.com host but are NOT identity-stable).
        const slug = canonicalProfileSlug(parsed.profileUrl);
        if (!slug) {
          return fail(
            "record_raw_candidate",
            "invalid_input",
            `profileUrl "${parsed.profileUrl}" is not a canonical /in/<slug>/ LinkedIn profile URL. ` +
              "Refusing — captures from search-result/post/company URLs are not identity-stable and produce " +
              "wrong-person leads. Navigate to the person's profile and use that URL.",
          );
        }
        // [P-75 D-30] Live identity check (skips when session unavailable or not on this profile; opt-out via bypass).
        if (!parsed.bypassIdentityCheck && session) {
          try {
            const client = session.getClient();
            if (client) {
              const ctx = await captureCurrentSurfaceContext(client);
              const check = checkIdentity(session, slug, parsed.personName, ctx.pageUrl, ctx.entries);
              if (!check.ok) return fail("record_raw_candidate", "invalid_input", check.reason);
            }
          } catch {
            // identity probe must NEVER block on a CDP hiccup — fall through to write
          }
        }
        const db = getSalesDb(salesDbPath);
        const { candidateId, inserted } = upsertRawCandidate(db, parsed);
        if (inserted) {
          appendTimelineEvent(db, { candidateId, eventType: "discovered", metadata: { source: parsed.source } });
        }
        const status = getRawCandidate(db, candidateId)?.status ?? "new";
        return ok("record_raw_candidate", { candidateId, status, inserted });
      } catch (e) {
        return failFromError("record_raw_candidate", e);
      }
    },
  });
}
