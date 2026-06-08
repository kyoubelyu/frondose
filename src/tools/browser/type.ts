import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { CdpClient } from "../../cdp/client.js";
import { hardwareTypeAt } from "../../cdp/hardwareInput.js";
import { applyPacing, fail, failFromError, ok, resolveByLabel } from "../../linkedin/index.js";
import type { LinkedinSession, SnapshotEntry } from "../../linkedin/types.js";
import { getHomeBase } from "../../persistence/paths.js";
import { getSalesDb } from "../sales/_dbHandle.js";

const NOTE_FIELD_RE = /note|message|备注|附言|留言/i;
const ADD_NOTE_RE = /add\s+a?\s*note|^note$|添加备注|添加附言/i;
const SEND_BTN_RE = /^(send( invitation| invite| now)?|send\s+without\s+a?\s*note|发送(邀请)?|直接发送|无备注发送|不留言)\s*$/i;
const CLICKABLE = new Set(["button", "link", "menuitem", "MenuItem"]);
const TEXTBOX = new Set(["textbox", "textarea", "TextBox"]);

/** [P-75 D-11 round 3] Detect "I'm inside a Connect-invite modal" from the captured context.
 *  Trigger if BOTH a note affordance (textarea/Add-a-note) AND a Send button are visible.
 *  Mirrors the matcher vocabulary that linkedin_connect used internally — we keep the
 *  detection here now that linkedin_connect itself is gone (round-3 reversal: the original
 *  Linfeng failure was AX-tree timing in click, fixed at click.ts; the dedicated tool was
 *  overengineering and brittle to 2nd-degree modal variance, per mai-linkedin original pattern). */
function inConnectModal(entries: SnapshotEntry[] | undefined): boolean {
  if (!entries) return false;
  const hasNoteAffordance =
    entries.some((e) => TEXTBOX.has(e.role) && NOTE_FIELD_RE.test(e.name)) ||
    entries.some((e) => ADD_NOTE_RE.test(e.name));
  if (!hasNoteAffordance) return false;
  return entries.some((e) => CLICKABLE.has(e.role) && SEND_BTN_RE.test(e.name));
}

const PROFILE_SLUG_RE = /^\/in\/([^/]+)\/?$/i;
/** Resolve the lead's canonical /in/<slug>/ from either:
 *   • a profile page URL: linkedin.com/in/<slug>/
 *   • the custom-invite preload URL: linkedin.com/preload/custom-invite/?vanityName=<slug>
 *     (agents commonly open the invite modal directly via this URL — see e.g. the
 *     Hung-I Lin flow 2026-06-08). Without this fallback, the text-fidelity guard
 *     false-rejects every preload-URL path. */
function profileSlugFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("linkedin.com")) return null;
    const m = u.pathname.match(PROFILE_SLUG_RE);
    if (m?.[1]) return m[1].toLowerCase();
    if (/\/preload\/custom-invite\/?$/i.test(u.pathname)) {
      const vn = u.searchParams.get("vanityName");
      if (vn) return vn.toLowerCase();
    }
    return null;
  } catch {
    return null;
  }
}

/** [P-75 D-11 round 3] Lookup the most-recent draft text for the lead currently on screen.
 *  - profileUrl → canonical /in/<slug>/ → raw_candidates row → leads row → drafts.text
 *  - Returns null when any lookup misses (no candidate, no lead, no draft). Caller treats
 *    null as "no draft to enforce against" → refuse the type (safer default than allowing
 *    arbitrary text into a Connect modal with no approval trail).
 *  Default sales.sqlite path matches src/tools/index.ts:213. */
function latestDraftTextForCurrentLead(pageUrl: string | undefined): string | null {
  if (!pageUrl) return null;
  const slug = profileSlugFromUrl(pageUrl);
  if (!slug) return null;
  try {
    const dbPath = join(getHomeBase(), ".mai", "agent", "sales.sqlite");
    const db = getSalesDb(dbPath);
    const candidateRow = db
      .prepare("SELECT id FROM raw_candidates WHERE profile_url = ? OR profile_url = ?")
      .get(`https://www.linkedin.com/in/${slug}/`, `https://www.linkedin.com/in/${slug}`) as
      | { id: string }
      | undefined;
    if (!candidateRow) return null;
    const leadRow = db.prepare("SELECT id FROM leads WHERE candidate_id = ?").get(candidateRow.id) as
      | { id: string }
      | undefined;
    if (!leadRow) return null;
    const draftRow = db
      .prepare(
        "SELECT text FROM message_drafts WHERE lead_id = ? AND kind = 'connect_note' ORDER BY created_at DESC LIMIT 1",
      )
      .get(leadRow.id) as { text: string } | undefined;
    return draftRow?.text ?? null;
  } catch {
    return null;
  }
}

