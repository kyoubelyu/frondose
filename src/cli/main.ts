#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import { ExitPromptError } from "@inquirer/core";
import { Command } from "commander";
import { DEFAULT_AUTH_PATH } from "../persistence/auth.js";
import { getHomeBase } from "../persistence/paths.js";
import { resolveTier } from "../tier.js";
import { registerCrashHandlers } from "./crashLogger.js";
import { loadDotenv } from "./env.js";
import { handleCronSlash } from "./replCron.js";
import { isInteractive, printNoninteractiveGuidance } from "./subcommands/_prompts.js";
import { runAnalyticsSubcommand } from "./subcommands/analytics.js";
import { runAuthSubcommand } from "./subcommands/auth.js";
import { runCronRemoveInteractive } from "./subcommands/cronRemove.js";
import { runGhSubcommand } from "./subcommands/gh.js";
import { runIdentitySubcommand } from "./subcommands/identity.js";
import { runSearchSubcommand } from "./subcommands/search.js";
import { runServerSubcommand } from "./subcommands/server.js";
import { runServerCredentialSubcommand, type ServerCredentialOpts } from "./subcommands/serverCredential.js";
import { runServerPersonaSubcommand } from "./subcommands/serverPersona.js";
import { runServerWebTokenSubcommand } from "./subcommands/serverWebToken.js";
import { runServerWorkerSubcommand } from "./subcommands/serverWorker.js";
import { runSessionsSubcommand } from "./subcommands/sessions.js";
import { runSetupSubcommand } from "./subcommands/setup.js";
import { runSoulSubcommand } from "./subcommands/soul.js";
import { runStatusSubcommand } from "./subcommands/status.js";
import { runTelegramSubcommand } from "./subcommands/telegram.js";
import { runTelegramDaemon } from "./subcommands/telegramDaemon.js";
import { runUninstallSubcommand } from "./subcommands/uninstall.js";
import { runUpdateSubcommand } from "./subcommands/update.js";
import { runVersionSubcommand } from "./subcommands/version.js";
import { bootWorker } from "./workerBoot.js";

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
  maxSteps?: string; // P-46 D-1b — Commander delivers <n> as a string
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
  const profileDir = process.env.MAI_PROFILE_DIR ?? path.join(getHomeBase(), ".mai", "agent", "chrome-profile");

  // P-4 env reads (persistence layer): memory DB + identity JSON paths.
  const memoryDbPath = process.env.MAI_MEMORY_DB_PATH ?? path.join(getHomeBase(), ".mai", "agent", "memory.sqlite");
  const identityPath = process.env.MAI_IDENTITY_PATH ?? path.join(getHomeBase(), ".mai", "agent", "identity.json");

  // P-6 env read (audit layer): JSONL audit log path; default ~/.mai/agent/audit.jsonl.
  const auditPath = process.env.MAI_AUDIT_PATH ?? path.join(getHomeBase(), ".mai", "agent", "audit.jsonl");

  // P-10 (D-9 / D-13) env read: schedule.jsonl path for /cron persistence.
  const schedulePath = process.env.MAI_SCHEDULE_PATH ?? path.join(getHomeBase(), ".mai", "agent", "schedule.jsonl");

  // P-11 (D-9 / D-13) env read: telegram.json path for /telegram persistence.
  const telegramConfigPath =
    process.env.MAI_TELEGRAM_CONFIG_PATH ?? path.join(getHomeBase(), ".mai", "agent", "telegram.json");

  // P-7: dynamic version read so commander's --version + the `version` subcommand stay in sync with package.json.
  const requireFromHere = createRequire(import.meta.url);
  const pkg = requireFromHere("../../package.json") as { version: string };

  const program = new Command();
  const powerTier = resolveTier() === "power";
  program
    .name("mai")
    .description("LinkedIn autonomous agent")
    .version(pkg.version)
    .option("--model <spec>", "LLM model spec (provider:modelId); overrides MAI_MODEL")
    .option("--prompt <text>", "one-shot prompt; exits after response")
    .option("--new-session", "start a fresh session (discard prior context)", false)
    .option("--cwd <dir>", "working directory for session storage", process.cwd())
    .option("--reset-identity", "delete identity.json and re-run first-run bootstrap", false)
    .option("--max-steps <n>", "max agent-loop tool-call steps per turn (overrides MAI_MAX_STEPS; default 200)")
    // P-5 Step 5a (FAILURE-1 fix): Commander v12 requires a root .action() handler whenever
    // any subcommand is registered, otherwise root-level invocations like `mai --prompt "..."`
    // fall through to the usage screen and exit 1. The full REPL / one-shot body lives here.
    .action(async () => {
      const opts = program.opts<CliOpts>();
      await bootWorker({
        cdpPort,
        profileDir,
        memoryDbPath,
        identityPath,
        auditPath,
        schedulePath,
        telegramConfigPath,
        opts,
      });
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

  if (powerTier) {
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
  }

  if (powerTier) {
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
    // P-41: provision a worker over SSH + revoke CLI shortcuts.
    serverWorker
      .command("provision <persona_id>")
      .description("Provision a new worker over SSH (installs + configures mai on the host)")
      .option("--hostname <h>", "worker SSH-reachable hostname (required for SSH provisioning)")
      .option("--worker-id <id>", "explicit worker id (default: random 8-hex)")
      .action(async (personaId: string, cliOpts: { hostname?: string; workerId?: string }) => {
        await runServerWorkerSubcommand("provision", {
          personaId,
          hostname: cliOpts.hostname,
          workerId: cliOpts.workerId,
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
  }

  if (powerTier) {
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
  }

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

  // P-56a: `mai serve` — HTTP-over-UDS bridge for the Tauri desktop shell (v0.5 hover pivot).
  program
    .command("serve")
    .description("HTTP-over-UDS bridge for the v0.5 Tauri desktop shell")
    .requiredOption("--sock <path>", "Unix Domain Socket path (provided by parent Tauri process)")
    .requiredOption("--token <token>", "Bearer token (provided by parent Tauri process)")
    .action(async (cliOpts: { sock: string; token: string }) => {
      const { runServeSubcommand } = await import("./subcommands/serve.js");
      await runServeSubcommand({ sockPath: cliOpts.sock, bearerToken: cliOpts.token });
      // runServeSubcommand returns when the server exits (SIGTERM/SIGINT).
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

  // P-58d.2: `mai update-server` — serve ~/.mai/site/ (download portal + Tauri
  // updater manifest) over LAN HTTP. Operator-internal infra command (not gated
  // by tier — like `mai update`). Blocks until SIGINT/SIGTERM.
  program
    .command("update-server")
    .description("Serve the local Frondose download portal + updater manifest (~/.mai/site/) over LAN HTTP")
    .option("--port <n>", "TCP port to bind (default 4875)")
    .option("--site-dir <dir>", "Site directory to serve (default ~/.mai/site)")
    .action(async (cliOpts: { port?: string; siteDir?: string }) => {
      const { runUpdateServerSubcommand } = await import("./subcommands/updateServer.js");
      await runUpdateServerSubcommand({ port: cliOpts.port, siteDir: cliOpts.siteDir });
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

  // P-SP-F: `mai analytics` — operator-facing sales metrics surface (north-star KPI).
  program
    .command("analytics")
    .description("Show sales analytics: funnel, rates, score calibration, auto-run history")
    .action(async () => {
      await runWithExitGuard(async () => {
        await runAnalyticsSubcommand({});
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
