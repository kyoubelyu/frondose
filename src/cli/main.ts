#!/usr/bin/env node
import { existsSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { ExitPromptError } from "@inquirer/core";
import type { CoreMessage } from "ai";
import { Command } from "commander";
import { HookRunner } from "../agent/hooks.js";
import { resolveModel } from "../agent/modelResolver.js";
import { BOUNDARY } from "../agent/systemPrompt/boundary.js";
import { CHECKPOINT } from "../agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../agent/systemPrompt/compose.js";
import { resolveSoulBand } from "../agent/systemPrompt/soul.js";
import { TurnLock } from "../agent/turnSemaphore.js";
import { createLinkedinSession } from "../linkedin/index.js";
import type { FreeAxesRecord } from "../methodology/types.js";
import { makeAuditWriter } from "../persistence/audit.js";
import { DEFAULT_AUTH_PATH } from "../persistence/auth.js";
import { DEFAULT_CONFIG_PATH, readConfig } from "../persistence/config.js";
import {
  applyIdentityPatch,
  type IdentityRecord,
  identityRecordSchema,
  readIdentity,
  writeIdentity,
} from "../persistence/identity.js";
import { setSafeModeServerUrl } from "../persistence/safeModeState.js";
import { readSecrets } from "../persistence/secrets.js";
import { continueRecent, loadMessages } from "../persistence/session.js";
import { loadMessagesShared, sharedSessionPath } from "../persistence/sharedSession.js";
import { readTelegramConfig } from "../persistence/telegramConfig.js";
import { WORKER_INBOX_DB_PATH } from "../persistence/workerInbox.js";
import type { ControlSignals } from "../tools/index.js";
import { makeAllTools } from "../tools/index.js";
import { registerCrashHandlers } from "./crashLogger.js";
import { loadDotenv } from "./env.js";
import { runIdentityBootstrap } from "./identity-init.js";
import { runOneShot, runRepl } from "./repl.js";
import { handleCronSlash } from "./replCron.js";
import { isInteractive, printNoninteractiveGuidance } from "./subcommands/_prompts.js";
import { runAuthSubcommand } from "./subcommands/auth.js";
import { runBootstrapRegister } from "./subcommands/bootstrapRegister.js";
import { runCronRemoveInteractive } from "./subcommands/cronRemove.js";
import { runGhSubcommand } from "./subcommands/gh.js";
import { runIdentitySubcommand } from "./subcommands/identity.js";
import { runSearchSubcommand } from "./subcommands/search.js";
import { runServerSubcommand } from "./subcommands/server.js";
import { runServerCredentialSubcommand, type ServerCredentialOpts } from "./subcommands/serverCredential.js";
import { runServerInstallTokenSubcommand } from "./subcommands/serverInstallToken.js";
import { runServerPersonaSubcommand } from "./subcommands/serverPersona.js";
import { runServerWebTokenSubcommand } from "./subcommands/serverWebToken.js";
import { runServerWorkerSubcommand } from "./subcommands/serverWorker.js";
import { runSessionsSubcommand } from "./subcommands/sessions.js";
import { runSetupSubcommand } from "./subcommands/setup.js";
import { promptFreeAxes, runSoulSubcommand } from "./subcommands/soul.js";
import { runStatusSubcommand } from "./subcommands/status.js";
import { runTelegramSubcommand } from "./subcommands/telegram.js";
import { runTelegramDaemon } from "./subcommands/telegramDaemon.js";
import { runUninstallSubcommand } from "./subcommands/uninstall.js";
import { runUpdateSubcommand } from "./subcommands/update.js";
import { runVersionSubcommand } from "./subcommands/version.js";
import { startWorkerHeartbeat } from "./workerHeartbeat.js";
import { startWorkerServerPoll } from "./workerServerPoll.js";

/**
 * P-13 D-2: canonical Ctrl-C catch helper. Every Commander action body that may
 * invoke a prompt wraps via this — operator Ctrl-C during inquirer prompt throws
 * ExitPromptError, which we treat as a clean cancel (exit 0, no stack trace).
 */
async function runWithExitGuard(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ExitPromptError) process.exit(0);
    throw e;
  }
}

interface CliOpts {
  model?: string;
  prompt?: string;
  newSession: boolean;
  cwd: string;
  resetIdentity: boolean;
}

/**
 * Prompt the operator for the 4 free axes via readline; persist into identity.json.
 * Caller (`main()` body, only-when-freeAxes-absent path) ensures this runs only once
 * per binary invocation. Reuses §6.7's `promptFreeAxes` for the readline loop +
 * freeAxesSchema validation; adds the persist step here.
 *
 * Wrapper-here over substitution with `runSoulSubcommand("reset", …)` because the
 * reset subcommand prints a "=== mai soul reset — re-pick the 4 free axes ===" header
 * — wrong UX for the FIRST-time-after-bootstrap path. This wrapper runs the prompts
 * silently after identity bootstrap, no "reset" framing.
 */
