import { tool } from "ai";
import { z } from "zod";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";
import { captureCurrentSurfaceContext } from "../../linkedin/index.js";
import type { LinkedinSession, SnapshotEntry } from "../../linkedin/types.js";
import { tokenizeRoleQuery } from "../../methodology/icpMatcher.js";

/**
 * [P-75 D-11] Deterministic LinkedIn Connect primitive — atomic + idempotent + identity-guarded.
 *
 * WHY: across 5 live attempts (Ahmed, Marcus, DM-v3, Linfeng ×2), the agent reliably reaches the
 * invite dialog but does NOT reliably complete the final atomic `type → click Send`. The Pi loop +
 * D-22 retry + prompt-tightening did not close the gap (it's a tool_targeting + LLM-planning
 * problem BELOW the loop). This primitive does the entire Connect choreography in CODE:
 *
 *   1. (idempotency + identity guard) capture the current page. If Pending/Withdraw already
 *      visible -> return {sent:false, alreadyPending:true}. If expectedName is supplied and the
 *      heading does not token-overlap it -> REFUSE (the deterministic D-30 sibling at outbound time).
 *   2. Find the Connect affordance: direct button/link, ELSE open the subject's "More" overlay and
 *      find Connect inside it.
 *   3. Click Connect -> invite dialog opens.
 *   4. WITH note (noteText supplied): click "Add a note" if present -> type the EXACT note into
 *      the textarea -> click "Send invite"/"Send".
 *      WITHOUT note (noteText omitted): click "Send" / "Send without a note" directly.
 *   5. VERIFY post-state: Pending/Withdraw visible AND/OR Connect gone. Return {sent, verified,
 *      state, withNote}. Caller MUST only call mark_message_sent when verified:true.
 *
 * GATING: this is a REAL outbound. Caller must have an operator-approved workflow step active —
 * the existing outboundGuard governs that, the primitive does not bypass it; it REPLACES the
 * fragile per-step LLM click sequence that runs AFTER approval.
 * P-57d: pure in-process CDP via the existing browser tools — no new external API.
 */

// --- pure matchers (exported so they're unit-testable; mirror outboundGuard label vocabulary) ---

/** Strip the inspect-side "[OUTBOUND] " category prefix added by buildInspectSummary. */
export function stripOutboundTag(name: string): string {
  return name.replace(/^\[OUTBOUND\]\s*/i, "").trim();
}

/** Connect / Invite-to-connect / sidebar "Invite <Name> to connect" / CJK equivalents.
 *  Excludes "X connections" (the connection-count) and "Stay connected". Callers should hand this
 *  function entries SCOPED to the subject (the snapshotCapture profile-actions synth handles that). */
export function isConnectName(name: string): boolean {
  const n = stripOutboundTag(name);
  if (/connections?\b/i.test(n)) return false; // "500+ connections" / "Connection requests"
  if (/stay\s+connected/i.test(n)) return false;
  // ASCII anchored patterns
  if (/^(connect|invite\s+to\s+connect)\b/i.test(n)) return true;
  // Sidebar / overlay variant: "Invite <name> to connect"
  if (/^invite\s+.+\s+to\s+connect\b/i.test(n)) return true;
  // CJK — no \b boundary in Unicode for ideographs; use substring/anchor tests instead
  if (/(?:^|[^a-z])(邀请|添加好友|建立联系|立即连接)/.test(n)) return true;
  if (/^连接$/.test(n)) return true;
  return false;
}

/** The "More" / "More actions" overflow opener (Connect lives behind this on 3rd-degree profiles). */
export function isMoreName(name: string): boolean {
  const n = stripOutboundTag(name);
  return /^(more\b|more\s+actions|更多)/i.test(n);
}

/** "Add a note" button in the invitation modal — accepts a bare "Note" label (which LinkedIn uses
 *  for the add-note affordance on some surfaces) but not e.g. "Notes & comments". */
export function isAddNoteName(name: string): boolean {
  const n = stripOutboundTag(name);
  return /add\s+a?\s*note/i.test(n) || /^note$/i.test(n) || /添加备注|添加附言/.test(n);
}

