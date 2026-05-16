/** P-28.5: server-side Google-login dispatch.
 *  The LLM passes ONLY workerId; credentials are resolved internally from
 *  credentials.sqlite so they never enter the server LLM session JSONL. */
import { tool } from "ai";
import type { Database as DB } from "better-sqlite3";
import { z } from "zod";
import {
  type GoogleAccountRow,
  getGoogleAccount,
  incrementGoogleAccountAssignedCount,
} from "../../persistence/credentialLibrary.js";
import { readPersonaTemplate } from "../../persistence/personaLibrary.js";
import { enqueueWorkerPending } from "../../persistence/serverInbox.js";
import { listWorkers } from "../../persistence/workersRegistry.js";

export interface DispatchGoogleLoginDeps {
  workersDb: DB | null;
  serverInboxDb: DB | null;
  credentialsDb: DB | null;
  personasDir: string;
}

export type DispatchGoogleLoginResult = { ok: true; queuedId: number; workerId: string } | { ok: false; error: string };

/** Compose the plain natural-language login instruction (credentials inline).
 *  Directive 4: this is prose, NOT a structured message. */
export function composeGoogleLoginInstruction(cred: GoogleAccountRow): string {
  const lines: string[] = [
    "TASK: Log this worker's Chrome into its Google account, then verify LinkedIn access.",
    "",
    "1. Clear the old Chrome profile first: call clear_cookies with origins " +
      '["https://accounts.google.com","https://www.google.com","https://www.linkedin.com"].',
    '2. navigate_to_url to "https://accounts.google.com/signin/v2/identifier".',
    `3. inspect the page, then type the email ${cred.email} into the email field and press Enter.`,
    "4. inspect again; type the password into the password field and press Enter.",
    `   The password is: ${cred.password}`,
  ];
  // C-1: the TOTP step is CONDITIONAL on twofa_link being present — never emit a
  // navigate_to_url instruction pointing at a non-URL placeholder string.
  if (cred.twofa_link) {
    lines.push(
      "5. If Google shows a 2-step verification (TOTP authenticator) prompt:",
      `   navigate_to_url to ${cred.twofa_link} ,`,
      "   inspect that page, read the 6-digit code it renders, then navigate_to_url back to",
      "   the Google verification page and type the 6-digit code and press Enter.",
    );
  } else {
    lines.push(
      "5. If Google shows a 2-step verification (TOTP) prompt: you have no TOTP link",
      "   configured. STOP and report this failure — do not attempt to guess the code.",
    );
  }
  if (cred.recovery_email) {
    lines.push(`   If Google asks for a recovery email, it is ${cred.recovery_email}.`);
  }
  if (cred.phone) {
    lines.push(`   If Google asks for a phone number, it is ${cred.phone}.`);
  }
  if (cred.sms_link) {
    lines.push(
      `   If Google sends an SMS code, the SMS-receive page is ${cred.sms_link} — ` +
        "open it with web_fetch or navigate_to_url to read the code.",
    );
  }
  lines.push(
    '6. Verify: navigate_to_url to "https://www.linkedin.com/feed/" and inspect — a real',
    "   feed (not a login page) means success.",
    "7. Report the outcome (success or the exact failure point) via telegram_notify.",
    "",
    "If Google shows a CAPTCHA, a device-trust prompt, or blocks the session, STOP and",
    "report the failure — do not retry in a loop.",
  );
  return lines.join("\n");
}

/** Core resolution + enqueue. Shared by the Vercel tool AND the CLI shortcut (D-8). */
export function dispatchGoogleLogin(deps: DispatchGoogleLoginDeps, workerId: string): DispatchGoogleLoginResult {
  if (!deps.workersDb || !deps.serverInboxDb || !deps.credentialsDb) {
    return { ok: false, error: "Server registry/credential store unavailable" };
  }
  const worker = listWorkers(deps.workersDb).find((w) => w.worker_id === workerId && w.status === "active");
  if (!worker) return { ok: false, error: `unknown or revoked worker ${workerId}` };
  if (!worker.persona) {
    return { ok: false, error: `worker ${workerId} has no bound persona` };
  }
  const persona = readPersonaTemplate(deps.personasDir, worker.persona);
  if (!persona) return { ok: false, error: `persona ${worker.persona} not found` };
  if (!persona.googleAccountRef) {
    return { ok: false, error: `persona ${worker.persona} has no googleAccountRef` };
  }
  const cred = getGoogleAccount(deps.credentialsDb, persona.googleAccountRef);
  if (!cred) {
    return { ok: false, error: `google account ${persona.googleAccountRef} not found in credentials.sqlite` };
  }
  const instruction = composeGoogleLoginInstruction(cred);
  const queuedId = enqueueWorkerPending(deps.serverInboxDb, workerId, instruction);
  // C-2: bump assigned_count (P-28 review §4 deferred this increment to P-28.5).
  // Informational only (OQ-4 — no allocation logic reads it).
  incrementGoogleAccountAssignedCount(deps.credentialsDb, persona.googleAccountRef);
  return { ok: true, queuedId, workerId };
}

export function makeDispatchGoogleLoginTool(deps: DispatchGoogleLoginDeps) {
  return tool({
    description:
      "Dispatch a Google SSO login task to a worker. Resolves the worker's bound Google " +
      "account internally — you pass ONLY the workerId, never credentials. The worker " +
      "drains the task from its inbox (≈60s latency) and self-drives the login.",
    parameters: z.object({ workerId: z.string().min(1) }),
    execute: async ({ workerId }): Promise<unknown> => dispatchGoogleLogin(deps, workerId),
  });
}
