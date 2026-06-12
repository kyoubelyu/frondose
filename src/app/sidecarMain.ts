#!/usr/bin/env node
// P-APP-6 — Dedicated app sidecar entrypoint. Decouples Frondose.app's backend
// from the public CLI command program. main.rs spawn_mai_serve() points here
// (not at dist/cli/main.js). The CLI `serve` subcommand stays in parallel during
// migration; this entry is the long-term boot path for the app.
//
// Bootstrap surface kept INTENTIONALLY MINIMAL — see docs/phase-app-6-plan.md §2
// for the dependency trace justifying each include/exclude. In particular:
//   - NO CLI command framework, NO 30-subcommand import graph (the win).
//   - NO loadDotenv (the .app has no relevant cwd; provider keys flow via
//     ~/.mai/auth.json / secrets — see §2.1 [2a, CONCERN-1] for trace).
//   - NO maybePrintTransitionalBanner (banner already short-circuits on `serve`).
//   - NO runStartupAutoUpdate (the Tauri updater owns app updates).
// What we DO need:
//   - registerCrashHandlers() FIRST (static import) so any throw — including a
//     subsequent import-time throw inside the serve graph — hits
//     ~/.mai/agent/logs/crash.log [CONCERN-MR-1].
//   - argv/env parse for --sock / --token (parseArgs exported for unit tests
//     [CONCERN-MR-3]).
//   - DYNAMIC import + call runServeSubcommand({sockPath, bearerToken}).

// Static import scope is INTENTIONALLY minimal — only the crash logger.
// The serve graph is dynamic-imported below to keep it OUT of the static
// import order [CONCERN-MR-1].
import { pathToFileURL } from "node:url";
import { registerCrashHandlers } from "../cli/crashLogger.js";

export function parseArgs(argv: string[]): { sockPath: string; bearerToken: string } {
  let sockPath: string | undefined;
  let bearerToken: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sock" && i + 1 < argv.length) {
      sockPath = argv[++i];
      continue;
    }
    if (a === "--token" && i + 1 < argv.length) {
      bearerToken = argv[++i];
      continue;
    }
    if (a !== undefined && a.startsWith("--sock=")) {
      sockPath = a.slice("--sock=".length);
      continue;
    }
    if (a !== undefined && a.startsWith("--token=")) {
      bearerToken = a.slice("--token=".length);
      continue;
    }
  }
  sockPath ??= process.env.MAI_SOCK;
  bearerToken ??= process.env.MAI_TOKEN;
  if (!sockPath || !bearerToken) {
    process.stderr.write(
      "[frondose-sidecar] FATAL: --sock and --token required (or MAI_SOCK + MAI_TOKEN env).\n" +
        `  argv: ${JSON.stringify(argv)}\n`,
    );
    process.exit(2);
  }
  return { sockPath, bearerToken };
}

export async function main(): Promise<void> {
  // Order [2a, CONCERN-MR-1]:
  // 1) parse argv (pure; can't throw at module-load),
  // 2) registerCrashHandlers() — installed BEFORE the serve graph is loaded,
  // 3) DYNAMIC import of the serve graph (any import-time throw now hits
  //    the registered handlers + the unhandled-rejection sink).
  const { sockPath, bearerToken } = parseArgs(process.argv.slice(2));
  registerCrashHandlers();
  const { runServeSubcommand } = await import("../cli/subcommands/serve.js");
  await runServeSubcommand({ sockPath, bearerToken });
  // runServeSubcommand returns when the server exits (SIGTERM/SIGINT).
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
