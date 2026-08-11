#!/usr/bin/env node
// P-APP-6 — Dedicated app sidecar entrypoint. Decouples Frondose.app's backend
// from the retired public CLI command program. main.rs spawn_frondose_serve()
// points here (never at the retired CLI entry — T-RETIRE.CLI.1).
// P-OPEN-SOURCE-SPLIT: the backend graph lives under src/app/backend/** and is
// booted through ./backend.js#runAppBackend.
//
// Bootstrap surface kept INTENTIONALLY MINIMAL — see docs/phase-app-6-plan.md §2
// for the dependency trace justifying each include/exclude. In particular:
//   - NO CLI command framework, NO 30-subcommand import graph (the win).
//   - NO loadDotenv (the .app has no relevant cwd; provider keys flow via the
//     current secrets store — see §2.1 [2a, CONCERN-1] for trace).
//   - NO maybePrintTransitionalBanner (banner already short-circuits on `serve`).
//   - NO runStartupAutoUpdate (the Tauri updater owns app updates).
// What we DO need:
//   - registerCrashHandlers() (static import) so any throw — including a
//     subsequent import-time throw inside the backend graph — hits
//     ~/.frondose/agent/logs/crash.log [CONCERN-MR-1].
//   - argv/env parse for --port-file / --token (parseArgs exported for unit tests
//     [CONCERN-MR-3]).
//   - DYNAMIC import + call runAppBackend({portFile, bearerToken}).

// Static import scope is INTENTIONALLY minimal — only the crash logger.
// The serve graph is dynamic-imported below to keep it OUT of the static
// import order [CONCERN-MR-1].
import { pathToFileURL } from "node:url";
import { frondoseEnv } from "../env.js";
import { type RuntimeTurnInput, runRuntimeTurn } from "./backend/scheduler.js";
import { createTelegramChannel, type TelegramChannel } from "./backend/telegramChannel.js";
import { registerCrashHandlers } from "./crashLogger.js";

const APP_ROUTE_NAMES = [
  "abort",
  "audit",
  "chrome/ensure",
  "cron",
  "events",
  "health",
  "identity",
  "passive",
  "retry",
  "settings",
  "turn",
  "workflow/approve",
  "workflow/cancel",
  "workflow/decline",
] as const;

type SidecarRuntimeDeps = {
  telegramConfigured: boolean;
  pollTelegram(signal: AbortSignal, offset: number): Promise<Array<{ updateId: number; text: string }>>;
  sendTelegramReply(text: string, signal: AbortSignal): Promise<void>;
  readTelegramOffset(): number;
  commitTelegramOffset(offset: number): void;
  writeAudit(event: { type: string }): void;
  releaseResources(): void;
};

export function createSidecarRuntime(deps: SidecarRuntimeDeps) {
  let activeTurn = false;
  const submitTurn = async (input: RuntimeTurnInput): Promise<{ finalText: string }> => {
    if (activeTurn) throw new Error("turn_busy");
    activeTurn = true;
    try {
      return await runRuntimeTurn(input);
    } finally {
      activeTurn = false;
    }
  };
  let telegram: TelegramChannel | undefined;
  if (deps.telegramConfigured) {
    telegram = createTelegramChannel({
      configured: true,
      readOffset: deps.readTelegramOffset,
      commitOffset: deps.commitTelegramOffset,
      pollUpdates: deps.pollTelegram,
      downloadMedia: async (media) => media.fileId,
      submitTurn,
      sendReply: deps.sendTelegramReply,
      writeAudit: (event) => deps.writeAudit(event),
      waitForNextPoll: (signal) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        }),
    });
  }
  return {
    start: async () => {
      await telegram?.start();
    },
    submitTurn,
    pollTelegramOnce: async () => {
      await telegram?.pollOnce();
    },
    stop: async () => {
      await telegram?.stop();
      deps.releaseResources();
    },
    routeNames: () => [...APP_ROUTE_NAMES],
  };
}

export function parseArgs(argv: string[]): { portFile: string; bearerToken: string } {
  let portFile: string | undefined;
  let bearerToken: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port-file" && i + 1 < argv.length) {
      portFile = argv[++i];
      continue;
    }
    if (a === "--token" && i + 1 < argv.length) {
      bearerToken = argv[++i];
      continue;
    }
    if (a !== undefined && a.startsWith("--port-file=")) {
      portFile = a.slice("--port-file=".length);
      continue;
    }
    if (a !== undefined && a.startsWith("--token=")) {
      bearerToken = a.slice("--token=".length);
    }
  }
  portFile ??= frondoseEnv("PORT_FILE");
  bearerToken ??= frondoseEnv("TOKEN");
  if (!portFile || !bearerToken) {
    process.stderr.write(
      "[frondose-sidecar] FATAL: --port-file and --token required (or FRONDOSE_PORT_FILE + FRONDOSE_TOKEN env).\n" +
        `  argv: ${JSON.stringify(argv)}\n`,
    );
    process.exit(2);
  }
  return { portFile, bearerToken };
}

export async function main(): Promise<void> {
  // Order [2a, CONCERN-MR-1]:
  // 1) parse argv (pure; can't throw at module-load),
  // 2) registerCrashHandlers() — installed BEFORE the serve graph is loaded,
  // 3) DYNAMIC import of the serve graph (any import-time throw now hits
  //    the registered handlers + the unhandled-rejection sink).
  const { portFile, bearerToken } = parseArgs(process.argv.slice(2));
  registerCrashHandlers();
  const { runAppBackend } = await import("./backend.js");
  await runAppBackend({ portFile, bearerToken });
  // runAppBackend returns when the server exits (SIGTERM/SIGINT).
  process.exit(0);
}

// ESM entrypoint guard [2a, CONCERN-MR-3] — importing this module from a unit
// test must NOT auto-run main(). Only run when invoked as the node entrypoint.
const invokedAsEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsEntrypoint) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `[frondose-sidecar] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
