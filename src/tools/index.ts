import type { Tool, ToolSet } from "ai";
import type { HookRunner } from "../agent/hooks.js";
import { IDEMPOTENT_TOOLS, withRetry } from "../agent/retryWrapper.js";
import { OUTREACH_TOOL_NAMES, withSafeMode } from "../agent/safeMode.js";
import type { LinkedinSession } from "../linkedin/types.js";
import { DEFAULT_CONFIG_PATH, readConfig } from "../persistence/config.js";
import { openCredentialsDb } from "../persistence/credentialLibrary.js";
import { openInvitesDb } from "../persistence/invitesRegistry.js";
import { DEFAULT_SECRETS_PATH, readSecrets } from "../persistence/secrets.js";
import { openServerInboxDb } from "../persistence/serverInbox.js";
import { SERVER_PERSONAS_DIR } from "../persistence/serverPaths.js";
import { openWorkersDb } from "../persistence/workersRegistry.js";
import { echoTool } from "./control/echo.js";
import { makeControlTools } from "./control/index.js";
import type { ControlSignals } from "./control/stop.js";
import { wrapWithHooks } from "./hookWrapper.js";
import { makeIdentityTools } from "./identity/index.js";
import { makeLinkedinTools } from "./linkedin/index.js";
import { makeMemoryTools } from "./memory/index.js";
import { makeMethodologyTools } from "./methodology/index.js";
import { makeOperatorOutputTools } from "./operatorOutput/index.js";
import { makeDispatchGoogleLoginTool } from "./server/dispatchGoogleLogin.js";
import { makeListPersonasTool } from "./server/listPersonas.js";
import { makeListWorkersTool } from "./server/listWorkers.js";
import { makeProvisionWorkerTool } from "./server/provisionWorker.js";
import { makePublishEventTool } from "./server/publishEvent.js";
import { makeQueryLeadGloballyTool, type ServerCoords } from "./server/queryLeadGlobally.js";
import { makeRevokeWorkerTool } from "./server/revokeWorker.js";
import { makeSendWorkerMessageTool } from "./server/sendWorkerMessage.js";
import { makeWebTools } from "./webTools/index.js";

/** P-25: tool-set mode. `worker` (default) is the worker inventory; `server`
 *  is the orchestrator inventory: no LinkedIn primitives, no methodology
 *  (qualify_profile is ICP-specific), plus `list_workers` + `send_worker_message`. */
export type ToolMode = "worker" | "server";

// Re-export ControlSignals for callers (e.g. src/cli/main.ts).
export type { ControlSignals } from "./control/stop.js";

/**
 * P-1 tool inventory: just `echo`. Vercel `ToolSet` consumes this directly.
 * `as const satisfies ToolSet` (per guardian critic CONCERN-1): literal-key
 * inference for tool-name strict typing in callers AND explicit type-validation
 * that each value implements the `Tool` interface.
 */
export const tools = {
  echo: echoTool,
} as const satisfies ToolSet;

export type ToolKey = keyof typeof tools;

export interface PersistencePaths {
  memoryDbPath: string;
  identityPath: string;
  // P-26: optional paths for serverCoords resolution + server-side DB handles.
  configPath?: string;
  secretsPath?: string;
  workersDbPath?: string;
  serverInboxDbPath?: string;
  // P-27: invite store + persona library + server URL (server mode).
  invitesDbPath?: string;
  personasDir?: string;
  serverUrl?: string;
  // P-28.5: server credential store handle for dispatch_google_login.
  credentialsDbPath?: string;
}

/**
 * Build the full tool inventory. P-26 surface:
 *   - worker mode: 26 tools (P-9 24 + query_lead_globally + publish_event)
 *   - server  mode: 15 tools (P-25 14 + send_worker_message; list_workers
 *                              upgraded from P-25 stub to registry-backed)
 *
 * Layer order applied across BOTH modes (outermost → innermost):
 *   hookWrapper → safeModeWrap → retryWrap → original execute
 *
 * Safe-mode wrap (P-26): worker mode only, ONLY when `serverCoords !== null`.
 * Refuses 4 outreach tools (`click`/`type`/`press`/`upload`) when no
 * successful heartbeat in the last 2 min. Standalone workers (no `server.url`
 * configured) skip safe-mode entirely.
 */