/** Send the invitation (with-or-without note path's final click). */
export function isSendName(name: string): boolean {
  const n = stripOutboundTag(name);
  return /^(send( invitation| invite| now)?|发送(邀请)?|直接发送)\s*$/i.test(n);
}

/** "Send without a note" — the no-note shortcut. */
export function isSendWithoutNoteName(name: string): boolean {
  return /send\s+without\s+a?\s*note|无备注发送|不留言/i.test(stripOutboundTag(name));
}

/** The note textarea in the invitation modal (role textbox/textarea). */
export function isNoteFieldName(name: string): boolean {
  return /note|message|备注|附言|留言/i.test(stripOutboundTag(name));
}

/** Post-state success / already-invited indicators. */
export function isPendingName(name: string): boolean {
  return /pending|invitation\s+sent|withdraw|已发送|待接受|撤回/i.test(stripOutboundTag(name));
}

const CLICKABLE = new Set(["button", "link", "menuitem", "MenuItem"]);
const TEXTBOX = new Set(["textbox", "TextBox", "textarea"]);

/** First clickable entry whose accessible name matches the predicate. */
export function findClickable(entries: SnapshotEntry[], pred: (name: string) => boolean): SnapshotEntry | undefined {
  return entries.find((e) => CLICKABLE.has(e.role) && pred(e.name));
}
export function findTextbox(entries: SnapshotEntry[], pred: (name: string) => boolean): SnapshotEntry | undefined {
  return entries.find((e) => TEXTBOX.has(e.role) && pred(e.name)) ?? entries.find((e) => TEXTBOX.has(e.role));
}
export function hasPending(entries: SnapshotEntry[]): boolean {
  return entries.some((e) => isPendingName(e.name));
}
/** Best-effort profile name from the captured surface (h1/h2/h3 → "heading" role + the profileCard synth). */
export function profileNameFromContext(entries: SnapshotEntry[]): string | undefined {
  for (const e of entries) {
    if ((e.role === "heading" || e.role === "profileCard") && e.name.trim().length > 1) return e.name.trim();
  }
  return undefined;
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const params = z.object({
  noteText: z
    .string()
    .trim()
    .max(300)
    .optional()
    .describe(
      "The connection-request note (LinkedIn caps custom notes at 300 chars). OMIT for a note-less " +
        "invite (the tool will click 'Send without a note' / 'Send' directly). When provided, send the " +
        "EXACT operator-approved draft text.",
    ),
  expectedName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "STRONGLY RECOMMENDED. The lead's name. REFUSES to send if the currently-loaded profile heading " +
        "does not token-overlap this name — the deterministic outbound-time defense against wrong-person " +
        "sends (D-30 sibling). Pass the lead's person_name.",
    ),
  leadId: z.string().trim().min(1).optional().describe("Optional lead id, for audit linkage in the return envelope."),
});