/** Resolve after `ms` milliseconds. */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const REACT_SAFE_CLEAR_ACTIVE_INPUT_JS = `(() => {
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
  el.focus();
  const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  const setter = (el instanceof HTMLTextAreaElement) ? nativeTextareaSetter : nativeInputSetter;
  if (setter) setter.call(el, '');
  else el.value = '';
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  return true;
})()`;

/**
 * P-47 G-2 / OQ-1: per-character typing delay in ms. Produces human keystroke
 * timing while bounding total typing time at ~8s for any text length.
 *  - `budget` = min(8000 / textLength, 150): the per-char time slice. For text
 *    longer than ~54 chars this shrinks so `textLength × budget ≤ ~8000`.
 *  - jitter: `rand` in [0,1] maps to a 0.3..1.0 multiplier — variable timing is
 *    the anti-bot keystroke-fingerprint signal. Jitter only VARIES the delay for
 *    short/medium text; once `textLength > ~266` the floor equals the budget so
 *    the per-char delay is budget-pinned (constant) and the ~8s cap dominates.
 *  - floor = min(30, budget): a 30ms floor for short/medium text, but never
 *    above `budget`, so the ~8s cap is preserved for long text (see plan §0.3).
 */
export function computeCharDelay(textLength: number, rand: number): number {
  const budget = Math.min(8000 / Math.max(1, textLength), 150);
  const floor = Math.min(30, budget);
  return Math.max(floor, Math.floor(budget * (0.3 + rand * 0.7)));
}

async function clearActiveInput(client: CdpClient): Promise<void> {
  let reactSafeClearSucceeded = false;
  try {
    reactSafeClearSucceeded = await client.evaluate<boolean>(REACT_SAFE_CLEAR_ACTIVE_INPUT_JS);
  } catch {
    reactSafeClearSucceeded = false;
  }
  if (reactSafeClearSucceeded) return;

  await client.handle.Input.dispatchKeyEvent({ type: "keyDown", key: "a", modifiers: 4 });
  await client.handle.Input.dispatchKeyEvent({ type: "keyUp", key: "a", modifiers: 4 });
  await client.handle.Input.dispatchKeyEvent({
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
  });
  await client.handle.Input.dispatchKeyEvent({
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
  });
}

const typeParams = z.object({
  text: z.string().describe("Text to type into the resolved input. Replaces existing value."),
  ref: z.string().optional().describe("Input ref from inspect, e.g. '@e3'."),
  label: z.string().optional().describe("Accessible name of the input (case-insensitive)."),
  scope: z.string().optional().describe("Scope handle to narrow the search."),
});