export function makeAllTools(
  session?: LinkedinSession,
  persistence?: PersistencePaths,
  control?: ControlSignals,
  hookRunner?: HookRunner,
  opts?: { mode?: ToolMode; workerId?: string },
): ToolSet {
  const mode: ToolMode = opts?.mode ?? "worker";
  const out: ToolSet = { echo: echoTool };

  // P-26: lazy serverCoords resolution from config + secrets. Resolved ONLY
  // in worker mode + only when both url + token + workerId are present. The
  // tools always register; null coords surface a graceful envelope at execute
  // time (so the LLM sees a clear error rather than a missing-tool surprise).
  let serverCoords: ServerCoords | null = null;
  if (mode === "worker" && persistence) {
    try {
      const cfg = readConfig(persistence.configPath ?? DEFAULT_CONFIG_PATH());
      const secrets = readSecrets(persistence.secretsPath ?? DEFAULT_SECRETS_PATH());
      if (cfg.server.url && secrets.server?.token && opts?.workerId) {
        serverCoords = {
          serverUrl: cfg.server.url,
          token: secrets.server.token,
          workerId: opts.workerId,
        };
      }
    } catch {
      // Config/secrets read errors → fall back to standalone (null coords).
    }
  }

  // Memory + identity register from persistence regardless of session/mode.
  if (persistence) {
    // P-26: pass serverCoords through to `remember` so it can fire-and-forget
    // POST /api/lead/touch alongside the local SQLite insert.
    Object.assign(out, makeMemoryTools(persistence.memoryDbPath, serverCoords ?? undefined));
    Object.assign(out, makeIdentityTools(persistence.identityPath));
    // P-5 / P-25: methodology (qualify_profile) is LinkedIn-ICP-specific — worker only.
    if (mode === "worker") {
      Object.assign(out, makeMethodologyTools({ identityPath: persistence.identityPath }));
    }
  }
  // P-25: LinkedIn tools register ONLY in worker mode. Server mode overrides
  // session presence — if caller misconfigures, emit a stderr warning and skip.
  if (mode === "worker" && session) {
    Object.assign(out, makeLinkedinTools(session));
  } else if (mode === "server" && session) {
    process.stderr.write("[mai] makeAllTools: ignoring session in server mode\n");
  }

  // P-6: operator-output + control tools. Registered when `control` is given.
  if (control) {
    const operatorOutputTools = makeOperatorOutputTools();
    Object.assign(out, operatorOutputTools);
    Object.assign(
      out,
      makeControlTools(
        control,
        {
          // biome-ignore lint/style/noNonNullAssertion: makeOperatorOutputTools always populates these.
          telegramTool: operatorOutputTools.telegram_notify!,
          // biome-ignore lint/style/noNonNullAssertion: makeOperatorOutputTools always populates these.
          ghIssueTool: operatorOutputTools.gh_issue!,
        },
        hookRunner,
      ),
    );
  }
  // P-9 F-3 / F-4: web tools always registered; no deps.
  Object.assign(out, makeWebTools());

  // P-26: mode-specific tools.
  if (mode === "server") {
    // server-only: list_workers (real impl, replaces P-25 stub) +
    // send_worker_message. DB handles passed as null when persistence.* paths
    // unset → tools surface a graceful envelope instead of crashing at boot
    // (server boot before `mai server worker add` has created workers.sqlite).
    let workersDb: import("better-sqlite3").Database | null = null;
    let serverInboxDb: import("better-sqlite3").Database | null = null;
    if (persistence?.workersDbPath && persistence?.serverInboxDbPath) {
      workersDb = openWorkersDb(persistence.workersDbPath);
      serverInboxDb = openServerInboxDb(persistence.serverInboxDbPath);
    }
    // P-27: invite store + persona library. invitesDb may stay null (graceful
    // envelope at execute time); personasDir falls back to the default.
    let invitesDb: import("better-sqlite3").Database | null = null;
    if (persistence?.invitesDbPath) {
      try {
        invitesDb = openInvitesDb(persistence.invitesDbPath);
      } catch (e) {
        process.stderr.write(`[mai] cannot open invites.sqlite: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
    const personasDir = persistence?.personasDir ?? SERVER_PERSONAS_DIR();
    const serverUrl =
      persistence?.serverUrl ?? (persistence?.configPath ? (readConfig(persistence.configPath).server.url ?? "") : "");
    // P-28.5: credential store for dispatch_google_login (LLM passes only workerId).
    let credentialsDb: import("better-sqlite3").Database | null = null;
    if (persistence?.credentialsDbPath) {
      try {
        credentialsDb = openCredentialsDb(persistence.credentialsDbPath);
      } catch (e) {
        process.stderr.write(`[mai] cannot open credentials.sqlite: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
    Object.assign(out, {
      list_workers: makeListWorkersTool(workersDb),
      send_worker_message: makeSendWorkerMessageTool(workersDb, serverInboxDb),
      provision_worker: makeProvisionWorkerTool(invitesDb, personasDir, serverUrl),
      revoke_worker: makeRevokeWorkerTool(workersDb),
      list_personas: makeListPersonasTool(personasDir),
      dispatch_google_login: makeDispatchGoogleLoginTool({
        workersDb,
        serverInboxDb,
        credentialsDb,
        personasDir,
      }),
    });
  } else {
    // worker-only: query_lead_globally + publish_event. Both always register;
    // both return a structured envelope when serverCoords===null.
    Object.assign(out, {
      query_lead_globally: makeQueryLeadGloballyTool(serverCoords),
      publish_event: makePublishEventTool(serverCoords),
    });
  }

  // P-9 D-1 / D-11: retry-wrap idempotent tools.
  for (const name of Object.keys(out)) {
    if (IDEMPOTENT_TOOLS.has(name)) {
      out[name] = withRetry(out[name] as Tool);
    }
  }
  // P-26: safe-mode wrap pass. ONLY worker mode, ONLY when serverCoords is set
  // (standalone workers never enter safe-mode). Wraps the 4 outreach tools.
  if (mode === "worker" && serverCoords !== null) {
    for (const name of Object.keys(out)) {
      if (OUTREACH_TOOL_NAMES.has(name)) {
        out[name] = withSafeMode(out[name] as Tool, name);
      }
    }
  }
  // P-9 D-11: hook-wrap every tool when hookRunner present (no-op if hooks.json absent).
  if (hookRunner) {
    for (const name of Object.keys(out)) {
      out[name] = wrapWithHooks(out[name] as Tool, hookRunner, name);
    }
  }
  return out;
}
