#!/usr/bin/env node
import { existsSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { CoreMessage } from "ai";
import { Command } from "commander";
import { HookRunner } from "../agent/hooks.js";
import { resolveModel } from "../agent/modelResolver.js";
import { BOUNDARY } from "../agent/systemPrompt/boundary.js";
import { CHECKPOINT } from "../agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../agent/systemPrompt/compose.js";
import { composeSoulBand } from "../agent/systemPrompt/soul.js";
import { TurnLock } from "../agent/turnSemaphore.js";
import { createLinkedinSession } from "../linkedin/index.js";
import type { FreeAxesRecord } from "../methodology/types.js";
import { makeAuditWriter } from "../persistence/audit.js";
import { DEFAULT_AUTH_PATH } from "../persistence/auth.js";
import {
  applyIdentityPatch,
  type IdentityRecord,
  identityRecordSchema,
  readIdentity,
  writeIdentity,
} from "../persistence/identity.js";
import { continueRecent, loadMessages } from "../persistence/session.js";
import type { ControlSignals } from "../tools/index.js";
import { makeAllTools } from "../tools/index.js";
import { loadDotenv } from "./env.js";
import { runIdentityBootstrap } from "./identity-init.js";
import { runOneShot, runRepl } from "./repl.js";
import { handleCronSlash } from "./replCron.js";
import { runAuthSubcommand } from "./subcommands/auth.js";
import { runIdentitySubcommand } from "./subcommands/identity.js";
import { runSessionsSubcommand } from "./subcommands/sessions.js";
import { promptFreeAxes, runSoulSubcommand } from "./subcommands/soul.js";
import { runStatusSubcommand } from "./subcommands/status.js";
import { runTelegramSubcommand } from "./subcommands/telegram.js";
import { runVersionSubcommand } from "./subcommands/version.js";

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

      // P-5: Soul band composed from final identity record (re-read after potential axes prompt).
      const finalIdentity: IdentityRecord | null = readIdentity(identityPath);
      const system = composeSystemPrompt({
        boundary: BOUNDARY, // P-9 D-8 — was BOUNDARY_PLACEHOLDER
        soul: composeSoulBand(finalIdentity),
        checkpoint: CHECKPOINT, // P-10 D-10
      });
      const sessionFile = continueRecent(opts.cwd, { newSession: opts.newSession });
      const messages: CoreMessage[] = loadMessages(sessionFile);

      // v0.3-fix1: lazy LinkedinSession factory — captures launch options only; Chrome
      // boots on first session.getOrInitClient() call inside any LinkedIn tool's execute.
      // Memory + identity tools work without Chrome.
      const linkedinSession = createLinkedinSession({ port: cdpPort, profileDir });

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
      const tools = makeAllTools(linkedinSession, { memoryDbPath, identityPath }, control, hookRunner);

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

  // P-7: `mai auth` — provider key management (~/.mai/auth.json).
  const auth = program.command("auth").description("Provider key management (~/.mai/auth.json)");
  auth
    .command("set <spec>")
    .option("--key <value>", "API key")
    .option("--base-url <url>", "Custom base URL (e.g. for DeepSeek's OpenAI-compat endpoint)")
    .action(async (spec: string, cliOpts: { key?: string; baseUrl?: string }) => {
      await runAuthSubcommand("set", { spec, key: cliOpts.key, baseUrl: cliOpts.baseUrl });
      process.exit(0);
    });
  auth.command("list").action(async () => {
    await runAuthSubcommand("list", {});
    process.exit(0);
  });
  auth.command("remove <provider>").action(async (provider: string) => {
    await runAuthSubcommand("remove", { provider });
    process.exit(0);
  });
  auth.command("default <spec>").action(async (spec: string) => {
    await runAuthSubcommand("default", { spec });
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
  sessions.command("continue <id>").action(async (id: string) => {
    await runSessionsSubcommand("continue", { sessionId: id });
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
  tg.command("bind <user_id>").action(async (id: string) => {
    await runTelegramSubcommand("bind", { tcPath: telegramConfigPath, userId: Number(id) });
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
  // `mai cron schedule` is intentionally REPL-only (interactive prompt body too awkward as CLI argv).
  const cron = program.command("cron").description("Cron schedule management (create via REPL `/cron schedule`)");
  cron.command("list").action(async () => {
    await handleCronSlash("/cron list", schedulePath, process.stdout);
    process.exit(0);
  });
  cron.command("remove <id>").action(async (id: string) => {
    await handleCronSlash(`/cron remove ${id}`, schedulePath, process.stdout);
    process.exit(0);
  });

  await program.parseAsync(process.argv);
  // No code after parseAsync — root + sub actions run themselves.
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
