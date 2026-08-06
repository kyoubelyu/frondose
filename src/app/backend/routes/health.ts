import type { ServerResponse } from "node:http";
import { readIdentity } from "../../../persistence/identity.js";
import { sendJson } from "../http.js";

export function handleHealth(res: ServerResponse): void {
  sendJson(res, 200, { ok: true, ts: Date.now(), pid: process.pid });
}

export function handleIdentity(res: ServerResponse): void {
  const id = readIdentity();
  if (id === null) {
    // P-ONBOARD-CONVERSATIONAL-IDENTITY: conversational-first wording (Step-3 Codex critic
    // CONCERN-MR) — the old "open Frondose → Settings" text contradicted the FE fix that
    // shows the composer on first contact; Settings stays a fallback, not the primary path.
    sendJson(res, 200, { ok: false, reason: "identity not set yet — say hello to get started (or set it in Frondose → Settings)" });
    return;
  }
  sendJson(res, 200, { ok: true, ...id });
}

export const handleGetHealth = handleHealth;
export const handleGetIdentity = handleIdentity;