export function makeConnectTool(session: LinkedinSession) {
  return tool({
    description:
      "Perform a REAL, deterministic LinkedIn Connect on the CURRENTLY-LOADED profile, with or without " +
      "a note. Locates Connect (opening 'More' overflow if hidden), clicks it, types the note (when " +
      "supplied), clicks Send, and VERIFIES the invitation actually landed (Pending state). " +
      "Returns {sent, verified, state, withNote, alreadyPending?}. ONLY call for an operator-APPROVED " +
      "outbound step. Does NOT navigate — the correct profile must already be open. After it returns " +
      "sent:true AND verified:true, call mark_message_sent(draftId) + update_lead_stage(leadId, " +
      "'connect_sent'). Refuses to send if expectedName doesn't match the loaded profile, or if an " +
      "invite is already Pending. Tool name: linkedin_connect.",
    parameters: params,
    execute: async (input) => {
      try {
        const { noteText, expectedName, leadId } = params.parse(input);
        const withNote = Boolean(noteText && noteText.length > 0);
        const r = await session.getOrInitClient();
        if (!r.ok) return r;
        const client = r.client;

        // Step 0 — capture + idempotency + identity defense.
        let ctx = await captureCurrentSurfaceContext(client);
        session.setLastContext(ctx);
        if (hasPending(ctx.entries)) {
          return ok("linkedin_connect", {
            sent: false,
            verified: false,
            alreadyPending: true,
            state: "pending",
            withNote,
            leadId,
          });
        }
        if (expectedName) {
          const heading = profileNameFromContext(ctx.entries);
          if (heading) {
            const want = new Set(tokenizeRoleQuery(expectedName));
            const got = new Set(tokenizeRoleQuery(heading));
            const overlap = [...want].some((t) => got.has(t));
            if (!overlap) {
              return fail(
                "linkedin_connect",
                "invalid_input",
                `Identity mismatch (D-30 outbound guard): loaded profile heading "${heading}" does not overlap ` +
                  `expectedName "${expectedName}". Refusing to send — re-navigate to the correct profile.`,
              );
            }
          }
        }

        // Step 1 — locate Connect (direct, else via "More").
        let connect = findClickable(ctx.entries, isConnectName);
        if (!connect) {
          const more = findClickable(ctx.entries, isMoreName);
          if (!more) {
            return fail(
              "linkedin_connect",
              "not_found",
              "No Connect affordance and no 'More' menu on this profile — likely already a 1st-degree " +
                "connection (Message shown, no Connect), or Connect is unavailable.",
            );
          }
          await client.clickAt(more.ref);
          await settle(700);
          ctx = await captureCurrentSurfaceContext(client);
          session.setLastContext(ctx);
          connect = findClickable(ctx.entries, isConnectName);
          if (!connect) {
            return fail(
              "linkedin_connect",
              "not_found",
              "Opened 'More' but no Connect item — already connected or Connect unavailable.",
            );
          }
        }

        // Step 2 — click Connect; the invitation modal should open.
        await client.clickAt(connect.ref);
        await settle(900);
        ctx = await captureCurrentSurfaceContext(client);
        session.setLastContext(ctx);

        // Step 3 — branch by note vs no-note.
        if (withNote) {
          // 3a-with-note: click "Add a note" if present, then type, then click Send.
          const addNote = findClickable(ctx.entries, isAddNoteName);
          if (addNote) {
            await client.clickAt(addNote.ref);
            await settle(600);
            ctx = await captureCurrentSurfaceContext(client);
            session.setLastContext(ctx);
          }
          const field = findTextbox(ctx.entries, isNoteFieldName);
          if (!field) {
            return fail(
              "linkedin_connect",
              "not_found",
              "Invitation modal opened but no note textarea was found — cannot attach the note. NOT sending " +
                "(a note-less send would not match the approved action). Re-inspect and retry.",
            );
          }
          await client.typeAt(field.ref, noteText as string);
          await settle(400);
          ctx = await captureCurrentSurfaceContext(client);
          session.setLastContext(ctx);
          const sendBtn = findClickable(ctx.entries, isSendName);
          if (!sendBtn) {
            return fail(
              "linkedin_connect",
              "not_found",
              "Note typed but no Send button found in the invitation modal. NOT sending. Re-inspect the modal.",
            );
          }
          await client.clickAt(sendBtn.ref);
        } else {
          // 3b-without-note: prefer "Send without a note", else fall back to a plain "Send".
          const swn = findClickable(ctx.entries, isSendWithoutNoteName);
          const sendBtn = swn ?? findClickable(ctx.entries, isSendName);
          if (!sendBtn) {
            return fail(
              "linkedin_connect",
              "not_found",
              "Invitation modal is open but no 'Send without a note' or 'Send' button was found. NOT sending.",
            );
          }
          await client.clickAt(sendBtn.ref);
        }
        await settle(1400);

        // Step 4 — VERIFY post-state.
        ctx = await captureCurrentSurfaceContext(client);
        session.setLastContext(ctx);
        const nowPending = hasPending(ctx.entries);
        const connectGone = !findClickable(ctx.entries, isConnectName);
        const verified = nowPending || connectGone;
        return ok("linkedin_connect", {
          sent: true,
          verified,
          state: nowPending ? "pending" : connectGone ? "connect_gone" : "unconfirmed",
          withNote,
          leadId,
          note: verified
            ? undefined
            : "Send was clicked but post-state could not be confirmed (no Pending/Withdraw and Connect still present). " +
              "Treat as UNVERIFIED — do NOT mark_message_sent until you confirm via a fresh inspect.",
        });
      } catch (e) {
        return failFromError("linkedin_connect", e);
      }
    },
  });
}
