import type { ServerResponse } from "node:http";
import { readIdentity } from "../../../../persistence/identity.js";
import { sendJson } from "../http.js";

export function handleHealth(res: ServerResponse): void {
  sendJson(res, 200, { ok: true, ts: Date.now(), pid: process.pid });
}

export function handleIdentity(res: ServerResponse): void {
  const id = readIdentity();
  if (id === null) {
    sendJson(res, 200, { ok: false, reason: "identity not set; open Frondose → Settings to complete setup" });
    return;
  }
  sendJson(res, 200, { ok: true, ...id });
}

export const handleGetHealth = handleHealth;
export const handleGetIdentity = handleIdentity;
