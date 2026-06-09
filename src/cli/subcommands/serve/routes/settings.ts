import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServeDeps } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";
import { applySettings, parseSettingsPatch, readSettings, reloadAgentDeps } from "../settings.js";

export function handleGetSettings(res: ServerResponse): void {
  sendJson(res, 200, { ok: true, ...readSettings() });
}

export async function handlePostSettings(deps: ServeDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const parsed = parseSettingsPatch(body);
  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, error: parsed.error });
    return; // config/secrets UNCHANGED — fail-fast at write, not corrupt-then-break-on-read
  }
  applySettings(parsed.patch);
  const { restartRequired } = reloadAgentDeps(deps);
  sendJson(res, 200, { ok: true, restartRequired, ...readSettings() });
}
