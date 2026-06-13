#!/usr/bin/env node
// P-APP-9 — Dedicated app update-server entrypoint. Decouples the
// legacy update-server launchd service from the public CLI command
// program. The operator-authored launchd plist points here (not at
// dist/cli/main.js). The CLI `update-server` subcommand stays in parallel during
// migration; this entry is the long-term boot path for the local update portal.
//
// Bootstrap surface kept INTENTIONALLY MINIMAL — see docs/phase-app-9-plan.md §1.3
// for the dependency trace justifying each include/exclude. In particular:
//   - NO CLI command framework, NO 30-subcommand import graph (the win).
//   - NO env-file loader (the update-server reads no provider keys; the launchd
//     plist sets only PATH + HOME — see §1.3).
//   - NO maybePrintTransitionalBanner (banner already short-circuits on
//     `update-server` — main.ts:62).
//   - NO runStartupAutoUpdate (the update-server is the very service the Tauri
//     updater polls; it never imports the CLI self-updater).
// What we DO need:
//   - bootMigrateOrExit() FIRST (F-REN-4a B-1) — the data-dir migration runs
//     before registerCrashHandlers and any data-dir read.
//   - registerCrashHandlers() (static import), installed BEFORE the
//     update-server graph is dynamic-imported, so a RUNTIME uncaught exception /
//     rejection after boot hits the registered handlers (~/.frondose/agent/logs/crash.log).
//     A boot-time dynamic-import REJECTION is handled by the entrypoint guard's
//     main().catch below -> surfaced on stderr (captured in the launchd log), NOT
//     crash.log — see CONCERN-1 / docs/phase-app-6-review.md:10.
//   - argv parse for OPTIONAL --port / --site-dir (parseArgs exported for unit
//     tests). No env fallback + no FATAL on absence: runUpdateServerSubcommand
//     supplies port 4875 + ~/.frondose/site defaults (§1.4) — exactly what the live
//     zero-flag plist relies on.
//   - DYNAMIC import + call runUpdateServerSubcommand({port, siteDir}).

// Static import scope is INTENTIONALLY minimal — only the crash logger + the URL
// helper for the entrypoint guard. The update-server graph is dynamic-imported
// below to keep it OUT of the static import order.
import { pathToFileURL } from "node:url";
import { registerCrashHandlers } from "../cli/crashLogger.js";
import { bootMigrateOrExit } from "../persistence/dataDirMigration.js";
import { getHomeBase } from "../persistence/paths.js";

export function parseArgs(argv: string[]): { port?: string; siteDir?: string } {
  let port: string | undefined;
  let siteDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" && i + 1 < argv.length) {
      port = argv[++i];
      continue;
    }
    if (a === "--site-dir" && i + 1 < argv.length) {
      siteDir = argv[++i];
      continue;
    }
    if (a !== undefined && a.startsWith("--port=")) {
      port = a.slice("--port=".length);
      continue;
    }
    if (a !== undefined && a.startsWith("--site-dir=")) {
      siteDir = a.slice("--site-dir=".length);
      continue;
    }
    // Unknown args (incl. a leading "update-server" positional) are ignored —
    // the body validates --port and defaults --site-dir.
  }
  return { port, siteDir };
}

export async function main(): Promise<void> {
  // Order:
  // 1) parse argv (pure; can't throw at module-load),
  // 2) registerCrashHandlers() — installed BEFORE the update-server graph loads,
  //    so a RUNTIME uncaught exception / rejection after boot hits the registered
  //    handlers. (A boot-time dynamic-import rejection is caught by the entrypoint
  //    guard's main().catch below and surfaced on stderr — see CONCERN-1.)
  // 3) DYNAMIC import of the update-server graph.
  const { port, siteDir } = parseArgs(process.argv.slice(2));
  bootMigrateOrExit(getHomeBase());
  registerCrashHandlers();
  const { runUpdateServerSubcommand } = await import("../cli/subcommands/updateServer.js");
  await runUpdateServerSubcommand({ port, siteDir });
  // runUpdateServerSubcommand returns when the server exits (SIGINT/SIGTERM).
  process.exit(0);
}

// ESM entrypoint guard — importing this module from a unit test must NOT auto-run
// main(). Only run when invoked as the node entrypoint.
const invokedAsEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsEntrypoint) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `[mai-update-server] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