export function makeTypeTool(session: LinkedinSession) {
  return tool({
    description:
      "Type text into a page input. Provide either a ref or a label. Existing value is cleared first " +
      "(React-safe clear + insertText replacement).",
    parameters: typeParams,
    execute: async ({ text, ref, label, scope }) => {
      try {
        const r = await session.getOrInitClient();
        if (!r.ok) return r;
        const { client } = r;
        // [P-75 D-11 round 3] Text-fidelity guard for Connect-invite modals.
        // When typing into a detected Connect modal (Add-a-note OR note textarea + Send button
        // both visible), the typed text MUST exactly match the most-recent connect_note draft
        // saved for the lead currently on screen. Catches the Linfeng-rewrite hazard
        // (operator-vetted "Hi Linfeng — your blend of a PhD..." came out as "...PhD from HKUST +
        // ... an impressive combo" because the agent paraphrased on the way to send).
        // Replaces the round-2 modal-block guard (which forced linkedin_connect, now removed).
        const guardCtx = session.getLastContext();
        if (inConnectModal(guardCtx?.entries)) {
          const expected = latestDraftTextForCurrentLead(guardCtx?.pageUrl);
          if (expected === null) {
            return fail(
              "type",
              "invalid_input",
              "Refusing to type into a Connect-invite modal: no saved connect_note draft found for the lead " +
                "at this URL. Call save_message_draft(leadId, kind='connect_note', text=…) FIRST, get operator " +
                "approval via the workflow gate, then re-type the EXACT approved text. " +
                "(D-11 round-3 brand-safety guard — closes the rewrite-on-fallback hazard.)",
            );
          }
          if (text !== expected) {
            const preview = (s: string): string =>
              s.length > 80 ? `${s.slice(0, 38)}…${s.slice(-38)}` : s;
            return fail(
              "type",
              "invalid_input",
              `Refusing to type rewritten text into a Connect-invite modal. The text being typed does NOT ` +
                `match the saved draft for this lead. ` +
                `Expected: "${preview(expected)}" (${expected.length} chars). ` +
                `Got: "${preview(text)}" (${text.length} chars). ` +
                `Send the EXACT saved draft text — paraphrasing/rewriting the operator-vetted note is the ` +
                `Linfeng-class brand-safety hazard this guard exists to block. (D-11 round-3.)`,
            );
          }
        }
        let target = "";
        if (ref) {
          target = ref.startsWith("@") ? ref : `@${ref}`;
        } else {
          const ctx = session.getLastContext();
          if (!ctx) throw new Error("type: call inspect first to populate inputs.");

          // Ambiguity enforcement: when scope provided without label, check for multiple inputs.
          if (scope && !label) {
            const INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "textarea"]);
            const scopeInputs = ctx.entries.filter((e) => INPUT_ROLES.has(e.role) && e.name.length > 0);
            if (scopeInputs.length > 1) {
              const candidates = scopeInputs.map((e) => ({ ref: e.ref, label: e.name }));
              return fail(
                "type",
                "ambiguous_target",
                `scope '${scope}' exposes ${scopeInputs.length} inputs. Provide --label to target one.`,
                candidates,
              );
            }
            if (scopeInputs.length === 1) {
              // biome-ignore lint/style/noNonNullAssertion: length-checked above.
              target = scopeInputs[0]!.ref;
            }
          }

          if (!target) {
            if (label) {
              const entry = resolveByLabel(ctx.entries, label, { kind: "type", scope });
              target = entry.ref;
            } else {
              throw new Error("type: provide either 'ref' or 'label'.");
            }
          }
        }
        // [P-75 D-17] Re-validate the ref before typing. LinkedIn's New Message dialog
        // re-uses the same <input> element across recipient-search vs message-body modes;
        // backendNodeId stays the same but aria-label flips. Without this guard, the agent
        // can type the message body into the recipient-search field (observed in the
        // 2026-06-04 DM dogfood — text appeared under "No results found" instead of being
        // sent). Skip when the target wasn't in lastContext (selector/label fallback that
        // already used the current entries).
        const typeCtx = session.getLastContext();
        const typeEntry = typeCtx?.entries?.find((e) => e.ref === target);
        if (target.startsWith("@") && typeEntry) {
          const verify = await client.verifyRef(target.slice(1), {
            role: typeEntry.role,
            name: typeEntry.name,
          });
          if (!verify.matches) {
            return fail(
              "type",
              "runtime_error",
              `ref_stale: ${target} no longer points at "${typeEntry.name}" (role=${typeEntry.role}). ` +
                `Current state: role=${verify.currentRole ?? "<gone>"} name=${verify.currentName ?? "<gone>"}. ` +
                `The DOM changed between your inspect and this type — likely an input swapped purpose ` +
                `(e.g. recipient-search → message-body). Call inspect again and retry against the fresh ref.`,
            );
          }
        }
        // P-Y2.3: paint the agent cursor + highlight on the resolved target before the focus click. Best-effort,
        // visual-only (a getBox/overlay failure must NEVER block typing); the injected driver Auto-gates (no paint
        // + no dwell in Manual/headless/REPL). The type dispatch is OUTSIDE this try (unaffected on failure).
        try {
          const box = await client.getBox(target);
          await session.showAgentTarget?.(box, label ?? target);
        } catch {
          // visual-only; ignore
        }
        // P-32: hardware-path input branch; CDP arm unchanged.
        if (session.inputMode === "hardware") {
          await hardwareTypeAt(client, target, text);
        } else {
          // Focus the input.
          await client.clickAt(target);
          // [P-59 D-RUN-3] Try React-safe DOM clear first; fall back to Cmd+A+Backspace only when the
          // focused element is not a native input/textarea or the evaluate path fails.
          await clearActiveInput(client);
          // P-47 G-2: per-character dispatch — replaces the atomic insertText.
          // Each printable char is its own insertText call (fires a discrete
          // `input` event React/LinkedIn listens to); `\n` is a real Enter key
          // event. Jittered inter-char delays give a human keystroke-timing
          // fingerprint; computeCharDelay caps the total at ~8s for long text.
          if (text.length > 0) {
            for (const ch of text) {
              if (ch === "\n") {
                await client.handle.Input.dispatchKeyEvent({
                  type: "keyDown",
                  key: "Enter",
                  code: "Enter",
                  windowsVirtualKeyCode: 13,
                });
                await client.handle.Input.dispatchKeyEvent({
                  type: "keyUp",
                  key: "Enter",
                  code: "Enter",
                  windowsVirtualKeyCode: 13,
                });
              } else {
                await client.handle.Input.insertText({ text: ch });
              }
              await sleep(computeCharDelay(text.length, Math.random()));
            }
          }
        }
        const pacing = await applyPacing();
        // type does NOT emit data.hint per cli-primitives.md §type (focus-and-fill is not surface-changing).
        return ok("type", { target, text, pacing });
      } catch (e) {
        return failFromError("type", e);
      }
    },
  });
}
