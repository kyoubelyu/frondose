import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import { appendTimelineEvent, getRawCandidate, upsertRawCandidate } from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

const recordRawCandidateParams = z.object({
  personName: z.string().trim().min(1).describe("Full name of the observed person."),
  profileUrl: z.string().trim().url().describe("LinkedIn profile URL (e.g. https://www.linkedin.com/in/alice/)."),
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
});

/** P-SP-A: record a discovered LinkedIn person as a raw candidate.
 *  Upsert semantics — calling again for the same profileUrl bumps last_seen_at
 *  but does NOT change status or evidence. Also appends a 'discovered' event
 *  to lead_timeline on FIRST observation only (subsequent calls are silent). */
export function makeRecordRawCandidateTool(salesDbPath: string) {
  return tool({
    description:
      "Record a discovered LinkedIn person as a raw candidate in the sales kernel. " +
      "Use this for every person you observe on LinkedIn (profile view, search hit, feed signal) " +
      "BEFORE you decide whether to qualify or message them — the kernel learns from every observation. " +
      "Upsert by profileUrl; calling again for the same person bumps last_seen_at. Returns { candidateId, status }.",
    parameters: recordRawCandidateParams,
    execute: async (input) => {
      try {
        const parsed = recordRawCandidateParams.parse(input);
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