async function promptFreeAxesAndPersist(identityPath: string): Promise<void> {
  const existing = readIdentity(identityPath);
  if (!existing) {
    process.stderr.write("[mai] identity.json missing during axes-prompt — skipping (operator must re-run mai).\n");
    return;
  }
  process.stdout.write(
    "\n=== Pick your 4 methodology habit axes (one-time setup; can be re-rolled via `mai soul reset`) ===\n",
  );
  const axes: FreeAxesRecord = await promptFreeAxes();
  const patched = applyIdentityPatch(existing, { freeAxes: axes });
  const merged = identityRecordSchema.parse({
    ...patched,
    updatedAt: new Date().toISOString(),
  });
  writeIdentity(merged, identityPath);
  process.stdout.write("[mai] freeAxes saved.\n");
}

async function main(): Promise<void> {
  // CRITICAL: load .env BEFORE any code reads process.env (modelResolver, persistence).
  loadDotenv(process.cwd());

  // P-18 D-1: register crash handlers early — before any async work that could throw
  registerCrashHandlers();

  // P-22 §3.1: auto-update on every startup (unless skipped or invoked as `mai update`).
  // `mai update [...]` subcommand path is bypassed to avoid an infinite re-exec loop
  // (the manual subcommand IS the explicit refresh). The success path inside
  // `runStartupAutoUpdate` calls `process.exit` after a successful re-exec; if we
  // reach the line below, the update was skipped, completed without re-exec, or failed.
  if (process.env.MAI_AUTOUPDATE !== "skip" && process.argv[2] !== "update") {
    const { runStartupAutoUpdate } = await import("./autoUpdate.js");
    await runStartupAutoUpdate();
  }

  // P-3 env reads (CDP layer): port + profile dir.
  const cdpPort = process.env.MAI_CDP_PORT ? parseInt(process.env.MAI_CDP_PORT, 10) : 9222;
  const profileDir = process.env.MAI_PROFILE_DIR ?? path.join(os.homedir(), ".mai", "agent", "chrome-profile");

  // P-4 env reads (persistence layer): memory DB + identity JSON paths.
  const memoryDbPath = process.env.MAI_MEMORY_DB_PATH ?? path.join(os.homedir(), ".mai", "agent", "memory.sqlite");
  const identityPath = process.env.MAI_IDENTITY_PATH ?? path.join(os.homedir(), ".mai", "agent", "identity.json");

  // P-6 env read (audit layer): JSONL audit log path; default ~/.mai/agent/audit.jsonl.
  const auditPath = process.env.MAI_AUDIT_PATH ?? path.join(os.homedir(), ".mai", "agent", "audit.jsonl");

  // P-10 (D-9 / D-13) env read: schedule.jsonl path for /cron persistence.
  const schedulePath = process.env.MAI_SCHEDULE_PATH ?? path.join(os.homedir(), ".mai", "agent", "schedule.jsonl");

  // P-11 (D-9 / D-13) env read: telegram.json path for /telegram persistence.
  const telegramConfigPath =
    process.env.MAI_TELEGRAM_CONFIG_PATH ?? path.join(os.homedir(), ".mai", "agent", "telegram.json");

  // P-24 §6.9: path to ~/.mai/agent/config.json. CLI production honors
  // MAI_CONFIG_PATH (operator override); library-level DEFAULT_CONFIG_PATH()
  // getter does NOT — see plan §8 NIT-B. Both env vars are undocumented in
  // CLAUDE.md and unsupported for direct readConfig()/readSecrets() calls.
  // Currently unused in main.ts dispatch — subcommands rely on the
  // DEFAULT_CONFIG_PATH() default inside writeTelegramConfigFields. Reserved
  // for future P-25 server/worker reads + explicit threading.
  const _configPath = process.env.MAI_CONFIG_PATH ?? path.join(os.homedir(), ".mai", "agent", "config.json");
  void _configPath;

  // P-11 (D-3 / D-19): single TurnLock for the binary lifetime. Threaded into runRepl
  // so operator + cron + telegram turns serialize on a single mutex chain.
  const turnLock = new TurnLock();

  // P-7: dynamic version read so commander's --version + the `version` subcommand stay in sync with package.json.
  const requireFromHere = createRequire(import.meta.url);
  const pkg = requireFromHere("../../package.json") as { version: string };

  const program = new Command();
  program
    .name("mai")
    .description("LinkedIn autonomous agent")
    .version(pkg.version)
    .option("--model <spec>", "LLM model spec (provider:modelId); overrides MAI_MODEL")
    .option("--prompt <text>", "one-shot prompt; exits after response")
    .option("--new-session", "start a fresh session (discard prior context)", false)
    .option("--cwd <dir>", "working directory for session storage", process.cwd())
    .option("--reset-identity", "delete identity.json and re-run first-run bootstrap", false)
    // P-5 Step 5a (FAILURE-1 fix): Commander v12 requires a root .action() handler whenever
    // any subcommand is registered, otherwise root-level invocations like `mai --prompt "..."`
    // fall through to the usage screen and exit 1. The full REPL / one-shot body lives here.
    .action(async () => {
      const opts = program.opts<CliOpts>();

      // P-4: identity-init bootstrap (must run BEFORE Chrome boot — readline owns stdin).
      if (opts.resetIdentity && existsSync(identityPath)) unlinkSync(identityPath);
      if (!existsSync(identityPath)) {
        await runIdentityBootstrap(identityPath);
      }

      // P-5: axes-prompt-or-default (rev-2 §4 migration semantics). If identity.json exists
      // but lacks freeAxes (pre-P-5 record), trigger axes prompt on interactive REPL; silent
      // default + stderr nudge for non-TTY/--prompt.
      const initialIdentity = readIdentity(identityPath);
      if (initialIdentity && !initialIdentity.freeAxes) {
        if (process.stdin.isTTY && !opts.prompt) {
          await promptFreeAxesAndPersist(identityPath);
          // (re-read happens below via finalIdentity)
        } else {
          process.stderr.write(
            "[mai] freeAxes not yet picked — using methodology defaults. Run `mai soul reset` to set them.\n",
          );
        }
      }

      const model = resolveModel({ cli: opts.model });

      // P-5 + P-28: Soul band — config.soul.override REPLACES the composed band when set.
      const finalIdentity: IdentityRecord | null = readIdentity(identityPath);
      const cfgForSoul = readConfig(DEFAULT_CONFIG_PATH());
      const system = composeSystemPrompt({
        boundary: BOUNDARY, // P-9 D-8 — was BOUNDARY_PLACEHOLDER
        // soul is non-optional in configJsonSchemaV2 (.default({override:null})).
        soul: resolveSoulBand(cfgForSoul.soul.override, finalIdentity),
        checkpoint: CHECKPOINT, // P-10 D-10
      });
      // P-23 §6.7: when telegram daemon is enabled in cfg, REPL switches to
      // shared session JSONL so operator + daemon turns share one log.
      const tgCfgForSession = readTelegramConfig(telegramConfigPath);
      const usingShared = tgCfgForSession.enabled;
      const sessionFile = usingShared ? sharedSessionPath() : continueRecent(opts.cwd, { newSession: opts.newSession });
      const messages: CoreMessage[] = usingShared ? loadMessagesShared(sessionFile) : loadMessages(sessionFile);

      // v0.3-fix1: lazy LinkedinSession factory — captures launch options only; Chrome
      // boots on first session.getOrInitClient() call inside any LinkedIn tool's execute.
      // Memory + identity tools work without Chrome.
      // P-32: per-worker input mode (cdp default | hardware) from config.json.
      const linkedinSession = createLinkedinSession({
        port: cdpPort,
        profileDir,
        inputMode: readConfig(DEFAULT_CONFIG_PATH()).worker.input_mode,
      });

      // P-18 D-2: periodic CDP health check — clears stale cache between idle periods
      const heartbeatInterval = setInterval(() => {
        linkedinSession.heartbeat().catch(() => {
          /* best-effort; heartbeat failures are non-fatal */
        });
      }, 30_000);
      // Allow Node to exit even if this interval is pending
      heartbeatInterval.unref();

      // P-6: single AbortController for the binary lifetime (sticky once aborted —
      // a turn-N stop should prevent turn N+1 from starting). Wired into makeAllTools
      // via control.requestStop, and into runAgentLoop via abortSignal.
      const abortController = new AbortController();
      const control: ControlSignals = {
        requestStop: () => abortController.abort(),
        // P-6 Step 5a r3: stop tool writes its own audit row directly because
        // Vercel SDK v4 skips onStepFinish on abort-triggered step exits.
        auditPath,
      };
      const auditWriter = makeAuditWriter(auditPath);

      // P-9 D-10: lazy-loads ~/.mai/agent/hooks.json; missing-file = no-op runner.
      const hookRunner = new HookRunner();

      // P-26: worker-side server-coord plumbing. When `config.server.url` is set
      // AND `secrets.server.token` is provisioned (via `mai server worker add`),
      // start the heartbeat + long-poll loops. Otherwise the worker runs
      // standalone (safe-mode never activates; query_lead_globally / publish_event
      // return graceful envelopes via their null-coords paths).
      const workerCfg = readConfig();
      const workerSecrets = readSecrets();
      const workerId = finalIdentity?.fullName ?? os.hostname();
      if (workerCfg.server.url) {
        if (workerSecrets.server?.token) {
          setSafeModeServerUrl(workerCfg.server.url);
          const coords = {
            serverUrl: workerCfg.server.url,
            token: workerSecrets.server.token,
            workerId,
          };
          startWorkerHeartbeat(coords, abortController.signal);
          startWorkerServerPoll(
            coords,
            WORKER_INBOX_DB_PATH(),
            abortController.signal,
            workerCfg.server.poll_interval_s * 1000,
          );
        } else {
          process.stderr.write(
            "[mai] config.server.url set but secrets.server.token missing — server features disabled\n",
          );
        }
      }

      const tools = makeAllTools(
        linkedinSession,
        { memoryDbPath, identityPath, schedulePath }, // P-31: + schedulePath (schedule_task tool)
        control,
        hookRunner,
        { mode: "worker", workerId },
      );

      if (typeof opts.prompt === "string" && opts.prompt.length > 0) {
        await runOneShot({
          model,
          system,
          messages,
          tools,
          sessionFile,
          cwd: opts.cwd,
          prompt: opts.prompt,
          abortSignal: abortController.signal,
          onStepFinish: auditWriter,
          turnLock, // P-11 D-19 — unused in oneShot but keeps signature uniform
          telegramConfigPath, // P-11 D-9
        });
        process.exit(0);
      }

      await runRepl({
        model,
        system,
        messages,
        tools,
        sessionFile,
        cwd: opts.cwd,
        abortController,
        abortSignal: abortController.signal,
        onStepFinish: auditWriter,
        schedulePath, // P-10 D-9
        turnLock, // P-11 D-19
        telegramConfigPath, // P-11 D-9
      });
      // REPL fall-through (Ctrl-C or stop-triggered break): exit cleanly.
      process.exit(0);
    });

  // P-5: `mai soul <action>` subcommand. Short-circuits via process.exit(0) — never
  // falls through to REPL/one-shot dispatch.
  program
    .command("soul <action>")
    .description(
      "Soul-band controls: 'show' prints composed Soul; 'edit' opens identity.json in $EDITOR; 'reset' re-prompts the 4 free axes.",
    )
    .action(async (action: string) => {
      if (action !== "show" && action !== "edit" && action !== "reset") {
        process.stderr.write(`[mai] unknown soul action: ${action}. Use show / edit / reset.\n`);
        process.exit(1);
      }
      await runSoulSubcommand(action, { identityPath });
      process.exit(0);
    });

  // P-7 / P-13: `mai auth` — provider key management (~/.mai/auth.json).
  // P-13 D-10: positional args become optional (`[name]`) so missing args + TTY
  // trigger the interactive Prompter path inside runAuthSubcommand.
  const auth = program.command("auth").description("Provider key management (~/.mai/auth.json)");
  auth
    .command("set [url]")
    .option("--key <value>", "API key")
    .option("--model-id <id>", "Model ID") // P-36 F-E: was --model (collided with the global --model)
    .option("--name <name>", "Provider name (default: derived from URL hostname)")
    .option("--default", "Set this provider:model as the new default model spec", false)
    .action(
      async (
        url: string | undefined,
        cliOpts: { key?: string; modelId?: string; name?: string; default?: boolean },
      ) => {
        await runWithExitGuard(async () => {
          await runAuthSubcommand("set", {
            url,
            key: cliOpts.key,
            model: cliOpts.modelId, // P-36 F-E: --model-id → opts.model (internal field unchanged)
            name: cliOpts.name,
            asDefault: cliOpts.default ?? false,
          });
        });
        process.exit(0);
      },
    );
  auth.command("list").action(async () => {
    await runWithExitGuard(async () => {
      await runAuthSubcommand("list", {});
    });
    process.exit(0);
  });
  auth.command("remove [provider]").action(async (provider: string | undefined) => {
    await runWithExitGuard(async () => {
      await runAuthSubcommand("remove", { provider });
    });
    process.exit(0);
  });
  auth.command("default [spec]").action(async (spec: string | undefined) => {
    await runWithExitGuard(async () => {
      await runAuthSubcommand("default", { spec });
    });
    process.exit(0);
  });

  // P-7: `mai identity` — operator identity management.
  const identity = program.command("identity").description("Operator identity management");
  identity
    .command("init")
    .option("--reset", "Re-run from scratch (with confirmation)", false)
    .action(async (cliOpts: { reset?: boolean }) => {
      await runIdentitySubcommand("init", { identityPath, reset: cliOpts.reset });
      process.exit(0);
    });
  identity.command("show").action(async () => {
    await runIdentitySubcommand("show", { identityPath });
    process.exit(0);
  });

  // P-7: `mai sessions` — session management.
  const sessions = program.command("sessions").description("Session management");
  sessions
    .command("list")
    .option("--json", "Output NDJSON instead of table", false)
    .action(async (cliOpts: { json?: boolean }) => {
      await runSessionsSubcommand("list", { json: cliOpts.json });
      process.exit(0);
    });
  sessions.command("continue [id]").action(async (id: string | undefined) => {
    await runWithExitGuard(async () => {
      await runSessionsSubcommand("continue", { sessionId: id });
    });
    process.exit(0);
  });
  sessions.command("new").action(async () => {
    await runSessionsSubcommand("new", {});
    process.exit(0);
  });

  // P-7: `mai version` — companion to --version flag; same dynamic source.
  program.command("version").action(() => {
    runVersionSubcommand();
    process.exit(0);
  });

  // P-11 D-9: `mai telegram` — bidirectional Telegram channel management.
  const tg = program.command("telegram").description("Bidirectional Telegram channel management");
  tg.command("on").action(async () => {
    await runTelegramSubcommand("on", { tcPath: telegramConfigPath });
    process.exit(0);
  });
  tg.command("off").action(async () => {
    await runTelegramSubcommand("off", { tcPath: telegramConfigPath });
    process.exit(0);
  });
  tg.command("status").action(async () => {
    await runTelegramSubcommand("status", { tcPath: telegramConfigPath });
    process.exit(0);
  });
  tg.command("test").action(async () => {
    await runTelegramSubcommand("test", { tcPath: telegramConfigPath });
    process.exit(0);
  });
  tg.command("bind [user_id]").action(async (id: string | undefined) => {
    await runWithExitGuard(async () => {
      // P-13 D-7: when id absent, runTelegramSubcommand's interactive bind flow handles it.
      const userId = id === undefined ? undefined : Number(id);
      await runTelegramSubcommand("bind", { tcPath: telegramConfigPath, userId });
    });
    process.exit(0);
  });
  tg.command("proxy [url]")
    .option("--unset", "Clear proxy URL")
    .action(async (url: string | undefined, cliOpts: { unset?: boolean }) => {
      await runTelegramSubcommand("proxy", {
        tcPath: telegramConfigPath,
        proxyUrl: url,
        unsetProxy: cliOpts.unset ?? false,
      });
      process.exit(0);
    });
  // P-23 §6.9: daemon entry — invoked by launchd, not for direct operator use.
  tg.command("poll")
    .description("(daemon) long-running Telegram poll loop — invoked by launchd; not for direct operator use")
    .action(async () => {
      await runTelegramDaemon();
      process.exit(0);
    });

  // P-25: `mai server` — orchestrator agent (chief-of-staff). Independent
  // directory tree at ~/.mai/server/, distinct Telegram bot via
  // MAI_SERVER_TELEGRAM_TOKEN, 14-tool inventory (no LinkedIn).
  const server = program.command("server").description("Operator's orchestrator agent");
  server.action(async () => {
    // P-25 §6.11: propagate MAI_SERVER_TELEGRAM_TOKEN → TELEGRAM_TOKEN in-process
    // so replTelegram.ts (which reads process.env.TELEGRAM_TOKEN) sees the
    // operator's server-bot token. Guard prevents clobbering an explicitly-set
    // TELEGRAM_TOKEN (per GQ-3 + plan §6.11).
    if (process.env.MAI_SERVER_TELEGRAM_TOKEN && !process.env.TELEGRAM_TOKEN) {
      process.env.TELEGRAM_TOKEN = process.env.MAI_SERVER_TELEGRAM_TOKEN;
    }
    await runServerSubcommand("repl", {});
    process.exit(0);
  });
  server
    .command("install")
    .option("--yes", "Bypass consent prompt", false)
    .action(async (cliOpts: { yes?: boolean }) => {
      await runWithExitGuard(async () => {
        await runServerSubcommand("install", { yes: cliOpts.yes ?? false });
      });
      process.exit(0);
    });
  server.command("uninstall").action(async () => {
    await runServerSubcommand("uninstall", {});
    process.exit(0);
  });
  server.command("status").action(async () => {
    await runServerSubcommand("status", {});
    process.exit(0);
  });
  server.command("bind [user_id]").action(async (id: string | undefined) => {
    await runWithExitGuard(async () => {
      const userId = id === undefined ? undefined : Number(id);
      await runServerSubcommand("bind", { userId });
    });
    process.exit(0);
  });
  const serverIdent = server.command("identity");
  serverIdent
    .command("init")
    .option("--reset", "Re-run from scratch", false)
    .action(async (cliOpts: { reset?: boolean }) => {
      await runWithExitGuard(async () => {
        await runServerSubcommand("identity-init", { reset: cliOpts.reset ?? false });
      });
      process.exit(0);
    });
  const serverSoul = server.command("soul");
  serverSoul.command("show").action(async () => {
    await runServerSubcommand("soul-show", {});
    process.exit(0);
  });
  serverSoul.command("edit").action(async () => {
    await runServerSubcommand("soul-edit", {});
    process.exit(0);
  });
  serverSoul.command("reset").action(async () => {
    await runWithExitGuard(async () => {
      await runServerSubcommand("soul-reset", {});
    });
    process.exit(0);
  });
  // P-26: `mai server worker add/rotate/remove/list` — worker-registry subgroup.
  const serverWorker = server.command("worker").description("Worker registry");
  serverWorker
    .command("add <worker_id>")
    .option("--hostname <h>", "worker hostname")
    .option("--persona <p>", "worker persona label")
    .action(async (workerId: string, cliOpts: { hostname?: string; persona?: string }) => {
      await runServerWorkerSubcommand("add", {
        workerId,
        hostname: cliOpts.hostname,
        persona: cliOpts.persona,
      });
      process.exit(0);
    });
  serverWorker.command("rotate <worker_id>").action(async (workerId: string) => {
    await runServerWorkerSubcommand("rotate", { workerId });
    process.exit(0);
  });
  serverWorker.command("remove <worker_id>").action(async (workerId: string) => {
    await runServerWorkerSubcommand("remove", { workerId });
    process.exit(0);
  });
  serverWorker
    .command("list")
    .option("--json", "JSON output", false)
    .action(async (cliOpts: { json?: boolean }) => {
      await runServerWorkerSubcommand("list", { json: cliOpts.json ?? false });
      process.exit(0);
    });
  // P-27: provision (mint invite + curl one-liner) + revoke CLI shortcuts.
  serverWorker
    .command("provision <persona_id>")
    .option("--hostname <h>", "worker hostname hint")
    .option("--ttl-min <n>", "invite TTL in minutes", "30")
    .action(async (personaId: string, cliOpts: { hostname?: string; ttlMin?: string }) => {
      await runServerWorkerSubcommand("provision", {
        personaId,
        hostname: cliOpts.hostname,
        ttlMin: cliOpts.ttlMin ? Number.parseInt(cliOpts.ttlMin, 10) : 30,
      });
      process.exit(0);
    });
  serverWorker.command("revoke <worker_id>").action(async (workerId: string) => {
    await runServerWorkerSubcommand("revoke", { workerId });
    process.exit(0);
  });
  // P-28.5: dispatch a server-guided Google login task to a worker.
  serverWorker.command("login <worker_id>").action(async (workerId: string) => {
    await runServerWorkerSubcommand("login", { workerId });
    process.exit(0);
  });

  // P-29: `mai server web-token set/show/remove` — web dashboard Basic-Auth secret.
  const serverWebToken = server.command("web-token").description("Web dashboard Basic-Auth token");
  serverWebToken.command("set [token]").action((token?: string) => {
    runServerWebTokenSubcommand("set", { token });
    process.exit(0);
  });
  serverWebToken.command("show").action(() => {
    runServerWebTokenSubcommand("show");
    process.exit(0);
  });
  serverWebToken.command("remove").action(() => {
    runServerWebTokenSubcommand("remove");
    process.exit(0);
  });

  // P-34: `mai server install-token set/show/remove` — GitHub PAT for worker bootstrap install.
  const serverInstallToken = server.command("install-token").description("GitHub PAT for worker bootstrap install");
  serverInstallToken.command("set [token]").action(async (token?: string) => {
    await runServerInstallTokenSubcommand("set", { token });
    process.exit(0);
  });
  serverInstallToken.command("show").action(async () => {
    await runServerInstallTokenSubcommand("show");
    process.exit(0);
  });
  serverInstallToken.command("remove").action(async () => {
    await runServerInstallTokenSubcommand("remove");
    process.exit(0);
  });

  // P-27: `mai server persona add/list/show/remove` — persona library subgroup.
  const serverPersona = server.command("persona").description("Persona template library");
  const runPersona = async (
    action: "add" | "list" | "show" | "remove",
    opts: { personaId?: string; json?: boolean; fromTemplate?: string },
  ): Promise<void> => {
    try {
      await runServerPersonaSubcommand(action, opts);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
    process.exit(0);
  };
  serverPersona
    .command("add <persona_id>")
    .option("--from-template <id_or_json>", "copy from an existing persona ID or inline JSON")
    .action(async (personaId: string, cliOpts: { fromTemplate?: string }) => {
      await runWithExitGuard(async () => {
        await runPersona("add", { personaId, fromTemplate: cliOpts.fromTemplate });
      });
    });
  serverPersona
    .command("list")
    .option("--json", "JSON output", false)
    .action(async (cliOpts: { json?: boolean }) => {
      await runPersona("list", { json: cliOpts.json ?? false });
    });
  serverPersona.command("show <persona_id>").action(async (personaId: string) => {
    await runPersona("show", { personaId });
  });
  serverPersona.command("remove <persona_id>").action(async (personaId: string) => {
    await runPersona("remove", { personaId });
  });

  // P-28: `mai server llm-key` + `mai server google-account` — credential library.
  const runCred = async (
    kind: "llm-key" | "google-account",
    action: "add" | "list" | "remove",
    credOpts: ServerCredentialOpts,
  ): Promise<void> => {
    try {
      await runServerCredentialSubcommand(kind, action, credOpts);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
    process.exit(0);
  };

  const serverLlmKey = server.command("llm-key").description("LLM API key pool");
  serverLlmKey
    .command("add <id>")
    .option("--type <type>", "anthropic | openai")
    .option("--base-url <url>", "OpenAI-compatible base URL")
    .option("--key <key>", "API key (prompted if omitted)")
    .option("--label <label>", "display label")
    .action(
      async (id: string, o: { type?: "anthropic" | "openai"; baseUrl?: string; key?: string; label?: string }) => {
        await runWithExitGuard(() => runCred("llm-key", "add", { id, ...o }));
      },
    );
  serverLlmKey
    .command("list")
    .option("--json", "JSON output", false)
    .action(async (o: { json?: boolean }) => {
      await runCred("llm-key", "list", { json: o.json ?? false });
    });
  serverLlmKey.command("remove <id>").action(async (id: string) => {
    await runCred("llm-key", "remove", { id });
  });

  const serverGoogle = server.command("google-account").description("Google account library (LinkedIn SSO)");
  serverGoogle
    .command("add <id>")
    .option("--email <email>", "Google account email")
    .option("--password <pw>", "password (prompted if omitted)")
    .option("--recovery-email <email>", "recovery email (P-28.5)")
    .option("--phone <phone>", "phone number (P-28.5)")
    .option("--sms-link <url>", "hosted SMS-receive URL (P-28.5)")
    .option("--twofa-link <url>", "hosted TOTP URL (P-28.5)")
    .option("--label <label>", "display label")
    .action(
      async (
        id: string,
        o: {
          email?: string;
          password?: string;
          recoveryEmail?: string;
          phone?: string;
          smsLink?: string;
          twofaLink?: string;
          label?: string;
        },
      ) => {
        await runWithExitGuard(() => runCred("google-account", "add", { id, ...o }));
      },
    );
  serverGoogle
    .command("list")
    .option("--json", "JSON output", false)
    .action(async (o: { json?: boolean }) => {
      await runCred("google-account", "list", { json: o.json ?? false });
    });
  serverGoogle.command("remove <id>").action(async (id: string) => {
    await runCred("google-account", "remove", { id });
  });

  // P-27: `mai bootstrap-register` — worker-side registration (called by the
  // bootstrap script). NOT a Vercel tool — a Commander subcommand.
  program
    .command("bootstrap-register")
    .description("Register this worker with a mai server (called by the bootstrap script)")
    .requiredOption("--server-url <url>", "server base URL")
    .requiredOption("--invite-token <token>", "invite token from provision_worker")
    .action(async (cliOpts: { serverUrl: string; inviteToken: string }) => {
      try {
        await runBootstrapRegister({ serverUrl: cliOpts.serverUrl, inviteToken: cliOpts.inviteToken });
      } catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(1);
      }
      process.exit(0);
    });

  // Hidden launchd entry — invoked by ProgramArguments only.
  server.command("daemon", { hidden: true }).action(async () => {
    // Same env propagation as the foreground `server` action so the daemon
    // (which is launchd-spawned) sees the server-bot token under
    // process.env.TELEGRAM_TOKEN (the plist's EnvironmentVariables already
    // sets TELEGRAM_TOKEN to the snapshot of MAI_SERVER_TELEGRAM_TOKEN, but
    // this guard keeps the dev-mode `mai server daemon` invocation correct).
    if (process.env.MAI_SERVER_TELEGRAM_TOKEN && !process.env.TELEGRAM_TOKEN) {
      process.env.TELEGRAM_TOKEN = process.env.MAI_SERVER_TELEGRAM_TOKEN;
    }
    await runServerSubcommand("daemon", {});
    process.exit(0);
  });

  // P-15: `mai gh` — GitHub issue tool configuration
  const gh = program.command("gh").description("GitHub issue tool configuration");
  gh.command("set [token]")
    .option("--repo <owner/repo>", "GitHub repo (format owner/repo)")
    .action(async (token: string | undefined, cliOpts: { repo?: string }) => {
      await runWithExitGuard(async () => {
        await runGhSubcommand("set", { token, repo: cliOpts.repo });
      });
      process.exit(0);
    });
  gh.command("status").action(async () => {
    await runGhSubcommand("status", {});
    process.exit(0);
  });
  gh.command("remove").action(async () => {
    await runGhSubcommand("remove", {});
    process.exit(0);
  });

  // P-15: `mai search` — web search API key management
  const search = program.command("search").description("Web search API key management");
  search
    .command("set")
    .option("--brave <key>", "Brave Search API key")
    .option("--tavily <key>", "Tavily Search API key")
    .action(async (cliOpts: { brave?: string; tavily?: string }) => {
      await runWithExitGuard(async () => {
        await runSearchSubcommand("set", { braveApiKey: cliOpts.brave, tavilyApiKey: cliOpts.tavily });
      });
      process.exit(0);
    });
  search.command("status").action(async () => {
    await runSearchSubcommand("status", {});
    process.exit(0);
  });
  search.command("remove").action(async () => {
    await runSearchSubcommand("remove", {});
    process.exit(0);
  });

  // P-20: `mai update` — check GitHub Releases for newer mai-agent version.
  // P-22 §3.2: `--bootstrap` triggers a forced auto-update (bypasses dev-link guard).
  program
    .command("update")
    .description("Check for mai-agent updates on GitHub Releases")
    .option("--json", "Output machine-readable JSON")
    .option(
      "--bootstrap",
      "One-time migration: install latest release to ~/.mai/agent/releases/ and swap the global symlink (use when running from a dev-link npm-link setup)",
    )
    .action(async (cliOpts: { json?: boolean; bootstrap?: boolean }) => {
      if (cliOpts.bootstrap === true) {
        const { runStartupAutoUpdate } = await import("./autoUpdate.js");
        await runStartupAutoUpdate({ force: true, source: "bootstrap" });
        process.exit(0);
      }
      await runUpdateSubcommand({ json: cliOpts.json ?? false });
      process.exit(0);
    });

  // P-38: `mai uninstall` — remove the global install. fs-only; --purge wipes ~/.mai/.
  program
    .command("uninstall")
    .description("Remove the global mai install (bin + package symlink + release dirs); --purge also removes ~/.mai/")
    .option("--purge", "Also remove ~/.mai/ — credentials, sessions, Chrome-profile symlink (irreversible)", false)
    .option("--yes", "Skip the interactive confirmation prompts", false)
    .action(async (cliOpts: { purge?: boolean; yes?: boolean }) => {
      await runWithExitGuard(async () => {
        await runUninstallSubcommand({ purge: cliOpts.purge ?? false, yes: cliOpts.yes ?? false });
      });
      process.exit(0);
    });

  // P-11 D-9: `mai status` — aggregator (auth + chrome + identity + telegram + cron + memory).
  program
    .command("status")
    .description("Show agent status (auth + chrome + identity + telegram + cron + memory)")
    .action(async () => {
      await runStatusSubcommand({
        authPath: DEFAULT_AUTH_PATH(),
        identityPath,
        schedulePath,
        tcPath: telegramConfigPath,
        memoryDbPath,
        cdpPort,
      });
      process.exit(0);
    });

  // P-11 D-9: `mai cron list | remove <id>` — delegates to existing handleCronSlash for shape parity.
  // P-31 OQ-3: `mai cron schedule` was intentionally REPL-only; P-31 reverses that so the
  // server can create a worker cron job over SSH (delegates to handleCronSlash).
  const cron = program.command("cron").description("Cron schedule management");
  cron.command("list").action(async () => {
    await handleCronSlash("/cron list", schedulePath, process.stdout);
    process.exit(0);
  });
  // P-31: `mai cron schedule <task> --cron <expr> | --at <time>`.
  cron
    .command("schedule <task>")
    .option("--cron <expr>", "5-field cron expression (recurring)")
    .option("--at <time>", "HH:MM or ISO datetime (one-shot)")
    .action(async (task: string, opts: { cron?: string; at?: string }) => {
      if (!opts.cron && !opts.at) {
        process.stderr.write("mai cron schedule: --cron <expr> or --at <time> required\n");
        process.exit(1);
      }
      const flag = opts.cron ? `--cron "${opts.cron}"` : `--at "${opts.at}"`;
      const safeTask = task.replace(/"/g, ""); // handleCronSlash tokenizer is quote-delimited
      await handleCronSlash(`/cron schedule "${safeTask}" ${flag}`, schedulePath, process.stdout);
      process.exit(0);
    });
  // P-13 D-10 + B-1: optional [id] — when omitted + TTY, delegate to
  // runCronRemoveInteractive (DI-injectable helper in subcommands/cronRemove.ts).
  cron.command("remove [id]").action(async (id: string | undefined) => {
    await runWithExitGuard(async () => {
      let effectiveId = id;
      if (!effectiveId) {
        if (!isInteractive()) {
          printNoninteractiveGuidance("cron remove", "<job-id>", "<job-id-from-mai-cron-list>");
          process.exit(1);
        }
        const selected = await runCronRemoveInteractive(schedulePath);
        if (selected === null) {
          // Empty schedule, no selection, or operator declined confirm — clean exit.
          process.exit(0);
        }
        effectiveId = selected;
      }
      await handleCronSlash(`/cron remove ${effectiveId}`, schedulePath, process.stdout);
    });
    process.exit(0);
  });

  // P-13 D-6: `mai setup` — interactive wizard (auth → identity → telegram → soul).
  program
    .command("setup")
    .description("Interactive wizard: auth + identity + telegram + soul configuration")
    .action(async () => {
      await runWithExitGuard(async () => {
        await runSetupSubcommand({
          authPath: DEFAULT_AUTH_PATH(),
          identityPath,
          tcPath: telegramConfigPath,
          schedulePath,
          memoryDbPath,
          cdpPort,
        });
      });
      process.exit(0);
    });

  await program.parseAsync(process.argv);
  // No code after parseAsync — root + sub actions run themselves.
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
